/**
 * Qoder 模块入口：装配配置、日志、存储、服务与调度。
 *
 * 复用 WorkBuddy 模块的通用件（日志脱敏、HTTP 客户端、时区计算），
 * 新平台不复制这些基础能力，也不改动它们的行为。
 */
import type { RetryPolicy } from '../checkin/client';
import { Logger } from '../checkin/logger';
import { loadAccounts } from './accounts';
import { loginWithDeviceFlow, type LoginOptions } from './auth';
import { describeQoderConfig, loadQoderConfig, normalizeRegion, REGIONS } from './config';
import { QoderService } from './service';
import { QoderStore } from './store';
import type { QoderAccount, QoderConfig, QoderRegion, QoderTokens } from './types';

export * from './types';
export { REGIONS, REGION_IDS, normalizeRegion, loadQoderConfig, defaultQoderConfig, describeQoderConfig, clientVersion, findUmidComponent } from './config';
export { QoderStore, maskToken, accountTag, accountIdFor } from './store';
export { loadAccounts, selectAccounts, describeAccount, parseAccountLine, splitAccountLines, looksLikeToken } from './accounts';
export { startDeviceLogin, pollDeviceLoginOnce, loginWithDeviceFlow, refreshTokens, looksLikeAccessToken } from './auth';
export { getRiskIdentity, invokeUmid, locateUmid, machineOs, machineHostname, clearRiskCache } from './device';
export {
  fetchCampaigns,
  claimCampaign,
  parseClaimResponse,
  fetchQuotaTotal,
  fetchCampaignReward,
  sashHeaders,
  minimalSashHeaders,
  buildHeaders,
  authDead,
  quotaCooldown,
  campaignRows,
  normalizeCampaignRow,
  CLAIM_FAILURE_TEXT,
} from './api';
export { pickDailyCampaign, looksLikeProUpgrade, dailyWindowActive, describeCampaignRows } from './campaign';
export { QoderService } from './service';
export { QoderScheduler, QoderPidFile } from './scheduler';

export interface QoderRuntime {
  config: QoderConfig;
  logger: Logger;
  store: QoderStore;
  service: QoderService;
  accounts: () => QoderAccount[];
  summary: Record<string, unknown>;
}

export interface QoderRuntimeOptions {
  config?: QoderConfig;
  cwd?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scope?: string;
  env?: NodeJS.ProcessEnv;
}

export function createQoderRuntime(options: QoderRuntimeOptions = {}): QoderRuntime {
  const config = options.config || loadQoderConfig({ ...(options.cwd ? { cwd: options.cwd } : {}) });
  const logger = new Logger({
    logDir: config.dataDir,
    verbose: config.verbose,
    scope: options.scope || 'qoder',
  });
  const store = new QoderStore(config.dataDir);
  const service = new QoderService({
    config,
    logger,
    store,
    retry: {
      maxAttempts: config.retry.maxAttempts,
      baseDelayMs: config.retry.baseDelayMs,
      maxDelayMs: config.retry.maxDelayMs,
      ...(options.sleep ? { sleepImpl: options.sleep } : {}),
    } satisfies RetryPolicy,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  const accounts = (): QoderAccount[] =>
    loadAccounts({
      store,
      regions: config.regions,
      ...(options.env ? { env: options.env } : {}),
      ...(options.now ? { now: options.now } : {}),
    });

  return {
    config,
    logger,
    store,
    service,
    accounts,
    summary: describeQoderConfig(config),
  };
}

export interface LoginResult {
  ok: boolean;
  region: QoderRegion;
  account: QoderAccount | null;
  authUrl: string;
  error: string | null;
  /** 是否成功唤起浏览器（失败不代表登录失败，链接已经给到用户） */
  browserOpened: boolean;
  browserError: string | null;
}

/**
 * 交互式设备码登录并把账号写入存储。
 * 需要用户在自己的浏览器里确认授权（不处理验证码 / MFA）。
 */
export async function loginAccount(input: {
  region: QoderRegion | string;
  note?: string;
  store: QoderStore;
  logger: Logger;
  openBrowser?: LoginOptions['openBrowser'];
  onAuthUrl?: (url: string) => void;
  onPoll?: (attempt: number) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<LoginResult> {
  const region = normalizeRegion(input.region);
  const machineId = input.store.installMachineId();
  const loginOptions: LoginOptions = {
    ...(input.openBrowser ? { openBrowser: input.openBrowser } : {}),
    ...(input.onAuthUrl ? { onAuthUrl: input.onAuthUrl } : {}),
    ...(input.onPoll ? { onPoll: input.onPoll } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.intervalMs ? { intervalMs: input.intervalMs } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  };

  const result = await loginWithDeviceFlow(region, machineId, loginOptions);
  if (!result.ok || !result.tokens) {
    return {
      ok: false,
      region,
      account: null,
      authUrl: result.authUrl,
      error: result.error || '授权失败',
      browserOpened: result.browserOpened,
      browserError: result.browserError,
    };
  }

  const account = input.store.upsertAccount({
    region,
    note: input.note || `${region === 'cn' ? 'QoderCN' : 'Qoder'}`,
    uid: result.uid || '',
    tokens: result.tokens,
    source: 'login',
  });
  input.logger.info(
    `已保存 ${REGIONS[region].label} 账号 ${account.note}（uid=${account.uid || '未知'}）`,
  );
  return {
    ok: true,
    region,
    account,
    authUrl: result.authUrl,
    error: null,
    browserOpened: result.browserOpened,
    browserError: result.browserError,
  };
}

/** 手动写入令牌（用于已有 token 的场景）。 */
export function importAccount(input: {
  store: QoderStore;
  region: QoderRegion | string;
  access: string;
  refresh?: string;
  uid?: string;
  note?: string;
  now?: () => number;
}): QoderAccount {
  const region = normalizeRegion(input.region);
  const tokens: QoderTokens = {
    access: String(input.access || '').trim(),
    refresh: String(input.refresh || '').trim(),
    updatedAt: (input.now || Date.now)(),
  };
  if (!tokens.access) throw new Error('access_token 不能为空');
  return input.store.upsertAccount({
    region,
    uid: input.uid || '',
    ...(input.note ? { note: input.note } : {}),
    tokens,
    source: 'store',
  });
}

/** 配置摘要（供 CLI 打印）。 */
export function describeRuntime(runtime: QoderRuntime): Record<string, unknown> {
  return describeQoderConfig(runtime.config);
}
