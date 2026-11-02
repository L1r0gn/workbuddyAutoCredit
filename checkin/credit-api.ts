/**
 * 官方积分接口封装。
 *
 * 本文件里的**每一个**地址、方法、请求头与请求体都来自参考项目源码的实测实现，
 * 并已在本机真实账号上再次核对（见 docs/02-analysis.md 的接口核对表）：
 *
 *   1) 积分查询：POST {apiHost}/v2/billing/meter/get-user-resource
 *      请求体：{PageNumber,PageSize,ProductCode:'p_tcaca',Status:[0,3],
 *               PackageEndTimeRangeBegin,PackageEndTimeRangeEnd}
 *      响应：data.Response.Data.Accounts[].CycleCapacityRemainPrecise ...
 *
 *   2) 每日签到（真正的领取动作）：POST {host}/billing/meter/daily-checkin
 *      请求体：{}
 *      成功：code === 0
 *      已签到：code === 10001 且 msg 明确表达"已签到/已领取"（HTTP 400 也会出现）
 *
 * 除上述接口外，没有发现任何"仅查询签到状态"的 GET 接口，因此本模块
 * 不编造状态查询地址，改用「本地已验证记录 + 领取响应」判定当日状态。
 */
import { inspectToken } from './auth-manager';
import { requestWithRetry, type HttpResponse, type RetryPolicy } from './client';
import { PROFILES } from './config';
import type { ProfileId } from './types';

/** 官方允许的接口主机白名单（按令牌签发域严格映射，避免把令牌发到未知域）。 */
export const ISSUER_HOST_MAP: Record<string, string> = {
  'https://www.workbuddy.ai': 'https://www.workbuddy.ai',
  'https://www.workbuddy.cn': 'https://www.workbuddy.cn',
  'https://www.codebuddy.cn': 'https://www.codebuddy.cn',
  'https://www.codebuddy.ai': 'https://www.codebuddy.ai',
};

export const CHECKIN_PATHS = ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin'] as const;
export const CREDIT_PATH = '/v2/billing/meter/get-user-resource';

const INACTIVE_MESSAGE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i;
const ALREADY_MESSAGE = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already\s*(?:checked[- ]?in|claimed)|already/i;

export type CheckinVerdict = 'success' | 'already' | 'inactive' | 'unauthorized' | 'unknown';

export interface CheckinClassification {
  verdict: CheckinVerdict;
  /** 是否可视为「今日积分已到手」 */
  ok: boolean;
  already: boolean;
  inactive: boolean;
  code: number | null;
  message: string;
  /** 保守处理的原因说明（unknown 时用于诊断） */
  reason: string | null;
}

function numericCode(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 判定签到结果。规则与参考项目一致并且**更保守**：
 * - 仅 HTTP 2xx 不足以判定成功（网关可能返回空 200）。
 * - code=0 且 HTTP 成功 → 成功。
 * - code=10001 且文案明确表示已签到 → 视为「今日已完成」（不重复发放）。
 * - 文案命中"活动未开启/已结束" → inactive，不视为成功。
 * - 其它任何情况 → unknown，绝不猜测成功。
 */
export function classifyCheckinResult(input: {
  httpOk: boolean;
  status?: number;
  code: unknown;
  message: unknown;
}): CheckinClassification {
  const code = numericCode(input.code);
  const message = String(input.message ?? '');
  const status = input.status ?? (input.httpOk ? 200 : 0);
  const inactive = INACTIVE_MESSAGE.test(message);

  if (status === 401 || status === 403) {
    return { verdict: 'unauthorized', ok: false, already: false, inactive: false, code, message, reason: '登录身份失效' };
  }
  if (inactive) {
    return { verdict: 'inactive', ok: false, already: false, inactive: true, code, message, reason: '签到活动未开启或已结束' };
  }
  const already = code === 10001 && ALREADY_MESSAGE.test(message);
  if (already) {
    return { verdict: 'already', ok: true, already: true, inactive: false, code, message, reason: null };
  }
  if (code === 0 && input.httpOk) {
    return { verdict: 'success', ok: true, already: false, inactive: false, code, message, reason: null };
  }
  return {
    verdict: 'unknown',
    ok: false,
    already: false,
    inactive: false,
    code,
    message,
    reason: code === null ? '响应缺少业务 code，无法确认领取结果' : `未识别的响应 code=${code}`,
  };
}

/**
 * 解析签到接口地址列表。
 * 优先令牌自带的签发域；无法识别时才回落到 profile 域名，国内版再补一个同族域名兜底。
 */
export function resolveCheckinEndpoints(accessToken: string, profile: ProfileId): string[] {
  const issuerOrigin = inspectToken(accessToken).issuerOrigin;
  const issuerHost = issuerOrigin ? ISSUER_HOST_MAP[issuerOrigin] : undefined;
  const hosts: string[] = [];
  if (issuerHost) hosts.push(issuerHost);
  else hosts.push(PROFILES[profile].apiHost.replace(/\/+$/, ''));
  if (!issuerHost && PROFILES[profile].region === 'cn') {
    for (const host of ['https://www.codebuddy.cn', 'https://www.workbuddy.cn']) {
      if (!hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts.flatMap((host) => CHECKIN_PATHS.map((p) => host + p));
}

/** 积分查询的候选主机（先 profile 主域，再令牌签发域）。 */
export function resolveCreditHosts(accessToken: string, profile: ProfileId): string[] {
  const hosts = [PROFILES[profile].apiHost.replace(/\/+$/, '')];
  const issuerOrigin = inspectToken(accessToken).issuerOrigin;
  const issuerHost = issuerOrigin ? ISSUER_HOST_MAP[issuerOrigin] : undefined;
  if (issuerHost && !hosts.includes(issuerHost)) hosts.push(issuerHost);
  return hosts;
}

function baseHeaders(host: string, accessToken: string, refererPath: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}${refererPath}`,
    authorization: `Bearer ${accessToken}`,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 积分查询请求体：时间范围用本地时间 "YYYY-MM-DD HH:mm:ss"。 */
export function buildCreditResourceBody(now = new Date()): Record<string, unknown> {
  const end = new Date(now.getTime());
  end.setFullYear(end.getFullYear() + 101);
  const fmt = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes(),
    )}:${pad(date.getSeconds())}`;
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  };
}

export interface CreditResult {
  ok: boolean;
  /** 剩余积分合计（按优先级取周期剩余字段） */
  total: number | null;
  accounts: number;
  code: number | null;
  message: string | null;
  host: string | null;
  error: string | null;
}

/**
 * 从积分响应里取剩余额度。
 * 字段优先级与官方前端一致：周期剩余 > 总量剩余（月度包用完时两者不同）。
 */
export function extractCreditTotal(payload: Record<string, unknown> | null): { total: number | null; accounts: number } {
  if (!payload) return { total: null, accounts: 0 };
  const data = payload.data;
  const container = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const response = container && container.Response && typeof container.Response === 'object'
    ? (container.Response as Record<string, unknown>)
    : null;
  const responseData = response && response.Data && typeof response.Data === 'object'
    ? (response.Data as Record<string, unknown>)
    : null;

  const accountList =
    (responseData && Array.isArray(responseData.Accounts) ? responseData.Accounts : null) ||
    (container && Array.isArray(container.accounts) ? container.accounts : null) ||
    [];

  if (!accountList.length) return { total: null, accounts: 0 };
  let sum = 0;
  for (const item of accountList) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const candidates = [row.CycleCapacityRemainPrecise, row.CycleCapacityRemain, row.CapacityRemainPrecise, row.CapacityRemain];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      const value = parseFloat(String(candidate));
      if (!Number.isNaN(value)) {
        sum += value;
        break;
      }
    }
  }
  return { total: Math.round(sum * 100) / 100, accounts: accountList.length };
}

export interface CreditQueryOptions {
  profile: ProfileId;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry: RetryPolicy;
  now?: () => number;
}

/** 查询账号当前积分（只读，不改动任何服务端状态）。 */
export async function fetchCredits(options: CreditQueryOptions): Promise<CreditResult> {
  const hosts = resolveCreditHosts(options.accessToken, options.profile);
  let lastError: string | null = null;
  for (const host of hosts) {
    const response: HttpResponse = await requestWithRetry(
      {
        url: `${host}${CREDIT_PATH}`,
        method: 'POST',
        headers: baseHeaders(host, options.accessToken, '/profile/plans-usage'),
        body: JSON.stringify(buildCreditResourceBody(new Date(options.now ? options.now() : Date.now()))),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
      options.retry,
    );

    if (response.status === 401 || response.status === 403) {
      return { ok: false, total: null, accounts: 0, code: null, message: null, host, error: '登录身份失效（HTTP 401/403）' };
    }
    if (response.json) {
      const code = numericCode(response.json.code);
      if (code !== null && code !== 0) {
        lastError = String(response.json.msg || response.json.message || `code=${code}`);
        continue;
      }
      const extracted = extractCreditTotal(response.json);
      if (extracted.total === null) {
        lastError = '积分响应中没有可识别的 Accounts 数据';
        continue;
      }
      return { ok: true, total: extracted.total, accounts: extracted.accounts, code, message: null, host, error: null };
    }
    lastError = response.error || `HTTP ${response.status}`;
  }
  return { ok: false, total: null, accounts: 0, code: null, message: null, host: null, error: lastError || '积分查询失败' };
}

export interface ClaimOptions {
  profile: ProfileId;
  accessToken: string;
  /** 账号 uid（作为 x-user-id 发送） */
  uid: string;
  /** 账号所属域（作为 x-domain 发送） */
  domain: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retry: RetryPolicy;
}

export interface ClaimResult {
  classification: CheckinClassification;
  endpoint: string | null;
  status: number;
  /** 响应 data 的字段名（仅用于诊断未知结构，不含值） */
  dataKeys: string[] | null;
  attempts: number;
  /** 网络层错误（无响应时） */
  transportError: string | null;
  /** 尝试过的瓶颈：所有候选地址都 404 时用于诊断 */
  tried: string[];
}

/**
 * 执行每日签到（真正的领取动作）。
 *
 * 幂等保障：
 * - 服务端按天去重，重复请求返回 10001「已签到」。
 * - 调用方（checkin-service）另有本地已验证记录与进程内并发锁。
 */
export async function claimDailyCheckin(options: ClaimOptions): Promise<ClaimResult> {
  const endpoints = resolveCheckinEndpoints(options.accessToken, options.profile);
  const tried: string[] = [];
  let firstUnauthorized: ClaimResult | null = null;
  let lastResult: ClaimResult | null = null;

  for (const url of endpoints) {
    const host = new URL(url).origin;
    tried.push(url);
    const headers = {
      ...baseHeaders(host, options.accessToken, '/profile/plans-usage'),
      ...(options.uid ? { 'x-user-id': options.uid } : {}),
      ...(options.domain ? { 'x-domain': options.domain } : {}),
    };
    const response = await requestWithRetry(
      {
        url,
        method: 'POST',
        headers,
        body: '{}',
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
      options.retry,
    );

    if (response.errorKind === 'timeout' || response.errorKind === 'network') {
      lastResult = {
        classification: classifyCheckinResult({ httpOk: false, status: 0, code: null, message: response.error || '网络错误' }),
        endpoint: url,
        status: 0,
        dataKeys: null,
        attempts: response.attempts,
        transportError: response.error,
        tried: [...tried],
      };
      // 换下一个地址继续尝试（可能只是该域不可达）
      continue;
    }

    const payload = response.json || {};
    const message = String(payload.msg ?? payload.message ?? (response.ok ? 'OK' : `HTTP ${response.status}`));
    const dataKeys = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
      ? Object.keys(payload.data as Record<string, unknown>)
      : null;
    const classification = classifyCheckinResult({
      httpOk: response.ok,
      status: response.status,
      code: payload.code,
      message,
    });
    const result: ClaimResult = {
      classification,
      endpoint: url,
      status: response.status,
      dataKeys,
      attempts: response.attempts,
      transportError: null,
      tried: [...tried],
    };

    if (classification.verdict === 'success' || classification.verdict === 'already' || classification.verdict === 'inactive') {
      return result;
    }
    if (classification.verdict === 'unauthorized') {
      // 令牌失效：不再尝试其它域名，避免用同一无效令牌反复请求
      if (!firstUnauthorized) firstUnauthorized = result;
      continue;
    }
    // 4xx（非 401/403）说明该地址不适用于此账号，换下一个；200 但没有 code 则停止，避免误判
    lastResult = result;
    if (response.ok) return result;
    if (response.status !== 404 && response.status !== 405) return result;
  }

  return firstUnauthorized || lastResult || {
    classification: classifyCheckinResult({ httpOk: false, status: 0, code: null, message: '没有可用的签到接口地址' }),
    endpoint: null,
    status: 0,
    dataKeys: null,
    attempts: 0,
    transportError: 'no-endpoint',
    tried,
  };
}
