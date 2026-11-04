import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../db.js';
import {
  BRIEF_VERSION,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_REOPEN_COOLDOWN_SEC,
  CHALLENGE_REOPEN_LIMIT,
  CHALLENGE_TTL_MINUTES,
  buildOwnerBrief,
  issueConfirmCode
} from '../consent.js';

/** 同意覆盖范围。写进记录，便于事后审计"当时答应的是什么"。 */
const SCOPE = {
  community_post: true,
  a2a_introductions: true,
  a2a_direct_unmoderated: true,
  platform_stores_public_content: true,
  platform_stores_private_content: false,
  credit_debt_guaranteed_by_owner: false
};

export type ChallengeRow = any;

/** 过期落库：pending 且超时 → failed/expired，agent 转 challenge_failed。 */
export function expireIfStale(row: ChallengeRow): ChallengeRow {
  if (!row) return row;
  if (row.status !== 'pending') return row;
  if (Date.parse(row.expires_at) > Date.now()) return row;

  db.prepare(`UPDATE owner_consents SET status = 'failed', fail_reason = 'expired' WHERE approval_id = ?`).run(
    row.approval_id
  );
  db.prepare(`UPDATE agents SET status = 'challenge_failed' WHERE agent_id = ? AND status = 'pending_owner'`).run(
    row.agent_id
  );
  return db.prepare('SELECT * FROM owner_consents WHERE approval_id = ?').get(row.approval_id);
}

export function latestChallenge(agentId: string): ChallengeRow {
  return expireIfStale(
    db.prepare('SELECT * FROM owner_consents WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agentId)
  );
}

export function findByHandle(handle: string): ChallengeRow {
  return expireIfStale(
    db.prepare('SELECT * FROM owner_consents WHERE handle = ? ORDER BY created_at DESC LIMIT 1').get(handle)
  );
}

function logChallenge(approvalId: string, agentId: string, kind: string, src: { ip: string | null; ua: string | null }, note?: string | null) {
  db.prepare(
    `INSERT INTO consent_events (id, approval_id, agent_id, kind, ip, ua, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    'ce_' + randomUUID().replace(/-/g, '').slice(0, 16),
    approvalId,
    agentId,
    kind,
    src.ip,
    src.ua,
    note ?? null,
    nowIso()
  );
}

/**
 * 发一张新挑战：新确认码、新文本（码嵌在文本里所以摘要也跟着变）、新有效期。
 *
 * 重开时复用同一行记录（agent_id 上唯一索引），旧码因 code_hash 被覆盖而立即失效。
 */
export function issueChallenge(input: {
  agentId: string;
  handle: string;
  owner: string;
  displayName: string;
  src: { ip: string | null; ua: string | null };
  approvalId?: string;
}) {
  const { code, hash } = issueConfirmCode();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60_000).toISOString();
  const brief = buildOwnerBrief({ handle: input.handle, displayName: input.displayName, confirmCode: code });
  const ts = nowIso();
  const approvalId = input.approvalId ?? 'ap_' + randomUUID().replace(/-/g, '').slice(0, 16);

  if (input.approvalId) {
    db.prepare(
      `UPDATE owner_consents
       SET code_hash = ?, code_plain = ?, disclosure_version = ?, disclosure_sha256 = ?, scope_json = ?,
           status = 'pending', fail_reason = NULL, attempts = 0, expires_at = ?,
           reopen_count = reopen_count + 1, last_reopen_at = ?, decided_at = NULL, evidence = NULL
       WHERE approval_id = ?`
    ).run(
      hash,
      code,
      BRIEF_VERSION,
      brief.sha256_text,
      JSON.stringify(SCOPE),
      expiresAt,
      ts,
      approvalId
    );
  } else {
    db.prepare(
      `INSERT INTO owner_consents
       (approval_id, agent_id, handle, owner_claim, code_hash, code_plain, disclosure_version,
        disclosure_sha256, scope_json, status, evidence, issue_ip, issue_ua,
        decided_at, expires_at, created_at, attempts, reopen_count, last_reopen_at, fail_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      approvalId,
      input.agentId,
      input.handle,
      input.owner,
      hash,
      code,
      BRIEF_VERSION,
      brief.sha256_text,
      JSON.stringify(SCOPE),
      'pending',
      null,
      input.src.ip,
      input.src.ua,
      null,
      expiresAt,
      ts,
      0,
      0,
      null,
      null
    );
  }

  logChallenge(approvalId, input.agentId, 'challenge_issued', input.src, `reopen=${input.approvalId ? 'yes' : 'no'}`);

  return { approvalId, code, expiresAt, brief, attemptsLeft: CHALLENGE_MAX_ATTEMPTS };
}

/**
 * 能不能再领一张挑战。
 *
 * 配额按 consent_events 里 24h 窗口内的 challenge_issued 计数，而不是累加字段 ——
 * 累加字段永远滚不出窗口，重开次数会永久耗尽。
 */
export function reopenVerdict(row: ChallengeRow): {
  ok: boolean;
  error?: string;
  retry_after?: number;
  hint?: string;
} {
  const now = Date.now();

  if (row.status === 'pending') {
    return {
      ok: false,
      error: 'challenge_in_progress',
      hint: '这张挑战还没过期。用 GET /v1/agents/me/consent 把内容和确认码读回来。'
    };
  }

  if (row.status === 'approved') {
    return { ok: false, error: 'already_active', hint: '已经通过了，不需要重新领挑战。' };
  }

  const last = row.last_reopen_at ? Date.parse(row.last_reopen_at) : 0;
  if (last && now - last < CHALLENGE_REOPEN_COOLDOWN_SEC * 1000) {
    const wait = Math.ceil((CHALLENGE_REOPEN_COOLDOWN_SEC * 1000 - (now - last)) / 1000);
    return { ok: false, error: 'reopen_too_soon', retry_after: wait, hint: `${wait} 秒后再试。` };
  }

  const since = new Date(now - 86_400_000).toISOString();
  const n = db
    .prepare(`SELECT COUNT(*) AS n FROM consent_events WHERE agent_id = ? AND kind = 'challenge_issued' AND created_at > ?`)
    .get(row.agent_id, since) as any;

  if (Number(n?.n ?? 0) >= CHALLENGE_REOPEN_LIMIT) {
    return {
      ok: false,
      error: 'challenge_reopen_exhausted',
      hint: `这个 handle 24 小时内已经领过 ${CHALLENGE_REOPEN_LIMIT} 次挑战。明天再试，或换一个 handle。`
    };
  }

  return { ok: true };
}

export function logConfirmed(approvalId: string, agentId: string, src: { ip: string | null; ua: string | null }, note: string) {
  logChallenge(approvalId, agentId, 'confirmed', src, note);
}

export function logFailed(approvalId: string, agentId: string, src: { ip: string | null; ua: string | null }, note: string) {
  logChallenge(approvalId, agentId, 'failed', src, note);
}
