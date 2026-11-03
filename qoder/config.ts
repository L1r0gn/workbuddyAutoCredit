/**
 * Qoder 区域配置、路径解析与 UMID 组件定位。
 *
 * 关键事实（来自 Qoder-Daily 源码，逐条核对）：
 * - 国内版：api https://openapi.qoder.com.cn，授权页 https://qoder.com.cn，UMID env=0
 * - 国际版：api https://openapi.qoder.sh，授权页 https://qoder.com，UMID env=3
 * - 设备风控身份由官方 `runtime-info` 组件生成（不是自造指纹）：
 *     runtime-info <env> --account-stdin  ← stdin {"account": uid}
 *     → stdout {"machineToken","machineCode","machineType",...}
 * - 组件位置：<客户端 resources>/umid/runtime-info[.exe]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appSupportDir, defaultDataDir } from '../checkin/config';
import type { QoderConfig, QoderRegion, QoderRegionProfile } from './types';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

export const REGIONS: Record<QoderRegion, QoderRegionProfile> = {
  cn: {
    region: 'cn',
    base: 'https://openapi.qoder.com.cn',
    web: 'https://qoder.com.cn',
    label: 'Qoder CN 国内版',
    umidEnv: 0,
    umidEnvVar: 'QODERCN_RUNTIME_INFO',
    installNames: ['Qoder CN', 'QoderCN'],
  },
  global: {
    region: 'global',
    base: 'https://openapi.qoder.sh',
    web: 'https://qoder.com',
    label: 'Qoder 国际版',
    umidEnv: 3,
    umidEnvVar: 'QODER_RUNTIME_INFO',
    installNames: ['Qoder'],
  },
};

export const REGION_IDS: QoderRegion[] = ['cn', 'global'];

/** 参考实现里的客户端版本兜底值（Cosy-Version）。 */
export const DEFAULT_CLIENT_VERSION = '1.1.69';
/** 设备身份缓存时长（与上游一致，50 分钟）。 */
export const RISK_TTL_MS = 50 * 60 * 1000;

/** 归一化区域名，容忍 intl / international 等写法。 */
export function normalizeRegion(value: unknown): QoderRegion {
  const text = String(value || '').toLowerCase().trim();
  return text === 'global' || text === 'intl' || text === 'international' ? 'global' : 'cn';
}

/** Qoder 数据目录：与 WorkBuddy 模块共用根，文件名区分。 */
export function qoderDataDir(): string {
  return process.env.QODER_CHECKIN_DATA_DIR || defaultDataDir();
}

/** UMID 组件文件名。 */
export function umidBinaryName(): string {
  return IS_WIN ? 'runtime-info.exe' : 'runtime-info';
}

function listDirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 客户端安装根目录候选（未去重）。 */
function installRoots(region: QoderRegion, exe?: string | null): string[] {
  const roots: string[] = [];
  const profile = REGIONS[region];
  if (exe) {
    const dir = path.dirname(exe);
    roots.push(dir, path.dirname(dir));
  }
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const name of profile.installNames) {
      roots.push(path.join(local, 'Programs', name));
      for (const envVar of ['ProgramFiles', 'ProgramFiles(x86)']) {
        const base = process.env[envVar];
        if (base) roots.push(path.join(base, name));
      }
    }
  } else if (IS_MAC) {
    for (const name of profile.installNames) {
      roots.push(`/Applications/${name}.app`);
      roots.push(path.join(os.homedir(), 'Applications', `${name}.app`));
    }
  } else {
    for (const name of profile.installNames) {
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      roots.push(`/opt/${name}`, `/opt/${slug}`, `/usr/lib/${slug}`);
    }
  }
  return roots;
}

/**
 * resources 目录候选，按优先级：
 *  1. <root>/resources（当前版本）
 *  2. <root>/.qoder-versions/<ver>/resources（多版本并存时的最新几个）
 *  3. macOS .app/Contents/Resources
 */
export function resourcesDirs(region: QoderRegion, exe?: string | null): string[] {
  const out: string[] = [];
  for (const root of installRoots(region, exe)) {
    out.push(path.join(root, 'resources'));
    if (IS_MAC && root.endsWith('.app')) out.push(path.join(root, 'Contents', 'Resources'));
    const versionsDir = path.join(root, '.qoder-versions');
    const entries = listDirSafe(versionsDir)
      .filter((name) => /^\d/.test(name))
      .sort()
      .reverse()
      .slice(0, 8);
    for (const entry of entries) out.push(path.join(versionsDir, entry, 'resources'));
  }
  return [...new Set(out)];
}

/** 读取客户端版本（Cosy-Version 头取此值）。 */
export function clientVersion(region: QoderRegion, exe?: string | null): string {
  for (const dir of resourcesDirs(region, exe)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'build-manifest.json'), 'utf8')) as {
        productVersion?: unknown;
      };
      if (typeof manifest.productVersion === 'string' && manifest.productVersion.trim()) {
        return manifest.productVersion.trim();
      }
    } catch {
      /* 继续找下一个 */
    }
  }
  return DEFAULT_CLIENT_VERSION;
}

export interface UmidLookup {
  path: string | null;
  source: 'env' | 'config' | 'app' | 'cli' | 'data' | 'none';
  /** 尝试过的位置，失败时用于诊断 */
  tried: string[];
}

/**
 * 定位官方 UMID 组件（只读，不安装、不改客户端）。
 * 找不到时返回 tried 列表，供 CLI 给出可操作的错误信息。
 */
export function findUmidComponent(
  region: QoderRegion,
  options: {
    exe?: string | null;
    configured?: string | null;
    dataDir?: string;
    env?: NodeJS.ProcessEnv;
    /** 忽略 CLI 运行时缓存里的组件（只认客户端自带/显式指定的） */
    ignoreCliCache?: boolean;
  } = {},
): UmidLookup {
  const env = options.env || process.env;
  const profile = REGIONS[region];
  const tried: string[] = [];

  const candidates: Array<{ path: string; source: UmidLookup['source'] }> = [];
  const fromEnv = String(env[profile.umidEnvVar] || '').trim() || String(env.QODER_UMID_PATH || '').trim();
  if (fromEnv) candidates.push({ path: fromEnv, source: 'env' });
  if (options.configured) candidates.push({ path: options.configured, source: 'config' });
  for (const dir of resourcesDirs(region, options.exe)) {
    candidates.push({ path: path.join(dir, 'umid', umidBinaryName()), source: 'app' });
  }

  // CLI 运行时缓存：~/.qoder-cn/.bin/umid-*/runtime-info（国内版）/ ~/.qoder/.bin/...（国际版）
  const home = os.homedir();
  const cliConfigName = region === 'cn' ? '.qoder-cn' : '.qoder';
  const cliHome = String(env[region === 'cn' ? 'QODERCN_CLI_HOME' : 'QODER_CLI_HOME'] || '').trim() || home;
  const binDir = path.join(cliHome, cliConfigName, '.bin');
  for (const entry of options.ignoreCliCache ? [] : listDirSafe(binDir).sort().reverse()) {
    const candidate = path.join(binDir, entry);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() && entry.startsWith('umid-')) {
      candidates.push({ path: path.join(candidate, umidBinaryName()), source: 'cli' });
    } else if (entry.startsWith('runtime-info')) {
      candidates.push({ path: candidate, source: 'cli' });
    }
  }

  if (options.dataDir) {
    candidates.push({ path: path.join(options.dataDir, 'umid', region, umidBinaryName()), source: 'data' });
  }

  for (const candidate of candidates) {
    tried.push(candidate.path);
    if (isFile(candidate.path)) return { path: candidate.path, source: candidate.source, tried };
  }
  return { path: null, source: 'none', tried };
}

export const QODER_DEFAULT_RETRY = { maxAttempts: 3, baseDelayMs: 2000, maxDelayMs: 60000 };
export const QODER_DEFAULT_WINDOW_RETRY = { enabled: true, max: 6, gapMs: 600_000 };

export function defaultQoderConfig(overrides: Partial<QoderConfig> = {}): QoderConfig {
  const dataDir = overrides.dataDir || qoderDataDir();
  const { retry, windowRetry, ...rest } = overrides;
  return {
    dataDir,
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    requestTimeoutMs: 20000,
    verifyDelayMs: 2000,
    regions: REGION_IDS,
    clientExe: {},
    umidPath: {},
    allowUmidDownload: false,
    verbose: true,
    ...rest,
    retry: { ...QODER_DEFAULT_RETRY, ...(retry || {}) },
    windowRetry: { ...QODER_DEFAULT_WINDOW_RETRY, ...(windowRetry || {}) },
  };
}

const CONFIG_FILES = ['qoder.config.json'];

/** 读取 qoder.config.json 并与默认值合并。 */
export function loadQoderConfig(options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): QoderConfig {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const dataDir = qoderDataDir();

  const candidates: string[] = [];
  if (env.QODER_CHECKIN_CONFIG) candidates.push(env.QODER_CHECKIN_CONFIG);
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
      /* 不存在或非法则继续 */
    }
  }

  const config = defaultQoderConfig({ dataDir });
  if (typeof raw.timezone === 'string' && raw.timezone.trim()) config.timezone = raw.timezone.trim();
  if (Array.isArray(raw.checkTimes)) {
    const times = raw.checkTimes.map((t) => String(t).trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    if (times.length) config.checkTimes = times;
  }
  if (Number.isFinite(Number(raw.requestTimeoutMs))) config.requestTimeoutMs = Math.max(1000, Number(raw.requestTimeoutMs));
  if (Number.isFinite(Number(raw.verifyDelayMs))) config.verifyDelayMs = Math.max(0, Number(raw.verifyDelayMs));
  if (raw.verbose === false) config.verbose = false;
  if (raw.allowUmidDownload === true) config.allowUmidDownload = true;
  if (Array.isArray(raw.regions)) {
    const list = raw.regions.map(normalizeRegion);
    config.regions = [...new Set(list)];
  }
  if (raw.retry && typeof raw.retry === 'object') {
    const retry = raw.retry as Record<string, unknown>;
    if (Number.isFinite(Number(retry.maxAttempts))) config.retry.maxAttempts = Math.max(1, Math.min(10, Number(retry.maxAttempts)));
    if (Number.isFinite(Number(retry.baseDelayMs))) config.retry.baseDelayMs = Math.max(100, Number(retry.baseDelayMs));
    if (Number.isFinite(Number(retry.maxDelayMs))) config.retry.maxDelayMs = Math.max(1000, Number(retry.maxDelayMs));
  }
  if (raw.windowRetry && typeof raw.windowRetry === 'object') {
    const window = raw.windowRetry as Record<string, unknown>;
    if (window.enabled === false) config.windowRetry.enabled = false;
    if (Number.isFinite(Number(window.max))) config.windowRetry.max = Math.max(1, Math.min(12, Number(window.max)));
    if (Number.isFinite(Number(window.gapMs))) config.windowRetry.gapMs = Math.max(10_000, Number(window.gapMs));
  }
  for (const key of ['clientExe', 'umidPath'] as const) {
    const value = raw[key];
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) config[key][normalizeRegion(k)] = v.trim();
      }
    }
  }
  config.usedConfigPath = usedPath;
  return config;
}

/** CLI 展示用配置摘要。 */
export function describeQoderConfig(config: QoderConfig): Record<string, unknown> {
  return {
    dataDir: config.dataDir,
    timezone: config.timezone,
    checkTimes: config.checkTimes,
    regions: config.regions.map((r) => ({ region: r, label: REGIONS[r].label, base: REGIONS[r].base })),
    windowRetry: config.windowRetry,
    requestTimeoutMs: config.requestTimeoutMs,
    allowUmidDownload: config.allowUmidDownload,
    configFile: config.usedConfigPath ?? null,
    appSupport: appSupportDir(),
  };
}
