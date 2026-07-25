# Database restore: serial sequence repair (DB-012)

After restoring or importing a Postgres dump, sequence-backed serial primary keys can
lag behind `MAX(id)`. The next `INSERT` then collides on the primary key.

## `platform_global_credentials`

This table uses a serial integer `id` for UI compatibility with Market credential rows.
After any restore/import that loads rows without replaying the sequence:

```sql
SELECT setval(
  pg_get_serial_sequence('platform_global_credentials', 'id'),
  COALESCE((SELECT MAX(id) FROM platform_global_credentials), 1),
  (SELECT MAX(id) IS NOT NULL FROM platform_global_credentials)
);
```

Or from application code (idempotent):

```ts
import { repairPlatformGlobalCredentialIdSequence } from '@/database/models/platform/globalCredential';

await repairPlatformGlobalCredentialIdSequence(serverDB);
```

### When to run

- After `pg_restore` / logical dump import of `platform_global_credentials`
- After manual bulk `INSERT` with explicit `id` values
- As a post-restore checklist item in ops runbooks

### Verification

```sql
SELECT
  last_value AS sequence_last,
  (SELECT COALESCE(MAX(id), 0) FROM platform_global_credentials) AS max_id
FROM platform_global_credentials_id_seq;
-- sequence_last should be >= max_id; next nextval() must not reuse max_id.
```

See also: schema comment on `platform_global_credentials` in
`packages/database/src/schemas/platform/credentials.ts` and helper
`repairPlatformGlobalCredentialIdSequence` in
`packages/database/src/models/platform/globalCredential.ts`.
