/**
 * Qoder 测试夹具：临时数据目录、可控时钟、可编程 fetch、账号与响应构造。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultQoderConfig } from '../qoder/config';
import { QoderService } from '../qoder/service';
import { QoderStore } from '../qoder/store';
import type { QoderAccount, QoderConfig, QoderRiskValues } from '../qoder/types';
import { Logger } from '../checkin/logger';
import type { RetryPolicy } from '../checkin/client';

export function tempDir(prefix = 'qoder-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function silentLogger(logDir?: string): Logger {
  return new Logger({ logDir: logDir ?? null, verbose: false, scope: 'qoder-test' });
}

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type MockHandler = (call: MockCall) => Response | Promise<Response>;

export function createMockFetch(routes: Array<{ match: RegExp | string; handler: MockHandler }>): {
  fetchImpl: typeof fetch;
  calls: MockCall[];
  countMatching(pattern: RegExp | string): number;
} {
  const calls: MockCall[] = [];
  const fetchImpl = (async (input: string | URL | { url: string }, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = value;
    const call: MockCall = {
      url,
      method: (init?.method || 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const hit = typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url);
      if (hit) return route.handler(call);
    }
    return jsonResponse({ code: 404, message: 'not mocked' }, 404);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    countMatching(pattern: RegExp | string): number {
      return calls.filter((call) => (typeof pattern === 'string' ? call.url.includes(pattern) : pattern.test(call.url))).length;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** campaigns 响应：payload.campaigns 直接给出（上游常见形态之一）。 */
export function campaignsPayload(rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): unknown {
  return { code: 0, campaigns: rows, ...extra };
}

export function dailyCampaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: 'cmp-daily-001',
    campaignKey: 'act-daily-credits',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { kind: 'CREDITS', amount: 100 },
    title: '每日积分',
    ...overrides,
  };
}

export function quotaPayload(total: number): unknown {
  return {
    code: 0,
    data: {
      userQuota: { remaining: total },
      addOnQuota: { remaining: 0 },
      dedicatedResourcePackages: [],
    },
  };
}

export const RISK: QoderRiskValues = {
  machineToken: 'machine-token-test',
  machineCode: 'f75e70f400e4f52356',
  machineType: '47f3349091202b187f',
};

export function qoderAccount(overrides: Partial<QoderAccount> = {}): QoderAccount {
  const region = overrides.region || 'cn';
  return {
    id: overrides.id || `${region}:uid-test-1`,
    region,
    note: '测试账号',
    uid: 'uid-test-1',
    tokens: {
      access: 'dt-access-test-token-0001',
      refresh: 'drt-refresh-test-token-0001',
      updatedAt: Date.parse('2026-11-02T00:00:00Z'),
    },
    device: {
      machineId: 'machine-id-test',
      machineOs: 'x86_64_win32',
      machineHostname: 'TESTHOST',
    },
    source: 'store',
    createdAt: Date.parse('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

export interface QoderHarness {
  service: QoderService;
  store: QoderStore;
  config: QoderConfig;
  logger: Logger;
  dir: string;
  now: () => number;
  setNow: (value: number) => void;
}

export function createQoderHarness(input: {
  fetchImpl: typeof fetch;
  now?: number;
  config?: Partial<QoderConfig>;
  risk?: QoderRiskValues | null;
}): QoderHarness {
  const dir = tempDir();
  let clock = input.now ?? Date.parse('2026-11-03T02:05:00.000Z'); // 北京时间 10:05
  const config: QoderConfig = defaultQoderConfig({
    dataDir: dir,
    verbose: false,
    verifyDelayMs: 0,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    ...input.config,
  });
  const logger = silentLogger(dir);
  const store = new QoderStore(dir);
  const noSleep = async (): Promise<void> => undefined;
  const retry: RetryPolicy = {
    maxAttempts: config.retry.maxAttempts,
    baseDelayMs: config.retry.baseDelayMs,
    maxDelayMs: config.retry.maxDelayMs,
    sleepImpl: noSleep,
  };
  const risk = input.risk === undefined ? RISK : input.risk;
  const service = new QoderService({
    config,
    logger,
    store,
    retry,
    fetchImpl: input.fetchImpl,
    now: () => clock,
    sleep: noSleep,
    riskProvider: async () =>
      risk
        ? { values: risk, error: null, component: { path: '/fake/runtime-info', source: 'config', tried: [] } }
        : {
            values: null,
            error: '未找到官方 UMID 组件（测试环境）',
            component: { path: null, source: 'none', tried: ['/a', '/b'] },
          },
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
