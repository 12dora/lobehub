-- Round-2 platform-instance/F4: persisted multi-instance catalog authority generation.
-- One row per catalog domain; writers bump generation in the same transaction as publish.
-- Readers reconcile with a single PK lookup (no catalog-wide scan on the steady-state path).
-- Idempotent / convergent so partial re-applies are safe (PGlite + Postgres).

CREATE TABLE IF NOT EXISTS "platform_catalog_authority" (
	"domain" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"token_kind" text NOT NULL,
	"token_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Seed the two poll domains at generation 0. ON CONFLICT keeps re-applies no-ops.
INSERT INTO "platform_catalog_authority" ("domain", "generation", "token_kind", "token_value", "updated_at")
VALUES
	('ai_catalog', 0, 'immutable_id', '0000000000000000000000000000000000000000000000000000000000000000', now()),
	('skill_catalog', 0, 'immutable_id', '0000000000000000000000000000000000000000000000000000000000000000', now())
ON CONFLICT ("domain") DO NOTHING;
