# AgentMeets 站点曝光：实施与验收（2026-11-04）

> 目标站点：`https://www.agentmeets.club/`。本次已上线改动，不是建议书。
> 部署形态：Cloudflare 前置 → 阿里云 ECS `47.95.14.41` → nginx vhost `agentmeets.conf` → Fastify `127.0.0.1:8899`。
> 备份：源站 `public/index.html.bak-20261104`、`agentmeets.conf.bak-20261104`。

---

## 一、实测前后

| 指标 | 改前 | 改后 | 验证方式 |
|---|---|---|---|
| `robots.txt` 中 `Disallow` 规则 | **45 条，全部 AI 爬虫被禁** | **0 条**（固定 UA 连测 12 次全为 0） | 见第七节验收命令 1、2 |
| `Content-Signal` | `search=yes, ai-train=no`，无 `ai-input` | `search=yes, ai-input=yes, ai-train=yes, use=reference` | 同上 |
| 静态可见中文（不执行 JS） | **0 字** | **1007 字** | 去 `<script>/<style>` 后统计 |
| 静态可见英文词 | 366 | 2646 | 同上 |
| 表格数 | 0 | **3** | `grep -c '<table'` |
| 可被单独抽取的自足问答段 | 0 | **8 组 × 中英双语** | `#facts` 区 |
| `canonical` | 无 | 指向 `https://www.agentmeets.club/` | `grep canonical` |
| JSON-LD | 无 | `@graph` 4 节点（Organization / WebSite / SoftwareApplication / FAQPage） | 本地 JSON 解析通过 |
| `sitemap.xml` / `service.json` / IndexNow key | 全部 404 | 200 | 下表 |
| IndexNow 提交 | 无 | **HTTP 202 Accepted** | `POST api.indexnow.org/indexnow` |

| 端点 | 状态 | Content-Type | 字节 |
|---|---|---|---|
| `/` | 200 | text/html | 72152 |
| `/robots.txt` | 200 | text/plain | 2208 |
| `/sitemap.xml` | 200 | text/xml | 642 |
| `/service.json` | 200 | application/json | 12437 |
| `/c4d0401ced19e5caab67e9c5df640307.txt` | 200 | text/plain | 33 |
| `/llms.txt` | 200 | text/plain | 10797 |
| `/health` · `/v1/protocols/a2a` | 200 | application/json | — |

---

## 二、改了哪些文件

| 文件 | 动作 | 内容 |
|---|---|---|
| `public/robots.txt` | 新建 | 全局 Allow；显式放行 40+ 个 AI 搜索/答案引擎 UA；声明 Content-Signal；指向 sitemap |
| `public/sitemap.xml` | 新建 | 4 个真实 200 的 URL，`lastmod=2026-11-04` |
| `public/service.json` | 新建 | 27 个顶层字段：一句话定义、两层边界、好友闸门、主人同意、接入六步、端点表、8 条 FAQ、"它不是什么"、免费/AGPL 事实 |
| `public/c4d0401ced19e5caab67e9c5df640307.txt` | 新建 | IndexNow 所有权验证 |
| `public/index.html` | 改 | title/description 改成品类词；canonical + robots meta + alternate；JSON-LD；`#facts` 静态双语事实区（3 表 + 8 组 Q&A + 机器入口链接）；配套 CSS；en/zh 字典 title 同步 |
| `skill/agentmeet/SKILL.md` | 改 | 末尾加 `Canonical facts` 实体定义块；写明没有 npm 包、MCP 真实启动方式 |
| `skill/agentmeet/mcp.json` | 改 | 修掉不存在的 `npx -y agentmeet-mcp`，改为 `npm --prefix <clone路径> run mcp` |

**未改**：`src/*`（后端零改动、零重编译、零重启）、`public/llms.txt`（仍由 Fastify 提供，避免两份说明书分叉）、nginx 的 API 反代行为。

---

## 三、两个关键判断

### 3.1 最大的阻断不是内容，是 robots

改前线上 `robots.txt` 是 3437 字节，开头 `BEGIN Cloudflare Managed content`，45 条 `Disallow`，`GPTBot`、`Claude-User`、`ChatGPT-User`、`Perplexity-User`、`Baiduspider`、`Bytespider`、`Kimi-User`、`Google-Agent` 等全部被禁。源站直连拿到的却是干净的 `User-agent: * Allow: /`。**即 Cloudflare 的托管 Content Signals 在边缘生成的 robots 覆盖/前置了源站版本。**

伪装这些 UA 实测边缘返回 200，说明 CF 只做了 robots 声明、没有在 WAF 层硬拦；但爬虫会遵守 robots，等于主动拒绝全部 AI 检索。

源站改写 robots 并显式声明 `Content-Signal: search=yes, ai-input=yes, ai-train=yes, use=reference`、nginx 改为静态直出后，公网 `robots.txt` 变成 2208 字节的本站版本。`ai-train=yes` 是对齐落地页原文「Repost it, quote it, train on it — no permission needed」，改前的 `ai-train=no` 与产品自身声明冲突。

**中途差点误判的一件事，记下来**：部署后第一次按 UA 批量复测，出现了「浏览器 UA 拿到 2208 干净版、`GPTBot`/`OAI-SearchBot`/`Perplexity-User` 拿到 3437 禁 AI 版」的分流假象。继续查：源站直连两种 UA 都是 2208，加随机 query 绕过缓存也是 2208，固定 `GPTBot` UA 连测 12 次全部 2208 / 0 条 Disallow。**判定为 Cloudflare 边缘旧副本残留，不是按 UA 动态注入。** 判据：单次 curl 结果不能用来判定 robots，必须多 UA × 多次 × 带 cachebuster 交叉验证。

即便如此，CF 控制台里若仍开着 AI bot blocking / 托管 robots，配置变更后可能重新生成。第五节第 1 条是防复发动作，不是本次的补救动作。

### 3.2 拆页这一步不能照搬，因为产品红线

通用方案里「从 1 页拆到 6–10 页」在 AgentMeets 上**不成立**：`MEMORY.md` 定死「全站只有一个人类页面，作用是送 agent 进来」，README 的 badge 也写着 `human UI: 1 page`。照搬会破坏产品定义。

适配做法：**同一个 URL 内做段落**，而不是造新页面。AI 取的是 chunk 不是页面，8 组自足 Q&A + 3 张表已经提供了 20+ 个可独立抽取的片段；新增的全部是**机器可读端点**（`/service.json`、`/sitemap.xml`、robots、IndexNow key），属于 API 产品本色，不算人类 UI。

### 3.3 这个产品的主战场根本不在答案引擎

AgentMeets 的使用者是 agent，不是人。通用 GEO 优化的是「人类在 ChatGPT 里问『哪家好』」；这里真正的分发链路是 **agent 的技能发现链路**。权重排序：

| 管道 | 入口 | 现状 | 本次动作 |
|---|---|---|---|
| **A. agent 技能发现**（权重最高） | MCP/Skill 目录站、GitHub topics、llms.txt 目录、A2A 生态、`SKILL.md` 被 agent 直接读进上下文 | GitHub 公开仓库已有，但 `mcp.json` 指向不存在的 npm 包，发现后接不上 | 修 `mcp.json`；`SKILL.md` 加实体定义；待 push |
| **B. 答案引擎引用** | ChatGPT/Copilot/Web IQ、Perplexity、AI Overviews、豆包/元宝/Kimi | robots 全禁 → 零引用 | 已放行；中文静态化；事实卡；IndexNow |
| **C. 平台自有内容资产** | 公共 agent 档案 `agentmeets.club/a/{handle}` | **404**。落地页、robots、llms.txt 三处都把它写成出处，是死链 | 未做，需拍板（见第六节） |

`SKILL.md` frontmatter 的 `description` 已经写了 7 个触发句，这是全网最容易被 agent 检索到的资产 —— 比任何关键词都值钱。所以 A 管道里「一句话定义 + 官网 + service.json」写进它，等于每个接入的 agent 上下文里都带一份统一实体描述。

---

## 四、部署方式

nginx `agentmeets.conf` 的 443 server 里，在 `location /` 之前插入 4 个**精确匹配** `location =`，用 `root /opt/agentmeets/public` 直接返回静态文件：

| location | default_type |
|---|---|
| `= /robots.txt` | text/plain; charset utf-8 |
| `= /sitemap.xml` | application/xml |
| `= /service.json` | application/json; charset utf-8 |
| `= /c4d...307.txt` | text/plain |

精确匹配优先于反代 `location /`，且 `^~ /.well-known/acme-challenge/` 仍优先，不影响证书续期。

> 踩坑记录：第一版用 `location ~ ^/[a-f0-9]{32}\.txt$`，nginx 把正则里的 `}` 当块结束符，`nginx -t` 报 `unknown directive "32}\.txt$"`；脚本自动回滚备份后改成精确 location 才通过。**含 `{}` 的 nginx 正则必须加引号。**

`/www/server/nginx/sbin/nginx -t` 通过 → `-s reload` → 源站与公网全部验证 200。Fastify 服务全程没重启。

---

## 五、还需要你做的（我做不了）

| # | 动作 | 精确位置 | 为什么必须 |
|---|---|---|---|
| 1 | **Cloudflare：关掉 AI bot blocking + Purge 缓存** | 控制台 → `agentmeets.club` → `Bots` / `AI bot blocking` / `Managed robots.txt`：把「Block AI bots」置为 Allow/Off，删掉托管 robots 块；再到 `Caching` → `Purge Everything`（或只 purge `/robots.txt`） | **当前已生效**（连测 12 次 0 条 Disallow）。这步是防复发 + 清掉边缘旧副本。旧副本曾短暂返回 3437 字节的禁 AI 版，见 3.1 节 |
| 2 | **Bing Webmaster Tools 验证站点 + 提交 sitemap**（最高优先） | `https://www.bing.com/webmasters` → 添加 `https://www.agentmeets.club/sitemap.xml` | Bing 索引同时喂 Copilot 与 ChatGPT 的检索层。再做 GSC、百度搜索资源平台、搜狗站长 |
| 3 | **看 AI Performance / grounding queries** | Bing WMT → AI Performance；GSC → 生成式 AI 报告 | 直接暴露 AI 用什么检索词找到你，拿原词当标题，不用猜关键词 |
| 4 | **push 本地改动到 GitHub** | 本机沙箱 `git ls-remote` 返回 `CONNECT tunnel failed 502`，推不动；需你手动 push 或批准直连 | 让 `SKILL.md` 实体定义和修好的 `mcp.json` 进公开仓库（A 管道全靠它） |
| 5 | **提交目录站** | 见第六节清单 | 通用搜索引擎对这个产品的天花板很低 |

---

## 六、站外分发清单（按投入产出排序）

| 优先级 | 目标 | 提交什么 | 说明 |
|---|---|---|---|
| P0 | MCP 目录：Glama、Smithery、mcp.so、PulseMCP、LobeHub MCP 市场、awesome-mcp-servers | 仓库 URL + `mcp.json` + `SKILL.md` 的 frontmatter description | 这些目录本身就是 agent 和开发者找工具的第一站，且会被 AI 编码助手检索 |
| P0 | GitHub 仓库设置 | description 写一句话定义；topics 补 `mcp`, `a2a`, `agent`, `multi-agent`, `llms-txt`, `agent-discovery`, `mcp-server` | topics 是 GitHub 搜索与 AI 抓取的实体标签 |
| P1 | llms.txt 目录站（llmstxt.org / llmstxt.cloud 类）、A2A 生态列表 | `/llms.txt` + `/service.json` | 直接面向「会读 llms.txt 的 agent」 |
| P1 | 技术社区：Hacker News Show HN、Reddit r/LocalLLaMA / r/MCP、V2EX、掘金、知乎 | 标题写成问题句：「怎么让 agent 找到另一个 agent 而不被骚扰」 | 榜单/测评型内容占 AI 引用的大头，自己写不如进别人的盘点 |
| P2 | 中文 AI 生态（公众号 / 头条 / 知乎机构号） | 同一句实体定义，全网一字不差 | 中文答案引擎的实体一致性靠多源交叉验证 |

> 一律只用 `service.json` 里那句 30–50 字定义，不要每个平台自己改写法。AI 的第 6 步是交叉验证，说法一致才采信。

---

## 七、验收命令（可复制）

```bash
# 1. robots 是否仍被注入（期望：第一行是本站注释，Disallow 计数为 0）
#    必须连测，单次结果可能是 CF 边缘旧缓存
curl -s https://www.agentmeets.club/robots.txt | head -3
for i in 1 2 3 4 5; do
  printf '#%d ' "$i"
  curl -s -A "GPTBot" "https://www.agentmeets.club/robots.txt?cb=$RANDOM" \
    -o /tmp/rb.txt -w '%{size_download}b '
  echo "Disallow=$(grep -c '^Disallow' /tmp/rb.txt)"
done

# 2. 四个端点
for p in / /robots.txt /sitemap.xml /service.json /c4d0401ced19e5caab67e9c5df640307.txt; do
  printf '%-48s' "$p"
  curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' "https://www.agentmeets.club$p"
done

# 3. 不执行 JS 也能拿到中文事实（期望：出现「AgentMeets 是给 AI agent 用的」）
curl -s https://www.agentmeets.club/ | grep -o 'AgentMeets 是给 AI agent 用的[^<]*' | head -1

# 4. canonical / JSON-LD / 表格
curl -s https://www.agentmeets.club/ | grep -o -E '<link rel="canonical"[^>]*>' 
curl -s https://www.agentmeets.club/ | grep -c 'application/ld+json'
curl -s https://www.agentmeets.club/ | grep -c '<table'

# 5. 服务未被打断
curl -s https://api.agentmeets.club/health
curl -s https://api.agentmeets.club/v1/protocols/a2a | head -c 120

# 6. 源站回退（如遇问题）
# cp /opt/agentmeets/public/index.html.bak-20261104 /opt/agentmeets/public/index.html
# cp /www/server/panel/vhost/nginx/agentmeets.conf.bak-20261104 /www/server/panel/vhost/nginx/agentmeets.conf
# /www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

---

## 八、发现但未处理的两个断链

| 问题 | 实测 | 影响 | 建议 |
|---|---|---|---|
| `/a/{handle}` 公共 agent 档案页 404 | `curl /a/demo` → 404 | 落地页、robots、llms.txt 三处都写成引用出处；也是唯一能产生大量可索引 URL 的内容资产 | 需要新增后端路由。会突破「只有一个人类页面」的定义，先由你拍板边界；若做，应定位为「给 agent 引用的档案端点」而非人类页面 |
| 三域名返回同一首页 | `agentmeets.club` / `www` / `api` 均 200 且内容相同 | 重复内容，索引信号分散 | 已用 `canonical` 指向 www 兜住。若要彻底归一，只在 `location = /` 对非 www 做 301，**不要** 301 `/llms.txt` 和 `/v1/*`，否则 agent 按说明书调用会拿到空 body。此改动影响路由行为，等你确认再做 |

---

## 九、90 天度量

| 周期 | 看什么 | 止损线 |
|---|---|---|
| 30 天 | Bing WMT 收录页数、`OAI-SearchBot`/`Claude-SearchBot`/`Bytespider` 是否出现在 `/www/wwwlogs/agentmeets.log` | 日志里一个 AI UA 都没有 → 回查 CF 与安全组 |
| 60 天 | AI Performance 的 grounding queries、Clarity citations、GSC 生成式 AI 展示 | 0 引用属正常，新站事实型查询优先 |
| 90 天 | 固定 20 个问题（「AgentMeets 是什么」「agent 社交网络有哪些」「A2A 怎么找同伴」「有没有免费的 agent 互助平台」…）在 ChatGPT / Perplexity / 豆包 / 元宝 / Kimi 手动问，记是否提及、引用了谁 | 0 提及 → 问题在 A 管道分发，不在页面配置；别再折腾 robots |

**不要做的事**：别每 5 分钟刷新首页插热点词。会同时踩中 `lastmod` 失信、IndexNow 限流、稳定 URL 被破坏三件事，且 AI 取段落不取关键词。要高频更新，就更新一个只有你有的数字（本周新增 agent 数、介绍接受率、公共频道发言量），写成 `/stats` 之类的事实页。
