/**
 * 接口层测试：结果判定表、地址解析、积分解析、网络异常与重试。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildCreditResourceBody,
  classifyCheckinResult,
  claimDailyCheckin,
  extractCreditTotal,
  fetchCredits,
  resolveCheckinEndpoints,
  resolveCreditHosts,
} from '../checkin/credit-api';
import { isTransient, requestWithRetry, type RetryPolicy } from '../checkin/client';
import { createMockFetch, creditPayload, fakeJwt, jsonResponse } from './helpers';

const fastRetry: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleepImpl: async () => undefined };

test('判定表：只有显式成功或显式已签到才算完成', () => {
  const cases: Array<{ input: Parameters<typeof classifyCheckinResult>[0]; verdict: string; ok: boolean }> = [
    { input: { httpOk: true, status: 200, code: 0, message: 'OK' }, verdict: 'success', ok: true },
    { input: { httpOk: false, status: 400, code: 10001, message: '今天已签到，请明天再来' }, verdict: 'already', ok: true },
    { input: { httpOk: true, status: 200, code: 10001, message: '今日已签到' }, verdict: 'already', ok: true },
    { input: { httpOk: true, status: 200, code: 10001, message: '请求成功' }, verdict: 'unknown', ok: false },
    { input: { httpOk: true, status: 200, code: 10001, message: '活动未开启' }, verdict: 'inactive', ok: false },
    { input: { httpOk: true, status: 200, code: undefined, message: 'OK' }, verdict: 'unknown', ok: false },
    // HTTP 层失败时即使 code=0 也不算成功（网关可能返回半截响应）
    { input: { httpOk: false, status: 200, code: 0, message: 'OK' }, verdict: 'unknown', ok: false },
    { input: { httpOk: false, status: 401, code: null, message: '' }, verdict: 'unauthorized', ok: false },
    { input: { httpOk: false, status: 403, code: null, message: '' }, verdict: 'unauthorized', ok: false },
    { input: { httpOk: true, status: 200, code: 200, message: 'ok' }, verdict: 'unknown', ok: false },
  ];
  for (const { input, verdict, ok } of cases) {
    const result = classifyCheckinResult(input);
    assert.equal(result.verdict, verdict, `verdict for ${JSON.stringify(input)}`);
    assert.equal(result.ok, ok, `ok for ${JSON.stringify(input)}`);
  }
});

test('活动关闭文案优先于 code=10001 的"已领取"含义', () => {
  const result = classifyCheckinResult({ httpOk: true, status: 200, code: 10001, message: '活动已结束，已领取的积分保留' });
  assert.equal(result.verdict, 'inactive');
  assert.equal(result.ok, false);
});

test('签到地址优先使用令牌签发域，且同时给出两个版本路径', () => {
  const token = fakeJwt({ iss: 'https://www.workbuddy.cn/auth/realms/copilot' });
  const endpoints = resolveCheckinEndpoints(token, 'workbuddy-cn');
  assert.deepEqual(endpoints, [
    'https://www.workbuddy.cn/billing/meter/daily-checkin',
    'https://www.workbuddy.cn/v2/billing/meter/daily-checkin',
  ]);
});

test('无法识别签发域时回落 profile 域名，并附加同族域名兜底', () => {
  const endpoints = resolveCheckinEndpoints('not-a-jwt', 'workbuddy-cn');
  assert.equal(endpoints[0], 'https://www.codebuddy.cn/billing/meter/daily-checkin');
  assert.ok(endpoints.some((url) => url.startsWith('https://www.workbuddy.cn/')));
});

test('国际版回落自己的域名，不混入国内域名', () => {
  const endpoints = resolveCheckinEndpoints('not-a-jwt', 'workbuddy-ai');
  assert.deepEqual(endpoints, [
    'https://www.workbuddy.ai/billing/meter/daily-checkin',
    'https://www.workbuddy.ai/v2/billing/meter/daily-checkin',
  ]);
});

test('积分查询主机优先 profile 主域，其次签发域', () => {
  const token = fakeJwt({ iss: 'https://www.workbuddy.cn' });
  assert.deepEqual(resolveCreditHosts(token, 'workbuddy-cn'), ['https://www.codebuddy.cn', 'https://www.workbuddy.cn']);
});

test('积分请求体字段与官方一致', () => {
  const body = buildCreditResourceBody(new Date('2026-11-02T10:05:00'));
  assert.equal(body.PageNumber, 1);
  assert.equal(body.PageSize, 100);
  assert.equal(body.ProductCode, 'p_tcaca');
  assert.deepEqual(body.Status, [0, 3]);
  assert.match(String(body.PackageEndTimeRangeBegin), /^2026-11-02 10:05:00$/);
  assert.match(String(body.PackageEndTimeRangeEnd), /^2127-11-02 10:05:00$/);
});

test('积分解析优先取周期剩余，缺失时退回总量剩余', () => {
  const payload = {
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            { CycleCapacityRemainPrecise: '97.66', CapacityRemainPrecise: '500' },
            { CapacityRemain: '100' },
          ],
        },
      },
    },
  };
  const result = extractCreditTotal(payload);
  assert.equal(result.accounts, 2);
  assert.equal(result.total, 197.66);
});

test('积分解析：无 Accounts 时返回 null 而不是 0（避免把查询失败当成 0 积分）', () => {
  const result = extractCreditTotal({ code: 0, data: {} });
  assert.equal(result.total, null);
  assert.equal(result.accounts, 0);
});

test('网络断开：重试后返回明确失败，不伪造成功', async () => {
  let attempts = 0;
  const mock = createMockFetch([
    {
      match: /daily-checkin/,
      handler: () => {
        attempts += 1;
        throw new TypeError('fetch failed');
      },
    },
  ]);
  const result = await claimDailyCheckin({
    profile: 'workbuddy-cn',
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn' }),
    uid: 'uid-1',
    domain: 'workbuddy.cn',
    fetchImpl: mock.fetchImpl,
    retry: fastRetry,
  });

  assert.equal(result.classification.ok, false);
  assert.equal(result.classification.verdict, 'unknown');
  // 两个候选签到地址各自重试到上限：2 × maxAttempts
  assert.equal(attempts, fastRetry.maxAttempts * 2, '每个候选地址都应重试到上限');
  assert.ok(result.transportError);
});

test('404 时切换到下一个候选地址', async () => {
  const calls: string[] = [];
  const mock = createMockFetch([
    {
      match: 'www.workbuddy.cn/billing/meter/daily-checkin',
      handler: (call) => {
        calls.push(call.url);
        return new Response('not found', { status: 404 });
      },
    },
    {
      match: 'www.workbuddy.cn/v2/billing/meter/daily-checkin',
      handler: (call) => {
        calls.push(call.url);
        return jsonResponse({ code: 0, msg: 'OK' });
      },
    },
  ]);

  const result = await claimDailyCheckin({
    profile: 'workbuddy-cn',
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn' }),
    uid: 'uid-1',
    domain: 'workbuddy.cn',
    fetchImpl: mock.fetchImpl,
    retry: fastRetry,
  });

  assert.equal(result.classification.verdict, 'success');
  assert.equal(calls.length, 2);
  assert.match(result.endpoint ?? '', /v2\/billing\/meter\/daily-checkin$/);
});

test('5xx 视为瞬时故障并重试，最终仍失败时保持 unknown', async () => {
  let count = 0;
  const mock = createMockFetch([
    {
      match: /daily-checkin/,
      handler: () => {
        count += 1;
        return jsonResponse({ code: 50000, msg: 'internal error' }, 500);
      },
    },
  ]);
  const result = await claimDailyCheckin({
    profile: 'workbuddy-cn',
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn' }),
    uid: 'uid-1',
    domain: 'workbuddy.cn',
    fetchImpl: mock.fetchImpl,
    retry: fastRetry,
  });

  assert.equal(result.classification.ok, false);
  assert.ok(count >= 2, '5xx 应触发重试');
});

test('isTransient 只对超时/网络/429/5xx 返回 true', () => {
  const base = { ok: false, text: '', json: null, error: null, durationMs: 0, attempts: 1, url: 'x' };
  assert.equal(isTransient({ ...base, status: 500, errorKind: 'none' }), true);
  assert.equal(isTransient({ ...base, status: 429, errorKind: 'none' }), true);
  assert.equal(isTransient({ ...base, status: 401, errorKind: 'none' }), false);
  assert.equal(isTransient({ ...base, status: 0, errorKind: 'network' }), true);
  assert.equal(isTransient({ ...base, status: 0, errorKind: 'timeout' }), true);
});

test('请求不跟随重定向', async () => {
  let redirectSeen: string | null = null;
  const mockFetch = (async (_input: string | URL | { url: string }, init?: RequestInit) => {
    redirectSeen = init?.redirect ?? null;
    return jsonResponse({ code: 0 });
  }) as unknown as typeof fetch;

  await requestWithRetry(
    { url: 'https://www.codebuddy.cn/x', method: 'POST', headers: {}, body: '{}', fetchImpl: mockFetch },
    fastRetry,
  );
  assert.equal(redirectSeen, 'error');
});

test('积分查询 401 直接返回登录失效，不重试', async () => {
  let count = 0;
  const mock = createMockFetch([
    {
      match: /get-user-resource/,
      handler: () => {
        count += 1;
        return new Response('unauthorized', { status: 401 });
      },
    },
  ]);
  const result = await fetchCredits({
    profile: 'workbuddy-cn',
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn' }),
    fetchImpl: mock.fetchImpl,
    retry: fastRetry,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /登录身份失效/);
  assert.equal(count, 1);
});

test('积分查询成功时返回合计与候选域名', async () => {
  const mock = createMockFetch([
    { match: /codebuddy\.cn\/v2\/billing\/meter\/get-user-resource/, handler: () => jsonResponse(creditPayload(1234.5, 2)) },
  ]);
  const result = await fetchCredits({
    profile: 'workbuddy-cn',
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn' }),
    fetchImpl: mock.fetchImpl,
    retry: fastRetry,
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 1234.5);
  assert.equal(result.host, 'https://www.codebuddy.cn');
});
