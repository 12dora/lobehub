import { z } from 'zod';

import type { AdminAgentDraft } from './types';

/**
 * Schema keys whose NAMES look credential-ish (they contain "key"/"token") but are opaque
 * catalog identifiers / CAS tokens — never secrets. Allow-listed so a legitimate draft is not
 * mis-flagged, while any OTHER sensitive-looking key still blocks persistence.
 */
const BENIGN_KEYS = new Set(
  ['allowedToolKeys', 'connectorKey', 'draftToken', 'modelKey', 'providerKey', 'skillKey'].map(
    (name) => name.toLowerCase(),
  ),
);

/**
 * Self-contained secret detection. This stays a light client module — it deliberately does NOT
 * import the server/database redaction chain, so it never persists common credential material.
 */
const SENSITIVE_KEY_PATTERN =
  /password|passwd|pwd|secret|credential|private[-_]?key|api[-_]?key|access[-_]?key|auth[-_]?token|bearer|session[-_]?id|cookie|\btoken\b/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[\w-]{35}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bBearer\s+[\w.-]{16,}\b/i,
  /["']?type["']?\s*:\s*["']service_account["']/i,
];

const isSensitiveKeyName = (key: string) =>
  !BENIGN_KEYS.has(key.toLowerCase()) && SENSITIVE_KEY_PATTERN.test(key);

const containsSecretValue = (value: string) =>
  SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));

/**
 * Fail-closed secret scan tuned for the draft shape: flags secret-bearing string VALUES anywhere
 * and any sensitive foreign KEY name (e.g. `password`, `apiKey`) that is not an allow-listed
 * schema identifier. The rejected content is never returned or logged.
 */
const carriesSecretMaterial = (value: unknown): boolean => {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0 && visited < 10_000) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'string') {
      if (containsSecretValue(current)) return true;
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isSensitiveKeyName(key) && child != null) return true;
      stack.push(child);
    }
  }
  return false;
};

const STORAGE_PREFIX = 'aihub.admin.agents.draft.';

/**
 * Absolute upper bound on a persisted recovery draft. The contract already caps every text
 * field (systemRole ≤ 100k chars, etc.), so a legitimate in-progress draft stays well under
 * this; the bound is a hard backstop against a corrupted/oversized payload filling quota.
 */
export const MAX_DRAFT_BYTES = 512 * 1024;

/**
 * Structural (not business-complete) validation of a persisted draft. Types and object shape
 * are enforced strictly so schema drift / corrupted storage is rejected, while empty strings
 * are tolerated because a recovery draft is captured mid-edit and may be incomplete.
 */
const storedConfigSchema = z
  .object({
    avatar: z.string().nullable(),
    backgroundColor: z.string().nullable(),
    description: z.string().nullable(),
    displayName: z.string(),
    modelParameters: z
      .object({
        frequencyPenalty: z.number().optional(),
        maxTokens: z.number().optional(),
        presencePenalty: z.number().optional(),
        temperature: z.number().optional(),
        topP: z.number().optional(),
      })
      .strict(),
    openingMessage: z.string().nullable(),
    openingQuestions: z.array(z.string()),
    systemRole: z.string(),
    tags: z.array(z.string()),
  })
  .strict();

const storedSnapshotSchema = z
  .object({
    connectors: z.array(
      z
        .object({
          allowedToolKeys: z.array(z.string()),
          connectorId: z.string(),
          connectorKey: z.string(),
          publishedChecksum: z.string(),
          publishedRevision: z.number(),
        })
        .strict(),
    ),
    model: z
      .object({
        modelKey: z.string(),
        providerChecksum: z.string(),
        providerKey: z.string(),
        providerRevision: z.number(),
      })
      .strict()
      .nullable(),
    skills: z.array(
      z
        .object({
          checksum: z.string(),
          skillKey: z.string(),
          version: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const storedAdminAgentDraftSchema = z
  .object({
    draft: z
      .object({
        config: storedConfigSchema,
        dependencies: storedSnapshotSchema,
        version: z.string(),
      })
      .strict(),
    draftToken: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().nonnegative(),
    savedAt: z.string(),
  })
  .strict();

export interface StoredAdminAgentDraft {
  draft: AdminAgentDraft;
  draftToken: string;
  revision: number;
  savedAt: string;
}

/**
 * Outcome of a persist attempt, surfaced to the editor so the operator always knows whether
 * their in-progress work is actually recoverable.
 * - `saved`        — written to local storage.
 * - `unavailable`  — storage threw (private mode / quota / security exception).
 * - `blocked`      — rejected because it carries secret-bearing material; content is NOT logged.
 * - `too_large`    — exceeds {@link MAX_DRAFT_BYTES}.
 */
export type DraftPersistStatus = 'blocked' | 'saved' | 'too_large' | 'unavailable';

const keyFor = (id: string) => `${STORAGE_PREFIX}${id}`;

const byteLength = (value: string) => new TextEncoder().encode(value).length;

const safeRemove = (id: string) => {
  try {
    localStorage.removeItem(keyFor(id));
  } catch {
    /* storage unavailable — nothing to clean up */
  }
};

export const loadAdminAgentDraft = (id: string): StoredAdminAgentDraft | null => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(keyFor(id));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeRemove(id);
    return null;
  }

  const result = storedAdminAgentDraftSchema.safeParse(parsed);
  if (!result.success) {
    safeRemove(id);
    return null;
  }
  // Defense in depth: never hydrate secret-bearing material even if it reached storage.
  if (carriesSecretMaterial(result.data)) {
    safeRemove(id);
    return null;
  }
  return result.data as StoredAdminAgentDraft;
};

export const saveAdminAgentDraft = (
  id: string,
  value: StoredAdminAgentDraft,
): DraftPersistStatus => {
  // Never persist secret-bearing material; the rejected content is deliberately not surfaced.
  if (carriesSecretMaterial(value)) {
    safeRemove(id);
    return 'blocked';
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 'unavailable';
  }
  if (byteLength(serialized) > MAX_DRAFT_BYTES) {
    safeRemove(id);
    return 'too_large';
  }

  try {
    localStorage.setItem(keyFor(id), serialized);
    return 'saved';
  } catch {
    // Quota exceeded, private-mode SecurityError, etc. — fail closed without throwing.
    return 'unavailable';
  }
};

export const clearAdminAgentDraft = (id: string) => safeRemove(id);
