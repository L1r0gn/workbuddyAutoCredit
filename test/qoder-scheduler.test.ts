/**
 * 调度测试：检查点计算、启动补偿、全部完成时跳过、pid 文件。
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { QoderPidFile, QoderScheduler } from '../qoder/scheduler';
import { defaultQoderConfig } from '../qoder/config';
import {
  campaignsPayload,
  createMockFetch,
  createQoderHarness,
  dailyCampaign,
  jsonResponse,
  qoderAccount,
  quotaPayload,
  silentLogger,
} from './qoder-helpers';

function seedAccount(harness: ReturnType<typeof createQoderHarness>, uid = 'uid-1') {
  const account = qoderAccount({ id: `cn:${uid}`, uid });
  harness.store.upsertAccount({
    region: 'cn',
    note: account.note,
    uid: account.uid,
    tokens: account.tokens,
  });
  return harness.store.getAccount(account.id) || account;
}

test('runOnce：执行所有账号并汇总', async () => {
  const mock = createMockFetch([
    { match: /\/claim$/, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: '/sash/api/v1/me/campaigns', handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: '/api/v2/quota/usage', handler: () => jsonResponse(quotaPayload(100)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  seedAccount(harness, 'u1');
  seedAccount(harness, 'u2');

  const scheduler = new QoderScheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => harness.store.listAccounts(),
    now: harness.now,
    sleep: async () => undefined,
  });

  const result = await scheduler.runOnce();
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.claimed, 2);
});

test('runOnce：没有账号时给出提示且不报错', async () => {
  const mock = createMockFetch([]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const logger = silentLogger();
  const scheduler = new QoderScheduler({
    config: harness.config,
    logger,
    service: harness.service,
    accounts: () => [],
    now: harness.now,
    sleep: async () => undefined,
  });
  const result = await scheduler.runOnce();
  assert.equal(result.records.length, 0);
  assert.equal(mock.calls.length, 0);
});

test('runForever：到点执行一次后停止', async () => {
  const mock = createMockFetch([
    { match: /\/claim$/, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: '/sash/api/v1/me/campaigns', handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: '/api/v2/quota/usage', handler: () => jsonResponse(quotaPayload(100)) },
  ]);
  // 08:00 北京时间，下一个检查点 10:05
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl, now: Date.parse('2026-11-03T00:00:00.000Z') });
  seedAccount(harness, 'u1');

  let schedulerRef: QoderScheduler | null = null;
  let sleeps = 0;
  const scheduler = new QoderScheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => harness.store.listAccounts(),
    now: harness.now,
    sleep: async (ms) => {
      sleeps += 1;
      harness.setNow(harness.now() + ms);
      if (sleeps >= 2) schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;

  await scheduler.runForever();
  assert.equal(mock.countMatching(/\/claim$/), 1, '同一天只领取一次');
});

test('启动补偿：当天已过检查时间且未完成 → 立即执行', async () => {
  const mock = createMockFetch([
    { match: /\/claim$/, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: '/sash/api/v1/me/campaigns', handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: '/api/v2/quota/usage', handler: () => jsonResponse(quotaPayload(100)) },
  ]);
  // 21:00 北京时间，已过 10:05
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl, now: Date.parse('2026-11-03T13:00:00.000Z') });
  seedAccount(harness, 'u1');

  let schedulerRef: QoderScheduler | null = null;
  const scheduler = new QoderScheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => harness.store.listAccounts(),
    now: harness.now,
    sleep: async () => {
      schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;

  await scheduler.runForever();
  assert.equal(mock.countMatching(/\/claim$/), 1, '启动时应补执行一次');
});

test('启动补偿：当天已确认完成则不请求', async () => {
  const mock = createMockFetch([]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl, now: Date.parse('2026-11-03T13:00:00.000Z') });
  const account = seedAccount(harness, 'u1');
  harness.store.saveRecord({
    accountId: account.id,
    region: 'cn',
    date: '2026-11-03',
    outcome: 'claimed',
    ok: true,
    campaignId: 'c',
    campaignAmount: 100,
    claimedAmount: 100,
    creditsBefore: 0,
    creditsAfter: 100,
    creditsDelta: 100,
    verified: true,
    verification: 'quota-delta',
    message: 'ok',
    at: harness.now(),
    durationMs: 10,
    dryRun: false,
    accountTag: 'cn-x',
    note: account.note,
  });

  let schedulerRef: QoderScheduler | null = null;
  const scheduler = new QoderScheduler({
    config: harness.config,
    logger: harness.logger,
    service: harness.service,
    accounts: () => harness.store.listAccounts(),
    now: harness.now,
    sleep: async () => {
      schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;

  await scheduler.runForever();
  assert.equal(mock.calls.length, 0, '已完成时不应发任何请求');
});

test('pid 文件：写入 / 读取 / 探测 / 清理', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qoder-pid-'));
  const pidFile = new QoderPidFile(dir);
  assert.equal(pidFile.existing(), null);
  const pid = pidFile.write();
  assert.equal(pidFile.read(), pid);
  assert.equal(pidFile.existing(), pid, '当前进程应被识别为存活');
  pidFile.clear();
  assert.equal(pidFile.read(), null);

  // 陈旧 pid（不存在的进程）应被视为无占用
  fs.writeFileSync(path.join(dir, 'qoder-daemon.pid'), '999999');
  assert.equal(pidFile.existing(), null);
});

test('默认配置：每天 10:05、窗口重试开启且有上限', () => {
  const config = defaultQoderConfig();
  assert.deepEqual(config.checkTimes, ['10:05']);
  assert.equal(config.windowRetry.enabled, true);
  assert.ok(config.windowRetry.max <= 12);
  assert.ok(config.windowRetry.gapMs >= 10_000);
  assert.deepEqual(config.regions, ['cn', 'global'] as never);
});
