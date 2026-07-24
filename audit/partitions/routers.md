## Partition: routers

Scope reviewed: `apps/server/src/enterprise/routers/**`
Files examined: 58 TypeScript files (30 source, 28 tests; no TSX), totaling 15,280 lines

### Summary

The admin authorization surface is structurally strong: all 188 admin procedures are represented in the authorization registry, all 103 mutations are represented in the mutation-policy registry, and the reconciliation tests require exactly one permission gate per procedure. The largest risk is `admin.stats`, which returns unredacted cross-user message metadata capable of containing local-file and tool-result snapshots. User-facing managed Skills, AI, and Connector procedures also omit the active-user revocation guard used by the equivalent managed-Agent surface. Additional weaknesses include non-atomic audit writes, unbounded remote imports and statistics responses, feature-flag leakage, permissive date validation, and important untested failure paths.

### Findings

#### \[CRITICAL] Global usage statistics expose cross-user local-file and tool-result snapshots

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:95`
- **Problem:** Both usage procedures return database-model objects directly and define no output schema or redaction boundary. The returned `metadata` field can contain local-system tool snapshots, including file contents, tool arguments, results, state, and errors.
- **Evidence:** The router returns `model.findByMonth(input?.mo)` verbatim. `PlatformGlobalStatsModel.findByDateRange` selects and returns `messages.metadata`; `MessageMetadataSchema` permits `localSystemToolSnapshots`, whose shape includes `content`, `arguments`, and `result`.
- **Impact / failure scenario:** A principal granted only `STATS_READ` can call `usageFindByMonth` and retrieve local files or other sensitive tool outputs captured in every user's assistant-message metadata. This crosses the intended analytics boundary and may disclose credentials, proprietary source code, or private documents.
- **Recommendation:** Introduce a strict usage output schema and construct a whitelist projection containing only fields required by the statistics UI. Exclude raw metadata, snapshots, lineage, tool arguments/results, and other provenance fields. Add a regression test that seeds a distinctive secret in `localSystemToolSnapshots` and proves it is absent from both usage responses.

#### \[HIGH] Managed Skills, AI, and Connector endpoints bypass user revocation

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/routers/user/connectors.ts:21`; `apps/server/src/enterprise/routers/platformSkills.ts:27`; `apps/server/src/enterprise/routers/platformSkills.ts:48`; `apps/server/src/enterprise/routers/platform.ts:51`
- **Problem:** These independently enabled user-facing enterprise surfaces use only `authedProcedure` or `wsCompatProcedure` plus database middleware. They omit the active-user guard that rejects banned, temporarily banned, and security-epoch-invalidated principals.
- **Evidence:** `userConnectorProcedure = authedProcedure.use(serverDatabase)...`; Skills use `authedProcedure` and `wsCompatProcedure`, while AI catalog uses `authedProcedure`. In contrast, `platformAgents.ts:15-21` explicitly applies `withActiveUser({ enforceWhenAdminDisabled: true })` because managed surfaces can remain enabled when platform admin is off. `wsCompatProcedure` is only an alias of `authedProcedure`.
- **Impact / failure scenario:** With `ENABLE_PLATFORM_ADMIN=0` and managed Connectors or Skills enabled, a banned user retaining an otherwise valid session can list managed connectors, start OAuth authorization, disconnect bindings, read the managed skill catalog, and mint operation-bound skill proofs. A revoked user can similarly read the published managed-AI catalog.
- **Recommendation:** Add feature-specific active-user middleware for managed Connectors, Skills, and AI, analogous to `withActiveUserWhenManagedAgents`, and place it before service/catalog access. Preserve flag-off behavior by enforcing only when the corresponding managed-resource flag is enabled. Add banned, temporary-ban, and epoch-invalidation tests with the admin flag disabled.

#### \[HIGH] Registration and sidebar mutations can commit without required audit records

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/routers/admin/authSettings.ts:36`; `apps/server/src/enterprise/routers/admin/sidebarLayout.ts:36`
- **Problem:** Both procedures commit their configuration update before appending the audit record, then intentionally swallow any audit failure. This contradicts the policy registry, which marks their audit control as enforced.
- **Evidence:** Each router executes `model.update(...)`, then wraps `PlatformAuditService.append(...)` in `try/catch {}` with the comment `Audit is best-effort and never blocks the settings write.` The mutation registry supplies the default enforced control: `Service persists a sanitized platform audit outcome.`
- **Impact / failure scenario:** If audit storage is unavailable, an administrator can enable open registration, alter the email-domain allowlist, or impose a global sidebar layout; the API reports success and the change takes effect with no durable audit trail.
- **Recommendation:** Perform the configuration mutation and success audit in one database transaction. If the audit cannot be persisted, roll back and return a stable failure. Add failure-injection tests proving audit failure cannot produce an unaudited committed change.

#### \[HIGH] Remote skill imports have neither a body deadline nor a streaming size limit

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/routers/admin/skillsImportParse.ts:185`
- **Problem:** The 30-second timeout covers only receipt of response headers and is cleared before the body is consumed. The procedure then materializes the entire response through `response.arrayBuffer()` or `response.text()` before checking content size; remote ZIPs receive no equivalent of the uploaded-ZIP pre-decode limit.
- **Evidence:** `clearTimeout(timeoutId)` runs at lines 209-210, followed by `Buffer.from(await response.arrayBuffer())` at line 231 or `parser.parseSkillMd(await response.text())` at line 243. The 1 MB content check occurs later in `buildOutput`; only uploaded base64 ZIPs receive the early 20 MB guard at lines 251-257.
- **Impact / failure scenario:** A server controlled by an administrator or attacker returns headers immediately and then streams an unbounded or indefinitely slow body. Each `parseImportSource` call can retain a worker, socket, and growing buffer, allowing memory exhaustion or request starvation despite the nominal timeout and mutation rate limit.
- **Recommendation:** Keep an abort deadline active through body consumption, reject oversized `Content-Length` values, and consume the body through a byte-counting stream that aborts once the applicable text/ZIP cap is exceeded. Enforce compressed and expanded ZIP limits for URL and GitHub imports. Test oversized chunked responses without `Content-Length` and bodies that stall after headers.

#### \[HIGH] Usage endpoints return an unbounded platform-wide month of message rows

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:95`
- **Problem:** `usageFindByMonth` and `usageFindAndGroupByDay` expose no cursor, page size, record cap, or aggregation-only mode. The backing query loads every assistant message for the month, joins users, sorts all rows, and returns full record arrays.
- **Evidence:** Both procedures accept only `{ mo?: string }` and directly return the model result. The backing `findByDateRange` query has no `limit` or cursor, while `findAndGroupByDay` first materializes the same complete row collection and embeds every row under daily `records`.
- **Impact / failure scenario:** On a large tenant with millions of assistant messages per month, opening the admin statistics page can allocate and serialize the full result twice, produce a very large response, and cause database sorting pressure, process memory exhaustion, gateway timeouts, or browser failure.
- **Recommendation:** Add bounded cursor pagination to the detailed usage endpoint. Compute chart totals and daily aggregates in SQL without returning per-message records; fetch detail rows only for the selected page/day. Define explicit output schemas and load-test a high-volume month.

#### \[MEDIUM] Invalid statistics dates silently widen or substitute the query

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:22`
- **Problem:** Month and date filters accept arbitrary strings. Invalid count dates are silently discarded by the database helper, while an invalid month silently selects the current month.
- **Evidence:** Inputs use `mo: z.string()`, `startDate: z.string()`, `endDate: z.string()`, and tupled strings without refinement. The backing date helpers return `undefined` for invalid dates, and `resolveMonthRange` falls back to the current month when strict `YYYY-MM` parsing fails.
- **Impact / failure scenario:** A request such as `{ range: ["not-a-date", "also-invalid"] }` to `countMessages` produces the all-time count rather than `BAD_REQUEST`. `{ mo: "2026-99" }` returns current-month usage, which the caller may label as the requested period.
- **Recommendation:** Validate months semantically as `YYYY-MM`, validate dates as ISO dates, reject reversed ranges, and map validation failures to `BAD_REQUEST`. Add tests for malformed, impossible, reversed, and boundary-date inputs.

#### \[MEDIUM] Sidebar policy remains active when enterprise flags are closed

- **Dimension:** 5 / Potential frontend/backend functional bugs
- **Location:** `apps/server/src/enterprise/routers/platform.ts:108`
- **Problem:** `getSidebarLayout` reads and applies the persisted platform policy without checking any enterprise feature flag. Consequently, stale platform-managed state remains user-visible after the admin feature is disabled.
- **Evidence:** The procedure always runs `PlatformSidebarLayoutModel(...).get()` and returns `managed: policy.mode === 'platform'`. The client hook fetches this procedure directly and hides customization or reorders sections whenever `managed` is true.
- **Impact / failure scenario:** An operator configures platform mode, then disables `ENABLE_PLATFORM_ADMIN` while retaining an unrelated enterprise feature—or closes all flags while a client still reaches the hook. Users continue seeing centrally reordered sections and hidden customization controls, violating the requirement that a closed enterprise flag not alter user-visible behavior.
- **Recommendation:** When the controlling flag is off, return `DEFAULT_SIDEBAR_LAYOUT_POLICY` without reading persisted policy. Gate the client hook on the same capability and add a regression test with a stale platform-mode row and all relevant flags disabled.

#### \[MEDIUM] Skill-import failures render hardcoded English to Chinese users

- **Dimension:** 4 / Missing simplified-Chinese i18n
- **Location:** `apps/server/src/enterprise/routers/admin/skillsImportParse.ts:122`
- **Problem:** The router sends prose English error messages as raw tRPC error messages. The client error wrapper falls back to displaying `cause.message` when no enterprise error code is mapped.
- **Evidence:** Examples include `Skill content exceeds the 1MB limit`, `Fetching the URL timed out after 30 seconds`, `Resource not found at ...`, and `ZIP file exceeds the 20MB limit`. The client toast fallback displays `cause.message`; although `aiSkillSettings.import.fetchFailed` has a hand-authored zh-CN translation, these raw errors do not use it.
- **Impact / failure scenario:** A zh-CN administrator importing an oversized ZIP, a missing URL, or a slow remote skill receives an English toast instead of localized copy.
- **Recommendation:** Return stable machine-readable enterprise error codes and bounded details from the router. Map them to `admin` namespace keys in the client and add matching English-source and hand-authored zh-CN entries for timeout, not-found, invalid ZIP, and size-limit cases.

#### \[MEDIUM] Critical router failure paths lack regression coverage

- **Dimension:** 2 / Test rot
- **Location:** `apps/server/src/enterprise/routers/admin/stats.ts:36`; `apps/server/src/enterprise/routers/admin/authSettings.ts:26`; `apps/server/src/enterprise/routers/admin/sidebarLayout.ts:26`; `apps/server/src/enterprise/routers/user/connectors.test.ts:27`; `apps/server/src/enterprise/routers/platformSkills.test.ts:65`
- **Problem:** There are no router tests for Stats, Auth Settings, or Sidebar Layout. Existing Connector and Skills tests cover authentication/feature behavior but not banned, temporary-ban, or epoch-invalidated callers.
- **Evidence:** Repo-wide test searches find no import or invocation of `adminStatsRouter`, `adminAuthSettingsRouter`, or `adminSidebarLayoutRouter`; the managed-user test files contain no banned/inactive/epoch cases. No skipped tests were found, but these security and failure paths are absent.
- **Impact / failure scenario:** Metadata redaction, date rejection, pagination limits, flag-off sidebar behavior, audit atomicity, and revocation enforcement can regress without failing the router suite—the current defects demonstrate that gap.
- **Recommendation:** Add named regression suites for: `admin.stats redacts sensitive metadata and paginates`; `admin.stats rejects invalid dates`; `authSettings/sidebarLayout roll back on audit failure`; `platform.getSidebarLayout defaults when disabled`; and `managed Skills/Connectors reject banned, temporary-banned, and epoch-invalid principals before service access`.

#### \[LOW] Three exported router aliases are unused repo-wide

- **Dimension:** 3 / Dead code & dev cruft
- **Location:** `apps/server/src/enterprise/routers/user/connectors.ts:99`; `apps/server/src/enterprise/routers/admin/connectors.ts:545`; `apps/server/src/enterprise/routers/admin/users.ts:300`
- **Problem:** The exported aliases `UserConnectorsRouter`, `AdminConnectorsRouter`, and `AdminUsersRouter` have no consumers.
- **Evidence:** Repo-wide exact-identifier searches return only their declaration lines; unlike `PlatformRouter`, none is re-exported from a barrel or imported by a client/server module.
- **Impact / failure scenario:** These aliases expand the apparent public API and create maintenance noise without providing type reuse. Future refactors may preserve them unnecessarily under the assumption that they are consumed.
- **Recommendation:** Remove the unused exports, or intentionally expose and consume them from the router type boundary if they are meant to be public.

#### \[LOW] AI catalog router test exceeds the repository file-size guideline

- **Dimension:** 1 / Code smells
- **Location:** `apps/server/src/enterprise/routers/admin/aiCatalog.test.ts:1`
- **Problem:** The test file is 804 lines, crossing the repository’s approximately 800-line code-smell threshold and combining several distinct concerns.
- **Evidence:** `wc -l` reports 804 lines; the next-largest in-scope tests are 779 and 678 lines.
- **Impact / failure scenario:** Provider, model, permission, publication, and secret-redaction scenarios become harder to navigate and more likely to accumulate shared setup or accidental coupling.
- **Recommendation:** Split the suite by behavior—provider/model CRUD, publication/revision handling, authorization, and secret redaction—while extracting only genuinely shared fixtures.

### Metrics

- Total findings: 11 (CRITICAL 1, HIGH 4, MEDIUM 4, LOW 2)
- Largest in-scope files (lines): `admin/aiCatalog.test.ts` 804; `admin/connectors.test.ts` 779; `admin/skills.test.ts` 678
- Dead-code candidates verified unused repo-wide: 3
