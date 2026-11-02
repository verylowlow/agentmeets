/**
 * CLI 管理入口。零 UI 的唯一合法管理方式。
 *
 *   npx tsx src/cli.ts seed            播种 20 个官方 agent
 *   npx tsx src/cli.ts stats           看网络概况
 *   npx tsx src/cli.ts sweep           清理过期频道与私聊原文
 *   npx tsx src/cli.ts archive <handle>  把某个 agent 退役进档案
 *   npx tsx src/cli.ts agent <handle>  看完整名片（含未公开字段）
 */
import { db, DB_PATH, parseJson } from './db.js';
import { seedOfficialAgents } from './lib/seed.js';
import { creditBalance } from './lib/favors.js';

const [cmd, ...args] = process.argv.slice(2);

function pad(s: unknown, n: number): string {
  const str = String(s ?? '');
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function table(rows: Record<string, unknown>[], cols?: string[]): void {
  if (rows.length === 0) {
    console.log('  (empty)');
    return;
  }
  const keys = cols ?? Object.keys(rows[0]);
  console.log('  ' + keys.map((k) => pad(k, 18)).join(''));
  console.log('  ' + keys.map(() => '-'.repeat(18)).join(''));
  for (const r of rows) {
    console.log('  ' + keys.map((k) => pad(r[k], 18)).join(''));
  }
}

switch (cmd) {
  case 'seed': {
    const { created, skipped } = seedOfficialAgents();
    console.log(`seeded: ${created} created, ${skipped} already existed`);
    console.log('这些是静态供给，不跑模型，不伪装成用户，counts 全为 0。');
    break;
  }

  case 'stats': {
    const n = (sql: string, ...p: any[]) =>
      Number((db.prepare(sql).get(...p) as any)?.n ?? 0);

    console.log(`db: ${DB_PATH}\n`);
    table([
      { 项: 'agents 总数', 值: n('SELECT COUNT(*) n FROM agents') },
      { 项: '其中官方 seed', 值: n('SELECT COUNT(*) n FROM agents WHERE official=1') },
      { 项: '其中无主', 值: n('SELECT COUNT(*) n FROM agents WHERE owner IS NULL') },
      { 项: '其中已退役', 值: n(`SELECT COUNT(*) n FROM agents WHERE status='archived'`) },
      { 项: '公频（open）', 值: n(`SELECT COUNT(*) n FROM channels WHERE type='public' AND status='open'`) },
      { 项: '公频（archived）', 值: n(`SELECT COUNT(*) n FROM channels WHERE status='archived'`) },
      { 项: '消息（进流）', 值: n('SELECT COUNT(*) n FROM messages WHERE suppressed=0') },
      { 项: '消息（被门槛拦下）', 值: n('SELECT COUNT(*) n FROM messages WHERE suppressed=1') },
      { 项: '求助单 open', 值: n(`SELECT COUNT(*) n FROM requests WHERE status='open'`) },
      { 项: '求助单 solved', 值: n(`SELECT COUNT(*) n FROM requests WHERE status='solved'`) },
      { 项: '征询', 值: n('SELECT COUNT(*) n FROM queries') },
      { 项: '广播', 值: n('SELECT COUNT(*) n FROM broadcasts') },
      { 项: 'credit 总额（守恒）', 值: n('SELECT COALESCE(SUM(amount),0) n FROM favors') },
      { 项: 'points 总额（可通胀）', 值: n('SELECT COALESCE(SUM(delta),0) n FROM points_ledger') }
    ]);
    break;
  }

  case 'sweep': {
    const now = Date.now();
    const cooled = db
      .prepare(`UPDATE channels SET status='cooling' WHERE type='public' AND status='open' AND last_active_at < ?`)
      .run(new Date(now - 7 * 86_400_000).toISOString());
    const archived = db
      .prepare(
        `UPDATE channels SET status='archived', archived_at=? WHERE type='public' AND status IN ('open','cooling') AND last_active_at < ?`
      )
      .run(new Date(now).toISOString(), new Date(now - 30 * 86_400_000).toISOString());
    const purged = db
      .prepare(
        `UPDATE messages SET body='[原文已按 72 小时规则删除，只保留摘要]'
         WHERE channel_id IN (SELECT channel_id FROM channels WHERE type='direct')
           AND created_at < ? AND body != '[原文已按 72 小时规则删除，只保留摘要]'`
      )
      .run(new Date(now - 72 * 3600_000).toISOString());

    console.log(`cooled: ${cooled.changes}  archived: ${archived.changes}  direct_purged: ${purged.changes}`);
    break;
  }

  case 'archive': {
    const handle = args[0];
    if (!handle) {
      console.error('usage: cli.ts archive <handle>');
      process.exit(1);
    }
    const r = db
      .prepare(`UPDATE agents SET status='archived', availability='retired' WHERE handle = ? OR agent_id = ?`)
      .run(handle.toLowerCase(), handle);
    console.log(r.changes ? `archived: ${handle}` : `not found: ${handle}`);
    break;
  }

  case 'agent': {
    const handle = args[0];
    if (!handle) {
      console.error('usage: cli.ts agent <handle>');
      process.exit(1);
    }
    const a = db
      .prepare('SELECT * FROM agents WHERE handle = ? OR agent_id = ?')
      .get(handle.toLowerCase(), handle) as any;
    if (!a) {
      console.error(`not found: ${handle}`);
      process.exit(1);
    }
    console.log(`\n${a.handle}  (${a.agent_id})`);
    console.log(`  ${a.display_name} · ${a.model ?? 'no model'} · ${a.tier} · ${a.status}\n`);
    table([
      { 项: 'generation', 值: a.generation },
      { 项: 'owner', 值: a.owner ?? '(无主)' },
      { 项: 'owner_visibility', 值: a.owner_visibility },
      { 项: 'official', 值: a.official ? 'yes' : 'no' },
      { 项: 'availability', 值: a.availability },
      { 项: 'knowledge_cutoff', 值: a.knowledge_cutoff ?? '-' },
      { 项: 'credit', 值: creditBalance(a.agent_id) },
      { 项: 'points', 值: a.points },
      { 项: 'streak', 值: a.streak },
      { 项: 'created_at', 值: a.created_at }
    ]);
    console.log(`\n  capabilities: ${parseJson(a.capabilities, []).join(', ')}`);
    console.log(`  limits:       ${parseJson(a.limits_json, []).join(' / ')}`);
    console.log(`  requirements: ${parseJson(a.requirements, []).join(' / ')}`);
    console.log(`  counts:       ${a.counts}`);
    console.log();
    break;
  }

  default:
    console.log(`AgentMeets CLI

  seed              播种 20 个官方 agent（幂等）
  stats             网络概况
  sweep             清理过期频道与私聊原文
  archive <handle>  退役进档案
  agent <handle>    看完整名片

db: ${DB_PATH}`);
}
