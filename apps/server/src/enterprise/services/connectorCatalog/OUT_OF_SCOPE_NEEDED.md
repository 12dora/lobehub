# OUT\_OF\_SCOPE\_NEEDED — connector catalog

## HIGH — formal migration for durable connection-test columns

**Location:** `packages/database/migrations/**` (serialized DB batch owns this)

**Table:** `platform_connectors`

**Schema (already in TS `packages/database/src/schemas/platform/connectors.ts`):**

| Column                           | SQL type       | Nullable | Default       |
| -------------------------------- | -------------- | -------- | ------------- |
| `connection_test_status`         | `varchar(16)`  | yes      | none (`NULL`) |
| `connection_test_latency_ms`     | `integer`      | yes      | none (`NULL`) |
| `connection_test_error_category` | `varchar(32)`  | yes      | none (`NULL`) |
| `connection_test_message_code`   | `varchar(128)` | yes      | none (`NULL`) |
| `connection_tested_at`           | `timestamptz`  | yes      | none (`NULL`) |
| `connection_tested_draft_token`  | `varchar(64)`  | yes      | none (`NULL`) |
| `connection_tested_revision`     | `integer`      | yes      | none (`NULL`) |

**SQL shape (convergent, expand-only):**

```sql
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_status" varchar(16);
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_latency_ms" integer;
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_error_category" varchar(32);
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_test_message_code" varchar(128);
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_at" timestamp with time zone;
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_draft_token" varchar(64);
ALTER TABLE "platform_connectors" ADD COLUMN IF NOT EXISTS "connection_tested_revision" integer;
```

**Runtime:** production request paths never run DDL. Publish fails closed when durable columns are absent/unreadable. Test harness may expand-only ADD COLUMN in `catalogTestUtils` until this migration lands + journal entry.

## MEDIUM — router soft-fail path already stable

Hard-fail rethrow is fixed in `catalogService.ts`. Soft-fail `publishError` was already a stable code string. Router mapping in `connectorsSupport.ts` is out of bounds and already treats `ConnectorPublishImmediateError` as a safe message.
