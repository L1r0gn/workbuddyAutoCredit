/**
 * 编排执行器：依次触发各平台，单平台失败/超时不影响其它平台。
 *
 * 为什么是串行：
 * - 三个平台都会发真实请求，串行便于日志阅读与限速（避免同一瞬间打三个域）；
 * - Qoder 的 10 点窗口重试可能持续数分钟，并行收益不大；
 * - 单个平台内部的账号遍历本来就是串行的。
 *
 * 隔离手段：
 * - 每个平台独立 try/catch + 独立超时；
 * - 超时只上报结果，不强杀正在进行的 HTTP（Node 无法安全中断 fetch），
 *   但该平台的迟到结果会被丢弃，不会污染其它平台的汇总。
 */
import { beijingDate } from '../checkin/logger';
import type { PlatformAdapter, PlatformOutcome, RunAllOptions, UnifiedResult } from './types';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    // 注意：这里**不能** unref。超时必须能独立触发，
    // 否则当被等待的 Promise 不产生任何 I/O 时，事件循环会先空闲退出，超时永不生效。
    const timer = setTimeout(() => reject(new Error(`${label} 执行超时（${Math.round(ms / 1000)} 秒）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function errorOutcome(adapter: PlatformAdapter, error: unknown, durationMs: number): PlatformOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    platform: adapter.meta.id,
    label: adapter.meta.label,
    status: 'error',
    accounts: 0,
    claimed: 0,
    already: 0,
    skipped: 0,
    dryRun: 0,
    failed: 0,
    durationMs,
    detail: '执行异常，已跳过该平台',
    error: message,
  };
}

/** 汇总：把多个平台结果压成一份总账。 */
export function summarize(date: string, startedAt: number, dryRun: boolean, outcomes: PlatformOutcome[], finishedAt: number): UnifiedResult {
  const count = (status: PlatformOutcome['status']): number => outcomes.filter((item) => item.status === status).length;
  return {
    date,
    startedAt,
    finishedAt,
    dryRun,
    outcomes,
    summary: {
      platforms: outcomes.length,
      ok: count('ok'),
      partial: count('partial'),
      failed: count('failed'),
      skipped: count('skipped'),
      norun: count('norun'),
      error: count('error'),
      accounts: outcomes.reduce((sum, item) => sum + item.accounts, 0),
      claimed: outcomes.reduce((sum, item) => sum + item.claimed, 0),
      already: outcomes.reduce((sum, item) => sum + item.already, 0),
      skippedAccounts: outcomes.reduce((sum, item) => sum + item.skipped, 0),
      failedAccounts: outcomes.reduce((sum, item) => sum + item.failed, 0),
      unavailableAccounts: outcomes.reduce((sum, item) => sum + (item.unavailable ?? 0), 0),
    },
  };
}

/**
 * 执行全部平台。
 * @param adapters 已按执行顺序排好
 */
export async function runAll(adapters: PlatformAdapter[], options: RunAllOptions = {}): Promise<UnifiedResult> {
  const startedAt = Date.now();
  const date = beijingDate(startedAt);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dryRun = !!options.dryRun;
  const only = options.only && options.only.length ? new Set(options.only) : null;
  const selected = only ? adapters.filter((adapter) => only.has(adapter.meta.id)) : adapters;
  const outcomes: PlatformOutcome[] = [];

  for (const adapter of selected) {
    const platformStartedAt = Date.now();
    options.onStart?.(adapter.meta);

    // 今日已完成就整平台跳过（dry-run 与 force 除外：前者要看到"将会做什么"，后者要强制复核）
    if (!dryRun && !options.force) {
      let done = false;
      try {
        done = adapter.doneToday(date);
      } catch {
        done = false;
      }
      if (done) {
        const skipped: PlatformOutcome = {
          platform: adapter.meta.id,
          label: adapter.meta.label,
          status: 'skipped',
          accounts: 0,
          claimed: 0,
          already: 0,
          skipped: 0,
          dryRun: 0,
          failed: 0,
          durationMs: Date.now() - platformStartedAt,
          detail: '今日已全部完成，跳过',
        };
        outcomes.push(skipped);
        options.onFinish?.(skipped);
        continue;
      }
    }

    let outcome: PlatformOutcome;
    try {
      outcome = await timeout(
        adapter.run({
          ...(dryRun ? { dryRun: true } : {}),
          ...(options.force ? { force: true } : {}),
        }),
        timeoutMs,
        adapter.meta.label,
      );
    } catch (error) {
      outcome = errorOutcome(adapter, error, Date.now() - platformStartedAt);
    }
    outcomes.push(outcome);
    options.onFinish?.(outcome);
  }

  return summarize(date, startedAt, dryRun, outcomes, Date.now());
}

/**
 * 退出码约定：
 * 0 全部完成（含"今日已领取"/"跳过"）
 * 1 有平台部分失败
 * 2 有平台整体失败或编排异常
 * 3 有平台没有可用账号（配置问题，但不影响其它平台）
 */
export function exitCodeFor(result: UnifiedResult): number {
  const { summary } = result;
  if (summary.failed > 0 || summary.error > 0) return 2;
  if (summary.partial > 0) return 1;
  if (summary.norun > 0) return 3;
  return 0;
}
