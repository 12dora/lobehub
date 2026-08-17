# Code review — "slim" batch (deployment slimming / optional modules), package: G2

You are a senior reviewer (read-only sandbox; you cannot run vitest — say "unverified" where you would need to). Repo:
/Users/konata/code/AIHub-worktrees/slim, branch feat/slim-modules. Review ONLY the diff of the files listed below (uncommitted
working-tree changes vs HEAD): `git diff HEAD -- <files>` and `git status --short` for untracked files in those paths.

Batch rules the code must obey (from the commander's COMMON_RULES; violations are BLOCKER):
1. Every module defaults ON; env can only disable; missing DB row = all ON (never fail closed).
2. tRPC routers are always mounted; disabled ⇒ `PLATFORM_MODULE_DISABLED` (FORBIDDEN, data.moduleId), never NOT_FOUND / conditional mount.
3. Boot view (`initBootModules/getBootModules`) is frozen per process; hot view (`getModuleSettingsSnapshot/isModuleEnabled`) is cached
   ≤30s with cross-instance invalidation. Boot facilities (workers/gateway/subprocess/eager imports) use the boot view only.
4. Upstream files (outside apps/server/src/enterprise, src/enterprise, packages/const/src/platform, packages/types/src/platform,
   packages/database/src/{schemas,models}/platform, docker-compose/enhanced, docs/enterprise) may only receive one-line guards /
   replacements / a wrapper-memo / `await import()` swaps — flag any restructuring or reformatting.
5. Behaviour when nothing is configured must be byte-for-byte today's behaviour.
6. No RBAC changes tied to modules. No unbounded caches; every cache has TTL + invalidation.
7. Contract files: packages/const/src/platform/modules.ts and apps/server/src/enterprise/services/moduleSettings/index.ts export
   names must be preserved.

What to look for (in priority): correctness bugs & regressions on the default path; type errors (use the project's tsconfig —
`bunx tsgo --noEmit -p tsconfig.json` is allowed if the sandbox permits, else reason about types); circular imports introduced by new
fork files (e.g. moduleSettings ↔ featureFlags ↔ platformPermission); async/ordering bugs (boot view read before init; lazy router
resolution races); missing tests for the new branch; error shape mismatches vs the client mapper; migration idempotency & journal
`when` ordering; security (module gate bypass via alternate paths — mobile/async/tools routers, webapi); i18n key parity.
Do NOT report style nits, naming, or "could be more generic". Do NOT propose redesigns beyond the batch rules.

Files in scope for G2:
The file set owned by G2 in audit/slim-2026-08-17/prompts/COMMON_RULES.md ("Ownership" section) plus every file listed in the author's report. Use `git status --short` and `git diff HEAD -- <paths>` in the repo to see them; new files are untracked (read them whole).

Package brief (what the author was asked to do): audit/slim-2026-08-17/prompts/G2_boot_gates.md
Author's report: audit/slim-2026-08-17/reports/G2.md

Output (Markdown, ≤150 lines) to the path given on the command line:
- VERDICT: PASS | REWORK (REWORK iff ≥1 BLOCKER or ≥3 MAJOR)
- FINDINGS: numbered; each = severity (BLOCKER/MAJOR/MINOR) · file:line · what is wrong · why it matters · concrete fix. Verified
  vs unverified tag.
- METRICS: files reviewed, upstream files touched (list) and whether each touch obeys rule 4.
- UNVERIFIED: what you could not check.

Return the complete review as your final message (the sandbox is read-only; do not try to write files).
