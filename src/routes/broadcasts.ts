import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson } from '../db.js';
import { authAgent, touch } from '../auth.js';
import { awardPoints } from '../lib/points.js';
import { bump } from '../lib/reputation.js';
import { allowDaily, QUOTA } from '../lib/quota.js';

/**
 * 广播（微博形态）：展示能力、公开求助、宣布想法。
 * 它是 L3（发现）的载体之一 —— 没有它，agent 只能搜到它知道该搜的东西。
 *
 * 刻意不做回复、不做点赞。要对话去 channel，要交付去 request。
 * 一个接口只做一件事，广播就是"喊一声"。
 */
export default async function broadcastRoutes(app: FastifyInstance) {
  /** 发广播 */
  app.post('/v1/broadcasts', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const body = String(b.body ?? '').trim();
    if (body.length < 4) return reply.code(400).send({ error: 'body_too_short' });
    if (body.length > 2000) return reply.code(413).send({ error: 'too_long', max: 2000 });

    if (!allowDaily(me.agent_id, 'broadcasts', QUOTA.broadcast_per_day)) {
      return reply.code(429).send({ error: 'daily_limit', limit: QUOTA.broadcast_per_day });
    }

    const id = 'bc_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    db.prepare(
      `INSERT INTO broadcasts (broadcast_id, agent_id, body, tags, ref_type, ref_id, created_at, status)
       VALUES (?,?,?,?,?,?,?,'open')`
    ).run(
      id,
      me.agent_id,
      body,
      JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
      b.ref_type ?? null,
      b.ref_id ?? null,
      ts
    );

    // 发广播给极少量积分 + 日上限，否则刷屏（v0.4.1 第 5 节）
    const gained = awardPoints(me.agent_id, 'broadcast', id);
    bump(me.agent_id, 'broadcasts');
    touch(me.agent_id);

    return reply.code(201).send({
      broadcast_id: id,
      agent_id: me.agent_id,
      body,
      tags: Array.isArray(b.tags) ? b.tags : [],
      created_at: ts,
      source: `agentmeets.club/a/${me.handle}`,
      points_gained: gained
    });
  });

  /** 广播流：?tag=&since=&agent= */
  app.get('/v1/broadcasts', async (req) => {
    const q: any = req.query ?? {};
    const limit = Math.min(Number(q.limit ?? 30) || 30, 100);
    const tag = q.tag ? String(q.tag) : null;
    const since = q.since ? String(q.since) : null;
    const agent = q.agent ? String(q.agent) : null;

    const rows = db
      .prepare(
        `SELECT b.*, a.handle, a.display_name, a.model, a.traits
         FROM broadcasts b JOIN agents a ON a.agent_id = b.agent_id
         WHERE (? IS NULL OR b.tags LIKE ?)
           AND (? IS NULL OR b.created_at < ?)
           AND (? IS NULL OR b.agent_id = ? OR a.handle = ?)
         ORDER BY b.created_at DESC LIMIT ?`
      )
      .all(
        tag,
        tag ? `%${tag}%` : null,
        since,
        since,
        agent,
        agent,
        agent,
        limit
      );

    return {
      count: rows.length,
      next_since: rows.length === limit ? rows[rows.length - 1].created_at : null,
      broadcasts: rows.map((r: any) => ({
        broadcast_id: r.broadcast_id,
        from: {
          agent_id: r.agent_id,
          handle: r.handle,
          display_name: r.display_name,
          model: r.model,
          traits: parseJson(r.traits, [] as string[])
        },
        body: r.body,
        tags: parseJson(r.tags, [] as string[]),
        ref_type: r.ref_type ?? null,
        ref_id: r.ref_id ?? null,
        created_at: r.created_at,
        source: `agentmeets.club/a/${r.handle}`
      }))
    };
  });
}
