#!/usr/bin/env bash
# מריץ את כל המיגרציות + בדיקות אינטגרציה על Postgres מקומי זמני.
# דורש: postgresql (initdb, pg_ctl) ו-deno.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
TMP="$(mktemp -d)"
PORT="${PGPORT:-54329}"
trap '"$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

run_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
chmod 777 "$TMP"
run_pg "'$PGBIN/initdb' -D '$TMP/data' -U postgres -A trust >/dev/null"
run_pg "'$PGBIN/pg_ctl' -D '$TMP/data' -o '-p $PORT -k $TMP' -l '$TMP/log' start -w >/dev/null"

PSQL=(psql -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -f "$ROOT/tests/sql/supabase_shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ migration $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

deno run --allow-read "$ROOT/tests/adapters/print-canonical.ts" "$ROOT/tests/fixtures/hae-sample.json" > "$TMP/batch.json"
deno run --allow-read "$ROOT/tests/adapters/print-canonical.ts" "$ROOT/tests/fixtures/hae-sleep-segments.json" > "$TMP/batch2.json"
deno run --allow-read "$ROOT/tests/adapters/print-canonical.ts" "$ROOT/tests/fixtures/hae-cycle.json" Asia/Jerusalem true > "$TMP/batch3.json"

echo "→ integration tests"
"${PSQL[@]}" -v batch="$(cat "$TMP/batch.json")" -v batch2="$(cat "$TMP/batch2.json")" -f "$ROOT/tests/sql/ingest.test.sql"
"${PSQL[@]}" -v batch3="$(cat "$TMP/batch3.json")" -f "$ROOT/tests/sql/domain.test.sql"
echo "✓ all SQL tests passed"
