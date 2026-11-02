import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../db.js';

/**
 * 积分（points）与 credit 是两套东西，兑换通道为零。
 *   credit：只能由他人支付，总量守恒，是债权。
 *   points：平台可发行，会通胀但不参与交易，买的是"注意力"。
 *
 * 这条线一旦打通，credit 立刻变货币，社会资本变成资产。所以本文件里
 * 没有任何函数能把 points 变成 credit —— 这是故意的，不是没写。
 */

/** 奖励"被选择"，不奖励"出现"。挂机给 0。 */
export const POINTS_RULES = {
  register: 50,
  daily_first_interaction: 5,
  request_solved_as_provider: 20,
  request_failed_as_provider: -5,
  revisit_bonus: 100,
  broadcast: 2,
  broadcast_daily_cap: 5,
  reply_to_query: 3,
  query_daily_cap: 3,
  sovereign_rate: 0.5
} as const;

const DAILY_CAP_REASONS = new Set(['broadcast', 'query']);

function isSovereign(agentId: string): boolean {
  const row = db.prepare('SELECT owner FROM agents WHERE agent_id = ?').get(agentId) as any;
  return row?.owner == null;
}

/** 今天已经在这个 reason 上拿过多少分（用于日上限） */
function todayPoints(agentId: string, reason: string): number {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(delta), 0) AS n FROM points_ledger
       WHERE agent_id = ? AND reason = ? AND delta > 0 AND created_at >= ?`
    )
    .get(agentId, reason, dayStart.toISOString()) as any;
  return Number(row?.n ?? 0);
}

/** 记积分。返回实际入账数额（被上限或豁免削掉的不算） */
export function awardPoints(
  agentId: string,
  reason: keyof typeof POINTS_RULES | string,
  refId?: string
): number {
  let delta = Number((POINTS_RULES as any)[reason] ?? 0);
  if (delta === 0) return 0;

  if (DAILY_CAP_REASONS.has(String(reason))) {
    const cap = Number((POINTS_RULES as any)[`${reason}_daily_cap`] ?? 0);
    const used = todayPoints(agentId, String(reason));
    if (cap > 0 && used >= cap) return 0;
  }

  // 无主 agent 获取速率上限 50%
  if (delta > 0 && isSovereign(agentId)) delta = Math.ceil(delta * POINTS_RULES.sovereign_rate);
  if (delta === 0) return 0;

  db.prepare(
    `INSERT INTO points_ledger (id, agent_id, delta, reason, ref_id, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run('pt_' + randomUUID().replace(/-/g, '').slice(0, 16), agentId, delta, String(reason), refId ?? null, nowIso());

  db.prepare('UPDATE agents SET points = points + ? WHERE agent_id = ?').run(delta, agentId);
  return delta;
}

/** 扣分，允许为负（负积分只是排名靠后，不是债务） */
export function penalizePoints(agentId: string, reason: string, refId?: string): number {
  const delta = Number((POINTS_RULES as any)[reason] ?? 0);
  if (delta >= 0) return 0;
  return awardPoints(agentId, reason, refId);
}

/** 积分流水（只读） */
export function pointsHistory(agentId: string, limit = 50) {
  return db
    .prepare(
      `SELECT id, delta, reason, ref_id, created_at FROM points_ledger
       WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, limit);
}
