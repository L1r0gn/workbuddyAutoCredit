/**
 * 平台适配器：把三个签到模块包装成统一接口。
 *
 * 关键点：适配器**不复制**任何平台逻辑，只调用各模块自己的 `Scheduler.runOnce()`，
 * 因此：
 * - WorkBuddy 的 CDP 诊断、客户端拉起、多域名兜底、幂等三层，行为完全不变；
 * - Qoder 的 10 点窗口重试、额度回读、区域隔离，行为完全不变；
 * - 编排层只做"顺序、隔离、超时、汇总"。
 */
import { beijingDate } from '../checkin/logger';
import { Scheduler as WorkBuddyScheduler } from '../checkin/scheduler';
import type { BatchResult as WorkBuddyBatch } from '../checkin/types';
import type { Runtime as WorkBuddyRuntime } from '../checkin/index';
import { QoderScheduler } from '../qoder/scheduler';
import type { QoderRuntime } from '../qoder/index';
import type { QoderBatchResult, QoderRegion } from '../qoder/types';
import type { PlatformAdapter, PlatformId, PlatformOutcome, PlatformStatus } from './types';

const LABELS: Record<PlatformId, string> = {
  workbuddy: 'WorkBuddy（国内版 + AI 国际版）',
  'qoder-cn': 'Qoder CN 国内版',
  'qoder-global': 'Qoder 国际版',
};

const HINTS: Record<PlatformId, string> = {
  workbuddy: '读取本机客户端登录态，调用官方签到接口',
  'qoder-cn': '设备码登录态 + 官方 UMID 身份，领取每日活动',
  'qoder-global': '设备码登录态 + 官方 UMID 身份，领取每日活动',
};

function settle(complete: number, failed: number, total: number, noRunDetail: string | null): PlatformStatus {
  if (total === 0) return 'norun';
  if (failed === 0) return complete > 0 ? 'ok' : 'skipped';
  if (complete === 0) return 'failed';
  return 'partial';
}

/** WorkBuddy 适配器：一个任务覆盖国内版与 AI 国际版两个 profile。 */
export function createWorkBuddyAdapter(runtime: WorkBuddyRuntime): PlatformAdapter {
  // 复用平台自己的调度器：它的 runOnce 内部已包含客户端探测、退避重试与账号级幂等
  const scheduler = new WorkBuddyScheduler({
    config: runtime.config,
    logger: runtime.logger,
    service: runtime.service,
    accounts: () => runtime.accounts(),
  });

  return {
    meta: { id: 'workbuddy', label: LABELS.workbuddy, hint: HINTS.workbuddy },

    hasAccounts(): boolean {
      return runtime.accounts().some((account) => !!account.uid && !!account.credentials);
    },

    doneToday(date: string): boolean {
      const usable = runtime.accounts().filter((account) => !!account.uid && !!account.credentials);
      if (!usable.length) return false;
      return usable.every((account) => runtime.store.hasConfirmedSuccess(account.uid, date));
    },

    async run(options): Promise<PlatformOutcome> {
      const startedAt = Date.now();
      const result: WorkBuddyBatch = await scheduler.runOnce({
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.force ? { force: true } : {}),
      });
      const summary = result.summary;
      const complete = summary.checkedIn + summary.already + summary.skipped;
      const total = summary.total;
      const failed = summary.failed;
      const status = settle(complete, failed, total, null);
      const unavailable = result.records.filter((record) => record.outcome === 'unauthenticated').length;
      const parts: string[] = [];
      if (unavailable) parts.push(`不可用 ${unavailable}（未登录或未安装对应客户端）`);
      if (summary.checkedIn) parts.push(`新领取 ${summary.checkedIn}`);
      if (summary.already) parts.push(`已领取 ${summary.already}`);
      if (summary.skipped) parts.push(`跳过 ${summary.skipped}`);
      if (summary.dryRun) parts.push(`模拟 ${summary.dryRun}`);
      if (failed) parts.push(`失败 ${failed}`);

      return {
        platform: 'workbuddy',
        label: LABELS.workbuddy,
        status,
        accounts: total,
        claimed: summary.checkedIn,
        already: summary.already,
        skipped: summary.skipped,
        dryRun: summary.dryRun,
        failed,
        ...(unavailable ? { unavailable } : {}),
        durationMs: Date.now() - startedAt,
        detail: total === 0 ? '没有可用的 WorkBuddy 账号' : parts.join('，'),
        records: result.records,
      };
    },
  };
}

/** Qoder 适配器：按区域各自独立（凭据、设备身份、接口域名均不同）。 */
export function createQoderAdapter(runtime: QoderRuntime, region: QoderRegion): PlatformAdapter {
  const platform: PlatformId = region === 'cn' ? 'qoder-cn' : 'qoder-global';
  const accountsOfRegion = () => runtime.accounts().filter((account) => account.region === region);

  const scheduler = new QoderScheduler({
    config: runtime.config,
    logger: runtime.logger,
    service: runtime.service,
    accounts: accountsOfRegion,
  });

  return {
    meta: { id: platform, label: LABELS[platform], hint: HINTS[platform] },

    hasAccounts(): boolean {
      return accountsOfRegion().some((account) => !!account.tokens.access);
    },

    doneToday(date: string): boolean {
      const accounts = accountsOfRegion().filter((account) => !!account.tokens.access);
      if (!accounts.length) return false;
      return accounts.every((account) => runtime.store.hasConfirmed(account.id, date));
    },

    async run(options): Promise<PlatformOutcome> {
      const startedAt = Date.now();
      const result: QoderBatchResult = await scheduler.runOnce({
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.force ? { force: true } : {}),
      });
      const summary = result.summary;
      const complete = summary.claimed + summary.already + summary.skipped;
      const total = summary.total;
      const failed = summary.failed;
      // 无活动（窗口未开/已领过/缺设备身份）不算硬失败，但也无法确认今日到账
      const unresolved = summary.noCampaign;
      let status: PlatformStatus;
      if (total === 0) status = 'norun';
      else if (failed === 0 && unresolved === 0) status = complete > 0 ? 'ok' : 'skipped';
      else if (failed + unresolved >= total && complete === 0) status = failed > 0 ? 'failed' : 'partial';
      else status = 'partial';

      const unavailable = result.records.filter((record) => record.outcome === 'unauthorized').length;
      const parts: string[] = [];
      if (unavailable) parts.push(`不可用 ${unavailable}（登录失效且无法续期）`);
      if (summary.claimed) parts.push(`新领取 ${summary.claimed}`);
      if (summary.already) parts.push(`已领取 ${summary.already}`);
      if (summary.skipped) parts.push(`跳过 ${summary.skipped}`);
      if (summary.noCampaign) parts.push(`无活动 ${summary.noCampaign}`);
      if (summary.dryRun) parts.push(`模拟 ${summary.dryRun}`);
      if (failed) parts.push(`失败 ${failed}`);

      return {
        platform,
        label: LABELS[platform],
        status,
        accounts: total,
        claimed: summary.claimed,
        already: summary.already,
        skipped: summary.skipped,
        dryRun: summary.dryRun,
        failed,
        ...(unavailable ? { unavailable } : {}),
        durationMs: Date.now() - startedAt,
        detail: total === 0 ? `没有 ${LABELS[platform]} 账号` : parts.join('，'),
        records: result.records,
      };
    },
  };
}

/** 三个适配器，顺序即执行顺序（先本地、后 Qoder；国内版先于国际版）。 */
export function createAllAdapters(input: {
  workbuddy: WorkBuddyRuntime;
  qoder: QoderRuntime;
  platforms?: PlatformId[];
}): PlatformAdapter[] {
  const adapters: PlatformAdapter[] = [
    createWorkBuddyAdapter(input.workbuddy),
    createQoderAdapter(input.qoder, 'cn'),
    createQoderAdapter(input.qoder, 'global'),
  ];
  if (!input.platforms || !input.platforms.length) return adapters;
  return adapters.filter((adapter) => input.platforms?.includes(adapter.meta.id));
}

/** 今日日期（北京时间），供 CLI 与调度共用。 */
export function todayString(now = Date.now()): string {
  return beijingDate(now);
}
