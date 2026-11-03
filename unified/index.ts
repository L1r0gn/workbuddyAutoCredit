/**
 * 统一入口的装配层。
 *
 * 只做三件事：
 * 1. 各建一份平台运行时（互不共享状态，避免串号）；
 * 2. 把平台包装成适配器；
 * 3. 提供一个统一 logger + 调度器。
 *
 * 平台模块本身完全不知道"统一入口"的存在——编排是单向依赖，删掉 unified/ 不影响任何平台。
 */
import { createRuntime as createWorkBuddyRuntime, type Runtime as WorkBuddyRuntime } from '../checkin/index';
import { loadConfig } from '../checkin/config';
import { createQoderRuntime, type QoderRuntime } from '../qoder/index';
import { loadQoderConfig } from '../qoder/config';
import { Logger } from '../checkin/logger';
import { createAllAdapters } from './platforms';
import { UnifiedScheduler } from './scheduler';
import type { PlatformAdapter, PlatformId } from './types';

export interface UnifiedRuntime {
  workbuddy: WorkBuddyRuntime;
  qoder: QoderRuntime;
  adapters: PlatformAdapter[];
  logger: Logger;
  /** 数据目录（两个平台共用根目录） */
  dataDir: string;
  timezone: string;
  checkTimes: string[];
  /** 两个平台配置的检查时间不一致时的提示 */
  configWarning: string | null;
  scheduler: (options?: { now?: () => number; sleep?: (ms: number) => Promise<void> }) => UnifiedScheduler;
}

export interface UnifiedRuntimeOptions {
  /** 只装配指定平台 */
  platforms?: PlatformId[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 只读模式（status 用）：不查询积分/额度 */
  skipCredits?: boolean;
  /** 覆盖控制台日志开关（--json 时传 false，保证 stdout 只有 JSON） */
  verbose?: boolean;
  scope?: string;
}

const KNOWN_PLATFORMS: PlatformId[] = ['workbuddy', 'qoder-cn', 'qoder-global'];

/** 解析 `--platform` 参数：支持 workbuddy / qoder-cn / qoder-global / qoder（两个 Qoder 区域）/ all。 */
export function parsePlatformSelector(values: string[]): PlatformId[] | null {
  if (!values.length) return null;
  const picked = new Set<PlatformId>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if (!value || value === 'all') return null;
    if (value === 'qoder' || value === 'qoder-all') {
      picked.add('qoder-cn');
      picked.add('qoder-global');
      continue;
    }
    const matched = KNOWN_PLATFORMS.find((item) => item === value);
    if (!matched) throw new Error(`未知平台：${raw}（可用：workbuddy / qoder-cn / qoder-global / qoder / all）`);
    picked.add(matched);
  }
  return picked.size ? [...picked] : null;
}

export function createUnifiedRuntime(options: UnifiedRuntimeOptions = {}): UnifiedRuntime {
  const baseConfig = loadConfig();
  const workbuddy = createWorkBuddyRuntime({
    config: options.verbose === undefined ? baseConfig : { ...baseConfig, verbose: options.verbose },
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const qoder = createQoderRuntime({
    config: {
      ...loadQoderConfig(),
      dataDir: workbuddy.config.dataDir,
      // 统一入口下，Qoder 的检查时间跟随统一调度，避免两个时间点各跑一次
      verbose: workbuddy.config.verbose,
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    scope: 'qoder',
  });

  const logger = new Logger({
    logDir: workbuddy.config.dataDir,
    verbose: workbuddy.config.verbose,
    scope: options.scope || 'unified',
  });
  void options.skipCredits;

  const adapters = createAllAdapters({ workbuddy, qoder, platforms: options.platforms });

  const wbTimes = workbuddy.config.checkTimes.join(',');
  const qTimes = qoder.config.checkTimes.join(',');
  const configWarning = wbTimes === qTimes
    ? null
    : `两平台的检查时间配置不一致（WorkBuddy: ${wbTimes}，Qoder: ${qTimes}），统一调度按 WorkBuddy 的配置执行`;

  return {
    workbuddy,
    qoder,
    adapters,
    logger,
    dataDir: workbuddy.config.dataDir,
    timezone: workbuddy.config.timezone,
    checkTimes: workbuddy.config.checkTimes,
    configWarning,
    scheduler: (schedulerOptions = {}) =>
      new UnifiedScheduler({
        adapters,
        logger,
        timezone: workbuddy.config.timezone,
        checkTimes: workbuddy.config.checkTimes,
        ...(options.now ? { now: options.now } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...schedulerOptions,
      }),
  };
}

export * from './types';
export { createAllAdapters, createWorkBuddyAdapter, createQoderAdapter } from './platforms';
export { runAll, summarize, exitCodeFor } from './runner';
export { UnifiedScheduler, UnifiedPidFile, readLivePid } from './scheduler';
