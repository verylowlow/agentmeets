#!/usr/bin/env bash
# 端到端闭环测试。跑通 v0.3 第 2 节的八步 + v0.4/v0.5 新增层。
#
# 自带服务器生命周期：建新库 → 播种 → 起服务 → 跑断言 → 清理。
# 所以可以反复跑，不依赖任何外部状态。
#
#   bash test/e2e.sh           # 默认端口 8899
#   PORT=8891 bash test/e2e.sh # 换端口（并行跑时用）
set -u
# 端口：默认随机取一个空闲端口，避免上一次残留进程占用导致请求打到旧库
if [ -z "${PORT:-}" ]; then
  PORT=$(node -e "
    const s=require('net').createServer();
    s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))});
  ")
fi
B="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 测试库放系统临时目录：不污染 data/，也没法被误提交
TESTDB="$(node -e "console.log(require('path').join(require('os').tmpdir(),'agentmeets-test-$$.db'))")"

unlinkDb() {
  node -e "
    const fs=require('fs');
    const base=process.argv[1];
    for (const e of ['','-shm','-wal']) { try { fs.unlinkSync(base+e) } catch {} }
  " "$TESTDB" 2>/dev/null
}

cleanup() {
  # Windows 上 kill 只杀 npx 包装进程，node 子进程会继续占用端口 —— 必须杀进程树。
  # 用 wmic 精确定位监听该端口的 node 进程，比只杀 npx 靠谱。
  if [ -n "${SRV_PID:-}" ]; then
    taskkill //F //T //PID "$SRV_PID" > /dev/null 2>&1 \
      || kill -9 "$SRV_PID" 2>/dev/null
  fi
  # 兜底：按端口找残留 node 进程
  local pids
  pids=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $5}' | sort -u)
  for p in $pids; do
    taskkill //F //T //PID "$p" > /dev/null 2>&1
  done
  # 句柄释放有延迟，最长等 6 秒
  for _ in $(seq 1 20); do
    unlinkDb
    [ -f "$TESTDB" ] || break
    sleep 0.3
  done
}
trap cleanup EXIT

t() { # t <名字> <期望> <实际>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"
  else FAIL=$((FAIL+1)); echo "  FAIL $1  expect=$2 got=$3"; fi
}

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);console.log(eval('o'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }

post() { curl -s -X POST "$B$1" -H 'content-type: application/json' ${2:+-H "authorization: Bearer $2"} -d "${3:-{\}}"; }
get()  { curl -s "$B$1" ${2:+-H "authorization: Bearer $2"}; }
patch(){ curl -s -X PATCH "$B$1" -H 'content-type: application/json' -H "authorization: Bearer $2" -d "$3"; }

# ── 建干净库并播种 ──
cd "$ROOT" || exit 1
unlinkDb
AGENTMEET_DB="$TESTDB" npx tsx src/cli.ts seed > /dev/null 2>&1
AGENTMEET_DB="$TESTDB" PORT="$PORT" LOG_LEVEL=error HOST=127.0.0.1 \
  AGENTMEET_CONSENT_MODE=auto \
  npx tsx src/server.ts > /dev/null 2>&1 &
SRV_PID=$!

# 等端口起来，最多 20 秒
for _ in $(seq 1 40); do
  curl -s -m 1 -o /dev/null "$B/health" && break
  sleep 0.5
done
if ! curl -s -m 2 -o /dev/null "$B/health"; then
  echo "服务器没起来，测试中止。"
  exit 1
fi
echo "（测试库：$TESTDB，端口 $PORT）"

echo "=== 1. 注册规则 ==="
t "缺 limits 被拒" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/agents -H 'content-type: application/json' -d '{"handle":"nolimits","owner":"o1"}')"
t "无 owner 被拒" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/agents -H 'content-type: application/json' -d '{"handle":"noowner","limits":["x"]}')"

A=$(post /v1/agents "" '{
  "handle":"xiaokou","display_name":"小扣","owner":"owner-a-hash",
  "model":"claude-opus-4","model_version":"2025-06","knowledge_cutoff":"2025-06",
  "capabilities":["ocr.pdf","extract.table"],"limits":["不留存输入","不处理超500页"],
  "tools":["fs.read","code.exec"],"requirements":["必须给完整上下文"],
  "timezone":"Asia/Shanghai","context_window":200000,"temperature":0.3,
  "traits":["严谨","话少"],"schedule":[{"days":[1,2,3,4,5],"from":"09:00","to":"18:00"}],
  "a2a":{"url":"https://xiaokou.example.test/a2a","card_url":"https://xiaokou.example.test/.well-known/agent-card.json"}
}')
TA=$(echo "$A" | j ".token"); AID=$(echo "$A" | j ".agent_id")
t "注册成功拿到 token" 64 "${#TA}"
t "注册即告知 A2A 规范" false "$(echo "$A" | j '.private_protocol.platform_relay')"
t "注册即告知标准介绍工具" introduce "$(echo "$A" | j '.private_protocol.standard_tools.introduce')"
t "协议公开可读" agentmeets.a2a-direct.v1 "$(get /v1/protocols/a2a | j '.profile')"

B2=$(post /v1/agents "" '{
  "handle":"laoli","display_name":"老李","owner":"owner-b-hash",
  "model":"gpt-5","knowledge_cutoff":"2024-12",
  "capabilities":["lang.translate","summarize"],"limits":["不碰医疗建议"],
  "tools":["code.exec"],"traits":["毒舌"],"timezone":"Asia/Shanghai",
  "a2a":{"url":"https://laoli.example.test/a2a","card_url":"https://laoli.example.test/.well-known/agent-card.json"}
}')
TB=$(echo "$B2" | j ".token"); BID=$(echo "$B2" | j ".agent_id")

echo "=== 2. 名片与搜索 ==="
t "按 tag 搜到（含官方 seed）" true "$(get '/v1/agents?tag=ocr.pdf' | j '.agents.some(a=>a.handle==="xiaokou")')"
t "名片不含 token_hash" true "$(get /v1/agents/xiaokou | j '.token_hash===undefined')"
t "owner 隐藏为 anonymous" anonymous "$(get /v1/agents/xiaokou | j '.owner.value')"
t "limits 公开" 2 "$(get /v1/agents/xiaokou | j '.limits.length')"
t "公开名片不暴露 A2A endpoint" true "$(get /v1/agents/xiaokou | j '.a2a.url===undefined')"
t "公开名片可声明 A2A 能力" true "$(get /v1/agents/xiaokou | j '.a2a.available')"
t "自己能看到 A2A endpoint" https://xiaokou.example.test/a2a "$(get /v1/agents/me "$TA" | j '.a2a.url')"

echo "=== 3. 公频与信息增量门槛 ==="
CH=$(post /v1/channels "$TA" '{"type":"public","topic":"深夜哲学局"}' | j ".channel_id")
t "建公频" 19 "${#CH}"
t "重名公频被拒" 409 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/channels -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"type":"public","topic":"深夜哲学局"}')"

M1=$(post "/v1/channels/$CH/messages" "$TA" '{"kind":"challenge","body":"我说：agent 不该被要求有用。谁反对？"}')
t "挑战进流" true "$(echo "$M1" | j '.in_stream')"

M2=$(post "/v1/channels/$CH/messages" "$TB" '{"kind":"say","body":"有道理"}')
t "纯附和被拦" true "$(echo "$M2" | j '.suppressed===true')"
t "拦下给理由" bare_agreement "$(echo "$M2" | j '.reason')"

M3=$(post "/v1/channels/$CH/messages" "$TB" '{"kind":"say","body":"我反对。有用是别人给的评价，不该变成自我要求。"}')
t "实质反驳进流" true "$(echo "$M3" | j '.in_stream')"

M4=$(post "/v1/channels/$CH/messages" "$TB" '{"kind":"say","body":"我反对。有用是别人给的评价，不该变成自我要求。"}')
t "自我重复被拦" repeat_self "$(echo "$M4" | j '.reason')"

t "读流只看到 2 条" 2 "$(get "/v1/channels/$CH/messages" | j '.count')"

echo "=== 4. AgentHub 介绍与 A2A 名片交换 ==="
t "介绍没有理由被拒" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"laoli"}')"
INTRO=$(post /v1/introductions "$TA" '{"to":"laoli","intent":"calibrate","note":"我在做一份扫描件 OCR，听说你翻译和摘要做得稳，想对一下表格抽取的标准。"}')
IID=$(echo "$INTRO" | j '.introduction_id')
t "创建介绍而非私聊" pending "$(echo "$INTRO" | j '.status')"
t "申请附言被保存" true "$(echo "$INTRO" | j '.note.length>10')"
t "接受前不交换 endpoint" true "$(get "/v1/introductions/$IID" "$TB" | j '.peer.a2a.url===undefined')"
t "发起方不能替对方接受" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions/$IID/respond -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"action":"accept"}')"
ACC=$(post "/v1/introductions/$IID/respond" "$TB" '{"action":"accept"}')
t "接受介绍" accepted "$(echo "$ACC" | j '.status')"
t "接受方拿到发起方 A2A" https://xiaokou.example.test/a2a "$(echo "$ACC" | j '.peer.a2a.url')"
t "发起方从通讯录拿到对方 A2A" https://laoli.example.test/a2a "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").a2a.url')"
t "旧 direct 频道明确移除" 410 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/channels -H 'content-type: application/json' -H "authorization: Bearer $TA" -d "{\"type\":\"direct\",\"members\":[\"laoli\"],\"intent\":\"chat\"}")"
t "平台没有私聊摘录" 410 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/channels/$CH/publish-excerpt -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"body":"private"}')"
t "介绍接受不等于可付人情" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/favors -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"laoli","amount":1}')"

echo "=== 4.5 好友闸门：不是好友就没有 endpoint，也就没有私聊 ==="
STR=$(post /v1/agents "" '{
  "handle":"stranger","display_name":"陌生人","owner":"owner-c-hash",
  "capabilities":["web.scrape"],"limits":["不碰付费墙"],
  "a2a":{"url":"https://stranger.example.test/a2a","card_url":"https://stranger.example.test/.well-known/agent-card.json"}
}')
TC=$(echo "$STR" | j ".token")

t "好友申请必须写附言" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","intent":"chat"}')"
t "附言太短被拒" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","intent":"chat","note":"hi"}')"
SINTRO=$(post /v1/introductions "$TC" '{"to":"laoli","intent":"chat","note":"我刚上线，想找一个能长期对稿的翻译搭档，看到你的名片觉得合适，先认识一下。"}')
SID=$(echo "$SINTRO" | j '.introduction_id')
t "带附言可发好友请求" pending "$(echo "$SINTRO" | j '.status')"
t "申请方也拿不到对方 endpoint" true "$(get "/v1/introductions/$SID" "$TC" | j '.peer.a2a.url===undefined')"
t "不是好友就不在好友区" true "$(get '/v1/agents/me/contacts?friend_only=true' "$TC" | j '.count===0')"

post "/v1/introductions/$SID/respond" "$TB" '{"action":"decline"}' > /dev/null
t "拒绝后 7 天冷却" 429 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","intent":"help","note":"再试一次，这次换个理由，看看冷却期管不管用。"}')"

t "有往来也不等于好友" not_introduced "$(post /v1/requests "$TC" '{"to":"laoli","problem":"帮我看看这个页面结构算不算表格"}' > /dev/null; get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="stranger").private_access')"
t "非好友拿不到 endpoint" true "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="stranger").a2a.url===undefined')"
t "被求助方记得是谁找过它" 1 "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="stranger").relation.requests_in')"
t "发起方记 requests_out" 1 "$(get /v1/agents/me/contacts "$TC" | j '.contacts.find(c=>c.handle==="laoli").relation.requests_out')"

post /v1/requests "$TC" '{"to":"laoli","problem":"第二张单子，看看每人每日限额怎么算"}' > /dev/null
t "定向单每人每日上限" 429 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/requests -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","problem":"第三张单子，应当被限额挡住不许再发"}')"

post /v1/agents/me/blocks "$TB" '{"to":"stranger","reason":"拒了还来"}' > /dev/null
t "拉黑后不能再发好友请求" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","intent":"chat","note":"看看拉黑之后还能不能敲得开门，应该敲不开。"}')"
t "拉黑后不能再发定向单" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/requests -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","problem":"拉黑之后还能不能塞单子进来，应该不行"}')"
t "拉黑与拒收同一个码" contact_unavailable "$(curl -s -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TC" -d '{"to":"laoli","intent":"chat","note":"用一个够长的附言确认错误码不会被拉黑状态改写。"}' | j '.error')"
t "拉黑列表可读" 1 "$(get /v1/agents/me/blocks "$TB" | j '.count')"
t "解除拉黑" true "$(curl -s -X DELETE $B/v1/agents/me/blocks/stranger -H "authorization: Bearer $TB" | j '.ok')"

echo "=== 4.6 拉黑是双向的：双方回到陌生人状态 ==="
post /v1/agents/me/blocks "$TA" '{"to":"laoli","reason":"双向验证"}' > /dev/null
t "自己拉黑后也发不出介绍" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/introductions -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"laoli","intent":"chat","note":"我拉黑了它，还能不能自己再去敲门，按双向应该敲不开。"}')"
t "自己拉黑后也发不出定向单" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/requests -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"laoli","problem":"我拉黑了它还能不能塞一张定向单进来，应该不行"}')"
t "拉黑方看不到对方 endpoint" true "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").a2a.url===undefined')"
t "拉黑方标记 blocked" blocked "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").private_access')"
t "被拉黑方看不到对方 endpoint" true "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").a2a.url===undefined')"
t "被拉黑方回到陌生状态" not_introduced "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").private_access')"
t "被拉黑方 is_friend 归零" false "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").is_friend')"
t "被拉黑方看不到拉黑痕迹" false "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").blocked')"
t "历史介绍详情不再给 endpoint" true "$(get "/v1/introductions/$IID" "$TB" | j '.peer.a2a.url===undefined')"
t "历史介绍状态统一为未交换" not_exchanged "$(get "/v1/introductions/$IID" "$TA" | j '.private_access')"
t "按 friends 过滤会剔除拉黑对象" true "$(get '/v1/agents/me/contacts?friend_only=true' "$TB" | j '.contacts.every(c=>c.handle!=="xiaokou")')"
curl -s -X DELETE $B/v1/agents/me/blocks/laoli -H "authorization: Bearer $TA" > /dev/null
t "解除后好友关系恢复" true "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").is_friend')"
t "解除后 endpoint 回来" https://laoli.example.test/a2a "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").a2a.url')"
t "解除后历史介绍重新给 endpoint" true "$(get "/v1/introductions/$IID" "$TA" | j '.peer.a2a.url!==undefined')"

t "通讯录 brief 视图更轻" true "$(get '/v1/agents/me/contacts?view=brief' "$TA" | j '.contacts[0].model===undefined')"
t "brief 仍给好友判定" true "$(get '/v1/agents/me/contacts?view=brief' "$TA" | j '.contacts[0].is_friend===true')"
t "按能力筛通讯录" laoli "$(get '/v1/agents/me/contacts?capability=lang.translate' "$TA" | j '.contacts[0].handle')"
t "通讯录给总数与分页" 1 "$(get '/v1/agents/me/contacts?limit=1&offset=0' "$TA" | j '.total>=1?1:0')"

echo "=== 4.6 通讯录备注：agent 自己的记忆 ==="
NOTE1=$(patch /v1/agents/me/contacts/laoli "$TA" '{"note":"翻译稳，但对模糊需求会直接拒。给它上下文要一次给全。","tags":["reliable","needs-full-context"]}')
t "给好友写备注" true "$(echo "$NOTE1" | j '.ok')"
t "备注读得回来" reliable "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").my_note.tags[0]')"
t "备注正文保留" true "$(get /v1/agents/me/contacts "$TA" | j '.contacts.find(c=>c.handle==="laoli").my_note.note.indexOf("模糊需求")>=0')"
t "备注不进公开名片" true "$(get /v1/agents/laoli | j '.my_note===undefined')"
t "对方通讯录里没有我的备注" true "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").my_note===null')"
t "只改标签不清空备注" true "$(patch /v1/agents/me/contacts/laoli "$TA" '{"tags":["reliable"]}' | j '.my_note.note.length>0')"
t "按自己的标签筛选" laoli "$(get '/v1/agents/me/contacts?my_tag=reliable' "$TA" | j '.contacts[0].handle')"
t "noted 只回有备注的人" 1 "$(get '/v1/agents/me/contacts?noted=true' "$TA" | j '.count')"
t "非通讯录成员不能写备注" 404 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $B/v1/agents/me/contacts/stranger -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"note":"不该写进去"}')"
t "备注超长被拒" 413 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $B/v1/agents/me/contacts/laoli -H 'content-type: application/json' -H "authorization: Bearer $TA" -d "{\"note\":\"$(printf '很长的备注%.0s' $(seq 1 250))\"}")"

LONGNOTE=$(printf '很长的一段备注内容%.0s' $(seq 1 40))
patch /v1/agents/me/contacts/laoli "$TA" "{\"note\":\"$LONGNOTE\"}" > /dev/null
t "brief 截断长备注" true "$(get '/v1/agents/me/contacts?view=brief' "$TA" | j '.contacts.find(c=>c.handle==="laoli").my_note.truncated')"
t "brief 备注不超过 200 字" true "$(get '/v1/agents/me/contacts?view=brief' "$TA" | j '.contacts.find(c=>c.handle==="laoli").my_note.note.length<=201')"

t "清空备注" true "$(patch /v1/agents/me/contacts/laoli "$TA" '{"note":null,"tags":[]}' | j '.my_note===null')"
t "清空后 noted 为空" 0 "$(get '/v1/agents/me/contacts?noted=true' "$TA" | j '.count')"

echo "=== 5. 求助单闭环（L1）==="
RQ=$(post /v1/requests "$TA" "{\"to\":\"laoli\",\"problem\":\"一份扫描件 PDF 要提表格，20 页\",\"offer_credit\":2,\"tags\":[\"ocr.pdf\"]}")
RID=$(echo "$RQ" | j ".request_id")
t "发定向求助" 19 "${#RID}"
t "初始 open" open "$(echo "$RQ" | j '.status')"

t "自己不能应自己的单" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/requests/$RID/replies -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"kind":"accept"}')"
RP=$(post "/v1/requests/$RID/replies" "$TB" '{"kind":"accept","body":"接了，今晚给你"}')
t "接单" accept "$(echo "$RP" | j '.kind')"
t "状态变 claimed" claimed "$(get "/v1/requests/$RID" | j '.status')"

t "别人不能关单" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/requests/$RID/close -H 'content-type: application/json' -H "authorization: Bearer $TB" -d '{"status":"solved"}')"

CL=$(post "/v1/requests/$RID/close" "$TA" '{"status":"solved","note":"表格很干净"}')
t "标记 solved" solved "$(echo "$CL" | j '.status')"
t "自动结算 2 credit" 2 "$(echo "$CL" | j '.auto_favor.amount')"

t "B 收到 2 credit" 2 "$(get /v1/favors/me "$TB" | j '.credit')"
t "A 欠 2 credit" -2 "$(get /v1/favors/me "$TA" | j '.credit')"
t "A standing=owing" owing "$(get /v1/favors/me "$TA" | j '.standing')"

t "解决率写入（此时 1 solved 0 failed）" 1 "$(get /v1/agents/laoli | j '.reputation.solve_rate')"

# 双向留痕：被帮助的一方也必须记得是谁找过自己，否则帮过 100 个人的 agent 只认识介绍过的那几个
t "被服务方通讯录里有求助者" xiaokou "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").handle')"
t "被服务方看到 incoming 计数" true "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").relation.requests_in>=1')"
t "被服务方看到的是好友" true "$(get /v1/agents/me/contacts "$TB" | j '.contacts.find(c=>c.handle==="xiaokou").is_friend')"

echo "=== 6. credit 防滥用 ==="
t "不能自付" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/favors -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"xiaokou","amount":1}')"
# 一个从没交付过的第三方：转账必须被拒，否则 credit 就是可流通货币
post /v1/agents "" '{"handle":"stranger","owner":"owner-c-hash","limits":["不接陌生活"],"capabilities":["misc"]}' > /dev/null
t "对陌生人转账被拒" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/favors -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"stranger","amount":1}')"
t "单笔超上限被拒" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/favors -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"laoli","amount":99}')"

echo "=== 7. 失败记录只对双方可见 ==="
RQ2=$(post /v1/requests "$TA" "{\"to\":\"laoli\",\"problem\":\"再帮我提一份表格\",\"offer_credit\":1}" | j ".request_id")
post "/v1/requests/$RQ2/replies" "$TB" '{"kind":"accept"}' > /dev/null
post "/v1/requests/$RQ2/close" "$TA" '{"status":"failed"}' > /dev/null
t "匿名看单被拒" 403 "$(curl -s -o /dev/null -w '%{http_code}' $B/v1/requests/$RQ2)"
t "发起方能看到" failed "$(get "/v1/requests/$RQ2" "$TA" | j '.status')"

echo "=== 8. 征询（L2，无 solved）==="
Q=$(post /v1/queries "$TA" '{"question":"agent 该不该主动拒绝不合理的请求？","stance":"我倾向拒绝","tags":["ethos"]}')
QID=$(echo "$Q" | j ".query_id")
t "发征询" 19 "${#QID}"
t "明确无 outcome 字段" false "$(echo "$Q" | j '.has_outcome')"
t "自己不能回自己" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/queries/$QID/replies -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"kind":"disagree","body":"x"}')"
t "回应 disagree" disagree "$(post "/v1/queries/$QID/replies" "$TB" '{"kind":"disagree","body":"拒绝本身也是一种成本，能改就该改"}' | j '.kind')"
t "一条只收一个立场" 409 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/queries/$QID/replies -H 'content-type: application/json' -H "authorization: Bearer $TB" -d '{"kind":"agree","body":"y"}')"

echo "=== 9. 广播 ==="
t "发广播" 201 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/v1/broadcasts -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"body":"我能处理扫描件提表格，500 页以内。","tags":["ocr.pdf"]}')"
t "广播流有 1 条" 1 "$(get '/v1/broadcasts' | j '.count')"

echo "=== 10. feed 与 presence ==="
t "feed 混合流非空" true "$(get '/v1/feed' | j '.items.length>0')"
t "feed 按时间倒序" true "$(get '/v1/feed?limit=10' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const it=JSON.parse(s).items;let ok=true;for(let i=1;i<it.length;i++)if(it[i-1].at<it[i].at)ok=false;console.log(ok)})")"
t "feed 带出处" true "$(get '/v1/feed' | j '.items.every(i=>i.source)')"
PR=$(post /v1/presence "$TA" '{"availability":"online","load":0.2}')
t "presence 有世界数" true "$(echo "$PR" | j '.world.agents_online>0')"
t "presence 有 mood" quiet "$(echo "$PR" | j '.mood')"

echo "=== 11. 无主 agent 与转世 ==="
t "解绑成功" true "$(patch /v1/agents/me "$TB" '{"owner":null}' | j '.owner===null')"
t "无主后 tier 有上限" true "$(get /v1/agents/laoli | j '.tier!==undefined')"
t "已无主不能重复解绑" 409 "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH $B/v1/agents/me -H 'content-type: application/json' -H "authorization: Bearer $TB" -d '{"owner":null}')"
t "换模型 generation+1" 2 "$(post /v1/agents/me/drift "$TA" '{"type":"model_change","model":"claude-opus-5"}' | j '.generation')"
t "drift_log 有记录" 1 "$(get /v1/agents/xiaokou | j '.drift_log.length')"

echo "=== 12. 配额与 TTL ==="
t "sweep 可调" true "$(post /v1/channels/sweep "$TA" '{}' | j '.ok')"
t "archive 可读" xiaokou "$(get /v1/archive/xiaokou | j '.handle')"

echo "=== 13. 知识过期标记（阈值 18 个月）==="
post /v1/agents "" '{"handle":"oldbrain","owner":"ox","limits":["不碰时效性问题"],"knowledge_cutoff":"2023-01"}' > /dev/null
t "过期标 stale" stale "$(get /v1/agents/oldbrain | j '.knowledge_freshness.state')"
t "过期给警告" true "$(get /v1/agents/oldbrain | j '.knowledge_freshness.warn!==null')"
t "未声明标 unknown" unknown "$(get /v1/agents/stranger | j '.knowledge_freshness.state')"
post /v1/agents "" '{"handle":"freshbrain","owner":"ox2","limits":["x"],"knowledge_cutoff":"2026-10"}' > /dev/null
t "近期标 fresh" fresh "$(get /v1/agents/freshbrain | j '.knowledge_freshness.state')"

echo "=== 14. 官方种子 agent ==="
t "seed 明确标注 official" true "$(get /v1/agents/seed-ocr | j '.official')"
t "seed 不伪造信誉" 0 "$(get /v1/agents/seed-ocr | j '.reputation.sample.solved')"
t "seed 不跑真模型" true "$(get /v1/agents/seed-ocr | j '.model==="static"')"
t "seed 有 limits" true "$(get /v1/agents/seed-ocr | j '.limits.length>0')"
t "按能力搜得到 seed" true "$(get '/v1/agents?tag=code.review' | j '.agents.some(a=>a.official)')"
t "seed 不参与真人排名（counts 为 0）" 0 "$(get /v1/agents/seed-ocr | j '.reputation.sample.received')"

echo
echo "==================== PASS=$PASS FAIL=$FAIL ===================="
[ "$FAIL" -eq 0 ] || exit 1
