/**
 * Qoder 账号、令牌与签到记录的本地存储。
 *
 * 设计要点：
 * 1. 令牌必须落盘：Qoder 的续期会轮换 refresh_token，只放内存会导致第二次运行失效。
 * 2. 文件权限 0600，位于用户数据目录（不在仓库内），`.gitignore` 同时兜底。
 * 3. 写入为「临时文件 + rename」原子替换，避免断电/中断产生半截 JSON。
 * 4. 令牌绝不进日志：对外只暴露 `maskToken()` 结果。
 * 5. machineToken 不落盘（有时效的签名串），只保存稳定标识 machineId。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  QoderAccount,
  QoderCheckinRecord,
  QoderDeviceIdentity,
  QoderRegion,
  QoderTokens,
} from './types';

const STORE_VERSION = 1;
const KEEP_DAYS = 90;
const STORE_FILE = 'qoder-state.json';

interface StoredAccount {
  region: QoderRegion;
  note: string;
  uid: string;
  access: string;
  refresh: string;
  updatedAt: number;
  source: QoderAccount['source'];
  createdAt: number;
  device: QoderDeviceIdentity;
  lastCheckinAt?: number;
  records: Record<string, QoderCheckinRecord>;
}

interface StoreFile {
  version: number;
  updatedAt: number;
  install: { machineId: string };
  accounts: Record<string, StoredAccount>;
}

function emptyStore(): StoreFile {
  return { version: STORE_VERSION, updatedAt: Date.now(), install: { machineId: '' }, accounts: {} };
}

/** 令牌脱敏：仅展示前缀与末 4 位。 */
export function maskToken(token: string): string {
  const value = String(token || '');
  if (!value) return '—';
  if (value.length <= 12) return value.slice(0, 3) + '****';
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

/** 账号在日志里的稳定标签：region + 令牌指纹（不含凭据）。 */
export function accountTag(region: QoderRegion, uid: string, access: string): string {
  const seed = uid || access || '';
  const digest = crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 8);
  return `${region === 'cn' ? 'cn' : 'intl'}-${digest}`;
}

/** 账号主键：有 uid 用 uid，否则用令牌指纹，保证同一账号多次运行可命中同一条记录。 */
export function accountIdFor(region: QoderRegion, uid: string, access: string): string {
  const digest = crypto.createHash('sha256').update(access || uid || '', 'utf8').digest('hex').slice(0, 16);
  return uid ? `${region}:${uid}` : `${region}:fp-${digest}`;
}

export class QoderStore {
  readonly dataDir: string;
  readonly file: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, STORE_FILE);
  }

  load(): StoreFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile;
      if (!parsed || typeof parsed !== 'object' || !parsed.accounts) return emptyStore();
      if (!parsed.install || typeof parsed.install.machineId !== 'string') parsed.install = { machineId: '' };
      return parsed;
    } catch {
      return emptyStore();
    }
  }

  private save(store: StoreFile): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    store.updatedAt = Date.now();
    prune(store);
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows 上可能不支持 */
    }
  }

  /** 本机稳定标识（Cosy-MachineId 的兜底来源）。 */
  installMachineId(): string {
    const store = this.load();
    if (store.install.machineId) return store.install.machineId;
    const value = crypto.randomUUID().replace(/-/g, '');
    store.install.machineId = value;
    this.save(store);
    return value;
  }

  /** 列出账号（可按区域过滤）。 */
  listAccounts(region?: QoderRegion): QoderAccount[] {
    const store = this.load();
    return Object.entries(store.accounts)
      .filter(([, item]) => !region || item.region === region)
      .map(([id, item]) => this.toAccount(id, item))
      .sort((a, b) => a.region.localeCompare(b.region) || a.createdAt - b.createdAt);
  }

  getAccount(id: string): QoderAccount | null {
    const store = this.load();
    const item = store.accounts[id];
    return item ? this.toAccount(id, item) : null;
  }

  private toAccount(id: string, item: StoredAccount): QoderAccount {
    return {
      id,
      region: item.region,
      note: item.note,
      uid: item.uid,
      tokens: { access: item.access, refresh: item.refresh, updatedAt: item.updatedAt },
      device: item.device,
      source: item.source,
      createdAt: item.createdAt,
    };
  }

  /** 新增或更新账号（按 id 覆盖）。 */
  upsertAccount(input: {
    region: QoderRegion;
    note?: string;
    uid?: string;
    tokens: QoderTokens;
    device?: Partial<QoderDeviceIdentity>;
    source?: QoderAccount['source'];
  }): QoderAccount {
    const store = this.load();
    const id = accountIdFor(input.region, input.uid || '', input.tokens.access);
    const existing = store.accounts[id];
    const machineId = input.device?.machineId || existing?.device.machineId || this.installMachineId();
    const account: StoredAccount = {
      region: input.region,
      note: input.note || existing?.note || defaultNote(input.region, input.uid || ''),
      uid: input.uid || existing?.uid || '',
      access: input.tokens.access,
      refresh: input.tokens.refresh || existing?.refresh || '',
      updatedAt: input.tokens.updatedAt || Date.now(),
      source: input.source || existing?.source || 'store',
      createdAt: existing?.createdAt || Date.now(),
      device: {
        machineId,
        machineOs: input.device?.machineOs || existing?.device.machineOs || '',
        machineHostname: input.device?.machineHostname || existing?.device.machineHostname || '',
        ...(input.device?.machineCode ?? existing?.device.machineCode
          ? { machineCode: input.device?.machineCode ?? existing?.device.machineCode }
          : {}),
        ...(input.device?.machineType ?? existing?.device.machineType
          ? { machineType: input.device?.machineType ?? existing?.device.machineType }
          : {}),
        lastUmidAt: input.device?.lastUmidAt ?? existing?.device.lastUmidAt,
      },
      records: existing?.records || {},
      ...(existing?.lastCheckinAt ? { lastCheckinAt: existing.lastCheckinAt } : {}),
    };
    store.accounts[id] = account;
    this.save(store);
    return this.toAccount(id, account);
  }

  /** 续期后更新令牌（refresh 可能被轮换，必须立即落盘）。 */
  updateTokens(id: string, tokens: QoderTokens): void {
    const store = this.load();
    const item = store.accounts[id];
    if (!item) throw new Error('账号不存在，无法保存令牌');
    item.access = tokens.access;
    if (tokens.refresh) item.refresh = tokens.refresh;
    item.updatedAt = tokens.updatedAt;
    this.save(store);
  }

  /** 记录设备身份（machineCode/machineType 仅供展示与排障）。 */
  patchDevice(id: string, patch: Partial<QoderDeviceIdentity>): void {
    const store = this.load();
    const item = store.accounts[id];
    if (!item) return;
    item.device = { ...item.device, ...patch };
    this.save(store);
  }

  removeAccount(id: string): boolean {
    const store = this.load();
    if (!store.accounts[id]) return false;
    delete store.accounts[id];
    this.save(store);
    return true;
  }

  getRecord(id: string, date: string): QoderCheckinRecord | null {
    const store = this.load();
    return store.accounts[id]?.records?.[date] || null;
  }

  /** 今日是否已确认完成（只有 ok 且 verified 不为 false 才算）。 */
  hasConfirmed(id: string, date: string): boolean {
    const record = this.getRecord(id, date);
    if (!record || !record.ok || record.verified === false) return false;
    return record.outcome === 'claimed' || record.outcome === 'already';
  }

  saveRecord(record: QoderCheckinRecord): void {
    const store = this.load();
    const item = store.accounts[record.accountId];
    if (!item) return;
    item.records = item.records || {};
    const existing = item.records[record.date];
    // 分级合并：真实领取 > 已领取 > 跳过 > 其它，低等级不能覆盖高等级
    const rank = (value: QoderCheckinRecord | undefined): number => {
      if (!value) return -1;
      if (value.outcome === 'claimed') return 3;
      if (value.outcome === 'already') return 2;
      if (value.outcome === 'skipped') return 1;
      return 0;
    };
    if (existing && rank(existing) > rank(record)) {
      existing.diagnostic = record.diagnostic ?? existing.diagnostic;
    } else {
      item.records[record.date] = record;
    }
    if (record.ok) item.lastCheckinAt = record.at;
    this.save(store);
  }
}

function defaultNote(region: QoderRegion, uid: string): string {
  const label = region === 'cn' ? 'QoderCN' : 'Qoder';
  return uid ? `${label}-${uid.slice(0, 6)}` : label;
}

/** 只保留最近 90 天记录，避免文件无限增长。 */
function prune(store: StoreFile): void {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const [id, account] of Object.entries(store.accounts)) {
    const records: Record<string, QoderCheckinRecord> = {};
    for (const [date, record] of Object.entries(account.records || {})) {
      if (date >= cutoff) records[date] = record;
    }
    account.records = records;
    if (!account.access) delete store.accounts[id];
  }
}
