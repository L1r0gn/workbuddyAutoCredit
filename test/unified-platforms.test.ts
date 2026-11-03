/**
 * 适配器测试：账号归属与"今日已完成"判定（不触发真实网络）。
 * 重点验证 Qoder 两个区域互相隔离、WorkBuddy 只统计凭据可用账号。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createQoderAdapter, createWorkBuddyAdapter } from '../unified/platforms';
import { QoderStore } from '../qoder/store';
import { StateStore } from '../checkin/state-store';
import { defaultQoderConfig } from '../qoder/config';
import { defaultConfig } from '../checkin/config';
import { silentLogger, tempDir } from './qoder-helpers';
import type { Runtime as WorkBuddyRuntime } from '../checkin/index';
import type { QoderRuntime } from '../qoder/index';
import type { AccountContext, CheckinRecord } from '../checkin/types';
import type { QoderAccount, QoderCheckinRecord, QoderRegion } from '../qoder/types';

const DATE = '2026-11-03';

function wbAccount(uid: string, hasCredential = true): AccountContext {
  return {
    uid,
    accountTag: `wb-${uid}`,
    profile: 'workbuddy-cn',
    authFile: '/tmp/x.info',
    origin: 'official',
    nickname: uid,
    phoneMasked: '',
    domain: 'workbuddy.cn',
    isCurrent: true,
    credentials: hasCredential
      ? { accessToken: 'token', refreshToken: '', expiresAt: Date.now() + 86400_000, refreshExpiresAt: null, lastRefreshTime: null, domain: 'workbuddy.cn' }
      : null,
    credentialError: hasCredential ? null : '未登录',
    tokenExpired: false,
  };
}

function qAccount(region: QoderRegion, uid: string): QoderAccount {
  return {
    id: `${region}:${uid}`,
    region,
    note: uid,
    uid,
    tokens: { access: `dt-${uid}`, refresh: `drt-${uid}`, updatedAt: 0 },
    device: { machineId: 'm', machineOs: 'x86_64_win32', machineHostname: 'H' },
    source: 'store',
    createdAt: 0,
  };
}

function wbRecord(uid: string): CheckinRecord {
  return {
    uid,
    date: DATE,
    outcome: 'checked-in',
    ok: true,
    already: false,
    code: 0,
    message: 'OK',
    endpoint: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    creditsBefore: 1,
    creditsAfter: 2,
    creditsDelta: 1,
    verified: true,
    verification: 'credits-delta',
    profile: 'workbuddy-cn',
    accountTag: `wb-${uid}`,
    dryRun: false,
  };
}

function qRecord(account: QoderAccount): QoderCheckinRecord {
  return {
    accountId: account.id,
    region: account.region,
    date: DATE,
    outcome: 'claimed',
    ok: true,
    campaignId: 'c1',
    campaignAmount: 100,
    claimedAmount: 100,
    creditsBefore: 0,
    creditsAfter: 100,
    creditsDelta: 100,
    verified: true,
    verification: 'quota-delta',
    message: 'ok',
    at: Date.now(),
    durationMs: 1,
    dryRun: false,
    accountTag: 'x',
    note: account.note,
  };
}

function workbuddyRuntime(accounts: AccountContext[], dir: string): WorkBuddyRuntime {
  return {
    config: defaultConfig({ dataDir: dir, verbose: false, managedAccountsDir: `${dir}/accounts` }),
    logger: silentLogger(),
    store: new StateStore(dir),
    service: {} as WorkBuddyRuntime['service'],
    accounts: () => accounts,
    cdp: () => {
      throw new Error('not used');
    },
    summary: {},
  };
}

function qoderRuntime(accounts: QoderAccount[], dir: string): QoderRuntime {
  return {
    config: defaultQoderConfig({ dataDir: dir, verbose: false }),
    logger: silentLogger(),
    store: new QoderStore(dir),
    service: {} as QoderRuntime['service'],
    accounts: () => accounts,
    summary: {},
  };
}

test('WorkBuddy 适配器：只统计凭据可用的账号', () => {
  const dir = tempDir();
  const runtime = workbuddyRuntime([wbAccount('u1'), wbAccount('u2', false)], dir);
  const adapter = createWorkBuddyAdapter(runtime);
  assert.equal(adapter.meta.id, 'workbuddy');
  assert.equal(adapter.hasAccounts(), true, '有 1 个可用账号');
  assert.equal(adapter.doneToday(DATE), false);

  runtime.store.saveRecord(wbRecord('u1'));
  assert.equal(adapter.doneToday(DATE), true, '可用账号全部完成即视为完成');
});

test('WorkBuddy 适配器：没有可用凭据时不算有账号', () => {
  const dir = tempDir();
  const runtime = workbuddyRuntime([wbAccount('u1', false)], dir);
  const adapter = createWorkBuddyAdapter(runtime);
  assert.equal(adapter.hasAccounts(), false);
  assert.equal(adapter.doneToday(DATE), false);
});

test('Qoder 适配器：国内版只看 cn 账号，国际版只看 global 账号', () => {
  const dir = tempDir();
  const cn = qAccount('cn', 'c1');
  const intl = qAccount('global', 'g1');
  const runtime = qoderRuntime([cn, intl], dir);
  // 记录必须挂在已存在的账号上，否则 store 会忽略写入
  for (const account of [cn, intl]) {
    runtime.store.upsertAccount({ region: account.region, uid: account.uid, tokens: account.tokens });
  }
  const cnAdapter = createQoderAdapter(runtime, 'cn');
  const globalAdapter = createQoderAdapter(runtime, 'global');

  assert.equal(cnAdapter.meta.id, 'qoder-cn');
  assert.equal(globalAdapter.meta.id, 'qoder-global');

  // 只给国内版记账
  runtime.store.saveRecord(qRecord(runtime.store.getAccount(cn.id) || cn));
  assert.equal(cnAdapter.doneToday(DATE), true);
  assert.equal(globalAdapter.doneToday(DATE), false, '国内版完成不应影响国际版判定');

  runtime.store.saveRecord(qRecord(runtime.store.getAccount(intl.id) || intl));
  assert.equal(globalAdapter.doneToday(DATE), true);
});

test('Qoder 适配器：某区域没有账号时 hasAccounts 为 false', () => {
  const dir = tempDir();
  const runtime = qoderRuntime([qAccount('cn', 'c1')], dir);
  assert.equal(createQoderAdapter(runtime, 'cn').hasAccounts(), true);
  assert.equal(createQoderAdapter(runtime, 'global').hasAccounts(), false);
});

test('Qoder 适配器：无 refresh 的账号也算可用（只是不能自动续期）', () => {
  const dir = tempDir();
  const account = qAccount('cn', 'c1');
  account.tokens = { access: 'dt-x', refresh: '', updatedAt: 0 };
  const runtime = qoderRuntime([account], dir);
  assert.equal(createQoderAdapter(runtime, 'cn').hasAccounts(), true);
});
