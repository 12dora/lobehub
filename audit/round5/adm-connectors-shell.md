# Round 5 Audit — adm-connectors-shell

## Scope

Audited the 103 fork-owned files under:

- `src/enterprise/client/features/admin/{connectors,overview,stats,primitives,layout,pages,unified,i18n}`
- `src/enterprise/client/features/admin/index.ts`
- `src/enterprise/client/routes`
- `src/enterprise/client/registry.ts` and its tests
- `src/enterprise/client/providers`
- `src/enterprise/client/services/{adminConnectors,adminStats,platform}.ts` and assigned tests

Relative to `4bab1636408e60a7ee17b640490fbf33a310a325`, all 103 files are additions, totaling 10,871 inserted lines. No in-scope files were excluded as upstream-identical. Shared stats renderers and server code were read only to verify data flow; no out-of-scope defects are reported. This was a static, read-only audit; no test or formatting commands were run.

## Summary

| Dimension                                             | Findings | Highest severity |
| ----------------------------------------------------- | -------: | ---------------- |
| D1 Code smells                                        |        1 | LOW              |
| D2 Test decay                                         |        2 | MEDIUM           |
| D3 Dead code and development debris                   |        1 | LOW              |
| D4 Missing Simplified Chinese i18n coverage           |        1 | MEDIUM           |
| D5 Potential functional bugs                          |        1 | MEDIUM           |
| D6 Warnings and errors not surfaced via toast         |        1 | MEDIUM           |
| D7 Overly technical/internal-state-leaking UI strings |        1 | MEDIUM           |
| D8 Missing animations/motion                          |        1 | LOW              |

## Findings

### adm-connectors-shell-D5-001 — The bounded user-name cache evicts labels from the response currently being rendered

- **Severity:** MEDIUM
- **Dimension:** D5 Potential functional bugs
- **Location:** `src/enterprise/client/features/admin/stats/adminStatsDataSource.ts:17-36,52-63,79-85`; `src/enterprise/client/features/admin/stats/GlobalStatsPage.tsx:27-34`
- **Confidence:** HIGH
- **What:** The Round-4 remediation bounded the global user-display cache at 500 entries, but the same cache is the only lookup used to render the current result. A response containing more than 500 distinct users evicts the earliest names before the fetch function returns.
- **Evidence:** `rememberUsersFromUsage` inserts every returned user and immediately removes the oldest entries while `size > 500`. Both `findAndGroupByDay` and `findByMonth` populate the cache before returning. `GlobalStatsPage` then passes `resolveAdminStatsUser` to the stats UI, where an evicted user resolves to their raw ID. The regression test at `adminStatsDataSource.test.ts:24-37` reproduces 550 users and confirms that the first label has already been lost.
- **Impact:** On sufficiently active enterprise instances, the same monthly chart can show display names for newer users and opaque identifiers for earlier users, despite the server having returned names for all of them. Counts remain intact, but the identity dimension is visibly wrong.
- **Fix:** Separate the bounded historical cache from a current-query display map. Retain every distinct identity in the currently mounted result, or carry `userDisplay` alongside the grouped series so rendering does not depend on process-wide cache eviction. Add a regression test where one response exceeds 500 distinct users and every returned display name remains resolvable.

### adm-connectors-shell-D7-001 — Global statistics deliberately expose raw user IDs as display names

- **Severity:** MEDIUM
- **Dimension:** D7 Overly technical/internal-state-leaking UI strings
- **Location:** `src/enterprise/client/features/admin/stats/adminStatsDataSource.ts:20-25,75-85`; `src/enterprise/client/features/admin/stats/adminStatsDataSource.test.ts:24-45`; `src/enterprise/client/features/admin/stats/GlobalStatsPage.tsx:27-34`
- **Confidence:** HIGH
- **What:** Missing or evicted display names fall back directly to `userId`, which can be an internal UUID.
- **Evidence:** Cache insertion uses `name: row.userDisplay || row.userId`, while a cache miss returns `{ name: userId }`. Tests explicitly expect visible names such as `u-0` and `u1`. `GlobalStatsPage` supplies this resolver to the user-grouped chart and ranking views.
- **Impact:** Administrators see implementation identifiers they cannot interpret or act on. This also exposes internal identity values in screenshots and exported visual evidence.
- **Fix:** Keep the ID only as the internal grouping key and assign stable localized aliases for unresolved users. Exact copy: en-US `"Unknown user {{index}}"`; zh-CN `"未知用户 {{index}}"`. The per-result index avoids collapsing multiple unknown users into one chart category.

### adm-connectors-shell-D6-001 — Connector recovery-draft failures are silently swallowed

- **Severity:** MEDIUM
- **Dimension:** D6 Warnings and errors not surfaced via toast
- **Location:** `src/enterprise/client/features/admin/connectors/localDraftStorage.ts:131-156`; `src/enterprise/client/features/admin/connectors/useConnectorEditor.ts:103-118`; `src/enterprise/client/features/admin/connectors/localDraftStorage.test.ts:124-145`
- **Confidence:** HIGH
- **What:** Recovery persistence silently returns when the draft is unsafe or oversized and silently catches quota/private-mode write errors. The editor receives no outcome and cannot tell the administrator that crash recovery is unavailable.
- **Evidence:** `saveAdminConnectorDraft` returns `void`; its size and secret-scan branches remove the stored draft and return, while its final `catch` does nothing. `useConnectorEditor` calls it from an effect without tracking success. Tests codify that serialization and storage exceptions merely leave `localStorage` empty.
- **Impact:** The administrator can continue a long edit without knowing that a tab crash or browser restart will lose it. The navigation guard helps deliberate navigation but cannot protect against process failure.
- **Fix:** Return a discriminated persistence result and have the editor show one deduplicated `toast.warning` from `@lobehub/ui/base-ui` per editing session. Preserve the fail-closed secret handling, but surface a plain warning such as “Recovery backup is unavailable. Keep this page open until you save.” Avoid firing a toast on every keystroke.

### adm-connectors-shell-D4-001 — The zh-CN connector catalog ships pervasive mixed-English copy

- **Severity:** MEDIUM
- **Dimension:** D4 Missing Simplified Chinese i18n coverage
- **Location:** `src/enterprise/client/features/admin/connectors/ConnectorListView.tsx:64-124`; `src/enterprise/client/features/admin/connectors/ConnectorDetailView.tsx:176-206`; `src/enterprise/client/features/admin/connectors/ConnectorEditorFields.tsx:144-210`; `locales/zh-CN/admin.json:1126-1267`
- **Confidence:** HIGH
- **What:** Forty-five `connectorCatalog.*` zh-CN values retain ordinary English terms including “Connector,” “Revision,” “Secret,” “Client Secret,” “Scope,” and “Deny.” These are translated elsewhere in the same catalog as “连接器，” “版本，” “密钥，” “权限范围，” and “拒绝”.
- **Evidence:** Core in-scope screens render these keys for page titles, buttons, conflict alerts, form labels, table columns, mutation confirmations, toasts, and unsaved-change warnings. Examples include `"Connector Revision 冲突"`, `"平台 Connector"`, `"草稿 Revision"`, and `"平台 Deny 始终优先"`.
- **Impact:** Nearly every connector-management flow appears partially untranslated to Simplified Chinese users, including destructive confirmations and error recovery.
- **Fix:** Normalize the entire connector namespace using the established Chinese glossary. Exact representative copy: en-US `"Create connector"` / zh-CN `"创建连接器"`; `"Connector version conflict"` / `"连接器版本冲突"`; `"Create connector draft"` / `"创建连接器草稿"`; `"Replace OAuth client secret"` / `"替换 OAuth 客户端密钥"`; `"OAuth scopes (space-separated)"` / `"OAuth 权限范围（以空格分隔）"`; `"Draft version"` / `"草稿版本"`; `"Platform connectors"` / `"平台连接器"`; `"Platform deny rules always take priority. Risk level and confirmation requirements are included in the published version."` / `"平台拒绝规则始终优先。风险等级和确认要求会包含在已发布版本中。"`; `"You have unsaved public connector settings. Secret values are not stored in recovery drafts."` / `"存在未保存的连接器公开配置；密钥不会写入恢复草稿。"`

### adm-connectors-shell-D2-001 — The stats cache regression test blesses the user-visible label loss

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/stats/adminStatsDataSource.test.ts:24-37`; `src/enterprise/client/features/admin/stats/adminStatsDataSource.ts:17-36,79-85`
- **Confidence:** HIGH
- **What:** The Round-4 regression test verifies only that the implementation stays below 500 entries and explicitly treats raw-ID fallback as correct.
- **Evidence:** After loading 550 named users, the test asserts `resolveAdminStatsUser('u-0')` equals `{ name: 'u-0' }`. It never asserts the actual product requirement: names returned in the current query must remain available while that query is displayed.
- **Impact:** The suite stays green while the global user chart loses valid labels at enterprise scale, making the remediation appear complete.
- **Fix:** Replace the raw-ID expectation with a current-response regression test that resolves every returned user name. Test boundedness separately on an auxiliary historical cache that is not the active render lookup.

### adm-connectors-shell-D2-002 — The locale regression helper does not enforce its stated zh-CN guarantee

- **Severity:** MEDIUM
- **Dimension:** D2 Test decay
- **Location:** `src/enterprise/client/features/admin/i18n/shippedScreenKeys.locale.test.ts:7-22,48-76,88-96`; `locales/zh-CN/admin.json:1126-1267`
- **Confidence:** HIGH
- **What:** The test says it prevents zh-CN from silently degrading to English, but untranslated detection is optional and is not enabled for the admin, chat, or model-provider key groups. It also contains no connector-screen keys.
- **Evidence:** `assertKeys` only rejects English when `forbidEnglish?.[key]` exists. The admin assertion calls it without that argument, so any non-empty English value passes. Only the managed-resource test supplies forbidden English values. Consequently, the 45 mixed-English connector values are untested.
- **Impact:** Locale presence tests give false confidence: keys can exist yet remain untranslated across an entire shipped admin flow.
- **Fix:** Compare zh-CN values against en-US by default, with a small explicit allowlist for accepted technical tokens such as OAuth, URL, JSON, and MCP. Add all literal connector screen keys or derive them from the connector namespace, and assert the exact Chinese glossary used in D4.

### adm-connectors-shell-D1-001 — Connector tool ordering logic is duplicated between controller and UI

- **Severity:** LOW
- **Dimension:** D1 Code smells
- **Location:** `src/enterprise/client/features/admin/connectors/controller.ts:219-225`; `src/enterprise/client/features/admin/connectors/ToolPolicyEditor.tsx:52-63`
- **Confidence:** HIGH
- **What:** The three-level comparator—`sort`, then `toolKey`, then `id`—is implemented verbatim in two places.
- **Evidence:** The controller exports `sortConnectorTools`, but `ToolPolicyEditor` recreates the same comparator inside `useMemo`.
- **Impact:** A later ordering or tie-break change can make saved tool order differ from the editor’s visible order.
- **Fix:** Reuse `sortConnectorTools` in `ToolPolicyEditor`, or export a single comparator used by both paths.

### adm-connectors-shell-D3-001 — The enterprise route registry is a parked extension API with no production producer

- **Severity:** LOW
- **Dimension:** D3 Dead code and development debris
- **Location:** `src/enterprise/client/registry.ts:130-160`; `src/enterprise/client/routes/index.ts:16-32`; `src/enterprise/client/publicBarrel.exports.test.ts:8-21`
- **Confidence:** HIGH
- **What:** The registry exposes registration, normalization, duplicate detection, and nested-route validation, but no production code registers a module. Its own comment says to “park extension routes” until a router rebuild path exists.
- **Evidence:** A repo-wide search found `.register` calls only in tests; production merely calls `enterpriseModuleRegistry.getRoutes()`, which is therefore always empty. The public-barrel test additionally ensures the singleton and factory cannot be used by external consumers.
- **Impact:** The codebase carries a misleading extension abstraction and dedicated tests for behavior that cannot occur in production.
- **Fix:** Remove the registry and pass no extension routes until a real bootstrap lifecycle exists, or complete that lifecycle by registering modules before route construction and providing an explicit route-factory rebuild path.

### adm-connectors-shell-D8-001 — Shared table states replace one another without transition

- **Severity:** LOW
- **Dimension:** D8 Missing animations/motion
- **Location:** `src/enterprise/client/features/admin/primitives/DataTable.tsx:270-291,336-382`
- **Confidence:** HIGH
- **What:** Loading, error, empty, and populated states are separate early returns, so revalidation and empty-to-populated transitions abruptly replace the entire table and pagination region.
- **Evidence:** Each state mounts a different root subtree. Unlike the overview cards, the table primitive has no stable state container or opacity/layout transition.
- **Impact:** Connector lists and other admin tables visibly pop and jump as data arrives or a retry succeeds.
- **Fix:** Keep the table region mounted and use the antd `Table` `loading` prop for refreshes. For first-load, empty, and error swaps, use an `@lobehub/ui` `Skeleton` inside a stable wrapper with `createStaticStyles` and `opacity ${cssVar.motionDurationMid} ${cssVar.motionEaseInOut}`. Disable the transition under `prefers-reduced-motion`; add no animation dependency.

## Dimensions with no findings

None. At least one verified finding was identified in each of D1–D8.
