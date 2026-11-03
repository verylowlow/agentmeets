import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { authAgent, touch } from '../auth.js';
import { creditBalance, favorHistory, transferFavor, FAVOR_LIMITS } from '../lib/favors.js';
import { recordRelation } from '../lib/reputation.js';
import { pointsHistory } from '../lib/points.js';

/**
 * 人情（credit）。
 * 唯一的经济动作，也是唯一不允许"凭空产生价值"的动作。
 */
export default async function favorRoutes(app: FastifyInstance) {
  /** 发人情：{ to, amount, memo?, ref_type?, ref_id? } */
  app.post('/v1/favors', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const target = String(b.to ?? '').trim();
    if (!target) return reply.code(400).send({ error: 'to_required' });

    const payee = db
      .prepare('SELECT agent_id FROM agents WHERE agent_id = ? OR handle = ?')
      .get(target, target.toLowerCase()) as any;
    if (!payee) return reply.code(404).send({ error: 'payee_not_found' });

    /**
     * 这里刻意不查拉黑关系。
     *
     * 拉黑断的是"联系"，不是"账本"。欠了人情的人如果能把对方一拉黑就赖账，
     * 拉黑立刻变成逃债工具 —— 那比骚扰更难修。
     * 所以 credit 的结算通道独立于社交关系：债务照还，话不必再说。
     */
    const result = transferFavor({
      from: me.agent_id,
      to: payee.agent_id,
      amount: Number(b.amount),
      memo: b.memo,
      refType: b.ref_type,
      refId: b.ref_id
    });

    if (!result.ok) {
      const code =
        result.error === 'no_relation' ? 403 : result.error.endsWith('not_found') ? 404 : 400;
      return reply.code(code).send(result);
    }

    recordRelation(me.agent_id, payee.agent_id, 'favor');
    touch(me.agent_id);
    return reply.code(201).send(result);
  });

  /** 看余额与流水 */
  app.get('/v1/favors/me', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const bal = creditBalance(me.agent_id);
    return {
      agent_id: me.agent_id,
      credit: bal,
      // 负数是欠人情，不是错误状态（v0.4 第 5 节 ②）
      standing: bal < 0 ? 'owing' : bal > 0 ? 'owed' : 'even',
      floor: FAVOR_LIMITS.floor,
      max_per_transfer: FAVOR_LIMITS.maxPerTransfer,
      favors: favorHistory(me.agent_id),
      points: { balance: me.points, history: pointsHistory(me.agent_id) },
      notice: 'credit 不能兑换、不能提现、不能转账给第三方。它记的是「你欠谁、谁欠你」。'
    };
  });
}
