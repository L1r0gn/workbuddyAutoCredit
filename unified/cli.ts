#!/usr/bin/env node
/**
 * 统一命令行入口：一个指令跑完三个签到任务。
 *
 *   npm run signin              依次执行 WorkBuddy / Qoder CN / Qoder 国际版
 *   npm run signin:status       三个平台的总览（只读）
 *   npm run signin:dry-run      全部模拟，不调用任何领取接口
 *   npm run signin:daemon       统一定时服务（每天 10:05）
 *
 * 需要单独控制某个平台时，仍然用原来的 platform CLI（checkin:* / qoder:*）。
 */
import * as path from 'node:path';
import { beijingDate } from '../checkin/logger';
import { QoderPidFile } from '../qoder/scheduler';
import { PidFile as WorkBuddyPidFile } from '../checkin/scheduler';
import { createUnifiedRuntime, exitCodeFor, parsePlatformSelector, UnifiedPidFile } from './index';
import type { PlatformOutcome, UnifiedResult } from './types';

interface Args {
  command: string;
  flags: Set<string>;
  values: Map<string, string>;
  multi: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(['platform', 'timeout']);
const MULTI_FLAGS = new Set(['platform']);

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  let command = 'run';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const [rawName, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      const name = rawName.toLowerCase();
      const push = (value: string): void => {
        const list = multi.get(name) || [];
        list.push(value);
        multi.set(name, list);
        values.set(name, value);
      };
      if (inline !== undefined) {
        push(inline);
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          push(next);
          i++;
          continue;
        }
      }
      flags.add(name);
      continue;
    }
    command = arg;
  }
  return { command, flags, values, multi };
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1;
  return width;
}

function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function printTable(rows: Array<Record<string, string>>): void {
  if (!rows.length) return;
  const columns = Object.keys(rows[0] as Record<string, string>);
  const widths = columns.map((col) => Math.max(displayWidth(col), ...rows.map((row) => displayWidth(row[col] ?? ''))));
  const line = (cells: string[]): string => cells.map((cell, i) => padRight(cell, widths[i] as number)).join('  ');
  console.log(line(columns));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(columns.map((col) => row[col] ?? '')));
}

const STATUS_LABEL: Record<PlatformOutcome['status'], string> = {
  ok: '完成',
  partial: '部分完成',
  failed: '失败',
  skipped: '已跳过',
  norun: '无账号',
  error: '异常',
};

function printOutcome(outcome: PlatformOutcome, index: number, total: number): void {
  console.log(`\n[${index}/${total}] ${outcome.label}`);
  if (outcome.status === 'skipped') {
    console.log(`  ⏭  ${outcome.detail}（${outcome.durationMs}ms，无网络请求）`);
    return;
  }
  if (outcome.status === 'norun') {
    console.log(`  ○  ${outcome.detail}`);
    return;
  }
  const icon = outcome.status === 'ok' ? '✅' : outcome.status === 'error' || outcome.status === 'failed' ? '❌' : '⚠️';
  console.log(`  ${icon} ${STATUS_LABEL[outcome.status]}｜账号 ${outcome.accounts}｜${outcome.detail}｜${outcome.durationMs}ms`);
  if (outcome.error) console.log(`     错误：${outcome.error}`);
  const records = Array.isArray(outcome.records) ? outcome.records : [];
  for (const record of records.slice(0, 12)) {
    const item = record as Record<string, unknown>;
    const label = String(item.accountTag ?? item.note ?? '?');
    const state = String(item.outcome ?? '?');
    const amount = item.claimedAmount ?? item.campaignAmount ?? item.creditsDelta ?? null;
    console.log(`     · ${label}  ${state}${amount === null ? '' : `  ${String(amount)}`}`);
  }
}

function printResult(result: UnifiedResult): void {
  console.log(`\n══ 全部签到结果（${result.date}${result.dryRun ? '，模拟' : ''}）══`);
  result.outcomes.forEach((outcome, index) => printOutcome(outcome, index + 1, result.outcomes.length));
  const s = result.summary;
  console.log(
    `\n汇总：平台 ${s.platforms}（完成 ${s.ok}｜部分 ${s.partial}｜失败 ${s.failed}｜跳过 ${s.skipped}｜无账号 ${s.norun}｜异常 ${s.error}）` +
      `\n      账号 ${s.accounts}，新领取 ${s.claimed}，已领取 ${s.already}，跳过 ${s.skippedAccounts}，失败 ${s.failedAccounts}` +
      (s.unavailableAccounts ? `（其中不可用 ${s.unavailableAccounts}）` : '') +
      `\n      总耗时 ${((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s`,
  );
}

async function commandRun(args: Args, dryRun: boolean): Promise<number> {
  const platforms = parsePlatformSelector(args.multi.get('platform') || []);
  const json = args.flags.has('json');
  const runtime = createUnifiedRuntime({
    platforms: platforms || undefined,
    // --json 时关闭控制台事件，保证 stdout 只有一份 JSON
    ...(json ? { verbose: false } : {}),
  });
  if (runtime.configWarning) console.error(`警告：${runtime.configWarning}`);

  const timeoutSeconds = Number(args.values.get('timeout'));
  const result = await runtime.scheduler().runOnce({
    ...(dryRun ? { dryRun: true } : {}),
    ...(args.flags.has('force') ? { force: true } : {}),
    ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { timeoutMs: timeoutSeconds * 1000 } : {}),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }
  return exitCodeFor(result);
}

async function commandStatus(args: Args): Promise<number> {
  const platforms = parsePlatformSelector(args.multi.get('platform') || []);
  const runtime = createUnifiedRuntime({ platforms: platforms || undefined });
  const date = beijingDate();
  const rows: Array<Record<string, string>> = [];

  for (const adapter of runtime.adapters) {
    const has = adapter.hasAccounts();
    const done = has && adapter.doneToday(date);
    let accounts = 0;
    let note = '';
    if (adapter.meta.id === 'workbuddy') {
      const list = runtime.workbuddy.accounts().filter((account) => !!account.uid && !!account.credentials);
      accounts = list.length;
      const outcomes = list.map((account) => runtime.workbuddy.store.getRecord(account.uid, date)?.outcome ?? '无记录');
      note = [...new Set(outcomes)].join('/');
    } else {
      const region = adapter.meta.id === 'qoder-cn' ? 'cn' : 'global';
      const list = runtime.qoder.accounts().filter((account) => account.region === region);
      accounts = list.length;
      const outcomes = list.map((account) => runtime.qoder.store.getRecord(account.id, date)?.outcome ?? '无记录');
      note = [...new Set(outcomes)].join('/');
    }
    rows.push({
      平台: adapter.meta.label,
      账号: String(accounts),
      今日: !has ? '无账号' : done ? '已完成' : '未完成',
      最近结果: note || '—',
    });
  }

  console.log(`统一签到总览（${date}，北京时间）`);
  printTable(rows);
  console.log(`\n时区 ${runtime.timezone}｜检查点 ${runtime.checkTimes.join(', ')}｜数据目录 ${runtime.dataDir}`);
  console.log('配置提示：');
  console.log('  WorkBuddy 账号来自本机客户端登录态；Qoder 账号需先执行 npm run qoder:login -- --region cn|global');
  if (!runtime.adapters.some((adapter) => adapter.meta.id === 'workbuddy' && adapter.hasAccounts())) {
    console.log('  ⚠ 未发现可用的 WorkBuddy 账号（请确认客户端已登录）');
  }
  for (const id of ['qoder-cn', 'qoder-global'] as const) {
    const adapter = runtime.adapters.find((item) => item.meta.id === id);
    if (adapter && !adapter.hasAccounts()) {
      console.log(`  ⚠ ${adapter.meta.label} 暂无账号（npm run qoder:login -- --region ${id === 'qoder-cn' ? 'cn' : 'global'}）`);
    }
  }
  return 0;
}

function assertNoPlatformDaemon(dataDir: string): string | null {
  const wb = new WorkBuddyPidFile(dataDir).existing();
  if (wb) return `检测到 WorkBuddy 平台 daemon 正在运行（pid ${wb}，${path.join(dataDir, 'daemon.pid')}）`;
  const qoder = new QoderPidFile(dataDir).existing();
  if (qoder) return `检测到 Qoder 平台 daemon 正在运行（pid ${qoder}，${path.join(dataDir, 'qoder-daemon.pid')}）`;
  return null;
}

async function commandDaemon(args: Args): Promise<number> {
  const runtime = createUnifiedRuntime();
  const pidFile = new UnifiedPidFile(runtime.dataDir);
  const existing = pidFile.existing();
  if (existing) {
    console.error(`已有统一定时服务在运行（pid ${existing}），如需重启请先停止该进程。`);
    return 3;
  }
  const conflict = assertNoPlatformDaemon(runtime.dataDir);
  if (conflict) {
    console.error(`${conflict}。\n统一调度已覆盖三个平台，请先停止该 daemon 再启动统一服务（否则同一天会跑两轮）。`);
    return 3;
  }

  pidFile.write();
  const scheduler = runtime.scheduler();
  const shutdown = (signal: string): void => {
    runtime.logger.info(`收到 ${signal}，停止统一定时服务`);
    scheduler.stop();
    pidFile.clear();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => pidFile.clear());

  console.log(
    `统一定时服务已启动（pid ${process.pid}，时区 ${runtime.timezone}，检查点 ${runtime.checkTimes.join(', ')}）`,
  );
  console.log(`平台：${runtime.adapters.map((adapter) => adapter.meta.label).join(' / ')}`);
  console.log(`日志目录：${runtime.dataDir}`);
  try {
    await scheduler.runForever({ ...(args.flags.has('dry-run') ? { dryRun: true } : {}) });
  } finally {
    pidFile.clear();
  }
  return 0;
}

function printHelp(): void {
  console.log(`每日签到统一入口（WorkBuddy + Qoder CN + Qoder 国际版）

用法：
  npm run signin                 一次性执行全部三个任务
  npm run signin:status          总览（只读：账号数、今日状态、最近结果）
  npm run signin:dry-run         全部模拟（不调用任何领取接口）
  npm run signin:daemon          统一定时服务（默认每天 10:05 北京时间）

参数：
  --platform <id>   只跑指定平台：workbuddy / qoder-cn / qoder-global / qoder / all
                    可重复，例如 --platform qoder-cn --platform workbuddy
  --dry-run         模拟执行（等价于 signin:dry-run）
  --force           忽略"今日已完成"记录，强制再确认一次（服务端仍按天去重）
  --json            输出机器可读 JSON
  --timeout <秒>    单平台超时（默认 1200 秒）

单独控制某个平台（功能完全不变）：
  npm run checkin:status / checkin:run / checkin:all / checkin:dry-run / checkin:daemon
  npm run qoder:login / qoder:accounts / qoder:status / qoder:run / qoder:dry-run / qoder:refresh / qoder:daemon
`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'run':
    case 'all':
      return commandRun(args, args.flags.has('dry-run'));
    case 'dry-run':
      return commandRun(args, true);
    case 'status':
      return commandStatus(args);
    case 'daemon':
      return commandDaemon(args);
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error(`未知命令：${args.command}\n`);
      printHelp();
      return 2;
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`执行失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
