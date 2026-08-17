> Unable to create `REVIEW_G3.md`: the read-only sandbox rejected the write. Review content follows.

# G3 Code Review

VERDICT: REWORK

## FINDINGS

1. **BLOCKER · apps/server/src/routers/async/index.ts:11 · Verified** · The async tRPC formatter (`packages/trpc/src/async/init.ts:12`) drops `error.cause.data`. Disabled async procedures serialize FORBIDDEN without the required module ID. Fix the formatter to preserve the same structured payload as lambda and add an HTTP-level assertion.

2. **BLOCKER · apps/server/src/routers/lambda/index.ts:120 · Verified** · Root routers are gated, but direct server tool runtimes remain usable: `serverRuntimes/knowledgeBase.ts:14`, `serverRuntimes/memory.ts:854`, and `serverRuntimes/webBrowsing.ts:10` execute without hot module checks. Stored or crafted agent calls can bypass disabled modules. Add `assertModuleEnabled` at the runtime boundary and test rejection before side effects.

3. **BLOCKER · apps/server/src/featureFlags/index.ts:66 · Verified** · The upstream function was structurally rewritten, violating rule 4. Restore its original control flow and apply `applyDisabledModuleFeatureFlagOverrides(await getMergedFeatureFlags(...))` as a one-line wrapper at the public call site.

4. **BLOCKER · apps/server/src/services/search/impls/index.ts:22 · Verified** · The upstream provider factory was replaced wholesale by a loader registry, cache, and proxy. This violates rule 4. Move lazy machinery into a fork-owned helper and retain only mechanical replacements here, or leave the fan-out unchanged.

5. **MAJOR · apps/server/src/enterprise/guards/enterpriseErrors.ts:43 · Verified** · The author claims this edit and `packages/const/src/platform/errorCodes.ts:44`, but both are exclusively owned by G1. This risks conflicting canonical error contracts. Have G1 land or explicitly coordinate these changes.

6. **MAJOR · apps/server/src/enterprise/services/branding/assetStorage.ts:4 · Verified** · The eager-import work is incomplete. The measured boot graph still statically imports `sharp` through branding; `services/aiAgent/ingestAttachment.ts:3` also remains static, as does XLSX at `packages/eval-dataset-parser/src/parsers/xlsx.ts:1`. Apply local dynamic imports where signatures permit and use the G0-approved lazy boundary for synchronous cases.

7. **MAJOR · apps/server/src/services/search/impls/index.ts:30 · Verified** · No scoped test exercises the new lazy provider factory. Existing search tests mock the factory or import providers directly. Add tests for no evaluation-time import, provider mapping/fallback, concurrent import-once behavior, and Search1API auto-engine behavior.

## METRICS

- Files reviewed: 13 changed/untracked scoped files, plus contextual reads for formatters, tool runtimes, and boot imports.
- Upstream files touched:
  - `apps/server/src/routers/lambda/index.ts` — obeys rule 4.
  - `apps/server/src/routers/async/index.ts` — obeys rule 4, but has the error-contract blocker.
  - `apps/server/src/routers/tools/index.ts` — obeys rule 4.
  - `apps/server/src/routers/mobile/index.ts` — obeys rule 4.
  - `apps/server/src/featureFlags/index.ts` — **violates rule 4**.
  - `apps/server/src/services/search/impls/index.ts` — **violates rule 4**.

## UNVERIFIED

- Vitest was not run, as instructed.
- Type correctness is unverified. The first `tsgo` attempt tried to write `tsconfig.tsbuildinfo` and reported an unrelated existing error at `src/components/mdx/Image.tsx:34`; the non-incremental attempt did not finish within the review window.
- Live routing, serialized HTTP responses, standalone boot behavior, import-once behavior, and RSS/chunk reduction were not executed.