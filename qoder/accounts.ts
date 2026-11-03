/**
 * 账号来源整合：本模块存储 + 环境变量导入（兼容 Qoder-Daily 的写法）。
 *
 * 环境变量格式（与参考实现一致）：
 *   QODER_TOKENS         国内版
 *   QODER_GLOBAL_TOKENS  国际版
 *   每行 / 用 & 分隔，支持：
 *     access
 *     access|refresh
 *     note|access|refresh
 *     note|access|refresh|uid        （国际版常用第 4 段 uid）
 *
 * 环境变量里的账号首次出现时会写入本机存储（令牌轮换后仍可继续使用）。
 */
import { normalizeRegion, REGIONS } from './config';
import { accountIdFor, QoderStore } from './store';
import type { QoderAccount, QoderRegion, QoderTokens } from './types';

/** 令牌形态判定（dt- / drt- / jt- / jrt- / JWT / 长串）。 */
export function looksLikeToken(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  return (
    text.startsWith('dt-') ||
    text.startsWith('drt-') ||
    text.startsWith('jt-') ||
    text.startsWith('jrt-') ||
    text.startsWith('eyJ') ||
    text.split('.').length >= 3 ||
    text.length > 80
  );
}

export interface ParsedAccount {
  note: string;
  access: string;
  refresh: string;
  uid: string;
  region: QoderRegion;
}

/** 解析一行账号配置。 */
export function parseAccountLine(line: string, region: QoderRegion, index: number): ParsedAccount | null {
  const text = String(line || '').trim().replace(/^["']|["']$/g, '');
  if (!text || text.startsWith('#')) return null;
  const parts = text.split('|').map((part) => part.trim());
  const fallbackNote = region === 'cn' ? `QoderCN-${index}` : `Qoder-${index}`;
  let note = fallbackNote;
  let access = '';
  let refresh = '';
  let uid = '';

  if (parts.length >= 4) {
    [note, access, refresh, uid] = parts as [string, string, string, string];
  } else if (parts.length === 3) {
    [note, access, refresh] = parts as [string, string, string];
  } else if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    if (looksLikeToken(first) && looksLikeToken(second)) {
      access = first;
      refresh = second;
    } else if (looksLikeToken(second)) {
      note = first;
      access = second;
    } else {
      access = first;
      refresh = second;
    }
  } else {
    access = parts[0] || '';
  }

  if (!access) return null;
  return { note: note || fallbackNote, access, refresh, uid, region };
}

/** 把多行文本拆成账号行。 */
export function splitAccountLines(raw: string): string[] {
  return String(raw || '')
    .replace(/&/g, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export interface LoadAccountsOptions {
  store: QoderStore;
  /** 只取这些区域 */
  regions?: QoderRegion[];
  env?: NodeJS.ProcessEnv;
  /** 是否把环境变量里的账号写入存储（默认 true） */
  persistEnv?: boolean;
  now?: () => number;
}

/**
 * 汇总可用账号：存储中已有的 + 环境变量里的（去重）。
 * 环境变量优先写回存储，保证续期后的新令牌能持久化。
 */
export function loadAccounts(options: LoadAccountsOptions): QoderAccount[] {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const persist = options.persistEnv !== false;
  const regions = options.regions && options.regions.length ? options.regions : (['cn', 'global'] as QoderRegion[]);

  const envSources: Array<{ raw: string; region: QoderRegion }> = [];
  if (regions.includes('cn')) envSources.push({ raw: String(env.QODER_TOKENS || ''), region: 'cn' });
  if (regions.includes('global')) envSources.push({ raw: String(env.QODER_GLOBAL_TOKENS || ''), region: 'global' });

  for (const source of envSources) {
    splitAccountLines(source.raw).forEach((line, index) => {
      const parsed = parseAccountLine(line, source.region, index + 1);
      if (!parsed) return;
      const id = accountIdFor(parsed.region, parsed.uid, parsed.access);
      const existing = options.store.getAccount(id);
      // 已存在且令牌未变则不动；令牌变化（例如用户换了 token）则更新
      if (existing && existing.tokens.access === parsed.access && existing.tokens.refresh === parsed.refresh) return;
      if (!persist) return;
      options.store.upsertAccount({
        region: parsed.region,
        note: parsed.note,
        uid: parsed.uid,
        tokens: { access: parsed.access, refresh: parsed.refresh, updatedAt: now() },
        source: 'env',
      });
    });
  }

  return options.store.listAccounts().filter((account) => regions.includes(account.region));
}

/** 按 region / 备注 / id / uid / 序号选择账号。 */
export function selectAccounts(accounts: QoderAccount[], selector?: string | null): QoderAccount[] {
  const key = String(selector || '').trim();
  if (!key) return accounts;
  const lower = key.toLowerCase();
  const regionKey = lower === 'cn' || lower === 'global' ? (normalizeRegion(lower)) : null;
  if (regionKey) return accounts.filter((account) => account.region === regionKey);

  const matches = accounts.filter(
    (account) =>
      account.id.toLowerCase() === lower ||
      account.uid.toLowerCase() === lower ||
      account.note.toLowerCase() === lower,
  );
  if (matches.length) return matches;
  const index = Number(key);
  if (Number.isSafeInteger(index) && index >= 1 && index <= accounts.length) {
    const picked = accounts[index - 1];
    return picked ? [picked] : [];
  }
  return [];
}

/** 账号摘要（CLI / 日志用，不含凭据）。 */
export function describeAccount(account: QoderAccount): Record<string, unknown> {
  return {
    id: account.id,
    region: account.region,
    regionLabel: REGIONS[account.region].label,
    note: account.note,
    uid: account.uid,
    source: account.source,
    hasRefresh: !!account.tokens.refresh,
    token: account.tokens.access
      ? `${account.tokens.access.slice(0, 6)}****${account.tokens.access.slice(-4)}`
      : '—',
    machineId: account.device.machineId,
    createdAt: account.createdAt,
  };
}

export type { QoderTokens };
