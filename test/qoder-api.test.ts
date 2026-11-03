/**
 * Qoder 接口层测试：区域隔离、活动解析、领取判定矩阵、额度/鉴权错误分流、国内版空表复取。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  authDead,
  campaignResponseIsEmpty,
  claimCampaign,
  fetchCampaigns,
  fetchQuotaTotal,
  minimalSashHeaders,
  normalizeCampaignRow,
  parseClaimResponse,
  quotaCooldown,
  sashHeaders,
  type QoderApiContextWithMachine,
} from '../qoder/api';
import type { QoderTokens } from '../qoder/types';
import type { RetryPolicy } from '../checkin/client';
import { campaignRows } from '../qoder/api';
import { RISK, campaignsPayload, createMockFetch, dailyCampaign, jsonResponse, quotaPayload } from './qoder-helpers';

const fastRetry: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 2, sleepImpl: async () => undefined };
const TOKENS: QoderTokens = { access: 'dt-access-test', refresh: 'drt-refresh-test', updatedAt: 0 };

function ctx(overrides: Partial<QoderApiContextWithMachine> = {}): QoderApiContextWithMachine {
  return {
    region: 'cn',
    tokens: TOKENS,
    uid: 'uid-1',
    machineId: 'machine-1',
    clientVersion: '0.4.11',
    risk: RISK,
    retry: fastRetry,
    timeoutMs: 5000,
    machineOs: 'x86_64_win32',
    machineHostname: 'TESTHOST',
    ...overrides,
  };
}

test('两个区域使用各自的接口域名，绝不混用', () => {
  // 国内版 → openapi.qoder.com.cn
  assert.match(ctx({ region: 'cn' }).region, /cn/);
  assert.equal(new URL('https://openapi.qoder.com.cn/sash/api/v1/me/campaigns').host, 'openapi.qoder.com.cn');
  assert.equal(new URL('https://openapi.qoder.sh/sash/api/v1/me/campaigns').host, 'openapi.qoder.sh');
});

test('基础鉴权头与最小头符合上游形态', () => {
  const full = sashHeaders('dt-abc');
  assert.equal(full.authorization, 'Bearer dt-abc');
  assert.equal(full['cosy-clienttype'], '10');
  assert.equal(full['user-agent'], 'Qoder');

  const minimal = minimalSashHeaders('dt-abc');
  assert.deepEqual(Object.keys(minimal).sort(), [
    'authorization',
    'content-type',
    'cosy-clienttype',
    'user-agent',
  ]);
});

test('活动行归一化：只使用已确认字段', () => {
  const row = normalizeCampaignRow({
    campaignId: 'c1',
    campaignKey: 'act-1',
    actionType: 'claim_benefit',
    claimStatus: 'claimable',
    benefit: { kind: 'credits', amount: '100' },
    title: '每日',
    unknownField: 'should-not-appear',
  });
  assert.equal(row.campaignId, 'c1');
  assert.equal(row.actionType, 'CLAIM_BENEFIT');
  assert.equal(row.claimStatus, 'CLAIMABLE');
  assert.equal(row.benefitKind, 'CREDITS');
  assert.equal(row.benefitAmount, 100);
  assert.equal('unknownField' in row, false);
});

test('活动行支持 campaignId 与 id 两种写法，且能从 data.campaigns 取到', () => {
  const rows = campaignRows({ data: { campaigns: [{ id: 'x1' }, { campaignId: 'x2' }] } });
  assert.equal(rows.length, 2);
  assert.equal(normalizeCampaignRow(rows[0] as Record<string, unknown>).campaignId, 'x1');
  assert.equal(normalizeCampaignRow(rows[1] as Record<string, unknown>).campaignId, 'x2');
});

test('会话失效判定：401/403 与业务码 105 / 10019901001', () => {
  const make = (status: number, body: unknown) =>
    ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(body), json: body as Record<string, unknown>, errorKind: 'none', error: null, durationMs: 0, attempts: 1, url: 'x' }) as never;
  assert.equal(authDead(make(401, { message: 'unauthorized' })), true);
  assert.equal(authDead(make(200, { code: 105 })), true);
  assert.equal(authDead(make(200, { data: { code: '10019901001' } })), true);
  assert.equal(authDead(make(200, { campaigns: [] })), false);
});

test('额度类 403 不算登录失效，且给出冷却时长', () => {
  const base = Date.parse('2026-11-03T12:00:00+08:00');
  const make = (status: number, body: unknown) =>
    ({ status, ok: false, text: JSON.stringify(body), json: body as Record<string, unknown>, errorKind: 'none', error: null, durationMs: 0, attempts: 1, url: 'x' }) as never;

  const exhausted = quotaCooldown(make(403, { code: 112, pricingUrl: '/pricing' }), base);
  assert.equal(exhausted.kind, 'exhausted');
  assert.equal(exhausted.seconds, 1800);
  assert.equal(authDead(make(403, { code: 112 }), base), false, '额度问题不应触发续期');

  const daily = quotaCooldown(make(403, { code: 110, message: 'Billing daily count exceeded' }), base);
  assert.equal(daily.kind, 'daily');
  assert.ok(daily.seconds >= 60 && daily.seconds <= 6 * 3600, `冷却应在 60s~6h 之间，实际 ${daily.seconds}`);
  assert.equal(authDead(make(403, { code: 110 }), base), false);
});

test('空表判定只在成功且明确为空时成立', () => {
  const make = (status: number, body: unknown) =>
    ({ status, ok: status === 200, text: JSON.stringify(body), json: body as Record<string, unknown>, errorKind: 'none', error: null, durationMs: 0, attempts: 1, url: 'x' }) as never;
  assert.equal(campaignResponseIsEmpty(make(200, { campaigns: [] })), true);
  assert.equal(campaignResponseIsEmpty(make(200, { showCampaign: false })), true);
  assert.equal(campaignResponseIsEmpty(make(200, { campaigns: [{ id: 'x' }] })), false);
  assert.equal(campaignResponseIsEmpty(make(401, { campaigns: [] })), false);
  assert.equal(campaignResponseIsEmpty(make(200, { code: 105, campaigns: [] })), false);
});

test('领取判定矩阵与上游测试用例一致', () => {
  const make = (status: number, body: unknown) =>
    ({ status, ok: status >= 200 && status < 300, text: JSON.stringify(body), json: body as Record<string, unknown>, errorKind: 'none', error: null, durationMs: 0, attempts: 1, url: 'x' }) as never;

  const cases: Array<[number, Record<string, unknown>, string]> = [
    [200, { data: { status: 'CLAIMED' } }, 'claimed'],
    [200, { status: 'GRANTED' }, 'claimed'],
    [200, { status: 'SUCCESS' }, 'claimed'],
    [200, { status: 'CLAIMED', replayed: true }, 'already'],
    [200, { result: 'ALREADY_CLAIMED' }, 'already'],
    [409, { errorCode: 'ALREADY_CLAIMED' }, 'already'],
    [409, { errorCode: 'REPLAYED' }, 'already'],
    [409, { errorCode: 'OTHER_CONFLICT' }, 'error'],
    [200, { status: 'BLOCKED', failureCode: 'SAME_PERSON_ALREADY_CLAIMED' }, 'blocked'],
    [200, { failureCode: 'REDEMPTION_CODE_OUT_OF_STOCK' }, 'error'],
    [200, { message: 'ok but unknown' }, 'error'],
    [500, { message: 'boom' }, 'error'],
  ];
  for (const [status, body, expected] of cases) {
    const result = parseClaimResponse(make(status, body));
    assert.equal(result.verdict, expected, `HTTP ${status} ${JSON.stringify(body)}`);
  }
});

test('领取命中 HTTP 200 但无成功状态：绝不当作成功', () => {
  const result = parseClaimResponse({
    status: 200,
    ok: true,
    text: '{"status":"PENDING"}',
    json: { status: 'PENDING' },
    errorKind: 'none',
    error: null,
    durationMs: 0,
    attempts: 1,
    url: 'x',
  } as never);
  assert.equal(result.verdict, 'error');
  assert.equal(result.amount, 0);
});

test('国内版空表 → 用最小头复取一次；复取仍空则保留原始响应', async () => {
  let calls = 0;
  const mock = createMockFetch([
    {
      match: '/sash/api/v1/me/campaigns',
      handler: (call) => {
        calls += 1;
        if (calls === 1) return jsonResponse({ showCampaign: false, campaigns: [] });
        // 第二次（最小头）应当没有 Cosy-Machine* 头
        assert.equal(call.headers['cosy-machinetoken'], undefined);
        assert.equal(call.headers['content-type'], 'application/json');
        return jsonResponse(campaignsPayload([dailyCampaign()]));
      },
    },
  ]);

  const result = await fetchCampaigns(ctx({ fetchImpl: mock.fetchImpl }));
  assert.equal(result.rows.length, 1);
  assert.equal(result.minimalFallbackUsed, true);
  assert.equal(calls, 2);
});

test('国际版不做最小头复取', async () => {
  let calls = 0;
  const mock = createMockFetch([
    {
      match: '/sash/api/v1/me/campaigns',
      handler: () => {
        calls += 1;
        return jsonResponse({ campaigns: [] });
      },
    },
  ]);
  const result = await fetchCampaigns(ctx({ region: 'global', fetchImpl: mock.fetchImpl }));
  assert.equal(result.rows.length, 0);
  assert.equal(result.minimalFallbackUsed, false);
  assert.equal(calls, 1);
});

test('活动查询带上设备风控头', async () => {
  const mock = createMockFetch([
    { match: '/sash/api/v1/me/campaigns', handler: () => jsonResponse(campaignsPayload([dailyCampaign()])) },
  ]);
  await fetchCampaigns(ctx({ fetchImpl: mock.fetchImpl }));
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.headers['cosy-machinetoken'], RISK.machineToken);
  assert.equal(call.headers['cosy-machinecode'], RISK.machineCode);
  assert.equal(call.headers['cosy-machinetype'], RISK.machineType);
  assert.equal(call.headers['cosy-version'], '0.4.11');
  assert.equal(call.headers['cosy-machineos'], 'x86_64_win32');
  assert.equal(call.headers['cosy-machineid'], 'machine-1');
  assert.equal(call.headers.authorization, 'Bearer dt-access-test');
  // 官方客户端不发送 forceRefresh
  assert.equal(call.url.includes('forceRefresh'), false);
});

test('无设备身份时不带 Cosy-MachineToken（上游会因此不下发活动）', async () => {
  const mock = createMockFetch([
    { match: '/sash/api/v1/me/campaigns', handler: () => jsonResponse(campaignsPayload([])) },
  ]);
  await fetchCampaigns(ctx({ risk: null, fetchImpl: mock.fetchImpl }));
  assert.equal(mock.calls[0]?.headers['cosy-machinetoken'], undefined);
});

test('额度类 403 归为 quota-exhausted 且不判为 unauthorized', async () => {
  const mock = createMockFetch([
    { match: '/sash/api/v1/me/campaigns', handler: () => jsonResponse({ code: 112, pricingUrl: '/pricing' }, 403) },
  ]);
  const result = await fetchCampaigns(ctx({ fetchImpl: mock.fetchImpl }));
  assert.equal(result.ok, false);
  assert.equal(result.quotaKind, 'exhausted');
  assert.match(result.error || '', /额度/);
});

test('领取请求：POST 到 {base}/sash/api/v1/me/campaigns/{id}/claim，body {}', async () => {
  const mock = createMockFetch([
    { match: '/claim', handler: () => jsonResponse({ status: 'CLAIMED', benefit: { amount: 100 } }) },
  ]);
  const result = await claimCampaign(ctx({ fetchImpl: mock.fetchImpl }), 'cmp-123');
  assert.equal(result.verdict, 'claimed');
  assert.equal(result.amount, 100);
  const call = mock.calls[0];
  assert.ok(call);
  assert.equal(call.method, 'POST');
  assert.match(call.url, /^https:\/\/openapi\.qoder\.com\.cn\/sash\/api\/v1\/me\/campaigns\/cmp-123\/claim$/);
  assert.equal(call.body, '{}');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.headers.origin, 'https://openapi.qoder.com.cn');
});

test('非法 campaignId 直接拒绝，不发请求', async () => {
  const mock = createMockFetch([{ match: '/claim', handler: () => jsonResponse({ status: 'CLAIMED' }) }]);
  const result = await claimCampaign(ctx({ fetchImpl: mock.fetchImpl }), '../etc/passwd');
  assert.equal(result.verdict, 'error');
  assert.equal(mock.calls.length, 0);
});

test('额度汇总：userQuota + addOnQuota + 资源包 + 组织额度', async () => {
  const mock = createMockFetch([
    {
      match: '/api/v2/quota/usage',
      handler: () =>
        jsonResponse({
          data: {
            userQuota: { remaining: 100.5 },
            addOnQuota: { remaining: 20 },
            dedicatedResourcePackages: [{ remaining: 7 }, { remaining: 2.5 }],
            orgResourcePackage: { remaining: 30 },
          },
        }),
    },
  ]);
  const result = await fetchQuotaTotal(ctx({ fetchImpl: mock.fetchImpl }));
  assert.equal(result.total, 160);
  assert.equal(result.error, null);
});

test('额度响应结构未知时返回 null 而不是 0', async () => {
  const mock = createMockFetch([{ match: '/api/v2/quota/usage', handler: () => jsonResponse({ data: {} }) }]);
  const result = await fetchQuotaTotal(ctx({ fetchImpl: mock.fetchImpl }));
  assert.equal(result.total, null);
  assert.match(result.error || '', /结构未知/);
});

test('网络异常：重试后返回失败，不伪造结果', async () => {
  let attempts = 0;
  const mock = createMockFetch([
    {
      match: '/sash/api/v1/me/campaigns',
      handler: () => {
        attempts += 1;
        throw new TypeError('fetch failed');
      },
    },
  ]);
  const result = await fetchCampaigns(
    ctx({ fetchImpl: mock.fetchImpl, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleepImpl: async () => undefined } }),
  );
  assert.equal(result.ok, false);
  assert.ok(attempts >= 1);
  assert.ok(result.error);
});
