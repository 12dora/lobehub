#!/usr/bin/env bash
# Codex(high) read-only verification that each partition's findings are correctly FIXED in the working tree.
# Usage: verify_run.sh <partition1> <partition2> ...
ROOT=/Users/konata/code/AIHub
cd "$ROOT" || exit 1
FIX="$ROOT/audit/round2/fix"
STATUS="$FIX/logs/_verify_status.tsv"
mkdir -p "$FIX/verify/reports" "$FIX/logs"
: > "$STATUS"

PREAMBLE='You are an INDEPENDENT reviewer verifying that a set of code-audit findings were CORRECTLY FIXED in the current working tree of the AIHub enterprise 二开 layer. The fixes are UNCOMMITTED — inspect them with `git diff` (read-only) and by reading the current files.

For partition "%s":
1. Read audit/round2/partitions/%s.md (the findings, each with its evidence + intended Fix).
2. Read audit/round2/fix/verify/%s.verified.txt (the VERIFIED severity/scope — prioritize CRITICAL/HIGH; a MEDIUM/LOW may be fixed more lightly).
3. Inspect the ACTUAL fix: run `git diff -- <relevant paths>` and read the changed files + their tests.
4. For EVERY finding in the report, judge whether the working tree now correctly fixes it. Watch for: the fix being absent, the fix being wrong/incomplete, a NEW bug or type error introduced, a test changed to pass without asserting the corrected behavior, or a security fix that still has a hole.

You are READ-ONLY. Do NOT modify files. Do NOT run the full test suite or build. You MAY read anything and run read-only git/grep.

OUTPUT (your final message, captured verbatim — start directly, no preamble): a compact Markdown table, one row per finding:
| Finding | Verified Sev | Fix status | Note |
Fix status is one of: FIXED_OK | PARTIAL | NOT_FIXED | REGRESSION | N/A (deferred refactor).
Then a final line: `VERDICT: <clean | needs-rework>` and, if needs-rework, a bulleted list of the exact finding IDs needing rework with a one-sentence corrective instruction each (this feeds the grok rework pass).'

run_one () {
  local p="$1" start end rc
  start=$(date +%s)
  echo -e "START\t$p\t$(date +%H:%M:%S)" >> "$STATUS"
  local prompt; prompt=$(printf "$PREAMBLE" "$p" "$p" "$p")
  codex exec -m gpt-5.6-sol -c model_reasoning_effort=high --sandbox read-only --skip-git-repo-check \
    --output-last-message "$FIX/verify/reports/$p.fixcheck.md" \
    "$prompt" > "$FIX/logs/$p.verify.log" 2>&1
  rc=$?
  end=$(date +%s)
  echo -e "DONE\t$p\trc=$rc\tsecs=$((end-start))\t$(date +%H:%M:%S)" >> "$STATUS"
}

for p in "$@"; do
  run_one "$p" &
  echo "verify launched: $p pid=$!"
  sleep 1
done
wait
echo -e "ALL_DONE\t$(date +%H:%M:%S)" >> "$STATUS"
echo "ALL_DONE"
