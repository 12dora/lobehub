# OUT\_OF\_SCOPE\_NEEDED — admin audit slice

Items intentionally not fixed in this pass (allowed edit roots only:
`apps/server/src/enterprise/services/audit/**` and
`src/enterprise/client/features/admin/audit/**`).

## i18n — 15 audit actions + enum/value labels

**Gap:** Fifteen emitted `admin.audit.*` actions lack EN/zh-CN locale keys
(`exports.{cancel,create,download,get}`, `legalHolds.{create,get,release}`,
`retention.{cancel,dryRun,getRun,run,status,worker}`, compat `admin.audit.{get,list}`).
Several UI surfaces still render raw enums (message roles, timeline kinds,
hold scope types, worker error text).

**Why OOS:** Locale catalogs live under `packages/locales/` and `locales/`;
user directed a separate i18n pass. Do not hand-edit those trees here.

## File-size splits

**Gap:** `adminAuditService.ts`, `retentionWorker.ts`, and
`retentionWorker.test.ts` exceed the \~800-line guideline.

**Why OOS:** Pure refactor; risk of noisy diffs while landing HIGH security
fixes. Split by subdomain in a follow-up.

## Retention per-row / hold-inventory performance

**Gap:** Each retention batch still loads the full active legal-hold inventory
and may re-evaluate holds per candidate. Large hold sets × large batches stay
O(holds × candidates).

**Why OOS:** Ideal fix is indexed set-based hold predicates / versioned hold
snapshot in `packages/database` retention repository (outside allowed roots).

## True zero-copy S3 stream upload

**Gap:** Export collection streams NDJSON to a temp file (O(batch) RAM), but
final upload still reads the full artifact once into a `Buffer` because the
shared `S3.uploadBuffer` API and current storage interface accept buffers only.

**Why OOS:** Multipart / streaming PutObject needs either an `S3` module change
(`apps/server/src/modules/S3`) or a dedicated multipart client — outside this
slice. Collection no longer holds a 1M-element line array.

## Download TOCTOU / immutable object versions

**Gap:** Download verifies checksum then issues a signed URL; a same-key
replace after verify remains a narrow TOCTOU window.

**Why OOS:** Requires versioned object keys or immutable storage policy outside
the audit service package.
