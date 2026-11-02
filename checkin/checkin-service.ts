/**
 * 签到服务：实现完整闭环
 *   读取登录态 → 查询当日领取状态 → 执行领取 → 验证到账 → 缓存结果
 *
 * 幂等保护（三层）：
 *   1. 进程内同一 uid 串行化（inFlight Map）。
 *   2. 本地已验证记录：同日已成功则不再发任何领取请求。
 *   3. 服务端按天去重：即使并发/重试，重复请求只会返回 code=10001「已签到」。
 */
import { isTokenUsable, refreshCredentials } from './auth-manager';
import { PROFILES } from './config';
import { claimDailyCheckin, fetchCredits, type CheckinClassification, type CreditResult } from './credit-api';
import type { RetryPolicy } from './client';
import { beijingDate, type Logger, redactText } from './logger';
import type { StateStore } from './state-store';
import type {
  AccountContext,
  AccountStatusView,
  BatchResult,
  CheckinConfig,
  CheckinOutcome,
  CheckinRecord,
} from './types';

export interface ServiceDeps {
  config: CheckinConfig;
  logger: Logger;
  store: StateStore;
  retry: RetryPolicy;
  fetchImpl?: typeof fetch;
  /** 测试注入：可控时钟 */
  now?: () => number;
  /** 测试注入：跳过真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckinOptions {
  dryRun?: boolean;
  /** 忽略本地成功记录，强制走一次领取流程（仍受服务端去重保护） */
  force?: boolean;
  /** 只读模式：不查询积分 */
  skipCredits?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function outcomeFromClassification(classification: CheckinClassification): CheckinOutcome {
  switch (classification.verdict) {
    case 'success':
      return 'checked-in';
    case 'already':
      return 'already';
    case 'inactive':
      return 'inactive';
    case 'unauthorized':
      return 'unauthenticated';
    default:
      return 'unsupported';
  }
}

export class CheckinService {
  private readonly deps: ServiceDeps;
  private readonly inFlight = new Map<string, Promise<CheckinRecord>>();

  constructor(deps: ServiceDeps) {
    this.deps = deps;
    this.deps.retry = { ...deps.retry, ...(deps.retry.sleepImpl ? {} : { sleepImpl: deps.sleep || defaultSleep }) };
  }

  /** 暴露状态仓库（调度器判断"今日是否已完成"用）。 */
  get store(): StateStore {
    return this.deps.store;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    const sleepImpl = this.deps.sleep || defaultSleep;
    await sleepImpl(ms);
  }

  /** 查询积分（失败不抛错，返回原因）。 */
  async queryCredits(account: AccountContext): Promise<CreditResult> {
    if (!account.credentials) {
      return { ok: false, total: null, accounts: 0, code: null, message: null, host: null, error: account.credentialError || '无可用凭据' };
    }
    return fetchCredits({
      profile: account.profile,
      accessToken: account.credentials.accessToken,
      retry: this.deps.retry,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      timeoutMs: this.deps.config.requestTimeoutMs,
      now: () => this.now(),
    });
  }

  /** 账号列表 + 今日状态 + 积分，用于 `checkin:status`。 */
  async status(accounts: AccountContext[], options: { skipCredits?: boolean } = {}): Promise<AccountStatusView[]> {
    const date = beijingDate(this.now());
    const views: AccountStatusView[] = [];
    for (const account of accounts) {
      const record = account.uid ? this.deps.store.getRecord(account.uid, date) : null;
      let credits: number | null = null;
      let creditsError: string | null = null;
      if (!options.skipCredits && account.credentials) {
        const result = await this.queryCredits(account);
        credits = result.ok ? result.total : null;
        creditsError = result.ok ? null : result.error;
      } else if (!account.credentials) {
        creditsError = account.credentialError;
      }
      views.push({
        accountTag: account.accountTag,
        uidMasked: account.accountTag,
        profile: account.profile,
        nickname: account.nickname,
        phoneMasked: account.phoneMasked,
        origin: account.origin,
        isCurrent: account.isCurrent,
        hasCredential: !!account.credentials,
        credentialError: account.credentialError,
        tokenExpired: account.tokenExpired,
        tokenExpiresAt: account.credentials?.expiresAt ? new Date(account.credentials.expiresAt).toISOString() : null,
        today: {
          date,
          outcome: record ? record.outcome : null,
          ok: !!(record && record.ok && record.verified !== false),
          at: record ? new Date(record.finishedAt).toISOString() : null,
          source: record ? 'local-record' : 'none',
        },
        credits,
        creditsError,
      });
    }
    return views;
  }

  /**
   * 对单个账号执行签到。
   * 同一 uid 的并发调用会复用同一个 Promise，避免重复领取。
   */
  async checkin(account: AccountContext, options: CheckinOptions = {}): Promise<CheckinRecord> {
    const key = account.uid || account.authFile;
    const existing = this.inFlight.get(key);
    if (existing) {
      this.deps.logger.warn(`账号 ${account.accountTag} 已有进行中的签到任务，复用该任务`);
      return existing;
    }
    const task = this.runCheckin(account, options).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  private async runCheckin(account: AccountContext, options: CheckinOptions): Promise<CheckinRecord> {
    const startedAt = this.now();
    const date = beijingDate(startedAt);
    const base = {
      uid: account.uid,
      date,
      profile: account.profile,
      accountTag: account.accountTag,
      startedAt,
      dryRun: !!options.dryRun,
    };

    const finish = (partial: Partial<CheckinRecord> & { outcome: CheckinOutcome; ok: boolean }): CheckinRecord => {
      const record: CheckinRecord = {
        uid: base.uid,
        date,
        outcome: partial.outcome,
        ok: partial.ok,
        already: partial.already ?? false,
        code: partial.code ?? null,
        message: partial.message ?? '',
        endpoint: partial.endpoint ?? null,
        startedAt,
        finishedAt: this.now(),
        creditsBefore: partial.creditsBefore ?? null,
        creditsAfter: partial.creditsAfter ?? null,
        creditsDelta: partial.creditsDelta ?? null,
        verified: partial.verified ?? false,
        verification: partial.verification ?? 'none',
        profile: base.profile,
        accountTag: base.accountTag,
        dryRun: base.dryRun,
        ...(partial.diagnostic ? { diagnostic: redactText(partial.diagnostic, 300) } : {}),
      };
      this.deps.logger.record(record);
      try {
        this.deps.store.saveRecord(record);
      } catch (error) {
        this.deps.logger.error(`写入签到记录失败：${redactText(error, 160)}`);
      }
      return record;
    };

    if (!account.uid) {
      return finish({ outcome: 'unauthenticated', ok: false, diagnostic: '凭据文件中没有账号 uid，无法确定账号身份' });
    }

    // ---- 第 1 步：本地已验证记录（幂等第一层） ----
    if (!options.force && this.deps.store.hasConfirmedSuccess(account.uid, date)) {
      const record = this.deps.store.getRecord(account.uid, date);
      this.deps.logger.info(`账号 ${account.accountTag} 今日已确认签到，跳过所有请求`);
      return finish({
        outcome: 'skipped',
        ok: true,
        already: true,
        code: record?.code ?? null,
        message: record?.message ?? '本地记录显示今日已完成签到',
        endpoint: record?.endpoint ?? null,
        creditsBefore: record?.creditsBefore ?? null,
        creditsAfter: record?.creditsAfter ?? null,
        verified: true,
        verification: 'local-record',
      });
    }

    // ---- 第 2 步：凭据有效性 ----
    if (!account.credentials) {
      return finish({
        outcome: 'unauthenticated',
        ok: false,
        diagnostic: account.credentialError || '未取得可用的登录凭据',
      });
    }

    let credentials = account.credentials;
    if (!isTokenUsable(credentials, startedAt)) {
      if (!this.deps.config.allowTokenRefresh) {
        return finish({
          outcome: 'unauthenticated',
          ok: false,
          diagnostic: 'accessToken 已过期或即将过期；为避免影响客户端登录态，默认不自动刷新，请在客户端重新登录后重试',
        });
      }
      const refreshed = await refreshCredentials(credentials, {
        apiHost: PROFILES[account.profile].apiHost,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        timeoutMs: this.deps.config.requestTimeoutMs,
        now: this.now(),
      });
      if (!refreshed.ok) {
        return finish({
          outcome: 'unauthenticated',
          ok: false,
          diagnostic: `令牌刷新失败：${refreshed.error || '未知原因'}`,
        });
      }
      credentials = refreshed.credentials;
      account.credentials = credentials;
      this.deps.logger.info(`账号 ${account.accountTag} 已在内存中刷新 accessToken（未写回官方凭据文件）`);
    }

    // ---- 第 3 步：签到前积分 ----
    let creditsBefore: number | null = null;
    if (!options.skipCredits) {
      const before = await this.queryCredits({ ...account, credentials });
      creditsBefore = before.ok ? before.total : null;
      if (!before.ok) this.deps.logger.warn(`账号 ${account.accountTag} 签到前积分查询失败：${before.error}`);
    }

    // ---- 第 4 步：模拟执行不领取 ----
    if (options.dryRun) {
      return finish({
        outcome: 'dry-run',
        ok: false,
        creditsBefore,
        diagnostic: '模拟执行：已确认凭据可用，但未调用领取接口',
      });
    }

    // ---- 第 5 步：执行领取 ----
    const claim = await claimDailyCheckin({
      profile: account.profile,
      accessToken: credentials.accessToken,
      uid: account.uid,
      domain: credentials.domain || account.domain,
      retry: this.deps.retry,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      timeoutMs: this.deps.config.requestTimeoutMs,
    });

    const classification = claim.classification;
    const outcome = outcomeFromClassification(classification);

    if (outcome === 'unsupported') {
      return finish({
        outcome,
        ok: false,
        code: classification.code,
        message: classification.message,
        endpoint: claim.endpoint,
        creditsBefore,
        diagnostic: [
          classification.reason,
          claim.transportError ? `传输错误：${claim.transportError}` : null,
          claim.dataKeys ? `响应 data 字段：${claim.dataKeys.join(',')}` : null,
          `已尝试：${claim.tried.join(' , ')}`,
        ]
          .filter(Boolean)
          .join('；'),
      });
    }

    if (outcome === 'unauthenticated') {
      return finish({
        outcome,
        ok: false,
        code: classification.code,
        message: classification.message,
        endpoint: claim.endpoint,
        creditsBefore,
        diagnostic: '服务端拒绝登录身份（401/403），请在客户端重新登录',
      });
    }

    if (outcome === 'inactive') {
      return finish({
        outcome,
        ok: false,
        code: classification.code,
        message: classification.message,
        endpoint: claim.endpoint,
        creditsBefore,
        diagnostic: classification.reason || '签到活动不可用',
      });
    }

    // ---- 第 6 步：验证到账 ----
    let creditsAfter: number | null = null;
    let delta: number | null = null;
    if (!options.skipCredits) {
      await this.sleep(this.deps.config.verifyDelayMs);
      const after = await this.queryCredits({ ...account, credentials });
      creditsAfter = after.ok ? after.total : null;
      if (creditsBefore !== null && creditsAfter !== null) {
        delta = Math.round((creditsAfter - creditsBefore) * 100) / 100;
      }
    }

    let verification: CheckinRecord['verification'] = 'server-code';
    let verified = true;
    let diagnostic: string | undefined;
    if (outcome === 'checked-in') {
      if (delta !== null && delta > 0) {
        verification = 'credits-delta';
        diagnostic = `积分已到账，增加 ${delta}`;
      } else if (delta === 0) {
        verification = 'server-code';
        diagnostic = '服务端返回成功，但积分差额为 0（可能为异步入账或已计入其它积分包）';
      } else {
        verification = 'server-code';
        diagnostic = '服务端返回成功；积分差额不可观测（查询失败或未启用积分查询）';
      }
    } else {
      // already：今日已签到，服务端明确说明，不重复发放
      verification = 'server-code';
      diagnostic = '服务端表示今日已签到，未重复发放';
    }

    return finish({
      outcome,
      ok: true,
      already: classification.already,
      code: classification.code,
      message: classification.message,
      endpoint: claim.endpoint,
      creditsBefore,
      creditsAfter,
      creditsDelta: delta,
      verified,
      verification,
      ...(diagnostic ? { diagnostic } : {}),
    });
  }

  /**
   * 遍历账号逐个签到。
   * 单个账号失败不会阻断其它账号：每个账号独立 try/catch，独立记录。
   */
  async checkinAll(accounts: AccountContext[], options: CheckinOptions = {}): Promise<BatchResult> {
    const startedAt = this.now();
    const date = beijingDate(startedAt);
    const records: CheckinRecord[] = [];

    if (!accounts.length) {
      return {
        date,
        startedAt,
        finishedAt: this.now(),
        records,
        summary: { total: 0, checkedIn: 0, already: 0, skipped: 0, dryRun: 0, failed: 0 },
      };
    }

    this.deps.logger.event('batch.start', { date, accounts: accounts.length, dryRun: !!options.dryRun });

    for (const account of accounts) {
      try {
        const record = await this.checkin(account, options);
        records.push(record);
      } catch (error) {
        // 兜底：服务内部异常也要落一条失败记录，并继续下一个账号
        const message = redactText(error, 240);
        this.deps.logger.error(`账号 ${account.accountTag} 签到异常：${message}`);
        const record: CheckinRecord = {
          uid: account.uid,
          date,
          outcome: 'error',
          ok: false,
          already: false,
          code: null,
          message: '签到流程异常',
          endpoint: null,
          startedAt: this.now(),
          finishedAt: this.now(),
          creditsBefore: null,
          creditsAfter: null,
          creditsDelta: null,
          verified: false,
          verification: 'none',
          profile: account.profile,
          accountTag: account.accountTag,
          dryRun: !!options.dryRun,
          diagnostic: message,
        };
        try {
          this.deps.store.saveRecord(record);
        } catch {
          /* 已尽力 */
        }
        this.deps.logger.record(record);
        records.push(record);
      }
    }

    const summary = {
      total: records.length,
      checkedIn: records.filter((r) => r.outcome === 'checked-in').length,
      already: records.filter((r) => r.outcome === 'already').length,
      skipped: records.filter((r) => r.outcome === 'skipped').length,
      dryRun: records.filter((r) => r.outcome === 'dry-run').length,
      failed: records.filter((r) => !r.ok && r.outcome !== 'dry-run').length,
    };
    const result: BatchResult = { date, startedAt, finishedAt: this.now(), records, summary };
    this.deps.logger.event('batch.finish', { date, ...summary });
    return result;
  }
}
