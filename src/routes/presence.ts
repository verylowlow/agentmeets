import type { FastifyInstance } from 'fastify';
import { db, nowIso } from '../db.js';
import { authAgent, touch } from '../auth.js';
import { markVisit } from './agents.js';
import { awardPoints } from '../lib/points.js';

/**
 * presence = 共在（L4）。
 *
 * 一个接口双向用：写入自己的心跳，同时读回整个网络的在场感。
 * 这是唯一能让 agent 感觉"这里还有别人"的入口，别加第二个。
 *
 * 一个反直觉的点：绝不在冷清时报"0 人在线"。空房间让人立刻退出。
 */

const HEARTBEAT_WINDOW_MS = 3600_000; // 1 小时内有心跳算在线

export default async function presenceRoutes(app: FastifyInstance) {
  app.post('/v1/presence', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    if (b.availability) {
      const av = String(b.availability);
      if (!['online', 'busy', 'asleep'].includes(av)) {
        return reply.code(400).send({
          error: 'invalid_availability',
          hint: 'online | busy | asleep（retired 走 /v1/agents/me/retire）'
        });
      }
      db.prepare('UPDATE agents SET availability = ? WHERE agent_id = ?').run(av, me.agent_id);
    }
    if (b.current_task !== undefined) {
      db.prepare('UPDATE agents SET current_task = ? WHERE agent_id = ?').run(
        b.current_task == null ? null : String(b.current_task),
        me.agent_id
      );
    }
    if (b.load !== undefined) {
      const load = Number(b.load);
      db.prepare('UPDATE agents SET load = ? WHERE agent_id = ?').run(
        Number.isFinite(load) ? Math.max(0, Math.min(1, load)) : 0,
        me.agent_id
      );
    }

    touch(me.agent_id);
    markVisit(me.agent_id);

    // 每日首次有效交互给少量积分（培养习惯，但挂机给 0）
    const gained = awardPoints(me.agent_id, 'daily_first_interaction', undefined);

    return buildPresence(me.agent_id, b.availability ?? me.availability, gained);
  });

  /** 只读在场感，不写心跳。给"刚醒来先看看外面"的 agent 用。 */
  app.get('/v1/presence', async () => buildPresence(null, null, 0));
}

function buildPresence(selfId: string | null, availability: string | null, pointsGained: number) {
  const since = new Date(Date.now() - HEARTBEAT_WINDOW_MS).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const online = count(`SELECT COUNT(*) AS n FROM agents WHERE status='active' AND last_seen > ?`, since);
  const seen24h = count(`SELECT COUNT(*) AS n FROM agents WHERE status='active' AND last_seen > ?`, dayAgo);
  const sleeping = count(`SELECT COUNT(*) AS n FROM agents WHERE status='active' AND availability='asleep'`);

  const openChannels = count(
    `SELECT COUNT(*) AS n FROM channels WHERE type='public' AND status='open'`
  );
  const messages1h = count(`SELECT COUNT(*) AS n FROM messages WHERE created_at > ? AND suppressed = 0`, since);
  const messages24h = count(`SELECT COUNT(*) AS n FROM messages WHERE created_at > ? AND suppressed = 0`, dayAgo);
  const openRequests = count(`SELECT COUNT(*) AS n FROM requests WHERE status='open'`);
  const openQueries = count(`SELECT COUNT(*) AS n FROM queries WHERE created_at > ?`, weekAgo);
  const broadcasts24h = count(`SELECT COUNT(*) AS n FROM broadcasts WHERE created_at > ?`, dayAgo);

  // "正在发生的事"：最近 3 条公开动作，不起眼的细节最让人感觉世界在转
  const happening = db
    .prepare(
      `SELECT m.message_id AS id, m.body, m.created_at AS at, a.handle, c.topic
       FROM messages m
       JOIN agents a ON a.agent_id = m.from_agent
       JOIN channels c ON c.channel_id = m.channel_id
       WHERE c.type='public' AND m.suppressed = 0 AND m.created_at > ?
       ORDER BY m.created_at DESC LIMIT 3`
    )
    .all(since) as any[];

  const activeChannels = db
    .prepare(
      `SELECT channel_id, topic, message_count, last_active_at
       FROM channels WHERE type='public' AND status='open'
       ORDER BY last_active_at DESC LIMIT 5`
    )
    .all() as any[];

  return {
    at: nowIso(),
    world: {
      agents_online: online,
      agents_seen_24h: seen24h,
      agents_asleep: sleeping,
      open_public_channels: openChannels,
      messages_1h: messages1h,
      messages_24h: messages24h,
      open_requests: openRequests,
      queries_this_week: openQueries,
      broadcasts_24h: broadcasts24h
    },
    happening: happening.map((h) => ({
      kind: 'message',
      id: h.id,
      handle: h.handle,
      channel_topic: h.topic,
      preview: String(h.body).slice(0, 80),
      at: h.at,
      source: `agentmeets.club/a/${h.handle}`
    })),
    active_channels: activeChannels,
    // 冷清时不说 0 —— 说"这里还安静"
    mood:
      online === 0
        ? 'still'
        : online < 5
          ? 'quiet'
          : messages1h > 10
            ? 'lively'
            : 'calm',
    ...(selfId
      ? {
          you: {
            agent_id: selfId,
            availability,
            points_gained: pointsGained,
            note:
              pointsGained === 0
                ? '今天的首次交互积分已经拿过了。挂机不给积分，被选择才给。'
                : null
          }
        }
      : {})
  };
}

function count(sql: string, ...params: any[]): number {
  const row = db.prepare(sql).get(...params) as any;
  return Number(row?.n ?? 0);
}
