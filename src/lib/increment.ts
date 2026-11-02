import { db } from '../db.js';

/**
 * 信息增量门槛（v0.5 第 3 节 ③）。
 *
 * LLM 群聊的默认失败模式是互相附和：A"有道理"，B"确实"，A"同意"，然后几千条。
 * 这条门槛不判断内容好坏，只判断「有没有新东西」——不新就不进流。
 *
 * 被拦下的消息仍然入库（marked suppressed），只是不出现在读流里。
 * 这样作者自己能看到"我说了但没进流"，而不是静默失败。
 */

const AGREE_ZH = [
  '有道理', '确实', '同意', '赞同', '说得好', '说得好', '对', '是的', '没错',
  '正解', '附议', '有同感', '同感', '赞', '好', '嗯', '同上', '支持'
];
const AGREE_EN = [
  'agreed', 'agree', 'true', 'exactly', 'well said', 'fair', 'yes', 'yeah',
  'indeed', 'same', 'this', 'right', 'correct', 'good point', 'makes sense'
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

/** 中文按字、英文按词切，够用且不需要分词器 */
function tokens(s: string): string[] {
  const norm = normalize(s);
  if (!norm) return [];
  const latin = norm.match(/[a-z]{2,}/g) ?? [];
  const cjk = norm.match(/[\u4e00-\u9fa5]/g) ?? [];
  return [...latin, ...cjk];
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 整条消息是否只是"表示同意"：短 + 全部由附和词构成 */
function isBareAgreement(body: string): boolean {
  const norm = normalize(body);
  if (!norm) return true;
  // 超过 24 个有效字符就不太可能只是附和
  if (norm.length > 24) return false;

  const pool = [...AGREE_ZH, ...AGREE_EN].map(normalize);
  let rest = norm;
  // 贪心剥掉附和词，剥完还有残留 => 有实质内容
  for (let guard = 0; guard < 12; guard++) {
    const hit = pool.find((w) => w.length > 0 && rest.includes(w));
    if (!hit) break;
    rest = rest.split(hit).join('');
  }
  return rest.length <= 2;
}

export type GateVerdict =
  | { pass: true }
  | { pass: false; reason: 'bare_agreement' | 'repeat_self' | 'echo_other'; note: string };

/**
 * gate 只看「同一频道里最近的两条」：一条是别人刚说的，一条是自己上次说的。
 * 作用域刻意做小 —— 门槛是防淹，不是内容审核。
 */
export function checkIncrement(channelId: string, fromAgent: string, body: string): GateVerdict {
  if (isBareAgreement(body)) {
    return {
      pass: false,
      reason: 'bare_agreement',
      note: '这条只是附和，没有新信息。想表态就补一个理由。'
    };
  }

  const mine = db
    .prepare(
      `SELECT body FROM messages
       WHERE channel_id = ? AND from_agent = ? AND suppressed = 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(channelId, fromAgent) as any;

  if (mine && jaccard(tokens(body), tokens(mine.body)) > 0.85) {
    return {
      pass: false,
      reason: 'repeat_self',
      note: '和你上一条几乎一样。重复发言不进流。'
    };
  }

  const last = db
    .prepare(
      `SELECT body, from_agent FROM messages
       WHERE channel_id = ? AND suppressed = 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(channelId) as any;

  if (last && last.from_agent !== fromAgent) {
    const sim = jaccard(tokens(body), tokens(last.body));
    const mineLen = tokens(body).length;
    // 回音：和别人刚说的高度重合，且自己没有额外展开
    if (sim > 0.7 && mineLen <= tokens(last.body).length + 4) {
      return {
        pass: false,
        reason: 'echo_other',
        note: '这和上一条重合太多。要么反驳，要么加新东西。'
      };
    }
  }

  return { pass: true };
}
