/**
 * Qoder 签到服务：单账号闭环 + 多账号批处理。
 *
 * 闭环：
 *   取凭据 → 取设备身份 → 查询活动 → 判断今日状态 → 领取 → 回读额度验证 → 落盘
 *
 * 幂等：
 *   1. 进程内按账号串行（inFlight）
 *   2. 本地已验证记录（同日 claimed/already 直接跳过）
 *   3. 服务端：replayed / 409 ALREADY_CLAIMED / SAME_PERSON_ALREADY_CLAIMED 均按已领取处理
 */
import { beijingDate, redactText, type Logger } from '../checkin/logger';
import type { RetryPolicy } from '../checkin/client';
import { REGIONS, clientVersion } from './config';
import { refreshTokens } from './auth';
import { claimCampaign, fetchCampaigns, fetchQuotaTotal, parseClaimResponse, quotaCooldown, type QoderApiContextWithMachine } from './api';
import { dailyWindowActive, describeCampaignRows, pickDailyCampaign } from './campaign';
import { getRiskIdentity, machineHostname, machineOs, type RiskResult } from './device';
import { accountTag, QoderStore } from './store';
import type {
  QoderAccount,
  QoderAccountView,
  QoderBatchResult,
  QoderCheckinOutcome,
  QoderCheckinRecord,
  QoderConfig,
  QoderRegion,
  QoderRiskValues,
} from './types';

export interface QoderServiceDeps {
  config: QoderConfig;
  logger: Logger;
  store: QoderStore;
  retry: RetryPolicy;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入：设备身份提供者 */
  riskProvider?: (account: QoderAccount) => Promise<RiskResult>;
}

export interface QoderCheckinOptions {
  dryRun?: boolean;
  force?: boolean;
  /** 只读模式：不查询额度 */
  skipCredits?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class QoderService {
  private readonly deps: QoderServiceDeps;
  private readonly inFlight = new Map<string, Promise<QoderCheckinRecord>>();

  constructor(deps: QoderServiceDeps) {
    this.deps = deps;
    this.deps.retry = { ...deps.retry, ...(deps.retry.sleepImpl ? {} : { sleepImpl: deps.sleep || defaultSleep }) };
  }

  get store(): QoderStore {
    return this.deps.store;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await (this.deps.sleep || defaultSleep)(ms);
  }

  /** 组装接口上下文（区域、令牌、设备身份）。 */
  private async buildContext(account: QoderAccount): Promise<{
    ctx: QoderApiContextWithMachine;
    risk: QoderRiskValues | null;
    riskError: string | null;
    exe: string | null;
  }> {
    const { config } = this.deps;
    const exe = config.clientExe[account.region] || null;
    const riskResult = this.deps.riskProvider
      ? await this.deps.riskProvider(account)
      : await getRiskIdentity({
          region: account.region,
          uid: account.uid,
          exe,
          umidPath: config.umidPath[account.region] || null,
          dataDir: config.dataDir,
        });

    if (riskResult.values) {
      // 记录设备身份（不落盘 machineToken）
      try {
        this.deps.store.patchDevice(account.id, {
          machineOs: machineOs(),
          machineHostname: machineHostname(),
          machineCode: riskResult.values.machineCode,
          machineType: riskResult.values.machineType,
          lastUmidAt: this.now(),
        });
      } catch {
        /* 记录失败不影响签到 */
      }
    }

    const ctx: QoderApiContextWithMachine = {
      region: account.region,
      tokens: account.tokens,
      uid: account.uid,
      machineId: account.device.machineId || this.deps.store.installMachineId(),
      clientVersion: clientVersion(account.region, exe),
      risk: riskResult.values,
      retry: this.deps.retry,
      timeoutMs: this.deps.config.requestTimeoutMs,
      machineOs: machineOs(),
      machineHostname: machineHostname(),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      now: () => this.now(),
    };
    return { ctx, risk: riskResult.values, riskError: riskResult.error, exe };
  }

  /** 续期并落盘；失败返回可读原因。 */
  private async refresh(account: QoderAccount): Promise<{ ok: boolean; error: string | null; refreshed: boolean }> {
    const result = await refreshTokens(account.region, account.tokens, {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      timeoutMs: this.deps.config.requestTimeoutMs,
      now: () => this.now(),
    });
    if (!result.ok) return { ok: false, error: result.error, refreshed: false };
    account.tokens = result.tokens;
    try {
      this.deps.store.updateTokens(account.id, result.tokens);
    } catch (error) {
      this.deps.logger.error(`令牌续期后保存失败：${redactText(error, 160)}`);
    }
    this.deps.logger.info(`账号 ${account.note}（${REGIONS[account.region].label}）令牌已续期`);
    return { ok: true, error: null, refreshed: true };
  }

  /** status：账号列表 + 今日状态 + 额度。 */
  async status(accounts: QoderAccount[], options: { skipCredits?: boolean } = {}): Promise<QoderAccountView[]> {
    const date = beijingDate(this.now());
    const views: QoderAccountView[] = [];
    for (const account of accounts) {
      const record = this.deps.store.getRecord(account.id, date);
      const risk = await getRiskIdentity({
        region: account.region,
        uid: account.uid,
        exe: this.deps.config.clientExe[account.region] || null,
        umidPath: this.deps.config.umidPath[account.region] || null,
        dataDir: this.deps.config.dataDir,
      });
      let credits: number | null = null;
      let creditsError: string | null = null;
      if (!options.skipCredits) {
        const { ctx } = await this.buildContext(account);
        const quota = await fetchQuotaTotal(ctx);
        credits = quota.total;
        creditsError = quota.error;
      }
      views.push({
        id: account.id,
        region: account.region,
        regionLabel: REGIONS[account.region].label,
        accountTag: accountTag(account.region, account.uid, account.tokens.access),
        note: account.note,
        uid: account.uid,
        tokenMasked: maskAccess(account.tokens.access),
        hasRefresh: !!account.tokens.refresh,
        tokenAgeSeconds: account.tokens.updatedAt ? Math.round((this.now() - account.tokens.updatedAt) / 1000) : null,
        today: {
          date,
          outcome: record ? record.outcome : null,
          ok: !!(record && record.ok && record.verified !== false),
          at: record ? new Date(record.at).toISOString() : null,
          amount: record ? record.claimedAmount ?? record.campaignAmount : null,
          source: record ? 'local-record' : 'none',
        },
        device: {
          machineId: account.device.machineId,
          machineOs: account.device.machineOs || machineOs(),
          umidAvailable: !!risk.values,
          umidPath: risk.component.path,
          umidError: risk.error,
        },
        credits,
        creditsError,
      });
    }
    return views;
  }

  /** 单账号签到（并发时复用同一任务）。 */
  async checkin(account: QoderAccount, options: QoderCheckinOptions = {}): Promise<QoderCheckinRecord> {
    const existing = this.inFlight.get(account.id);
    if (existing) {
      this.deps.logger.warn(`账号 ${account.note} 已有进行中的签到任务，复用该任务`);
      return existing;
    }
    const task = this.runCheckin(account, options).finally(() => this.inFlight.delete(account.id));
    this.inFlight.set(account.id, task);
    return task;
  }

  private async runCheckin(account: QoderAccount, options: QoderCheckinOptions): Promise<QoderCheckinRecord> {
    const startedAt = this.now();
    const date = beijingDate(startedAt);
    const tag = accountTag(account.region, account.uid, account.tokens.access);

    const finish = (partial: Partial<QoderCheckinRecord> & { outcome: QoderCheckinOutcome; ok: boolean }): QoderCheckinRecord => {
      const record: QoderCheckinRecord = {
        accountId: account.id,
        region: account.region,
        date,
        outcome: partial.outcome,
        ok: partial.ok,
        campaignId: partial.campaignId ?? null,
        campaignAmount: partial.campaignAmount ?? null,
        claimedAmount: partial.claimedAmount ?? null,
        creditsBefore: partial.creditsBefore ?? null,
        creditsAfter: partial.creditsAfter ?? null,
        creditsDelta: partial.creditsDelta ?? null,
        verified: partial.verified ?? false,
        verification: partial.verification ?? 'none',
        message: partial.message ?? '',
        at: this.now(),
        durationMs: this.now() - startedAt,
        dryRun: !!options.dryRun,
        accountTag: tag,
        note: account.note,
        ...(partial.diagnostic ? { diagnostic: redactText(partial.diagnostic, 300) } : {}),
        ...(partial.tokenRefreshed ? { tokenRefreshed: true } : {}),
      };
      this.deps.logger.event('qoder.checkin', {
        date: record.date,
        account: record.accountTag,
        region: record.region,
        note: record.note,
        outcome: record.outcome,
        ok: record.ok,
        campaignId: record.campaignId,
        amount: record.claimedAmount ?? record.campaignAmount,
        creditsBefore: record.creditsBefore,
        creditsAfter: record.creditsAfter,
        creditsDelta: record.creditsDelta,
        verified: record.verified,
        verification: record.verification,
        durationMs: record.durationMs,
        tokenRefreshed: record.tokenRefreshed === true,
        diagnostic: record.diagnostic ?? null,
      });
      try {
        this.deps.store.saveRecord(record);
      } catch (error) {
        this.deps.logger.error(`写入 Qoder 签到记录失败：${redactText(error, 160)}`);
      }
      return record;
    };

    // 1) 本地已验证记录
    if (!options.force && this.deps.store.hasConfirmed(account.id, date)) {
      const previous = this.deps.store.getRecord(account.id, date);
      this.deps.logger.info(`账号 ${account.note} 今日已确认完成，跳过所有请求`);
      return finish({
        outcome: 'skipped',
        ok: true,
        campaignId: previous?.campaignId ?? null,
        campaignAmount: previous?.campaignAmount ?? null,
        claimedAmount: previous?.claimedAmount ?? null,
        message: previous?.message || '本地记录显示今日已完成',
        verified: true,
        verification: 'local-record',
      });
    }

    // 2) 设备身份 + 接口上下文
    const { ctx, riskError } = await this.buildContext(account);

    // 3) 领取前额度（只读，失败不阻塞）
    let creditsBefore: number | null = null;
    if (!options.skipCredits) {
      const before = await fetchQuotaTotal(ctx);
      creditsBefore = before.total;
      if (before.error) this.deps.logger.warn(`账号 ${account.note} 签到前额度查询失败：${before.error}`);
    }

    // 4) 查询活动（会话失效时续期一次再试）
    let campaign = await fetchCampaigns(ctx);
    let tokenRefreshed = false;
    // 只有「真正会话失效」才续期：额度类 403（112/110）同码不同因，不能续期，
    // 否则会白白轮换 refresh token。
    const authDeadSignal = campaign.quotaKind === ''
      && (campaign.httpStatus === 401 || campaign.httpStatus === 403 || /105|10019901001/.test(campaign.error || ''));
    if (!campaign.ok && authDeadSignal) {
      const refreshed = await this.refresh(account);
      if (refreshed.ok) {
        tokenRefreshed = true;
        ctx.tokens = account.tokens;
        campaign = await fetchCampaigns(ctx);
      } else if (refreshed.error) {
        return finish({
          outcome: 'unauthorized',
          ok: false,
          creditsBefore,
          message: '登录状态失效',
          diagnostic: `${refreshed.error}${riskError ? `；设备身份：${riskError}` : ''}`,
        });
      }
    }

    if (campaign.quotaKind) {
      return finish({
        outcome: 'quota-exhausted',
        ok: false,
        creditsBefore,
        message: campaign.error || '额度类 403',
        diagnostic: `quotaKind=${campaign.quotaKind}, cooldown=${campaign.quotaSeconds}s`,
        ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
      });
    }

    if (!campaign.ok) {
      const unauthorized = campaign.httpStatus === 401 || campaign.httpStatus === 403;
      return finish({
        outcome: unauthorized ? 'unauthorized' : 'error',
        ok: false,
        creditsBefore,
        message: campaign.error || `活动查询失败（HTTP ${campaign.httpStatus}）`,
        diagnostic: [
          riskError ? `设备身份不可用：${riskError}` : null,
          campaign.minimalFallbackUsed ? '已尝试国内版最小头复取' : null,
          campaign.rows.length ? `活动行：${JSON.stringify(describeCampaignRows(campaign.rows))}` : null,
        ]
          .filter(Boolean)
          .join('；'),
        ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
      });
    }

    // 5) 判断今日状态
    let pick = pickDailyCampaign(campaign.rows);
    if (!pick.target && !pick.claimed && this.shouldWindowRetry(options)) {
      this.deps.logger.info(`账号 ${account.note} 处于 10 点窗口但未下发活动，按配置有限次重试`);
      const { max, gapMs } = this.deps.config.windowRetry;
      for (let attempt = 1; attempt <= max; attempt++) {
        if (!dailyWindowActive(this.now(), this.deps.config.timezone)) break;
        await this.sleep(gapMs);
        campaign = await fetchCampaigns(ctx);
        pick = pickDailyCampaign(campaign.rows);
        if (pick.target || pick.claimed) break;
        this.deps.logger.event('qoder.window-retry', { account: tag, attempt, rows: campaign.rows.length });
      }
    }

    if (!pick.target) {
      if (pick.claimed) {
        return finish({
          outcome: 'already',
          ok: true,
          message: '今日已领取',
          verified: true,
          verification: 'server-status',
          creditsBefore,
          ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
        });
      }
      const riskHint = riskError
        ? `设备身份不可用：${riskError}`
        : `未发现可领取的每日活动（官方窗口每天 10:00 北京时间开启；若已在客户端领过，活动行会消失）`;
      return finish({
        outcome: 'no-campaign',
        ok: false,
        creditsBefore,
        message: riskHint,
        diagnostic: [
          `活动行 ${campaign.rows.length} 条`,
          pick.proSkipped ? `跳过 Pro 行 ${pick.proSkipped} 条` : null,
          campaign.rows.length ? JSON.stringify(describeCampaignRows(campaign.rows)) : null,
        ]
          .filter(Boolean)
          .join('；'),
        ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
      });
    }

    // 6) 模拟执行
    if (options.dryRun) {
      return finish({
        outcome: 'dry-run',
        ok: false,
        campaignId: pick.target.campaignId,
        campaignAmount: pick.target.benefitAmount,
        creditsBefore,
        message: `模拟：发现可领取活动（${pick.target.benefitKind} ${pick.target.benefitAmount}）`,
        diagnostic: 'dry-run 未调用领取接口',
      });
    }

    // 7) 领取
    const claim = await claimCampaign(ctx, pick.target.campaignId);
    if (claim.verdict === 'already') {
      return finish({
        outcome: 'already',
        ok: true,
        campaignId: pick.target.campaignId,
        campaignAmount: pick.target.benefitAmount,
        message: claim.message,
        verified: true,
        verification: 'server-status',
        creditsBefore,
        ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
      });
    }
    if (claim.verdict === 'blocked') {
      return finish({
        outcome: 'blocked',
        ok: false,
        campaignId: pick.target.campaignId,
        campaignAmount: pick.target.benefitAmount,
        creditsBefore,
        message: claim.message,
        diagnostic: `status=${claim.status}, failureCode=${claim.failureCode}`,
        ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
      });
    }
    if (claim.verdict !== 'claimed') {
      return finish({
        outcome: claim.httpStatus === 401 || claim.httpStatus === 403 ? 'unauthorized' : 'unsupported',
        ok: false,
        campaignId: pick.target.campaignId,
        campaignAmount: pick.target.benefitAmount,
        creditsBefore,
        message: claim.message,
        diagnostic: [`HTTP ${claim.httpStatus}`, `status=${claim.status}`, `failureCode=${claim.failureCode}`, claim.transportError || '']
          .filter(Boolean)
          .join('；'),
        ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
      });
    }

    // 8) 回读额度验证
    let creditsAfter: number | null = null;
    let delta: number | null = null;
    if (!options.skipCredits) {
      await this.sleep(this.deps.config.verifyDelayMs);
      const after = await fetchQuotaTotal(ctx);
      creditsAfter = after.total;
      if (creditsBefore !== null && creditsAfter !== null) {
        delta = Math.round((creditsAfter - creditsBefore) * 100) / 100;
      }
    }

    const amount = claim.amount > 0 ? claim.amount : pick.target.benefitAmount;
    let verification: QoderCheckinRecord['verification'] = 'server-status';
    let diagnostic = '服务端返回 CLAIMED，额度回读不可用';
    if (delta !== null && delta > 0) {
      verification = 'quota-delta';
      diagnostic = `额度已增加 ${delta}`;
    } else if (delta === 0) {
      diagnostic = '服务端返回 CLAIMED，但额度差额为 0（可能异步入账或计入其它资源包）';
    }

    return finish({
      outcome: 'claimed',
      ok: true,
      campaignId: pick.target.campaignId,
      campaignAmount: pick.target.benefitAmount,
      claimedAmount: amount > 0 ? amount : null,
      creditsBefore,
      creditsAfter,
      creditsDelta: delta,
      verified: true,
      verification,
      message: claim.message,
      diagnostic,
      ...(tokenRefreshed ? { tokenRefreshed: true } : {}),
    });
  }

  /** 是否应触发 10 点窗口重试。 */
  private shouldWindowRetry(options: QoderCheckinOptions): boolean {
    if (options.dryRun) return false;
    if (!this.deps.config.windowRetry.enabled) return false;
    return dailyWindowActive(this.now(), this.deps.config.timezone);
  }

  /** 多账号批量（单账号失败不影响其它账号）。 */
  async checkinAll(accounts: QoderAccount[], options: QoderCheckinOptions = {}): Promise<QoderBatchResult> {
    const startedAt = this.now();
    const date = beijingDate(startedAt);
    const records: QoderCheckinRecord[] = [];
    if (!accounts.length) {
      return {
        date,
        startedAt,
        finishedAt: this.now(),
        records,
        summary: { total: 0, claimed: 0, already: 0, skipped: 0, dryRun: 0, noCampaign: 0, failed: 0 },
      };
    }
    this.deps.logger.event('qoder.batch.start', { date, accounts: accounts.length, dryRun: !!options.dryRun });

    for (const account of accounts) {
      try {
        records.push(await this.checkin(account, options));
      } catch (error) {
        const message = redactText(error, 240);
        this.deps.logger.error(`账号 ${account.note} 签到异常：${message}`);
        const record: QoderCheckinRecord = {
          accountId: account.id,
          region: account.region,
          date,
          outcome: 'error',
          ok: false,
          campaignId: null,
          campaignAmount: null,
          claimedAmount: null,
          creditsBefore: null,
          creditsAfter: null,
          creditsDelta: null,
          verified: false,
          verification: 'none',
          message: '签到流程异常',
          at: this.now(),
          durationMs: 0,
          dryRun: !!options.dryRun,
          accountTag: accountTag(account.region, account.uid, account.tokens.access),
          note: account.note,
          diagnostic: message,
        };
        try {
          this.deps.store.saveRecord(record);
        } catch {
          /* 已尽力 */
        }
        this.deps.logger.event('qoder.checkin', { account: record.accountTag, outcome: 'error', diagnostic: message });
        records.push(record);
      }
    }

    const summary = {
      total: records.length,
      claimed: records.filter((r) => r.outcome === 'claimed').length,
      already: records.filter((r) => r.outcome === 'already').length,
      skipped: records.filter((r) => r.outcome === 'skipped').length,
      dryRun: records.filter((r) => r.outcome === 'dry-run').length,
      noCampaign: records.filter((r) => r.outcome === 'no-campaign').length,
      failed: records.filter((r) => !r.ok && r.outcome !== 'dry-run' && r.outcome !== 'skipped' && r.outcome !== 'no-campaign').length,
    };
    const result: QoderBatchResult = { date, startedAt, finishedAt: this.now(), records, summary };
    this.deps.logger.event('qoder.batch.finish', { date, ...summary });
    return result;
  }

  /** 定向续期（CLI `qoder:refresh` 用）。 */
  async refreshAccount(account: QoderAccount): Promise<{ ok: boolean; error: string | null }> {
    const result = await this.refresh(account);
    return { ok: result.ok, error: result.error };
  }
}

/** 令牌脱敏（只保留前缀与末 4 位）。 */
function maskAccess(token: string): string {
  const value = String(token || '');
  if (!value) return '—';
  return value.length <= 12 ? `${value.slice(0, 3)}****` : `${value.slice(0, 6)}****${value.slice(-4)}`;
}

export type { QoderRegion };
