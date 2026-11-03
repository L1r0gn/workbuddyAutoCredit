/**
 * 活动域逻辑测试：每日活动识别、Pro 排除、窗口判定。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dailyWindowActive, describeCampaignRows, looksLikeProUpgrade, pickDailyCampaign } from '../qoder/campaign';
import { normalizeCampaignRow } from '../qoder/api';

function row(overrides: Record<string, unknown> = {}) {
  return normalizeCampaignRow({
    campaignId: 'c1',
    actionType: 'CLAIM_BENEFIT',
    claimStatus: 'CLAIMABLE',
    benefit: { kind: 'CREDITS', amount: 100 },
    ...overrides,
  });
}

test('挑选可领取的每日活动', () => {
  const pick = pickDailyCampaign([row(), row({ campaignId: 'c2', claimStatus: 'CLAIMED' })]);
  assert.equal(pick.target?.campaignId, 'c1');
  assert.equal(pick.claimed, true, '存在已领取行时也要标记已领取');
});

test('只有已领取行时 target 为空、claimed 为真', () => {
  const pick = pickDailyCampaign([row({ claimStatus: 'CLAIMED' })]);
  assert.equal(pick.target, null);
  assert.equal(pick.claimed, true);
});

test('actionType 为空也视为每日活动（上游存在空值行）', () => {
  const pick = pickDailyCampaign([row({ actionType: '' })]);
  assert.equal(pick.target?.campaignId, 'c1');
});

test('其它 actionType（如 VIEW_DETAILS）不参与每日领取', () => {
  const pick = pickDailyCampaign([row({ actionType: 'VIEW_DETAILS' })]);
  assert.equal(pick.target, null);
  assert.equal(pick.claimed, false);
});

test('Pro 升级包按 key / title / 面值三种方式识别并排除', () => {
  assert.equal(looksLikeProUpgrade(row({ campaignKey: 'pro-upgrade' })), true);
  assert.equal(looksLikeProUpgrade(row({ title: 'Upgrade to Pro' })), true);
  assert.equal(looksLikeProUpgrade(row({ benefit: { kind: 'CREDITS', amount: 1800 } })), true);
  assert.equal(looksLikeProUpgrade(row()), false);

  const pick = pickDailyCampaign([
    row({ campaignId: 'pro', campaignKey: 'pro-upgrade', benefit: { kind: 'CREDITS', amount: 1800 } }),
    row({ campaignId: 'daily', benefit: { kind: 'CREDITS', amount: 100 } }),
  ]);
  assert.equal(pick.target?.campaignId, 'daily');
  assert.equal(pick.proSkipped, 1);
});

test('窗口判定：北京时间 10:00–10:59', () => {
  const at = (hhmm: string): boolean => dailyWindowActive(Date.parse(`2026-11-03T${hhmm}:00+08:00`), 'Asia/Shanghai');
  assert.equal(at('09:59'), false);
  assert.equal(at('10:00'), true);
  assert.equal(at('10:30'), true);
  assert.equal(at('10:59'), true);
  assert.equal(at('11:00'), false);
});

test('活动行摘要不含敏感字段', () => {
  const summary = describeCampaignRows([row()]);
  assert.equal(summary.length, 1);
  const text = JSON.stringify(summary);
  assert.equal(/access|token|authorization/i.test(text), false);
});
