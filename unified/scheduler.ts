/**
 * 统一调度：一个进程按北京时间每天 10:05 依次触发三个平台。
 *
 * 与各平台自带 daemon 的关系：
 * - 三者**只能跑一个**。统一调度已覆盖全部平台，若同时再开平台 daemon，
 *   会出现同一天两轮执行（幂等能防重复领取，但会多打一倍请求）。
 *   因此启动前会检查平台 pid 文件并拒绝启动。
 * - 各平台 daemon 仍然保留，适合"只想跑某一个平台"的场景。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beijingDate, localIso, type Logger } from '../checkin/logger';
import { nextSlotAt, zonedParts, zonedTimeToUtc } from '../checkin/scheduler';
import { runAll } from './runner';
import type { PlatformAdapter, UnifiedResult } from './types';

export interface UnifiedSchedulerOptions {
  adapters: PlatformAdapter[];
  logger: Logger;
  timezone: string;
  checkTimes: string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onResult?: (result: UnifiedResult) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class UnifiedScheduler {
  private readonly options: UnifiedSchedulerOptions;
  private stopped = false;
  private lastRunDate: string | null = null;

  constructor(options: UnifiedSchedulerOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    await (this.options.sleep || realSleep)(ms);
  }

  stop(): void {
    this.stopped = true;
  }

  /** 所有"有账号的"平台今日是否都已完成。没有账号的平台不参与判断。 */
  allDone(date: string): boolean {
    const active = this.options.adapters.filter((adapter) => adapter.hasAccounts());
    if (!active.length) return false;
    return active.every((adapter) => adapter.doneToday(date));
  }

  /** 执行一轮：依次跑所有平台。 */
  async runOnce(options: { dryRun?: boolean; force?: boolean; timeoutMs?: number } = {}): Promise<UnifiedResult> {
    const { logger, adapters } = this.options;
    const startedAt = this.now();
    logger.event('unified.run.start', {
      at: localIso(startedAt),
      date: beijingDate(startedAt),
      platforms: adapters.map((adapter) => adapter.meta.id),
      dryRun: !!options.dryRun,
    });

    const result = await runAll(adapters, {
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      onStart: (meta) => logger.event('unified.platform.start', { platform: meta.id, label: meta.label }),
      onFinish: (outcome) =>
        logger.event('unified.platform.finish', {
          platform: outcome.platform,
          status: outcome.status,
          accounts: outcome.accounts,
          claimed: outcome.claimed,
          already: outcome.already,
          skipped: outcome.skipped,
          failed: outcome.failed,
          durationMs: outcome.durationMs,
          detail: outcome.detail,
          error: outcome.error ?? null,
        }),
    });

    logger.event('unified.run.finish', { date: result.date, ...result.summary, durationMs: result.finishedAt - result.startedAt });
    this.options.onResult?.(result);
    return result;
  }

  /** 当天已过检查时间但仍有平台未完成 → 启动时补一次。 */
  shouldCatchUp(): boolean {
    const now = this.now();
    const zoned = zonedParts(this.options.timezone, now);
    const slots = this.options.checkTimes
      .map((item) => /^(\d{1,2}):(\d{2})$/.exec(item))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => zonedTimeToUtc(this.options.timezone, zoned.year, zoned.month, zoned.day, Number(match[1]), Number(match[2])));
    if (!slots.length || now < Math.min(...slots)) return false;
    return !this.allDone(beijingDate(now));
  }

  /** 常驻循环。 */
  async runForever(options: { dryRun?: boolean } = {}): Promise<void> {
    const { logger } = this.options;
    logger.event('unified.scheduler.start', {
      timezone: this.options.timezone,
      checkTimes: this.options.checkTimes,
      platforms: this.options.adapters.map((adapter) => adapter.meta.id),
      pid: process.pid,
    });

    if (this.shouldCatchUp()) {
      logger.info('今天仍有平台未完成，立即补执行一次');
      await this.runOnce(options);
      this.lastRunDate = beijingDate(this.now());
    }

    while (!this.stopped) {
      const now = this.now();
      const next = nextSlotAt(now, this.options.checkTimes, this.options.timezone);
      logger.event('unified.scheduler.wait', {
        now: localIso(now),
        nextAt: localIso(next),
        waitSeconds: Math.round(Math.max(0, next - now) / 1000),
      });
      await this.sleep(Math.max(1000, next - now));
      if (this.stopped) break;

      const today = beijingDate(this.now());
      if (this.lastRunDate === today && this.allDone(today)) {
        logger.info('今日所有平台已完成，跳过本轮');
        continue;
      }
      await this.runOnce(options);
      this.lastRunDate = beijingDate(this.now());
    }
    logger.event('unified.scheduler.stop', { at: localIso(this.now()) });
  }
}

/** 统一后台服务的 pid 文件（与平台 daemon 的文件名区分开）。 */
export class UnifiedPidFile {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'unified-daemon.pid');
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

  clear(): void {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* ignore */
    }
  }
}

/** 读取某个 pid 文件并判断进程是否存活（用于检测平台 daemon 是否在跑）。 */
export function readLivePid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}
