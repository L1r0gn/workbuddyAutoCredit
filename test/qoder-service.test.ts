/**
 * 签到闭环测试：领取 / 已领取 / 跳过 / 续期 / 额度 / 无活动 / 阻塞 / 多账号 / 区域隔离。
 * 全部使用可编程 fetch，不消耗真实签到机会。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  RISK,
  campaignsPayload,
  createMockFetch,
  createQoderHarness,
  dailyCampaign,
  jsonResponse,
  qoderAccount,
  quotaPayload,
} from './qoder-helpers';
import type { QoderCheckinRecord } from '../qoder/types';

const CLAIM = /\/claim$/;
const CAMPAIGNS = '/sash/api/v1/me/campaigns';
const QUOTA = '/api/v2/quota/usage';
const REFRESH = '/refresh';

/** 预置账号到 store，便于 service 能落库。 */
function seed(harness: ReturnType<typeof createQoderHarness>, account = qoderAccount()) {
  harness.store.upsertAccount({
    region: account.region,
    note: account.note,
    uid: account.uid,
    tokens: account.tokens,
  });
  const stored = harness.store.getAccount(account.id);
  assert.ok(stored, '账号应已写入存储');
  return stored;
}

test('今日已领取（服务端 CLAIMED 行）→ already，不调用领取接口', async () => {
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    {
      match: CAMPAIGNS,
      handler: () => jsonResponse(campaignsPayload([dailyCampaign({ claimStatus: 'CLAIMED' })])),
    },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(500)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'already');
  assert.equal(record.ok, true);
  assert.equal(record.verified, true);
  assert.equal(record.verification, 'server-status');
  assert.equal(mock.countMatching(CLAIM), 0, '已领取时不应再发领取请求');
});

test('可领取 → claimed，并用额度增量验证到账', async () => {
  let quota = 1000;
  const mock = createMockFetch([
    {
      match: CLAIM,
      handler: () => {
        quota += 100;
        return jsonResponse({ status: 'CLAIMED', benefit: { amount: 100 } });
      },
    },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(quota)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'claimed');
  assert.equal(record.ok, true);
  assert.equal(record.verified, true);
  assert.equal(record.verification, 'quota-delta');
  assert.equal(record.creditsBefore, 1000);
  assert.equal(record.creditsAfter, 1100);
  assert.equal(record.creditsDelta, 100);
  assert.equal(record.campaignId, 'cmp-daily-001');
  assert.equal(record.claimedAmount, 100);
  assert.equal(mock.countMatching(CLAIM), 1);
});

test('已领取但额度未变化：仍按服务端状态判定成功，验证依据降级', async () => {
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'claimed');
  assert.equal(record.verified, true);
  assert.equal(record.verification, 'server-status');
  assert.match(record.diagnostic || '', /差额为 0/);
});

test('本地已验证记录命中 → skipped，零网络请求', async () => {
  const mock = createMockFetch([{ match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) }]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);
  harness.store.saveRecord({
    accountId: account.id,
    region: 'cn',
    date: '2026-11-03',
    outcome: 'claimed',
    ok: true,
    campaignId: 'cmp-daily-001',
    campaignAmount: 100,
    claimedAmount: 100,
    creditsBefore: 1000,
    creditsAfter: 1100,
    creditsDelta: 100,
    verified: true,
    verification: 'quota-delta',
    message: '领取成功',
    at: harness.now(),
    durationMs: 100,
    dryRun: false,
    accountTag: 'cn-test',
    note: account.note,
  } satisfies QoderCheckinRecord);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'skipped');
  assert.equal(record.ok, true);
  assert.equal(record.verification, 'local-record');
  assert.equal(mock.calls.length, 0, '跳过时不应发出任何请求');
});

test('重复运行：同一天只会真正领取一次', async () => {
  let claimed = 0;
  let quota = 1000;
  const mock = createMockFetch([
    {
      match: CLAIM,
      handler: () => {
        claimed += 1;
        quota += 100;
        return jsonResponse({ status: 'CLAIMED' });
      },
    },
    {
      match: CAMPAIGNS,
      handler: () =>
        jsonResponse(campaignsPayload([dailyCampaign({ claimStatus: claimed > 0 ? 'CLAIMED' : 'CLAIMABLE' })])),
    },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(quota)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const first = await harness.service.checkin(account);
  const second = await harness.service.checkin(account);
  const third = await harness.service.checkin(account);

  assert.equal(first.outcome, 'claimed');
  assert.equal(second.outcome, 'skipped');
  assert.equal(third.outcome, 'skipped');
  assert.equal(claimed, 1, '同一天只允许一次领取请求');
});

test('并发同一账号：复用同一任务，只领取一次', async () => {
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const results = await Promise.all([
    harness.service.checkin(account),
    harness.service.checkin(account),
    harness.service.checkin(account),
  ]);
  assert.equal(mock.countMatching(CLAIM), 1);
  assert.ok(results.every((item) => item.outcome === 'claimed'));
});

test('会话失效（401）→ 自动续期后重试成功，并把新令牌落盘', async () => {
  let campaignCalls = 0;
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    {
      match: CAMPAIGNS,
      handler: () => {
        campaignCalls += 1;
        if (campaignCalls === 1) return jsonResponse({ message: 'token expired' }, 401);
        return jsonResponse(campaignsPayload([dailyCampaign()]));
      },
    },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
    {
      match: REFRESH,
      handler: () => jsonResponse({ device_token: 'dt-renewed', refresh_token: 'drt-renewed' }),
    },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'claimed');
  assert.equal(record.tokenRefreshed, true);
  assert.equal(mock.countMatching(REFRESH), 1);

  const stored = harness.store.getAccount(account.id);
  assert.equal(stored?.tokens.access, 'dt-renewed', '轮换后的 access token 必须落盘');
  assert.equal(stored?.tokens.refresh, 'drt-renewed', '轮换后的 refresh token 必须落盘');
});

test('业务码 105 同样触发续期', async () => {
  let calls = 0;
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    {
      match: CAMPAIGNS,
      handler: () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ code: 105, message: 'token expired' });
        return jsonResponse(campaignsPayload([dailyCampaign()]));
      },
    },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
    { match: REFRESH, handler: () => jsonResponse({ token: 'dt-renewed-2' }) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'claimed');
  assert.equal(record.tokenRefreshed, true);
});

test('续期失败 → unauthorized，且不误报成功', async () => {
  const mock = createMockFetch([
    { match: CAMPAIGNS, handler: () => jsonResponse({ message: 'unauthorized' }, 401) },
    { match: REFRESH, handler: () => jsonResponse({ message: 'revoked' }, 401) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'unauthorized');
  assert.equal(record.ok, false);
  assert.match(record.diagnostic || '', /重新登录/);
});

test('额度类 403：标记 quota-exhausted，不触发续期', async () => {
  const mock = createMockFetch([
    { match: CAMPAIGNS, handler: () => jsonResponse({ code: 112, pricingUrl: '/pricing' }, 403) },
    { match: REFRESH, handler: () => jsonResponse({ device_token: 'should-not-happen' }) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'quota-exhausted');
  assert.equal(record.ok, false);
  assert.equal(mock.countMatching(REFRESH), 0, '额度问题不应触发令牌续期');
});

test('无活动行 + 无设备身份 → no-campaign，并提示 UMID 缺失', async () => {
  const mock = createMockFetch([
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(0)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl, risk: null });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'no-campaign');
  assert.equal(record.ok, false);
  assert.match(record.message, /UMID/);
});

test('无活动行但有设备身份 → no-campaign，提示可能是窗口/已领', async () => {
  const mock = createMockFetch([
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(0)) },
  ]);
  const harness = createQoderHarness({
    fetchImpl: mock.fetchImpl,
    risk: RISK,
    config: { windowRetry: { enabled: false, max: 1, gapMs: 1 } },
  });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'no-campaign');
  assert.match(record.message, /10:00|活动/);
});

test('领取被阻塞（BLOCKED / 同人多号）→ blocked', async () => {
  const mock = createMockFetch([
    {
      match: CLAIM,
      handler: () => jsonResponse({ status: 'BLOCKED', failureCode: 'SAME_PERSON_ALREADY_CLAIMED' }),
    },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'blocked');
  assert.equal(record.ok, false);
  assert.match(record.message, /同一设备身份/);
});

test('领取返回 409 ALREADY_CLAIMED → already（幂等，不重复发放）', async () => {
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ errorCode: 'ALREADY_CLAIMED' }, 409) },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'already');
  assert.equal(record.ok, true);
  assert.equal(record.verified, true);
});

test('网络异常 → error，不误报成功', async () => {
  const mock = createMockFetch([
    {
      match: CAMPAIGNS,
      handler: () => {
        throw new TypeError('fetch failed');
      },
    },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.ok, false);
  assert.equal(record.outcome, 'error');
  assert.equal(harness.store.hasConfirmed(account.id, '2026-11-03'), false);
});

test('多账号：一个失败不影响另一个，各自独立落库', async () => {
  const good = qoderAccount({ id: 'cn:uid-good', region: 'cn', uid: 'uid-good', note: '好账号' });
  const bad = qoderAccount({ id: 'global:uid-bad', region: 'global', uid: 'uid-bad', note: '坏账号' });

  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    {
      match: 'openapi.qoder.sh/sash/api/v1/me/campaigns',
      handler: () => jsonResponse({ message: 'unauthorized' }, 401),
    },
    { match: 'openapi.qoder.sh/refresh', handler: () => jsonResponse({ message: 'revoked' }, 401) },
    { match: 'openapi.qoder.com.cn/sash/api/v1/me/campaigns', handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: 'openapi.qoder.com.cn/api/v2/quota/usage', handler: () => jsonResponse(quotaPayload(1000)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  seed(harness, good);
  seed(harness, bad);

  const stored = harness.store.listAccounts();
  const batch = await harness.service.checkinAll(stored);
  assert.equal(batch.summary.total, 2);
  assert.equal(batch.summary.claimed, 1);
  assert.equal(batch.summary.failed, 1);
  const cnRecord = harness.store.getRecord('cn:uid-good', '2026-11-03');
  const intlRecord = harness.store.getRecord('global:uid-bad', '2026-11-03');
  assert.equal(cnRecord?.outcome, 'claimed');
  assert.equal(intlRecord?.outcome, 'unauthorized');
});

test('区域隔离：国内版账号只请求 openapi.qoder.com.cn，国际版只请求 openapi.qoder.sh', async () => {
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(100)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });

  const cn = seed(harness, qoderAccount({ id: 'cn:u1', region: 'cn', uid: 'u1' }));
  await harness.service.checkin(cn);
  const cnCalls = mock.calls.length;
  assert.ok(cnCalls > 0);
  assert.ok(mock.calls.every((call) => new URL(call.url).host === 'openapi.qoder.com.cn'), '国内版不应请求国际域名');

  mock.calls.length = 0;
  const intl = seed(harness, qoderAccount({ id: 'global:u2', region: 'global', uid: 'u2' }));
  await harness.service.checkin(intl);
  assert.ok(mock.calls.length > 0);
  assert.ok(mock.calls.every((call) => new URL(call.url).host === 'openapi.qoder.sh'), '国际版不应请求国内域名');
});

test('dry-run：不调用领取接口，但会报告发现的活动', async () => {
  const mock = createMockFetch([
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(500)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const record = await harness.service.checkin(account, { dryRun: true });
  assert.equal(record.outcome, 'dry-run');
  assert.equal(record.campaignId, 'cmp-daily-001');
  assert.equal(record.campaignAmount, 100);
  assert.equal(mock.countMatching(CLAIM), 0);
  assert.equal(harness.store.hasConfirmed(account.id, '2026-11-03'), false);
});

test('10 点窗口内未下发活动 → 有限次重试后成功', async () => {
  let rounds = 0;
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    {
      match: CAMPAIGNS,
      handler: () => {
        rounds += 1;
        if (rounds === 1) return jsonResponse(campaignsPayload([]));
        return jsonResponse(campaignsPayload([dailyCampaign()]));
      },
    },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(100)) },
  ]);
  // 时钟固定在 10:05（北京时间），窗口重试开启，间隔 1ms
  const harness = createQoderHarness({
    fetchImpl: mock.fetchImpl,
    config: { windowRetry: { enabled: true, max: 2, gapMs: 1 } },
  });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'claimed');
  // 第一次空表 → 国内版最小头复取（第 2 次）拿到活动，无需进入 10 点窗口重试
  assert.equal(rounds, 2, '应通过国内版最小头复取拿到活动');
  assert.equal(mock.countMatching(CLAIM), 1);
});

test('窗口外不重试：避免无意义的持续请求', async () => {
  let rounds = 0;
  const mock = createMockFetch([
    {
      match: CAMPAIGNS,
      handler: () => {
        rounds += 1;
        // 非空但不参与每日领取 → 不触发国内版空表复取，也不进入窗口重试
        return jsonResponse(campaignsPayload([
          { campaignId: 'x1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 10 } },
        ]));
      },
    },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(0)) },
  ]);
  // 时钟固定在 20:05（北京时间），不在窗口内
  const harness = createQoderHarness({
    fetchImpl: mock.fetchImpl,
    now: Date.parse('2026-11-03T12:05:00.000Z'),
    config: { windowRetry: { enabled: true, max: 3, gapMs: 1 } },
  });
  const account = seed(harness);

  const record = await harness.service.checkin(account);
  assert.equal(record.outcome, 'no-campaign');
  assert.equal(rounds, 1, '窗口外不应重试');
});

test('--force：忽略本地记录再次确认，服务端返回 replayed 时按已领取处理', async () => {
  let claims = 0;
  const mock = createMockFetch([
    {
      match: CLAIM,
      handler: () => {
        claims += 1;
        return jsonResponse(claims === 1 ? { status: 'CLAIMED' } : { status: 'CLAIMED', replayed: true });
      },
    },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(1000)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);

  const first = await harness.service.checkin(account);
  const forced = await harness.service.checkin(account, { force: true });
  assert.equal(first.outcome, 'claimed');
  assert.equal(forced.outcome, 'already');
  assert.equal(claims, 2);
});

test('签到记录与日志中不出现令牌', async () => {
  const mock = createMockFetch([
    { match: CLAIM, handler: () => jsonResponse({ status: 'CLAIMED' }) },
    { match: CAMPAIGNS, handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
    { match: QUOTA, handler: () => jsonResponse(quotaPayload(100)) },
  ]);
  const harness = createQoderHarness({ fetchImpl: mock.fetchImpl });
  const account = seed(harness);
  await harness.service.checkin(account);

  const record = harness.store.getRecord(account.id, '2026-11-03');
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('dt-access-test-token'), false);
  assert.equal(serialized.includes('drt-refresh-test-token'), false);
});
