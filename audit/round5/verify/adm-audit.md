# Verification — adm-audit

## Verdicts

| Finding ID      | Original severity | Verdict | Corrected severity | One-line reason                                                                                                                                                                                                             |
| --------------- | ----------------- | ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adm-audit-D5-01 | HIGH              | REFUTED | N/A                | A direct `enabled` prop toggle exposes a local state gap, but no production permission-revocation path performs that transition without unmounting the picker, and every search request is independently server-authorized. |

## Details

### adm-audit-D5-01 — REFUTED

- **What the original claimed:** Revoking `AUDIT_READ` while `searchUsers` is pending changes `enabled` to false without invalidating the request, allowing the late response and cached user PII to remain visible.

- **What I actually found:** The isolated component does lack an `[enabled]` cleanup effect. A hypothetical direct rerender from `enabled=true` to `false` would leave the old request ID valid because response acceptance checks only mount state and request ID at `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.tsx:108-126`. Its user cache is also retained at `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.tsx:55` and `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.tsx:113-115`.

  That hypothetical prop transition is not how production permission revocation reaches the component. Every caller derives `enabled` from the in-memory `AdminAccessProvider` permission snapshot—for example `src/enterprise/client/features/admin/audit/live/LivePage.tsx:146-151` and `src/enterprise/client/features/admin/audit/live/LivePage.tsx:513-519`, plus `src/enterprise/client/features/admin/audit/conversations/ConversationsSearchPage.tsx:44-50` and `src/enterprise/client/features/admin/audit/conversations/ConversationsSearchPage.tsx:80-87`.

- **Refutation attempts:**

  - **Access lifecycle:** `AdminAccessProvider` loads permissions only on mount or explicit `refresh()` and sets the entire shell to `loading` before awaiting a refreshed snapshot at `src/enterprise/client/providers/AdminAccessProvider.tsx:78-120`. `AdminAccessShell` renders no business children whenever status is not `allowed` at `src/enterprise/client/features/admin/gates/AdminRootGate.tsx:80-105`. Consequently, a real refresh unmounts the picker; its cleanup invalidates pending requests at `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.tsx:146-153`.

  - **Refresh callers:** Repository-wide search found no allowed audit page invoking `useAdminAccess().refresh()`. Its only production consumer is the root error retry at `src/enterprise/client/features/admin/gates/AdminRootGate.tsx:81-96`. External role revocation therefore does not silently turn a mounted picker’s `enabled` prop false.

  - **Route gate:** Permission snapshots are also checked before rendering route content at `src/enterprise/client/features/admin/gates/AdminPermissionOutlet.tsx:38-55`. The audit-log route specifically requires `AUDIT_READ` at `src/enterprise/client/nav/adminNavMeta.ts:276-280`.

  - **Server authorization:** `admin.audit.users.search` is built from the `auditRead` procedure at `apps/server/src/enterprise/routers/admin/audit.ts:83-90` and `apps/server/src/enterprise/routers/admin/audit.ts:228-235`. Its middleware reloads global permissions from the database and rejects missing permission before executing the handler at `apps/server/src/enterprise/guards/platformPermission.ts:185-223` and `apps/server/src/enterprise/guards/platformPermission.ts:233-238`. Requests initiated after revocation are therefore blocked server-side.

  - **Tests:** The component tests cover out-of-order searches and initially disabled operation at `src/enterprise/client/features/admin/audit/shared/AuditUserSearchSelect.test.tsx:67-118`. They do not test a direct prop transition, but that omission does not establish production reachability.

  - **Baseline:** Both the component and its test are additions relative to `4bab1636408e60a7ee17b640490fbf33a310a325`; therefore this is not being refuted as an upstream-identical defect.

- **Verdict rationale:** The report proves only a reusable-component robustness gap under a synthetic direct prop rerender. It does not reproduce the claimed production confidentiality failure. When the application actually refreshes authorization, the picker is unmounted and its existing cleanup rejects the late result. Without a refresh, `enabled` does not change, so the proposed `[enabled]` effect would not detect an external revocation anyway. Such revocation is enforced at the next server request boundary; cancellation of a request already authorized by the server is not an established contract here.

- **Corrected severity and scope:** No surviving production defect. Adding an `enabled`-edge cleanup could provide defense in depth for future callers that toggle the prop directly, but the claimed HIGH-severity cross-flow PII exposure is not reproducible in the current call graph.
