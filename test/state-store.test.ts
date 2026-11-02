/**
 * 本地状态仓库测试：原子写入、幂等、保留策略、跨进程锁。
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { StateStore } from '../checkin/state-store';
import type { CheckinRecord } from '../checkin/types';
import { tempDir } from './helpers';

function record(overrides: Partial<CheckinRecord> = {}): CheckinRecord {
  return {
    uid: 'uid-1',
    date: '2026-11-02',
    outcome: 'checked-in',
    ok: true,
    already: false,
    code: 0,
    message: 'OK',
    endpoint: 'https://www.workbuddy.cn/billing/meter/daily-checkin',
    startedAt: Date.parse('2026-11-02T02:05:00Z'),
    finishedAt: Date.parse('2026-11-02T02:05:03Z'),
    creditsBefore: 100,
    creditsAfter: 120,
    creditsDelta: 20,
    verified: true,
    verification: 'credits-delta',
    profile: 'workbuddy-cn',
    accountTag: 'uid-****01',
    dryRun: false,
    ...overrides,
  };
}

test('写入后可读回，并生成 0600 权限的文件', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  store.saveRecord(record());

  const loaded = store.getRecord('uid-1', '2026-11-02');
  assert.equal(loaded?.ok, true);
  assert.equal(loaded?.creditsDelta, 20);
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-02'), true);

  const file = path.join(dir, 'state.json');
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('verified=false 的记录不算"已确认成功"', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  store.saveRecord(record({ verified: false, verification: 'none' }));
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-02'), false);
});

test('不同日期互不影响', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  store.saveRecord(record({ date: '2026-11-01' }));
  store.saveRecord(record({ date: '2026-11-02' }));
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-01'), true);
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-02'), true);
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-03'), false);
  assert.equal(store.history('uid-1').length, 2);
});

test('损坏的状态文件不会导致崩溃', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ broken');
  const store = new StateStore(dir);
  assert.equal(store.getRecord('uid-1', '2026-11-02'), null);
  store.saveRecord(record());
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-02'), true);
});

test('超过保留期的记录会被清理', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  store.saveRecord(record({ date: '2020-01-01' }));
  store.saveRecord(record({ date: '2026-11-02' }));
  assert.equal(store.getRecord('uid-1', '2020-01-01'), null, '过期记录应被裁剪');
  assert.equal(store.getRecord('uid-1', '2026-11-02')?.ok, true);
});

test('写入过程中不会留下半截文件（临时文件 + rename）', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  store.saveRecord(record());
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('锁文件在异常路径下也会被释放', () => {
  const dir = tempDir();
  const store = new StateStore(dir);
  assert.throws(() =>
    store.withLock(() => {
      throw new Error('boom');
    }),
  );
  assert.equal(fs.existsSync(path.join(dir, '.state.lock')), false);
  // 释放后仍可正常写入
  store.saveRecord(record());
  assert.equal(store.hasConfirmedSuccess('uid-1', '2026-11-02'), true);
});
