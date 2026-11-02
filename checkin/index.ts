/**
 * 模块入口：组装配置、日志、状态仓库、CDP 与服务，并对外导出。
 *
 * 典型用法：
 *   const runtime = createRuntime();
 *   const accounts = runtime.accounts();
 *   await runtime.service.checkinAll(accounts);
 */
import { discoverAccounts } from './account-manager';
import { CdpClient } from './cdp';
import { CheckinService } from './checkin-service';
import { loadConfig, PROFILES } from './config';
import { retryPolicyFrom } from './client';
import { describeConfig } from './config';
import { detectInsecureTlsEnv, Logger } from './logger';
import { StateStore } from './state-store';
import type { AccountContext, CheckinConfig } from './types';

export * from './types';
export { loadConfig, defaultConfig, describeConfig, PROFILES, PROFILE_IDS, extensionAuthDir, defaultDataDir, findWorkBuddyExe } from './config';
export { Logger, redactText, maskUid, maskPhone, beijingDate, localIso, detectInsecureTlsEnv } from './logger';
export { StateStore } from './state-store';
export {
  discoverAccounts,
  currentAccounts,
  findAccounts,
  describeAccount,
  legacyBackupDir,
} from './account-manager';
export {
  readAuthFile,
  extractAuthContent,
  inspectToken,
  isTokenUsable,
  refreshCredentials,
  deriveStaticKey,
  openEnvelope,
  clearKeyCache,
} from './auth-manager';
export {
  classifyCheckinResult,
  resolveCheckinEndpoints,
  resolveCreditHosts,
  fetchCredits,
  claimDailyCheckin,
  buildCreditResourceBody,
  extractCreditTotal,
  ISSUER_HOST_MAP,
  CHECKIN_PATHS,
} from './credit-api';
export { requestOnce, requestWithRetry, isTransient, retryPolicyFrom } from './client';
export { CheckinService } from './checkin-service';
export { CdpClient, classifyTarget, selectPageTarget, detectClientProcess } from './cdp';
export { Scheduler, PidFile, nextSlotAt, zonedTimeToUtc, zonedParts, timezoneOffsetMs, backoffSequence } from './scheduler';

export interface Runtime {
  config: CheckinConfig;
  logger: Logger;
  store: StateStore;
  service: CheckinService;
  /** 每次调用都重新发现账号（账号切换后能立刻反映） */
  accounts: () => AccountContext[];
  cdp: () => CdpClient;
  summary: Record<string, unknown>;
}

export interface RuntimeOptions {
  config?: CheckinConfig;
  cwd?: string;
  /** 关闭密钥派生（仅测试用） */
  allowKeyDerivation?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scope?: string;
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const config = options.config || loadConfig({ ...(options.cwd ? { cwd: options.cwd } : {}) });
  const logger = new Logger({
    logDir: config.dataDir,
    verbose: config.verbose,
    scope: options.scope || 'checkin',
  });

  if (detectInsecureTlsEnv()) {
    logger.warn('检测到环境变量 NODE_TLS_REJECT_UNAUTHORIZED=0：外部环境已关闭 TLS 校验，本模块自身从不关闭');
  }

  const store = new StateStore(config.dataDir);
  const service = new CheckinService({
    config,
    logger,
    store,
    retry: retryPolicyFrom(config, options.sleep),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  const accounts = (): AccountContext[] =>
    discoverAccounts(config, {
      ...(options.allowKeyDerivation === undefined ? {} : { allowKeyDerivation: options.allowKeyDerivation }),
    });

  let cdpClient: CdpClient | null = null;
  const cdp = (): CdpClient => {
    if (!cdpClient) {
      const profile = config.profiles[0] || 'workbuddy-cn';
      cdpClient = new CdpClient({
        profile,
        logger,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    }
    return cdpClient;
  };

  const summary: Record<string, unknown> = {
    ...describeConfig(config),
    profiles: config.profiles.map((id) => ({ id, name: PROFILES[id].name, apiHost: PROFILES[id].apiHost })),
  };

  return { config, logger, store, service, accounts, cdp, summary };
}

/** 账号切换后重新确认身份：重新扫描并把 uid 与调用方期望值比对。 */
export function confirmIdentity(
  accounts: AccountContext[],
  expectedUid: string,
): { ok: boolean; account: AccountContext | null; reason: string | null } {
  const account = accounts.find((item) => item.uid === expectedUid) || null;
  if (!account) return { ok: false, account: null, reason: '账号已不存在于本机登录文件，可能已退出登录' };
  if (!account.credentials) return { ok: false, account, reason: account.credentialError || '凭据不可用' };
  if (account.tokenExpired) return { ok: false, account, reason: '令牌已过期' };
  return { ok: true, account, reason: null };
}
