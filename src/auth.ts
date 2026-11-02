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
