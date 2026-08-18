# G5b — commander rework (before codex review). Same tree, you are still G5.

Your two-layer split drops everything the old `COPY --from=app / /` shipped except `/bin/{node,proxychains}`, `/lib`, `/lib64`, `/usr`,
`/etc`, `/app`. Missing from the final image now (verified by reading the Dockerfile diff):
- `/tmp` (busybox ships it 1777). Node's `os.tmpdir()` is `/tmp`; document parsing, sharp, curl-impersonate config files, upload
  staging, the network-proxy engine and the peer session's cursor-agent per-turn scratch dir all `mkdtemp` there → ENOENT at runtime.
- `/opt` — the peer session's base-stage block installs `/distroless/opt/cursor-agent` which reaches the app stage via
  `COPY --from=base /distroless/ /` and must reach the final image too (`ENV CURSOR_AGENT_HOME=/opt/cursor-agent`).
- `/var`, `/home`, `/root`, `/run`, `/mnt`, `/srv`, `/sbin` … whatever busybox/base put at `/`.

## Do
1. In the app-stage assembly RUN, build layer-a as: every top-level entry of `/` EXCEPT `/app`, `/bin`, `/proc`, `/sys`, `/dev`,
   `/layer-a`, `/layer-b` (`for p in /* /.[!.]*; do case "$p" in …) continue;; esac; cp -a "$p" /layer-a/; done`), plus
   `/bin/node` and `/bin/proxychains` only (no busybox applets — keep your finding), plus `mkdir -m 1777 -p /layer-a/tmp` (busybox
   `cp -a` of /tmp keeps the mode; make sure the sticky bit survives — verify in the image with `stat`), plus `/app/node_modules`
   hard-linked as you did. layer-b = `/app` minus node_modules (unchanged).
2. Prove parity: `docker create` both `aihub:slim-final3` and the new image, `docker export | tar -tv` and diff the sorted list of
   top-level entries + modes/owners; the only allowed differences are the busybox applets and the two pruned skia copies. Put the diff
   summary in the report.
3. Runtime proof inside the new image, as user nextjs (`docker exec -u nextjs -w /app <ctr> node -e "..."`): `fs.mkdtempSync(os.tmpdir()+'/x')`
   succeeds; `require('@napi-rs/canvas')`, `require('sharp')`, `require('ffmpeg-static')` still OK; `test -x /usr/local/bin/curl-impersonate`.
   Rebuild twice (touch a comment) and re-confirm layer-a CACHED with identical digest.
4. Keep the Dockerfile diff confined to the app-stage tail + the two final COPYs. Tag `aihub:p5-3`. Update `phase2/reports/G5.md`
   with a "Round 2" section (parity diff, runtime proofs, layer digests). Final message: 6 lines.
