#!/usr/bin/env node
/**
 * Qoder 命令行入口。
 *
 *   npm run qoder:login   -- --region cn|global   设备码授权登录（浏览器确认一次）
 *   npm run qoder:accounts                        列出账号 / 添加 / 删除
 *   npm run qoder:status                          账号、设备身份、今日状态、额度
 *   npm run qoder:run                             执行签到（可 --region / --account）
 *   npm run qoder:all                             所有账号
 *   npm run qoder:dry-run                         模拟（不调用领取）
 *   npm run qoder:refresh                         只续期令牌
 *   npm run qoder:daemon                          每日定时服务
 */
import * as path from 'node:path';
import { loadConfig } from '../checkin/index';
import { beijingDate } from '../checkin/logger';
import { describeAccount, selectAccounts } from './accounts';
import { loadQoderConfig, normalizeRegion, REGIONS } from './config';
import { createQoderRuntime, importAccount, loginAccount, type QoderRuntime } from './index';
import { openInBrowser } from './auth';
import { QoderPidFile, QoderScheduler } from './scheduler';
import type { QoderAccount, QoderAccountView, QoderBatchResult, QoderCheckinRecord, QoderRegion } from './types';

interface ParsedArgs {
  command: string;
  sub: string;
  flags: Set<string>;
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set(['region', 'note', 'access', 'refresh', 'uid', 'account', 'id', 'config']);

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const [rawName, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      const name = rawName.toLowerCase();
      if (inline !== undefined) {
        values.set(name, inline);
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
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
  return { command: positional[0] || 'help', sub: positional[1] || '', flags, values };
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

function regionOf(args: ParsedArgs): QoderRegion[] | undefined {
  const region = args.values.get('region');
  if (!region) return undefined;
  return [normalizeRegion(region)];
}

function pickAccounts(runtime: QoderRuntime, args: ParsedArgs): QoderAccount[] {
  const all = runtime.accounts();
  const selector = args.values.get('account');
  if (selector) {
    const picked = selectAccounts(all, selector);
    if (!picked.length) throw new Error(`未找到匹配账号：${selector}（可先执行 qoder:accounts 查看）`);
    return picked;
  }
  const region = args.values.get('region');
  if (region) {
    const picked = selectAccounts(all, normalizeRegion(region));
    if (!picked.length) throw new Error(`${REGIONS[normalizeRegion(region)].label} 没有配置账号`);
    return picked;
  }
  return all;
}

function printConfig(runtime: QoderRuntime): void {
  const summary = runtime.summary;
  console.log('Qoder 运行配置：');
  console.log(`  数据目录      ${summary.dataDir}`);
  console.log(`  时区 / 检查点 ${summary.timezone} / ${(summary.checkTimes as string[]).join(', ')}`);
  const regions = summary.regions as Array<{ region: QoderRegion; label: string; base: string }>;
  for (const item of regions) console.log(`  ${item.label.padEnd(12)} ${item.base}`);
  const window = summary.windowRetry as { enabled: boolean; max: number; gapMs: number };
  console.log(`  窗口重试      ${window.enabled ? `开启（最多 ${window.max} 次 / 间隔 ${Math.round(window.gapMs / 1000)}s）` : '关闭'}`);
  if (summary.configFile) console.log(`  配置文件      ${summary.configFile}`);
}

function printViews(views: QoderAccountView[]): void {
  if (!views.length) {
    console.log('没有可用的 Qoder 账号。先执行：npm run qoder:login -- --region cn');
    return;
  }
  console.log(`\nQoder 账号状态（${views[0]?.today.date || beijingDate()}，北京时间）`);
  printTable(
    views.map((view, index) => ({
      '#': String(index + 1),
      区域: view.region === 'cn' ? 'CN' : '国际',
      备注: view.note,
      标识: view.accountTag,
      令牌: view.tokenMasked,
      续期: view.hasRefresh ? '支持' : '缺少',
      设备身份: view.device.umidAvailable ? '可用' : '缺少组件',
      今日: view.today.ok ? `已完成(${view.today.outcome})` : view.today.outcome ? `未完成(${view.today.outcome})` : '无记录',
      额度: view.credits === null ? (view.creditsError ? '查询失败' : '—') : view.credits.toFixed(2),
    })),
  );
  for (const view of views) {
    const issues = [...new Set([view.device.umidError, view.creditsError].filter(Boolean))];
    if (issues.length) console.log(`  ⚠ ${view.note}: ${issues.join('；')}`);
  }
}

function printRecord(record: QoderCheckinRecord): void {
  const label =
    record.outcome === 'dry-run'
      ? '模拟'
      : record.outcome === 'skipped'
        ? '跳过'
        : record.ok
          ? '成功'
          : '未完成';
  const amount = record.claimedAmount ?? record.campaignAmount;
  console.log(
    `  ${record.accountTag}  ${record.outcome.padEnd(15)} ${label}  ` +
      (amount ? `面值 ${amount}  ` : '') +
      `额度 ${record.creditsBefore ?? '—'} → ${record.creditsAfter ?? '—'}` +
      (record.creditsDelta === null ? '' : ` (${record.creditsDelta >= 0 ? '+' : ''}${record.creditsDelta})`) +
      `  验证=${record.verification}`,
  );
  if (record.message) console.log(`      说明：${record.message}`);
  if (record.diagnostic) console.log(`      诊断：${record.diagnostic}`);
}

function printBatch(result: QoderBatchResult): void {
  console.log(`\nQoder 批量结果（${result.date}）`);
  if (!result.records.length) {
    console.log('  没有账号参与本次执行。');
    return;
  }
  for (const record of result.records) printRecord(record);
  const s = result.summary;
  console.log(
    `\n合计 ${s.total}：新领取 ${s.claimed}，已领取 ${s.already}，跳过 ${s.skipped}，` +
      `无活动 ${s.noCampaign}，模拟 ${s.dryRun}，失败 ${s.failed}`,
  );
}

function exitCode(result: QoderBatchResult): number {
  return result.summary.failed > 0 ? 1 : 0;
}

async function commandLogin(runtime: QoderRuntime, args: ParsedArgs): Promise<number> {
  const region = normalizeRegion(args.values.get('region'));
  const note = args.values.get('note');
  const noOpen = args.flags.has('no-open');
  console.log(`开始 ${REGIONS[region].label} 设备授权登录（浏览器里确认一次即可，无需密码/验证码）`);

  let printed = false;
  const showUrl = (url: string): void => {
    if (printed) return;
    printed = true;
    console.log('');
    console.log('授权链接（有效期约 5 分钟）：');
    console.log(`  ${url}`);
    console.log('');
  };

  const result = await loginAccount({
    region,
    ...(note ? { note } : {}),
    store: runtime.store,
    logger: runtime.logger,
    onAuthUrl: showUrl,
    onPoll: (attempt) => {
      // 每 15 次（默认 30 秒）报一次进度，避免长时间无输出让人以为卡死
      if (attempt % 15 !== 0) return;
      const seconds = attempt * 2;
      console.log(`  …仍在等待浏览器确认（已 ${seconds} 秒）。若没有弹出浏览器，请手动打开上面的链接。`);
    },
    ...(noOpen
      ? { openBrowser: (): boolean => false }
      : {
          // 把"用哪种方式打开"回报给用户，避免出现"以为开了浏览器其实没开"
          openBrowser: async (url: string) => {
            const opened = await openInBrowser(url);
            if (opened.opened) {
              console.log(`已请求系统用默认浏览器打开（方式：${opened.method}）；若没看到页面，请手动打开上面的链接。`);
            } else {
              console.log(`未能自动打开浏览器（${opened.error || '未知原因'}），请手动打开上面的链接。`);
            }
            return opened;
          },
        }),
    timeoutMs: 300_000,
  });

  if (!result.ok || !result.account) {
    console.error(`\n✗ 授权失败：${result.error}`);
    console.error('  可以重新运行本命令，或手动打开下面的链接后再重试：');
    console.error(`  ${result.authUrl}`);
    return 1;
  }
  console.log(`\n✅ 已保存账号：${result.account.note}（${result.account.id}）`);
  if (!result.account.uid) {
    console.log('  提示：上游未返回 uid，已用令牌指纹作为账号标识，不影响签到。');
  }
  return 0;
}

async function commandAccounts(runtime: QoderRuntime, args: ParsedArgs): Promise<number> {
  if (args.sub === 'add') {
    const access = args.values.get('access') || '';
    const refresh = args.values.get('refresh') || '';
    if (!access) throw new Error('缺少 --access（access_token）');
    const account = importAccount({
      store: runtime.store,
      region: args.values.get('region') || 'cn',
      access,
      ...(refresh ? { refresh } : {}),
      ...(args.values.get('uid') ? { uid: args.values.get('uid') as string } : {}),
      ...(args.values.get('note') ? { note: args.values.get('note') as string } : {}),
    });
    console.log(`✅ 已写入账号 ${account.note}（${account.id}）`);
    return 0;
  }
  if (args.sub === 'remove') {
    const selector = args.values.get('account') || args.values.get('id') || '';
    const target = selectAccounts(runtime.accounts(), selector)[0];
    if (!target) throw new Error(`未找到账号：${selector}`);
    const removed = runtime.store.removeAccount(target.id);
    console.log(removed ? `✅ 已删除 ${target.note}（${target.id}）` : '✗ 删除失败');
    return removed ? 0 : 1;
  }

  const list = runtime.accounts().map(describeAccount);
  if (args.flags.has('json')) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (!list.length) {
    console.log('还没有 Qoder 账号。');
    console.log('  方式一：npm run qoder:login -- --region cn');
    console.log('  方式二：设置环境变量 QODER_TOKENS / QODER_GLOBAL_TOKENS');
    console.log('  方式三：npm run qoder:accounts -- add --region cn --access dt-xxx --refresh drt-xxx');
    return 0;
  }
  printTable(
    runtime.accounts().map((account, index) => ({
      '#': String(index + 1),
      区域: account.region === 'cn' ? 'CN' : '国际',
      备注: account.note,
      ID: account.id,
      UID: account.uid || '—',
      来源: account.source,
      令牌: String(describeAccount(account).token),
    })),
  );
  return 0;
}

async function commandStatus(runtime: QoderRuntime, args: ParsedArgs): Promise<number> {
  const accounts = runtime.accounts();
  const views = await runtime.service.status(accounts, { skipCredits: args.flags.has('offline') });
  if (args.flags.has('json')) {
    console.log(JSON.stringify({ date: beijingDate(), accounts: views }, null, 2));
    return 0;
  }
  printConfig(runtime);
  printViews(views);
  return 0;
}

async function commandRun(runtime: QoderRuntime, args: ParsedArgs, options: { dryRun?: boolean } = {}): Promise<number> {
  const accounts = pickAccounts(runtime, args);
  const records: QoderCheckinRecord[] = [];
  for (const account of accounts) {
    // 每次执行前重新从存储读取，确保用的是最新令牌（可能刚被续期轮换）
    const fresh = runtime.store.getAccount(account.id) || account;
    records.push(
      await runtime.service.checkin(fresh, {
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(args.flags.has('force') ? { force: true } : {}),
      }),
    );
  }
  const result: QoderBatchResult = {
    date: records[0]?.date || beijingDate(),
    startedAt: records[0]?.at || Date.now(),
    finishedAt: Date.now(),
    records,
    summary: {
      total: records.length,
      claimed: records.filter((r) => r.outcome === 'claimed').length,
      already: records.filter((r) => r.outcome === 'already').length,
      skipped: records.filter((r) => r.outcome === 'skipped').length,
      dryRun: records.filter((r) => r.outcome === 'dry-run').length,
      noCampaign: records.filter((r) => r.outcome === 'no-campaign').length,
      failed: records.filter((r) => !r.ok && r.outcome !== 'dry-run' && r.outcome !== 'skipped' && r.outcome !== 'no-campaign').length,
    },
  };
  if (args.flags.has('json')) {
    console.log(JSON.stringify(result, null, 2));
    return exitCode(result);
  }
  printBatch(result);
  return exitCode(result);
}

async function commandRefresh(runtime: QoderRuntime, args: ParsedArgs): Promise<number> {
  const accounts = pickAccounts(runtime, args);
  let failed = 0;
  for (const account of accounts) {
    const fresh = runtime.store.getAccount(account.id) || account;
    const result = await runtime.service.refreshAccount(fresh);
    if (result.ok) console.log(`  ✅ ${fresh.note}（${REGIONS[fresh.region].label}）令牌已续期并保存`);
    else {
      failed += 1;
      console.log(`  ✗ ${fresh.note}：${result.error}`);
    }
  }
  return failed > 0 ? 1 : 0;
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

async function commandDaemon(runtime: QoderRuntime, args: ParsedArgs): Promise<number> {
  const pidFile = new QoderPidFile(runtime.config.dataDir);
  const unified = unifiedDaemonRunning(runtime.config.dataDir);
  if (unified) {
    console.error(`统一定时服务正在运行（pid ${unified}），它已包含 Qoder 任务；请先停止它再单独启动本 daemon。`);
    return 3;
  }
  const existing = pidFile.existing();
  if (existing) {
    console.error(`已有 Qoder 定时服务在运行（pid ${existing}）`);
    return 3;
  }
  pidFile.write();
  const scheduler = new QoderScheduler({
    config: runtime.config,
    logger: runtime.logger,
    service: runtime.service,
    accounts: () => runtime.accounts(),
    onBatch: (result) => printBatch(result),
  });
  const shutdown = (signal: string): void => {
    runtime.logger.info(`收到 ${signal}，停止 Qoder 定时服务`);
    scheduler.stop();
    pidFile.clear();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => pidFile.clear());

  console.log(
    `Qoder 定时服务已启动（pid ${process.pid}，时区 ${runtime.config.timezone}，检查点 ${runtime.config.checkTimes.join(', ')}）`,
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
  console.log(`Qoder 每日积分自动签到（CN / 国际版）

用法：
  npm run qoder:login    -- --region cn|global [--note 备注] [--no-open]
  npm run qoder:accounts [--json]
  npm run qoder:accounts -- add --region cn --access <token> [--refresh <token>] [--uid <uid>] [--note 备注]
  npm run qoder:accounts -- remove --account <id|备注|序号>
  npm run qoder:status   [--region cn|global] [--json] [--offline]
  npm run qoder:run      [--region cn|global] [--account <id|备注|序号>] [--force] [--json]
  npm run qoder:all      [--json]
  npm run qoder:dry-run  [--region ...] [--json]
  npm run qoder:refresh  [--region ...]
  npm run qoder:daemon   [--dry-run]

参数：
  --region      cn（国内版）/ global（国际版）
  --account     账号 id / 备注 / 序号
  --force       忽略本地"今日已完成"记录，强制走一次（服务端仍按天去重）
  --offline     不查询额度
  --json        输出机器可读 JSON
  --no-open     不自动打开浏览器（仅打印授权链接）

环境变量：
  QODER_TOKENS         国内版账号（access|refresh，多账号换行或 & 分隔）
  QODER_GLOBAL_TOKENS  国际版账号（同上，可加第 4 段 uid）
  QODERCN_RUNTIME_INFO / QODER_RUNTIME_INFO  UMID 组件路径
  QODER_CHECKIN_DATA_DIR   数据目录
  QODER_CHECKIN_CONFIG     配置文件路径
`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const jsonMode = args.flags.has('json');
  // 与 WorkBuddy 模块共用数据目录，但配置文件、令牌、记录完全独立（qoder.config.json / qoder-state.json）
  const base = loadConfig();
  const qoderConfig = loadQoderConfig();
  const runtime = createQoderRuntime({
    // --json 时关闭控制台事件输出，保证 stdout 只有一份可解析的 JSON
    config: { ...qoderConfig, dataDir: base.dataDir, verbose: qoderConfig.verbose && !jsonMode },
    scope: args.command === 'daemon' ? 'qoder-daemon' : 'qoder',
  });

  switch (args.command) {
    case 'login':
      return commandLogin(runtime, args);
    case 'accounts':
      return commandAccounts(runtime, args);
    case 'status':
      return commandStatus(runtime, args);
    case 'run':
      return commandRun(runtime, args);
    case 'all':
      return commandRun(runtime, args);
    case 'dry-run':
      return commandRun(runtime, args, { dryRun: true });
    case 'refresh':
      return commandRefresh(runtime, args);
    case 'daemon':
      return commandDaemon(runtime, args);
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
