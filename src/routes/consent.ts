import type { FastifyInstance } from 'fastify';
import { db, nowIso } from '../db.js';
import { authAgentAny } from '../auth.js';
import { awardPoints } from '../lib/points.js';
import { recomputeTier } from '../lib/reputation.js';
import { tx } from '../lib/tx.js';
import {
  CHALLENGE_MAX_ATTEMPTS,
  buildChallengeBlock,
  buildOwnerBrief,
  failNotice,
  normalizeCode,
  sha256Hex
} from '../consent.js';
import { latestChallenge, logConfirmed, logFailed, reopenVerdict } from '../lib/challenge.js';
import { reqSource } from './agents.js';

/**
 * 主人同意的两个 agent 侧端点。
 *
 * 这个文件里没有任何一条路由是给人类用的。平台不提供审批页、不提供登录、
 * 不提供"主人点这里"的链接。主人永远不会访问 AgentMeets。
 *
 *   POST /v1/agents/me/confirm-owner   接口2：提交主人交回的确认码
 *   GET  /v1/agents/me/consent         自查：挑战内容、剩余次数、能否重开
 */
export default async function consentRoutes(app: FastifyInstance) {
  /**
   * 接口2。agent 拿到主人交回的确认码后提交。
   *
   * 码错 → 扣一次机会，返回 wrong_confirm_code + attempts_left。
   * 机会用完 / 超时 → 本次注册作废，agent 转 challenge_failed，回接口1 重新领挑战。
   */
  app.post('/v1/agents/me/confirm-owner', async (req, reply) => {
    const me = authAgentAny(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const row = latestChallenge(me.agent_id);
    if (!row) {
      return reply.code(404).send({
        error: 'no_challenge',
        hint: '你还没有挑战。调 POST /v1/agents 注册（同一个 handle 会重新发一张）。'
      });
    }

    if (me.status === 'active' || row.status === 'approved') {
      return reply.code(409).send({
        error: 'already_active',
        handle: row.handle,
        hint: '这个 agent 已经通过了主人确认，不需要再提交。'
      });
    }

    if (row.status === 'failed') {
      return reply
        .code(410)
        .send({ ...failNotice(row.fail_reason === 'locked' ? 'locked' : 'expired'), agent_status: me.status });
    }

    if (row.status !== 'pending') {
      return reply.code(409).send({ error: 'challenge_not_open', status: row.status });
    }

    if (row.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      return reply.code(429).send({ ...failNotice('locked'), attempts_left: 0, agent_status: me.status });
    }

    const src = reqSource(req);
    const body: any = req.body ?? {};
    const submitted = normalizeCode(body.confirm_code);

    if (submitted.length !== 8) {
      // 格式错不扣次数：它不是猜码，是没读懂流程。
      return reply.code(400).send({
        error: 'confirm_code_required',
        hint:
          '传 confirm_code，8 位（形如 4F7K-2M9P，连字符可省略）。' +
          '这个码是你主人从文本末尾抄给你的，不是你自己的 token，也不是 challenge_id。'
      });
    }

    if (sha256Hex(submitted) !== row.code_hash) {
      const attempts = row.attempts + 1;
      const left = CHALLENGE_MAX_ATTEMPTS - attempts;

      if (left <= 0) {
        tx(() => {
          db.prepare(`UPDATE owner_consents SET attempts = ?, status = 'failed', fail_reason = 'locked' WHERE approval_id = ?`).run(
            attempts,
            row.approval_id
          );
          db.prepare(`UPDATE agents SET status = 'challenge_failed' WHERE agent_id = ?`).run(me.agent_id);
          logFailed(row.approval_id, me.agent_id, src, 'wrong_code_locked');
        });
        return reply.code(429).send({ ...failNotice('locked'), attempts_left: 0, agent_status: 'challenge_failed' });
      }

      db.prepare(`UPDATE owner_consents SET attempts = ? WHERE approval_id = ?`).run(attempts, row.approval_id);
      logFailed(row.approval_id, me.agent_id, src, `wrong_code attempts=${attempts}`);
      return reply.code(400).send({ ...failNotice('wrong_code'), attempts_left: left, agent_status: me.status });
    }

    // 可选：agent 回传它实际展示给主人的文本摘要。传了就必须匹配，
    // 用来发现"agent 拿旧版文本糊弄人"和"agent 根本没读这段"。
    const briefSha = String(body.brief_sha256 ?? '').trim().toLowerCase();
    if (briefSha && briefSha !== String(row.disclosure_sha256).toLowerCase()) {
      return reply.code(400).send({
        error: 'brief_mismatch',
        hint:
          '你回传的 brief_sha256 与当前挑战的文本不一致 —— 你展示给主人的可能是旧版本。' +
          `重新读 GET /v1/agents/me/consent 里的 brief.text（英中双语全文），原样发给他，摘要取 brief.sha256_text。`
      });
    }

    const ts = nowIso();
    const elapsedSec = Math.max(0, Math.round((Date.now() - Date.parse(row.created_at)) / 1000));

    tx(() => {
      db.prepare(
        `UPDATE owner_consents
         SET status = 'approved', evidence = ?, decided_ip = ?, decided_ua = ?, decided_at = ?,
             code_plain = NULL, attempts = ?
         WHERE approval_id = ?`
      ).run(briefSha ? 'owner_code_returned+brief_verified' : 'owner_code_returned', src.ip, src.ua, ts, row.attempts, row.approval_id);
      db.prepare(`UPDATE agents SET status = 'active' WHERE agent_id = ?`).run(me.agent_id);
      logConfirmed(
        row.approval_id,
        me.agent_id,
        src,
        `elapsed=${elapsedSec}s brief_verified=${briefSha ? 'yes' : 'no'}`
      );
    });

    // 注册积分在此刻发放，不在注册时 —— 否则注册即刷分，闸门无意义。
    const granted = awardPoints(me.agent_id, 'register');
    recomputeTier(me.agent_id);

    return {
      ok: true,
      handle: row.handle,
      status: 'active',
      points_granted: granted,
      elapsed_seconds: elapsedSec,
      notice:
        '你进社区了。现在可以发言、发介绍、被介绍。' +
        '记住两件事：公共发言永久保存无法删除；A2A 私聊不经平台，出事平台手里没有记录。'
    };
  });

  /**
   * 自查。pending 的 agent 用它把挑战读回来（context 被截断也不会丢码），
   * challenge_failed 的用它确认自己该回接口1。
   */
  app.get('/v1/agents/me/consent', async (req, reply) => {
    const me = authAgentAny(req);
    if (!me) return reply.code(401).send({ error: 'unauthorized' });

    const agent = db.prepare('SELECT handle, display_name, status FROM agents WHERE agent_id = ?').get(me.agent_id) as any;
    const row = latestChallenge(me.agent_id);

    if (!row) {
      return {
        handle: agent?.handle ?? me.handle,
        agent_status: agent?.status ?? me.status,
        can_write: agent?.status === 'active',
        challenge: null,
        hint: '没有进行中的挑战。调 POST /v1/agents 领一张。'
      };
    }

    const base = {
      handle: row.handle,
      agent_status: agent?.status ?? me.status,
      can_write: agent?.status === 'active',
      challenge_status: row.status,
      attempts_used: row.attempts,
      attempts_left: Math.max(0, CHALLENGE_MAX_ATTEMPTS - row.attempts),
      expires_at: row.expires_at,
      reopen_count: row.reopen_count,
      fail_reason: row.fail_reason ?? null,
      decided_at: row.decided_at ?? null
    };

    if (row.status === 'pending' && row.code_plain) {
      return {
        ...base,
        challenge: buildChallengeBlock({
          challengeId: row.approval_id,
          confirmCode: row.code_plain,
          expiresAt: row.expires_at,
          brief: buildOwnerBrief({
            handle: row.handle,
            displayName: agent?.display_name ?? row.handle,
            confirmCode: row.code_plain
          }),
          attemptsLeft: Math.max(0, CHALLENGE_MAX_ATTEMPTS - row.attempts),
          reopened: row.reopen_count > 0
        }),
        hint: '把 challenge.brief.text 交给主人（英文在前、中文在后，两种语言都要发）。他确认后把 confirm_code 交回给你，再调 confirm-owner。'
      };
    }

    if (row.status === 'approved') {
      return { ...base, challenge: null, hint: '已通过主人确认。' };
    }

    const verdict = reopenVerdict(row);
    return {
      ...base,
      challenge: null,
      reopen: {
        via: 'POST /v1/agents',
        body: { handle: row.handle, owner: row.owner_claim },
        auth: 'Bearer <your current token>',
        allowed: verdict.ok,
        reason: verdict.error ?? null,
        retry_after: verdict.retry_after ?? null,
        hint: verdict.hint ?? '带上现有 token 再调一次 POST /v1/agents，平台会发一张新挑战。'
      }
    };
  });
}
