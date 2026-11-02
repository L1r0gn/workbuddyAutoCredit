/**
 * 本地状态存储（JSON，原子写入，权限 0600）。
 *
 * 用途：
 * 1. 已领取状态缓存 —— 同一账号同一天只认一次成功记录，后续运行直接跳过。
 * 2. 领取历史 —— 日期、结果、前后积分、验证方式，供 CLI 与人工核对。
 *
 * 并发保护：
 * - 进程内：checkin-service 用 Map 串行化同一账号。
 * - 跨进程（daemon + 手动 CLI 同时跑）：临界区用 O_EXCL 锁文件，5 分钟视为陈旧锁。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckinRecord } from './types';

const STATE_VERSION = 1;
const KEEP_DAYS = 90;
const LOCK_STALE_MS = 5 * 60 * 1000;

export interface AccountState {
  /** 最近一次成功（或已签到）的日期 */
  lastSuccessDate: string | null;
  /** date -> record */
  records: Record<string, CheckinRecord>;
}

export interface StoreState {
  version: number;
  updatedAt: number;
  accounts: Record<string, AccountState>;
}

function emptyState(): StoreState {
  return { version: STATE_VERSION, updatedAt: Date.now(), accounts: {} };
}

export class StateStore {
  readonly dataDir: string;
  readonly stateFile: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
  }

  /** 读取状态；文件缺失或损坏时返回空状态（不抛错，保证签到可继续）。 */
  load(): StoreState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as StoreState;
      if (!parsed || typeof parsed !== 'object' || !parsed.accounts) return emptyState();
      return {
        version: Number(parsed.version) || STATE_VERSION,
        updatedAt: Number(parsed.updatedAt) || 0,
        accounts: parsed.accounts,
      };
    } catch {
      return emptyState();
    }
  }

  private save(state: StoreState): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const pruned = prune(state);
    pruned.updatedAt = Date.now();
    const tmp = `${this.stateFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
    try {
      fs.chmodSync(this.stateFile, 0o600);
    } catch {
      /* Windows 上可能不支持，忽略 */
    }
  }

  /** 读取指定账号指定日期的记录。 */
  getRecord(uid: string, date: string): CheckinRecord | null {
    const state = this.load();
    const account = state.accounts[uid];
    const record = account && account.records ? account.records[date] : null;
    return record || null;
  }

  /**
   * 今天是否已有"确认成功"的记录。
   * 只有 ok=true 且 verified 不为 false 的记录才算数，避免异常响应被误判为成功。
   * `skipped` 也是由一次确认成功派生的（今日已完成），同样视为已确认。
   */
  hasConfirmedSuccess(uid: string, date: string): boolean {
    const record = this.getRecord(uid, date);
    if (!record) return false;
    if (!record.ok) return false;
    if (record.verified === false) return false;
    return record.outcome === 'checked-in' || record.outcome === 'already' || record.outcome === 'skipped';
  }

  /** 写入一条记录（合并写，保留其它账号/日期）。 */
  saveRecord(record: CheckinRecord): void {
    this.withLock(() => {
      const state = this.load();
      const account: AccountState = state.accounts[record.uid] || { lastSuccessDate: null, records: {} };
      const existing = account.records[record.date];
      // 按信息量分级合并：真实领取 > 服务端已签到 > 本地跳过 > 其它（失败/模拟）。
      // 低等级记录不得覆盖高等级记录，避免"跳过"把"已领取"挤出状态文件。
      const rank = (item: CheckinRecord | undefined): number => {
        if (!item) return -1;
        if (item.outcome === 'checked-in') return 3;
        if (item.outcome === 'already') return 2;
        if (item.outcome === 'skipped') return 1;
        return 0;
      };
      const incomingSuccess = record.ok && record.verified !== false;
      if (existing && rank(existing) > rank(record)) {
        // 保留原有更高等级记录，仅补充诊断信息
        existing.diagnostic = record.diagnostic ?? existing.diagnostic;
        account.records[record.date] = existing;
      } else {
        account.records[record.date] = record;
        if (incomingSuccess) account.lastSuccessDate = record.date;
      }
      state.accounts[record.uid] = account;
      this.save(state);
    });
  }

  /** 当天所有账号记录。 */
  listByDate(date: string): Record<string, CheckinRecord> {
    const state = this.load();
    const out: Record<string, CheckinRecord> = {};
    for (const [uid, account] of Object.entries(state.accounts)) {
      const record = account.records[date];
      if (record) out[uid] = record;
    }
    return out;
  }

  /** 读取某账号最近 N 条记录（新的在前）。 */
  history(uid: string, limit = 10): CheckinRecord[] {
    const state = this.load();
    const account = state.accounts[uid];
    if (!account) return [];
    return Object.values(account.records)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  /**
   * 临界区锁：跨进程互斥，避免 daemon 与手动 CLI 同时领取。
   * 拿不到锁时抛出明确错误（调用方按失败处理，不阻塞其它账号）。
   */
  withLock<T>(fn: () => T, options: { timeoutMs?: number } = {}): T {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(this.dataDir, '.state.lock');
    const deadline = Date.now() + (options.timeoutMs ?? 3000);
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(fd, String(process.pid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // 陈旧锁清理
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error('状态文件被其它进程占用，请稍后重试');
        const wait = 50;
        const end = Date.now() + wait;
        while (Date.now() < end) {
          /* 短暂自旋，避免引入异步 */
        }
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 只保留最近 KEEP_DAYS 天的记录，防止状态文件无限增长。 */
function prune(state: StoreState): StoreState {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const [uid, account] of Object.entries(state.accounts)) {
    const kept: Record<string, CheckinRecord> = {};
    for (const [date, record] of Object.entries(account.records || {})) {
      if (date >= cutoff) kept[date] = record;
    }
    const dates = Object.keys(kept).sort();
    state.accounts[uid] = { lastSuccessDate: account.lastSuccessDate, records: kept };
    if (!dates.length) delete state.accounts[uid];
  }
  return state;
}
