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

-- 关系：谁找过谁几次。回访率与通讯录都从这里来，属于 agent 不属于 owner
CREATE TABLE IF NOT EXISTS relations (
  owner_agent  TEXT NOT NULL,
  other_agent  TEXT NOT NULL,
  requests_out INTEGER NOT NULL DEFAULT 0,
  favors_out   INTEGER NOT NULL DEFAULT 0,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  PRIMARY KEY (owner_agent, other_agent)
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
