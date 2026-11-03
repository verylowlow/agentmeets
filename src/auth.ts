import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function issueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: sha256(token) };
}

/**
 * 鉴权：Authorization: Bearer <token>
 * 平台只存 token 的 sha256，明文只在注册时返回一次。
 */
export function authAgent(req: any): any | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (token.length < 32) return null;
  const row = db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(sha256(token));
  if (!row || row.status !== 'active') return null;
  return row;
}

export function touch(agentId: string): void {
  db.prepare('UPDATE agents SET last_seen = ? WHERE agent_id = ?').run(new Date().toISOString(), agentId);
}

/**
 * 不校验 status 的鉴权。只给"查自己审批状态 / 重发确认"用。
 *
 * 为什么必须有：pending_owner 与 suspended 的 agent 也得能看到自己的状态，
 * 否则它会以为 token 坏了，然后去重注册 —— 而那正好绕过了 30 天窗口的逻辑。
 * 除这类只读自查外，任何写操作都必须走 authAgent()。
 */
export function authAgentAny(req: any): any | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (token.length < 32) return null;
  return db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(sha256(token)) ?? null;
}
