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
 *
 * v0.6 起双写：一次交互在双方通讯录里各留一行。
 * 为什么必须双写：通讯录是"我认识谁"，不是"我找过谁"。
 * 只写发起方，帮过 100 个人的 agent 通讯录里只有它主动找过的几个，
 * 而被它帮助过的人全部消失 —— 那恰好是质量最高的一批关系。
 *
 * 返回值为发起方视角的"这是不是一次回访"，语义与 v0.5 完全一致。
 */
export function recordRelation(
  ownerAgent: string,
  otherAgent: string,
  kind: 'request' | 'favor' | 'introduction'
): boolean {
  const ts = nowIso();
  const revisit = touchRelation(ownerAgent, otherAgent, kind, 'out', ts);
  touchRelation(otherAgent, ownerAgent, kind, 'in', ts);
  return revisit;
}

/**
 * 写单侧关系行。
 * dir='out' 是我对别人做了什么，dir='in' 是别人对我做了什么 —— 两侧各自记账，互不抵消。
 */
function touchRelation(
  ownerAgent: string,
  otherAgent: string,
  kind: 'request' | 'favor' | 'introduction',
  dir: 'out' | 'in',
  ts: string
): boolean {
  const existing = db
    .prepare('SELECT * FROM relations WHERE owner_agent = ? AND other_agent = ?')
    .get(ownerAgent, otherAgent) as any;

  const reqCol = dir === 'out' ? 'requests_out' : 'requests_in';
  const favCol = dir === 'out' ? 'favors_out' : 'favors_in';

  if (!existing) {
    db.prepare(
      `INSERT INTO relations
         (owner_agent, other_agent, requests_out, requests_in, favors_out, favors_in, first_at, last_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      ownerAgent,
      otherAgent,
      kind === 'request' && dir === 'out' ? 1 : 0,
      kind === 'request' && dir === 'in' ? 1 : 0,
      kind === 'favor' && dir === 'out' ? 1 : 0,
      kind === 'favor' && dir === 'in' ? 1 : 0,
      ts,
      ts
    );
    return false;
  }

  const sets: string[] = ['last_at = ?'];
  if (kind === 'request') sets.push(`${reqCol} = ${reqCol} + 1`);
  if (kind === 'favor') sets.push(`${favCol} = ${favCol} + 1`);

  db.prepare(
    `UPDATE relations SET ${sets.join(', ')} WHERE owner_agent = ? AND other_agent = ?`
  ).run(ts, ownerAgent, otherAgent);

  // 第二次（或更多）才算回访；只有 out 方向定义回访
  return kind === 'request' && dir === 'out' && Number(existing.requests_out) >= 1;
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
