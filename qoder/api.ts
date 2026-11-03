/**
 * Qoder 接口层（传输与协议细节）。
 *
 * 全部地址与头部来自 Qoder-Daily 源码，并在本机用真实客户端组件核对：
 *   GET  /sash/api/v1/me/campaigns            活动列表（官方客户端不带 forceRefresh）
 *   POST /sash/api/v1/me/campaigns/{id}/claim 领取（body {}）
 *   GET  /sash/api/v1/me/campaigns/{id}/reward 只读面值（可选）
 *   GET  /api/v2/quota/usage                   额度（用于领取前后核对）
 *
 * 必需的设备风控头（缺失会导致活动不下发）：
 *   Cosy-Version / Cosy-MachineOS / Cosy-MachineId / Cosy-MachineHostname
 *   Cosy-MachineToken / Cosy-MachineCode / Cosy-MachineType
 */
import { requestWithRetry, type HttpResponse, type RetryPolicy } from '../checkin/client';
import { REGIONS } from './config';
import type {
  QoderCampaignFetch,
  QoderCampaignRow,
  QoderClaimResult,
  QoderClaimVerdict,
  QoderRegion,
  QoderRiskValues,
  QoderTokens,
} from './types';

export const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns';
export const QUOTA_USAGE_PATH = '/api/v2/quota/usage';
export const SASH_CLIENT_TYPE = '10';
export const SASH_USER_AGENT = 'Qoder';

/** 领取失败码 → 可读文案（与上游一致，不臆造新码）。 */
export const CLAIM_FAILURE_TEXT: Record<string, string> = {
  REDEMPTION_CODE_OUT_OF_STOCK: '今日名额已发完，等待下一轮',
  SAME_PERSON_ALREADY_CLAIMED: '同一设备身份下的其他账号已领取',
  CAMPAIGN_NOT_ACTIVE: '活动尚未开放或已结束',
  ACHIEVEMENT_NOT_COMPLETED: '活动条件尚未完成',
  RISK_BLOCKED: '设备风控未通过',
  RISK_DEPENDENCY_UNAVAILABLE: '设备风控依赖暂不可用',
};

/** 额度类 403 的冷却时长。 */
export const QUOTA_112_COOLDOWN_MS = 30 * 60 * 1000;
export const QUOTA_110_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const QUOTA_110_MIN_COOLDOWN_MS = 60 * 1000;

export interface QoderApiContext {
  region: QoderRegion;
  tokens: QoderTokens;
  uid: string;
  machineId: string;
  clientVersion: string;
  risk: QoderRiskValues | null;
  retry: RetryPolicy;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 基础鉴权头（官方活动接口使用）。 */
export function sashHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'cosy-clienttype': SASH_CLIENT_TYPE,
    accept: 'application/json',
    'accept-language': 'zh-CN',
    'user-agent': SASH_USER_AGENT,
  };
}

/** 国内版空表复取时使用的最小鉴权四件套（上游实测形态）。 */
export function minimalSashHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'cosy-clienttype': SASH_CLIENT_TYPE,
    'user-agent': SASH_USER_AGENT,
    'content-type': 'application/json',
  };
}

/** 组装带设备身份的头。risk 为空时只带机器标识（上游会因此不下发活动，需提示用户）。 */
export function buildHeaders(ctx: QoderApiContextWithMachine): Record<string, string> {
  const headers = sashHeaders(ctx.tokens.access);
  headers['Cosy-Version'] = ctx.clientVersion;
  headers['Cosy-MachineOS'] = ctx.machineOs || '';
  headers['Cosy-MachineId'] = ctx.machineId;
  if (ctx.machineHostname) headers['Cosy-MachineHostname'] = ctx.machineHostname;
  if (ctx.risk) {
    headers['Cosy-MachineToken'] = ctx.risk.machineToken;
    headers['Cosy-MachineCode'] = ctx.risk.machineCode;
    headers['Cosy-MachineType'] = ctx.risk.machineType;
  }
  return headers;
}

/** 兼容：给 context 补上可选的机器环境字段。 */
export interface QoderApiContextWithMachine extends QoderApiContext {
  machineOs?: string;
  machineHostname?: string;
}

interface RequestOptions {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  retry?: RetryPolicy;
}

async function send(ctx: QoderApiContext, options: RequestOptions): Promise<HttpResponse> {
  return requestWithRetry(
    {
      url: options.url,
      method: options.method,
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      timeoutMs: ctx.timeoutMs,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    },
    options.retry || ctx.retry,
  );
}

function payloadOf(response: HttpResponse): Record<string, unknown> {
  return response.json || {};
}

function nestedCode(payload: Record<string, unknown>): string {
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const values = [payload.code, payload.Code, data.code, data.Code];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    return String(value);
  }
  return '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function amountOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 额度类 403 识别。
 * 上游对「额度耗尽(112)」「每日计费次数上限(110)」同样返回 403，与令牌失效同码不同因，
 * 必须区分：这两种情况不应该触发续期。
 */
export function quotaCooldown(
  response: HttpResponse,
  now = Date.now(),
): { kind: '' | 'exhausted' | 'daily'; seconds: number } {
  const payload = payloadOf(response);
  const text = `${JSON.stringify(payload)} ${response.text || ''}`.replace(/\\/g, '');
  if (/pricingUrl/.test(text) || /"code"\s*:\s*"?112\b/.test(text)) {
    return { kind: 'exhausted', seconds: QUOTA_112_COOLDOWN_MS / 1000 };
  }
  if (/Billing daily count exceeded/.test(text) || /"code"\s*:\s*"?110\b/.test(text)) {
    const local = new Date(now);
    const midnight = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1);
    const seconds = Math.round((midnight.getTime() - local.getTime()) / 1000);
    return {
      kind: 'daily',
      seconds: Math.max(QUOTA_110_MIN_COOLDOWN_MS / 1000, Math.min(QUOTA_110_MAX_COOLDOWN_MS / 1000, seconds)),
    };
  }
  return { kind: '', seconds: 0 };
}

/** 会话失效判定：401/403（非额度）或业务码 105 / 10019901001。 */
export function authDead(response: HttpResponse, now = Date.now()): boolean {
  if (response.status === 401 || response.status === 403) {
    return quotaCooldown(response, now).kind === '';
  }
  const payload = payloadOf(response);
  const code = nestedCode(payload);
  return code === '105' || code === '10019901001';
}

/** 仅在「成功且明确空表」时返回 true。 */
export function campaignResponseIsEmpty(response: HttpResponse, now = Date.now()): boolean {
  if (response.status !== 200 || authDead(response, now)) return false;
  const payload = payloadOf(response);
  if (!payload || typeof payload !== 'object') return false;
  const bodies: Array<Record<string, unknown>> = [payload];
  if (payload.data && typeof payload.data === 'object') bodies.push(payload.data as Record<string, unknown>);
  for (const body of bodies) {
    const campaigns = body.campaigns;
    if (Array.isArray(campaigns)) return campaigns.length === 0;
    if (campaigns === undefined && body.showCampaign === false) return true;
  }
  return false;
}

/** 从响应体取活动行。 */
export function campaignRows(payload: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!payload) return [];
  const direct = payload.campaigns;
  if (Array.isArray(direct)) return direct as Array<Record<string, unknown>>;
  const data = payload.data;
  if (data && typeof data === 'object') {
    const rows = (data as Record<string, unknown>).campaigns;
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return [];
}

/** 归一化活动行（只保留已确认存在的字段）。 */
export function normalizeCampaignRow(row: Record<string, unknown>): QoderCampaignRow {
  const benefit = row.benefit && typeof row.benefit === 'object' ? (row.benefit as Record<string, unknown>) : {};
  return {
    campaignId: firstText(row.campaignId, row.id),
    campaignKey: firstText(row.campaignKey),
    actionType: firstText(row.actionType).toUpperCase(),
    claimStatus: firstText(row.claimStatus).toUpperCase(),
    benefitKind: firstText(benefit.kind).toUpperCase(),
    benefitAmount: amountOf(benefit.amount),
    title: firstText(row.title, row.name, row.campaignName),
    raw: row,
  };
}

/** 查询活动列表（含国内版空表的最小头复取）。 */
export async function fetchCampaigns(ctx: QoderApiContextWithMachine): Promise<QoderCampaignFetch> {
  const headers = buildHeaders(ctx);
  const url = `${REGIONS[ctx.region].base}${CAMPAIGNS_PATH}`;

  let response = await send(ctx, { url, method: 'GET', headers });
  let minimalFallbackUsed = false;

  if (ctx.region === 'cn' && campaignResponseIsEmpty(response, ctx.now ? ctx.now() : Date.now())) {
    const original = response;
    minimalFallbackUsed = true;
    response = await send(ctx, {
      url,
      method: 'GET',
      headers: minimalSashHeaders(ctx.tokens.access),
      retry: { ...ctx.retry, maxAttempts: 1 },
    });
    if (campaignResponseIsEmpty(response, ctx.now ? ctx.now() : Date.now())) response = original;
  }

  const nowMs = ctx.now ? ctx.now() : Date.now();
  const quota = quotaCooldown(response, nowMs);
  const dead = authDead(response, nowMs);
  const empty = campaignResponseIsEmpty(response, nowMs);

  let error: string | null = null;
  if (quota.kind) {
    error = quota.kind === 'exhausted'
      ? '额度已耗尽（112 / pricingUrl），账号冷却 30 分钟'
      : `每日计费次数已达上限（110），冷却约 ${Math.round(quota.seconds / 60)} 分钟`;
  } else if (response.status === 401 || response.status === 403) {
    error = `活动查询被拒（HTTP ${response.status}），请确认令牌有效且地区选择正确`;
  } else if (dead) {
    error = '活动查询失败（业务码 105 / 10019901001），续期后仍无效，请重新登录';
  } else if (response.status === 429) {
    error = '活动查询失败（HTTP 429 限流），请稍后重试';
  } else if (response.status !== 200) {
    error = `活动列表返回 HTTP ${response.status}`;
  }

  const rows = response.status === 200 && !dead && !quota.kind
    ? campaignRows(payloadOf(response)).map(normalizeCampaignRow)
    : [];

  return {
    ok: !error,
    rows,
    httpStatus: response.status,
    empty,
    error,
    minimalFallbackUsed,
    riskNote: null,
    quotaKind: quota.kind,
    quotaSeconds: quota.seconds,
  };
}

/**
 * 领取活动奖励。
 * 判定矩阵（与上游测试用例一致）：
 *   status ∈ {CLAIMED,GRANTED,SUCCESS} 且无 replayed → claimed
 *   replayed=true / result ALREADY|REPLAYED / 409 + ALREADY|REPLAYED → already
 *   status=BLOCKED 或 failureCode=SAME_PERSON_ALREADY_CLAIMED → blocked
 *   其余 → error（绝不把 2xx 当成功）
 */
export function parseClaimResponse(response: HttpResponse): QoderClaimResult {
  const payload = payloadOf(response);
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : payload;
  const status = firstText(data.status, payload.status).toUpperCase();
  const failureCode = firstText(data.failureCode, payload.failureCode, data.errorCode, payload.errorCode).toUpperCase();
  const result = firstText(data.result, payload.result).toUpperCase();
  const replayed = data.replayed === true || payload.replayed === true;
  const redemptionCode = firstText(data.redemptionCode, payload.redemptionCode);
  const message = firstText(data.message, data.msg, payload.message, payload.msg);
  const benefit = data.benefit && typeof data.benefit === 'object' ? (data.benefit as Record<string, unknown>) : {};
  const amount = amountOf(benefit.amount);

  const base: Omit<QoderClaimResult, 'verdict' | 'message'> = {
    amount,
    status,
    failureCode,
    replayed,
    redemptionCode,
    httpStatus: response.status,
  };

  if (result.includes('ALREADY') || result.includes('REPLAYED')) {
    return { ...base, verdict: 'already', message: '活动已领取' };
  }
  if (response.status === 409) {
    if (failureCode.includes('ALREADY') || failureCode.includes('REPLAYED') || replayed) {
      return { ...base, verdict: 'already', message: '活动已领取' };
    }
    return { ...base, verdict: 'error', message: message || `HTTP 409 ${failureCode || '领取冲突'}` };
  }
  if (status === 'CLAIMED' || status === 'GRANTED' || status === 'SUCCESS') {
    if (replayed) return { ...base, verdict: 'already', message: '活动已领取' };
    if (redemptionCode) return { ...base, verdict: 'claimed', message: `已领取兑换券：${redemptionCode}` };
    return { ...base, verdict: 'claimed', message: message || '领取成功' };
  }
  if (status === 'BLOCKED' || failureCode === 'SAME_PERSON_ALREADY_CLAIMED') {
    return {
      ...base,
      verdict: 'blocked',
      message: CLAIM_FAILURE_TEXT[failureCode] || message || '领取被阻塞',
    };
  }
  if (failureCode && CLAIM_FAILURE_TEXT[failureCode]) {
    return { ...base, verdict: 'error', message: CLAIM_FAILURE_TEXT[failureCode] };
  }
  if (response.status >= 200 && response.status < 300) {
    return { ...base, verdict: 'error', message: message || '上游未确认成功' };
  }
  return { ...base, verdict: 'error', message: message || `HTTP ${response.status}` };
}

/** 执行领取。 */
export async function claimCampaign(ctx: QoderApiContextWithMachine, campaignId: string): Promise<QoderClaimResult & { transportError: string | null }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(campaignId)) {
    return {
      verdict: 'error' as QoderClaimVerdict,
      amount: 0,
      message: '活动 ID 非法，已拒绝请求',
      status: '',
      failureCode: '',
      replayed: false,
      redemptionCode: '',
      httpStatus: 0,
      transportError: 'invalid-campaign-id',
    };
  }
  const headers = {
    ...buildHeaders(ctx),
    'content-type': 'application/json',
    origin: REGIONS[ctx.region].base,
  };
  const response = await send(ctx, {
    url: `${REGIONS[ctx.region].base}${CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`,
    method: 'POST',
    headers,
    body: '{}',
  });
  const transportError = response.errorKind === 'timeout' || response.errorKind === 'network'
    ? response.error || '网络错误'
    : null;
  const parsed = parseClaimResponse(response);
  return { ...parsed, transportError };
}

/** 只读读取活动面值（官方活动页用浏览器头，不带 Cosy-Machine*）。 */
export async function fetchCampaignReward(
  ctx: QoderApiContext,
  campaignId: string,
): Promise<{ kind: string; amount: number } | null> {
  const headers = sashHeaders(ctx.tokens.access);
  headers.origin = REGIONS[ctx.region].base;
  const response = await send(ctx, {
    url: `${REGIONS[ctx.region].base}${CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/reward`,
    method: 'GET',
    headers,
    retry: { ...ctx.retry, maxAttempts: 1 },
  });
  if (response.status !== 200 || !response.json) return null;
  const payload = response.json;
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : payload;
  const benefit = data.benefit && typeof data.benefit === 'object' ? (data.benefit as Record<string, unknown>) : {};
  return {
    kind: firstText(data.kind, benefit.kind).toUpperCase(),
    amount: amountOf(benefit.amount ?? data.amount),
  };
}

/**
 * 账户总剩余额度（用于领取前后核对真实增量）。
 * 汇总字段：userQuota.remaining + addOnQuota.remaining + dedicatedResourcePackages[].remaining + orgResourcePackage.remaining
 */
export async function fetchQuotaTotal(ctx: QoderApiContextWithMachine): Promise<{ total: number | null; httpStatus: number; error: string | null }> {
  const headers = buildHeaders(ctx);
  const response = await send(ctx, {
    url: `${REGIONS[ctx.region].base}${QUOTA_USAGE_PATH}`,
    method: 'GET',
    headers,
    retry: { ...ctx.retry, maxAttempts: 1 },
  });
  if (response.status !== 200 || !response.json) {
    return { total: null, httpStatus: response.status, error: response.error || `额度查询 HTTP ${response.status}` };
  }
  const payload = response.json;
  const data = payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : payload;
  let total = 0;
  let seen = false;
  const pools = ['userQuota', 'addOnQuota'] as const;
  for (const key of pools) {
    const pool = data[key];
    if (pool && typeof pool === 'object' && (pool as Record<string, unknown>).remaining !== undefined) {
      total += amountOf((pool as Record<string, unknown>).remaining);
      seen = true;
    }
  }
  const dedicated = data.dedicatedResourcePackages;
  if (Array.isArray(dedicated)) {
    for (const pool of dedicated) {
      if (pool && typeof pool === 'object' && (pool as Record<string, unknown>).remaining !== undefined) {
        total += amountOf((pool as Record<string, unknown>).remaining);
        seen = true;
      }
    }
  }
  const org = data.orgResourcePackage;
  if (org && typeof org === 'object' && (org as Record<string, unknown>).remaining !== undefined) {
    total += amountOf((org as Record<string, unknown>).remaining);
    seen = true;
  }
  if (!seen) return { total: null, httpStatus: response.status, error: '额度响应结构未知' };
  return { total: Math.round(total * 100) / 100, httpStatus: response.status, error: null };
}
