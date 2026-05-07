#!/usr/bin/env bash
# Do NOT use set -e; we track pass/fail ourselves and must not exit on curl errors.
set -uo pipefail

PASS=0
FAIL=0
TOTAL=0

LH="${LOCALHAUS_URL:?LOCALHAUS_URL not set}"
FIXTURE="${FIXTURE_PATH:?FIXTURE_PATH not set}"
DOMAIN="${LOCALHAUS_DOMAIN:-test.local}"

assert() {
  local desc="$1" result="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$result" = "true" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $desc"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $desc"
  fi
}

# Curl wrapper: captures status code + body, never exits on error.
# Usage: api_call METHOD URL [extra curl args...]
# Sets globals: RESP_STATUS, RESP_BODY
RESP_STATUS=""
RESP_BODY=""
api_call() {
  local method="$1" url="$2"
  shift 2
  local tmpfile
  tmpfile=$(mktemp)
  RESP_STATUS=$(curl -s -o "$tmpfile" -w '%{http_code}' -X "$method" "$@" "$url") || true
  RESP_BODY=$(cat "$tmpfile")
  rm -f "$tmpfile"
  echo "  >> $method $url -> HTTP $RESP_STATUS"
  if [ "${RESP_STATUS:-0}" -ge 400 ] 2>/dev/null; then
    echo "  >> body: $RESP_BODY"
  fi
}

echo "=== Localhaus E2E Lifecycle Test ==="
echo "  LH=$LH"
echo "  FIXTURE=$FIXTURE"
echo ""

# ── Step 1: Wait for localhaus health ──
echo "Step 1: Wait for localhaus to be healthy"
HEALTHY=false
for i in $(seq 1 30); do
  if curl -sf "$LH/" > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  echo "  waiting... ($i/30)"
  sleep 2
done
assert "localhaus is healthy" "$HEALTHY"

# ── Step 2: Create project ──
echo "Step 2: Create fixture project"
api_call POST "$LH/projects" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "name=e2e-fixture&path=${FIXTURE}&description=e2e+test"
# POST /projects returns 302 redirect on success (express res.redirect)
assert "POST /projects returns 302 or 200" \
  "$([ "$RESP_STATUS" = "302" ] || [ "$RESP_STATUS" = "200" ] && echo true || echo false)"

# ── Step 3: Verify project exists in API ──
echo "Step 3: Verify project in API"
api_call GET "$LH/api/projects"
PROJECTS_JSON="$RESP_BODY"
PROJECT_ID=$(echo "$PROJECTS_JSON" | jq -r '.[] | select(.name=="e2e-fixture") | .id' 2>/dev/null) || true
SUBDOMAIN=$(echo "$PROJECTS_JSON" | jq -r '.[] | select(.name=="e2e-fixture") | .subdomain' 2>/dev/null) || true
assert "project exists with ID and subdomain" \
  "$([ -n "$PROJECT_ID" ] && [ -n "$SUBDOMAIN" ] && echo true || echo false)"
echo "  project_id=$PROJECT_ID subdomain=$SUBDOMAIN"

# ── Step 4: Start project ──
echo "Step 4: Start project"
api_call POST "$LH/projects/$PROJECT_ID/start"
START_OK=$(echo "$RESP_BODY" | jq -r '.success' 2>/dev/null) || true
if [ "$START_OK" != "true" ]; then
  echo "  >> start failed, body: $RESP_BODY"
fi
assert "POST /projects/:id/start returns success" \
  "$([ "$START_OK" = "true" ] && echo true || echo false)"

# ── Step 5: Poll until running with port ──
echo "Step 5: Wait for project to be running with port"
RUNNING=false
PORT=""
for i in $(seq 1 60); do
  PJSON=$(curl -s "$LH/api/projects" 2>/dev/null) || true
  STATUS=$(echo "$PJSON" | jq -r ".[] | select(.id==$PROJECT_ID) | .status" 2>/dev/null) || true
  PORT=$(echo "$PJSON" | jq -r ".[] | select(.id==$PROJECT_ID) | .port" 2>/dev/null) || true
  if [ "$STATUS" = "running" ] && [ -n "$PORT" ] && [ "$PORT" != "null" ]; then
    RUNNING=true
    break
  fi
  echo "  waiting for running... status=$STATUS port=$PORT ($i/60)"
  sleep 3
done
assert "project status is running" "$RUNNING"
assert "project has assigned port" \
  "$([ -n "$PORT" ] && [ "$PORT" != "null" ] && echo true || echo false)"
echo "  port=$PORT"

# ── Step 6: Subdomain proxy ──
echo "Step 6: Test subdomain proxy"
PROXY_BODY=$(curl -s -H "Host: ${SUBDOMAIN}.${DOMAIN}" "http://localhost:7777/" 2>/dev/null) || true
if [ "$PROXY_BODY" != "e2e-fixture-ok" ]; then
  echo "  >> proxy got: '$PROXY_BODY'"
fi
assert "subdomain proxy returns e2e-fixture-ok" \
  "$([ "$PROXY_BODY" = "e2e-fixture-ok" ] && echo true || echo false)"

# ── Step 7: Logs endpoints ──
echo "Step 7: Test logs history and live stream endpoints"
api_call GET "$LH/projects/$PROJECT_ID/logs?lines=200"
HISTORY_LOG_LINE_COUNT=$(echo "$RESP_BODY" | jq -er 'if (.lines | type == "array") then (.lines | length) else empty end' 2>/dev/null) || HISTORY_LOG_LINE_COUNT=""
HISTORY_HAS_FIXTURE_LOG=$(echo "$RESP_BODY" | jq -r '(.lines | type == "array") and any(.lines[]?; contains("e2e fixture listening on :3000"))' 2>/dev/null) || HISTORY_HAS_FIXTURE_LOG="false"
HISTORY_HAS_ERROR_LOG=$(echo "$RESP_BODY" | jq -r 'if (.lines | type == "array") then any(.lines[]?; contains("Error getting logs:")) else true end' 2>/dev/null) || HISTORY_HAS_ERROR_LOG="true"
if [ "$HISTORY_HAS_FIXTURE_LOG" != "true" ] || [ "$HISTORY_HAS_ERROR_LOG" = "true" ]; then
  echo "  >> logs history line count: ${HISTORY_LOG_LINE_COUNT:-0}"
  echo "  >> logs history body: $RESP_BODY"
fi
assert "logs history includes fixture startup log and no error lines" \
  "$([ "$RESP_STATUS" = "200" ] && [ -n "$HISTORY_LOG_LINE_COUNT" ] && [ "$HISTORY_LOG_LINE_COUNT" -gt 0 ] && [ "$HISTORY_HAS_FIXTURE_LOG" = "true" ] && [ "$HISTORY_HAS_ERROR_LOG" != "true" ] 2>/dev/null && echo true || echo false)"

SSE_HEADERS=$(mktemp)
SSE_STATUS=$(curl -s -o /dev/null -D "$SSE_HEADERS" -w '%{http_code}' --max-time 1 "$LH/projects/$PROJECT_ID/logs/stream" 2>/dev/null) || true
SSE_CONTENT_TYPE=$(tr -d '\r' < "$SSE_HEADERS" | awk -F': *' 'tolower($1)=="content-type" {print tolower($2); exit}')
rm -f "$SSE_HEADERS"
assert "logs stream is reachable as SSE live stream" \
  "$([ "$SSE_STATUS" = "200" ] && [[ "$SSE_CONTENT_TYPE" == text/event-stream* ]] && echo true || echo false)"

# ── Step 8: Stop project ──
echo "Step 8: Stop project"
api_call POST "$LH/projects/$PROJECT_ID/stop"
STOP_OK=$(echo "$RESP_BODY" | jq -r '.success' 2>/dev/null) || true
assert "POST /projects/:id/stop returns success" \
  "$([ "$STOP_OK" = "true" ] && echo true || echo false)"

# ── Step 9: Verify stopped ──
echo "Step 9: Verify project is stopped"
STOPPED=false
for i in $(seq 1 20); do
  PJSON=$(curl -s "$LH/api/projects" 2>/dev/null) || true
  STATUS=$(echo "$PJSON" | jq -r ".[] | select(.id==$PROJECT_ID) | .status" 2>/dev/null) || true
  if [ "$STATUS" = "stopped" ]; then
    STOPPED=true
    break
  fi
  sleep 2
done
assert "project status is stopped" "$STOPPED"

# ── Step 10: Delete project ──
echo "Step 10: Delete project"
api_call DELETE "$LH/projects/$PROJECT_ID"
assert "DELETE /projects/:id returns 200" \
  "$([ "$RESP_STATUS" = "200" ] && echo true || echo false)"

# Verify gone
api_call GET "$LH/api/projects"
GONE_COUNT=$(echo "$RESP_BODY" | jq '[.[] | select(.name=="e2e-fixture")] | length' 2>/dev/null) || true
assert "project no longer in API" "$([ "$GONE_COUNT" = "0" ] && echo true || echo false)"

# ── Summary ──
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
