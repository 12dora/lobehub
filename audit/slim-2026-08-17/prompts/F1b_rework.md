# F1b — Rework after review (admin modules UI)

Same tree /Users/konata/code/AIHub-worktrees/slim, you are still F1. Absolute paths:
- Rules: audit/slim-2026-08-17/prompts/COMMON_RULES.md
- Your brief/report: …/scratchpad/slim/prompts/F1_admin_modules_ui.md, …/scratchpad/slim/reports/F1.md
- Review: audit/slim-2026-08-17/reviews/REVIEW_F1.out.md

Adjudication — ACCEPT all ten findings; do exactly this:
1. F1: `useModuleEnabled` must fall back to `getBootModules()` while capabilities are unresolved / failed (distinguish "not loaded"
   from "loaded"; seed the fallback capability map from boot modules). Tests: pending fetch and failed fetch keep boot-disabled modules
   disabled.
2. F2: `UnifiedManagementPage` (`/admin/unified`) tabs gate on their modules (`settingsPolicy`, `managedAi`) with the same
   "never leave the admin on a hidden tab" fallback. Tests for both.
3. F3: initial-load error ⇒ error state + retry only (no switches / presets / Save). Test.
4. F4: only `PLATFORM_REVISION_CONFLICT` (check the exact code in `packages/const/src/platform/errorCodes.ts` / mapEnterpriseError)
   triggers reload+draft reset; other failures keep the draft and allow retry. Test.
5. F5: wizard completion goes through the same `onSave` path incl. `DangerConfirm` for audit/moderation. Test.
6. F6: summary memory shows「未测量」when no enabled module has `idleRssMb`, and preset comparisons of memory are suppressed when totals
   are incomplete (the commander will backfill measured numbers into `modules.ts` later; keep the UI honest either way).
7. F7: wizard infra step handles probe error before loading (error + retry, and do not block progression? — block "下一步" only while
   loading; on error allow skipping with a note). Test.
8. F8: guide dismissal in `sessionStorage` (shared key used by card and wizard exit).
9. F9: restart `reason` tokens rendered through i18n (`modules.restart.reason.<token>` keys; add en/zh targeted inserts; unknown token
   → generic text), plus the env hint.
10. F10: single source for poll intervals: move `ADMIN_POLL_INTERVALS` to a shared layer importable by the provider (e.g.
    `src/enterprise/client/shared/pollIntervals.ts`) and derive the provider's two literals from it; keep the existing test.
11. Verify (`bun run .agents/scripts/check/cli.ts --lint --test <files>` + targeted vitest); locale parity test green; append "Round 2"
    to …/scratchpad/slim/reports/F1.md. Final message: 10 lines.
