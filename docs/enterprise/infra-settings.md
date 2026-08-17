# Infrastructure settings (object storage / mail)

Admin → 系统 → 通用设置 → 基础设施 can persist object-storage (S3) and mail (SMTP / Resend) configuration. Changes take effect at runtime (no process restart) through a 30s `DomainConfigCache` snapshot invalidated on every save.

## Precedence

Per card, all-or-nothing — never a per-field merge:

```
effective(card) = db[card].enabled ? db[card] : env[card]
```

Each card reports `source: 'db' | 'env'`. Turning a card off (`enabled: false`) keeps the row for audit history and falls back to the process environment. A disable payload may be `{ enabled: false }` only — omitted non-secret fields keep their stored values, and the secret stays unless the action is `clear`. Disable is never blocked by an undecryptable secret.

If the database or KEK decrypt is unavailable, the snapshot **fails open** in this order:

1. last-known-good snapshot (keep the last successfully loaded effective bags so a DB outage does not flip live S3/mail back to env and break uploads)
2. env bag, if nothing has been loaded yet

A single warning log includes the age of the last-known-good snapshot (`lastKnownGoodAgeMs`). Per card, an enabled DB object-storage override does **not** inherit `S3_PREVIEW_URL_EXPIRE_IN` from env; missing DB preview expiry uses the constant default `7200`.

## What stays env-only

- `NEXT_PUBLIC_S3_FILE_PATH` (object key prefix). Changing it would break existing keys.
- 密钥管理 (KEK / Vault). The KEK decrypts every DB-stored secret — a DB-sourced Vault address is a confused-deputy. Credentials stay in the start environment; the 基础设施 tab has no card for it at all, and its health is reported on the 系统 status page.

## Secrets

Secrets are never returned. The admin form sends `{ action: 'keep' | 'clear' | 'replace', value? }`. Ciphertext is sealed with `PlatformSecretService`. Enabling a card without a stored (or newly replaced) secret is rejected.

## Mail `from`

Branding's published `emailFrom` still overrides the sender at send time. The mail card's from address / sender name is the fallback when branding has none.

## Runtime consumers

S3: `createFileS3()` / `FileS3.create()`, file service URL building, tracing stores, audit export storage, branding asset gate, `enableUploadFileToServer`.

Mail: `EmailService.create()` (Better Auth send sites).

The OpenAPI package (`packages/openapi`) still reads `fileEnv` only and does not import enterprise code.

## Invalidation

Scope `infra_settings`. `admin.system.updateInfraSettings` writes CAS (`expectedRevision`) then publishes the scope so every instance reloads.
