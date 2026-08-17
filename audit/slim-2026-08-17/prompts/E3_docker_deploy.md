# E3 — Docker image, build, external dependencies and deployment footprint

Read EXPLORE_RULES.md (same directory) first. Write the report to `../explore/E3_docker.md`.

Task: quantify the deployment footprint outside of the Node process itself and find the cheapest,
upstream-friendly ways to shrink it and to make dependencies optional.

## Measure
1. Image composition of `aihub:demo` (1.72GB): `docker history aihub:demo`, and inside a throwaway
   container (`docker run --rm --entrypoint sh aihub:demo -c '...'`, or `docker create` + `docker cp`):
   `du -sh /app/.next /app/node_modules /app/public /app/.next/server /app/.next/static ...`, top-30
   directories under `/app/node_modules` and `/app/.next/server/chunks` by size; native/binary deps
   (sharp, onnx, tiktoken wasm, playwright browsers?, python?, proxychains, mihomo pre-bundled?).
   Which of these are only needed by an optional module (map to E2's candidate list by name)?
2. Root `Dockerfile` (and any variants under `Dockerfile*` / `docker-compose/*/`): stages, what is
   copied, standalone output tracing (`outputFileTracingIncludes/Excludes` in `next.config.ts`),
   `serverExternalPackages`, `NODE_OPTIONS`/memory flags at runtime, and what `scripts/serverLauncher/startServer.js`
   + `docker.cjs` do at boot (migration run every start — cost?). Peak memory of `next build` /
   `build:spa` if it can be inferred from scripts (`--max-old-space-size`), because operators building
   on the target machine feel that too.
3. External dependencies matrix (compose `enhanced` and `deploy`): postgres (ParadeDB — which migration
   / query actually requires `pg_search` BM25 vs plain pgvector? grep migrations and
   `packages/database` for `pg_search`, `paradedb`, `@@@`, `bm25`, `vector`), redis (what breaks
   without REDIS_URL — feature flags provider, rate limits, caches, locks?), S3/rustfs (what breaks
   without S3 — file upload, avatars, audit export, branding assets, knowledge base), searxng (only
   web search?), minio/mc init, lkg-init. For each: is it already optional today (code path guarded by
   env presence)? typical idle RSS of the sidecar container (measure `docker stats` of the aihub-dev
   ones).
4. Runtime knobs already available in upstream that reduce load without code changes (e.g.
   `NODE_OPTIONS=--max-old-space-size`, disabling telemetry, `NEXT_PUBLIC_*`, `FEATURE_FLAGS`, disabling
   the messenger gateway auto-start, `PLATFORM_*` job intervals) — a table with defaults.

## Recommend
- A concrete tiered deployment shape (e.g. `minimal` = app + postgres(+pgvector) only; `standard` =
  + redis + s3; `full` = + searxng + moderation + network proxy …) with what each tier loses, and
  which env vars / compose profiles express it (`docker compose --profile`?). Say how first-run
  configuration could be persisted (env only vs DB-backed `platform_infra_settings`-style rows, which
  already exist for S3 / mail — cite the file).
- Image-size reductions that do not fight upstream (e.g. pruning locales, `.next/static` duplicates,
  dev deps leaking, tracing excludes) with an estimated MB each.
- Section D must list what NOT to change in the Dockerfile to keep upstream merges cheap.
