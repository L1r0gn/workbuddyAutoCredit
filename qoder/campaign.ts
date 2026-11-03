/**
 * 活动域逻辑（纯函数，便于单测）。
 *
 * 规则来源：Qoder-Daily `pick_daily_campaign` / `campaign_looks_like_pro_upgrade` /
 * `daily_window_active`，以及它自带的测试用例。
 *
 * 「每日积分」活动行的识别条件：
 *   actionType 为空或 CLAIM_BENEFIT
 *   且不是 Pro 升级包（campaignKey/title 含 pro|upgrade，或面值 ≥ 1000 credits）
 *   claimStatus=CLAIMABLE → 可领取；CLAIMED → 已领取
 */
import { zonedParts } from '../checkin/scheduler';
import type { QoderCampaignRow } from './types';

/** 判定是否是 Pro 升级包（一次性大额，不是每日积分）。 */
export function looksLikeProUpgrade(row: QoderCampaignRow): boolean {
  const haystack = [row.campaignKey, row.actionType, row.title].join(' ').toLowerCase();
  if (haystack.includes('pro') || haystack.includes('upgrade')) return true;
  return row.benefitKind === 'CREDITS' && row.benefitAmount >= 1000;
}

export interface DailyPick {
  target: QoderCampaignRow | null;
  /** 是否存在今日已领取的每日活动行 */
  claimed: boolean;
  /** 被跳过的 Pro 行数量，仅用于诊断 */
  proSkipped: number;
}

/** 从活动行中挑出今日可领取的每日活动。 */
export function pickDailyCampaign(rows: QoderCampaignRow[]): DailyPick {
  let target: QoderCampaignRow | null = null;
  let claimed = false;
  let proSkipped = 0;
  for (const row of rows) {
    if (row.actionType && row.actionType !== 'CLAIM_BENEFIT') continue;
    if (looksLikeProUpgrade(row)) {
      proSkipped += 1;
      continue;
    }
    if (row.claimStatus === 'CLAIMABLE' && !target) target = row;
    else if (row.claimStatus === 'CLAIMED') claimed = true;
  }
  return { target, claimed, proSkipped };
}

/**
 * 是否处于「每日活动窗口」。
 *
 * 官方窗口北京时间 10:00 开启，上游可能延迟到 11:00 前才下发，
 * 因此窗口判定为 10:00–10:59（与参考实现一致）。
 */
export function dailyWindowActive(nowMs: number, timeZone = 'Asia/Shanghai'): boolean {
  const parts = zonedParts(timeZone, nowMs);
  return parts.hour === 10;
}

/** 活动行摘要，用于日志与诊断（不含凭据）。 */
export function describeCampaignRows(rows: QoderCampaignRow[]): Array<Record<string, unknown>> {
  return rows.slice(0, 12).map((row) => ({
    id: row.campaignId,
    key: row.campaignKey,
    action: row.actionType,
    status: row.claimStatus,
    benefit: row.benefitKind ? `${row.benefitKind} ${row.benefitAmount}` : '',
    pro: looksLikeProUpgrade(row),
    title: row.title.slice(0, 40),
  }));
}
