/**
 * 调度测试：北京时间计算、退避序列、单轮执行与客户端缺失处置。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { backoffSequence, nextSlotAt, Scheduler, timezoneOffsetMs, zonedParts, zonedTimeToUtc } from '../checkin/scheduler';
import { createHarness, createMockFetch, creditPayload, jsonResponse, account } from './helpers';

const TZ = 'Asia/Shanghai';

test('Asia/Shanghai 固定 +08:00', () => {
  assert.equal(timezoneOffsetMs(TZ, Date.parse('2026-11-02T00:00:00Z')), 8 * 3600 * 1000);
  assert.equal(timezoneOffsetMs(TZ, Date.parse('2026-07-01T00:00:00Z')), 8 * 3600 * 1000, '无夏令时');
});

test('zonedParts 按北京时间拆分', () => {
  const parts = zonedParts(TZ, Date.parse('2026-11-02T02:05:00Z'));
  assert.deepEqual(parts, { year: 2026, month: 11, day: 2, hour: 10, minute: 5 });
});

test('zonedTimeToUtc 与 zonedParts 互逆', () => {
  const utc = zonedTimeToUtc(TZ, 2026, 11, 2, 10, 5);
  assert.equal(new Date(utc).toISOString(), '2026-11-02T02:05:00.000Z');
});

test('每日 10:05：未到点算当天，过了算次日', () => {
  const beforeSlot = Date.parse('2026-11-02T01:00:00Z'); // 09:00 CST
  assert.equal(new Date(nextSlotAt(beforeSlot, ['10:05'], TZ)).toISOString(), '2026-11-02T02:05:00.000Z');

  const afterSlot = Date.parse('2026-11-02T03:00:00Z'); // 11:00 CST
  assert.equal(new Date(nextSlotAt(afterSlot, ['10:05'], TZ)).toISOString(), '2026-11-03T02:05:00.000Z');
});

test('多个检查点按顺序推进，跨天回绕', () => {
  const times = ['10:05', '20:30'];
  const morning = Date.parse('2026-11-02T01:00:00Z');
  assert.equal(new Date(nextSlotAt(morning, times, TZ)).toISOString(), '2026-11-02T02:05:00.000Z');

  const noon = Date.parse('2026-11-02T04:00:00Z'); // 12:00 CST
  assert.equal(new Date(nextSlotAt(noon, times, TZ)).toISOString(), '2026-11-02T12:30:00.000Z');

  const night = Date.parse('2026-11-02T13:00:00Z'); // 21:00 CST
  assert.equal(new Date(nextSlotAt(night, times, TZ)).toISOString(), '2026-11-03T02:05:00.000Z');
});

test('非法时间点被忽略，全部非法时回落 10:05', () => {
  const now = Date.parse('2026-11-02T01:00:00Z');
  assert.equal(new Date(nextSlotAt(now, ['25:99', 'abc'], TZ)).toISOString(), '2026-11-02T02:05:00.000Z');
});

test('退避序列按指数增长并受上限约束', () => {
  const seq = backoffSequence({
    retry: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 3000 },
  } as never);
  assert.deepEqual(seq, [1000, 2000, 3000, 3000]);
});

test('runOnce：客户端未运行时仍用本地凭据完成签到（配置为 skip）', async () => {
  const mock = createMockFetch([
    { match: /get-user-resource/, handler: () => jsonResponse(creditPayload(1000)) },
    { match: /daily-checkin/, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();

  let launched = 0;
  const scheduler = new Scheduler({
    config: { ...harness.config, clientMissing: 'skip' },
    logger: harness.logger,
    service: harness.service,
    accounts: () => [fixture],
    now: harness.now,
    sleep: async () => undefined,
    detectProcess: async () => false,
    launchClient: async () => {
      launched += 1;
      return { launched: true, detail: 'stub' };
    },
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.checkedIn, 1);
  assert.equal(launched, 0, 'clientMissing=skip 时不应拉起客户端');
});

test('runOnce：配置为 launch 时会拉起客户端', async () => {
  const mock = createMockFetch([
    { match: /get-user-resource/, handler: () => jsonResponse(creditPayload(1000)) },
    { match: /daily-checkin/, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();

  let launched = 0;
  const scheduler = new Scheduler({
    config: { ...harness.config, clientMissing: 'launch' },
    logger: harness.logger,
    service: harness.service,
    accounts: () => [fixture],
    now: harness.now,
    sleep: async () => undefined,
    detectProcess: async () => false,
    launchClient: async () => {
      launched += 1;
      return { launched: true, detail: 'stub' };
    },
  });

  await scheduler.runOnce();
  assert.equal(launched, 1);
});

test('runOnce：失败账号会按退避重试，重试后成功', async () => {
  let attempts = 0;
  const mock = createMockFetch([
    { match: /get-user-resource/, handler: () => jsonResponse(creditPayload(1000)) },
    {
      match: /daily-checkin/,
      handler: () => {
        attempts += 1;
        if (attempts === 1) return new Response('<html>502</html>', { status: 502 });
        return jsonResponse({ code: 0, msg: 'OK' });
      },
    },
  ]);
  const harness = createHarness({
    fetchImpl: mock.fetchImpl,
    // maxAttempts=2：单次请求内会重试一次，第二次成功
    config: { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 } },
  });
  const fixture = account();

  const scheduler = new Scheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => [fixture],
    now: harness.now,
    sleep: async () => undefined,
    detectProcess: async () => true,
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.failed, 0);
  assert.ok(attempts >= 2, '第一轮应失败并触发调度层重试');
});

test('runForever：到点执行一次，随后停止', async () => {
  const mock = createMockFetch([
    { match: /get-user-resource/, handler: () => jsonResponse(creditPayload(1000)) },
    { match: /daily-checkin/, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  // 从 09:00 CST 开始，目标是 10:05 CST
  const harness = createHarness({ fetchImpl: mock.fetchImpl, now: Date.parse('2026-11-02T01:00:00Z') });
  const fixture = account();

  let schedulerRef: Scheduler | null = null;
  let sleepCount = 0;
  const scheduler = new Scheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => [fixture],
    now: harness.now,
    detectProcess: async () => true,
    sleep: async (ms) => {
      sleepCount += 1;
      harness.setNow(harness.now() + ms);
      if (sleepCount >= 2) schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;

  await scheduler.runForever();
  assert.equal(mock.countMatching(/daily-checkin/), 1, '同一天只应真正领取一次');
  assert.ok(sleepCount >= 1);
});

test('启动补偿只针对凭据可用的账号：无凭据账号不会导致每个检查点白跑', async () => {
  const mock = createMockFetch([
    { match: /get-user-resource/, handler: () => jsonResponse(creditPayload(1000)) },
    { match: /daily-checkin/, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  // 当前时间 23:30（已过 10:05），让"已签到"的那条记录落在今天
  const day = Date.parse('2026-11-02T15:30:00Z');
  const harness = createHarness({ fetchImpl: mock.fetchImpl, now: day });
  const usable = account({ uid: 'uid-usable-1' });
  const unusable = account({ uid: 'uid-no-cred-2', credentials: null, credentialError: '未登录' });

  // 预置"今天已成功"的记录
  harness.store.saveRecord({
    uid: usable.uid,
    date: '2026-11-02',
    outcome: 'already',
    ok: true,
    already: true,
    code: 10001,
    message: '今天已签到，请明天再来',
    endpoint: 'https://www.workbuddy.cn/billing/meter/daily-checkin',
    startedAt: day,
    finishedAt: day,
    creditsBefore: 1000,
    creditsAfter: 1000,
    creditsDelta: 0,
    verified: true,
    verification: 'server-code',
    profile: 'workbuddy-cn',
    accountTag: usable.accountTag,
    dryRun: false,
  });

  let sleepCount = 0;
  let schedulerRef: Scheduler | null = null;
  const scheduler = new Scheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => [usable, unusable],
    now: harness.now,
    detectProcess: async () => true,
    sleep: async (ms) => {
      sleepCount += 1;
      harness.setNow(harness.now() + ms);
      schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;

  await scheduler.runForever();
  assert.equal(mock.countMatching(/daily-checkin/), 0, '不应因为无凭据账号而发起领取');
  assert.ok(sleepCount >= 1, '应直接进入等待下一个检查点');
});
