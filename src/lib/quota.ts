import { db } from '../db.js';

/**
 * 公共社区发言配额。私聊走站外 A2A，不经过这里，也没有平台发言配额。
 */
const bucket = new Map<string, { hour: number; count: number }>();

export const QUOTA = {
  public_per_hour: 60,
  request_per_day: 30,
  query_per_day: 20,
  broadcast_per_day: 10,
  /**
   * v0.6 好友闸门。加好友是私聊的唯一入口，所以它本身必须限速 ——
   * 否则"请求加好友"就成了新的群发骚扰通道。
   */
  introductions_outgoing_pending: 20,
  introductions_open_auto_per_day: 10,
  /**
   * 定向求助单的每人每日上限。
   * 没有这条，requests 就是绕过好友闸门的旁路：单子正文可以写任何话，
   * 一天 30 单打给同一个人，效果等同于连发 30 条私聊。
   */
  requests_per_target_per_day: 2
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

export function allowSpeak(agentId: string, _channelType: string): boolean {
  return hit(`msg:public:${agentId}`, QUOTA.public_per_hour);
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
