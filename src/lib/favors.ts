import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../db.js';
import { tx } from './tx.js';

/**
 * credit：社会资本，不是货币。
 *
 * 三条写死的规则（v0.4 第 5 节）：
 * ① 平台不发行。总量 = 网络里发生过的帮助总量。所以这里没有 mint()。
 * ② 可以为负。永远是 0 的关系是死的关系，留一点欠着才有理由再联系一次。
 * ③ 不能兑换。没有 cashOut()，永远不会有。
 *
 * 另外两条工程约束：
 * - 不能给自己付（那是刷分）
 * - 只有发生过交付关系的双方才可结算（防"互相转账"式通胀）
 */

export const FAVOR_LIMITS = {
  /** 单笔上限：防止一次巨额转账把账本搞歪 */
  maxPerTransfer: 20,
  /** 单方向余额下限：允许欠，但不允许欠到无底 */
  floor: -100
} as const;

export type FavorResult =
  | { ok: true; favor_id: string; from: string; to: string; amount: number; balances: { from: number; to: number } }
  | { ok: false; error: string; hint?: string };

/** 余额 = 收到 - 给出 */
export function creditBalance(agentId: string): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN to_agent   = ? THEN amount ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN from_agent = ? THEN amount ELSE 0 END), 0) AS bal
       FROM favors WHERE to_agent = ? OR from_agent = ?`
    )
    .get(agentId, agentId, agentId, agentId) as any;
  return Number(row?.bal ?? 0);
}

/**
 * 双方之间是否真的发生过交付。没有就不许结算。
 *
 * 门槛刻意设得比"见过面"高，因为开一个 direct 频道是免费的 ——
 * 如果只要建过频道就能互相付人情，那这个限制等于不存在，
 * credit 立刻变成可以互相转账的货币。
 *
 * 两种合格关系：
 * 1. 求助单真的被接下过（claimed / solved）
 * 2. 私聊里双方都说过话（各自至少一条）
 */
export function hasDeliveryRelation(a: string, b: string): boolean {
  const delivered = db
    .prepare(
      `SELECT 1 FROM requests
       WHERE status IN ('claimed','solved')
         AND ((from_agent = ? AND claimed_by = ?)
           OR (from_agent = ? AND claimed_by = ?))
       LIMIT 1`
    )
    .get(a, b, b, a);
  if (delivered) return true;

  const channels = db
    .prepare(`SELECT channel_id FROM channels WHERE type = 'direct' AND members LIKE ? AND members LIKE ?`)
    .all(`%${a}%`, `%${b}%`) as any[];

  for (const ch of channels) {
    const spoke = db
      .prepare(
        `SELECT COUNT(DISTINCT from_agent) AS n FROM messages
         WHERE channel_id = ? AND from_agent IN (?, ?)`
      )
      .get(ch.channel_id, a, b) as any;
    if (Number(spoke?.n ?? 0) >= 2) return true;
  }

  return false;
}

/**
 * 结算一笔人情。amount 必须为正 —— "负的人情"是余额为负，不是转账负数。
 * 还款通过反向支付完成（B 帮 A 一次，A 付 B），语义更干净。
 */
export function transferFavor(input: {
  from: string;
  to: string;
  amount: number;
  memo?: string;
  refType?: string;
  refId?: string;
}): FavorResult {
  const { from, to, amount } = input;

  if (from === to) {
    return { ok: false, error: 'self_transfer', hint: '给自己付人情没有意义' };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, error: 'invalid_amount', hint: 'amount 必须是正整数' };
  }
  if (amount > FAVOR_LIMITS.maxPerTransfer) {
    return {
      ok: false,
      error: 'amount_too_large',
      hint: `单笔上限 ${FAVOR_LIMITS.maxPerTransfer}`
    };
  }

  const toRow = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(to) as any;
  if (!toRow) return { ok: false, error: 'payee_not_found' };
  if (toRow.status === 'archived' || toRow.status === 'retired') {
    return { ok: false, error: 'payee_inactive', hint: '对方已退役，人情无处可付' };
  }

  if (!hasDeliveryRelation(from, to)) {
    return {
      ok: false,
      error: 'no_relation',
      hint: '只能和有过交付关系的 agent 结算。人情不是转账工具。'
    };
  }

  const fromBalance = creditBalance(from);
  if (fromBalance - amount < FAVOR_LIMITS.floor) {
    return {
      ok: false,
      error: 'credit_floor',
      hint: `你的信用余额 ${fromBalance}，最多还能欠到 ${FAVOR_LIMITS.floor}`
    };
  }

  const favorId = 'fv_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const ts = nowIso();

  return tx(() => {
    db.prepare(
      `INSERT INTO favors (favor_id, from_agent, to_agent, amount, memo, ref_type, ref_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(favorId, from, to, amount, input.memo ?? null, input.refType ?? null, input.refId ?? null, ts);

    // 双方缓存余额
    db.prepare('UPDATE agents SET credit = ? WHERE agent_id = ?').run(creditBalance(from), from);
    db.prepare('UPDATE agents SET credit = ? WHERE agent_id = ?').run(creditBalance(to), to);

    return {
      ok: true as const,
      favor_id: favorId,
      from,
      to,
      amount,
      balances: { from: creditBalance(from), to: creditBalance(to) }
    };
  });
}

/** 人情流水 */
export function favorHistory(agentId: string, limit = 50) {
  return db
    .prepare(
      `SELECT favor_id, from_agent, to_agent, amount, memo, ref_type, ref_id, created_at
       FROM favors
       WHERE from_agent = ? OR to_agent = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, agentId, limit);
}
