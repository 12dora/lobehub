# Code review — "slim" phase 2 (deployment slimming, round 2), package: {{PKG}}

You are a senior reviewer (read-only sandbox; you cannot run vitest — say "unverified" where you would need to). Repo:
/Users/konata/code/AIHub-worktrees/slim2, branch feat/slim-phase2. Review ONLY the diff of the files listed below (uncommitted
working-tree changes vs HEAD): `git diff HEAD -- <files>` and `git status --short` for untracked files in those paths. Other agents'
uncommitted changes in other files are NOT in scope (ignore them, even if `git status` shows them).

Batch rules the code must obey (violations are BLOCKER):
1. Behaviour when nothing is configured must be byte-for-byte today's behaviour (default = full, everything on).
2. Upstream files (outside apps/server/src/enterprise, src/enterprise, packages/const/src/platform, packages/types/src/platform,
   packages/database/src/{schemas,models}/platform, docker-compose/enhanced, docs/enterprise, plugins/vite fork files,
   src/libs/next/config/docker*.ts) may only receive one-line guards / replacements / a wrapper-memo / a batch helper called from one
   place / `await import()` swaps — flag any restructuring or reformatting.
3. Every cache has TTL and/or explicit invalidation (identity/content-addressed memos are fine — do not demand a TTL for those).
4. Routers always mounted (never conditional); workers start only from `enterprise/bootstrap/workersBootstrap.ts` and honour the boot
   module view; a disabled module's job type / runtime must never be claimed or loaded.
5. No new tRPC procedures / no registry count changes unless the brief says so; no locale keys added by non-commander agents.
6. Lazy seams: the light identifier/manifest must come from the light package root, never from the heavy module (else the graph stays
   eager); concurrent first calls must not double-initialise; the gate must run BEFORE the import.

What to look for (in priority): correctness bugs & regressions on the default path; semantics drift in folded workers (lease/ttl/retry/
concurrency/ordering per job type); lost error isolation (one handler failing stops others); race conditions (batch claim, memo
invalidation, visibility gate vs restart convergence); type errors (reason about them; `bunx tsgo --noEmit -p tsconfig.json` if the
sandbox permits); circular imports introduced by new fork files; missing tests for the new branch; Docker: layer split that silently
loses files / breaks `require.resolve` of native modules / removes something referenced at runtime; bundle: React.lazy swaps that
change first-paint behaviour or Suspense boundaries; PWA precache narrowing that breaks offline shell.
Do NOT report style nits, naming, or "could be more generic". Do NOT propose redesigns beyond the batch rules.

Files in scope for {{PKG}}:
{{FILES}}

Package brief (what the author was asked to do): {{BRIEF_PATH}}
Author's report: {{REPORT_PATH}}

Output (Markdown, ≤150 lines) — print it as your final message (the sandbox cannot write files):
- VERDICT: PASS | REWORK (REWORK iff ≥1 BLOCKER or ≥3 MAJOR)
- FINDINGS: numbered; each = severity (BLOCKER/MAJOR/MINOR) · file:line · what is wrong · why it matters · concrete fix. Verified
  vs unverified tag.
- METRICS: files reviewed, upstream files touched (list) and whether each touch obeys rule 2.
- UNVERIFIED: what you could not check.
