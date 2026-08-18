VERDICT: PASS

## FINDINGS

1. **MAJOR** · `src/enterprise/client/providers/useEnterprisePlatformData.ts:42` · **[VERIFIED]** `focusThrottleInterval` and the public-snapshot `dedupingInterval` are both 60 seconds. SWR suppresses focus revalidation until `mount/request + focusThrottleInterval`, while dedupe can suppress the request independently. A tab hidden and restored within that window therefore remains stale until the newly started 120-second timer fires, contradicting the required immediate refocus refresh. This can leave branding, module state, and managed-resource enforcement stale for two minutes. Reduce both burst windows to a short value such as the existing 2-second dedupe, and add a real-SWR hidden→visible test within 60 seconds asserting exactly one refetch per resource.

2. **MAJOR** · `src/enterprise/client/features/admin/modules/useAdminModules.ts:109` · **[VERIFIED]** The restart gate is checked only before `await service.get()`. If the tab becomes hidden while that request is in flight, a converged response still calls `refreshAdminModules()` at line 122, causing another request while hidden; a pending/error response also burns hidden time before parking. Additionally, the loop checks visibility only, so it continues polling and exhausts its timeout while visible but offline. This violates the hidden/full-gate promise and can produce a spurious restart failure. Track visibility/online state for the complete accepted phase, recheck after every await before refreshing or scheduling, and defer work until the full gate reopens. Test with a deferred `get()` that resolves after hide/offline.

3. **MINOR** · `src/enterprise/client/features/admin/identityProviders/useIdentityProviders.ts:37` · **[VERIFIED]** Neither new identity-provider visibility branch has a consumer-level convergence test. Existing identity-provider tests mock these hooks, and `useVisiblePoll.test.tsx` only proves the interval changes; it does not prove that `testResult`, `onTerminal`, or auth-snapshot convergence resumes after refocus. Add hidden→visible fake-timer tests for both hooks, including terminal callback delivery.

## METRICS

- Files reviewed: **19** — 16 tracked modifications and 3 untracked additions.
- Upstream files touched: **none**. All scoped files are under `src/enterprise/**`; Rule 2 is not applicable.
- `git diff --check`: passed for tracked scoped changes.

## UNVERIFIED

- Vitest was not run, per the read-only sandbox constraint.
- Scoped type safety is unverified. `bunx tsgo --noEmit -p tsconfig.json` attempted to write `tsconfig.tsbuildinfo` and failed on unrelated out-of-scope type errors; no F6 path appeared in its diagnostics.
- Actual browser request counts and tRPC batching were not measured.