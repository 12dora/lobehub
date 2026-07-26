# AIHub Enterprise Fork — Round 5 Code-Health Audit

**Date:** 2026-07-26
**Method:** 18 parallel Codex auditors (`gpt-5.6-sol`, reasoning effort `high`, read-only sandbox),
followed by 15 independent adversarial verifiers over every CRITICAL/HIGH claim.
**Baseline:** upstream LobeHub `v2.2.10` @ `4bab1636408e60a7ee17b640490fbf33a310a325`.
**Scope:** the 2,525-file enterprise fork delta. Files byte-identical to upstream were excluded;
fork seams into upstream files were in scope.
**Mutations:** none. Every agent ran read-only; no source file was modified by this audit.

---

## 1. Headline

|                                             | Count                   |
| ------------------------------------------- | ----------------------- |
| Raw findings                                | **181**                 |
| CRITICAL/HIGH claims independently verified | 36                      |
| — CONFIRMED at original severity            | 13                      |
| — DOWNGRADED                                | 21                      |
| — REFUTED                                   | 2                       |
| New HIGH discovered _during_ verification   | 1                       |
| **Net top-tier after verification**         | **16 HIGH, 0 CRITICAL** |
| Unverified (MEDIUM/LOW, single-auditor)     | 145                     |

**Both Round-5 CRITICALs were downgraded to HIGH under scrutiny.** For the first round in this
program's history, no CRITICAL survived independent verification. Rounds 1–4 each carried
CRITICALs into remediation; Round 5 does not.

The verification wave rejected or de-rated **23 of 36** top-tier claims (64%). This is materially
worse than the \~25% false-positive rate seen in earlier rounds and is itself a finding: **the
MEDIUM and LOW tiers in this report are single-auditor and unverified — do not action them without
the same falsification pass.**

> **Triaged.** 68 of the 181 findings were assessed as safely skippable and cut from the actionable
> backlog; 113 remain. See [`TRIAGE.md`](./TRIAGE.md) for the cut list and the reasoning behind each
> category. The raw domain reports below are left intact as the evidence archive.

---

## 2. Findings by dimension

| Dim | Area                          | Raw    | Peak severity (post-verification) |
| --- | ----------------------------- | ------ | --------------------------------- |
| D5  | Potential functional bugs     | **45** | HIGH ×11                          |
| D1  | Code smells                   | 34     | HIGH ×2                           |
| D2  | Test decay                    | 31     | MEDIUM (all HIGHs downgraded)     |
| D3  | Dead code / dev debris        | 19     | MEDIUM                            |
| D7  | Over-technical UI copy        | 17     | MEDIUM                            |
| D6  | Errors not surfaced via toast | 16     | HIGH ×1                           |
| D4  | Missing zh-CN i18n            | 12     | MEDIUM                            |
| D8  | Missing animations            | 7      | LOW                               |

## 3. Findings by domain × dimension

| Domain                   | D1  | D2  | D3  | D4  | D5  | D6  | D7  | D8  | Total |
| ------------------------ | --- | --- | --- | --- | --- | --- | --- | --- | ----- |
| adm-agents-skills        | 2   | 2   | 1   | 0   | 1   | 3   | 2   | 1   | 12    |
| adm-ai                   | 1   | 2   | 1   | 1   | 3   | 2   | 1   | 1   | 12    |
| adm-audit                | 2   | 3   | 1   | 2   | 2   | 2   | 1   | 1   | 14    |
| adm-connectors-shell     | 1   | 2   | 1   | 1   | 1   | 1   | 1   | 1   | 9     |
| adm-settings-system      | 2   | 1   | 1   | 1   | 3   | 2   | 2   | 1   | 13    |
| adm-users-identity       | 1   | 1   | 1   | 1   | 3   | 1   | 1   | 1   | 10    |
| fe-user-surface          | 1   | 3   | 1   | 0   | 2   | 1   | 1   | 1   | 10    |
| ops-tests-docs           | 3   | 2   | 1   | 1   | 4   | 0   | 1   | 0   | 12    |
| pkg-shared               | 3   | 2   | 1   | 1   | 3   | 0   | 1   | 0   | 11    |
| srv-agent-skill-catalog  | 2   | 1   | 1   | 1   | 1   | 1   | 1   | 0   | 8     |
| srv-ai-settings-branding | 4   | 2   | 0   | 0   | 3   | 0   | 0   | 0   | 9     |
| srv-audit                | 3   | 1   | 1   | 1   | 5   | 0   | 0   | 0   | 11    |
| srv-connector            | 1   | 2   | 1   | 1   | 2   | 0   | 2   | 0   | 9     |
| srv-fork-seams           | 2   | 1   | 2   | 1   | 1   | 2   | 3   | 0   | 12    |
| srv-identity             | 1   | 2   | 2   | 0   | 1   | 0   | 0   | 0   | 6     |
| srv-platform-core        | 2   | 1   | 1   | 0   | 6   | 0   | 0   | 0   | 10    |
| srv-routers-contracts    | 2   | 2   | 0   | 0   | 1   | 1   | 0   | 0   | 6     |
| srv-security-guards      | 1   | 1   | 2   | 0   | 3   | 0   | 0   | 0   | 7     |

---

## 4. The 16 surviving HIGH findings

Ordered by remediation priority. Every one was independently reproduced by a second model that was
instructed to refute it.

### Tier A — correctness of the release/migration chain (blocks deploy)

| ID                      | Finding                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops-tests-docs-D5-003` | The squashed baseline migration `0000_squash_baseline.sql` contains an embedded `COMMIT` thousands of lines before the journal row is inserted, ending Drizzle's transaction early.                                          |
| `ops-tests-docs-D5-001` | The migration compatibility verifier still assumes the deleted 117-migration layout and fails its static gate before it ever reaches database verification.                                                                  |
| `ops-tests-docs-D1-001` | Migration `0011` drops a concurrently pre-built index and rebuilds it non-concurrently; two further indexes have no online predeploy path at all — the documented zero-downtime procedure is undone by the migration itself. |

### Tier B — identity, authorization and secret handling

| ID                                     | Finding                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkg-shared-D5-001` _(was CRITICAL)_   | A default-off enterprise feature flag disables the **pre-existing upstream** OIDC banned-user check. Requires an already-issued valid token; affects the tRPC surface.                                                            |
| `srv-identity-D5-001` _(was CRITICAL)_ | During a database outage, a failed last-known-good update can resurrect a disabled identity provider's configuration. Usable sign-in additionally requires DB recovery without another restart.                                   |
| `srv-routers-contracts-D5-1`           | Four identity-provider mutations omit the provider ID during sanitization, letting an opaque **current client secret** reach immutable revision comments and append-only audit reasons.                                           |
| `srv-connector-D5-1`                   | Banning a shared-OAuth owner revokes their sessions but leaves the connector binding intact; runtime substitutes the owner without checking effective-ban state, so a banned account remains an executable organization identity. |

### Tier C — audit/evidence subsystem integrity

| ID                    | Finding                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srv-audit-D5-04`     | A transient object-metadata error is treated as proof of absence, letting the purge outbox finalize while the sensitive object still exists.                    |
| `srv-audit-D5-05`     | Both retention failure paths commit terminal state before the required audit append, so an append failure cannot roll them back.                                |
| `srv-audit-MISSED-01` | _(found by the verifier, not the original auditor)_ Export dead-letter terminalization has the same cross-transaction audit gap as D5-05.                       |
| `srv-audit-D5-02`     | Snapshot materialization has no heartbeat; an expired lease is reclaimable across workers until the three-attempt budget is exhausted, stranding large exports. |

### Tier D — catalog and connector runtime

| ID                               | Finding                                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srv-agent-skill-catalog-D5-001` | A corrupt **mandatory** Skill is silently removed before readiness is computed, so the catalog reports healthy and runtime proceeds without a Skill that policy requires.   |
| `srv-agent-skill-catalog-D1-001` | Published-Skill caching has per-item limits but no aggregate byte budget, and payloads are cloned into a 32-revision process cache plus per-request services.               |
| `srv-connector-D5-2`             | Emergency archive and binding revocation both resolve/decrypt secrets first, so they cannot run when credential decryption is unhealthy — exactly when you need them.       |
| `srv-routers-contracts-D6-1`     | Managed-resource publish rejects the RPC _after_ the policy has atomically committed; the client reports failure while connector execution can remain globally fail-closed. |

### Tier E — user-facing feature gap

| ID                     | Finding                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fe-user-surface-D5-1` | Managed per-user Connector authorization is fully implemented but **unreachable**: both production routes replace it with a static notice, and no production caller mounts the only UI able to create per-user OAuth bindings. |

---

## 5. Refuted — do not action

| ID                    | Why it was rejected                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adm-audit-D5-01`     | No production permission-revocation path performs the claimed state transition without unmounting the picker, and every search request is independently server-authorized. |
| `srv-fork-seams-D6-1` | The catch-delete-success behavior is identical in upstream baseline `4bab163640` — **out of scope**, not a fork defect.                                                    |

---

## 6. Systemic patterns

**1. The audit/evidence subsystem is flagged for the fourth consecutive round.**
Rounds 2, 3 and 4 each landed CRITICALs here; Round 5 lands four HIGHs (`srv-audit-D5-02/04/05`
plus the verifier-discovered `MISSED-01`). Three of the four are the _same defect class_:
**terminal state committed outside the transaction that writes the required audit record.** This is
no longer a series of individual bugs — it is a missing architectural invariant. Recommend a single
structural fix (one transactional boundary that owns state-transition + audit-append together)
rather than four point patches.

**2. Round-4's test-execution fix held, but its coverage did not follow.**
The Round-4 root cause was guard suites that existed but never ran in CI. That is fixed. However
D2 produced 31 findings spread evenly across all 18 domains, and both test-related HIGHs
(`pkg-shared-D2-001`, `srv-identity-D2-001`) are _missing regression coverage for the exact defects
Round 4 claimed to fix_. Tests now execute; they still do not assert the invariants that matter.

**3. The migration squash is not deploy-safe.**
Three of the 16 surviving HIGHs are in the migration chain, all downstream of the
`bd5189eff0` squash-to-single-baseline. The embedded `COMMIT`, the stale verifier, and the
non-concurrent index rebuild are independent defects with a common origin. Treat the squash as
unvalidated until these clear.

**4. One fork change regressed upstream security behavior.**
`pkg-shared-D5-001` is the highest-value finding in the report precisely because the fork did not
add a weak check — it _disabled an existing upstream one_ behind a default-off flag. Worth a
targeted sweep for other enterprise flags that gate pre-existing upstream guards.

**5. UX dimensions are shallow but consistent.**
D4 (12), D6 (16), D7 (17), D8 (7) produced no surviving HIGHs and cluster almost entirely in the
admin surface. The zh-CN translation commit `4f93d6f378` closed most of the Round-4 i18n debt —
12 residual gaps versus Round 4's 123. D8 is the thinnest dimension at 7 findings, all LOW, all
satisfiable with existing `@lobehub/ui` primitives; no new animation dependency was proposed.

---

## 7. Recommended sequencing

1. **Tier A first.** The migration chain defects block a clean deploy and are independent of
   everything else.
2. **`pkg-shared-D5-001` next** — it is a security regression against upstream behavior, and the
   fix is small.
3. **Tier C as one architectural change**, not four patches. See systemic pattern 1.
4. **Tier B and D** in parallel; they are subsystem-local.
5. **`fe-user-surface-D5-1`** is a product decision, not a bug fix — confirm whether managed
   per-user Connector authorization was _intended_ to ship before wiring the route.
6. **Before actioning any MEDIUM or LOW**, run the same adversarial verification pass. The 64%
   de-rating rate at the top tier makes the unverified tiers unreliable as-is.

---

## 8. Artifacts

| Path                              | Contents                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit/round5/<domain>.md`        | 18 full domain reports, all 8 dimensions, every finding with `path:line` evidence, impact and proposed fix (incl. en-US + zh-CN copy for D4/D7 and named `@lobehub/ui` components for D8). |
| `audit/round5/verify/<domain>.md` | 15 adversarial verification reports with per-finding refutation attempts and corrected severities.                                                                                         |
| `audit/round5/INDEX.md`           | This document.                                                                                                                                                                             |
