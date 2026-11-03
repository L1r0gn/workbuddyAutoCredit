/**
 * 存储层测试：账号/令牌持久化、轮换写回、记录分级合并、幂等状态。
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { accountIdFor, maskToken, QoderStore } from '../qoder/store';
import type { QoderCheckinRecord } from '../qoder/types';
import { tempDir } from './qoder-helpers';

function record(overrides: Partial<QoderCheckinRecord> = {}): QoderCheckinRecord {
  return {
    accountId: 'cn:uid-1',
    region: 'cn',
    date: '2026-11-03',
    outcome: 'claimed',
    ok: true,
    campaignId: 'cmp-1',
    campaignAmount: 100,
    claimedAmount: 100,
    creditsBefore: 1000,
    creditsAfter: 1100,
    creditsDelta: 100,
    verified: true,
    verification: 'quota-delta',
    message: '领取成功',
    at: Date.parse('2026-11-03T02:05:00Z'),
    durationMs: 1200,
    dryRun: false,
    accountTag: 'cn-abc12345',
    note: '主号',
    ...overrides,
  };
}

test('写入账号后可读回，令牌完整保留', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  const account = store.upsertAccount({
    region: 'cn',
    note: '主号',
    uid: 'uid-1',
    tokens: { access: 'dt-aaa', refresh: 'drt-bbb', updatedAt: 1000 },
  });
  assert.equal(account.id, 'cn:uid-1');
  const loaded = store.getAccount(account.id);
  assert.equal(loaded?.tokens.access, 'dt-aaa');
  assert.equal(loaded?.tokens.refresh, 'drt-bbb');
  assert.equal(loaded?.note, '主号');
  assert.ok(loaded?.device.machineId, '应分配机器标识');
});

test('无 uid 时用令牌指纹作为账号标识，同一令牌稳定', () => {
  const id1 = accountIdFor('cn', '', 'dt-same');
  const id2 = accountIdFor('cn', '', 'dt-same');
  assert.equal(id1, id2);
  assert.match(id1, /^cn:fp-[0-9a-f]{16}$/);
  assert.notEqual(accountIdFor('global', '', 'dt-same'), id1, '不同区域不能算出同一个 id');
});

test('令牌轮换后必须能写回（否则下次运行会失效）', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  const account = store.upsertAccount({
    region: 'cn',
    uid: 'uid-1',
    tokens: { access: 'dt-old', refresh: 'drt-old', updatedAt: 1 },
  });
  store.updateTokens(account.id, { access: 'dt-new', refresh: 'drt-new', updatedAt: 2 });
  const loaded = store.getAccount(account.id);
  assert.equal(loaded?.tokens.access, 'dt-new');
  assert.equal(loaded?.tokens.refresh, 'drt-new');
});

test('账号信息不重复创建：同一 uid 再次 upsert 是更新而非新增', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  store.upsertAccount({ region: 'cn', uid: 'uid-1', note: '旧备注', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  store.upsertAccount({ region: 'cn', uid: 'uid-1', note: '新备注', tokens: { access: 'dt-2', refresh: 'drt-2', updatedAt: 2 } });
  const all = store.listAccounts();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.note, '新备注');
  assert.equal(all[0]?.tokens.access, 'dt-2');
});

test('两个区域各自独立存储，互不覆盖', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  store.upsertAccount({ region: 'cn', uid: 'same-uid', tokens: { access: 'dt-cn', refresh: '', updatedAt: 1 } });
  store.upsertAccount({ region: 'global', uid: 'same-uid', tokens: { access: 'dt-global', refresh: '', updatedAt: 1 } });
  const cn = store.listAccounts('cn');
  const intl = store.listAccounts('global');
  assert.equal(cn.length, 1);
  assert.equal(intl.length, 1);
  assert.equal(cn[0]?.tokens.access, 'dt-cn');
  assert.equal(intl[0]?.tokens.access, 'dt-global');
});

test('记录分级合并：低等级不能覆盖已领取', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  store.upsertAccount({ region: 'cn', uid: 'uid-1', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  const accountId = 'cn:uid-1';
  store.saveRecord(record({ accountId, outcome: 'claimed' }));
  store.saveRecord(record({ accountId, outcome: 'skipped', ok: true, verified: true }));
  const saved = store.getRecord(accountId, '2026-11-03');
  assert.equal(saved?.outcome, 'claimed', 'skipped 不应覆盖 claimed');
});

test('hasConfirmed 只认 claimed / already 且 verified 不为 false', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  store.upsertAccount({ region: 'cn', uid: 'uid-1', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  const accountId = 'cn:uid-1';
  assert.equal(store.hasConfirmed(accountId, '2026-11-03'), false);

  store.saveRecord(record({ accountId, outcome: 'claimed' }));
  assert.equal(store.hasConfirmed(accountId, '2026-11-03'), true);

  const dir2 = tempDir();
  const store2 = new QoderStore(dir2);
  store2.upsertAccount({ region: 'cn', uid: 'uid-1', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  store2.saveRecord(record({ accountId, outcome: 'claimed', verified: false, verification: 'none' }));
  assert.equal(store2.hasConfirmed(accountId, '2026-11-03'), false, '未验证的记录不能阻止再次尝试');
});

test('令牌脱敏：只保留前缀与末 4 位', () => {
  assert.equal(maskToken('dt-abcdefghijklmnop'), 'dt-abc****mnop');
  assert.equal(maskToken('short'), 'sho****');
  assert.equal(maskToken(''), '—');
});

test('状态文件权限 0600，且无临时文件残留', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  store.upsertAccount({ region: 'cn', uid: 'uid-1', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('qoder-state.json'));
  assert.equal(files.some((name) => name.includes('.tmp-')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'qoder-state.json')).mode & 0o777, 0o600);
  }
});

test('损坏的状态文件不导致崩溃', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'qoder-state.json'), '{ broken');
  const store = new QoderStore(dir);
  assert.deepEqual(store.listAccounts(), []);
  store.upsertAccount({ region: 'cn', uid: 'uid-1', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  assert.equal(store.listAccounts().length, 1);
});

test('删除账号同时清掉其记录', () => {
  const dir = tempDir();
  const store = new QoderStore(dir);
  const account = store.upsertAccount({ region: 'cn', uid: 'uid-1', tokens: { access: 'dt-1', refresh: '', updatedAt: 1 } });
  store.saveRecord(record({ accountId: account.id }));
  assert.equal(store.removeAccount(account.id), true);
  assert.equal(store.getRecord(account.id, '2026-11-03'), null);
  assert.equal(store.removeAccount(account.id), false);
});
