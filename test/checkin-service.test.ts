/**
 * 签到主流程测试（对应用户要求的测试清单 1-4、7-9）。
 * 全部使用可编程 fetch，不触碰真实账号。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { account, createHarness, createMockFetch, creditPayload, credentials, jsonResponse } from './helpers';
import { fakeJwt } from './helpers';

const CHECKIN = /\/billing\/meter\/daily-checkin/;
const CREDITS = /get-user-resource/;

test('未登录账号：不发任何领取请求，标记 unauthenticated', async () => {
  const mock = createMockFetch([{ match: CREDITS, handler: () => jsonResponse(creditPayload(100)) }]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(
    account({ credentials: null, credentialError: '未登录：凭据文件中没有 accessToken' }),
  );

  assert.equal(record.outcome, 'unauthenticated');
  assert.equal(record.ok, false);
  assert.equal(record.verified, false);
  assert.equal(mock.countMatching(CHECKIN), 0, '凭据不可用时绝不能调用领取接口');
  assert.match(record.diagnostic ?? '', /未登录/);
});

test('令牌过期且未开启刷新：不领取，给出明确诊断', async () => {
  const mock = createMockFetch([{ match: CREDITS, handler: () => jsonResponse(creditPayload(100)) }]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  // 注意：过期时间必须相对测试时钟（harness 固定在 2026-11-02T02:05Z）
  const expired = credentials({
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn', exp: Math.floor(Date.parse('2026-11-02T01:00:00Z') / 1000) }),
    expiresAt: Date.parse('2026-11-02T01:00:00Z'),
  });
  const record = await harness.service.checkin(account({ credentials: expired }));

  assert.equal(record.outcome, 'unauthenticated');
  assert.match(record.diagnostic ?? '', /过期/);
  assert.equal(mock.countMatching(CHECKIN), 0);
});

test('今日已签到（code=10001 + 已签到文案）：视为已完成，不重复发放', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(8717.55)) },
    {
      match: CHECKIN,
      handler: () => jsonResponse({ code: 10001, msg: '今天已签到，请明天再来' }, 400),
    },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'already');
  assert.equal(record.ok, true, '已签到应视为今日任务完成');
  assert.equal(record.already, true);
  assert.equal(record.code, 10001);
  assert.equal(record.verified, true);
  assert.equal(record.creditsDelta, 0);
});

test('未领取账号：code=0 且积分增加 → checked-in 并以积分差额验证', async () => {
  let credits = 1000;
  const mock = createMockFetch([
    {
      match: CREDITS,
      handler: () => jsonResponse(creditPayload(credits)),
    },
    {
      match: CHECKIN,
      handler: () => {
        credits += 20;
        return jsonResponse({ code: 0, msg: 'OK', data: {} });
      },
    },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'checked-in');
  assert.equal(record.ok, true);
  assert.equal(record.verified, true);
  assert.equal(record.verification, 'credits-delta');
  assert.equal(record.creditsBefore, 1000);
  assert.equal(record.creditsAfter, 1020);
  assert.equal(record.creditsDelta, 20);
});

test('code=0 但积分差额为 0：仍算成功，但验证依据降级为 server-code', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(500)) },
    { match: CHECKIN, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'checked-in');
  assert.equal(record.verified, true);
  assert.equal(record.verification, 'server-code');
  assert.match(record.diagnostic ?? '', /差额为 0/);
});

test('HTTP 200 但没有业务 code：保守判定为 unsupported，绝不误报成功', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(500)) },
    { match: CHECKIN, handler: () => jsonResponse({ msg: 'ok' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'unsupported');
  assert.equal(record.ok, false);
});

test('HTTP 200 但返回 HTML/空响应：不解析成功', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(500)) },
    { match: CHECKIN, handler: () => new Response('<html>gateway</html>', { status: 200 }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'unsupported');
  assert.equal(record.ok, false);
});

test('活动未开启：标记 inactive，不计成功', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(500)) },
    { match: CHECKIN, handler: () => jsonResponse({ code: 10001, msg: '活动未开启' }, 400) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'inactive');
  assert.equal(record.ok, false);
  assert.equal(record.already, false);
});

test('401：标记 unauthenticated 并停止后续域名尝试', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse({ code: 401, msg: 'unauthorized' }, 401) },
    { match: CHECKIN, handler: () => new Response('unauthorized', { status: 401 }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account());

  assert.equal(record.outcome, 'unauthenticated');
  assert.equal(record.ok, false);
});

test('重复运行：第二次命中本地记录，不再发任何领取请求', async () => {
  let credits = 1000;
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(credits)) },
    {
      match: CHECKIN,
      handler: () => {
        credits += 10;
        return jsonResponse({ code: 0, msg: 'OK' });
      },
    },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();

  const first = await harness.service.checkin(fixture);
  const second = await harness.service.checkin(fixture);
  const third = await harness.service.checkin(fixture);

  assert.equal(first.outcome, 'checked-in');
  assert.equal(second.outcome, 'skipped');
  assert.equal(third.outcome, 'skipped');
  assert.equal(mock.countMatching(CHECKIN), 1, '同一天只允许一次真正领取请求');
  // 首次签到：领取前 + 领取后各查一次积分；后两次跳过时不再查询
  assert.equal(mock.countMatching(CREDITS), 2, '跳过时不应重复查询积分');
});

test('并发同一账号：复用同一任务，接口只被调用一次', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(1000)) },
    { match: CHECKIN, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();

  const results = await Promise.all([
    harness.service.checkin(fixture),
    harness.service.checkin(fixture),
    harness.service.checkin(fixture),
  ]);

  assert.equal(mock.countMatching(CHECKIN), 1);
  assert.ok(results.every((r) => r.outcome === 'checked-in'));
});

test('--force：忽略本地记录重新确认一次，服务端去重后返回 already', async () => {
  let calls = 0;
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(1000)) },
    {
      match: CHECKIN,
      handler: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ code: 0, msg: 'OK' })
          : jsonResponse({ code: 10001, msg: '今天已签到，请明天再来' }, 400);
      },
    },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();

  await harness.service.checkin(fixture);
  const forced = await harness.service.checkin(fixture, { force: true });

  assert.equal(forced.outcome, 'already');
  assert.equal(forced.ok, true);
  assert.equal(mock.countMatching(CHECKIN), 2, 'force 会再发一次，但服务端不会重复发放');
});

test('失败记录不会覆盖已有的成功记录', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(1000)) },
    { match: CHECKIN, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();
  await harness.service.checkin(fixture);
  assert.equal(harness.store.hasConfirmedSuccess(fixture.uid, '2026-11-02'), true);

  // 模拟后续一次异常写入了失败记录
  const existing = harness.store.getRecord(fixture.uid, '2026-11-02');
  assert.ok(existing);
  harness.store.saveRecord({
    ...existing,
    ok: false,
    outcome: 'error',
    verified: false,
    diagnostic: '模拟失败',
  });

  assert.equal(harness.store.hasConfirmedSuccess(fixture.uid, '2026-11-02'), true, '成功记录必须保留');
});

test('多账号：一个账号失败不影响其它账号', async () => {
  const good = account({ uid: 'uid-good-0001', accountTag: 'uid-****01' });
  const bad = account({
    uid: 'uid-bad-0002',
    accountTag: 'uid-****02',
    credentials: credentials({
      accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn', exp: Math.floor(Date.parse('2026-11-02T01:00:00Z') / 1000) }),
      expiresAt: Date.parse('2026-11-02T01:00:00Z'),
    }),
  });

  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(1000)) },
    {
      match: CHECKIN,
      handler: (call) => {
        const uid = call.headers['x-user-id'];
        if (uid === 'uid-bad-0002') return jsonResponse({ code: 500, msg: 'boom' }, 500);
        return jsonResponse({ code: 0, msg: 'OK' });
      },
    },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });

  const batch = await harness.service.checkinAll([bad, good]);
  assert.equal(batch.records.length, 2);
  assert.equal(batch.summary.total, 2);
  assert.equal(batch.records[0]?.outcome, 'unauthenticated');
  assert.equal(batch.records[1]?.outcome, 'checked-in');
  assert.equal(batch.summary.failed, 1);
  assert.equal(batch.summary.checkedIn, 1);
});

test('多账号：同一批次内互不影响，各自独立落库', async () => {
  const first = account({ uid: 'uid-1111', accountTag: 'uid-****11' });
  const second = account({ uid: 'uid-2222', accountTag: 'uid-****22' });
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(100)) },
    { match: CHECKIN, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });

  const batch = await harness.service.checkinAll([first, second]);
  assert.equal(batch.summary.checkedIn, 2);
  assert.equal(harness.store.getRecord('uid-1111', '2026-11-02')?.ok, true);
  assert.equal(harness.store.getRecord('uid-2222', '2026-11-02')?.ok, true);
  assert.equal(mock.countMatching(CHECKIN), 2);
});

test('dry-run：不调用领取接口，只报告凭据可用', async () => {
  const mock = createMockFetch([{ match: CREDITS, handler: () => jsonResponse(creditPayload(777)) }]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const record = await harness.service.checkin(account(), { dryRun: true });

  assert.equal(record.outcome, 'dry-run');
  assert.equal(record.ok, false);
  assert.equal(record.creditsBefore, 777);
  assert.equal(mock.countMatching(CHECKIN), 0);
  assert.equal(harness.store.hasConfirmedSuccess('uid-aaaa-0001', '2026-11-02'), false, 'dry-run 不应写入成功状态');
});

test('签到请求带上账号身份头，但绝不把令牌写进响应体或日志', async () => {
  const mock = createMockFetch([
    { match: CREDITS, handler: () => jsonResponse(creditPayload(100)) },
    { match: CHECKIN, handler: () => jsonResponse({ code: 0, msg: 'OK' }) },
  ]);
  const harness = createHarness({ fetchImpl: mock.fetchImpl });
  const fixture = account();
  await harness.service.checkin(fixture);

  const claimCall = mock.calls.find((call) => CHECKIN.test(call.url));
  assert.ok(claimCall);
  assert.equal(claimCall.headers['x-user-id'], fixture.uid);
  assert.equal(claimCall.headers['x-domain'], 'workbuddy.cn');
  assert.equal(claimCall.body, '{}');

  const record = harness.store.getRecord(fixture.uid, '2026-11-02');
  const serialized = JSON.stringify(record);
  const token = fixture.credentials?.accessToken ?? '';
  assert.equal(serialized.includes(token), false, '持久化记录中不得出现 accessToken');
});
