/**
 * 底层 HTTP 客户端：统一超时、错误分类与有限次指数退避重试。
 *
 * 约束：
 * - 不关闭 TLS 校验（不设置 NODE_TLS_REJECT_UNAUTHORIZED，也不传 rejectUnauthorized:false）。
 * - 拒绝跟随重定向：官方接口不应重定向，跟随会把 Bearer 令牌带到非预期主机。
 * - 错误信息只保留状态码与业务 msg，绝不拼接请求头。
 */
import { redactText } from './logger';
import type { CheckinConfig } from './types';

export type HttpErrorKind = 'none' | 'timeout' | 'network' | 'http' | 'body';

export interface HttpResponse {
  status: number;
  ok: boolean;
  /** 原始响应文本，仅用于解析与截断诊断 */
  text: string;
  json: Record<string, unknown> | null;
  errorKind: HttpErrorKind;
  error: string | null;
  durationMs: number;
  attempts: number;
  url: string;
}

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 判断是否为值得重试的瞬时故障（超时 / 连接错误 / 5xx / 429）。 */
export function isTransient(response: HttpResponse): boolean {
  if (response.errorKind === 'timeout' || response.errorKind === 'network') return true;
  if (response.status === 429) return true;
  return response.status >= 500 && response.status < 600;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 测试可注入，避免真实等待 */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function retryPolicyFrom(config: CheckinConfig, sleepImpl?: (ms: number) => Promise<void>): RetryPolicy {
  return {
    maxAttempts: Math.max(1, config.retry.maxAttempts),
    baseDelayMs: Math.max(50, config.retry.baseDelayMs),
    maxDelayMs: Math.max(500, config.retry.maxDelayMs),
    ...(sleepImpl ? { sleepImpl } : {}),
  };
}

/** 单次请求（不重试）。 */
export async function requestOnce(request: HttpRequest): Promise<HttpResponse> {
  const fetchImpl = request.fetchImpl || globalThis.fetch;
  const timeoutMs = request.timeoutMs ?? 12000;
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      text,
      json,
      errorKind: json ? 'none' : 'body',
      error: json ? null : `响应不是 JSON（HTTP ${response.status}）`,
      durationMs: Date.now() - startedAt,
      attempts: 1,
      url: request.url,
    };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    const isTimeout = name === 'TimeoutError' || name === 'AbortError';
    return {
      status: 0,
      ok: false,
      text: '',
      json: null,
      errorKind: isTimeout ? 'timeout' : 'network',
      error: isTimeout ? `请求超时（${timeoutMs}ms）` : redactText(error, 200),
      durationMs: Date.now() - startedAt,
      attempts: 1,
      url: request.url,
    };
  }
}

/**
 * 带重试的请求。
 *
 * 对签到 POST 也可安全重试：服务端按"每天一次"幂等，重复请求只会得到
 * code=10001「今天已签到」，不会重复发放。
 */
export async function requestWithRetry(request: HttpRequest, policy: RetryPolicy): Promise<HttpResponse> {
  const sleep = policy.sleepImpl || defaultSleep;
  let last: HttpResponse | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const response = await requestOnce(request);
    response.attempts = attempt;
    last = response;
    if (!isTransient(response)) return response;
    if (attempt === policy.maxAttempts) break;
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    await sleep(delay);
  }
  return last as HttpResponse;
}
