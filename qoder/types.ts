/**
 * Qoder 签到模块类型定义。
 *
 * 命名：Qoder* 前缀表示本模块自有模型；Upstream* 表示官方接口返回结构。
 * 两个区域（cn / global）在类型层面就分开表达，避免凭据、设备身份、API 地址串区。
 */

/** Qoder CN 国内版 / Qoder 国际版。 */
export type QoderRegion = 'cn' | 'global';

/** 区域静态配置：API 与 Web 域名、UMID 运行时环境号、展示名。 */
export interface QoderRegionProfile {
  region: QoderRegion;
  /** 接口基址（openapi） */
  base: string;
  /** 网页基址（设备授权页） */
  web: string;
  label: string;
  /** runtime-info 组件的环境号：国内版 0，国际版 3 */
  umidEnv: number;
  /** 允许覆盖 UMID 组件路径的环境变量名 */
  umidEnvVar: string;
  /** 客户端安装目录候选（相对 %LOCALAPPDATA%\\Programs） */
  installNames: string[];
}

/** 账号令牌。access 形如 dt-xxx / jt-xxx，refresh 形如 drt-xxx / jrt-xxx。 */
export interface QoderTokens {
  access: string;
  refresh: string;
  /** 最近一次写入时间（毫秒） */
  updatedAt: number;
}

/**
 * 设备身份（仅存标识类字段）。
 *
 * machineToken 是有时效的签名串，不落盘，每次按需由 UMID 组件重新生成；
 * machineId 是本机稳定标识，machineCode/machineType 用于展示与排障。
 */
export interface QoderDeviceIdentity {
  /** Cosy-MachineId */
  machineId: string;
  /** 例如 x86_64_win32 */
  machineOs: string;
  /** Cosy-MachineHostname（已规范化） */
  machineHostname: string;
  /** UMID 输出的 machineCode（可空） */
  machineCode?: string;
  /** UMID 输出的 machineType（可空） */
  machineType?: string;
  /** 最近一次成功生成身份的时间 */
  lastUmidAt?: number;
}

/** UMID 组件一次调用的输出。 */
export interface QoderRiskValues {
  machineToken: string;
  machineCode: string;
  machineType: string;
}

/** 参与签到的 Qoder 账号。 */
export interface QoderAccount {
  /** `${region}:${uid 或令牌指纹}` */
  id: string;
  region: QoderRegion;
  /** 备注名，用于日志与 CLI 选择 */
  note: string;
  uid: string;
  tokens: QoderTokens;
  device: QoderDeviceIdentity;
  /** 令牌来源：store（本模块持久化）/ env（环境变量导入） */
  source: 'store' | 'env' | 'login';
  createdAt: number;
}

/** 签到结果的归一化状态。 */
export type QoderCheckinOutcome =
  | 'claimed'        // 本次领取成功
  | 'already'        // 今日已领取（服务端明确）
  | 'skipped'        // 本地已验证记录命中，未发请求
  | 'dry-run'        // 模拟，不发领取请求
  | 'no-campaign'    // 上游未下发活动（含窗口未开）
  | 'blocked'        // 设备身份/同人多号等阻塞
  | 'quota-exhausted'// 额度类 403（112/110），不是登录失效
  | 'unauthorized'   // 令牌失效且无法续期
  | 'unsupported'    // 响应结构未知，保守失败
  | 'error';         // 网络或其它错误

/** 一条签到记录。 */
export interface QoderCheckinRecord {
  accountId: string;
  region: QoderRegion;
  /** 北京时间日期 YYYY-MM-DD */
  date: string;
  outcome: QoderCheckinOutcome;
  ok: boolean;
  campaignId: string | null;
  /** 活动面值（campaigns 行的 benefit.amount） */
  campaignAmount: number | null;
  /** 领取响应里声明的面值 */
  claimedAmount: number | null;
  creditsBefore: number | null;
  creditsAfter: number | null;
  creditsDelta: number | null;
  verified: boolean;
  verification: 'quota-delta' | 'server-status' | 'local-record' | 'none';
  message: string;
  at: number;
  durationMs: number;
  dryRun: boolean;
  accountTag: string;
  note: string;
  diagnostic?: string;
  /** 本次是否刷新过 token */
  tokenRefreshed?: boolean;
}

/** campaigns 行（只列出用到的字段）。 */
export interface QoderCampaignRow {
  campaignId: string;
  campaignKey: string;
  actionType: string;
  claimStatus: string;
  benefitKind: string;
  benefitAmount: number;
  title: string;
  raw: Record<string, unknown>;
}

/** 领取响应的归一化判定。 */
export type QoderClaimVerdict = 'claimed' | 'already' | 'blocked' | 'error';

export interface QoderClaimResult {
  verdict: QoderClaimVerdict;
  amount: number;
  message: string;
  /** 响应体关键字段，便于诊断（不含凭据） */
  status: string;
  failureCode: string;
  replayed: boolean;
  redemptionCode: string;
  httpStatus: number;
}

/** 活动列表查询结果。 */
export interface QoderCampaignFetch {
  ok: boolean;
  rows: QoderCampaignRow[];
  httpStatus: number;
  /** 是否为 200 但明确空表 */
  empty: boolean;
  error: string | null;
  /** 是否触发了 CN 最小头复取 */
  minimalFallbackUsed: boolean;
  /** 设备身份问题（UMID 不可用等），仅诊断用 */
  riskNote: string | null;
  quotaKind: '' | 'exhausted' | 'daily';
  quotaSeconds: number;
}

/** 账号视图（CLI status 用）。 */
export interface QoderAccountView {
  id: string;
  region: QoderRegion;
  regionLabel: string;
  accountTag: string;
  note: string;
  uid: string;
  tokenMasked: string;
  hasRefresh: boolean;
  tokenAgeSeconds: number | null;
  today: {
    date: string;
    outcome: QoderCheckinOutcome | null;
    ok: boolean;
    at: string | null;
    amount: number | null;
    source: 'local-record' | 'none';
  };
  device: {
    machineId: string;
    machineOs: string;
    umidAvailable: boolean;
    umidPath: string | null;
    umidError: string | null;
  };
  credits: number | null;
  creditsError: string | null;
}

/** 批量结果。 */
export interface QoderBatchResult {
  date: string;
  startedAt: number;
  finishedAt: number;
  records: QoderCheckinRecord[];
  summary: {
    total: number;
    claimed: number;
    already: number;
    skipped: number;
    dryRun: number;
    noCampaign: number;
    failed: number;
  };
}

/** 模块配置。 */
export interface QoderConfig {
  /** 数据目录（与 WorkBuddy 模块共用根目录，文件名区分） */
  dataDir: string;
  timezone: string;
  /** 每日检查时间点（北京时间） */
  checkTimes: string[];
  /** 10:00 窗口延迟下发时的重试策略 */
  windowRetry: {
    enabled: boolean;
    max: number;
    gapMs: number;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  requestTimeoutMs: number;
  /** 领取后等待多久再回读额度 */
  verifyDelayMs: number;
  /** 参与的 region */
  regions: QoderRegion[];
  /** 客户端可执行文件（用于定位 build-manifest 与 umid 组件） */
  clientExe: Partial<Record<QoderRegion, string>>;
  /** 显式指定 UMID 组件路径 */
  umidPath: Partial<Record<QoderRegion, string>>;
  /** 是否允许在无本机组件时从官方 npm 包提取（默认关闭：需要联网且写文件） */
  allowUmidDownload: boolean;
  verbose: boolean;
  usedConfigPath?: string | null;
}
