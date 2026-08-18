# G5c — rework after codex review (REVIEW_G5.md). Same tree, you are still G5.

Review: /Users/konata/code/AIHub-worktrees/slim2/audit/slim-2026-08-17/phase2/reviews/REVIEW_G5.md — accepted.

BLOCKER: the final image must keep BusyBox and every applet name that the old image had (`/bin/sh` for `child_process.exec`,
`grep`/`which`/`ls`… used by `apps/server/src/services/mcp/deps/**`, `heterogeneous-agents/src/spawn/**` (cli spawn resolves commands),
`local-file-shell`, `generation/video.ts`). Do it without the hard-link explosion:
1. In the app-stage assembly: `cp -a /bin/busybox /layer-a/bin/busybox` (plus node + proxychains as now), then recreate every applet as a
   SYMLINK: `for a in $(/bin/busybox --list); do [ -e "/layer-a/bin/$a" ] || ln -s busybox "/layer-a/bin/$a"; done` (busybox resolves
   applets by argv[0], symlinks work). Do NOT `cp -al /bin` (explodes). Keep everything else from Round 2.
2. Rebuild (`aihub:p5-4`), then in the final image as user nextjs: `node -e "require('child_process').exec('node --version && which grep && sh -c \"echo ok\"', (e,o,s)=>{console.log(e,o,s)})"`
   → no error; `test -L /bin/sh && ls -la /bin | wc -l` ≈ old applet count; re-run the export parity diff (only the two pruned skia
   copies may differ now) and the previous nextjs proofs (mkdtemp, canvas/sharp/ffmpeg, curl-impersonate). Comment-only rebuild → layer-a
   CACHED again; report image size (symlinks are ~0 bytes; expect ≈ Round 2 size).
3. Update `phase2/reports/G5.md` "Round 3" (applet count, size, digests, proofs). Final message: 5 lines.
