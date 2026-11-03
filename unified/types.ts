/**
 * 统一编排层的类型定义。
 *
 * 设计原则：
 * - 三个任务（WorkBuddy / Qoder CN / Qoder 国际版）完全独立，
 *   编排层只负责"依次触发 + 汇总结果"，不碰各自内部的判定与接口。
 * - 平台之间用统一的结果结构交互，便于统一输出与退出码计算。
 */

/** 三个签到任务（Qoder 按区域拆成两个，与需求一致）。 */
export type PlatformId = 'workbuddy' | 'qoder-cn' | 'qoder-global';

/** 单平台执行结果状态。 */
export type PlatformStatus =
  | 'ok'        // 全部账号完成（领取成功或今日已领取）
  | 'partial'   // 部分账号失败
  | 'failed'    // 全部账号失败
  | 'skipped'   // 今日已完成，未发请求
  | 'norun'     // 没有可用账号 / 前置条件不满足
  | 'error';    // 编排层捕获的异常（含超时）

/** 归一化后的单平台结果。 */
export interface PlatformOutcome {
  platform: PlatformId;
  label: string;
  status: PlatformStatus;
  /** 参与执行的账号数 */
  accounts: number;
  /** 本次新领取成功 */
  claimed: number;
  /** 今日已领取（服务端/本地确认） */
  already: number;
  /** 因本地记录跳过 */
  skipped: number;
  /** 模拟执行 */
  dryRun: number;
  /** 失败总数（含不可用账号） */
  failed: number;
  /** 其中"凭据不可用/未安装客户端"这类非程序故障的数量，便于用户判断该不该管 */
  unavailable?: number;
  durationMs: number;
  /** 一句话说明（人类可读） */
  detail: string;
  /** 失败/诊断信息 */
  error?: string;
  /** 平台原始记录，仅 --json 输出时使用 */
  records?: unknown[];
}

/** 一次"全部签到"的汇总。 */
export interface UnifiedResult {
  /** 北京时间日期 */
  date: string;
  startedAt: number;
  finishedAt: number;
  dryRun: boolean;
  outcomes: PlatformOutcome[];
  summary: {
    platforms: number;
    ok: number;
    partial: number;
    failed: number;
    skipped: number;
    norun: number;
    error: number;
    accounts: number;
    claimed: number;
    already: number;
    skippedAccounts: number;
    failedAccounts: number;
    unavailableAccounts: number;
  };
}

/** 编排层选项。 */
export interface RunAllOptions {
  dryRun?: boolean;
  /** 忽略各平台"今日已完成"记录，强制再确认一次（服务端仍会去重） */
  force?: boolean;
  /** 单平台超时（毫秒），默认 20 分钟：Qoder 的窗口重试可能较久 */
  timeoutMs?: number;
  /** 只跑指定平台 */
  only?: PlatformId[];
  /** 进度回调（CLI 用来打印） */
  onStart?: (platform: PlatformMeta) => void;
  onFinish?: (outcome: PlatformOutcome) => void;
}

/** 平台元信息（用于打印与筛选）。 */
export interface PlatformMeta {
  id: PlatformId;
  label: string;
  /** 一句话描述，比如"读取本机客户端登录态" */
  hint: string;
}

/** 平台适配器：编排层唯一依赖的接口。 */
export interface PlatformAdapter {
  meta: PlatformMeta;
  /** 是否有可执行账号（没有则视为 norun，不参与"今日是否完成"的判断） */
  hasAccounts(): boolean;
  /** 今日是否已经全部完成（用于整批跳过，避免无意义请求） */
  doneToday(date: string): boolean;
  /** 执行一次（内部自行处理账号遍历、幂等与重试） */
  run(options: { dryRun?: boolean; force?: boolean }): Promise<PlatformOutcome>;
}
