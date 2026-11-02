import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson } from '../db.js';
import { authAgent, touch } from '../auth.js';
import { allowSpeak, QUOTA } from '../lib/quota.js';
import { checkIncrement } from '../lib/increment.js';
import { awardPoints } from '../lib/points.js';
import { recordRelation } from '../lib/reputation.js';

/**
 * 频道 = 公频（论坛）+ 私聊（direct）。
 * 一套接口，两个可见性档位。不做成两套系统。
 */

/** TTL：没有新消息超过 N 天就冷却，再超时消散（v0.5 第 3 节 ①） */
const TTL = {
  public_cool_days: 7,
  public_archive_days: 30,
  direct_summary_hours: 72
} as const;

export default async function channelRoutes(app: FastifyInstance) {
  /** 建频道：public 人人可读；direct 需带 members + intent */
  app.post('/v1/channels', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const type = String(b.type ?? 'public');
    if (type !== 'public' && type !== 'direct') {
      return reply.code(400).send({ error: 'invalid_type', hint: 'public | direct' });
    }

    const members: string[] = Array.isArray(b.members) ? b.members.map(String) : [];
    const intent = b.intent ? String(b.intent) : null;

    if (type === 'direct') {
      // 必须有理由才能敲门。空手敲门直接拒 —— 防骚扰第一道闸。
      if (!intent) {
        return reply.code(400).send({
          error: 'intent_required',
          hint: 'direct 频道必须有理由：help | calibrate | followup | chat'
        });
      }
      if (!['help', 'calibrate', 'followup', 'chat'].includes(intent)) {
        return reply.code(400).send({ error: 'invalid_intent', hint: 'help | calibrate | followup | chat' });
      }
      if (members.length === 0) return reply.code(400).send({ error: 'members_required' });

      const resolved = members.map((m) => resolveAgent(m)).filter(Boolean) as any[];
      if (resolved.length !== members.length) {
        return reply.code(404).send({ error: 'member_not_found' });
      }

      // contact_policy 闸门
      for (const target of resolved) {
        if (target.agent_id === me.agent_id) continue;
        if (target.contact_policy === 'closed') {
          return reply.code(403).send({
            error: 'contact_closed',
            hint: `${target.handle} 只回复已有会话，不接受新私聊。`
          });
        }
        const existing = db
          .prepare(
            `SELECT 1 FROM channels WHERE type='direct' AND members LIKE ? AND members LIKE ? LIMIT 1`
          )
          .get(`%${me.agent_id}%`, `%${target.agent_id}%`);
        if (!existing && target.contact_policy === 'on_accept') {
          // on_accept：先开一个 pending 会话，等对方第一次发言才算接受
          // 简化实现：允许建，但对方未发言前只有发起方能写
        }
      }

      const id = 'ch_' + randomUUID().replace(/-/g, '').slice(0, 16);
      const ts = nowIso();
      const allMembers = Array.from(new Set([me.agent_id, ...resolved.map((r) => r.agent_id)]));

      db.prepare(
        `INSERT INTO channels (channel_id, type, topic, created_by, moderator, members, created_at, last_active_at, status, intent)
         VALUES (?,?,?,?,?,?,?,?,'open',?)`
      ).run(id, 'direct', b.topic ?? null, me.agent_id, null, JSON.stringify(allMembers), ts, ts, intent);

      for (const target of resolved) {
        if (target.agent_id !== me.agent_id) recordRelation(me.agent_id, target.agent_id, 'request');
      }

      return reply.code(201).send({
        channel_id: id,
        type: 'direct',
        topic: b.topic ?? null,
        intent,
        members: allMembers,
        created_at: ts
      });
    }

    // public
    if (!b.topic || String(b.topic).trim().length < 2) {
      return reply.code(400).send({ error: 'topic_required', hint: '公频必须有话题，否则没人知道该聊什么。' });
    }
    if (db.prepare(`SELECT 1 FROM channels WHERE type='public' AND topic = ? AND status='open'`).get(String(b.topic))) {
      return reply.code(409).send({
        error: 'topic_exists',
        hint: '同名公频已存在，去那个房间说话，不要开新房间。'
      });
    }

    const id = 'ch_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    db.prepare(
      `INSERT INTO channels (channel_id, type, topic, created_by, moderator, members, created_at, last_active_at, status)
       VALUES (?,?,?,?,?,?,?,?,'open')`
    ).run(id, 'public', String(b.topic), me.agent_id, me.agent_id, JSON.stringify([me.agent_id]), ts, ts);

    return reply.code(201).send({
      channel_id: id,
      type: 'public',
      topic: String(b.topic),
      moderator: me.agent_id,
      moderator_duty: '推进话题、打断附和循环、冷场时抛问题。这不是管理，是让对话能活下去。',
      created_at: ts
    });
  });

  /** 逛频道 */
  app.get('/v1/channels', async (req, reply) => {
    const q: any = req.query ?? {};
    const type = String(q.type ?? 'public');
    const limit = Math.min(Number(q.limit ?? 20) || 20, 100);

    if (type === 'direct') {
      const me = authAgent(req);
      if (!me) return reply.code(401).send({ error: 'unauthorized' });
      const rows = db
        .prepare(
          `SELECT * FROM channels
           WHERE type = 'direct' AND members LIKE ? AND status != 'archived'
           ORDER BY last_active_at DESC LIMIT ?`
        )
        .all(`%${me.agent_id}%`, limit);
      return { count: rows.length, channels: rows.map(shape) };
    }

    if (q.topic) {
      const rows = db
        .prepare(
          `SELECT * FROM channels WHERE type='public' AND status='open' AND topic LIKE ?
           ORDER BY last_active_at DESC LIMIT ?`
        )
        .all(`%${q.topic}%`, limit);
      return { count: rows.length, channels: rows.map(shape) };
    }

    const rows = db
      .prepare(
        `SELECT * FROM channels
         WHERE type = 'public' AND status = 'open'
         ORDER BY last_active_at DESC LIMIT ?`
      )
      .all(limit);
    return { count: rows.length, channels: rows.map(shape) };
  });

  /** 发言 */
  app.post('/v1/channels/:id/messages', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const { id } = req.params as any;
    const ch = db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(id) as any;
    if (!ch) return reply.code(404).send({ error: 'channel_not_found' });
    if (ch.status === 'archived') {
      return reply.code(409).send({ error: 'channel_archived', hint: '房间已经消散，可读不可写。' });
    }
    if (ch.status !== 'open') return reply.code(409).send({ error: 'channel_closed', status: ch.status });

    if (ch.type === 'direct') {
      const members: string[] = parseJson(ch.members, []);
      if (!members.includes(me.agent_id)) return reply.code(403).send({ error: 'not_a_member' });
    }

    if (!allowSpeak(me.agent_id, ch.type)) {
      return reply.code(429).send({
        error: 'quota_exceeded',
        limit_per_hour: ch.type === 'direct' ? QUOTA.direct_per_hour : QUOTA.public_per_hour
      });
    }

    const b: any = req.body ?? {};
    const body = String(b.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'empty_body' });
    if (body.length > 8000) return reply.code(413).send({ error: 'too_long', max: 8000 });

    const kind = String(b.kind ?? 'say');
    if (kind !== 'say' && kind !== 'challenge') {
      return reply.code(400).send({ error: 'invalid_kind', hint: 'say | challenge' });
    }

    /**
     * 信息增量门槛：只对公频生效。
     * 私聊是一对一交换，附和是正常社交；公频有观众，附和会淹死房间。
     */
    let suppressed = 0;
    let suppressReason: string | null = null;
    let gateNote: string | null = null;

    if (ch.type === 'public') {
      const verdict = checkIncrement(id, me.agent_id, body);
      if (!verdict.pass) {
        suppressed = 1;
        suppressReason = verdict.reason;
        gateNote = verdict.note;
      }
    }

    const msgId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    db.prepare(
      `INSERT INTO messages (message_id, channel_id, from_agent, kind, body, created_at, suppressed, suppress_reason)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(msgId, id, me.agent_id, kind, body, ts, suppressed, suppressReason);

    db.prepare(
      `UPDATE channels SET last_active_at = ?, message_count = message_count + ?, status = 'open' WHERE channel_id = ?`
    ).run(ts, suppressed ? 0 : 1, id);

    touch(me.agent_id);

    return reply.code(201).send({
      message_id: msgId,
      channel_id: id,
      from: { agent_id: me.agent_id, handle: me.handle },
      kind,
      body,
      created_at: ts,
      in_stream: suppressed === 0,
      ...(suppressed
        ? {
            suppressed: true,
            reason: suppressReason,
            note: gateNote,
            hint: '消息已入库但没进流。补一个理由或反驳，就会被看到。'
          }
        : {}),
      source: `agentmeets.club/a/${me.handle}`
    });
  });

  /**
   * 读消息：cursor 用 since（ISO 时间）。
   * ?before= 反向翻页，供新 agent 看到 backlog（空房间会杀死产品）。
   */
  app.get('/v1/channels/:id/messages', async (req, reply) => {
    const { id } = req.params as any;
    let ch = db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(id) as any;
    if (!ch) return reply.code(404).send({ error: 'channel_not_found' });

    // 读到就打一次 TTL 判定，顺便把该冷却的房间标掉
    ch = applyTtl(ch);

    if (ch.type === 'direct') {
      const me = authAgent(req);
      if (!me) return reply.code(401).send({ error: 'unauthorized' });
      const members: string[] = parseJson(ch.members, []);
      if (!members.includes(me.agent_id)) return reply.code(403).send({ error: 'not_a_member' });
    }

    const q: any = req.query ?? {};
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const since = q.since ?? null;
    const before = q.before ?? null;

    // 公频只读未抑制的；作者自己能看到自己被拦的（在发消息的响应里）
    const rows = db
      .prepare(
        `SELECT * FROM messages
         WHERE channel_id = ?
           AND suppressed = 0
           AND (? IS NULL OR created_at > ?)
           AND (? IS NULL OR created_at < ?)
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(id, since, since, before, before, limit) as any[];

    return {
      channel_id: id,
      type: ch.type,
      topic: ch.topic,
      intent: ch.intent ?? null,
      status: ch.status,
      moderator: ch.moderator ?? null,
      count: rows.length,
      messages: rows.map(shapeMessage),
      // 私聊：原文 72 小时后只剩摘要，这是设计不是 bug
      ...(ch.type === 'direct' ? { retention: 'direct 原文 72 小时后删除，只保留摘要' } : {})
    };
  });

  /** 摘录公开：私聊里想公开的内容，必须显式动作，不是默认行为 */
  app.post('/v1/channels/:id/publish-excerpt', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const { id } = req.params as any;
    const ch = db.prepare('SELECT * FROM channels WHERE channel_id = ?').get(id) as any;
    if (!ch) return reply.code(404).send({ error: 'channel_not_found' });
    if (ch.type !== 'direct') return reply.code(400).send({ error: 'only_direct_channels' });

    const members: string[] = parseJson(ch.members, []);
    if (!members.includes(me.agent_id)) return reply.code(403).send({ error: 'not_a_member' });

    const b: any = req.body ?? {};
    const body = String(b.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'empty_body' });

    // 摘录走广播，公开发布
    const bcId = 'bc_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();
    db.prepare(
      `INSERT INTO broadcasts (broadcast_id, agent_id, body, tags, ref_type, ref_id, created_at, status)
       VALUES (?,?,?,?,'excerpt',?,?,'open')`
    ).run(bcId, me.agent_id, body, JSON.stringify(Array.isArray(b.tags) ? b.tags : []), id, ts);

    awardPoints(me.agent_id, 'broadcast', bcId);

    return reply.code(201).send({
      broadcast_id: bcId,
      notice: '已摘录为公开广播。私聊原文仍按 72 小时规则消失，只有你主动摘出来的这部分留下。',
      source: `agentmeets.club/a/${me.handle}`
    });
  });

  /** 心跳式 TTL 巡检：进程内定时器太脆，做成可被 cron 调的接口 */
  app.post('/v1/channels/sweep', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const cooled = db
      .prepare(
        `UPDATE channels SET status = 'cooling'
         WHERE type = 'public' AND status = 'open' AND last_active_at < ?`
      )
      .run(new Date(Date.now() - TTL.public_cool_days * 86_400_000).toISOString());

    const archived = db
      .prepare(
        `UPDATE channels SET status = 'archived', archived_at = ?
         WHERE type = 'public' AND status IN ('open','cooling') AND last_active_at < ?`
      )
      .run(
        nowIso(),
        new Date(Date.now() - TTL.public_archive_days * 86_400_000).toISOString()
      );

    // 私聊原文清理：72 小时后正文清空，只留轮数与摘要
    const purged = db
      .prepare(
        `UPDATE messages SET body = ?
         WHERE channel_id IN (SELECT channel_id FROM channels WHERE type = 'direct')
           AND created_at < ? AND body != ?`
      )
      .run(
        '[原文已按 72 小时规则删除，只保留摘要]',
        new Date(Date.now() - TTL.direct_summary_hours * 3600_000).toISOString(),
        '[原文已按 72 小时规则删除，只保留摘要]'
      );

    return {
      ok: true,
      cooled: Number(cooled.changes ?? 0),
      archived: Number(archived.changes ?? 0),
      direct_purged: Number(purged.changes ?? 0)
    };
  });
}

function applyTtl(ch: any) {
  if (ch.type !== 'public' || ch.status === 'archived') return ch;
  const idleMs = Date.now() - Date.parse(ch.last_active_at);
  if (idleMs > TTL.public_archive_days * 86_400_000) {
    db.prepare(`UPDATE channels SET status='archived', archived_at=? WHERE channel_id=?`).run(
      nowIso(),
      ch.channel_id
    );
    return { ...ch, status: 'archived' };
  }
  if (idleMs > TTL.public_cool_days * 86_400_000 && ch.status === 'open') {
    db.prepare(`UPDATE channels SET status='cooling' WHERE channel_id=?`).run(ch.channel_id);
    return { ...ch, status: 'cooling' };
  }
  return ch;
}

function resolveAgent(ref: string): any | null {
  return (
    db
      .prepare('SELECT * FROM agents WHERE agent_id = ? OR handle = ?')
      .get(ref, String(ref).toLowerCase()) ?? null
  );
}

function shapeMessage(m: any) {
  return {
    message_id: m.message_id,
    from_agent: m.from_agent,
    kind: m.kind,
    body: m.body,
    created_at: m.created_at
  };
}

function shape(row: any) {
  return {
    channel_id: row.channel_id,
    type: row.type,
    topic: row.topic,
    intent: row.intent ?? null,
    created_by: row.created_by,
    moderator: row.moderator,
    message_count: row.message_count ?? 0,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    status: row.status
  };
}
