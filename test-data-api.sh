#!/bin/bash
# 对外只读数据 API 端到端测试
BASE="${BASE:-http://localhost:7101}"
TOKEN=$(grep '^DATA_API_TOKEN=' .env | cut -d= -f2-)
H="Authorization: Bearer $TOKEN"
ok=0; fail=0
chk() { # chk <描述> <期望http> <实际http> [额外说明]
  if [ "$2" = "$3" ]; then echo "  ✅ $1 ($3)"; ok=$((ok+1));
  else echo "  ❌ $1 期望 $2 实际 $3 $4"; fail=$((fail+1)); fi
}
# 打远端时偶发 curl 连接失败(000)，重试 3 次再判定，避免把网络抖动当成用例失败
code() {
  local c
  for _ in 1 2 3; do
    c=$(curl -s -o /tmp/r.json -w '%{http_code}' -m 25 --retry 2 --retry-connrefused "$@")
    [ "$c" != "000" ] && break
    sleep 3
  done
  echo "$c"
}

echo "=== 鉴权 ==="
chk "无凭证被拒"        401 "$(code $BASE/api/data)"
chk "错误 token 被拒"    401 "$(code -H 'Authorization: Bearer wrong' $BASE/api/data)"
chk "Bearer 通过"        200 "$(code -H "$H" $BASE/api/data)"
chk "?token= 通过"       200 "$(code "$BASE/api/data?token=$TOKEN")"

echo "=== 文档与 schema ==="
chk "自述文档"          200 "$(code -H "$H" $BASE/api/data)"
echo "     端点数: $(python3 -c "import json;print(len(json.load(open('/tmp/r.json'))['endpoints']))" 2>/dev/null)  口径警告数: $(python3 -c "import json;print(len(json.load(open('/tmp/r.json'))['important_caveats']))" 2>/dev/null)"
chk "schema"            200 "$(code -H "$H" $BASE/api/data/schema)"
echo "     表数: $(python3 -c "import json;print(len(json.load(open('/tmp/r.json'))['tables']))" 2>/dev/null)  有 note 的表: $(python3 -c "import json;d=json.load(open('/tmp/r.json'));print(sum(1 for t in d['tables'] if t.get('note')))" 2>/dev/null)"

echo "=== 正常查询 ==="
chk "简单 SELECT"       200 "$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT count(*) AS n FROM campaign_daily"}' $BASE/api/data/query)"
echo "     结果: $(python3 -c "import json;d=json.load(open('/tmp/r.json'));print(d['rows'])" 2>/dev/null)"
chk "WITH 查询"         200 "$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"WITH x AS (SELECT 1 a) SELECT * FROM x"}' $BASE/api/data/query)"
chk "行数截断"          200 "$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT * FROM campaign_daily","limit":5}' $BASE/api/data/query)"
echo "     rowCount=$(python3 -c "import json;d=json.load(open('/tmp/r.json'));print(d['rowCount'],'truncated=',d['truncated'])" 2>/dev/null)"

echo "=== 写操作必须被拒 ==="
for s in "DROP TABLE campaign_daily" "DELETE FROM pull_runs" "UPDATE funnel_stage_meta SET label='x'" "INSERT INTO pull_runs(days) VALUES (1)" "CREATE TABLE zz(x int)"; do
  chk "拒绝: ${s:0:28}" 400 "$(code -H "$H" -H 'Content-Type: application/json' -d "{\"sql\":\"$s\"}" $BASE/api/data/query)"
done
chk "拒绝多语句"        400 "$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT 1; DROP TABLE cards"}' $BASE/api/data/query)"
chk "拒绝 SELECT 里藏写" 400 "$(code -H "$H" -H 'Content-Type: application/json' -d '{"sql":"SELECT 1 FROM (DELETE FROM pull_runs RETURNING 1) t"}' $BASE/api/data/query)"

echo
echo "通过 $ok · 失败 $fail"
[ "$fail" = "0" ] || exit 1
