import {
  carriesLocalDraftSecretMaterial,
  utf8ByteLength,
} from '@/enterprise/client/features/admin/primitives/localDraftSafety';

import type { EditableAdminConnectorDraft } from './controller';

const STORAGE_PREFIX = 'aihub.admin.connectors.draft.';
/** Hard backstop against a public draft filling local-storage quota. */
export const MAX_CONNECTOR_DRAFT_BYTES = 256 * 1024;

export interface StoredAdminConnectorDraft {
  baseRevision: number;
  draft: EditableAdminConnectorDraft;
  draftToken: string;
  savedAt: string;
}

const keyFor = (id: string) => `${STORAGE_PREFIX}${id}`;

const safeRemove = (id: string) => {
  try {
    localStorage.removeItem(keyFor(id));
  } catch {
    /* storage unavailable — nothing to clean up */
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

const sanitizeStoredDraft = (value: StoredAdminConnectorDraft): StoredAdminConnectorDraft => ({
  baseRevision: value.baseRevision,
  draft: sanitizePublicDraft(value.draft),
  draftToken: value.draftToken,
  savedAt: value.savedAt,
});

/**
 * Connector recovery stores only the public field whitelist. After whitelist sanitization,
 * run the shared client secret-value scan so a secret pasted into a public field cannot
 * persist (keys like `credentialMode` / `draftToken` are allow-listed by the shared helper).
 */
export const loadAdminConnectorDraft = (id: string): StoredAdminConnectorDraft | null => {
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
    if (carriesLocalDraftSecretMaterial(sanitized)) {
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

export const saveAdminConnectorDraft = (id: string, value: StoredAdminConnectorDraft) => {
  try {
    const sanitized = sanitizeStoredDraft(value);
    if (carriesLocalDraftSecretMaterial(sanitized)) {
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

export const clearAdminConnectorDraft = (id: string) => safeRemove(id);
