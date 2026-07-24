#!/usr/bin/env bash
# Run grok(high) fix batches in parallel. Usage: grok_run.sh <batch1> <batch2> ...
# Each grok edits ONLY its owned paths (disjoint write-sets) in the main working tree.
ROOT=/Users/konata/code/AIHub
cd "$ROOT" || exit 1
FIX="$ROOT/audit/round2/fix"
STATUS="$FIX/logs/_rework2_status.tsv"
mkdir -p "$FIX/logs"
: > "$STATUS"

run_one () {
  local name="$1"
  local pf="$FIX/prompts/rework2/$name.txt"
  local start end rc
  start=$(date +%s)
  echo -e "START\t$name\t$(date +%H:%M:%S)" >> "$STATUS"
  grok -p "$(cat "$pf")" \
    -m grok-4.5 \
    --reasoning-effort high \
    --always-approve \
    --no-leader \
    --cwd "$ROOT" \
    > "$FIX/logs/$name.rework2.log" 2>&1
  rc=$?
  end=$(date +%s)
  echo -e "DONE\t$name\trc=$rc\tsecs=$((end-start))\t$(date +%H:%M:%S)" >> "$STATUS"
}

for name in "$@"; do
  run_one "$name" &
  echo "launched grok:$name pid=$!"
  sleep 1
done
wait
echo -e "ALL_DONE\t$(date +%H:%M:%S)" >> "$STATUS"
echo "ALL_DONE"
