# F6 — P6 (client half): visibility-gated, slower, version-aware polling for the two platform-wide polls

Read /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/prompts/COMMON_RULES.md first (you are F6).
Then HANDOFF §1 P6: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/HANDOFF.md, and the referenced
`explore/E5_request_path.md` B5, `explore/E4_admin_setup.md` B8. REPO = /Users/konata/code/AIHub-worktrees/slim2.
(G2 does the server heartbeat merge; you do only the client.)

## Current state (verify)
- `src/enterprise/client/shared/pollIntervals.ts`: `publicSnapshot: 30_000` (anonymous `platform.getPublicSnapshot`),
  `capabilities: 60_000` (signed-in `platform.getCapabilities`), plus admin-page polls that are already gated on activity/module.
- Consumers: `src/enterprise/client/providers/**` (EnterprisePlatformProvider / useEnterprisePlatformData…), admin hooks. SWR via
  `@/libs/swr` (dedupe 2s since phase 1). Server caches the public snapshot 8s and capabilities read the 30s module snapshot.
- Goal (HANDOFF acceptance): an idle signed-in tab makes ≤3 requests in 5 minutes from these two polls; a hidden tab makes none.

## Do
1. Add `src/enterprise/client/shared/useVisiblePoll.ts` (or fold into an existing shared hook): returns the effective
   `refreshInterval` for a poll key — `0` when `document.visibilityState !== 'visible'` (subscribe to `visibilitychange`; also
   `online`/`offline` if cheap), the table value otherwise; SWR options `revalidateOnFocus: true` for the two platform polls so a
   tab that becomes visible refreshes once immediately (dedupe protects against bursts) and `revalidateIfStale` semantics unchanged.
2. Slow the two platform-wide polls: `publicSnapshot` 30s → 120s, `capabilities` 60s → 120s. Add a cheap "version-aware" short-circuit
   ONLY if it exists server-side already (does `getPublicSnapshot`/`getCapabilities` return a `revision`/`checksum`? If yes, use SWR
   `compare` so an unchanged payload does not re-render; do NOT add tRPC procedures or server fields).
3. Sweep every other `refreshInterval` in `src/enterprise/client/**` (grep) — any poll that is not already gated on visibility or a
   job in flight gets the visibility gate via the same hook. Do not touch upstream `src/**` outside `src/enterprise`. Keep the table
   in `pollIntervals.ts` as the single source of truth (add doc comments for the new gates).
4. Restart-convergence polls (`moduleRestart`, `identityProviderRestart`) must keep working while a restart is in flight even in a
   hidden tab? — No: user is watching those pages; gate them too, but make sure the "converged" state is picked up on refocus (test).
5. Tests: unit test for the hook (visibility toggling → interval 0/value, refocus triggers one revalidate), update provider tests
   (`src/enterprise/client/providers/*.test.tsx` — wrap in `<SWRConfig value={{ provider: () => new Map() }}>` as phase 1 did),
   `cd REPO && bun run check --test <files>`; lint. Manual verification: count requests in 5 idle minutes with a mocked timer test
   (fake timers advancing 5 min → assert ≤3 fetcher calls per poll) rather than a real browser.

Report → REPO/audit/slim-2026-08-17/phase2/reports/F6.md (≤80 lines): table of every poll (key → before → after → gate), tests, and
the computed idle request count / 5 min for a visible tab and a hidden tab.
