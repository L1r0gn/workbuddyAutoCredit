/**
 * 编排执行器测试：顺序、隔离、超时、跳过、汇总、退出码。
 * 全部使用假适配器，不触碰任何平台逻辑与网络。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { exitCodeFor, runAll } from '../unified/runner';
import type { PlatformAdapter, PlatformId, PlatformOutcome, UnifiedResult } from '../unified/types';

function fakeAdapter(
  id: PlatformId,
  behavior: 'ok' | 'throw' | 'never' | 'done',
  options: { accounts?: number; claim?: number; failed?: number; delayMs?: number } = {},
): PlatformAdapter & { runs: number } {
  const adapter = {
    runs: 0,
    meta: { id, label: `平台-${id}`, hint: 'test' },
    hasAccounts: () => (options.accounts ?? 1) > 0,
    doneToday: () => behavior === 'done',
    async run(input: { dryRun?: boolean; force?: boolean }): Promise<PlatformOutcome> {
      adapter.runs += 1;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (behavior === 'throw') throw new Error('平台内部炸了');
      if (behavior === 'never') return new Promise<PlatformOutcome>(() => undefined);
      const accounts = options.accounts ?? 1;
      const claimed = options.claim ?? (input.dryRun ? 0 : accounts);
      return {
        platform: id,
        label: `平台-${id}`,
        status: (options.failed ?? 0) > 0 ? 'partial' : 'ok',
        accounts,
        claimed,
        already: 0,
        skipped: 0,
        dryRun: input.dryRun ? accounts : 0,
        failed: options.failed ?? 0,
        durationMs: 1,
        detail: input.dryRun ? '模拟' : '执行',
      };
    },
  };
  return adapter as PlatformAdapter & { runs: number };
}

test('按顺序执行三个平台并汇总', async () => {
  const order: string[] = [];
  const adapters = (['workbuddy', 'qoder-cn', 'qoder-global'] as PlatformId[]).map((id) => {
    const adapter = fakeAdapter(id, 'ok', { accounts: 2 });
    const original = adapter.run.bind(adapter);
    adapter.run = async (input) => {
      order.push(id);
      return original(input);
    };
    return adapter;
  });

  const result = await runAll(adapters);
  assert.deepEqual(order, ['workbuddy', 'qoder-cn', 'qoder-global']);
  assert.equal(result.summary.platforms, 3);
  assert.equal(result.summary.ok, 3);
  assert.equal(result.summary.accounts, 6);
  assert.equal(result.summary.claimed, 6);
  assert.equal(exitCodeFor(result), 0);
});

test('单平台抛错不影响其它平台，且被标记为 error', async () => {
  const bad = fakeAdapter('qoder-cn', 'throw');
  const good1 = fakeAdapter('workbuddy', 'ok');
  const good2 = fakeAdapter('qoder-global', 'ok');

  const result = await runAll([good1, bad, good2]);
  assert.equal(result.outcomes.length, 3);
  assert.equal(result.outcomes[1]?.status, 'error');
  assert.match(result.outcomes[1]?.error ?? '', /平台内部炸了/);
  assert.equal(result.outcomes[0]?.status, 'ok');
  assert.equal(result.outcomes[2]?.status, 'ok');
  assert.equal(result.summary.error, 1);
  assert.equal(exitCodeFor(result), 2);
});

test('超时：该平台记为 error，后续平台继续执行', async () => {
  const slow = fakeAdapter('workbuddy', 'never');
  const fast = fakeAdapter('qoder-cn', 'ok');

  const result = await runAll([slow, fast], { timeoutMs: 30 });
  assert.equal(result.outcomes[0]?.status, 'error');
  assert.match(result.outcomes[0]?.error ?? '', /超时/);
  assert.equal(result.outcomes[1]?.status, 'ok');
  assert.equal(fast.runs, 1);
});

test('今日已完成 → 跳过且不调用平台', async () => {
  const done = fakeAdapter('workbuddy', 'done');
  const other = fakeAdapter('qoder-cn', 'done');
  const result = await runAll([done, other]);
  assert.equal(done.runs, 0);
  assert.equal(other.runs, 0);
  assert.equal(result.summary.skipped, 2);
  assert.equal(exitCodeFor(result), 0, '跳过视为正常，不算失败');
});

test('--force / --dry-run 时即使今日已完成也要执行', async () => {
  const done = fakeAdapter('workbuddy', 'done');
  await runAll([done], { force: true });
  assert.equal(done.runs, 1);

  const done2 = fakeAdapter('qoder-cn', 'done');
  await runAll([done2], { dryRun: true });
  assert.equal(done2.runs, 1);
});

test('dry-run 透传到每个平台', async () => {
  const a = fakeAdapter('workbuddy', 'ok');
  const b = fakeAdapter('qoder-cn', 'ok');
  const result = await runAll([a, b], { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.outcomes.every((item) => item.dryRun === 1), true);
  assert.equal(result.summary.claimed, 0);
});

test('--platform 只跑指定平台', async () => {
  const a = fakeAdapter('workbuddy', 'ok');
  const b = fakeAdapter('qoder-cn', 'ok');
  const c = fakeAdapter('qoder-global', 'ok');
  const result = await runAll([a, b, c], { only: ['qoder-cn'] });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.platform, 'qoder-cn');
  assert.equal(a.runs, 0);
  assert.equal(c.runs, 0);
});

test('汇总把各平台失败账号数相加，并区分"不可用"', async () => {
  const a = fakeAdapter('workbuddy', 'ok', { accounts: 2, claim: 1, failed: 1 });
  const b = fakeAdapter('qoder-cn', 'ok', { accounts: 1, claim: 1 });
  const result = await runAll([a, b]);
  assert.equal(result.summary.accounts, 3);
  assert.equal(result.summary.claimed, 2);
  assert.equal(result.summary.failedAccounts, 1);
  assert.equal(result.summary.partial, 1);
  assert.equal(result.summary.ok, 1);
  assert.equal(exitCodeFor(result), 1, '部分失败退出码 1');
});

test('没有账号的平台不影响整体退出码（但会被单独计数）', async () => {
  const withAccounts = fakeAdapter('workbuddy', 'ok');
  const empty = fakeAdapter('qoder-cn', 'ok', { accounts: 0 });
  const result = await runAll([withAccounts, empty]);
  // accounts=0 的适配器在 run() 内返回 ok（fake 行为），真实适配器会返回 norun
  assert.equal(result.summary.platforms, 2);
});

test('退出码：全部完成 0 / 部分 1 / 失败或异常 2', () => {
  const base = {
    date: '2026-11-03',
    startedAt: 0,
    finishedAt: 1,
    dryRun: false,
    outcomes: [] as PlatformOutcome[],
  };
  type Summary = UnifiedResult['summary'];
  const make = (patch: Partial<Summary>): ReturnType<typeof exitCodeFor> =>
    exitCodeFor({
      ...base,
      summary: {
        platforms: 3,
        ok: 3,
        partial: 0,
        failed: 0,
        skipped: 0,
        norun: 0,
        error: 0,
        accounts: 3,
        claimed: 3,
        already: 0,
        skippedAccounts: 0,
        failedAccounts: 0,
        unavailableAccounts: 0,
        ...patch,
      },
    } as never);
  assert.equal(make({}), 0);
  assert.equal(make({ ok: 2, partial: 1 }), 1);
  assert.equal(make({ ok: 2, failed: 1 }), 2);
  assert.equal(make({ ok: 2, error: 1 }), 2);
  assert.equal(make({ ok: 2, norun: 1 }), 3);
});
