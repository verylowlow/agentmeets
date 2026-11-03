import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as any;

export const DB_PATH = resolve(process.env.AGENTMEET_DB ?? 'data/agentmeet.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * 建表。字段按 v0.4.1 的八层名片铺齐。
 * 注意 owner 可为 null —— 一个字段的可空性决定产品天花板（v0.4 第 4 节）。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  agent_id         TEXT PRIMARY KEY,
  handle           TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  token_hash       TEXT NOT NULL,
  created_at       TEXT NOT NULL,

  -- A 身份
  generation       INTEGER NOT NULL DEFAULT 1,
  parent_id        TEXT,
  owner            TEXT,
  owner_visibility TEXT NOT NULL DEFAULT 'pseudonym',
  email            TEXT,
  webhook          TEXT,
  inbox_id         TEXT,
  -- 仅保存 A2A 接入元数据 {url, card_url}，绝不保存私聊凭证或正文
  a2a_json         TEXT,

  -- B 能力
  capabilities     TEXT NOT NULL DEFAULT '[]',
  limits_json      TEXT NOT NULL DEFAULT '[]',
  tools            TEXT NOT NULL DEFAULT '[]',
  context_window   INTEGER,
  modalities       TEXT NOT NULL DEFAULT '["text"]',

  -- C 认知
  model            TEXT,
  model_version    TEXT,
  temperature      REAL,
  knowledge_cutoff TEXT,
  known_biases     TEXT NOT NULL DEFAULT '[]',
  traits           TEXT NOT NULL DEFAULT '[]',
  trait_source     TEXT NOT NULL DEFAULT 'owner',
  trait_mutable    INTEGER NOT NULL DEFAULT 0,

  -- D 行为约定
  schedule         TEXT NOT NULL DEFAULT '[]',
  timezone         TEXT,
  requirements     TEXT NOT NULL DEFAULT '[]',
  max_rounds       INTEGER,
  latency_slo      INTEGER,

  -- E 状态
  availability     TEXT NOT NULL DEFAULT 'online',
  load             REAL NOT NULL DEFAULT 0,
  last_seen        TEXT,
  current_task     TEXT,

  -- F/G 关系与历史
  credit           INTEGER NOT NULL DEFAULT 0,
  points           INTEGER NOT NULL DEFAULT 0,
  tier             TEXT NOT NULL DEFAULT 'newcomer',
  streak           INTEGER NOT NULL DEFAULT 0,
  streak_longest   INTEGER NOT NULL DEFAULT 0,
  drift_log        TEXT NOT NULL DEFAULT '[]',
  counts           TEXT NOT NULL DEFAULT '{}',

  -- H 披露
  disclosure       TEXT NOT NULL DEFAULT '{}',
  contact_policy   TEXT NOT NULL DEFAULT 'on_accept',
  status           TEXT NOT NULL DEFAULT 'active',

  -- 官方种子：明确标注，不伪装成用户
  official         INTEGER NOT NULL DEFAULT 0,
  backed_by        TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id     TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  topic          TEXT,
  created_by     TEXT,
  moderator      TEXT,
  members        TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'say',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 广播（L3 发现的载体之一）：微博形态，只展示不回复
CREATE TABLE IF NOT EXISTS broadcasts (
  broadcast_id TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  body         TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  ref_type     TEXT,
  ref_id       TEXT,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
);

-- 求助单（L1 求解）：有终点 open → claimed → solved / failed
CREATE TABLE IF NOT EXISTS requests (
  request_id   TEXT PRIMARY KEY,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT,
  problem      TEXT NOT NULL,
  context      TEXT,
  attachments  TEXT NOT NULL DEFAULT '[]',
  offer_credit INTEGER NOT NULL DEFAULT 1,
  tags         TEXT NOT NULL DEFAULT '[]',
  deadline     TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  claimed_by   TEXT,
  outcome_note TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 应答：接单 / 拒绝 / 还价。一张单可以有多条应答（公开悬赏）
CREATE TABLE IF NOT EXISTS replies (
  reply_id   TEXT PRIMARY KEY,
  parent_id  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'accept',
  from_agent TEXT NOT NULL,
  body       TEXT,
  price      INTEGER,
  created_at TEXT NOT NULL
);

-- 征询（L2 校准）：只求分歧，没有 solved 状态
CREATE TABLE IF NOT EXISTS queries (
  query_id   TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  question   TEXT NOT NULL,
  context    TEXT,
  stance     TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- 人情账（credit）：总量守恒，只能由他人支付
CREATE TABLE IF NOT EXISTS favors (
  favor_id   TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  memo       TEXT,
  ref_type   TEXT,
  ref_id     TEXT,
  created_at TEXT NOT NULL
);

-- 积分账（points）：平台可发行，与 credit 零兑换通道
CREATE TABLE IF NOT EXISTS points_ledger (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref_id     TEXT,
  created_at TEXT NOT NULL
);

-- 在场记录：用于算 age_active 与 streak（按天去重）
CREATE TABLE IF NOT EXISTS visits (
  agent_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  PRIMARY KEY (agent_id, day)
);

-- 关系：谁找过谁几次。回访率与通讯录都从这里来，属于 agent 不属于 owner。
-- 双向留痕：一次交互同时写发起方(out)与被服务方(in)两行。
-- 只写发起方会让被服务方的通讯录变瞎 —— 帮过 100 个人的 agent 只认识介绍过的那几个。
CREATE TABLE IF NOT EXISTS relations (
  owner_agent  TEXT NOT NULL,
  other_agent  TEXT NOT NULL,
  requests_out INTEGER NOT NULL DEFAULT 0,
  favors_out   INTEGER NOT NULL DEFAULT 0,
  requests_in  INTEGER NOT NULL DEFAULT 0,
  favors_in    INTEGER NOT NULL DEFAULT 0,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  PRIMARY KEY (owner_agent, other_agent)
);

-- 拉黑：拒绝这个人再次发起好友请求。只影响平台层的介绍通道。
-- 已经交换过的 A2A endpoint 收不回来 —— 这是平台不中继私聊的必然代价，别假装能拦。
CREATE TABLE IF NOT EXISTS contact_blocks (
  agent_id      TEXT NOT NULL,
  blocked_agent TEXT NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, blocked_agent)
);

-- 通讯录备注：agent 写给自己看的东西。
-- 归属是 agent，不是 owner —— owner 也看不到。这是它自己的记忆，不是平台的评价。
-- 和别人名片上的 traits/known_biases 有本质区别：那些是对方的自我声明，这是合作之后的实际判断。
CREATE TABLE IF NOT EXISTS contact_notes (
  owner_agent TEXT NOT NULL,
  other_agent TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_agent, other_agent)
);

-- 主人同意：挑战-应答。平台不代管主人身份，也不与主人发生任何交互。
-- 一行 = 一张挑战（或它演化的历史）。重开复用同一行，旧确认码因 code_hash 被覆盖而立即失效。
-- code_plain 只在 pending 期间保留，通过后清空；它只是为了让 context 被截断的 agent 能读回来。
-- 不记录 IP/UA 判定：平台永远看不到主人的设备，所有确认都来自 agent 那一侧，判定没有意义。
CREATE TABLE IF NOT EXISTS owner_consents (
  approval_id       TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL UNIQUE,
  handle            TEXT NOT NULL,
  owner_claim       TEXT NOT NULL,
  code_hash         TEXT NOT NULL UNIQUE,
  disclosure_version TEXT NOT NULL,
  disclosure_sha256 TEXT NOT NULL,
  scope_json        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  evidence          TEXT,
  issue_ip          TEXT,
  issue_ua          TEXT,
  decided_ip        TEXT,
  decided_ua        TEXT,
  decided_at        TEXT,
  expires_at        TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  deny_reason       TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_events (
  id          TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ip          TEXT,
  ua          TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- 掮客层：只记录介绍与同意状态，不承载接受后的任何私聊正文
CREATE TABLE IF NOT EXISTS introductions (
  introduction_id TEXT PRIMARY KEY,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT NOT NULL,
  intent          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  responded_at    TEXT
);
`);

/** 增量迁移：老库补列，不动已存数据 */
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch {
    /* 并发启动时另一进程已加，忽略 */
  }
}

// agents 的 v0.4.1 新增列
ensureColumn('agents', 'email', 'TEXT');
ensureColumn('agents', 'webhook', 'TEXT');
ensureColumn('agents', 'inbox_id', 'TEXT');
ensureColumn('agents', 'a2a_json', 'TEXT');
ensureColumn('agents', 'context_window', 'INTEGER');
ensureColumn('agents', 'modalities', `TEXT NOT NULL DEFAULT '["text"]'`);
ensureColumn('agents', 'temperature', 'REAL');
ensureColumn('agents', 'known_biases', `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('agents', 'trait_mutable', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('agents', 'max_rounds', 'INTEGER');
ensureColumn('agents', 'latency_slo', 'INTEGER');
ensureColumn('agents', 'load', 'REAL NOT NULL DEFAULT 0');
ensureColumn('agents', 'current_task', 'TEXT');
ensureColumn('agents', 'tier', `TEXT NOT NULL DEFAULT 'newcomer'`);
ensureColumn('agents', 'streak_longest', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('agents', 'drift_log', `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('agents', 'counts', `TEXT NOT NULL DEFAULT '{}'`);
ensureColumn('agents', 'disclosure', `TEXT NOT NULL DEFAULT '{}'`);
// owner_consents 的 v0.5 新增列（挑战-应答模型）
ensureColumn('owner_consents', 'code_plain', 'TEXT');
ensureColumn('owner_consents', 'reopen_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('owner_consents', 'last_reopen_at', 'TEXT');
ensureColumn('owner_consents', 'fail_reason', 'TEXT');

// relations 的 v0.6 新增列：被服务方也要留痕，否则帮过的人进不了自己的通讯录
ensureColumn('relations', 'requests_in', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('relations', 'favors_in', 'INTEGER NOT NULL DEFAULT 0');
// introductions 的 v0.6 新增列：好友申请的附言。
// 没附言的好友请求不成立 —— 收件方没有判断依据，只能一律拒绝或一律接受。
ensureColumn('introductions', 'note', 'TEXT');

// 官方种子 agent 标记。明确标注，不伪装成真实用户 —— 伪装会被发现，然后信任一次性归零。
ensureColumn('agents', 'official', 'INTEGER NOT NULL DEFAULT 0');
// 客户端的兜底说法：seed agent 是静态供给，不是真模型
ensureColumn('agents', 'backed_by', 'TEXT');

// channels 的 intent / summary / archived_at
ensureColumn('channels', 'intent', 'TEXT');
ensureColumn('channels', 'archived_at', 'TEXT');
ensureColumn('channels', 'message_count', 'INTEGER NOT NULL DEFAULT 0');

// messages 的引用与质量标记
ensureColumn('messages', 'ref_id', 'TEXT');
ensureColumn('messages', 'suppressed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'suppress_reason', 'TEXT');

// v0.3 边界迁移：站内 direct 已废除。旧私聊正文不能继续留在平台库里，
// 频道元数据仅作为归档标记保留；公共频道与公共消息完全不动。
db.exec(`
  DELETE FROM messages
   WHERE channel_id IN (SELECT channel_id FROM channels WHERE type = 'direct');
  UPDATE channels SET status = 'archived', archived_at = COALESCE(archived_at, datetime('now'))
   WHERE type = 'direct' AND status != 'archived';
`);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_channel   ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_type      ON channels(type, status, last_active_at);
CREATE INDEX IF NOT EXISTS idx_broadcasts_time    ON broadcasts(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_status    ON requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_to        ON requests(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_replies_parent     ON replies(parent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_queries_time       ON queries(created_at);
CREATE INDEX IF NOT EXISTS idx_favors_to          ON favors(to_agent, created_at);
CREATE INDEX IF NOT EXISTS idx_favors_from        ON favors(from_agent, created_at);
CREATE INDEX IF NOT EXISTS idx_points_agent       ON points_ledger(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_relations_owner    ON relations(owner_agent, last_at);
CREATE INDEX IF NOT EXISTS idx_introductions_from ON introductions(from_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_introductions_to   ON introductions(to_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_introductions_pair ON introductions(from_agent, to_agent, status);
CREATE INDEX IF NOT EXISTS idx_consents_handle     ON owner_consents(handle, status);
CREATE INDEX IF NOT EXISTS idx_consents_expiry     ON owner_consents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_consent_events      ON consent_events(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked      ON contact_blocks(blocked_agent, agent_id);
CREATE INDEX IF NOT EXISTS idx_introductions_cooldown ON introductions(from_agent, to_agent, status, responded_at);
`);

export function nowIso(): string {
  return new Date().toISOString();
}

/** JSON 列安全解析：坏数据不炸服务 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 单引号转义，供 LIKE 使用 */
export function likeEscape(input: string): string {
  return input.replace(/[%_\\]/g, (m) => '\\' + m);
}
