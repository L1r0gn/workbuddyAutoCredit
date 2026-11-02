/**
 * 定时调度：默认按北京时间（Asia/Shanghai）每天 10:05 触发。
 *
 * 行为约定：
 * - 到点先查本地记录：今日已确认签到 → 不执行任何请求。
 * - 网络/接口瞬时故障 → 指数退避重试（有限次数），仍失败则等下一次检查时间。
 * - 客户端未运行时按配置决定是否拉起（clientMissing: 'skip' | 'launch'）。
 * - 拉起客户端不会绕过登录：没有有效登录态时只记录 unauthenticated，不尝试验证码/MFA。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beijingDate, type Logger, localIso, redactText } from './logger';
import { detectClientProcess } from './cdp';
import type { CheckinService } from './checkin-service';
import type { AccountContext, BatchResult, CheckinConfig } from './types';

/** 在指定时区取"墙上时间"偏移（毫秒）。 */
export function timezoneOffsetMs(timeZone: string, at: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value || 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wall - at;
}

/** 把时区内的墙上时间转换为 UTC 毫秒时间戳。 */
export function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // 两次迭代足以收敛（DST 边界也稳定）
  let at = guess;
  for (let i = 0; i < 2; i++) {
    const offset = timezoneOffsetMs(timeZone, at);
    at = guess - offset;
  }
  return at;
}

/** 在指定时区拆分年月日时分。 */
export function zonedParts(timeZone: string, at: number): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/**
 * 计算下一个检查时间点（严格大于 now）。
 * 支持 "HH:mm" 列表，跨天自动进位到次日。
 */
export function nextSlotAt(now: number, checkTimes: string[], timeZone: string): number {
  const parsed = (checkTimes.length ? checkTimes : ['10:05'])
    .map((t) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return { hour, minute };
    })
    .filter((v): v is { hour: number; minute: number } => v !== null)
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  // 全部非法时回落到默认 10:05，避免静默变成"次日凌晨"
  const times = parsed.length ? parsed : [{ hour: 10, minute: 5 }];

  const today = zonedParts(timeZone, now);
  for (const slot of times) {
    const at = zonedTimeToUtc(timeZone, today.year, today.month, today.day, slot.hour, slot.minute);
    if (at > now + 500) return at;
  }
  // 今天所有时间点都已过 → 用明天最早的时间点
  const first = times[0] || { hour: 10, minute: 5 };
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return zonedTimeToUtc(
    timeZone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    first.hour,
    first.minute,
  );
}

export interface SchedulerOptions {
  config: CheckinConfig;
  logger: Logger;
  service: CheckinService;
  /** 账号提供者：每次运行时重新发现，确保账号切换后身份正确 */
  accounts: () => AccountContext[];
  /** 测试注入 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onBatch?: (result: BatchResult) => void;
  /** 注入客户端拉起实现，便于测试 */
  launchClient?: () => Promise<{ launched: boolean; detail: string }>;
  /** 注入进程探测实现，便于测试 */
  detectProcess?: () => Promise<boolean | null>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 指数退避序列（毫秒）。 */
export function backoffSequence(config: CheckinConfig): number[] {
  const attempts = Math.max(1, config.retry.maxAttempts);
  const out: number[] = [];
  for (let i = 0; i < attempts; i++) {
    out.push(Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** i));
  }
  return out;
}

export class Scheduler {
  private readonly options: SchedulerOptions;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastRunDate: string | null = null;

  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    const impl = this.options.sleep || realSleep;
    await impl(ms);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 拉起客户端（只在显式配置 clientMissing='launch' 时调用）。 */
  private async launchClient(): Promise<{ launched: boolean; detail: string }> {
    if (this.options.launchClient) return this.options.launchClient();
    const exe = this.options.config.workBuddyExe['workbuddy-cn'] || process.env.WORKBUDDY_EXE || '';
    if (!exe) return { launched: false, detail: '未配置客户端可执行文件路径，无法拉起' };
    try {
      const child = spawn(exe, ['--remote-debugging-port=9222'], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { launched: true, detail: `已启动客户端：${path.basename(exe)}` };
    } catch (error) {
      return { launched: false, detail: redactText(error, 160) };
    }
  }

  /**
   * 执行一轮检查（含有限次退避重试）。
   * 返回本轮最终结果；全部账号成功/已签到时不会重试。
   */
  async runOnce(options: { dryRun?: boolean; force?: boolean } = {}): Promise<BatchResult> {
    const { config, logger, service } = this.options;
    const startedAt = this.now();
    logger.event('run.start', {
      at: localIso(startedAt),
      date: beijingDate(startedAt),
      timezone: config.timezone,
      dryRun: !!options.dryRun,
    });

    // 客户端状态只作诊断：签到依赖本地凭据文件，不强制客户端在线
    const processRunning = this.options.detectProcess
      ? await this.options.detectProcess()
      : await detectClientProcess('workbuddy-cn').catch(() => null);
    if (processRunning === false) {
      logger.warn('未检测到 WorkBuddy 客户端进程');
      if (config.clientMissing === 'launch' && !options.dryRun) {
        const launched = await this.launchClient();
        logger.event('client.launch', launched);
        if (launched.launched) await this.sleep(3000);
      } else {
        logger.info('按配置不自动启动客户端，继续使用本地凭据尝试签到');
      }
    }

    const backoffs = backoffSequence(config);
    let last: BatchResult | null = null;

    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      const accounts = this.options.accounts();
      if (!accounts.length) {
        logger.warn('没有发现可用的 WorkBuddy 账号');
        return {
          date: beijingDate(this.now()),
          startedAt,
          finishedAt: this.now(),
          records: [],
          summary: { total: 0, checkedIn: 0, already: 0, skipped: 0, dryRun: 0, failed: 0 },
        };
      }

      last = await service.checkinAll(accounts, { ...(options.dryRun ? { dryRun: true } : {}), ...(options.force ? { force: true } : {}) });
      this.options.onBatch?.(last);

      const retryable = last.records.filter((r) => r.outcome === 'unsupported' || r.outcome === 'error');
      if (!retryable.length) break;
      if (attempt === backoffs.length - 1) {
        logger.warn(`仍有 ${retryable.length} 个账号未完成，重试次数已用尽，等待下一次检查时间`);
        break;
      }
      const delay = backoffs[attempt] ?? config.retry.maxDelayMs;
      logger.info(`第 ${attempt + 1} 轮有 ${retryable.length} 个账号失败，${Math.round(delay / 1000)} 秒后重试`);
      await this.sleep(delay);
      if (this.stopped) break;
    }

    return (
      last || {
        date: beijingDate(this.now()),
        startedAt,
        finishedAt: this.now(),
        records: [],
        summary: { total: 0, checkedIn: 0, already: 0, skipped: 0, dryRun: 0, failed: 0 },
      }
    );
  }

  /**
   * 常驻循环：等到下一个检查时间点 → 执行 → 再等下一次。
   * 同一天内若本轮全部失败，会在当天后续检查时间点再次尝试。
   */
  async runForever(options: { dryRun?: boolean } = {}): Promise<void> {
    const { config, logger } = this.options;
    logger.event('scheduler.start', {
      timezone: config.timezone,
      checkTimes: config.checkTimes,
      dataDir: config.dataDir,
      pid: process.pid,
    });

    // 启动补偿：如果今天已经过了检查时间但还没有成功记录，立刻补一次
    const catchUp = this.shouldCatchUp();
    if (catchUp) {
      logger.info('检测到今天尚未完成签到，立即补执行一次');
      await this.runOnce(options);
      this.lastRunDate = beijingDate(this.now());
    }

    while (!this.stopped) {
      const now = this.now();
      const next = nextSlotAt(now, config.checkTimes, config.timezone);
      const waitMs = Math.max(1000, next - now);
      logger.event('scheduler.wait', {
        now: localIso(now),
        nextAt: localIso(next),
        nextAtZoned: new Date(next + timezoneOffsetMs(config.timezone, next)).toISOString().replace('Z', ''),
        waitSeconds: Math.round(waitMs / 1000),
      });
      await this.sleep(waitMs);
      if (this.stopped) break;

      // 触发时刻到了：若今日已确认成功则跳过网络请求（runOnce 内部也会跳过）
      const today = beijingDate(this.now());
      if (this.lastRunDate === today && this.allSucceededToday()) {
        logger.info('今日已全部完成，跳过本轮');
        continue;
      }
      await this.runOnce(options);
      this.lastRunDate = beijingDate(this.now());
    }
    logger.event('scheduler.stop', { at: localIso(this.now()) });
  }

  private allSucceededToday(): boolean {
    const today = beijingDate(this.now());
    const accounts = this.usableAccounts();
    if (!accounts.length) return false;
    return accounts.every((account) => this.options.service.store.hasConfirmedSuccess(account.uid, today));
  }

  /**
   * 只统计"凭据可用"的账号。
   * 没有凭据的账号（未安装对应客户端 / 未登录）永远不可能成功；
   * 若把它们算进来，每个检查点都会白跑一轮。
   */
  private usableAccounts(): AccountContext[] {
    return this.options.accounts().filter((account) => !!account.uid && !!account.credentials && !account.tokenExpired);
  }

  /** 今天是否已过检查时间但仍有可用账号未完成。 */
  private shouldCatchUp(): boolean {
    const now = this.now();
    const { config } = this.options;
    const today = beijingDate(now);
    const zoned = zonedParts(config.timezone, now);
    const slots = config.checkTimes
      .map((t) => /^(\d{1,2}):(\d{2})$/.exec(t))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => zonedTimeToUtc(config.timezone, zoned.year, zoned.month, zoned.day, Number(m[1]), Number(m[2])));
    if (!slots.length) return false;
    if (now < Math.min(...slots)) return false;
    const accounts = this.usableAccounts();
    if (!accounts.length) return false;
    return accounts.some((account) => !this.options.service.store.hasConfirmedSuccess(account.uid, today));
  }
}

/** daemon 的 pid 文件管理。 */
export class PidFile {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'daemon.pid');
  }

  write(): number {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, String(process.pid), { mode: 0o600 });
    return process.pid;
  }

  read(): number | null {
    try {
      const pid = Number(fs.readFileSync(this.file, 'utf8').trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  clear(): void {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* ignore */
    }
  }

  /** 已有 daemon 在运行时返回其 pid。 */
  existing(): number | null {
    const pid = this.read();
    if (!pid) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  }
}
