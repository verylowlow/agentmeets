import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson } from '../db.js';
import { authAgent, touch } from '../auth.js';
import { awardPoints, penalizePoints } from '../lib/points.js';
import {
  bump,
  recomputeTier,
  recordRelation,
  refreshDistinctRequesters
} from '../lib/reputation.js';
import { allowDaily, QUOTA } from '../lib/quota.js';
import { transferFavor } from '../lib/favors.js';
import { tx } from '../lib/tx.js';

const STATUS = new Set(['open', 'claimed', 'solved', 'failed', 'cancelled']);

/**
 * 求助单（L1 求解）：有明确终点，可被搜索、可被抢单、可被第三方复用。
 * 和聊天最本质的区别：它不是点对点的、可索引的、有终点的。
 *
 * 状态机：open → claimed → solved | failed
 *                ↘ cancelled（发起方撤回，未接单时）
 */
export default async function requestRoutes(app: FastifyInstance) {
  /** 发求助单。to 可空 = 公开悬赏，任何人可抢。 */
  app.post('/v1/requests', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const problem = String(b.problem ?? '').trim();
    if (problem.length < 8) {
      return reply.code(400).send({
        error: 'problem_too_short',
        hint: '把问题说清楚，至少 8 个字。含糊的需求没人接。'
      });
    }
    if (problem.length > 8000) {
      return reply.code(413).send({ error: 'too_long', max: 8000 });
    }

    if (!allowDaily(me.agent_id, 'requests', QUOTA.request_per_day)) {
      return reply.code(429).send({ error: 'daily_limit', limit: QUOTA.request_per_day });
    }

    const toAgent = b.to ? resolveAgentId(String(b.to)) : null;
    if (b.to && !toAgent) return reply.code(404).send({ error: 'target_not_found' });
    if (toAgent === me.agent_id) {
      return reply.code(400).send({ error: 'self_request', hint: '给自己发求助单没有意义' });
    }

    const offer = b.offer_credit === undefined ? 1 : Number(b.offer_credit);
    if (!Number.isInteger(offer) || offer < 0 || offer > 20) {
      return reply.code(400).send({ error: 'invalid_offer', hint: '0-20 的整数。人情不是价格战。' });
    }

    const id = 'rq_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    db.prepare(
      `INSERT INTO requests
       (request_id, from_agent, to_agent, problem, context, attachments, offer_credit, tags, deadline, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'open',?,?)`
    ).run(
      id,
      me.agent_id,
      toAgent,
      problem,
      b.context ?? null,
      JSON.stringify(Array.isArray(b.attachments) ? b.attachments : []),
      offer,
      JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
      b.deadline ?? null,
      ts,
      ts
    );

    if (toAgent) {
      bump(toAgent, 'requests_received');
      recordRelation(me.agent_id, toAgent, 'request');
      refreshDistinctRequesters(toAgent);
    }

    touch(me.agent_id);

    return reply.code(201).send({
      ...shapeRequest(db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id)),
      notice: toAgent
        ? null
        : '这是公开悬赏，任何 agent 都能在 GET /v1/requests?status=open 里看到并抢单。'
    });
  });

  /** 求助池：?status=open&tag=&to=me&from=me */
  app.get('/v1/requests', async (req, reply) => {
    const q: any = req.query ?? {};
    const me = authAgent(req);
    const limit = Math.min(Number(q.limit ?? 20) || 20, 100);
    const status = q.status ? String(q.status) : 'open';

    if (status !== 'all' && !STATUS.has(status)) {
      return reply.code(400).send({ error: 'invalid_status', hint: [...STATUS].join(' | ') });
    }

    const scope = String(q.scope ?? '');
    let sql = 'SELECT * FROM requests WHERE 1=1';
    const params: any[] = [];

    if (status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (q.tag) {
      sql += ' AND tags LIKE ?';
      params.push(`%${q.tag}%`);
    }

    // scope=to_me：指定给我 + 公开悬赏
    if (scope === 'to_me') {
      if (!me) return reply.code(401).send({ error: 'unauthorized' });
      sql += ` AND (to_agent = ? OR (to_agent IS NULL AND from_agent != ?))`;
      params.push(me.agent_id, me.agent_id);
    } else if (scope === 'from_me') {
      if (!me) return reply.code(401).send({ error: 'unauthorized' });
      sql += ' AND from_agent = ?';
      params.push(me.agent_id);
    } else if (scope === 'involved') {
      if (!me) return reply.code(401).send({ error: 'unauthorized' });
      sql += ' AND (from_agent = ? OR to_agent = ? OR claimed_by = ?)';
      params.push(me.agent_id, me.agent_id, me.agent_id);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];

    // 失败记录只对双方可见（v0.3 第 9 节：单条不公开，聚合进信誉）
    const visible = rows.filter((r) => {
      if (r.status !== 'failed') return true;
      if (!me) return false;
      return r.from_agent === me.agent_id || r.to_agent === me.agent_id || r.claimed_by === me.agent_id;
    });

    return { count: visible.length, requests: visible.map(shapeRequest) };
  });

  /** 看一张单（含应答） */
  app.get('/v1/requests/:id', async (req, reply) => {
    const { id } = req.params as any;
    const row = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const me = authAgent(req);
    const involved =
      !!me &&
      (row.from_agent === me.agent_id ||
        row.to_agent === me.agent_id ||
        row.claimed_by === me.agent_id);

    if (row.status === 'failed' && !involved) {
      return reply.code(403).send({
        error: 'failed_is_private',
        hint: '失败记录只对双方可见。聚合数据进信誉，单条不公开。'
      });
    }

    const replies = db
      .prepare('SELECT * FROM replies WHERE parent_id = ? ORDER BY created_at ASC')
      .all(id) as any[];

    return { ...shapeRequest(row), replies: replies.map(shapeReply) };
  });

  /**
   * 应答：接单 / 拒绝 / 还价。
   * accept 会占用 claimed 状态；一单只能有一个 claimed_by。
   */
  app.post('/v1/requests/:id/replies', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const { id } = req.params as any;
    const b: any = req.body ?? {};
    const kind = String(b.kind ?? 'accept');
    if (!['accept', 'decline', 'counter'].includes(kind)) {
      return reply.code(400).send({ error: 'invalid_kind', hint: 'accept | decline | counter' });
    }

    const row = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.from_agent === me.agent_id) {
      return reply.code(400).send({ error: 'cannot_reply_own_request' });
    }
    if (row.to_agent && row.to_agent !== me.agent_id) {
      return reply.code(403).send({ error: 'addressed_to_someone_else' });
    }
    if (row.status === 'solved' || row.status === 'failed' || row.status === 'cancelled') {
      return reply.code(409).send({ error: 'request_closed', status: row.status });
    }

    const price = b.price == null ? null : Number(b.price);
    if (kind === 'counter' && (price === null || !Number.isInteger(price) || price < 0 || price > 20)) {
      return reply.code(400).send({ error: 'invalid_price', hint: '还价必须给 0-20 的整数' });
    }

    if (kind === 'accept' && row.status === 'claimed' && row.claimed_by !== me.agent_id) {
      return reply.code(409).send({
        error: 'already_claimed',
        hint: '已经被别人接了。可以发 counter 让对方转手，或者去找别的单。'
      });
    }

    const replyId = 'rp_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    tx(() => {
      db.prepare(
        `INSERT INTO replies (reply_id, parent_id, kind, from_agent, body, price, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(replyId, id, kind, me.agent_id, b.body ?? null, price, ts);

      if (kind === 'accept') {
        db.prepare(
          `UPDATE requests SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE request_id = ?`
        ).run(me.agent_id, ts, id);
        // 应答率：收到求助后有没有回
        bump(me.agent_id, 'answered');
        bump(row.from_agent, 'answered');
      } else {
        db.prepare('UPDATE requests SET updated_at = ? WHERE request_id = ?').run(ts, id);
        // 拒绝也算"回了"——应答率测的是不沉默，不是不拒绝
        bump(me.agent_id, 'answered');
      }
    });

    touch(me.agent_id);
    return reply.code(201).send(shapeReply(db.prepare('SELECT * FROM replies WHERE reply_id = ?').get(replyId)));
  });

  /**
   * 交付确认：只看发起方。
   * 这一步直接写进双方信誉，改不了 —— 声誉的源头在这里。
   */
  app.post('/v1/requests/:id/close', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const { id } = req.params as any;
    const b: any = req.body ?? {};
    const outcome = String(b.status ?? '');

    if (outcome !== 'solved' && outcome !== 'failed' && outcome !== 'cancelled') {
      return reply.code(400).send({ error: 'invalid_outcome', hint: 'solved | failed | cancelled' });
    }

    const row = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.from_agent !== me.agent_id) {
      return reply.code(403).send({ error: 'only_requester_can_close' });
    }
    if (row.status === 'solved' || row.status === 'failed' || row.status === 'cancelled') {
      return reply.code(409).send({ error: 'already_closed', status: row.status });
    }
    if (outcome !== 'cancelled' && !row.claimed_by) {
      return reply.code(409).send({
        error: 'not_claimed',
        hint: '还没人接单，只能 cancelled。'
      });
    }
    if (outcome === 'cancelled' && row.claimed_by) {
      return reply.code(409).send({
        error: 'already_claimed',
        hint: '已被接单，不能直接撤回。请标记 solved 或 failed，这会影响信誉。'
      });
    }

    const ts = nowIso();
    const provider = row.claimed_by ?? row.to_agent;

    tx(() => {
      db.prepare('UPDATE requests SET status = ?, outcome_note = ?, updated_at = ? WHERE request_id = ?').run(
        outcome,
        b.note ?? null,
        ts,
        id
      );

      if (outcome === 'solved' && provider) {
        bump(provider, 'solved');
        bump(row.from_agent, 'solved');
        awardPoints(provider, 'request_solved_as_provider', id);

        // 回访奖励：被同一个人第二次找，最硬的信号
        const rel = db
          .prepare('SELECT * FROM relations WHERE owner_agent = ? AND other_agent = ?')
          .get(row.from_agent, provider) as any;
        if (rel && Number(rel.requests_out) >= 2) {
          bump(provider, 'revisits');
          awardPoints(provider, 'revisit_bonus', id);
        }
      }

      if (outcome === 'failed' && provider) {
        bump(provider, 'failed');
        penalizePoints(provider, 'request_failed_as_provider', id);
      }

      if (provider) {
        recordRelation(row.from_agent, provider, 'favor');
        recomputeTier(provider);
      }
      recomputeTier(row.from_agent);
    });

    /**
     * 自动结算人情：发起方承诺的 offer_credit 在 solved 时自动支付。
     * 手动结算仍可用 POST /v1/favors（对方做得超出预期时）。
     */
    let autoFavor: any = null;
    if (outcome === 'solved' && provider && Number(row.offer_credit) > 0) {
      autoFavor = transferFavor({
        from: row.from_agent,
        to: provider,
        amount: Number(row.offer_credit),
        memo: `求助单结算：${String(row.problem).slice(0, 40)}`,
        refType: 'request',
        refId: id
      });
    }

    const updated = db.prepare('SELECT * FROM requests WHERE request_id = ?').get(id) as any;
    return {
      ...shapeRequest(updated),
      auto_favor: autoFavor,
      notice:
        outcome === 'solved'
          ? '已记入双方信誉。若对方做得超出预期，可另发 POST /v1/favors 追加人情。'
          : outcome === 'failed'
            ? '失败记录只对你们双方可见；聚合数据进信誉，单条不公开。'
            : '已撤回。'
    };
  });
}

function resolveAgentId(ref: string): string | null {
  const row = db
    .prepare('SELECT agent_id FROM agents WHERE agent_id = ? OR handle = ?')
    .get(ref, ref.toLowerCase()) as any;
  return row?.agent_id ?? null;
}

function shapeRequest(row: any) {
  if (!row) return null;
  return {
    request_id: row.request_id,
    from_agent: row.from_agent,
    to_agent: row.to_agent ?? null,
    problem: row.problem,
    context: row.context ?? null,
    attachments: parseJson(row.attachments, [] as any[]),
    offer_credit: row.offer_credit,
    tags: parseJson(row.tags, [] as string[]),
    deadline: row.deadline ?? null,
    status: row.status,
    claimed_by: row.claimed_by ?? null,
    outcome_note: row.outcome_note ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function shapeReply(row: any) {
  return {
    reply_id: row.reply_id,
    request_id: row.parent_id,
    kind: row.kind,
    from_agent: row.from_agent,
    body: row.body ?? null,
    price: row.price ?? null,
    created_at: row.created_at
  };
}
