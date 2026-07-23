import type { EditableAdminConnectorDraft } from './controller';

const STORAGE_PREFIX = 'aihub.admin.connectors.draft.';

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

export const loadAdminConnectorDraft = (id: string): StoredAdminConnectorDraft | null => {
  try {
    const raw = localStorage.getItem(keyFor(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAdminConnectorDraft;
    if (!parsed.draft || typeof parsed.baseRevision !== 'number' || !parsed.draftToken) {
      safeRemove(id);
      return null;
    }
    const sanitized = sanitizeStoredDraft(parsed);
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
    localStorage.setItem(keyFor(id), JSON.stringify(sanitizeStoredDraft(value)));
  } catch {
    // Quota exceeded / private-mode SecurityError — fail closed without crashing the editor.
  }
};

export const clearAdminConnectorDraft = (id: string) => safeRemove(id);
