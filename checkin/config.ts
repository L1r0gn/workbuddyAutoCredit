/**
 * 路径解析、profile 定义与配置加载。
 *
 * 所有路径都遵循官方客户端的实际目录布局（与参考项目一致的实测结论）：
 *   Windows 扩展数据根 = %LOCALAPPDATA%
 *   macOS  扩展数据根 = ~/Library/Application Support
 *   登录凭据 = <扩展数据根>/CodeBuddyExtension/Data/Public/auth/<profile>.info
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CheckinConfig, ProfileDefinition, ProfileId } from './types';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/** Windows: %APPDATA%；macOS/Linux: ~/Library/Application Support、~/.config */
export function appSupportDir(): string {
  if (IS_WIN) return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

/** Windows: %LOCALAPPDATA%；macOS: 同 appSupport；Linux: $XDG_DATA_HOME */
export function localSupportDir(): string {
  if (IS_WIN) return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (IS_MAC) return appSupportDir();
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

/** 官方登录凭据目录。 */
export function extensionAuthDir(): string {
  return path.join(localSupportDir(), 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/** 本模块默认数据目录（与本项目源码目录解耦，避免被 git 忽略规则误伤）。 */
export function defaultDataDir(): string {
  return path.join(appSupportDir(), 'workbuddy-auto-checkin');
}

export const PROFILES: Record<ProfileId, ProfileDefinition> = {
  'workbuddy-cn': {
    id: 'workbuddy-cn',
    name: 'WorkBuddy 国内版',
    region: 'cn',
    authFileName: 'workbuddy-desktop.info',
    apiHost: 'https://www.codebuddy.cn',
    domainSignals: ['workbuddy.cn', 'codebuddy.cn'],
    exeCandidates: [path.join('Programs', 'WorkBuddy', 'WorkBuddy.exe')],
    macExeCandidates: ['/Applications/WorkBuddy.app/Contents/MacOS/Electron'],
  },
  'workbuddy-ai': {
    id: 'workbuddy-ai',
    name: 'WorkBuddy AI 国际版',
    region: 'intl',
    authFileName: 'workbuddy-desktop-ai.info',
    apiHost: 'https://www.workbuddy.ai',
    domainSignals: ['workbuddy.ai'],
    exeCandidates: [path.join('Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe')],
    macExeCandidates: ['/Applications/WorkBuddy AI.app/Contents/MacOS/Electron'],
  },
};

export const PROFILE_IDS: ProfileId[] = ['workbuddy-cn', 'workbuddy-ai'];

/**
 * 定位客户端可执行文件。
 *
 * 用途只有一个：以 ELECTRON_RUN_AS_NODE=1 方式启动它，读取本机静态密钥来解密
 * 已加密的凭据文件。绝不修改安装目录里的任何文件。
 *
 * 顺序：环境变量 → 配置文件显式指定 → 数据目录 path.txt → 平台默认安装位置。
 */
export function findWorkBuddyExe(
  profile: ProfileId,
  options: { configPath?: string | null; dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = options.env || process.env;
  const def = PROFILES[profile];
  const candidates: string[] = [];

  const envOverride = profile === 'workbuddy-ai' ? env.WORKBUDDY_AI_EXE : env.WORKBUDDY_EXE;
  if (envOverride) candidates.push(envOverride);

  const configPath = options.configPath ?? env.WORKBUDDY_CHECKIN_EXE;
  if (configPath) candidates.push(configPath);

  if (options.dataDir) {
    for (const name of ['workbuddy-exe.txt', `${profile}-exe.txt`]) {
      const file = path.join(options.dataDir, name);
      try {
        const value = fs.readFileSync(file, 'utf8').trim();
        if (value) candidates.push(value);
      } catch {
        /* 不存在则忽略 */
      }
    }
  }

  if (IS_WIN) {
    const local = localSupportDir();
    for (const relative of def.exeCandidates) candidates.push(path.join(local, relative));
  } else if (IS_MAC) {
    candidates.push(...def.macExeCandidates);
  }

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    try {
      if (fs.statSync(value).isFile()) return value;
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

const DEFAULT_RETRY = { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 60000 };

/** 默认配置。所有值都可以被 checkin.config.json 覆盖。 */
export function defaultConfig(overrides: Partial<CheckinConfig> = {}): CheckinConfig {
  const dataDir = overrides.dataDir || process.env.WORKBUDDY_CHECKIN_DATA_DIR || defaultDataDir();
  const { retry: retryOverride, ...rest } = overrides;
  return {
    profiles: PROFILE_IDS,
    dataDir,
    workBuddyExe: {},
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    clientMissing: 'skip',
    allowTokenRefresh: false,
    requestTimeoutMs: 12000,
    verifyDelayMs: 2500,
    verbose: true,
    scanLegacyBackup: false,
    managedAccountsDir: path.join(dataDir, 'accounts'),
    ...rest,
    retry: { ...DEFAULT_RETRY, ...(retryOverride || {}) },
  };
}

/** 配置文件名，按优先级在项目根与数据目录中查找。 */
const CONFIG_FILES = ['checkin.config.json'];

/**
 * 读取配置文件并与默认值合并。
 * 环境变量 WORKBUDDY_CHECKIN_CONFIG 可指定绝对路径。
 */
export function loadConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CheckinConfig {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const dataDir = env.WORKBUDDY_CHECKIN_DATA_DIR || defaultDataDir();

  const candidates: string[] = [];
  if (env.WORKBUDDY_CHECKIN_CONFIG) candidates.push(env.WORKBUDDY_CHECKIN_CONFIG);
  for (const name of CONFIG_FILES) {
    candidates.push(path.join(cwd, name));
    candidates.push(path.join(dataDir, name));
  }

  let raw: Record<string, unknown> = {};
  let usedPath: string | null = null;
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
        usedPath = file;
        break;
      }
    } catch {
      /* 不存在或格式错误则继续 */
    }
  }

  const merged = defaultConfig({ dataDir });
  const config: CheckinConfig = { ...merged };

  if (typeof raw.timezone === 'string' && raw.timezone.trim()) config.timezone = raw.timezone.trim();
  if (Array.isArray(raw.checkTimes)) {
    const times = raw.checkTimes.map((t) => String(t).trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    if (times.length) config.checkTimes = times;
  }
  if (raw.retry && typeof raw.retry === 'object') {
    const retry = raw.retry as Record<string, unknown>;
    if (Number.isFinite(Number(retry.maxAttempts))) config.retry.maxAttempts = Math.max(1, Math.min(10, Number(retry.maxAttempts)));
    if (Number.isFinite(Number(retry.baseDelayMs))) config.retry.baseDelayMs = Math.max(100, Number(retry.baseDelayMs));
    if (Number.isFinite(Number(retry.maxDelayMs))) config.retry.maxDelayMs = Math.max(1000, Number(retry.maxDelayMs));
  }
  if (raw.clientMissing === 'launch') config.clientMissing = 'launch';
  if (raw.allowTokenRefresh === true) config.allowTokenRefresh = true;
  if (raw.scanLegacyBackup === true) config.scanLegacyBackup = true;
  if (raw.verbose === false) config.verbose = false;
  if (Number.isFinite(Number(raw.requestTimeoutMs))) config.requestTimeoutMs = Math.max(1000, Number(raw.requestTimeoutMs));
  if (Number.isFinite(Number(raw.verifyDelayMs))) config.verifyDelayMs = Math.max(0, Number(raw.verifyDelayMs));
  if (Array.isArray(raw.profiles)) {
    const list = raw.profiles.filter((p): p is ProfileId => typeof p === 'string' && (PROFILE_IDS as string[]).includes(p));
    if (list.length) config.profiles = list;
  }
  if (raw.workBuddyExe && typeof raw.workBuddyExe === 'object') {
    for (const [key, value] of Object.entries(raw.workBuddyExe as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) config.workBuddyExe[key] = value.trim();
    }
  }
  config.usedConfigPath = usedPath;
  return config;
}

/** 供 CLI 打印的配置摘要（不含敏感项）。 */
export function describeConfig(config: CheckinConfig): Record<string, unknown> {
  return {
    dataDir: config.dataDir,
    profiles: config.profiles,
    timezone: config.timezone,
    checkTimes: config.checkTimes,
    clientMissing: config.clientMissing,
    allowTokenRefresh: config.allowTokenRefresh,
    requestTimeoutMs: config.requestTimeoutMs,
    verifyDelayMs: config.verifyDelayMs,
    scanLegacyBackup: config.scanLegacyBackup,
    configFile: config.usedConfigPath ?? null,
    extensionAuthDir: extensionAuthDir(),
  };
}
