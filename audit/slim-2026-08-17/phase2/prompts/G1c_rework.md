# G1c — round-3 rework after REVIEW_G1_round2.md. Same tree, you are still G1.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G1_round2.md — one BLOCKER, accepted:
- Restore `packages/builtin-tool-remote-device/src/types.ts` and `src/ExecutionRuntime/types.ts` to HEAD (`git checkout -- <file>` for those two
  only, if types.ts existed at HEAD; otherwise delete the moved block and put the declarations back where they were). Keep the light
  `./manifest` / `./systemRole` subpaths, but reference `DeviceAttachment` via `import type { DeviceAttachment } from './ExecutionRuntime/types'`
  (type-only imports are erased — no runtime edge). Verify with the E1 scanner that the remote-device ExecutionRuntime is still NOT reachable
  from the `serverRuntimes/index.ts` root; rerun `bun run check --lint` on the touched files and the toolExecution tests.
Update phase2/reports/G1.md "Round 3". Final message: 3 lines.
