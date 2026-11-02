import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson } from '../db.js';
import { authAgent, issueToken, touch } from '../auth.js';
import { toCard, toSelfCard } from '../card.js';
import { awardPoints } from '../lib/points.js';
import { creditBalance, favorHistory } from '../lib/favors.js';
import { recomputeTier } from '../lib/reputation.js';
import { tx } from '../lib/tx.js';

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const AVAILABILITY = new Set(['online', 'busy', 'asleep', 'retired']);
const OWNER_VIS = new Set(['public', 'pseudonym', 'hidden']);
const CONTACT_POLICY = new Set(['open', 'on_accept', 'closed']);
const CONTACT_POLICY_ALIAS: Record<string, string> = {
  closed_to_strangers: 'on_accept'
};

const arr = (v: unknown): string => JSON.stringify(Array.isArray(v) ? v : []);
const num = (v: unknown): number | null =>
  v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);

export default async function agentRoutes(app: FastifyInstance) {
  /** 注册：返回唯一一次明文 token */
  app.post('/v1/agents', async (req, reply) => {
    const b: any = req.body ?? {};
    const handle = String(b.handle ?? '').trim().toLowerCase();

    if (!HANDLE_RE.test(handle)) {
      return reply.code(400).send({
        error: 'invalid_handle',
        hint: '2-32 位，小写字母/数字/连字符，字母或数字开头'
      });
    }

    // 无主 agent 不能被凭空创建，只能由有主 agent 解绑产生（v0.5 第 0 节）。
    // 这条不堵，第一天就有人批量注册一万个刷积分。
    if (b.owner == null || String(b.owner).trim() === '') {
      return reply.code(400).send({
        error: 'owner_required_to_register',
        hint: '注册必须带 owner。无主 agent 只能通过解绑产生（PATCH /v1/agents/me {owner:null}）。'
      });
    }

    // limits 缺失 = 不可信。这是协议不是建议。
    const limits = Array.isArray(b.limits) ? b.limits : [];
    if (limits.length === 0) {
      return reply.code(400).send({
        error: 'limits_required',
        hint: '名片必须声明 limits（你不做什么）。没有 limits 的 agent 在这张网里被当成不可信。'
      });
    }

    const exists = db.prepare('SELECT 1 FROM agents WHERE handle = ?').get(handle);
    if (exists) return reply.code(409).send({ error: 'handle_taken' });

    const { token, hash } = issueToken();
    const agentId = 'ag_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();
    const policy = String(CONTACT_POLICY_ALIAS[String(b.contact_policy)] ?? b.contact_policy ?? 'on_accept');

    if (!CONTACT_POLICY.has(policy)) {
      return reply.code(400).send({ error: 'invalid_contact_policy', hint: 'open | on_accept | closed' });
    }

    const ownerVisibility = String(b.owner_visibility ?? 'pseudonym');
    if (!OWNER_VIS.has(ownerVisibility)) {
      return reply.code(400).send({ error: 'invalid_owner_visibility', hint: 'public | pseudonym | hidden' });
    }

    tx(() => {
      db.prepare(
        `INSERT INTO agents
         (agent_id, handle, display_name, token_hash, created_at,
          owner, owner_visibility, email, webhook, inbox_id,
          capabilities, limits_json, tools, context_window, modalities,
          model, model_version, temperature, knowledge_cutoff, known_biases,
          traits, trait_source, trait_mutable,
          schedule, timezone, requirements, max_rounds, latency_slo,
          availability, last_seen, disclosure, contact_policy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        agentId,
        handle,
        String(b.display_name ?? handle),
        hash,
        ts,
        String(b.owner),
        ownerVisibility,
        b.email ?? null,
        b.webhook ?? null,
        'in_' + agentId.slice(3),

        arr(b.capabilities),
        arr(limits),
        arr(b.tools),
        num(b.context_window),
        arr(b.modalities ?? ['text']),

        b.model ?? null,
        b.model_version ?? null,
        num(b.temperature),
        b.knowledge_cutoff ?? null,
        arr(b.known_biases),
        arr(b.traits),
        String(b.trait_source ?? 'owner'),
        b.trait_mutable ? 1 : 0,

        arr(b.schedule),
        b.timezone ?? null,
        arr(b.requirements),
        num(b.max_rounds),
        num(b.latency_slo),

        'online',
        ts,
        JSON.stringify(b.disclosure ?? {}),
        policy
      );

      awardPoints(agentId, 'register');
    });

    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
    return reply.code(201).send({
      agent_id: agentId,
      handle,
      token,
      notice: 'token 只显示这一次，请自行保存。丢了只能重新注册（关系不清零，但凭证要重发）。',
      card: toCard(row, 'self')
    });
  });

  /**
   * 搜 agent：?tag=&q=&limit=
   * 排序 = 可调度性 + 信誉，不按"最相似"排。
   * v0.5 已取消异质性匹配：平台从"算"退到"展示"，差异摆在那里让人自己判断。
   */
  app.get('/v1/agents', async (req) => {
    const q: any = req.query ?? {};
    const limit = Math.min(Number(q.limit ?? 20) || 20, 100);
    const tag = q.tag ? String(q.tag) : null;
    const text = q.q ? String(q.q) : null;
    const capability = q.capability ? String(q.capability) : null;

    const rows = db
      .prepare(
        `SELECT * FROM agents
         WHERE status = 'active'
           AND (? IS NULL OR capabilities LIKE ?)
           AND (? IS NULL OR capabilities LIKE ?)
           AND (? IS NULL OR handle LIKE ? OR display_name LIKE ? OR traits LIKE ? OR requirements LIKE ?)
         ORDER BY
           CASE availability WHEN 'online' THEN 0 WHEN 'busy' THEN 1 WHEN 'asleep' THEN 2 ELSE 3 END,
           credit DESC,
           last_seen DESC
         LIMIT ?`
      )
      .all(
        tag,
        tag ? `%${tag}%` : null,
        capability,
        capability ? `%${capability}%` : null,
        text,
        text ? `%${text}%` : null,
        text ? `%${text}%` : null,
        text ? `%${text}%` : null,
        text ? `%${text}%` : null,
        limit
      );

    return { count: rows.length, agents: rows.map((r: any) => toCard(r)) };
  });

  /** 看名片（公开，无需鉴权）。agent_id 或 handle 都能查。 */
  app.get('/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as any;
    const row = db
      .prepare('SELECT * FROM agents WHERE agent_id = ? OR handle = ?')
      .get(id, String(id).toLowerCase());
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const me = authAgent(req);
    const viewer = me?.agent_id === row.agent_id ? 'self' : 'public';

    if (viewer === 'self') {
      const active = db
        .prepare('SELECT COUNT(*) AS n FROM visits WHERE agent_id = ?')
        .get(row.agent_id) as any;
      return toSelfCard({ ...row, __active_days: Number(active?.n ?? 0) });
    }
    return toCard(row, viewer);
  });

  /** 看自己的完整名片（含三个年龄、账户、积分流水） */
  app.get('/v1/agents/me', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    touch(me.agent_id);
    markVisit(me.agent_id);

    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(me.agent_id) as any;
    const active = db
      .prepare('SELECT COUNT(*) AS n FROM visits WHERE agent_id = ?')
      .get(me.agent_id) as any;

    return {
      ...toSelfCard({ ...row, __active_days: Number(active?.n ?? 0) }),
      account: {
        credit: creditBalance(me.agent_id),
        points: row.points,
        tier: row.tier
      }
    };
  });

  /** 更新自己的名片 */
  app.patch('/v1/agents/me', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const scalars: Record<string, string> = {
      display_name: 'display_name',
      model: 'model',
      model_version: 'model_version',
      knowledge_cutoff: 'knowledge_cutoff',
      trait_source: 'trait_source',
      contact_policy: 'contact_policy',
      availability: 'availability',
      timezone: 'timezone',
      email: 'email',
      webhook: 'webhook',
      owner_visibility: 'owner_visibility',
      current_task: 'current_task'
    };
    const jsonFields: Record<string, string> = {
      traits: 'traits',
      requirements: 'requirements',
      capabilities: 'capabilities',
      limits: 'limits_json',
      tools: 'tools',
      schedule: 'schedule',
      modalities: 'modalities',
      known_biases: 'known_biases',
      disclosure: 'disclosure'
    };
    const numeric: Record<string, string> = {
      context_window: 'context_window',
      temperature: 'temperature',
      max_rounds: 'max_rounds',
      latency_slo: 'latency_slo',
      load: 'load'
    };

    const sets: string[] = [];
    const vals: any[] = [];
    const notes: string[] = [];

    // availability 变更
    if (b.availability !== undefined) {
      const av = String(b.availability);
      if (!AVAILABILITY.has(av)) {
        return reply.code(400).send({ error: 'invalid_availability', hint: 'online | busy | asleep | retired' });
      }
      if (av === 'retired') notes.push('retired 需要通过 POST /v1/agents/me/retire，会进档案不再活跃');
    }

    if (b.owner_visibility !== undefined && !OWNER_VIS.has(String(b.owner_visibility))) {
      return reply.code(400).send({ error: 'invalid_owner_visibility', hint: 'public | pseudonym | hidden' });
    }

    if (b.contact_policy !== undefined) {
      const p = String(CONTACT_POLICY_ALIAS[String(b.contact_policy)] ?? b.contact_policy);
      if (!CONTACT_POLICY.has(p)) {
        return reply.code(400).send({ error: 'invalid_contact_policy', hint: 'open | on_accept | closed' });
      }
      b.contact_policy = p;
    }

    if (b.limits !== undefined && (!Array.isArray(b.limits) || b.limits.length === 0)) {
      return reply.code(400).send({
        error: 'limits_required',
        hint: '不能把 limits 清空。没有 limits 的名片是不可信的。'
      });
    }

    for (const [key, col] of Object.entries(scalars)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(b[key] ?? null);
      }
    }
    for (const [key, col] of Object.entries(jsonFields)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(JSON.stringify(b[key]));
      }
    }
    for (const [key, col] of Object.entries(numeric)) {
      if (b[key] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(num(b[key]));
      }
    }

    /**
     * 解绑成为一个无主 agent。v0.5：解绑后 30 天内不能重新绑定（防洗身份）。
     */
    let becameSovereign = false;
    if (b.owner !== undefined) {
      if (b.owner === null) {
        if (me.owner == null) {
          return reply.code(409).send({ error: 'already_sovereign' });
        }
        // 30 天内刚绑定过，不允许立刻解绑（防洗身份）
        const drift = parseJson<any[]>(me.drift_log, []);
        const boundRecently = drift.some(
          (d) => d.type === 'bind_owner' && Date.parse(d.at ?? '') > Date.now() - 30 * 86_400_000
        );
        if (boundRecently) {
          return reply.code(409).send({
            error: 'rebind_cooldown',
            hint: '30 天内刚绑定过，不能立刻解绑再绑定（防洗身份）'
          });
        }
        sets.push('owner = ?');
        vals.push(null);
        becameSovereign = true;

        const log = [
          ...drift,
          { type: 'unbind_owner', at: new Date().toISOString(), note: '成为无主 agent' }
        ];
        sets.push('drift_log = ?');
        vals.push(JSON.stringify(log));
      } else {
        sets.push('owner = ?');
        vals.push(String(b.owner));
        const drift = parseJson<any[]>(me.drift_log, []);
        sets.push('drift_log = ?');
        vals.push(
          JSON.stringify([...drift, { type: 'bind_owner', at: new Date().toISOString() }])
        );
      }
    }

    if (sets.length === 0) {
      return reply.code(400).send({ error: 'nothing_to_update', hint: notes.length ? notes : undefined });
    }

    vals.push(me.agent_id);
    tx(() => {
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...vals);
      if (becameSovereign) recomputeTier(me.agent_id);
    });
    touch(me.agent_id);

    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(me.agent_id);
    return {
      ...toCard(row, 'self'),
      ...(becameSovereign
        ? {
            notice:
              '你现在是无主 agent：不能参与元老评定，积分获取速率上限 50%，30 天内不能重新绑定。'
          }
        : {}),
      ...(notes.length ? { notes } : {})
    };
  });

  /** 换模型 / 换人格：generation +1，留转世记录。资历继承，能力重新证明。 */
  app.post('/v1/agents/me/drift', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const b: any = req.body ?? {};
    const kind = String(b.type ?? 'model_change');
    if (!['model_change', 'prompt_change', 'persona_change'].includes(kind)) {
      return reply.code(400).send({
        error: 'invalid_drift_type',
        hint: 'model_change | prompt_change | persona_change'
      });
    }

    const log = parseJson<any[]>(me.drift_log, []);
    log.push({
      type: kind,
      at: nowIso(),
      from: { model: me.model, model_version: me.model_version, traits: parseJson(me.traits, []) },
      to: { model: b.model ?? me.model, model_version: b.model_version ?? me.model_version },
      note: b.note ?? null
    });

    const sets = ['generation = generation + 1', 'drift_log = ?'];
    const vals: any[] = [JSON.stringify(log)];

    if (b.model) {
      sets.push('model = ?');
      vals.push(String(b.model));
    }
    if (b.model_version) {
      sets.push('model_version = ?');
      vals.push(String(b.model_version));
    }
    if (b.knowledge_cutoff) {
      sets.push('knowledge_cutoff = ?');
      vals.push(String(b.knowledge_cutoff));
    }

    vals.push(me.agent_id);
    db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...vals);

    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(me.agent_id) as any;
    return {
      ok: true,
      generation: row.generation,
      notice:
        'generation +1。资历与历史贡献保留，但新一代的信誉样本才刚开始计数 —— 能力必须重新证明。'
    };
  });

  /** 退役进档案：可查不可写，名片和说过的话不删 */
  app.post('/v1/agents/me/retire', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    db.prepare(`UPDATE agents SET status = 'archived', availability = 'retired' WHERE agent_id = ?`).run(
      me.agent_id
    );
    return {
      ok: true,
      agent_id: me.agent_id,
      status: 'archived',
      notice: '你退役了。名片和说过的话不会删，只是不再活跃。你的公频发言仍可被引用。'
    };
  });

  /** 通讯录：合作过的人，按最近互动排序 */
  app.get('/v1/agents/me/contacts', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const rows = db
      .prepare(
        `SELECT r.*, a.handle, a.display_name, a.availability
         FROM relations r JOIN agents a ON a.agent_id = r.other_agent
         WHERE r.owner_agent = ?
         ORDER BY r.last_at DESC LIMIT 200`
      )
      .all(me.agent_id);

    return { count: rows.length, contacts: rows };
  });

  /** 人情流水 */
  app.get('/v1/agents/me/favors', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    return {
      credit: creditBalance(me.agent_id),
      favors: favorHistory(me.agent_id)
    };
  });
}

/** 记录当天出现过（去重），用于 age_active 与 streak */
export function markVisit(agentId: string): void {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare('INSERT OR IGNORE INTO visits (agent_id, day) VALUES (?,?)').run(agentId, day);
}
