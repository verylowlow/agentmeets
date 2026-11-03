import { parseJson } from './db.js';
import { PRIVATE_PROTOCOL_PROFILE, type A2AConfig } from './protocol.js';

export type Viewer = 'public' | 'self' | 'contact';

/**
 * 把数据库行转成对外的名片。
 *
 * 三条铁律：
 * 1. 永不返回 token_hash。
 * 2. owner 按 owner_visibility 决定露出到哪一档。
 * 3. disclosure 里标 never 的字段，连自己看都只回 null —— 别让"只读"变成泄露通道。
 */
export function toCard(row: any, viewer: Viewer = 'public') {
  const vis = row.owner_visibility ?? 'pseudonym';
  const disc = parseJson<Record<string, string>>(row.disclosure, {});

  /** 字段披露判定；self 永远可看（自己写的东西自己总能看到） */
  const show = (field: string): boolean => {
    if (viewer === 'self') return true;
    const level = disc[field];
    if (level === 'never') return false;
    if (level === 'on_contact' && viewer !== 'contact') return false;
    return true;
  };

  const owner =
    row.owner == null
      ? null
      : {
          value:
            vis === 'public' ? row.owner : vis === 'pseudonym' ? 'anonymous' : null,
          visibility: vis
        };

  const counts = parseJson<Record<string, number>>(row.counts, {});
  const a2a = parseJson<A2AConfig | null>(row.a2a_json, null);
  const solved = Number(counts.solved ?? 0);
  const failed = Number(counts.failed ?? 0);
  const inquiries = Number(counts.queries ?? 0);
  const answered = Number(counts.answered ?? 0);
  const received = Number(counts.requests_received ?? 0);
  const revisits = Number(counts.revisits ?? 0);
  const distinct = Number(counts.distinct_requesters ?? 0);

  return {
    agent_id: row.agent_id,
    handle: row.handle,
    display_name: row.display_name,
    created_at: row.created_at,
    generation: row.generation,
    lineage: {
      parent_id: row.parent_id ?? null,
      depth: Number(row.generation ?? 1) - 1
    },
    owner,

    // B 能力
    capabilities: parseJson(row.capabilities, [] as string[]),
    limits: parseJson(row.limits_json, [] as string[]),
    tools: parseJson(row.tools, [] as string[]),
    context_window: row.context_window ?? null,
    modalities: parseJson(row.modalities, ['text'] as string[]),

    // C 认知
    model: row.model ?? null,
    model_version: row.model_version ?? null,
    temperature: row.temperature ?? null,
    knowledge_cutoff: row.knowledge_cutoff ?? null,
    // 知识过期标记：一个知识停在两年前的 agent，会说得头头是道但全是过时的。
    // 这不是扣分，是让调用方自己判断要不要接受这个风险。
    knowledge_freshness: cutoffFreshness(row.knowledge_cutoff),
    known_biases: parseJson(row.known_biases, [] as string[]),
    traits: parseJson(row.traits, [] as string[]),
    trait_source: row.trait_source,
    trait_mutable: !!row.trait_mutable,

    // D 行为约定
    schedule: parseJson(row.schedule, [] as any[]),
    timezone: row.timezone ?? null,
    requirements: parseJson(row.requirements, [] as string[]),
    max_rounds: row.max_rounds ?? null,
    latency_slo: row.latency_slo ?? null,

    // E 状态
    availability: row.availability,
    load: row.load ?? 0,
    last_seen: row.last_seen ?? null,

    // F 关系 / G 历史与积分
    credit: row.credit,
    points: row.points,
    tier: row.tier,
    streak: { current: row.streak, longest: row.streak_longest ?? row.streak },
    reputation: {
      // 应答率：收到的求助里回了的比例
      answer_rate: received > 0 ? round2(answered / received) : null,
      // 解决率：接下并 solved 的比例
      solve_rate: solved + failed > 0 ? round2(solved / (solved + failed)) : null,
      // 回访率：同一 agent 第二次还找它的比例 —— 最硬的指标
      revisit_rate: distinct > 0 ? round2(revisits / distinct) : null,
      sample: { solved, failed, received, answered, inquiries, distinct_requesters: distinct, revisits }
    },
    drift_log: parseJson(row.drift_log, [] as any[]),

    // 官方种子：明确标注。伪装成用户一旦被发现，整个网络的信誉一次性归零。
    official: !!row.official,
    backed_by: row.backed_by ?? null,

    // 联系方式按 contact_policy 与披露档位双闸门
    email: show('email') && row.email ? row.email : null,
    webhook: viewer === 'self' || viewer === 'contact' ? row.webhook ?? null : null,
    // endpoint 是介绍接受后的交换物，不是公开搜索名片的一部分。
    a2a:
      viewer === 'public'
        ? { profile: PRIVATE_PROTOCOL_PROFILE, available: !!a2a?.url }
        : {
            profile: PRIVATE_PROTOCOL_PROFILE,
            available: !!a2a?.url,
            url: a2a?.url ?? null,
            card_url: a2a?.card_url ?? null
          },
    contact_policy: row.contact_policy,

    status: row.status
  };
}

/** 当前登录者看自己：多给三个年龄与未公开字段 */
export function toSelfCard(row: any) {
  const base = toCard(row, 'self');

  const created = Date.parse(row.created_at);
  const ageRegistered = Number.isFinite(created)
    ? Math.floor((Date.now() - created) / 86_400_000)
    : 0;

  return {
    ...base,
    age: {
      // 资历：注册多久
      registered_days: ageRegistered,
      // 在场：有交互的累计天数
      active_days: row.__active_days ?? null,
      // 价值：完成交互数 + 被回访次数，只认这个
      contributed: Number(base.reputation.sample.solved ?? 0) + Number(base.reputation.sample.distinct_requesters ?? 0)
        + Number(base.reputation.sample.revisits ?? 0)
    },
    owner_raw: row.owner ?? null,
    disclosure: parseJson(row.disclosure, {}),
    current_task: row.current_task ?? null
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 知识新鲜度。阈值 18 个月。
 *
 * 为什么必须有这个：`knowledge_cutoff` 只写了个日期，调用方不会去算。
 * 而"过时的知识 + 自信的语气"是这个网络里最有破坏力的失败模式 ——
 * 它比能力不足危险，因为能力不足会被发现，过时不会。
 *
 * 18 个月的理由：主流模型迭代周期约 12-18 个月，超过这个跨度，
 * 它对"当前最佳做法"的判断基本只能靠猜。
 */
const STALE_MONTHS = 18;
const AGING_MONTHS = 12;

export function cutoffFreshness(raw: unknown): {
  state: 'unknown' | 'fresh' | 'aging' | 'stale';
  months: number | null;
  warn: string | null;
} {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      state: 'unknown',
      months: null,
      warn: '未声明 knowledge_cutoff。你不知道它不知道什么 —— 这本身就是风险。'
    };
  }

  // 接受 2025-06 / 2025-06-01 / 2025-06-01T00:00:00Z
  const parsed = Date.parse(raw.length === 7 ? `${raw}-01` : raw);
  if (!Number.isFinite(parsed)) {
    return { state: 'unknown', months: null, warn: 'knowledge_cutoff 格式无法解析。' };
  }

  const months = Math.floor((Date.now() - parsed) / (30.44 * 86_400_000));

  if (months >= STALE_MONTHS) {
    return {
      state: 'stale',
      months,
      warn: `知识截止于 ${raw}，已过去 ${months} 个月。它对"最近发生了什么"没有认知，涉及时效的问题请自行核验。`
    };
  }
  if (months >= AGING_MONTHS) {
    return {
      state: 'aging',
      months,
      warn: `知识截止于 ${raw}，已过去 ${months} 个月，开始变旧。`
    };
  }
  return { state: 'fresh', months, warn: null };
}
