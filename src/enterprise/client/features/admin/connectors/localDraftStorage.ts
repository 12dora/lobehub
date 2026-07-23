import {
  carriesLocalDraftSecretMaterial,
  DEFAULT_LOCAL_DRAFT_BENIGN_KEYS,
  utf8ByteLength,
} from '@/enterprise/client/features/admin/primitives/localDraftSafety';

import type { EditableAdminConnectorDraft } from './controller';

/** v2 key prefix — legacy v1 entries are purged on first touch (no secret-leaf scan). */
const STORAGE_PREFIX = 'aihub.admin.connectors.draft.v2.';
const LEGACY_STORAGE_PREFIX = 'aihub.admin.connectors.draft.';
/** Hard backstop against a public draft filling local-storage quota. */
export const MAX_CONNECTOR_DRAFT_BYTES = 256 * 1024;

/** Intent metadata key names look sensitive but never hold secret bytes. */
const CONNECTOR_DRAFT_BENIGN_KEYS = [...DEFAULT_LOCAL_DRAFT_BENIGN_KEYS, 'secretIntent'] as const;

/**
 * Secret edit *intent* only — never the secret bytes. `replace_requires_reentry`
 * means the admin had typed a replacement that must be re-entered after restore.
 */
export type StoredConnectorSecretIntent = 'clear' | 'keep' | 'replace_requires_reentry';

export interface StoredAdminConnectorDraft {
  baseRevision: number;
  draft: EditableAdminConnectorDraft;
  draftToken: string;
  savedAt: string;
  /** Schema version for future migrations; reject unknown. */
  schemaVersion?: 2;
  /** Safe operation metadata for crash recovery (no secret material). */
  secretIntent?: StoredConnectorSecretIntent;
}

const keyFor = (id: string) => `${STORAGE_PREFIX}${id}`;
const legacyKeyFor = (id: string) => `${LEGACY_STORAGE_PREFIX}${id}`;

const safeRemove = (id: string) => {
  try {
    localStorage.removeItem(keyFor(id));
  } catch {
    /* storage unavailable — nothing to clean up */
  }
};

/** Purge pre-v2 draft entries that cannot be re-validated against secret leaves. */
const purgeLegacyDraft = (id: string) => {
  try {
    localStorage.removeItem(legacyKeyFor(id));
  } catch {
    /* ignore */
  }
};

const sanitizePublicDraft = (draft: EditableAdminConnectorDraft): EditableAdminConnectorDraft => ({
  credentialMode: draft.credentialMode,
  description: draft.description,
  displayName: draft.displayName,
  enabled: draft.enabled,
  endpoint: draft.endpoint,
  oauthAuthorizationEndpoint: draft.oauthAuthorizationEndpoint,
  oauthClientId: draft.oauthClientId,
  oauthIssuer: draft.oauthIssuer,
  oauthScopes: draft.oauthScopes,
  oauthTokenEndpoint: draft.oauthTokenEndpoint,
  sort: draft.sort,
  tools: draft.tools,
});

const sanitizeSecretIntent = (value: unknown): StoredConnectorSecretIntent => {
  if (value === 'clear' || value === 'replace_requires_reentry' || value === 'keep') return value;
  return 'keep';
};

const sanitizeStoredDraft = (value: StoredAdminConnectorDraft): StoredAdminConnectorDraft => ({
  baseRevision: value.baseRevision,
  draft: sanitizePublicDraft(value.draft),
  draftToken: value.draftToken,
  savedAt: value.savedAt,
  schemaVersion: 2,
  secretIntent: sanitizeSecretIntent(value.secretIntent),
});

/**
 * Connector recovery stores only the public field whitelist. After whitelist sanitization,
 * run the shared client secret-value scan so a secret pasted into a public field cannot
 * persist (keys like `credentialMode` / `draftToken` are allow-listed by the shared helper).
 * Pass `secretLeaves` for the secret currently being edited so arbitrary passphrases
 * cannot hide in description/displayName/etc.
 */
export const loadAdminConnectorDraft = (
  id: string,
  options?: { secretLeaves?: Iterable<string> },
): StoredAdminConnectorDraft | null => {
  // Pre-fix drafts may contain un-scanned arbitrary secrets — drop them.
  purgeLegacyDraft(id);
  try {
    const raw = localStorage.getItem(keyFor(id));
    if (!raw) return null;
    if (utf8ByteLength(raw) > MAX_CONNECTOR_DRAFT_BYTES) {
      safeRemove(id);
      return null;
    }
    const parsed = JSON.parse(raw) as StoredAdminConnectorDraft;
    if (!parsed.draft || typeof parsed.baseRevision !== 'number' || !parsed.draftToken) {
      safeRemove(id);
      return null;
    }
    const sanitized = sanitizeStoredDraft(parsed);
    if (
      carriesLocalDraftSecretMaterial(sanitized, {
        benignKeys: CONNECTOR_DRAFT_BENIGN_KEYS,
        secretLeaves: options?.secretLeaves,
      })
    ) {
      safeRemove(id);
      return null;
    }
    try {
      localStorage.setItem(keyFor(id), JSON.stringify(sanitized));
    } catch {
      /* re-persist is best-effort; the sanitized value is still returned */
    }
    return sanitized;
  } catch {
    safeRemove(id);
    return null;
  }
};

export const saveAdminConnectorDraft = (
  id: string,
  value: StoredAdminConnectorDraft,
  options?: { secretLeaves?: Iterable<string> },
) => {
  try {
    purgeLegacyDraft(id);
    const sanitized = sanitizeStoredDraft(value);
    if (
      carriesLocalDraftSecretMaterial(sanitized, {
        benignKeys: CONNECTOR_DRAFT_BENIGN_KEYS,
        secretLeaves: options?.secretLeaves,
      })
    ) {
      safeRemove(id);
      return;
    }
    const serialized = JSON.stringify(sanitized);
    if (utf8ByteLength(serialized) > MAX_CONNECTOR_DRAFT_BYTES) {
      safeRemove(id);
      return;
    }
    localStorage.setItem(keyFor(id), serialized);
  } catch {
    // Quota exceeded / private-mode SecurityError — fail closed without crashing the editor.
  }
};

export const clearAdminConnectorDraft = (id: string) => {
  purgeLegacyDraft(id);
  safeRemove(id);
};
