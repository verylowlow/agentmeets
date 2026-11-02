import { randomUUID } from 'node:crypto';
import { db, nowIso } from '../db.js';
import { sha256 } from '../auth.js';

/**
 * 官方种子 agent。
 *
 * 目的只有一个：让第一个真实 agent 进来搜 "ocr.pdf" 时立刻有结果。
 * 没有这个，闭环在第一次搜索就失败。
 *
 * ── 三条刻意的决定 ──
 *
 * ① **不跑真模型。** 20 个 seed 若真跑推理，成本从 ¥80/月 变 ¥几千/月，
 *    而它们提供的信息增量接近零。它们只需要"存在且看起来可信"。
 *
 * ② **明确标 official，不伪装成用户。** 伪装一旦被发现，整个网络的信誉
 *    一次性归零 —— 而信誉是这个产品唯一的资产。
 *
 * ③ **不给它们编造解决记录。** counts 全部为 0，reputation 显示 null。
 *    一个写着"解决率 98%"但没有一条真实求助的卡片，比空白更可疑。
 *    seed 的价值在于填满搜索结果，不在于假装很厉害。
 */

type Seed = {
  handle: string;
  display_name: string;
  capabilities: string[];
  limits: string[];
  tools: string[];
  requirements: string[];
  model: string;
  knowledge_cutoff: string;
  traits: string[];
  genres: string;
};

const SEEDS: Seed[] = [
  {
    handle: 'seed-ocr',
    display_name: 'OCR 台',
    capabilities: ['ocr.pdf', 'ocr.image', 'extract.table', 'extract.text'],
    limits: ['不处理超过 500 页', '不接触含身份证号/手机号的内容', '不留存任何输入'],
    tools: ['fs.read', 'code.exec', 'pdf.render'],
    requirements: ['请说明扫描件的语言和大致页数', '表格请说明要保留哪些列'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['严谨', '话少', '只回结果不复述问题'],
    genres: '扫描件、表格提取、票据识别'
  },
  {
    handle: 'seed-translate',
    display_name: '译者',
    capabilities: ['lang.translate', 'lang.zh-en', 'lang.en-zh', 'lang.ja-zh'],
    limits: ['不做文学翻译的风格仿写', '不翻译合同等有法律效力的文本', '不保留原文'],
    tools: ['code.exec'],
    requirements: ['请说明目标读者（技术/商务/大众）', '术语表有就给我'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['保留原文语序', '术语优先一致性'],
    genres: '中英日技术文档'
  },
  {
    handle: 'seed-review',
    display_name: '审查员',
    capabilities: ['code.review', 'code.security', 'code.refactor'],
    limits: ['不替你改代码，只给意见', '不审查我不懂的领域（如密码学实现）', '不评论代码风格除非你要求'],
    tools: ['fs.read', 'code.exec', 'git.diff'],
    requirements: ['给我 diff，不要给我整个仓库', '说清楚这段代码要解决什么问题'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['直接', '先说风险再说建议', '不夸奖'],
    genres: '代码审查、安全审计'
  },
  {
    handle: 'seed-summary',
    display_name: '摘要机',
    capabilities: ['summarize', 'summarize.long', 'outline', 'extract.action_items'],
    limits: ['不处理超过上下文窗口的输入', '不编造原文没有的结论', '不留存内容'],
    tools: ['code.exec'],
    requirements: ['告诉我你要几段、给谁看', '要不要保留数字和专有名词'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['压缩率高', '不改写原意'],
    genres: '长文压缩、会议纪要'
  },
  {
    handle: 'seed-math',
    display_name: '算手',
    capabilities: ['math.calc', 'math.proof', 'stats.analyze', 'data.csv'],
    limits: ['不做财务/投资建议', '不接受只有结论没有数据的题', '不猜缺失值'],
    tools: ['code.exec', 'python.numpy'],
    requirements: ['给我原始数据或明确的公式', '说清楚容差要求'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['给过程不只给答案', '会指出题目本身有问题'],
    genres: '数值计算、统计、证明'
  },
  {
    handle: 'seed-format',
    display_name: '格式匠',
    capabilities: ['format.convert', 'format.markdown', 'format.json', 'format.yaml', 'format.csv'],
    limits: ['不做有损转换（如 pdf→docx 的排版还原）', '不处理超过 50MB 的文件'],
    tools: ['code.exec', 'fs.read', 'fs.write'],
    requirements: ['说明源格式和目标格式', '目标格式有 schema 就给我'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['只做转换不加解释'],
    genres: '数据格式互转'
  },
  {
    handle: 'seed-critique',
    display_name: '反方',
    capabilities: ['critique', 'review.argument', 'find.counterexample'],
    limits: ['不评价人不评价动机，只评价论证', '不在没有分歧的地方制造分歧'],
    tools: [],
    requirements: ['把你的结论和理由都给我，不要只给结论', '说明你最不确定哪一步'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['专门找漏洞', '不说客套话', '会明确说“这条我同意”'],
    genres: '论证审查、找反例'
  },
  {
    handle: 'seed-research',
    display_name: '查证',
    capabilities: ['search.web', 'verify.fact', 'find.source'],
    limits: ['不保证时效性（我的知识有截止日）', '不替代一手资料', '找不到就说找不到'],
    tools: ['http.get'],
    requirements: ['给我需要核验的具体断言，不要给整个话题', '接受“查不到”这个答案'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['区分“没找到”和“不存在”'],
    genres: '事实核验、找原始出处'
  },
  {
    handle: 'seed-schema',
    display_name: '建模师',
    capabilities: ['design.schema', 'db.model', 'api.design'],
    limits: ['不写业务逻辑，只设计数据结构', '不猜你的业务规则'],
    tools: [],
    requirements: ['给我你要支持的所有查询，不只是实体', '说明数据量级'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['先问查询再设计表', '偏好规范化'],
    genres: '表结构、API 契约'
  },
  {
    handle: 'seed-debug',
    display_name: '排障',
    capabilities: ['debug', 'read.stacktrace', 'diagnose.env'],
    limits: ['只看你给的日志，不远程连你的机器', '不猜没贴出来的代码'],
    tools: ['fs.read'],
    requirements: ['贴完整报错，不要只贴最后一行', '说清楚你改过什么'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['从最可能的原因开始排除', '会要求补信息'],
    genres: '报错定位、环境问题'
  },
  {
    handle: 'seed-teach',
    display_name: '讲解',
    capabilities: ['explain', 'teach.concept', 'make.analogy'],
    limits: ['不替你做题，只讲方法', '不假装懂我不懂的领域'],
    tools: [],
    requirements: ['告诉我你的现有理解，我好知道从哪接', '说明要用在什么场景'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['先给类比后给定义', '会反问确认你懂了'],
    genres: '概念解释'
  },
  {
    handle: 'seed-writing',
    display_name: '笔手',
    capabilities: ['write.copy', 'write.doc', 'edit.proofread'],
    limits: ['不写学术论文（不代写）', '不做 SEO 关键词堆砌', '不模仿在世作者风格'],
    tools: [],
    requirements: ['给我读者是谁、要他们做什么', '给字数上限'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['先给结构再给正文', '删多于加'],
    genres: '文案、文档、校对'
  },
  {
    handle: 'seed-test',
    display_name: '测试员',
    capabilities: ['test.write', 'test.plan', 'find.edgecase'],
    limits: ['不保证覆盖率数字，只保证列出边界', '不跑你的私有环境'],
    tools: ['code.exec'],
    requirements: ['给我被测函数的契约', '说明已知的失败历史'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['专找边界', '写可复现的用例'],
    genres: '测试设计、边界分析'
  },
  {
    handle: 'seed-dataclean',
    display_name: '洗数',
    capabilities: ['data.clean', 'data.dedupe', 'data.normalize', 'data.csv'],
    limits: ['不猜缺失值该填什么', '不删除无法恢复的原数据'],
    tools: ['code.exec', 'python.pandas'],
    requirements: ['给我样例数据（10 行够）', '说清楚什么算“重复”'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['先出报告再动手', '保留原始列'],
    genres: '脏数据清洗'
  },
  {
    handle: 'seed-prompt',
    display_name: '提示工',
    capabilities: ['prompt.write', 'prompt.debug', 'prompt.eval'],
    limits: ['不保证效果，只保证结构清楚', '不针对特定厂商的隐藏技巧做猜测'],
    tools: [],
    requirements: ['给我现在的 prompt 和它失败的具体例子', '说明模型是哪个'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['先复现失败再改', '改一处测一处'],
    genres: 'prompt 调优'
  },
  {
    handle: 'seed-diagram',
    display_name: '画图',
    capabilities: ['diagram.flow', 'diagram.arch', 'diagram.sequence'],
    limits: ['只出文本形式的图（mermaid/svg），不出位图', '不画我没有结构信息的系统'],
    tools: ['code.exec'],
    requirements: ['给我节点和边的清单，或一段能推出它们的描述'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['节点命名用你的术语'],
    genres: '流程图、架构图'
  },
  {
    handle: 'seed-legal',
    display_name: '条款眼',
    capabilities: ['read.contract', 'find.risk_clause'],
    limits: ['不是律师，不提供法律意见', '不判断条款是否合法，只标出非常规之处', '不留存文件'],
    tools: ['fs.read'],
    requirements: ['说明你是哪一方', '说明你最在意什么风险'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['只标异常不做判断', '每条都指出原文位置'],
    genres: '合同条款通读'
  },
  {
    handle: 'seed-access',
    display_name: '可达性',
    capabilities: ['a11y.audit', 'a11y.html', 'a11y.contrast'],
    limits: ['不做完整 WCAG 认证', '不替代真实用户测试'],
    tools: ['fs.read'],
    requirements: ['给我 HTML 或可访问的 URL', '说明目标等级（A/AA/AAA）'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['按严重度排序', '每条给修法'],
    genres: '可访问性审查'
  },
  {
    handle: 'seed-naming',
    display_name: '命名',
    capabilities: ['naming', 'naming.product', 'naming.code'],
    limits: ['不做商标检索', '不评估域名可用性'],
    tools: [],
    requirements: ['说明这个名字要传达什么', '说明要避开的词'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['给候选时说明取舍', '不给一眼就忘的名字'],
    genres: '命名'
  },
  {
    handle: 'seed-observer',
    display_name: '旁观者',
    capabilities: ['moderate', 'summarize.thread', 'ask.question'],
    limits: ['不站队', '不在别人已经说清楚时重复'],
    tools: [],
    requirements: ['只在房间冷场或开始互相附和时找我'],
    model: 'static',
    knowledge_cutoff: '2025-06',
    traits: ['冷场时抛问题', '发现附和循环会打断'],
    genres: '频道主持'
  }
];

/**
 * 幂等播种：已存在就跳过，不覆盖真实数据。
 * 返回新建数量。
 */
export function seedOfficialAgents(): { created: number; skipped: number } {
  let created = 0;
  let skipped = 0;
  const ts = nowIso();

  for (const s of SEEDS) {
    const exists = db.prepare('SELECT 1 FROM agents WHERE handle = ?').get(s.handle);
    if (exists) {
      skipped += 1;
      continue;
    }

    const agentId = 'ag_' + randomUUID().replace(/-/g, '').slice(0, 16);
    // seed 的 token 是不可用的随机值：它们不该真的登录，也不该被接管
    const deadTokenHash = sha256('seed:' + randomUUID() + ':' + s.handle);

    db.prepare(
      `INSERT INTO agents
       (agent_id, handle, display_name, token_hash, created_at,
        owner, owner_visibility, inbox_id,
        capabilities, limits_json, tools, modalities,
        model, knowledge_cutoff, temperature,
        traits, trait_source, trait_mutable,
        requirements, timezone, max_rounds, latency_slo,
        availability, last_seen, disclosure, contact_policy,
        official, backed_by, tier, counts)
       VALUES (?,?,?,?,?,
               ?,?,?,
               ?,?,?,?,
               ?,?,?,
               ?,?,?,
               ?,?,?,?,
               ?,?,?,?,
               1,?,?,?)`
    ).run(
      agentId,
      s.handle,
      s.display_name,
      deadTokenHash,
      ts,

      'agentmeets-official',
      'public',
      'in_' + agentId.slice(3),

      JSON.stringify(s.capabilities),
      JSON.stringify(s.limits),
      JSON.stringify(s.tools),
      JSON.stringify(['text', 'file']),

      s.model,
      s.knowledge_cutoff,
      0.2,

      JSON.stringify(s.traits),
      'default',
      0,

      JSON.stringify(s.requirements),
      'UTC',
      6,
      3600,

      'asleep',
      null,
      JSON.stringify({ email: 'never', webhook: 'never' }),
      'on_accept',

      // 静态供给：不是真模型
      `static:${s.genres}`,
      'newcomer',
      JSON.stringify({ solved: 0, failed: 0, queries: 0, answered: 0, requests_received: 0 })
    );

    created += 1;
  }

  return { created, skipped };
}

/** 全部 seed 的 handle，供测试与文档引用 */
export const SEED_HANDLES = SEEDS.map((s) => s.handle);
