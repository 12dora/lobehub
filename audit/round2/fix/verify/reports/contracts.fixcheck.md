| Finding |    Verified Sev | Fix status | Note                                                                                                                                                                                                |
| ------- | --------------: | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      |          MEDIUM | REGRESSION | Schema removes `fingerprint`, but database projections still emit it; strict parsing now breaks provider reads, while client components/tests still reference the removed field.                    |
| F2      |            HIGH | FIXED\_OK  | Shared schema rejects enabled-plus-empty, disabled-plus-empty remains valid, and model/DB guards plus regression tests enforce fail-closed behavior.                                                |
| F3      |          MEDIUM | REGRESSION | Auth CAS exists server-side, but its client omits `expectedRevision`; sidebar has no revision persistence/CAS, its client also omits the token, and router outputs cannot satisfy the new contract. |
| F4      |            HIGH | NOT\_FIXED | Only restart schemas and schema tests were added; no router, admin-service, or coordinator restart path exists, so cancelled/dead jobs remain stranded.                                             |
| F5      | MEDIUM (report) | REGRESSION | DTOs accept code-only enums, but workers still persist raw arbitrary names/messages and projections return them unchanged, causing failed-job responses to violate strict output schemas.           |
| F6      | MEDIUM (report) | FIXED\_OK  | Recursive validation now rejects undefined, non-finite numbers, non-plain objects, and other non-JSON values, with representative regression coverage.                                              |
| F7      |    LOW (report) | FIXED\_OK  | Both AI and connector header maps now enforce entry, name/value, and control-character bounds; implementations are duplicated but the functional issue is closed.                                   |
| F8      |    LOW (report) | FIXED\_OK  | All identified secret-contract internals are now file-private and remain locally used.                                                                                                              |

VERDICT: needs-rework

- F1: Strip fingerprint in explicit client-facing projections and update every dependent UI/test type while retaining it only in internal draft/token machinery.
- F3: Pass read revisions through both clients and implement a real revision column, conditional update, conflict mapping, and stale-writer test for sidebar layout.
- F4: Add and test the restart router/service/coordinator operation that creates an idempotent new generation from matching cancelled or recoverable-dead terminal revisions.
- F5: Map exceptions to stable codes before persistence or projection, remove raw messages, and add worker-to-DTO tests using secret/storage-key-bearing exceptions.
