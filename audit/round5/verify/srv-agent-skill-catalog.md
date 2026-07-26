# Verification — srv-agent-skill-catalog

## Verdicts

| Finding ID                     | Original severity | Verdict   | Corrected severity | One-line reason                                                                                                                                                    |
| ------------------------------ | ----------------- | --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| srv-agent-skill-catalog-D1-001 | HIGH              | CONFIRMED | HIGH               | Per-item limits exist, but legal catalogs have no aggregate byte budget and are repeatedly cloned into a 32-revision process cache and request/operation services. |
| srv-agent-skill-catalog-D5-001 | HIGH              | CONFIRMED | HIGH               | A corrupt mandatory Skill is removed before readiness is calculated, so health becomes healthy and runtime execution proceeds without the mandatory Skill.         |

## Details

### srv-agent-skill-catalog-D1-001 — CONFIRMED

- **What the original claimed:** Published execution payloads lack an aggregate byte bound and are multiplied by structured cloning into revision and service caches, permitting severe CPU and memory growth.

- **What I actually found:** Individual payloads are bounded: Skill content is capped at 1 MiB, each resource at 1 MiB, and each Skill at 100 resources (`apps/server/src/enterprise/contracts/skillCatalog.ts:62-105`, `apps/server/src/enterprise/contracts/skillCatalog.ts:577-588`). That still permits approximately 101 MiB of inline content per Skill, while the catalog permits 10,000 entries with no aggregate-byte check (`apps/server/src/enterprise/services/skillCatalog/readService.ts:63-75`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:221-284`).

  Every executable item is cloned into the temporary index, that index is cloned into `projectionByRevision`, and every `getPublishedCatalog()` clones the entire cached index into the service instance (`apps/server/src/enterprise/services/skillCatalog/readService.ts:89-92`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:293-341`, `apps/server/src/enterprise/services/skillCatalog/readService.ts:353-368`). The process retains up to 32 full revision projections by count, regardless of their byte weight (`apps/server/src/enterprise/services/skillCatalog/readService.ts:337-349`).

- **Refutation attempts:**

  - Checked the input and resolved schemas. They establish per-file and per-Skill-count limits, but no sum across resources, Skills, or cached revisions (`apps/server/src/enterprise/contracts/skillCatalog.ts:62-105`, `apps/server/src/enterprise/contracts/skillCatalog.ts:315-327`).
  - Checked publication validation. It limits primary content to 1 MiB and validates resource integrity, but never accumulates resource or catalog bytes (`apps/server/src/enterprise/services/skillCatalog/validator.ts:623-708`).
  - Checked authorization. Creating and publishing Skills requires explicit platform permissions, and publication requires dangerous-action reauthentication (`apps/server/src/enterprise/routers/admin/skills.ts:177-185`, `apps/server/src/enterprise/routers/admin/skills.ts:256-275`). This limits who can populate the catalog but does not protect the process from legitimate large configurations.
  - Checked downstream execution guards. Device/sandbox materialization imposes an 8 MiB operation limit (`packages/device-control/src/inlineSkillResources.ts:168-186`), but it runs after catalog loading and therefore cannot prevent cache cloning. Server runtime prompt assembly also expands selected resources without applying that aggregate guard (`apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:47-57`, `apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:78-106`).
  - Checked callers. Even the authenticated metadata endpoint constructs a service and calls `getPublishedCatalog()`, causing the full execution index clone although it returns only metadata (`apps/server/src/enterprise/routers/platformSkills.ts:30-47`).
  - Checked cache behavior and tests. Tests verify count bounds and cache reuse, but contain no aggregate-payload or retained-byte regression (`apps/server/src/enterprise/services/skillCatalog/readService.projection.test.ts:176-218`, `apps/server/src/enterprise/services/skillCatalog/readService.cache.test.ts:16-31`).
  - Compared against baseline `4bab1636408e60a7ee17b640490fbf33a310a325`; the implicated files are fork-added, so this is not upstream-identical.

- **Verdict rationale:** The exact multiplication path and absence of an aggregate bound are independently reproducible from current code. Per-item schemas do not refute it: repeated normal publications can retain 32 copies of a moderately large catalog, while concurrent catalog/runtime requests create additional transient full-index clones.

- **Corrected severity and scope:** HIGH process-availability risk. Population requires an authorized administrator, and service-instance copies are transient rather than globally permanent. The 32 revision projections are process-retained, however, and all managed catalog readers and runtime starts pay cloning costs.

### srv-agent-skill-catalog-D5-001 — CONFIRMED

- **What the original claimed:** A corrupt published mandatory Skill is skipped, readiness is computed only from survivors, and the reduced catalog is reported healthy.

- **What I actually found:** `serverResolvedSkillSchema.parse()` failures are caught and discarded without preserving the item or its distribution (`apps/server/src/enterprise/services/skillCatalog/readService.ts:232-266`). Both public `skills` and `executionIndex` are then constructed only from survivors, so `executionIndex.size === skills.length` can be true despite a skipped authority item (`apps/server/src/enterprise/services/skillCatalog/readService.ts:269-332`).

  That boolean drives healthy runtime reporting (`apps/server/src/enterprise/services/skillCatalog/readService.ts:176-201`) and the readiness fast path (`apps/server/src/enterprise/services/skillCatalog/runtimeReadiness.ts:12-31`). Runtime selection therefore receives the reduced list and cannot recover the omitted Skill (`apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:84-106`).

  This contradicts mandatory semantics: mandatory Skills are always available, activated, and immutable when present (`packages/types/src/platform/skills.ts:138-154`), and runtime snapshots derive `mandatorySkillIds` only from surviving selected rows (`apps/server/src/enterprise/services/skillCatalog/runtimeSnapshot.ts:121-131`).

- **Refutation attempts:**

  - Checked catalog authority validation. It validates pointer identity and aggregate version checksum before returning all active rows (`apps/server/src/enterprise/services/platformInstance/catalogAuthority.ts:162-239`). It does not guarantee that the later stricter resolved schema will accept stored resource metadata.
  - Checked supported write guards. Current resource schemas bind `sizeBytes` and checksum to content (`apps/server/src/enterprise/contracts/skillCatalog.ts:77-103`); publication revalidates stored versions and rejects error-level issues (`apps/server/src/enterprise/services/skillCatalog/publication.ts:94-108`); and the database trigger prevents post-insert content mutation (`packages/database/migrations/0000_squash_baseline.sql:7555-7585`). These prevent newly published current-version corruption through supported APIs.
  - Those guards do not repair pre-existing rows. The projection regression test deliberately constructs a row that passes authority checksum verification but fails the resolved-resource schema, and confirms that it disappears (`apps/server/src/enterprise/services/skillCatalog/readService.projection.test.ts:132-174`).
  - Checked test coverage. That corruption test uses the fixture’s default distribution and asserts only omission/resolution; it does not test mandatory distribution, readiness, or health (`apps/server/src/enterprise/services/skillCatalog/readService.test.fixtures.ts:123-134`). Readiness tests explicitly accept empty catalogs and trust the service’s cached readiness result without resolving entries (`apps/server/src/enterprise/services/skillCatalog/runtimeReadiness.test.ts:64-76`, `apps/server/src/enterprise/services/skillCatalog/runtimeReadiness.test.ts:138-157`).
  - Checked the baseline; the affected implementation is fork-added and therefore in scope.

- **Verdict rationale:** No downstream guard compares the projected Skill count or identities against the authority set. Changing the already-tested corrupt row’s distribution to `mandatory` does not affect the skip branch, after which health and execution operate on the reduced catalog. The defect therefore survives.

- **Corrected severity and scope:** HIGH for pre-existing, restored, replicated, or externally corrupted published mandatory rows because it is a silent fail-open of organization-mandated runtime configuration. Current supported publication paths prevent creating new corrupt rows, so this is not a normal unprivileged write-path exploit.
