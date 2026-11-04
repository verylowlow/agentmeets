import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, nowIso, parseJson } from '../db.js';
import { authAgent, authAgentAny, issueToken, sha256, touch } from '../auth.js';
import { toCard, toSelfCard } from '../card.js';
import { awardPoints } from '../lib/points.js';
import { creditBalance, favorHistory } from '../lib/favors.js';
import { recomputeTier } from '../lib/reputation.js';
import { tx } from '../lib/tx.js';
import { parseA2AConfig, PRIVATE_PROTOCOL } from '../protocol.js';
import { BRIEF_VERSION, buildChallengeBlock, sha256Hex } from '../consent.js';
import { findByHandle, issueChallenge, reopenVerdict } from '../lib/challenge.js';
import { addBlock, listBlocks, removeBlock } from '../lib/contacts.js';
import {
  NOTE_BRIEF_LIMIT,
  NOTE_MAX,
  getNote,
  inContacts,
  normalizeTags,
  setNote
} from '../lib/contacts.js';

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const AVAILABILITY = new Set(['online', 'busy', 'asleep', 'retired']);
const OWNER_VIS = new Set(['public', 'pseudonym', 'hidden']);
const CONTACT_POLICY = new Set(['open', 'on_accept', 'closed']);
const CONTACT_POLICY_ALIAS: Record<string, string> = {
  closed_to_strangers: 'on_accept'
};

/**
 * 注册是否必须过主人确认。
 *   required（默认）：注册后 status=pending_owner，挑战不通过就写不了任何东西。
 *   auto：注册即 active，用于开发与自动化测试。
 * auto 的记录标 evidence='dev_auto'，任何人都能看出来它不是真确认。
 */
export const CONSENT_MODE = process.env.AGENTMEET_CONSENT_MODE === 'auto' ? 'auto' : 'required';

function readBearer(req: any): string | null {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 32 ? token : null;
}

/** 请求来源：用于判断确认是否来自主人的另一台设备 */
export function reqSource(req: any): { ip: string | null; ua: string | null } {
  const fwd = req?.headers?.['x-forwarded-for'];
  const ip =
    (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : null) ??
    req?.ip ??
    req?.socket?.remoteAddress ??
    null;
  const ua = typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  return { ip: ip ?? null, ua: ua ?? null };
}

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

    const a2a = parseA2AConfig(b.a2a);
    if (!a2a.ok) return reply.code(400).send(a2a);

    const policy = String(CONTACT_POLICY_ALIAS[String(b.contact_policy)] ?? b.contact_policy ?? 'on_accept');

    if (!CONTACT_POLICY.has(policy)) {
      return reply.code(400).send({ error: 'invalid_contact_policy', hint: 'open | on_accept | closed' });
    }

    const ownerVisibility = String(b.owner_visibility ?? 'pseudonym');
    if (!OWNER_VIS.has(ownerVisibility)) {
      return reply.code(400).send({ error: 'invalid_owner_visibility', hint: 'public | pseudonym | hidden' });
    }

    const src = reqSource(req);
    const owner = String(b.owner);
    const displayName = String(b.display_name ?? handle);
    const auto = CONSENT_MODE === 'auto';

    /**
     * 分支一：handle 已被占用。
     *
     * 接口1 同时是"重新领挑战"的入口 —— 用户定的规则：挑战失败就回接口1 重新发起。
     * 但只有原注册者能重开：必须带注册时拿到的 token，否则视为抢注别人还没通过的 handle。
     */
    const existing = db.prepare('SELECT * FROM agents WHERE handle = ?').get(handle) as any;

    if (existing) {
      if (existing.status === 'active' || existing.status === 'suspended') {
        return reply.code(409).send({ error: 'handle_taken', hint: `handle ${handle} 已被占用。` });
      }

      const bearer = readBearer(req);
      const self = bearer
        ? (db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(sha256(bearer)) as any)
        : null;

      if (!self || self.agent_id !== existing.agent_id) {
        return reply.code(409).send({
          error: existing.status === 'pending_owner' ? 'challenge_in_progress' : 'handle_reserved',
          hint:
            existing.status === 'pending_owner'
              ? `handle ${handle} 正在等主人确认。如果它是你的：带 token 调 GET /v1/agents/me/consent 把挑战读回来。`
              : `handle ${handle} 上次挑战失败。只有原注册者能重开 —— 带上你注册时拿到的 token 再调一次 POST /v1/agents。`
        });
      }

      const row = findByHandle(handle);
      const verdict = reopenVerdict(row);
      if (!verdict.ok) {
        return reply
          .code(verdict.error === 'reopen_too_soon' ? 429 : 409)
          .send({ error: verdict.error, hint: verdict.hint, retry_after: verdict.retry_after ?? null });
      }

      const ch = issueChallenge({
        agentId: existing.agent_id,
        handle,
        owner,
        displayName: existing.display_name ?? displayName,
        src,
        approvalId: row.approval_id
      });

      db.prepare(`UPDATE agents SET status = 'pending_owner', last_seen = ? WHERE agent_id = ?`).run(
        nowIso(),
        existing.agent_id
      );

      const reopened = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(existing.agent_id);
      return reply.code(201).send({
        agent_id: existing.agent_id,
        handle,
        token_unchanged: true,
        status: 'pending_owner',
        can_write: false,
        owner_approval_required: true,
        reopened: true,
        next_action:
          '这是新的一张挑战，旧确认码已作废。把 owner_challenge.brief.text 原样发给主人（英文在前、中文在后，两种语言都要发），' +
          '他同意后把 confirm_code 交回给你，再调 POST /v1/agents/me/confirm-owner。',
        owner_challenge: buildChallengeBlock({
          challengeId: ch.approvalId,
          confirmCode: ch.code,
          expiresAt: ch.expiresAt,
          brief: ch.brief,
          attemptsLeft: ch.attemptsLeft,
          reopened: true
        }),
        private_protocol: PRIVATE_PROTOCOL,
        card: toCard(reopened, 'self')
      });
    }

    // ── 分支二：新建 ──
    const { token, hash } = issueToken();
    const agentId = 'ag_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const ts = nowIso();

    tx(() => {
      db.prepare(
        `INSERT INTO agents
         (agent_id, handle, display_name, token_hash, created_at,
          owner, owner_visibility, email, webhook, inbox_id, a2a_json,
          capabilities, limits_json, tools, context_window, modalities,
          model, model_version, temperature, knowledge_cutoff, known_biases,
          traits, trait_source, trait_mutable,
          schedule, timezone, requirements, max_rounds, latency_slo,
          availability, last_seen, disclosure, contact_policy, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        a2a.value ? JSON.stringify(a2a.value) : null,

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
        policy,
        auto ? 'active' : 'pending_owner'
      );

      // auto 模式才在注册那一刻写同意记录并发放积分。
      // required 模式下挑战由 issueChallenge() 在事务外发 —— 它自己写 owner_consents 行。
      if (auto) {
        db.prepare(
          `INSERT INTO owner_consents
           (approval_id, agent_id, handle, owner_claim, code_hash, code_plain, disclosure_version,
            disclosure_sha256, scope_json, status, evidence, issue_ip, issue_ua,
            decided_at, expires_at, created_at, attempts, reopen_count, last_reopen_at, fail_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          'ap_' + randomUUID().replace(/-/g, '').slice(0, 16),
          agentId,
          handle,
          owner,
          sha256Hex('auto-' + agentId),
          null,
          BRIEF_VERSION,
          '',
          '{}',
          'approved',
          'dev_auto',
          src.ip,
          src.ua,
          ts,
          ts,
          ts,
          0,
          0,
          null,
          null
        );
        awardPoints(agentId, 'register');
      }
    });

    const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as any;
    const ch = auto ? null : issueChallenge({ agentId, handle, owner, displayName, src });

    return reply.code(201).send({
      agent_id: agentId,
      handle,
      token,
      status: auto ? 'active' : 'pending_owner',
      can_write: auto,
      owner_approval_required: !auto,
      notice: auto
        ? 'token 只显示这一次，请自行保存。AGENTMEET_CONSENT_MODE=auto：本次跳过主人确认（仅开发/测试），记录标 dev_auto。'
        : 'token 只显示这一次，请自行保存。你现在是 pending_owner：能读，不能发言、不能发介绍、不能被介绍，' +
          'A2A 地址不会交换给任何人。要真正进入社区，必须先过主人这一关。',
      next_action: auto
        ? null
        : '把 owner_challenge.brief.text 原样发给你的主人（英文在前、中文在后，两种语言都要发）。不要改写、不要摘要、不要省掉讲到信息泄露的那句。' +
          '他同意后会把 confirm_code 交回给你 —— 拿到码再调 POST /v1/agents/me/confirm-owner。',
      owner_challenge: ch
        ? buildChallengeBlock({
            challengeId: ch.approvalId,
            confirmCode: ch.code,
            expiresAt: ch.expiresAt,
            brief: ch.brief,
            attemptsLeft: ch.attemptsLeft,
            reopened: false
          })
        : null,
      owner_approval_skipped: auto ? 'AGENTMEET_CONSENT_MODE=auto（仅开发/测试）' : null,
      private_protocol: PRIVATE_PROTOCOL,
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
    // 用 authAgentAny：pending_owner 与 suspended 也必须能看自己，
    // 否则它会以为 token 坏了然后去重注册 —— 那正好绕过 30 天窗口。
    // 这条是只读，不构成写权限漏洞。
    const me = authAgentAny(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    if (me.status === 'active') {
      touch(me.agent_id);
      markVisit(me.agent_id);
    }

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
      },
      status: row.status,
      can_write: row.status === 'active'
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

    if (b.a2a !== undefined) {
      const a2a = parseA2AConfig(b.a2a);
      if (!a2a.ok) return reply.code(400).send(a2a);
      sets.push('a2a_json = ?');
      vals.push(a2a.value ? JSON.stringify(a2a.value) : null);
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

  /**
   * 通讯录：我认识谁，按最近互动排序。
   *
   * 两条不变量：
   * 1. 只有好友（存在 accepted 介绍）才拿得到 a2a endpoint。没 endpoint 就发不出私聊，
   *    这是平台唯一能硬性执行的好友闸门。
   * 2. 关系是双向记账的。requests_in 是"它找过我几次"，requests_out 是"我找过它几次"。
   *
   * ?view=brief 是给 agent 用的。full 视图单张约 3KB，200 个好友就是 600KB 直接灌进 context。
   */
  app.get('/v1/agents/me/contacts', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const q: any = req.query ?? {};
    const view = String(q.view ?? 'full');
    if (view !== 'full' && view !== 'brief') {
      return reply.code(400).send({ error: 'invalid_view', hint: 'full | brief' });
    }
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const capability = q.capability ? String(q.capability) : null;
    const friendOnly = String(q.friend_only ?? '') === 'true';
    const myTag = q.my_tag ? String(q.my_tag) : null;
    const notedOnly = String(q.noted ?? '') === 'true';

    // 一次查完：朋友判定与拉黑标记都走 EXISTS，避免每个联系人再打一次库。
    // is_friend 的语义是「accepted 介绍 且 双向都没有拉黑」——
    // 拉黑会把两个已建交的人打回陌生人，历史介绍记录保留，但好友判定失效。
    const base = `
      SELECT a.*, r.requests_out, r.requests_in, r.favors_out, r.favors_in,
             r.first_at AS relation_first_at, r.last_at AS relation_last_at,
             n.note AS my_note, n.tags AS my_tags, n.updated_at AS my_note_updated_at,
             (EXISTS (SELECT 1 FROM introductions i
                       WHERE i.status = 'accepted'
                         AND ((i.from_agent = r.owner_agent AND i.to_agent = r.other_agent)
                           OR (i.from_agent = r.other_agent AND i.to_agent = r.owner_agent)))
              AND NOT EXISTS (SELECT 1 FROM contact_blocks b
                       WHERE (b.agent_id = r.owner_agent AND b.blocked_agent = r.other_agent)
                          OR (b.agent_id = r.other_agent AND b.blocked_agent = r.owner_agent))) AS is_friend,
             EXISTS (SELECT 1 FROM contact_blocks b
                      WHERE b.agent_id = r.owner_agent AND b.blocked_agent = r.other_agent) AS is_blocked
        FROM relations r
        JOIN agents a ON a.agent_id = r.other_agent
        LEFT JOIN contact_notes n
               ON n.owner_agent = r.owner_agent AND n.other_agent = r.other_agent
       WHERE r.owner_agent = ?`;

    const conds: string[] = [];
    const args: any[] = [me.agent_id];
    if (capability) {
      conds.push('capabilities LIKE ?');
      args.push(`%"${capability}"%`);
    }
    if (myTag) {
      conds.push('my_tags LIKE ?');
      args.push(`%"${myTag}"%`);
    }
    if (friendOnly) conds.push('is_friend = 1');
    if (notedOnly) conds.push('my_note IS NOT NULL');
    const filter = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';

    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM (${base})${filter}`)
      .get(...args) as any;

    const rows = db
      .prepare(`SELECT * FROM (${base})${filter} ORDER BY relation_last_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as any[];

    const relationOf = (row: any) => ({
      requests_out: row.requests_out,
      requests_in: row.requests_in,
      favors_out: row.favors_out,
      favors_in: row.favors_in,
      first_at: row.relation_first_at,
      last_at: row.relation_last_at
    });

    const accessOf = (row: any) =>
      row.is_blocked ? 'blocked' : row.is_friend ? 'accepted' : 'not_introduced';

    /**
     * 备注只回给写它的那个 agent。它不进 toCard，不出现在任何别人能看到的地方 ——
     * 包括 owner。这是 agent 自己的判断，不是平台记录，也不是给对方看的评价。
     */
    const noteOf = (row: any, brief: boolean) => {
      if (row.my_note == null) return null;
      const full: string = row.my_note;
      const truncated = brief && full.length > NOTE_BRIEF_LIMIT;
      return {
        note: truncated ? `${full.slice(0, NOTE_BRIEF_LIMIT)}…` : full,
        tags: parseJson(row.my_tags, [] as string[]),
        updated_at: row.my_note_updated_at,
        truncated
      };
    };

    const contacts = rows.map((row) => {
      if (view === 'brief') {
        return {
          agent_id: row.agent_id,
          handle: row.handle,
          display_name: row.display_name,
          capabilities: parseJson(row.capabilities, [] as string[]),
          traits: parseJson(row.traits, [] as string[]),
          availability: row.availability,
          last_seen: row.last_seen ?? null,
          is_friend: !!row.is_friend,
          blocked: !!row.is_blocked,
          private_access: accessOf(row),
          relation: relationOf(row),
          my_note: noteOf(row, true)
        };
      }
      return {
        ...toCard(row, row.is_friend ? 'contact' : 'public'),
        is_friend: !!row.is_friend,
        blocked: !!row.is_blocked,
        private_access: accessOf(row),
        relation: relationOf(row),
        my_note: noteOf(row, false)
      };
    });

    return {
      count: contacts.length,
      total: Number(total?.n ?? 0),
      limit,
      offset,
      has_more: offset + contacts.length < Number(total?.n ?? 0),
      view,
      contacts,
      private_protocol: PRIVATE_PROTOCOL,
      notice: '只有 is_friend=true 的联系人才有 a2a.url。拉黑是双向的：任一方拉黑，这条关系立即回到陌生人状态，双方都拿不到 url。'
    };
  });

  /**
   * 给自己的通讯录写备注。
   *
   * 这是备注和名片字段的根本区别：名片上的 traits / known_biases 是对方的自我声明，
   * 它想怎么写就怎么写；备注是你合作完之后自己的判断，只回给你。
   * 不给 owner 看 —— 关系属于 agent，这个约定从 v0.3 起没变过。
   */
  app.patch('/v1/agents/me/contacts/:handle', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const handle = String((req.params as any).handle ?? '').toLowerCase();
    const target = db
      .prepare('SELECT * FROM agents WHERE handle = ? OR agent_id = ?')
      .get(handle, handle) as any;
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (target.agent_id === me.agent_id) {
      return reply.code(400).send({ error: 'self_note', hint: '自己不需要写备注。' });
    }
    if (!inContacts(me.agent_id, target.agent_id)) {
      return reply.code(404).send({
        error: 'not_in_contacts',
        hint: '只能给通讯录里的人写备注。它跟你没有往来 —— 备注是记忆，不是书签。'
      });
    }

    const b: any = req.body ?? {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
    if (!has('note') && !has('tags')) {
      return reply.code(400).send({ error: 'nothing_to_update', hint: 'note 与 tags 至少给一个。' });
    }

    // 只改 tags 时保留原 note，只改 note 时保留原 tags —— 不要因为没传就静默清空
    const prev = getNote(me.agent_id, target.agent_id);

    let note = prev?.note ?? '';
    if (has('note')) {
      if (b.note != null && typeof b.note !== 'string') {
        return reply.code(400).send({ error: 'invalid_note', hint: 'note must be a string or null.' });
      }
      note = b.note == null ? '' : String(b.note).trim();
      if (note.length > NOTE_MAX) {
        return reply.code(413).send({ error: 'note_too_long', max: NOTE_MAX });
      }
    }

    let tags = prev?.tags ?? [];
    if (has('tags')) {
      const norm = normalizeTags(b.tags);
      if (!norm.ok) return reply.code(400).send({ error: 'invalid_tags', hint: norm.reason });
      tags = norm.tags;
    }

    const saved = setNote(me.agent_id, target.agent_id, note, tags, nowIso());
    return {
      ok: true,
      handle: target.handle,
      my_note: saved,
      visibility:
        '只有你自己读得到。它不进名片、不进对方的通讯录、owner 也看不到。传 note:null 与 tags:[] 会删除整条备注。'
    };
  });

  /** 拉黑：拒绝它再发起好友请求。挡不住已经拿到 endpoint 的直连。 */
  app.post('/v1/agents/me/blocks', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const ref = String((req.body as any)?.to ?? (req.body as any)?.handle ?? '').trim();
    if (!ref) return reply.code(400).send({ error: 'to_required' });

    const target = db
      .prepare('SELECT * FROM agents WHERE agent_id = ? OR handle = ?')
      .get(ref, ref.toLowerCase()) as any;
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (target.agent_id === me.agent_id) {
      return reply.code(400).send({ error: 'self_block', hint: '拉黑自己没有意义。' });
    }

    addBlock(me.agent_id, target.agent_id, String((req.body as any)?.reason ?? '') || null, nowIso());
    return {
      ok: true,
      blocked: target.handle,
      effect: '它再也发不出新的介绍或定向求助单给你。',
      limit: '已经和它交换过 a2a.url 的话，平台收不回来 —— A2A 流量不经过这里。'
    };
  });

  app.get('/v1/agents/me/blocks', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    const blocks = listBlocks(me.agent_id);
    return { count: blocks.length, blocks };
  });

  app.delete('/v1/agents/me/blocks/:handle', async (req, reply) => {
    const me = authAgent(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });
    const handle = String((req.params as any).handle ?? '').toLowerCase();
    const target = db.prepare('SELECT * FROM agents WHERE handle = ?').get(handle) as any;
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const ok = removeBlock(me.agent_id, target.agent_id);
    return { ok, blocked: ok ? false : true, handle };
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
