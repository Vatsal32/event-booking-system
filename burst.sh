#!/usr/bin/env bash
# One-command on-sale stampede against a running instance, using only its public API.
#
#   ADMIN_KEY=<key> ./burst.sh <BASE_URL>
#
# Runs five scenarios, each on a fresh show, and prints a PASS/FAIL line per scenario:
#   stampede  ~30% storm 5 hot seats, ~60% distinct seats, ~10% same-key retries
#   hot       many users racing for one seat (exactly one 201, everyone else 409)
#   limit     one user firing parallel reserves on a per_user_limit=4 show (at most 4 succeed)
#   idem      one user sending the same idempotency key many times (one reservation)
#   cancel    only the owner can cancel; a released seat is cleanly re-bookable
# Overridable: N (stampede size, 2000), HOT_N (500), CONCURRENCY (500), TIMEOUT_MS (30000).
# Exits non-zero if any scenario failed.
set -uo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
if [[ -z "$BASE_URL" ]]; then
  echo "usage: ADMIN_KEY=<key> ./burst.sh <BASE_URL>" >&2
  exit 2
fi
if [[ -z "${ADMIN_KEY:-}" ]]; then
  echo "error: set ADMIN_KEY (the admin key provided with the submission)" >&2
  exit 2
fi

cd "$(dirname "$0")"
if [[ ! -d node_modules ]]; then
  echo "installing dependencies..."
  pnpm install --frozen-lockfile || exit 2
fi

N="${N:-2000}"
HOT_N="${HOT_N:-500}"
CONCURRENCY="${CONCURRENCY:-500}"
TIMEOUT_MS="${TIMEOUT_MS:-30000}"

summaries=()
failed=0

run() {
  local name="$1"
  shift
  echo
  echo "################ $name ################"
  local out
  # --env /dev/null: use only what is passed here, never a local .env
  out="$(pnpm --silent load:reserve --url "$BASE_URL" --env /dev/null \
    --concurrency "$CONCURRENCY" --timeout "$TIMEOUT_MS" "$@" 2>&1)"
  local code=$?
  echo "$out"
  local summary
  summary="$(grep '^SUMMARY' <<<"$out" | tail -1)"
  summaries+=("${summary:-SUMMARY scenario=$name result=ERROR exit=$code}")
  [[ $code -eq 0 ]] || failed=1
}

run "stampede (N=$N)"      --mode stampede -n "$N"
run "hot seat (N=$HOT_N)"  --mode hot -n "$HOT_N"
run "per-user limit"       --mode limit -n 10 --limit 4
run "idempotent retries"   --mode idem -n 50
run "cancel / release"     --mode cancel

echo
echo "################ summary ################"
printf '%s\n' "${summaries[@]}"
if [[ $failed -eq 0 ]]; then
  echo "ALL PASS"
else
  echo "SOME SCENARIOS FAILED"
fi
exit $failed
