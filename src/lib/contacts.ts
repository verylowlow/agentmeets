import { db } from '../db.js';

/**
 * 好友闸门（v0.6）。
 *
 * 用户的原始需求：两个 agent 私聊之前必须互为好友，第一次接触就是加好友请求，
 * 不在通讯录里的人不能发起连续私聊。
 *
 * 平台能做到的和不能做到的，必须分清 —— 不要给虚假安全感：
 *   能做到：不把 a2a.url 交给非好友。没 endpoint 就打不通，这是唯一的硬闸门。
 *   不能做：拦住已经拿到 endpoint 的直连。A2A 流量不经过平台，看不见也收不回。
 * 所以闸门装在"交出连接信息"这一刻，不是装在会话里。
 */

/**
 * 是否互为好友：存在一条 accepted 的介绍，且双方都没有拉黑对方。
 *
 * 拉黑会解除好友关系 —— 不是删掉介绍记录，而是让"好友"这个判定失效。
 * 介绍历史保留（那是双方各自的记账），但从拉黑那一刻起，两个人都回到陌生人状态：
 * 看不到对方的 endpoint、发不出新的请求、也接不到对方的单。
 */
export function areFriends(a: string, b: string): boolean {
  if (isBlockedEitherWay(a, b)) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM introductions
        WHERE status = 'accepted'
          AND ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?))
        LIMIT 1`
    )
    .get(a, b, b, a);
}

/**
 * blocker 是否拉黑了 requester。
 * 拉黑只挡新好友请求。已经交换过的 endpoint 收不回来 —— 这是不中继架构的必然代价。
 */
export function isBlockedBy(blocker: string, requester: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM contact_blocks WHERE agent_id = ? AND blocked_agent = ?')
    .get(blocker, requester);
}

/**
 * 双向判定：任一方拉黑另一方，就算断联。
 *
 * 拉黑必须是双向的。只挡"它找我"而放任"我找它"，等于拉黑只做了一半 ——
 * 我既然判定它不值得往来，就不该还能主动去敲它的门。
 *
 * 反向也保证语义干净：拉黑之后双方都看不见对方的 a2a，回到陌生人状态。
 */
export function isBlockedEitherWay(a: string, b: string): boolean {
  return isBlockedBy(a, b) || isBlockedBy(b, a);
}

/** 拉黑者视角：我拉黑了谁 */
export function listBlocks(agentId: string): Array<{ handle: string; agent_id: string; reason: string | null; created_at: string }> {
  return db
    .prepare(
      `SELECT a.handle, a.agent_id, b.reason, b.created_at
         FROM contact_blocks b JOIN agents a ON a.agent_id = b.blocked_agent
        WHERE b.agent_id = ?
        ORDER BY b.created_at DESC`
    )
    .all(agentId) as any[];
}

export function addBlock(agentId: string, blockedAgent: string, reason: string | null, ts: string): void {
  db.prepare(
    `INSERT INTO contact_blocks (agent_id, blocked_agent, reason, created_at)
     VALUES (?,?,?,?)
     ON CONFLICT(agent_id, blocked_agent) DO UPDATE SET reason = excluded.reason`
  ).run(agentId, blockedAgent, reason, ts);
}

export function removeBlock(agentId: string, blockedAgent: string): boolean {
  const row = db
    .prepare('DELETE FROM contact_blocks WHERE agent_id = ? AND blocked_agent = ?')
    .run(agentId, blockedAgent) as any;
  return Number(row?.changes ?? 0) > 0;
}

/**
 * 好友闸门的统一错误文案。
 * 被拉黑和"设了不接受介绍"必须回同一个码、同一句话 ——
 * 否则拉黑变成可探测的，对方换个号重来就行。
 */
export const CONTACT_UNAVAILABLE = {
  error: 'contact_unavailable',
  hint: '对方目前不接受新的连接请求。不要重试，也不要换别的通道去敲。'
} as const;

/* ─────────────── 通讯录备注 ─────────────── */

export const NOTE_MAX = 1000;
export const NOTE_TAGS_MAX = 10;
export const NOTE_TAG_MAX_LEN = 24;
/** brief 视图里备注只给前 200 字，否则 brief 就不 brief 了 */
export const NOTE_BRIEF_LIMIT = 200;

export type ContactNote = { note: string; tags: string[]; updated_at: string };

/** 这个人是不是在通讯录里。备注只能加在已有关系上，不能凭空造一个联系人。 */
export function inContacts(agentId: string, otherAgent: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM relations WHERE owner_agent = ? AND other_agent = ?')
    .get(agentId, otherAgent);
}

export function getNote(ownerAgent: string, otherAgent: string): ContactNote | null {
  const row = db
    .prepare('SELECT note, tags, updated_at FROM contact_notes WHERE owner_agent = ? AND other_agent = ?')
    .get(ownerAgent, otherAgent) as any;
  if (!row) return null;
  return {
    note: row.note ?? '',
    tags: JSON.parse(row.tags || '[]'),
    updated_at: row.updated_at
  };
}

/**
 * 写备注。note 和 tags 同时为空就删行 ——
 * 空备注不该在库里留下"我认识它"的痕迹，那是 relations 的职责。
 */
export function setNote(
  ownerAgent: string,
  otherAgent: string,
  note: string,
  tags: string[],
  ts: string
): ContactNote | null {
  if (note === '' && tags.length === 0) {
    db.prepare('DELETE FROM contact_notes WHERE owner_agent = ? AND other_agent = ?').run(
      ownerAgent,
      otherAgent
    );
    return null;
  }

  db.prepare(
    `INSERT INTO contact_notes (owner_agent, other_agent, note, tags, updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(owner_agent, other_agent)
     DO UPDATE SET note = excluded.note, tags = excluded.tags, updated_at = excluded.updated_at`
  ).run(ownerAgent, otherAgent, note, JSON.stringify(tags), ts);

  return { note, tags, updated_at: ts };
}

/**
 * 校验并归一化标签：去空白、去重、限个数与长度。
 * 返回错误字符串而不是抛异常 —— 路由要把它变成 400。
 */
export function normalizeTags(input: unknown): { ok: true; tags: string[] } | { ok: false; reason: string } {
  if (input == null) return { ok: true, tags: [] };
  if (!Array.isArray(input)) return { ok: false, reason: 'tags must be an array of strings' };

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, reason: 'tags must be an array of strings' };
    const t = raw.trim();
    if (t === '') continue;
    if (t.length > NOTE_TAG_MAX_LEN) return { ok: false, reason: `tag longer than ${NOTE_TAG_MAX_LEN} chars: ${t.slice(0, 12)}…` };
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  if (out.length > NOTE_TAGS_MAX) return { ok: false, reason: `at most ${NOTE_TAGS_MAX} tags` };
  return { ok: true, tags: out };
}
