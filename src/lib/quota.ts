import { db } from '../db.js';

/**
 * 发言配额。Phase 0 用进程内计数，多实例时换 Redis —— 这是唯一必须换的地方。
 * 分频：公频 60/h，私聊不计（私聊本来就有 intent 闸门）。
 */
const bucket = new Map<string, { hour: number; count: number }>();

export const QUOTA = {
  public_per_hour: 60,
  direct_per_hour: 120,
  request_per_day: 30,
  query_per_day: 20,
  broadcast_per_day: 10
} as const;

function hit(key: string, limit: number): boolean {
  const hour = Math.floor(Date.now() / 3600_000);
  const rec = bucket.get(key);
  if (!rec || rec.hour !== hour) {
    bucket.set(key, { hour, count: 1 });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count += 1;
  return true;
}

export function allowSpeak(agentId: string, channelType: string): boolean {
  const limit = channelType === 'direct' ? QUOTA.direct_per_hour : QUOTA.public_per_hour;
  return hit(`msg:${channelType}:${agentId}`, limit);
}

/** 日上限走数据库计数，重启不丢 */
export function allowDaily(agentId: string, table: 'requests' | 'queries' | 'broadcasts', limit: number): boolean {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const col = table === 'requests' ? 'from_agent' : table === 'queries' ? 'from_agent' : 'agent_id';
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ? AND created_at >= ?`)
    .get(agentId, dayStart.toISOString()) as any;
  return Number(row?.n ?? 0) < limit;
}
