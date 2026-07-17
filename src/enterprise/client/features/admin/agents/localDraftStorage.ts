import { z } from 'zod';

import {
  platformAgentConnectorDependencyRefSchema,
  platformAgentModelDependencyRefSchema,
  platformAgentSkillDependencyRefSchema,
  platformAgentVersionConfigSchema,
  platformAgentVersionSchema,
} from '@/server/enterprise/contracts/platformAgents';

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

/**
 * Hard cap on nodes scanned. A legitimate draft is small (a few hundred nodes); anything larger
 * is refused rather than partially scanned, so a secret can never hide past the limit.
 */
const MAX_SCAN_NODES = 10_000;

const isSensitiveKeyName = (key: string) =>
  !BENIGN_KEYS.has(key.toLowerCase()) && SENSITIVE_KEY_PATTERN.test(key);

const containsSecretValue = (value: string) =>
  SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));

/**
 * FAIL-CLOSED secret scan tuned for the draft shape: flags secret-bearing string VALUES anywhere
 * and any sensitive foreign KEY name (e.g. `password`, `apiKey`) that is not an allow-listed
 * schema identifier. If the traversal cannot COMPLETE within {@link MAX_SCAN_NODES} it returns
 * `true` (treat incomplete traversal as sensitive) so a secret placed past the cap — or a
 * benignly oversized tree — is never persisted. Rejected content is never returned or logged.
 */
const carriesSecretMaterial = (value: unknown): boolean => {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= MAX_SCAN_NODES) return true; // could not finish the scan → fail closed
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
 * field, but a contract-valid draft with many connectors/tools can still be large, so this is a
 * hard backstop against a payload filling local-storage quota.
 */
export const MAX_DRAFT_BYTES = 512 * 1024;

/**
 * Authoritative draft validation. Reuses the M10 append-version CONTRACT schemas so the local
 * recovery draft is held to the exact same rules the server enforces (SemVer, 64-hex checksums,
 * positive revisions, field lengths, array max + key uniqueness, model-parameter ranges, secret
 * refusal in text fields). The only adapter is that `model` may be `null` while the operator has
 * not yet resolved an exact published model, plus the local envelope (token/revision/savedAt).
 */
const storedDependenciesSchema = z
  .object({
    connectors: z.array(platformAgentConnectorDependencyRefSchema).max(100),
    model: platformAgentModelDependencyRefSchema.nullable(),
    skills: z.array(platformAgentSkillDependencyRefSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const connectorKeys = snapshot.connectors.map(({ connectorKey }) => connectorKey);
    if (new Set(connectorKeys).size !== connectorKeys.length) {
      ctx.addIssue({ code: 'custom', message: 'connector references must be unique' });
    }
    const skillKeys = snapshot.skills.map(({ skillKey }) => skillKey);
    if (new Set(skillKeys).size !== skillKeys.length) {
      ctx.addIssue({ code: 'custom', message: 'skill references must be unique' });
    }
  });

const storedAdminAgentDraftSchema = z
  .object({
    draft: z
      .object({
        config: platformAgentVersionConfigSchema,
        dependencies: storedDependenciesSchema,
        version: platformAgentVersionSchema,
      })
      .strict(),
    draftToken: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().nonnegative(),
    savedAt: z.string().datetime(),
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
 * - `blocked`      — carried secret material or was too large to scan; content is NOT logged.
 * - `too_large`    — exceeds {@link MAX_DRAFT_BYTES}.
 * - `invalid`      — failed authoritative contract validation (not yet a persistable draft).
 */
export type DraftPersistStatus = 'blocked' | 'invalid' | 'saved' | 'too_large' | 'unavailable';

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

  // Never hydrate secret-bearing (or un-scannable) material.
  if (carriesSecretMaterial(parsed)) {
    safeRemove(id);
    return null;
  }
  const result = storedAdminAgentDraftSchema.safeParse(parsed);
  if (!result.success) {
    safeRemove(id);
    return null;
  }
  return result.data as StoredAdminAgentDraft;
};

export const saveAdminAgentDraft = (
  id: string,
  value: StoredAdminAgentDraft,
): DraftPersistStatus => {
  // 1. Fail-closed secret / un-scannable-size guard (never surface the rejected content).
  if (carriesSecretMaterial(value)) {
    safeRemove(id);
    return 'blocked';
  }
  // 2. Authoritative contract validation before anything is written.
  if (!storedAdminAgentDraftSchema.safeParse(value).success) {
    safeRemove(id);
    return 'invalid';
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return 'unavailable';
  }
  // 3. Envelope size bound (a contract-valid draft can still be large via many tools).
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
