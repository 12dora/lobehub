#!/usr/bin/env bash
# Launch the 16-reviewer Codex fleet in parallel (read-only sandbox).
# Each reviewer's final report is captured to audit/round2/partitions/<name>.md
ROOT=/Users/konata/code/AIHub
cd "$ROOT" || exit 1
mkdir -p audit/round2/partitions audit/round2/logs
STATUS=audit/round2/logs/_status.tsv
: > "$STATUS"

launch_one () {
  local name="$1"
  local prompt_file="audit/round2/prompts/$name.txt"
  local start end rc
  start=$(date +%s)
  echo -e "START\t$name\t$(date +%H:%M:%S)" >> "$STATUS"
  codex exec \
    -m gpt-5.6-sol \
    -c model_reasoning_effort=high \
    --sandbox read-only \
    --skip-git-repo-check \
    --output-last-message "audit/round2/partitions/$name.md" \
    "$(cat "$prompt_file")" \
    > "audit/round2/logs/$name.log" 2>&1
  rc=$?
  end=$(date +%s)
  local bytes=0
  [ -f "audit/round2/partitions/$name.md" ] && bytes=$(wc -c < "audit/round2/partitions/$name.md" | tr -d ' ')
  echo -e "DONE\t$name\trc=$rc\tsecs=$((end-start))\tbytes=$bytes\t$(date +%H:%M:%S)" >> "$STATUS"
}

for p in audit/round2/prompts/*.txt; do
  name=$(basename "$p" .txt)
  launch_one "$name" &
  echo "launched $name pid=$!"
  sleep 1
done

wait
echo -e "ALL_DONE\t$(date +%H:%M:%S)" >> "$STATUS"
echo "ALL_DONE"
