/**
 * 账号发现与管理。
 *
 * 账号来源（按可信度排序）：
 * 1. official        —— 官方客户端当前登录文件（真实登录态，只读）
 * 2. managed         —— 用户自行放入 `<dataDir>/accounts/*.info` 的备份
 * 3. legacy-backup   —— 参考项目 WorkDaddy 的账号备份目录（可选，只读）
 *
 * 同一 uid 在多处出现时按上述优先级去重，避免同一账号被签到两次。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appSupportDir, extensionAuthDir, PROFILES } from './config';
import { inspectToken, isTokenUsable, readAuthFile } from './auth-manager';
import { maskPhone, maskUid, redactText } from './logger';
import type { AccountContext, CheckinConfig, ProfileId } from './types';

interface Candidate {
  profile: ProfileId;
  authFile: string;
  origin: AccountContext['origin'];
  priority: number;
}

const ORIGIN_PRIORITY: Record<AccountContext['origin'], number> = {
  official: 0,
  managed: 1,
  'legacy-backup': 2,
};

/** 参考项目的账号备份目录（只读扫描，用于衔接已有备份）。 */
export function legacyBackupDir(): string {
  return path.join(appSupportDir(), 'WorkDaddy', 'accounts');
}

function listInfoFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.info') && !name.endsWith('.tmp'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** 依据令牌签发域推断 profile。 */
function inferProfileFromOrigin(origin: string | null): ProfileId | null {
  if (!origin) return null;
  if (/workbuddy\.ai$/.test(origin)) return 'workbuddy-ai';
  if (/workbuddy\.cn$|codebuddy\.cn$/.test(origin)) return 'workbuddy-cn';
  return null;
}

/** 收集候选凭据文件。 */
function collectCandidates(config: CheckinConfig): Candidate[] {
  const candidates: Candidate[] = [];
  const authDir = extensionAuthDir();

  for (const profile of config.profiles) {
    const file = path.join(authDir, PROFILES[profile].authFileName);
    if (fs.existsSync(file)) {
      candidates.push({ profile, authFile: file, origin: 'official', priority: ORIGIN_PRIORITY.official });
    }
  }

  for (const file of listInfoFiles(config.managedAccountsDir)) {
    // 文件名约定：<profile>__*.info 或 <任意>.info；profile 在实际读取时按令牌签发域校验
    const base = path.basename(file).toLowerCase();
    const hinted = base.startsWith('workbuddy-ai') || base.includes('__ai') ? 'workbuddy-ai' : 'workbuddy-cn';
    candidates.push({ profile: hinted, authFile: file, origin: 'managed', priority: ORIGIN_PRIORITY.managed });
  }

  if (config.scanLegacyBackup) {
    for (const file of listInfoFiles(legacyBackupDir())) {
      // 参考项目以 uid 命名，profile 未知，先按国内版尝试（国际版会在令牌域校验时纠正）
      candidates.push({ profile: 'workbuddy-cn', authFile: file, origin: 'legacy-backup', priority: ORIGIN_PRIORITY['legacy-backup'] });
    }
  }

  return candidates.sort((a, b) => a.priority - b.priority);
}

export interface DiscoverOptions {
  /** 是否允许派生解密密钥（测试环境通常关闭） */
  allowKeyDerivation?: boolean;
  /** 显式指定可执行文件，覆盖自动探测 */
  exePath?: Partial<Record<ProfileId, string | null>>;
}

/**
 * 扫描本机账号，返回去重后的账号上下文列表。
 * 不发起任何网络请求。
 */
export function discoverAccounts(config: CheckinConfig, options: DiscoverOptions = {}): AccountContext[] {
  const candidates = collectCandidates(config);
  const byUid = new Map<string, AccountContext>();
  const anonymous: AccountContext[] = [];

  for (const candidate of candidates) {
    const exePath = options.exePath && candidate.profile in options.exePath
      ? options.exePath[candidate.profile] ?? null
      : config.workBuddyExe[candidate.profile] ?? undefined;

    const content = readAuthFile(candidate.authFile, candidate.profile, {
      allowKeyDerivation: options.allowKeyDerivation,
      ...(exePath ? { exePath } : {}),
    });

    const token = content.credentials?.accessToken ?? '';
    const inspected = token ? inspectToken(token) : { issuerOrigin: null, expiresAt: null, subject: null };

    // 以令牌签发域纠正 profile（备份文件可能被放错目录）
    let profile = candidate.profile;
    const inferred = inferProfileFromOrigin(inspected.issuerOrigin);
    if (inferred && candidate.origin !== 'official') profile = inferred;

    const uid = content.account?.uid || inspected.subject || '';
    const context: AccountContext = {
      uid,
      accountTag: uid ? maskUid(uid) : `unknown-${path.basename(candidate.authFile).replace(/\.info$/, '').slice(0, 12)}`,
      profile,
      authFile: candidate.authFile,
      origin: candidate.origin,
      nickname: content.account?.nickname || '',
      phoneMasked: maskPhone(content.account?.phoneMasked || ''),
      domain: content.credentials?.domain || '',
      isCurrent: candidate.origin === 'official',
      credentials: content.credentials,
      credentialError: content.credentialError,
      tokenExpired: content.credentials ? !isTokenUsable(content.credentials) : false,
    };

    if (!uid) {
      anonymous.push(context);
      continue;
    }
    const existing = byUid.get(uid);
    if (!existing) {
      byUid.set(uid, context);
      continue;
    }
    // 同一 uid：保留优先级更高的来源；若已有来源凭据不可用而新来源可用，则替换
    const betterOrigin = ORIGIN_PRIORITY[context.origin] < ORIGIN_PRIORITY[existing.origin];
    const betterCredential = !existing.credentials && !!context.credentials;
    if (betterOrigin || betterCredential) byUid.set(uid, context);
  }

  return [...byUid.values(), ...anonymous];
}

/** 当前登录账号（每个 profile 一个，取 official 来源）。 */
export function currentAccounts(accounts: AccountContext[]): AccountContext[] {
  return accounts.filter((account) => account.isCurrent && account.origin === 'official');
}

/**
 * 按 uid / 脱敏标签 / 昵称 / 序号查找账号。
 * CLI 的 `--account` 参数会用它解析。
 */
export function findAccounts(accounts: AccountContext[], selector?: string | null): AccountContext[] {
  const key = String(selector || '').trim();
  if (!key) return accounts;
  const lower = key.toLowerCase();
  const matches = accounts.filter(
    (account) =>
      account.uid === key ||
      account.accountTag.toLowerCase() === lower ||
      (account.nickname && account.nickname.toLowerCase() === lower),
  );
  if (matches.length) return matches;
  // 也支持 1-based 序号，便于交互式选择
  const index = Number(key);
  if (Number.isSafeInteger(index) && index >= 1 && index <= accounts.length) {
    const picked = accounts[index - 1];
    return picked ? [picked] : [];
  }
  return [];
}

/** 账号摘要（CLI 输出 / 日志用，绝不包含令牌）。 */
export function describeAccount(account: AccountContext): Record<string, unknown> {
  return {
    account: account.accountTag,
    profile: account.profile,
    nickname: account.nickname,
    phone: account.phoneMasked,
    origin: account.origin,
    isCurrent: account.isCurrent,
    hasCredential: !!account.credentials,
    credentialError: account.credentialError ? redactText(account.credentialError, 160) : null,
    tokenExpired: account.tokenExpired,
    tokenExpiresAt: account.credentials?.expiresAt ? new Date(account.credentials.expiresAt).toISOString() : null,
  };
}
