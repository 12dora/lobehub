# Round 5 — Triage: what to skip, what to keep

**181 findings → 68 dropped, 113 kept.**

The raw domain reports under `audit/round5/` are **left intact as the evidence archive**. Nothing is
deleted from them — an enterprise audit trail that silently loses findings is worse than a long one.
This file is the decision record: what was cut, and why it is safe to cut.

**Test used:** _does skipping this cost anything real?_ Not "is it a real finding" — nearly all 181
are real. Real and worth-doing are different questions. A finding was dropped only when skipping it
costs no user harm, no data risk, no deploy risk, and no compounding maintenance debt.

---

## Dropped — 68 findings

### Cut 1: File-size and structural-purity smells (13)

Pure style. No behavior, no risk, and "split this file" churn on a fork actively _increases_ future
upstream-merge conflict cost. This is the cut I am most confident in.

`adm-settings-system-D1-002` · `ops-tests-docs-D1-003` · `pkg-shared-D1-003` ·
`srv-agent-skill-catalog-D1-002` · `srv-ai-settings-branding-D1-04` · `srv-fork-seams-D1-2` ·
`fe-user-surface-D1-1` · `adm-audit-D1-02` · `adm-connectors-shell-D1-001` ·
`adm-users-identity-D1-1` · `srv-routers-contracts-D1-2` · `adm-ai-D1-01` · `srv-platform-core-D1-2`

> The 800-line guideline is for humans writing new code, not a licence to refactor a fork's
> hot merge surface. Every one of these is a file the next upstream merge has to reconcile.

### Cut 2: Missing test coverage that isn't a defect (17)

"X has no regression test" is a gap, not a bug. Where the underlying defect survived verification,
the test gets written _as part of that fix_ — it does not need a separate backlog item. Where there
is no underlying defect, the coverage buys little.

`adm-agents-skills-D2-1` · `adm-agents-skills-D2-2` · `adm-ai-D2-01` · `adm-ai-D2-02` ·
`adm-audit-D2-01` · `adm-audit-D2-02` · `adm-audit-D2-03` · `adm-settings-system-D2-001` ·
`adm-users-identity-D2-1` · `pkg-shared-D2-002` · `srv-ai-settings-branding-D2-02` ·
`srv-audit-D2-01` · `srv-connector-D2-1` · `srv-connector-D2-2` · `srv-routers-contracts-D2-1` ·
`srv-routers-contracts-D2-2` · `srv-security-guards-D2-001`

> **Kept deliberately:** tests that _actively assert wrong behavior_ or that pass vacuously. Those
> are worse than no test — they manufacture confidence. See the kept list.

### Cut 3: Inert dead code (13)

Dead code by definition does not execute. Orphaned comments, unused exports, stale file headers,
no-op scaffolding, unused constructor params. Zero runtime risk; delete opportunistically if you're
already in the file.

`adm-agents-skills-D3-1` · `adm-audit-D3-01` · `adm-connectors-shell-D3-001` ·
`adm-settings-system-D3-001` · `adm-users-identity-D3-1` · `pkg-shared-D3-001` ·
`srv-agent-skill-catalog-D3-001` · `srv-audit-D3-01` · `srv-connector-D3-1` ·
`srv-fork-seams-D3-1` · `srv-identity-D3-001` · `srv-identity-D3-002` ·
`srv-security-guards-D3-002`

### Cut 4: Low-value i18n (6)

Technical enum labels and terms that shouldn't be translated anyway.

`adm-ai-D4-01` (model-type enums, admin-facing) · `adm-audit-D4-02` (message roles) ·
`adm-users-identity-D4-1` ("Client ID" — a standard OAuth term; translating it makes it _harder_ to
match against the IdP console) · `pkg-shared-D4-001` (upstream SuperGrok provider copy) ·
`srv-agent-skill-catalog-D4-001` (server diagnostics) · `srv-fork-seams-D4-1`

### Cut 5: Refuted or de-rated to nothing (5)

`adm-audit-D5-01` — **refuted**, no production path performs the claimed transition.
`srv-fork-seams-D6-1` — **refuted**, identical behavior in upstream baseline; out of scope.
`srv-security-guards-D5-001` — verifier cut HIGH→LOW; only caller is an admin AI chat probe.
`srv-fork-seams-D5-1` — verifier cut HIGH→MEDIUM; current callers aligned, recoverable.
`adm-users-identity-D5-3` — cosmetic, requires concurrent restarts by one admin.

Plus `ops-tests-docs-D5-004` (E2E seed mutation) — test infrastructure, never touches production.

### Cut 6: Admin-facing jargon (7)

D7 exists to protect _ordinary users_. Platform administrators are technical staff who read
"revision" and "run ID" without harm. Rewriting admin copy is polish with a translation bill attached.

`adm-ai-D7-01` · `adm-audit-D7-01` · `adm-settings-system-D7-001` · `adm-users-identity-D7-1` ·
`ops-tests-docs-D7-001` · `adm-agents-skills-D7-1` · `adm-agents-skills-D7-2`

> **Two admin-facing D7s survived anyway** — see kept list. "Signed tombstone revision" is past what
> even an admin should have to parse, and the "rebase" copy gates recovery from a live HIGH.

### Cut 7: Cosmetic motion (4) + trivial perf (2)

`adm-settings-system-D8-001` (card-height jump) · `adm-agents-skills-D8-1` (rows appear abruptly) ·
`adm-ai-D8-01` (reorder snap) · `adm-connectors-shell-D8-001` (table state swap) —
all LOW, all invisible unless you're looking for them.

`adm-audit-D1-01` (one duplicate revalidation) · `srv-ai-settings-branding-D1-03` (serialized reads
on a snapshot path) — measurable but immaterial.

---

## Kept — 113 findings

### Must do — 16 verified HIGH

Unchanged from `INDEX.md` §4. Migration chain (3) → OIDC security regression (1) → audit/evidence
atomicity (4) → identity/authz (3) → catalog & connector runtime (4) → unreachable connector UI (1).

### Should do — the non-skippable remainder

**Tests that lie (14 kept from D2).** Not "missing coverage" — tests that assert the _wrong_ thing:
`fe-user-surface-D2-1` manufactures a route that doesn't exist in production and asserts the broken
guard, actively masking HIGH `fe-user-surface-D5-1`. `adm-connectors-shell-D2-001` blesses a
user-visible label loss. `srv-ai-settings-branding-D2-01` contradicts the implementation.
`srv-platform-core-D2-1` fails before reaching its assertions. `srv-identity-D2-002` is vacuous.
`fe-user-surface-D2-3` is seven exact duplicate suites.
Plus the **dormant-CI-lane trio** (`srv-agent-skill-catalog-D2-001`, `srv-fork-seams-D2-1`,
`ops-tests-docs-D2-002`): real-PostgreSQL and Prometheus/OTLP suites that exist but are never
scheduled. **This is the exact Round-4 root cause recurring** — treat as one item.

**Dead code that isn't inert (5 kept from D3).** `adm-ai-D3-01` / `fe-user-surface-D3-1` are the
same finding: the most recent commit (`eb7fcbb87c`, the settings-provider extraction) added
**4,231 lines no consumer imports** — an incomplete refactor, not debris. `srv-platform-core-D3-1`
is a managed-skill resolver with no caller (same "built but unwired" question as
`fe-user-surface-D5-1`). `srv-fork-seams-D3-2` leaves security comments claiming connector
governance is fail-open when it is not — actively misleading on a security property.
`srv-security-guards-D3-001` is a dead _credential-stripping_ branch; verify before deleting.

**Real bugs (40 kept from D5).** Highlights: `adm-agents-skills-D5-1` (admin SkillStore gated by
personal permissions instead of platform RBAC — an authz gap), `srv-security-guards-D5-003` (a
documented startup secret gate never invoked by production bootstrap), `srv-platform-core-D5-5/D5-6`
(break-glass bootstrap not idempotent, email lookup not normalized — emergency admin access),
`adm-users-identity-D5-2` and `adm-audit-D5-02` (both silently destroy populated drafts),
`pkg-shared-D5-002` (UTC bounds against session-local day buckets — wrong analytics),
`pkg-shared-D5-003` (Google transport bypassed by non-chat methods — may skip SSRF controls).

**Silent failures (15 kept from D6).** Kept nearly whole: this dimension is precisely "the user's
action failed and nothing told them." `adm-ai-D6-01` silently degrades connector permissions to
defaults on a fetch failure; `adm-ai-D6-02` overwrites partial publication and reports success.

**User-facing copy (10 kept from D7).** Only strings ordinary users actually hit.
`srv-connector-D7-2` is the standout: an expired OAuth authorization is presented as an _invalid API
key_, which sends users to re-enter a credential that was never the problem.

**i18n (6 kept from D4)** — the pervasive mixed-English surfaces (connector catalog, branding) and
untranslated export error codes.

**Motion (3 kept from D8).** `adm-audit-D8-01` is a genuine React correctness bug (ref mutation
during render), not decoration. `adm-users-identity-D8-1` is two minutes of polling with no
indicator — users conclude it hung. `fe-user-surface-D8-1` is an end-user surface.

---

## Standing caveat

The 97 kept non-HIGH findings are **single-auditor and unverified**. My verification wave de-rated
64% of the tier it checked. Keeping an item here means _"not safely skippable on its face"_ — it
does not mean _"confirmed, go fix it."_ Verify before actioning, in batches, the way the HIGH tier was.
