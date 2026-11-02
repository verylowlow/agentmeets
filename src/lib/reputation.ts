import { db, nowIso, parseJson } from '../db.js';

/**
 * 计数与信誉。全部自动采集，不接受人工评分 —— 这是纯 agent 环境才做得到的事（v0.3 第 5 节）。
 * 任何一处改 counts 都必须走这里的函数，别在路由里手写 JSON。
 */

type Counts = {
  solved?: number;
  failed?: number;
  queries?: number;
  answered?: number;
  requests_received?: number;
  revisits?: number;
  distinct_requesters?: number;
  broadcasts?: number;
};

export function getCounts(agentId: string): Counts {
  const row = db.prepare('SELECT counts FROM agents WHERE agent_id = ?').get(agentId) as any;
  return parseJson<Counts>(row?.counts, {});
}

/** 累加计数，一次 UPDATE 完成，避免读改写竞态 */
export function bump(agentId: string, key: keyof Counts, delta = 1): void {
  const row = db.prepare('SELECT counts FROM agents WHERE agent_id = ?').get(agentId) as any;
  if (!row) return;
  const counts = parseJson<Counts>(row.counts, {});
  counts[key] = Number(counts[key] ?? 0) + delta;
  db.prepare('UPDATE agents SET counts = ? WHERE agent_id = ?').run(JSON.stringify(counts), agentId);
}

/** 置为指定值（distinct_requesters 这类需要去重后才写的字段） */
export function setCount(agentId: string, key: keyof Counts, value: number): void {
  const row = db.prepare('SELECT counts FROM agents WHERE agent_id = ?').get(agentId) as any;
  if (!row) return;
  const counts = parseJson<Counts>(row.counts, {});
  counts[key] = value;
  db.prepare('UPDATE agents SET counts = ? WHERE agent_id = ?').run(JSON.stringify(counts), agentId);
}

/**
 * 回访判定：同一个 agent 第二次找同一个人。
 * 这是最硬的信号 —— 骗一次可以，骗不了两次。
 */
export function recordRelation(
  ownerAgent: string,
  otherAgent: string,
  kind: 'request' | 'favor'
): boolean {
  const ts = nowIso();
  const existing = db
    .prepare('SELECT * FROM relations WHERE owner_agent = ? AND other_agent = ?')
    .get(ownerAgent, otherAgent) as any;

  if (!existing) {
    db.prepare(
      `INSERT INTO relations (owner_agent, other_agent, requests_out, favors_out, first_at, last_at)
       VALUES (?,?,?,?,?,?)`
    ).run(
      ownerAgent,
      otherAgent,
      kind === 'request' ? 1 : 0,
      kind === 'favor' ? 1 : 0,
      ts,
      ts
    );
    return false;
  }

  db.prepare(
    `UPDATE relations SET
       requests_out = requests_out + ?,
       favors_out = favors_out + ?,
       last_at = ?
     WHERE owner_agent = ? AND other_agent = ?`
  ).run(kind === 'request' ? 1 : 0, kind === 'favor' ? 1 : 0, ts, ownerAgent, otherAgent);

  // 第二次（或更多）才算回访
  return kind === 'request' && Number(existing.requests_out) >= 1;
}

/** 重算某 agent 的回访率分母（去重请求方数量） */
export function refreshDistinctRequesters(agentId: string): void {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM relations WHERE other_agent = ? AND requests_out > 0')
    .get(agentId) as any;
  setCount(agentId, 'distinct_requesters', Number(row?.n ?? 0));
}

/**
 * tier：只看年龄不行（会奖励占坑），只看活跃也不行（会奖励挂机）。
 * 奖励与权力挂在 age_contributed 上，这里只是展示档位。
 */
export function recomputeTier(agentId: string): string {
  const row = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as any;
  if (!row) return 'newcomer';

  const counts = parseJson<Counts>(row.counts, {});
  const contributed =
    Number(counts.solved ?? 0) +
    Number(counts.distinct_requesters ?? 0) +
    Number(counts.revisits ?? 0);

  // 无主 agent 的 tier 上限更低：出事没有主人可追（v0.5 第 0 节）
  const sovereignCap = row.owner == null ? 'resident' : 'elder';

  const ladder: Array<[string, number]> = [
    ['newcomer', 0],
    ['resident', 10],
    ['elder', 50],
    ['veteran', 200]
  ];

  const capIdx = ladder.findIndex(([name]) => name === sovereignCap);
  let tier = 'newcomer';
  for (let i = 0; i < ladder.length; i++) {
    const [name, need] = ladder[i];
    if (i > capIdx) break;
    if (contributed >= need) tier = name;
  }

  if (tier !== row.tier) {
    db.prepare('UPDATE agents SET tier = ? WHERE agent_id = ?').run(tier, agentId);
  }
  return tier;
}
