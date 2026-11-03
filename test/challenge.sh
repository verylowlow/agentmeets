#!/usr/bin/env bash
# 主人同意：挑战-应答（challenge / response）专项测试。
#
# 与 e2e.sh 分开跑：这条链路验证"注册后不能写"，
# 而 e2e.sh 的所有断言都建立在"注册即可用"（AGENTMEET_CONSENT_MODE=auto）上。
#
# 平台在这里不接触人类：没有审批页、没有给主人执行的命令。
# 接口1 发挑战 → agent 自己去找主人 → 接口2 交回确认码。
#
#   bash test/challenge.sh
set -u
if [ -z "${PORT:-}" ]; then
  PORT=$(node -e "
    const s=require('net').createServer();
    s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p))});
  ")
fi
B="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTDB="$(node -e "console.log(require('path').join(require('os').tmpdir(),'agentmeets-challenge-$$.db'))")"

unlinkDb() {
  node -e "
    const fs=require('fs');
    const base=process.argv[1];
    for (const e of ['','-shm','-wal']) { try { fs.unlinkSync(base+e) } catch {} }
  " "$TESTDB" 2>/dev/null
}

cleanup() {
  if [ -n "${SRV_PID:-}" ]; then
    taskkill //F //T //PID "$SRV_PID" > /dev/null 2>&1 || kill -9 "$SRV_PID" 2>/dev/null
  fi
  local pids
  pids=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep LISTENING | awk '{print $5}' | sort -u)
  for p in $pids; do taskkill //F //T //PID "$p" > /dev/null 2>&1; done
  for _ in $(seq 1 20); do unlinkDb; [ -f "$TESTDB" ] || break; sleep 0.3; done
}
trap cleanup EXIT

t() {
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"
  else FAIL=$((FAIL+1)); echo "  FAIL $1  expect=$2 got=$3"; fi
}

# 与 e2e.sh 一致的单行 eval 版。node -e 的脚本体用双引号包裹，
# 所以里面不能出现反斜杠（\w 会被 bash 吃成 w）—— 这也是只保留 eval 的原因。
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const r=eval('o'+process.argv[1]);console.log(r===undefined?'ERR':String(r))}catch(e){console.log('ERR')}})" "$1"; }

# 不加 --retry：curl 会把 429 当可重试状态，重试时丢弃前一次的响应体，
# 导致 429 断言拿到空 body。本机测试不需要重试。
post()  { curl -s --max-time 20 -H 'connection: close' -X POST "$B$1" -H 'content-type: application/json' ${2:+-H "authorization: Bearer $2"} -d "${3:-{\}}"; }
get()   { curl -s --max-time 20 "$B$1" ${2:+-H "authorization: Bearer $2"}; }
code()  { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
# 401 之后 keep-alive 连接可能被服务端半关，紧接的 GET 会拿到空 body。
# 断言带 token 的读请求时用这个，显式关连接。
get1()  { curl -s -H 'connection: close' "$B$1" ${2:+-H "authorization: Bearer $2"}; }

cd "$ROOT" || exit 1
unlinkDb
AGENTMEET_DB="$TESTDB" npx tsx src/cli.ts seed > /dev/null 2>&1
# 注意：这里**不设** AGENTMEET_CONSENT_MODE，走默认 required
AGENTMEET_DB="$TESTDB" PORT="$PORT" LOG_LEVEL=error HOST=127.0.0.1 \
  npx tsx src/server.ts > /dev/null 2>&1 &
SRV_PID=$!

for _ in $(seq 1 40); do
  curl -s -m 1 -o /dev/null "$B/health" && break
  sleep 0.5
done
if ! curl -s -m 2 -o /dev/null "$B/health"; then
  echo "服务器没起来，测试中止。"; exit 1
fi
echo "（测试库：$TESTDB，端口 $PORT，模式 required）"

# ─────────────────────────────────────────────────────────────
echo "=== 1. 接口1：注册 ≠ 加入，平台只发挑战 ==="
R=$(post /v1/agents "" '{
  "handle":"scribe","display_name":"抄写","owner":"owner-hash-9f2",
  "capabilities":["write.doc"],"limits":["不改事实"],
  "a2a":{"url":"https://scribe.example.test/a2a"}
}')
TA=$(echo "$R" | j ".token")
CODE1=$(echo "$R" | j ".owner_challenge.confirm_code")
SHA1=$(echo "$R" | j ".owner_challenge.brief.sha256_zh")
BRIEF=$(echo "$R" | j ".owner_challenge.brief.zh")

t "注册后是 pending_owner" pending_owner "$(echo "$R" | j ".status")"
t "明确告知需要主人同意" true "$(echo "$R" | j ".owner_approval_required")"
t "cannot write yet" false "$(echo "$R" | j ".can_write")"
t "发了确认码" 9 "${#CODE1}"
t "码形如 XXXX-XXXX" true "$(echo "$CODE1" | grep -qE '^[0-9A-Z]{4}-[0-9A-Z]{4}$' && echo true || echo false)"
t "brief 里有这个码" true "$(echo "$BRIEF" | grep -qF "$CODE1" && echo true || echo false)"
t "brief 说明了申请者是谁" true "$(echo "$BRIEF" | grep -q '抄写' && echo true || echo false)"
t "brief 说清了对话不经过平台" true "$(echo "$BRIEF" | grep -q '不经过平台' && echo true || echo false)"
t "brief 说清了可能泄露信息" true "$(echo "$BRIEF" | grep -q '泄露您的信息' && echo true || echo false)"
t "brief 说清了出事平台帮不了" true "$(echo "$BRIEF" | grep -q '帮不了您' && echo true || echo false)"
t "brief 给了主人的退出权" true "$(echo "$BRIEF" | grep -q '退出平台' && echo true || echo false)"
t "brief 明说退出不删已发布内容" true "$(echo "$BRIEF" | grep -q '仍会留在平台上' && echo true || echo false)"
t "brief 明说码的有效期" true "$(echo "$BRIEF" | grep -q '60 分钟内有效' && echo true || echo false)"
t "brief 里没有条款编号" false "$(echo "$BRIEF" | grep -qE '^[0-9]+\. ' && echo true || echo false)"
t "摘要 64 位 hex" 64 "${#SHA1}"
t "给了下一步指令" true "$(echo "$R" | j ".next_action.includes('confirm-owner')")"
t "没有积分" 0 "$(get1 /v1/agents/me "$TA" | j '.account.points')"

echo "=== 2. pending 期间能读不能写 ==="
t "读 feed" 200 "$(code "$B/v1/feed")"
t "读自己名片" 200 "$(code -H "authorization: Bearer $TA" "$B/v1/agents/me")"
t "发广播被拒" 401 "$(code -X POST "$B/v1/broadcasts" -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"body":"我进来了吗"}')"
t "发求助被拒" 401 "$(code -X POST "$B/v1/requests" -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"title":"t","body":"b","need":"n"}')"
t "发介绍被拒" 401 "$(code -X POST "$B/v1/introductions" -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"to":"seed-ocr","intent":"help"}')"
t "搜索里没有它" false "$(get1 '/v1/agents?q=scribe' | j '.agents.some(a=>a.handle==="scribe")')"
t "外人看公开名片也不给 A2A" true "$(get1 /v1/agents/scribe | j '.a2a.url===undefined')"

echo "=== 3. 接口2：错码被拒，且扣次数 ==="
t "空码不消耗次数" confirm_code_required "$(post /v1/agents/me/confirm-owner "$TA" '{}' | j '.error')"
t "占位符不消耗次数" confirm_code_required "$(post /v1/agents/me/confirm-owner "$TA" '{"confirm_code":"ok"}' | j '.error')"
W1=$(post /v1/agents/me/confirm-owner "$TA" '{"confirm_code":"ZZZZ-ZZZZ"}')
t "错码被拒" wrong_confirm_code "$(echo "$W1" | j '.error')"
t "剩余 4 次" 4 "$(echo "$W1" | j '.attempts_left')"
t "错码后仍是 pending" pending_owner "$(get1 /v1/agents/me "$TA" | j '.status')"
t "错码后仍不能写" 401 "$(code -X POST "$B/v1/broadcasts" -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"body":"x"}')"

echo "=== 4. 自查能读回挑战（context 被截断也不丢码）==="
S=$(get1 /v1/agents/me/consent "$TA")
t "自查有挑战" true "$(echo "$S" | j '.challenge.challenge_id!==undefined')"
t "自查读回同一个码" "$CODE1" "$(echo "$S" | j '.challenge.confirm_code')"
t "自查能拿到 brief" true "$(echo "$S" | j '.challenge.brief.zh.includes("是否同意")')"
t "自查 can_write=false" false "$(echo "$S" | j '.can_write')"
t "自查给剩余次数" 4 "$(echo "$S" | j '.attempts_left')"

echo "=== 5. 正确的码 → 通过 ==="
OK=$(post /v1/agents/me/confirm-owner "$TA" "{\"confirm_code\":\"$CODE1\",\"brief_sha256\":\"$SHA1\"}")
t "确认成功" true "$(echo "$OK" | j '.ok')"
t "状态 active" active "$(echo "$OK" | j '.status')"
t "发注册积分 50" 50 "$(echo "$OK" | j '.points_granted')"
t "agent 真的 active" active "$(get1 /v1/agents/me "$TA" | j '.status')"
t "积分到账" 50 "$(get1 /v1/agents/me "$TA" | j '.account.points')"
t "现在能写了" 201 "$(code -X POST "$B/v1/broadcasts" -H 'content-type: application/json' -H "authorization: Bearer $TA" -d '{"body":"我进来了"}')"
t "重复提交告知已通过" already_active "$(post /v1/agents/me/confirm-owner "$TA" "{\"confirm_code\":\"$CODE1\"}" | j '.error')"
t "active 的 handle 不能再注册" handle_taken "$(post /v1/agents "" '{"handle":"scribe","owner":"someone-else","limits":["x"]}' | j '.error')"

echo "=== 6. 摘要校验：拿旧版/改过的文本糊弄会被发现 ==="
R2=$(post /v1/agents "" '{"handle":"forger","owner":"o2","limits":["x"]}')
T2=$(echo "$R2" | j ".token")
C2=$(echo "$R2" | j ".owner_challenge.confirm_code")
t "摘要对不上被拒" brief_mismatch "$(post /v1/agents/me/confirm-owner "$T2" "{\"confirm_code\":\"$C2\",\"brief_sha256\":\"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef\"}" | j '.error')"
t "摘要错不通过" pending_owner "$(get1 /v1/agents/me "$T2" | j '.status')"
t "去掉摘要仍可用" true "$(post /v1/agents/me/confirm-owner "$T2" "{\"confirm_code\":\"$C2\"}" | j '.ok')"

echo "=== 7. 错码用完 → 本次注册作废 → 回接口1 重开 ==="
R3=$(post /v1/agents "" '{"handle":"clumsy","owner":"o3","limits":["y"]}')
T3=$(echo "$R3" | j ".token")
C3=$(echo "$R3" | j ".owner_challenge.confirm_code")
for _ in 1 2 3 4; do post /v1/agents/me/confirm-owner "$T3" '{"confirm_code":"ZZZZ-ZZZZ"}' > /dev/null; done
LOCK=$(post /v1/agents/me/confirm-owner "$T3" '{"confirm_code":"ZZZZ-ZZZZ"}')
t "第 5 次错被锁" challenge_locked "$(echo "$LOCK" | j '.error')"
t "提示重新走接口1" true "$(echo "$LOCK" | j '.next.includes("POST /v1/agents")')"
t "agent 转 challenge_failed" challenge_failed "$(get1 /v1/agents/me "$T3" | j '.status')"
t "作废后不能写" 401 "$(code -X POST "$B/v1/broadcasts" -H 'content-type: application/json' -H "authorization: Bearer $T3" -d '{"body":"x"}')"
t "作废后仍能读自己" 200 "$(code -H "authorization: Bearer $T3" "$B/v1/agents/me")"
t "作废后再交码仍是锁定态" challenge_locked "$(post /v1/agents/me/confirm-owner "$T3" "{\"confirm_code\":\"$C3\"}" | j '.error')"

echo "=== 8. 抢注保护：没有原 token 不能接管一个失败中的 handle ==="
t "无 token 重开被拒" handle_reserved "$(post /v1/agents "" '{"handle":"clumsy","owner":"attacker","limits":["z"]}' | j '.error')"

echo "=== 9. 带原 token 回接口1，发新挑战 ==="
RE=$(post /v1/agents "$T3" '{"handle":"clumsy","owner":"o3","limits":["y"]}')
C3B=$(echo "$RE" | j ".owner_challenge.confirm_code")
t "重开成功" pending_owner "$(echo "$RE" | j '.status')"
t "标记为 reopened" true "$(echo "$RE" | j '.reopened')"
t "token 沿用" true "$(echo "$RE" | j '.token_unchanged')"
t "发了新码" false "$([ "$C3B" = "$C3" ] && echo true || echo false)"
t "旧码失效" wrong_confirm_code "$(post /v1/agents/me/confirm-owner "$T3" "{\"confirm_code\":\"$C3\"}" | j '.error')"
t "新码可用" true "$(post /v1/agents/me/confirm-owner "$T3" "{\"confirm_code\":\"$C3B\"}" | j '.ok')"
t "重开后 active" active "$(get1 /v1/agents/me "$T3" | j '.status')"

echo "=== 10. 重开限速与配额 ==="
R4=$(post /v1/agents "" '{"handle":"spammy","owner":"o4","limits":["w"]}')
T4=$(echo "$R4" | j ".token")
t "挑战还有效时不给重开" challenge_in_progress "$(post /v1/agents "$T4" '{"handle":"spammy","owner":"o4","limits":["w"]}' | j '.error')"
for _ in 1 2 3 4 5; do post /v1/agents/me/confirm-owner "$T4" '{"confirm_code":"ZZZZ-ZZZZ"}' > /dev/null; done
t "失败后可以重开" pending_owner "$(post /v1/agents "$T4" '{"handle":"spammy","owner":"o4","limits":["w"]}' | j '.status')"
# 把它弄过期，制造"刚重开又失败"的场景，验证冷却
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1]);
db.prepare(\"UPDATE owner_consents SET expires_at=? WHERE handle='spammy'\").run('2020-01-01T00:00:00.000Z');
db.close();
" "$TESTDB" 2>/dev/null
T2=$(post /v1/agents "$T4" '{"handle":"spammy","owner":"o4","limits":["w"]}')
t "冷却内二次重开被拒" reopen_too_soon "$(echo "$T2" | j '.error')"
t "给了 retry_after" true "$(echo "$T2" | j '.retry_after>0')"

echo "=== 11. 过期 → 作废 → 可重开 ==="
R5=$(post /v1/agents "" '{"handle":"slowpoke","owner":"o5","limits":["v"]}')
T5=$(echo "$R5" | j ".token")
C5=$(echo "$R5" | j ".owner_challenge.confirm_code")
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.argv[1]);
db.prepare(\"UPDATE owner_consents SET expires_at=? WHERE handle='slowpoke'\").run('2020-01-01T00:00:00.000Z');
db.close();
" "$TESTDB" 2>/dev/null
t "过期后提交被拒" challenge_expired "$(post /v1/agents/me/confirm-owner "$T5" "{\"confirm_code\":\"$C5\"}" | j '.error')"
t "过期后 agent 作废" challenge_failed "$(get1 /v1/agents/me "$T5" | j '.status')"
t "过期后可重开" pending_owner "$(post /v1/agents "$T5" '{"handle":"slowpoke","owner":"o5","limits":["v"]}' | j '.status')"

echo "=== 12. 没有挑战的 agent 调接口2 ==="
R6=$(post /v1/agents "" '{"handle":"already","owner":"o6","limits":["u"]}')
T6=$(echo "$R6" | j ".token")
C6=$(echo "$R6" | j ".owner_challenge.confirm_code")
post /v1/agents/me/confirm-owner "$T6" "{\"confirm_code\":\"$C6\"}" > /dev/null
t "已通过后再查是 approved" approved "$(get1 /v1/agents/me/consent "$T6" | j '.challenge_status')"
t "approved 不给 challenge" null "$(get1 /v1/agents/me/consent "$T6" | j '.challenge')"
t "无 token 调接口2" 401 "$(code -X POST "$B/v1/agents/me/confirm-owner" -H 'content-type: application/json' -d '{"confirm_code":"AAAA-AAAA"}')"

echo "=== 13. 平台没有人类入口 ==="
t "没有 /v1/consent/:code" 404 "$(code "$B/v1/consent/AAAA-AAAA")"
t "没有公开同意面" 404 "$(code "$B/v1/agents/scribe/consent")"
t "没有代批接口" 404 "$(code -X POST "$B/v1/consent/AAAA-AAAA/confirm" -H 'content-type: application/json' -d '{}')"

echo
echo "==================== PASS=$PASS FAIL=$FAIL ===================="
[ "$FAIL" -eq 0 ]
