/**
 * Qoder 定时调度。
 *
 * 与 WorkBuddy 模块共用同一套时区计算工具（`nextSlotAt` / `zonedParts`），
 * 但调度语义独立：Qoder 活动每天北京时间 10:00 开窗，可能延迟下发，
 * 因此「到点执行 + 窗口内有限次重试」放在 service 里，调度层只负责按时触发。
 *
 * 行为：
 * - 默认每天 10:05 检查（可配多个时间点）。
 * - 启动时若已过当天检查时间且仍有账号未完成 → 立即补一次。
 * - 全部账号今日已确认 → 该时间点不再发网络请求。
 * - 一个账号失败不影响其它账号（service 内部逐个隔离）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beijingDate, localIso, redactText, type Logger } from '../checkin/logger';
import { nextSlotAt, zonedParts, zonedTimeToUtc } from '../checkin/scheduler';
import type { QoderAccount, QoderBatchResult, QoderConfig } from './types';
import type { QoderService } from './service';

export interface QoderSchedulerOptions {
  config: QoderConfig;
  logger: Logger;
  service: QoderService;
  /** 每次运行重新加载账号（环境变量可能变化） */
  accounts: () => QoderAccount[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onBatch?: (result: QoderBatchResult) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class QoderScheduler {
  private readonly options: QoderSchedulerOptions;
  private stopped = false;
  private lastRunDate: string | null = null;

  constructor(options: QoderSchedulerOptions) {
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

  /** 今日是否所有账号都已完成（只统计有凭据的账号）。 */
  private allDone(date: string): boolean {
    const accounts = this.options.accounts().filter((account) => !!account.tokens.access);
    if (!accounts.length) return false;
    return accounts.every((account) => this.options.service.store.hasConfirmed(account.id, date));
  }

  /** 当天已过检查时间但仍有账号未完成。 */
  private shouldCatchUp(): boolean {
    const now = this.now();
    const { config } = this.options;
    const zoned = zonedParts(config.timezone, now);
    const slots = config.checkTimes
      .map((t) => /^(\d{1,2}):(\d{2})$/.exec(t))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => zonedTimeToUtc(config.timezone, zoned.year, zoned.month, zoned.day, Number(m[1]), Number(m[2])));
    if (!slots.length || now < Math.min(...slots)) return false;
    return !this.allDone(beijingDate(now));
  }

  /** 执行一轮（不重试：窗口重试由 service 负责）。 */
  async runOnce(options: { dryRun?: boolean; force?: boolean } = {}): Promise<QoderBatchResult> {
    const { logger, service } = this.options;
    const startedAt = this.now();
    const accounts = this.options.accounts();
    logger.event('qoder.run.start', {
      at: localIso(startedAt),
      date: beijingDate(startedAt),
      accounts: accounts.length,
      dryRun: !!options.dryRun,
    });
    if (!accounts.length) {
      logger.warn('没有可用的 Qoder 账号：请先执行 qoder:login，或配置 QODER_TOKENS / QODER_GLOBAL_TOKENS');
      return {
        date: beijingDate(startedAt),
        startedAt,
        finishedAt: this.now(),
        records: [],
        summary: { total: 0, claimed: 0, already: 0, skipped: 0, dryRun: 0, noCampaign: 0, failed: 0 },
      };
    }
    const result = await service.checkinAll(accounts, {
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(options.force ? { force: true } : {}),
    });
    this.options.onBatch?.(result);
    return result;
  }

  /** 常驻循环。 */
  async runForever(options: { dryRun?: boolean } = {}): Promise<void> {
    const { config, logger } = this.options;
    logger.event('qoder.scheduler.start', {
      timezone: config.timezone,
      checkTimes: config.checkTimes,
      regions: config.regions,
      windowRetry: config.windowRetry,
      pid: process.pid,
    });

    if (this.shouldCatchUp()) {
      logger.info('今天尚未完成 Qoder 签到，立即补执行一次');
      await this.runOnce(options);
      this.lastRunDate = beijingDate(this.now());
    }

    while (!this.stopped) {
      const now = this.now();
      const next = nextSlotAt(now, config.checkTimes, config.timezone);
      logger.event('qoder.scheduler.wait', {
        now: localIso(now),
        nextAt: localIso(next),
        waitSeconds: Math.round(Math.max(0, next - now) / 1000),
      });
      await this.sleep(Math.max(1000, next - now));
      if (this.stopped) break;
      const today = beijingDate(this.now());
      if (this.lastRunDate === today && this.allDone(today)) {
        logger.info('今日已全部完成，跳过本轮');
        continue;
      }
      await this.runOnce(options);
      this.lastRunDate = beijingDate(this.now());
    }
    logger.event('qoder.scheduler.stop', { at: localIso(this.now()) });
  }
}

/** Qoder 后台服务的 pid 文件。 */
export class QoderPidFile {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'qoder-daemon.pid');
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

/** 供日志复用的错误裁剪。 */
export function describeError(error: unknown): string {
  return redactText(error, 240);
}
