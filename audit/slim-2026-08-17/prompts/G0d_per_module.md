# G0d — per-module memory attribution (to fill `cost.idleRssMb` in packages/const/src/platform/modules.ts)

Same spike worktree (/Users/konata/code/AIHub-worktrees/spike), same harness, use your LAST build (experiment C+D: all-lazy +
preloadEntriesOnStart:false) — no rebuild. A machine-wide Docker build is running concurrently; RSS numbers are unaffected, timings
may be noisy (ignore timings).

For each module below, boot the standalone server twice with `LOBE_MODULES_DISABLED=<id>` (everything else default/full), wait
Ready + 20 s, then run the "typical session" burst you used in G0c (unauthenticated calls are fine) + `platform.getPublicSnapshot`,
wait 10 s, sample `process.memoryUsage().rss/heapUsed`. Compare with the same procedure with NO module disabled (2 boots) —
`delta = baseline − disabled` (MB, median of 2). Modules: bots, networkProxy, audit, managedConnectors, managedAgents, moderation,
chatgptWeb, agentSignal, databaseIdp, managedAi, imageGen, knowledgeBase, webSearch, memory, market, taskTemplates,
platformStats, branding, settingsPolicy, managedSkills, speech, workflows, sandbox, deviceGateway (24 boots + 2 baseline; ~40 s
each). Note: with all routers lazy most `hot` modules will show ≈0 at rest — that is the correct answer; also record for each whether
its worker was skipped (`[modules] worker … skipped`).

Report → audit/slim-2026-08-17/explore/G0d_per_module.md
(≤80 lines): a table module → RSS delta MB (rest, after burst) → heap delta → worker skipped? → note. Round to whole MB; values
within ±3 MB of noise report as 0. Final message = the table.
