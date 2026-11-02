/**
 * 测试公共设施：临时目录、静默日志、可控时钟、可编程 fetch、账号夹具。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CheckinService } from '../checkin/checkin-service';
import { retryPolicyFrom } from '../checkin/client';
import { defaultConfig } from '../checkin/config';
import { Logger } from '../checkin/logger';
import { StateStore } from '../checkin/state-store';
import type { AccountContext, CheckinConfig, WbAuthCredentials } from '../checkin/types';

export function tempDir(prefix = 'wbcheckin-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function silentLogger(logDir?: string): Logger {
  return new Logger({ logDir: logDir ?? null, verbose: false, scope: 'test' });
}

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type MockHandler = (call: MockCall) => Response | Promise<Response>;

/**
 * 可编程 fetch：按 URL 包含的关键字匹配处理器，并记录所有调用。
 * 未匹配的请求统一返回 404，便于暴露"意外调用"。
 */
export function createMockFetch(routes: Array<{ match: RegExp | string; handler: MockHandler }>): {
  fetchImpl: typeof fetch;
  calls: MockCall[];
  countMatching(pattern: RegExp | string): number;
} {
  const calls: MockCall[] = [];
  const fetchImpl = (async (input: string | URL | { url: string }, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
    const call: MockCall = { url, method, headers, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    for (const route of routes) {
      const hit = typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url);
      if (hit) return route.handler(call);
    }
    return jsonResponse({ code: 404, msg: 'not mocked' }, 404);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    countMatching(pattern: RegExp | string): number {
      return calls.filter((call) => (typeof pattern === 'string' ? call.url.includes(pattern) : pattern.test(call.url))).length;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 构造积分查询响应（Accounts 数量可控）。 */
export function creditPayload(total: number, parts = 1): unknown {
  const each = total / parts;
  return {
    code: 0,
    msg: 'OK',
    data: {
      Response: {
        Data: {
          Accounts: Array.from({ length: parts }, () => ({ ProductCode: 'p_tcaca', CycleCapacityRemainPrecise: String(each) })),
        },
      },
    },
  };
}

/** 构造 JWT（仅用于签发域识别测试，不含真实凭据）。 */
export function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

export function credentials(overrides: Partial<WbAuthCredentials> = {}): WbAuthCredentials {
  return {
    accessToken: fakeJwt({ iss: 'https://www.workbuddy.cn/auth/realms/copilot', exp: Math.floor(Date.now() / 1000) + 86400 }),
    refreshToken: 'refresh-placeholder',
    expiresAt: Date.now() + 86400_000,
    refreshExpiresAt: null,
    lastRefreshTime: null,
    domain: 'workbuddy.cn',
    ...overrides,
  };
}

export function account(overrides: Partial<AccountContext> = {}): AccountContext {
  const creds = overrides.credentials === undefined ? credentials() : overrides.credentials;
  return {
    uid: 'uid-aaaa-0001',
    accountTag: 'uid-****01',
    profile: 'workbuddy-cn',
    authFile: '/tmp/does-not-matter.info',
    origin: 'official',
    nickname: '测试账号',
    phoneMasked: '138****0000',
    domain: 'workbuddy.cn',
    isCurrent: true,
    credentials: creds,
    credentialError: creds ? null : '未登录',
    tokenExpired: false,
    ...overrides,
  };
}

export interface Harness {
  service: CheckinService;
  store: StateStore;
  config: CheckinConfig;
  logger: Logger;
  dir: string;
  now: () => number;
  setNow: (value: number) => void;
}

export function createHarness(options: {
  fetchImpl: typeof fetch;
  now?: number;
  config?: Partial<CheckinConfig>;
}): Harness {
  const dir = tempDir();
  let clock = options.now ?? Date.parse('2026-11-02T02:05:00.000Z'); // 北京时间 10:05
  const config: CheckinConfig = {
    ...defaultConfig({
      dataDir: dir,
      managedAccountsDir: path.join(dir, 'accounts'),
      verbose: false,
      verifyDelayMs: 0,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ...options.config,
    }),
  };
  const logger = silentLogger(dir);
  const store = new StateStore(dir);
  const noSleep = async (): Promise<void> => undefined;
  const service = new CheckinService({
    config,
    logger,
    store,
    retry: retryPolicyFrom(config, noSleep),
    fetchImpl: options.fetchImpl,
    now: () => clock,
    sleep: noSleep,
  });
  return {
    service,
    store,
    config,
    logger,
    dir,
    now: () => clock,
    setNow: (value: number) => {
      clock = value;
    },
  };
}
