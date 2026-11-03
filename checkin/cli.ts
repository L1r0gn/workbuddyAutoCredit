#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   npm run checkin:status    查询账号与积分状态
 *   npm run checkin:run       执行当前登录账号签到
 *   npm run checkin:all       执行所有已配置账号签到
 *   npm run checkin:dry-run   模拟签到（不调用领取接口）
 *   npm run checkin:daemon    启动后台定时服务
 */
import * as path from 'node:path';
import { currentAccounts, describeAccount, findAccounts } from './account-manager';
import { createRuntime, confirmIdentity, type Runtime } from './index';
import { loadConfig } from './config';
import { beijingDate } from './logger';
import { PidFile, Scheduler } from './scheduler';
import type { AccountContext, AccountStatusView, BatchResult, CheckinConfig, CheckinRecord } from './types';

interface ParsedArgs {
  command: string;
  flags: Set<string>;
  values: Map<string, string>;
}

const KNOWN_VALUE_FLAGS = new Set(['account', 'config', 'data-dir']);

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const [rawName, inlineValue] = arg.slice(2).split('=', 2) as [string, string | undefined];
      const name = rawName.toLowerCase();
      if (inlineValue !== undefined) {
        values.set(name, inlineValue);
        continue;
      }
      if (KNOWN_VALUE_FLAGS.has(name)) {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          values.set(name, next);
          i++;
          continue;
        }
      }
      flags.add(name);
      continue;
    }
    positional.push(arg);
  }
  return { command: positional[0] || 'help', flags, values };
}

function printConfig(runtime: Runtime): void {
  const summary = runtime.summary;
  console.log('运行配置：');
  console.log(`  数据目录      ${summary.dataDir}`);
  console.log(`  凭据目录      ${summary.extensionAuthDir}`);
  console.log(`  时区 / 检查点 ${summary.timezone} / ${(summary.checkTimes as string[]).join(', ')}`);
  console.log(`  客户端缺失时  ${summary.clientMissing}`);
  console.log(`  令牌自动刷新  ${summary.allowTokenRefresh ? '开启（仅内存生效）' : '关闭'}`);
  if (summary.configFile) console.log(`  配置文件      ${summary.configFile}`);
}

function formatCredits(value: number | null): string {
  if (value === null) return '—';
  return value.toFixed(2);
}

function printStatusTable(views: AccountStatusView[]): void {
  if (!views.length) {
    console.log('没有发现任何账号。请确认已在 WorkBuddy 客户端登录。');
    return;
  }
  const today = views[0]?.today.date || beijingDate();
  console.log(`\n账号状态（${today}，北京时间）`);
  const rows = views.map((view, index) => ({
    '#': String(index + 1),
    账号: view.accountTag,
    昵称: view.nickname || '—',
    客户端: view.profile === 'workbuddy-ai' ? 'AI' : 'CN',
    当前: view.isCurrent ? '是' : '',
    凭据: view.hasCredential ? (view.tokenExpired ? '已过期' : '有效') : '不可用',
    今日签到: view.today.ok ? `已完成(${view.today.outcome})` : view.today.outcome ? `未完成(${view.today.outcome})` : '无记录',
    积分: view.credits === null ? (view.creditsError ? '查询失败' : '—') : formatCredits(view.credits),
  }));
  printTable(rows);
  for (const view of views) {
    const issues = [...new Set([view.credentialError, view.creditsError].filter(Boolean))];
    if (issues.length) console.log(`  ⚠ ${view.accountTag}: ${issues.join('；')}`);
  }
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

/** 中文字符按 2 列宽度估算。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(char) ? 2 : 1;
  return width;
}

function padRight(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function printRecord(record: CheckinRecord): void {
  const label =
    record.outcome === 'dry-run'
      ? '模拟'
      : record.outcome === 'skipped'
        ? '跳过'
        : record.ok
          ? '成功'
          : '未完成';
  console.log(
    `  ${record.accountTag}  ${record.outcome.padEnd(14)} ${label}  code=${record.code ?? '—'}  ` +
      `积分 ${formatCredits(record.creditsBefore)} → ${formatCredits(record.creditsAfter)}` +
      (record.creditsDelta === null ? '' : ` (${record.creditsDelta >= 0 ? '+' : ''}${record.creditsDelta})`) +
      `  验证=${record.verification}`,
  );
  if (record.message) console.log(`      服务端：${record.message}`);
  if (record.diagnostic) console.log(`      诊断：${record.diagnostic}`);
}

function printBatch(result: BatchResult): void {
  console.log(`\n批量结果（${result.date}）`);
  if (!result.records.length) {
    console.log('  没有账号参与本次执行。');
    return;
  }
  for (const record of result.records) printRecord(record);
  const { summary } = result;
  console.log(
    `\n合计 ${summary.total}：新领取 ${summary.checkedIn}，已签到 ${summary.already}，跳过 ${summary.skipped}，` +
      `模拟 ${summary.dryRun}，失败 ${summary.failed}`,
  );
}

function selectAccounts(runtime: Runtime, args: ParsedArgs, mode: 'current' | 'all'): AccountContext[] {
  const all = runtime.accounts();
  const selector = args.values.get('account');
  if (selector) {
    const picked = findAccounts(all, selector);
    if (!picked.length) {
      throw new Error(`未找到匹配账号：${selector}（可用 checkin:status 查看账号标签）`);
    }
    return picked;
  }
  if (mode === 'all') return all;
  const currents = currentAccounts(all);
  const usable = currents.filter((account) => account.credentials) || [];
  if (usable.length) return usable.slice(0, 1);
  if (currents.length) return currents.slice(0, 1);
  throw new Error('没有检测到当前登录账号，请先在 WorkBuddy 客户端登录');
}

function exitCodeFor(result: BatchResult): number {
  const failed = result.records.filter((record) => !record.ok && record.outcome !== 'dry-run' && record.outcome !== 'skipped');
  return failed.length ? 1 : 0;
}

async function commandStatus(runtime: Runtime, args: ParsedArgs): Promise<number> {
  const accounts = selectAccountsSafe(runtime, args);
  const views = await runtime.service.status(accounts, { skipCredits: args.flags.has('offline') });
  if (args.flags.has('json')) {
    console.log(JSON.stringify({ date: beijingDate(), accounts: views }, null, 2));
    return 0;
  }
  printConfig(runtime);
  printStatusTable(views);

  // CDP 状态只做诊断，失败不影响退出码
  if (!args.flags.has('no-cdp') && !args.flags.has('json')) {
    const cdp = runtime.cdp();
    const status = await cdp.connect();
    cdp.disconnect();
    console.log(
      `\nCDP：${status.connected ? `已连接 端口 ${status.port}` : `未连接（${status.error}）`}` +
        (status.targetUrl ? `\n  目标页：${status.targetUrl}` : ''),
    );
  }
  return 0;
}

/** status 不因"没有当前账号"而失败，改为列出全部账号。 */
function selectAccountsSafe(runtime: Runtime, args: ParsedArgs): AccountContext[] {
  const all = runtime.accounts();
  const selector = args.values.get('account');
  if (selector) {
    const picked = findAccounts(all, selector);
    if (!picked.length) throw new Error(`未找到匹配账号：${selector}`);
    return picked;
  }
  const currents = currentAccounts(all);
  return currents.length ? currents : all;
}

async function commandRun(runtime: Runtime, args: ParsedArgs, options: { all?: boolean; dryRun?: boolean } = {}): Promise<number> {
  const accounts = selectAccounts(runtime, args, options.all ? 'all' : 'current');
  const force = args.flags.has('force');

  // 账号切换保护：逐个账号执行前重新扫描并核对 uid，避免把积分领到别的账号
  const records: CheckinRecord[] = [];
  for (const account of accounts) {
    const fresh = runtime.accounts();
    const identity = confirmIdentity(fresh, account.uid);
    if (!identity.ok || !identity.account) {
      console.error(`  ✗ ${account.accountTag}：${identity.reason || '身份确认失败'}`);
      continue;
    }
    const record = await runtime.service.checkin(identity.account, {
      ...(options.dryRun ? { dryRun: true } : {}),
      ...(force ? { force: true } : {}),
    });
    records.push(record);
  }

  const result: BatchResult = {
    date: records[0]?.date || beijingDate(),
    startedAt: records[0]?.startedAt || Date.now(),
    finishedAt: Date.now(),
    records,
    summary: {
      total: records.length,
      checkedIn: records.filter((r) => r.outcome === 'checked-in').length,
      already: records.filter((r) => r.outcome === 'already').length,
      skipped: records.filter((r) => r.outcome === 'skipped').length,
      dryRun: records.filter((r) => r.outcome === 'dry-run').length,
      failed: records.filter((r) => !r.ok && r.outcome !== 'dry-run').length,
    },
  };

  if (args.flags.has('json')) {
    console.log(JSON.stringify(result, null, 2));
    return exitCodeFor(result);
  }
  printBatch(result);
  return exitCodeFor(result);
}


/** 检测统一调度器是否在运行（避免两套调度同一天各跑一轮）。 */
function unifiedDaemonRunning(dataDir: string): number | null {
  return readLivePid(path.join(dataDir, 'unified-daemon.pid'));
}

/** 读取 pid 文件并判断进程是否存活。 */
function readLivePid(file: string): number | null {
  try {
    const fs2 = require('node:fs') as typeof import('node:fs');
    const pid = Number(fs2.readFileSync(file, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function commandDaemon(runtime: Runtime, args: ParsedArgs): Promise<number> {
  const pidFile = new PidFile(runtime.config.dataDir);
  const unified = unifiedDaemonRunning(runtime.config.dataDir);
  if (unified) {
    console.error(`统一定时服务正在运行（pid ${unified}），它已包含 WorkBuddy 任务；请先停止它再单独启动本 daemon。`);
    return 3;
  }
  const existing = pidFile.existing();
  if (existing) {
    console.error(`已有定时服务在运行（pid ${existing}），如需重启请先停止该进程。`);
    return 3;
  }
  pidFile.write();
  const scheduler = new Scheduler({
    config: runtime.config,
    logger: runtime.logger,
    service: runtime.service,
    accounts: () => runtime.accounts(),
    onBatch: (result) => printBatch(result),
  });

  const shutdown = (signal: string): void => {
    runtime.logger.info(`收到 ${signal}，正在停止定时服务`);
    scheduler.stop();
    pidFile.clear();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 兜底：任何正常退出路径都清掉 pid 文件（Windows 上被强杀时可能残留，下次启动会自动覆盖）
  process.on('exit', () => pidFile.clear());

  console.log(
    `定时服务已启动（pid ${process.pid}，时区 ${runtime.config.timezone}，检查点 ${runtime.config.checkTimes.join(', ')}）`,
  );
  console.log(`日志目录：${runtime.config.dataDir}`);
  try {
    await scheduler.runForever({ ...(args.flags.has('dry-run') ? { dryRun: true } : {}) });
  } finally {
    pidFile.clear();
  }
  return 0;
}

function printHelp(): void {
  console.log(`WorkBuddy 每日积分自动签到

用法：
  npm run checkin:status   [--json] [--offline] [--account <uid|标签|序号>] [--no-cdp]
  npm run checkin:run      [--account ...] [--force] [--json]
  npm run checkin:all      [--account ...] [--force] [--json]
  npm run checkin:dry-run  [--account ...] [--json]
  npm run checkin:daemon   [--dry-run]

参数：
  --json     输出机器可读 JSON
  --offline  不查询积分（只读本地记录）
  --force    忽略本地"今日已成功"记录，强制走一次领取（服务端仍按天去重）
  --no-cdp   跳过 CDP 诊断
  --account  只处理指定账号（uid / 脱敏标签 / 昵称 / 序号）

环境变量：
  WORKBUDDY_EXE               客户端可执行文件路径（用于解密本机凭据）
  WORKBUDDY_CHECKIN_DATA_DIR  数据目录（默认 %APPDATA%\\workbuddy-auto-checkin）
  WORKBUDDY_CHECKIN_CONFIG    配置文件绝对路径
`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const jsonMode = args.flags.has('json');
  const baseConfig = loadConfig();
  const runtime = createRuntime({
    // --json 时关闭控制台事件输出，保证 stdout 只有一份可解析的 JSON
    config: { ...baseConfig, verbose: baseConfig.verbose && !jsonMode },
    scope: args.command === 'daemon' ? 'daemon' : 'cli',
  });

  switch (args.command) {
    case 'status':
      return commandStatus(runtime, args);
    case 'run':
      return commandRun(runtime, args);
    case 'all':
      return commandRun(runtime, args, { all: true });
    case 'dry-run':
      return commandRun(runtime, args, { all: true, dryRun: true });
    case 'daemon':
      return commandDaemon(runtime, args);
    case 'accounts': {
      const list = runtime.accounts().map(describeAccount);
      if (args.flags.has('json')) console.log(JSON.stringify(list, null, 2));
      else {
        console.log('已发现的账号：');
        for (const item of list) console.log(`  ${JSON.stringify(item)}`);
      }
      return 0;
    }
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
      const message = error instanceof Error ? error.message : String(error);
      console.error(`执行失败：${message}`);
      process.exitCode = 1;
    });
}

export type { CheckinConfig, AccountContext };
