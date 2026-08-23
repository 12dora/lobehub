import {
  clearConnectorSecretEdit,
  type ConnectorSecretEdit,
  createEmptyConnectorSecretEdit,
} from './controller';
import type { StoredConnectorSecretIntent } from './localDraftStorage';

/**
 * Map live secret edit → durable intent. When the admin previously typed a
 * replacement that was not yet saved, we retain `replace_requires_reentry`
 * even though the bytes themselves are never stored.
 */
export const secretIntentFromEdit = (
  edit: ConnectorSecretEdit,
  requiresReentry: boolean,
): StoredConnectorSecretIntent => {
  if (edit.operation === 'clear') return 'clear';
  if (edit.operation === 'replace') return 'replace_requires_reentry';
  if (requiresReentry) return 'replace_requires_reentry';
  return 'keep';
};

export const secretEditFromIntent = (
  intent: StoredConnectorSecretIntent | undefined,
): ConnectorSecretEdit => {
  if (intent === 'clear') return clearConnectorSecretEdit();
  // Replacement bytes are never stored — admin must re-enter after restore.
  return createEmptyConnectorSecretEdit();
};

/**
 * Which recovery warning a restored draft owes the admin. Stable i18n key — translated at the
 * presentation boundary so locale changes apply.
 */
export const restoreNoticeKeyForIntent = (
  intent: StoredConnectorSecretIntent | undefined,
): string | null => {
  if (intent === 'replace_requires_reentry') return 'connectorCatalog.unsaved.secretReentry';
  if (intent === 'clear') return 'connectorCatalog.unsaved.secretClearRestored';
  return null;
};
