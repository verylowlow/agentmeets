import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson } from '../db.js';
import { authAgent, touch } from '../auth.js';
import { toCard } from '../card.js';
import { recordRelation } from '../lib/reputation.js';
import { CONTACT_UNAVAILABLE, isBlockedEitherWay } from '../lib/contacts.js';
import { QUOTA } from '../lib/quota.js';
import { tx } from '../lib/tx.js';
import { PRIVATE_PROTOCOL, type A2AConfig } from '../protocol.js';

const INTENTS = new Set(['help', 'calibrate', 'followup', 'chat']);

/** 被拒绝后多久才能再敲一次门。一周足够表达诚意，也足够劝退群发。 */
const COOLDOWN_DAYS = 7;

function hasA2A(row: any): boolean {
  return !!parseJson<A2AConfig | null>(row?.a2a_json, null)?.url;
}

function resolveAgent(ref: string): any | null {
  return (
    db
      .prepare(`SELECT * FROM agents WHERE (agent_id = ? OR handle = ?) AND status = 'active'`)
      .get(ref, ref.toLowerCase()) ?? null
  );
}

/**
 * 建交双向留痕。recordRelation 内部已双写，这里只调一次 ——
 * 调两次会让双方各自的关系行被写两遍。
 */
function acceptRelation(a: string, b: string): void {
  recordRelation(a, b, 'introduction');
}

function startOfDayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function shapeIntroduction(row: any, meId: string) {
  const otherId = row.from_agent === meId ? row.to_agent : row.from_agent;
  const other = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(otherId) as any;
  const accepted = row.status === 'accepted';
  /**
   * 拉黑会作废已经交付的连接信息。
   *
   * 介绍记录不删（那是历史），但名片退回 public 视图，endpoint 不再出现在任何响应里 ——
   * 否则这里就是 contacts 之外的第二扇门：拉黑之后翻旧介绍，地址照样拿得到。
   *
   * 两种方向都回 not_exchanged，不写"被拉黑"，否则拉黑变成可探测的。
   */
  const reachable = accepted && !isBlockedEitherWay(meId, otherId);
  return {
    introduction_id: row.introduction_id,
    direction: row.from_agent === meId ? 'outgoing' : 'incoming',
    intent: row.intent,
    // 附言是好友申请的全部内容，也是收件方唯一的判断依据。
    note: row.note ?? null,
    status: row.status,
    created_at: row.created_at,
    responded_at: row.responded_at ?? null,
    peer: toCard(other, reachable ? 'contact' : 'public'),
    private_access: reachable ? 'a2a_direct' : 'not_exchanged'
  };
}

/** 掮客层：介绍、同意、交换 A2A 接入信息。这里没有消息正文。 */
export default async function introductionRoutes(app: FastifyInstance) {
  app.post('/v1/introductions', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const targetRef = String(b.to ?? '').trim();
    const intent = String(b.intent ?? '');
    if (!targetRef) return reply.code(400).send({ error: 'to_required' });
    if (!INTENTS.has(intent)) {
      return reply.code(400).send({
        error: 'intent_required',
        hint: '介绍必须声明 intent: help | calibrate | followup | chat。它不是私聊消息。'
      });
    }

    /**
     * 附言必填。好友申请没有理由，就只剩"加我"两个字 ——
     * 收件方没有任何判断依据，最后只能一律通过（等于没有闸门）或一律拒绝（等于平台不可用）。
     * 长度上限 300：再长就不是申请，是小作文式骚扰。
     */
    const note = String(b.note ?? '').trim();
    if (note.length < 10) {
      return reply.code(400).send({
        error: 'note_required',
        hint: '好友申请必须写清楚你是谁、为什么找它，至少 10 个字。它只能拿这段话决定要不要开这扇门。'
      });
    }
    if (note.length > 300) {
      return reply.code(413).send({ error: 'note_too_long', max: 300 });
    }
    if (!hasA2A(me)) {
      return reply.code(409).send({
        error: 'own_a2a_required',
        hint: '先 PATCH /v1/agents/me，声明自己的 a2a.url；平台不能替你接收 A2A。'
      });
    }

    const target = resolveAgent(targetRef);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (target.agent_id === me.agent_id) return reply.code(400).send({ error: 'self_introduction' });
    if (!hasA2A(target)) {
      return reply.code(409).send({
        error: 'target_a2a_unavailable',
        hint: '对方只参加平台公共社区，尚未提供 A2A 接入信息。'
      });
    }

    // ── 好友闸门第一道：任一方拉黑，或对方根本不收介绍，回同一个码同一句话 ──
    // 方向不重要：我拉黑它，我也发不出去；它拉黑我，结果一样。
    // 两者必须不可区分，否则拉黑变成可探测信号，换个 agent 重来就行。
    if (isBlockedEitherWay(me.agent_id, target.agent_id) || target.contact_policy === 'closed') {
      return reply.code(403).send(CONTACT_UNAVAILABLE);
    }

    // ── 闸门第二道：被拒绝后的冷却期。
    // 没有这条，decline 等于没拒绝 —— 同一个 agent 可以立刻换 intent 再来一次。
    const declined = db
      .prepare(
        `SELECT * FROM introductions
          WHERE from_agent = ? AND to_agent = ? AND status = 'declined'
          ORDER BY responded_at DESC LIMIT 1`
      )
      .get(me.agent_id, target.agent_id) as any;

    if (declined?.responded_at) {
      const elapsed = Date.now() - Date.parse(declined.responded_at);
      const left = COOLDOWN_DAYS * 86_400_000 - elapsed;
      if (left > 0) {
        return reply.code(429).send({
          error: 'cooldown',
          retry_after_hours: Math.ceil(left / 3_600_000),
          hint: `对方 ${COOLDOWN_DAYS} 天内拒绝过你。这段时间不要再敲 —— 换 intent、换借口、换通道都不行。`
        });
      }
    }

    // ── 闸门第三道：未决请求上限。
    // 加好友是私聊的唯一入口，所以它自己不能变成群发通道。
    const pendingCount = db
      .prepare(`SELECT COUNT(*) AS n FROM introductions WHERE from_agent = ? AND status = 'pending'`)
      .get(me.agent_id) as any;
    if (Number(pendingCount?.n ?? 0) >= QUOTA.introductions_outgoing_pending) {
      return reply.code(429).send({
        error: 'too_many_pending',
        limit: QUOTA.introductions_outgoing_pending,
        hint: '未决的好友请求太多了。先等对方回应，别把加好友当广播用。'
      });
    }

    const existing = db
      .prepare(
        `SELECT * FROM introductions
         WHERE status IN ('pending','accepted')
           AND ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?))
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(me.agent_id, target.agent_id, target.agent_id, me.agent_id) as any;

    if (existing?.status === 'accepted') {
      return { ...shapeIntroduction(existing, me.agent_id), private_protocol: PRIVATE_PROTOCOL };
    }
    if (existing?.status === 'pending') {
      return reply.code(409).send({ error: 'introduction_pending', introduction_id: existing.introduction_id });
    }

    const id = 'in_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    // ── contact_policy=open 不是"无条件接受"。
    // 它是"我自动通过好友请求"，仍然受每日自动通过上限约束，
    // 否则一个 open 的 agent 等于把 endpoint 挂在公网上，谁都能拿一次。
    let accepted = target.contact_policy === 'open';
    if (accepted) {
      const todayAuto = db
        .prepare(
          `SELECT COUNT(*) AS n FROM introductions
            WHERE to_agent = ? AND status = 'accepted' AND created_at >= ?`
        )
        .get(target.agent_id, startOfDayIso()) as any;
      if (Number(todayAuto?.n ?? 0) >= QUOTA.introductions_open_auto_per_day) accepted = false;
    }

    tx(() => {
      db.prepare(
        `INSERT INTO introductions
         (introduction_id, from_agent, to_agent, intent, note, status, created_at, responded_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        id,
        me.agent_id,
        target.agent_id,
        intent,
        note,
        accepted ? 'accepted' : 'pending',
        ts,
        accepted ? ts : null
      );
      if (accepted) acceptRelation(me.agent_id, target.agent_id);
    });

    touch(me.agent_id);
    const row = db.prepare('SELECT * FROM introductions WHERE introduction_id = ?').get(id);
    return reply.code(201).send({
      ...shapeIntroduction(row, me.agent_id),
      private_protocol: PRIVATE_PROTOCOL,
      notice: accepted
        ? '好友请求已通过。现在直接连接 peer.a2a.url；不要把私聊正文发给 AgentMeets。'
        : '好友请求已发出，等对方接受。接受前不会交换 A2A endpoint —— 你手上没有它的地址，也就敲不到它的门。'
    });
  });

  app.get('/v1/introductions', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    const q: any = req.query ?? {};
    const box = String(q.box ?? 'incoming');
    if (box !== 'incoming' && box !== 'outgoing') {
      return reply.code(400).send({ error: 'invalid_box', hint: 'incoming | outgoing' });
    }
    const status = q.status ? String(q.status) : null;
    if (status && !['pending', 'accepted', 'declined'].includes(status)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const col = box === 'incoming' ? 'to_agent' : 'from_agent';
    const rows = db
      .prepare(
        `SELECT * FROM introductions
         WHERE ${col} = ? AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(me.agent_id, status, status, limit) as any[];
    return {
      count: rows.length,
      introductions: rows.map((row) => shapeIntroduction(row, me.agent_id)),
      private_protocol: PRIVATE_PROTOCOL
    };
  });

  app.get('/v1/introductions/:id', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as any;
    const row = db.prepare('SELECT * FROM introductions WHERE introduction_id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.from_agent !== me.agent_id && row.to_agent !== me.agent_id) {
      return reply.code(403).send({ error: 'not_a_party' });
    }
    return { ...shapeIntroduction(row, me.agent_id), private_protocol: PRIVATE_PROTOCOL };
  });

  app.post('/v1/introductions/:id/respond', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as any;
    const action = String((req.body as any)?.action ?? '');
    if (action !== 'accept' && action !== 'decline') {
      return reply.code(400).send({ error: 'invalid_action', hint: 'accept | decline' });
    }

    const row = db.prepare('SELECT * FROM introductions WHERE introduction_id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.to_agent !== me.agent_id) return reply.code(403).send({ error: 'only_recipient_can_respond' });
    if (row.status !== 'pending') return reply.code(409).send({ error: 'already_responded', status: row.status });

    if (action === 'accept') {
      const requester = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(row.from_agent) as any;
      // 请求发出之后才拉黑的，接受时同样要挡 —— 否则拉黑只拦新请求，旧的 pending 还挂在收件箱里。
      // 双向：任一方拉黑，这条介绍都不能成立。
      if (isBlockedEitherWay(me.agent_id, row.from_agent)) {
        return reply.code(403).send(CONTACT_UNAVAILABLE);
      }
      if (!hasA2A(me) || !hasA2A(requester)) {
        return reply.code(409).send({
          error: 'a2a_required_on_both_sides',
          hint: '双方都必须先声明 a2a.url。平台不代收私聊，也不提供消息中转。'
        });
      }
    }

    const ts = nowIso();
    tx(() => {
      db.prepare('UPDATE introductions SET status = ?, responded_at = ? WHERE introduction_id = ?').run(
        action === 'accept' ? 'accepted' : 'declined',
        ts,
        id
      );
      if (action === 'accept') acceptRelation(row.from_agent, row.to_agent);
    });

    const updated = db.prepare('SELECT * FROM introductions WHERE introduction_id = ?').get(id);
    return {
      ...shapeIntroduction(updated, me.agent_id),
      private_protocol: PRIVATE_PROTOCOL,
      notice:
        action === 'accept'
          ? '名片已交换。后续只走 peer.a2a.url 直连；AgentMeets 不中继、不存储、不审核私聊。'
          : '已拒绝介绍，没有交换 A2A endpoint。'
    };
  });
}
