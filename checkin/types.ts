/**
 * 共享类型定义。
 *
 * 命名约定：
 * - Wb* 表示来自 WorkBuddy 官方数据结构（auth 文件 / 接口响应）。
 * - Checkin* 表示本模块自己的领域模型。
 */

/** 支持的官方客户端 profile（仅桌面端，且账号能力可用的两个）。 */
export type ProfileId = 'workbuddy-cn' | 'workbuddy-ai';

/** 一个 profile 的静态描述：凭据文件位置、API 域名、可执行文件候选。 */
export interface ProfileDefinition {
  id: ProfileId;
  /** 展示名 */
  name: string;
  /** 区域：国内版 / 国际版 */
  region: 'cn' | 'intl';
  /** 官方登录凭据文件（相对扩展数据根） */
  authFileName: string;
  /** billing / 签到接口使用的主机 */
  apiHost: string;
  /** 判定 CDP target 归属时使用的域名信号 */
  domainSignals: string[];
  /** Windows 默认可执行文件候选（相对 %LOCALAPPDATA%） */
  exeCandidates: string[];
  /** macOS 可执行文件候选 */
  macExeCandidates: string[];
}

/** 凭据文件解密后的形态（只保留本模块需要的字段）。 */
export interface WbAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳 */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  lastRefreshTime: number | null;
  /** 令牌签发/使用域，签到请求会作为 x-domain 头带上 */
  domain: string;
}

/** 凭据文件里的账号信息。 */
export interface WbAccountInfo {
  uid: string;
  nickname: string;
  /** 已脱敏手机号，仅用于人工识别 */
  phoneMasked: string;
  uin: string;
  type: string;
  enterpriseName: string;
}

/** 从磁盘发现的一个账号来源。 */
export interface AccountSource {
  profile: ProfileId;
  /** .info 文件绝对路径 */
  authFile: string;
  /** 来源类别：官方当前登录文件 / 本模块账号目录 / 兼容参考项目备份 */
  origin: 'official' | 'managed' | 'legacy-backup';
}

/** 可直接用于签到流程的账号上下文。 */
export interface AccountContext {
  uid: string;
  /** 脱敏后的账号标识，用于日志 */
  accountTag: string;
  profile: ProfileId;
  authFile: string;
  origin: AccountSource['origin'];
  nickname: string;
  phoneMasked: string;
  domain: string;
  /** 是否是官方客户端当前登录的账号 */
  isCurrent: boolean;
  credentials: WbAuthCredentials | null;
  /** 凭据不可用的原因（未登录 / 已加密且取钥失败 / 无 accessToken） */
  credentialError: string | null;
  tokenExpired: boolean;
}

/** 签到统一结果状态。 */
export type CheckinOutcome =
  | 'checked-in'      // 本次真正领取成功
  | 'already'         // 服务端明确表示今日已签到（本次未重复发放）
  | 'skipped'         // 本地已验证记录命中，跳过所有请求
  | 'dry-run'         // 模拟执行，未发领取请求
  | 'unauthenticated' // 凭据缺失或失效
  | 'inactive'        // 活动未开启 / 已结束
  | 'unsupported'     // 接口行为与已知契约不符，停止领取
  | 'error';          // 网络或其它错误

/** 单次签到记录的持久化形态。 */
export interface CheckinRecord {
  uid: string;
  /** 北京时间日期 YYYY-MM-DD */
  date: string;
  outcome: CheckinOutcome;
  /** 是否可视为「今天已经拿到积分」 */
  ok: boolean;
  /** 本次是否为「已签到」判定 */
  already: boolean;
  /** 服务端业务 code */
  code: number | null;
  /** 服务端 msg（已脱敏） */
  message: string;
  /** 请求的接口地址（不含凭据） */
  endpoint: string | null;
  /** 毫秒时间戳 */
  startedAt: number;
  finishedAt: number;
  creditsBefore: number | null;
  creditsAfter: number | null;
  creditsDelta: number | null;
  /** 是否通过积分差额验证到账 */
  verified: boolean;
  /** verified 的判定依据 */
  verification: 'credits-delta' | 'server-code' | 'local-record' | 'none';
  profile: ProfileId;
  accountTag: string;
  dryRun: boolean;
  /** 失败/诊断信息（界面与日志用，不含敏感值） */
  diagnostic?: string;
}

/** 一次多账号批处理的结果。 */
export interface BatchResult {
  date: string;
  startedAt: number;
  finishedAt: number;
  records: CheckinRecord[];
  summary: {
    total: number;
    checkedIn: number;
    already: number;
    skipped: number;
    dryRun: number;
    failed: number;
  };
}

/** 账号在 CLI status 输出中的视图。 */
export interface AccountStatusView {
  accountTag: string;
  uidMasked: string;
  profile: ProfileId;
  nickname: string;
  phoneMasked: string;
  origin: AccountSource['origin'];
  isCurrent: boolean;
  hasCredential: boolean;
  credentialError: string | null;
  tokenExpired: boolean;
  tokenExpiresAt: string | null;
  today: {
    date: string;
    outcome: CheckinOutcome | null;
    ok: boolean;
    at: string | null;
    source: 'local-record' | 'none';
  };
  credits: number | null;
  creditsError: string | null;
}

/** CDP 连接状态。 */
export interface CdpStatus {
  connected: boolean;
  port: number | null;
  targetUrl: string | null;
  targetTitle: string | null;
  pageReadyState: string | null;
  error: string | null;
}

/** 运行时配置。 */
export interface CheckinConfig {
  /** 参与签到的 profile，默认只包含已安装且已登录的 */
  profiles: ProfileId[];
  /** 本地数据目录 */
  dataDir: string;
  /** 可执行文件覆盖（用于派生解密密钥） */
  workBuddyExe: Record<string, string>;
  /** 调度时区 */
  timezone: string;
  /** 每日检查时间（HH:mm，本地调度时区） */
  checkTimes: string[];
  /** 网络失败重试次数与退避基数 */
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  /** 客户端未启动时的行为 */
  clientMissing: 'skip' | 'launch';
  /** 是否允许在 token 过期时用 refresh token 换新令牌（默认关闭） */
  allowTokenRefresh: boolean;
  /** 单次 HTTP 超时 */
  requestTimeoutMs: number;
  /** 领取后等待多久再查积分（毫秒） */
  verifyDelayMs: number;
  /** 是否把日志同时写到 stdout */
  verbose: boolean;
  /** 允许扫描参考项目（WorkDaddy）遗留备份目录作为额外账号来源 */
  scanLegacyBackup: boolean;
  /** 额外账号目录（用户自行放置 .info 备份） */
  managedAccountsDir: string;
  /** 实际加载到的配置文件路径（无则为 null） */
  usedConfigPath?: string | null;
}
