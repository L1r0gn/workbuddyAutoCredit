/**
 * 统一调度测试：完成判定、启动补偿、到点触发、平台 daemon 冲突检测。
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { readLivePid, UnifiedPidFile, UnifiedScheduler } from '../unified/scheduler';
import { parsePlatformSelector } from '../unified/index';
import { silentLogger } from './qoder-helpers';
import type { PlatformAdapter, PlatformId, PlatformOutcome } from '../unified/types';

function adapter(
  id: PlatformId,
  state: { accounts: number; done: boolean },
  calls: string[],
): PlatformAdapter {
  return {
    meta: { id, label: `平台-${id}`, hint: 'test' },
    hasAccounts: () => state.accounts > 0,
    doneToday: () => state.done,
    async run(): Promise<PlatformOutcome> {
      calls.push(id);
      return {
        platform: id,
        label: `平台-${id}`,
        status: 'ok',
        accounts: state.accounts,
        claimed: state.accounts,
        already: 0,
        skipped: 0,
        dryRun: 0,
        failed: 0,
        durationMs: 1,
        detail: 'ok',
      };
    },
  };
}

test('allDone：只有"有账号"的平台参与判断', () => {
  const calls: string[] = [];
  const scheduler = new UnifiedScheduler({
    adapters: [
      adapter('workbuddy', { accounts: 1, done: true }, calls),
      adapter('qoder-cn', { accounts: 0, done: false }, calls),
    ],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
  });
  assert.equal(scheduler.allDone('2026-11-03'), true, '无账号的平台不应阻止"全部完成"');

  const scheduler2 = new UnifiedScheduler({
    adapters: [
      adapter('workbuddy', { accounts: 1, done: true }, calls),
      adapter('qoder-cn', { accounts: 1, done: false }, calls),
    ],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
  });
  assert.equal(scheduler2.allDone('2026-11-03'), false);
});

test('shouldCatchUp：已过检查时间且未全部完成 → true', () => {
  const calls: string[] = [];
  const at = (iso: string) => () => Date.parse(iso);
  // 08:00 北京时间，未到 10:05
  const before = new UnifiedScheduler({
    adapters: [adapter('workbuddy', { accounts: 1, done: false }, calls)],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    now: at('2026-11-03T00:00:00Z'),
  });
  assert.equal(before.shouldCatchUp(), false);

  // 21:00 北京时间，已过点且未完成
  const after = new UnifiedScheduler({
    adapters: [adapter('workbuddy', { accounts: 1, done: false }, calls)],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    now: at('2026-11-03T13:00:00Z'),
  });
  assert.equal(after.shouldCatchUp(), true);

  // 已过点但全部完成
  const done = new UnifiedScheduler({
    adapters: [adapter('workbuddy', { accounts: 1, done: true }, calls)],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    now: at('2026-11-03T13:00:00Z'),
  });
  assert.equal(done.shouldCatchUp(), false);
});

test('runForever：启动补偿执行一次，随后等待下一个检查点', async () => {
  const calls: string[] = [];
  let clock = Date.parse('2026-11-03T13:00:00Z'); // 21:00 北京时间
  let schedulerRef: UnifiedScheduler | null = null;
  let sleeps = 0;

  const scheduler = new UnifiedScheduler({
    adapters: [adapter('workbuddy', { accounts: 1, done: false }, calls)],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    now: () => clock,
    sleep: async () => {
      sleeps += 1;
      schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;

  await scheduler.runForever();
  assert.deepEqual(calls, ['workbuddy'], '启动补偿应执行一次');
  assert.ok(sleeps >= 1, '之后应进入等待');
});

test('runForever：dry-run 透传', async () => {
  const calls: string[] = [];
  const seen: Array<boolean | undefined> = [];
  const base = adapter('workbuddy', { accounts: 1, done: false }, calls);
  const spied: PlatformAdapter = {
    ...base,
    async run(options): Promise<PlatformOutcome> {
      seen.push(options.dryRun);
      return base.run(options);
    },
  };
  let clock = Date.parse('2026-11-03T13:00:00Z');
  let schedulerRef: UnifiedScheduler | null = null;
  const scheduler = new UnifiedScheduler({
    adapters: [spied],
    logger: silentLogger(),
    timezone: 'Asia/Shanghai',
    checkTimes: ['10:05'],
    now: () => clock,
    sleep: async () => {
      schedulerRef?.stop();
    },
  });
  schedulerRef = scheduler;
  await scheduler.runForever({ dryRun: true });
  assert.deepEqual(seen, [true]);
  void clock;
});

test('parsePlatformSelector：别名与非法值', () => {
  assert.equal(parsePlatformSelector([]), null);
  assert.equal(parsePlatformSelector(['all']), null);
  assert.deepEqual(parsePlatformSelector(['workbuddy']), ['workbuddy']);
  assert.deepEqual(parsePlatformSelector(['qoder']), ['qoder-cn', 'qoder-global']);
  assert.deepEqual(parsePlatformSelector(['qoder-cn', 'workbuddy']), ['qoder-cn', 'workbuddy']);
  assert.deepEqual(parsePlatformSelector(['qoder-global']), ['qoder-global']);
  assert.throws(() => parsePlatformSelector(['nope']), /未知平台/);
});

test('pid 文件：写入 / 存活探测 / 清理 / 陈旧 pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-pid-'));
  const pidFile = new UnifiedPidFile(dir);
  assert.equal(pidFile.existing(), null);
  const pid = pidFile.write();
  assert.equal(pidFile.existing(), pid);
  assert.equal(readLivePid(path.join(dir, 'unified-daemon.pid')), pid);
  pidFile.clear();
  assert.equal(pidFile.read(), null);

  fs.writeFileSync(path.join(dir, 'unified-daemon.pid'), '999999');
  assert.equal(pidFile.existing(), null, '不存在的进程应视为无占用');
  assert.equal(readLivePid(path.join(dir, 'unified-daemon.pid')), null);
});
