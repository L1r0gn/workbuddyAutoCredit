/**
 * 认证层测试：设备码登录（PKCE）、轮询、令牌续期、区域隔离。
 * 全部使用可编程 fetch，不触碰真实账号。
 */
import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { test } from 'node:test';
import {
  browserLaunchPlan,
  loginWithDeviceFlow,
  openInBrowser,
  pollDeviceLoginOnce,
  refreshTokens,
  startDeviceLogin,
} from '../qoder/auth';
import { createMockFetch, jsonResponse } from './qoder-helpers';

test('授权链接与轮询地址按区域生成，参数符合 PKCE S256', () => {
  const cn = startDeviceLogin('cn', 'machine-abc');
  const auth = new URL(cn.authUrl);
  assert.equal(auth.host, 'qoder.com.cn');
  assert.equal(auth.pathname, '/device/selectAccounts');
  assert.equal(auth.searchParams.get('challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('machine_id'), 'machine-abc');
  assert.equal(auth.searchParams.get('nonce'), cn.nonce);

  // challenge 必须等于 base64url(sha256(verifier))
  const expected = crypto.createHash('sha256').update(cn.verifier, 'ascii').digest('base64url');
  assert.equal(auth.searchParams.get('challenge'), expected);

  const poll = new URL(cn.pollUrl);
  assert.equal(poll.host, 'openapi.qoder.com.cn');
  assert.equal(poll.pathname, '/api/v1/deviceToken/poll');
  assert.equal(poll.searchParams.get('nonce'), cn.nonce);
  assert.equal(poll.searchParams.get('verifier'), cn.verifier);

  const intl = startDeviceLogin('global', 'machine-abc');
  assert.equal(new URL(intl.authUrl).host, 'qoder.com');
  assert.equal(new URL(intl.pollUrl).host, 'openapi.qoder.sh');
});

test('轮询：202 / 404 视为等待用户确认', async () => {
  const handle = startDeviceLogin('cn', 'machine-abc');
  for (const status of [202, 404]) {
    const mock = createMockFetch([{ match: '/deviceToken/poll', handler: () => new Response('', { status }) }]);
    const result = await pollDeviceLoginOnce(handle, { fetchImpl: mock.fetchImpl });
    assert.equal(result.status, 'pending', `HTTP ${status}`);
  }
});

test('轮询：200 带 token 即成功，兼容三种字段名', async () => {
  const handle = startDeviceLogin('cn', 'machine-abc');
  const bodies = [
    { token: 'dt-a', refresh_token: 'drt-a', user_id: 'u1' },
    { access_token: 'dt-b', refreshToken: 'drt-b' },
    { data: { device_token: 'dt-c', refresh_token: 'drt-c', userId: 'u3' } },
  ];
  const expected = ['dt-a', 'dt-b', 'dt-c'];
  for (const [index, body] of bodies.entries()) {
    const mock = createMockFetch([{ match: '/deviceToken/poll', handler: () => jsonResponse(body) }]);
    const result = await pollDeviceLoginOnce(handle, { fetchImpl: mock.fetchImpl });
    assert.equal(result.status, 'success');
    assert.equal(result.tokens?.access, expected[index]);
    assert.ok(result.tokens?.refresh.startsWith('drt-'));
  }
});

test('轮询：业务码非 0 报错，不当作成功', async () => {
  const handle = startDeviceLogin('cn', 'machine-abc');
  const mock = createMockFetch([
    { match: '/deviceToken/poll', handler: () => jsonResponse({ code: 40001, msg: '授权被拒绝' }) },
  ]);
  const result = await pollDeviceLoginOnce(handle, { fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'error');
  assert.match(result.error || '', /40001|授权被拒绝/);
});

test('轮询：HTTP 4xx 报错并带上服务端文案', async () => {
  const handle = startDeviceLogin('cn', 'machine-abc');
  const mock = createMockFetch([
    { match: '/deviceToken/poll', handler: () => jsonResponse({ message: 'invalid verifier' }, 400) },
  ]);
  const result = await pollDeviceLoginOnce(handle, { fetchImpl: mock.fetchImpl });
  assert.equal(result.status, 'error');
  assert.match(result.error || '', /invalid verifier/);
});

test('完整登录流程：先 pending 后 success', async () => {
  let calls = 0;
  const mock = createMockFetch([
    {
      match: '/deviceToken/poll',
      handler: () => {
        calls += 1;
        if (calls === 1) return new Response('', { status: 202 });
        return jsonResponse({ token: 'dt-final', refresh_token: 'drt-final', user_id: 'uid-9' });
      },
    },
  ]);
  const opened: string[] = [];
  const result = await loginWithDeviceFlow('cn', 'machine-abc', {
    fetchImpl: mock.fetchImpl,
    intervalMs: 1,
    sleep: async () => undefined,
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.tokens?.access, 'dt-final');
  assert.equal(result.uid, 'uid-9');
  assert.equal(opened.length, 1);
  assert.equal(calls, 2);
});

test('登录超时返回可读错误', async () => {
  const mock = createMockFetch([
    { match: '/deviceToken/poll', handler: () => new Response('', { status: 202 }) },
  ]);
  let clock = 0;
  const result = await loginWithDeviceFlow('cn', 'machine-abc', {
    fetchImpl: mock.fetchImpl,
    intervalMs: 1,
    timeoutMs: 3,
    now: () => clock,
    sleep: async () => {
      clock += 2;
    },
    openBrowser: () => true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /超时/);
});

test('续期：普通 refresh token 走 deviceToken/refresh', async () => {
  const mock = createMockFetch([
    {
      match: '/api/v1/deviceToken/refresh',
      handler: (call) => {
        assert.equal(call.method, 'POST');
        assert.equal(JSON.parse(call.body || '{}').refresh_token, 'drt-old');
        assert.equal(call.headers['user-agent'], 'qoder-local-proxy');
        return jsonResponse({ data: { device_token: 'dt-new', refresh_token: 'drt-new' } });
      },
    },
  ]);
  const result = await refreshTokens('cn', { access: 'dt-old', refresh: 'drt-old', updatedAt: 0 }, { fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.tokens.access, 'dt-new');
  assert.equal(result.tokens.refresh, 'drt-new', '轮换后的 refresh 必须返回给调用方落盘');
});

test('续期：jrt- 前缀走 jobToken/refresh', async () => {
  const mock = createMockFetch([
    { match: '/api/v1/jobToken/refresh', handler: () => jsonResponse({ token: 'jt-new', refresh_token: 'jrt-new' }) },
  ]);
  const result = await refreshTokens('cn', { access: 'jt-old', refresh: 'jrt-old', updatedAt: 0 }, { fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.tokens.access, 'jt-new');
  assert.equal(mock.countMatching('/deviceToken/refresh'), 0);
});

test('续期：401 给出"请重新登录"的可读错误', async () => {
  const mock = createMockFetch([{ match: '/refresh', handler: () => jsonResponse({ message: 'revoked' }, 401) }]);
  const result = await refreshTokens('cn', { access: 'dt-old', refresh: 'drt-x', updatedAt: 0 }, { fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /重新登录/);
});

test('续期：没有 refresh token 时不发请求', async () => {
  const mock = createMockFetch([{ match: '/refresh', handler: () => jsonResponse({}) }]);
  const result = await refreshTokens('cn', { access: 'dt-old', refresh: '', updatedAt: 0 }, { fetchImpl: mock.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(mock.calls.length, 0);
});

test('续期：区域不同则请求域名不同', async () => {
  const mock = createMockFetch([
    { match: '/refresh', handler: () => jsonResponse({ device_token: 'dt-x' }) },
  ]);
  await refreshTokens('global', { access: 'dt-o', refresh: 'drt-r', updatedAt: 0 }, { fetchImpl: mock.fetchImpl });
  assert.match(mock.calls[0]?.url || '', /^https:\/\/openapi\.qoder\.sh/);
});

// ---- 浏览器唤起（Windows 上曾把 URL 当路径打开文件管理器）----

test('Windows 首选 url.dll 协议处理器，且 URL 原样传递', () => {
  const url = 'https://qoder.com.cn/device/selectAccounts?challenge=abc&challenge_method=S256&machine_id=m1&nonce=n1';
  const plan = browserLaunchPlan('win32', url);
  assert.equal(plan.length, 3);
  assert.equal(plan[0]?.command, 'rundll32.exe');
  assert.deepEqual(plan[0]?.args, ['url.dll,FileProtocolHandler', url]);
  assert.equal(plan[0]?.args[1], url, '带 & 的完整 URL 必须作为一个参数传递，不能被拆开');
  assert.equal(plan[2]?.method, 'explorer', '资源管理器只是最后兜底');
});

test('其它平台的启动计划', () => {
  assert.equal(browserLaunchPlan('darwin', 'https://qoder.com')[0]?.command, 'open');
  assert.equal(browserLaunchPlan('linux', 'https://qoder.com')[0]?.command, 'xdg-open');
});

test('onAuthUrl 在第一次轮询之前被调用，且链接含 PKCE 参数', async () => {
  const seen: string[] = [];
  let polledAfterCallback = false;
  const mock = createMockFetch([
    {
      match: '/deviceToken/poll',
      handler: () => {
        if (seen.length === 1) polledAfterCallback = true;
        return jsonResponse({ token: 'dt-ok', refresh_token: 'drt-ok' });
      },
    },
  ]);
  const result = await loginWithDeviceFlow('cn', 'machine-x', {
    fetchImpl: mock.fetchImpl,
    intervalMs: 1,
    sleep: async () => undefined,
    openBrowser: () => true,
    onAuthUrl: (url) => seen.push(url),
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0] || '', /challenge=/);
  assert.match(seen[0] || '', /challenge_method=S256/);
  assert.equal(polledAfterCallback, true, '回调必须先于第一次轮询');
  assert.equal(result.browserOpened, true);
});

test('浏览器打开失败不影响登录等待（链接已交给用户）', async () => {
  const mock = createMockFetch([
    { match: '/deviceToken/poll', handler: () => new Response('', { status: 202 }) },
  ]);
  const result = await loginWithDeviceFlow('cn', 'machine-x', {
    fetchImpl: mock.fetchImpl,
    intervalMs: 1,
    timeoutMs: 5,
    sleep: async () => undefined,
    openBrowser: () => {
      throw new Error('spawn ENOENT');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /超时/);
  assert.equal(result.browserOpened, false);
  assert.match(result.browserError || '', /ENOENT/);
  assert.ok(result.authUrl.startsWith('https://qoder.com.cn/device/selectAccounts'));
});

test('QODER_LOGIN_NO_BROWSER=1 时不尝试启动任何程序', async () => {
  const result = await openInBrowser('about:blank', { platform: 'win32', env: { QODER_LOGIN_NO_BROWSER: '1' } });
  assert.equal(result.opened, false);
  assert.equal(result.method, null);
  assert.match(result.error || '', /禁用/);
});
