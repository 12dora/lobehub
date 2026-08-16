import { serializeIdentityProviderAllowedCorps } from './controller';
import type { EditableDraft } from './steps';

export type IdentityProviderPersistResult = 'blocked' | 'clean' | 'conflict' | 'error' | 'saved';

export type IdentityProviderPersistRequest = {
  includeSecret: boolean;
  silent: boolean;
};

export const IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS = 400;

export const canPersistIdentityProviderDraft = (input: {
  displayName: string;
  invalidJson: boolean;
  providerKey: string;
  providerKeyError: string | null;
}): boolean =>
  Boolean(input.displayName.trim() && input.providerKey.trim()) &&
  !input.invalidJson &&
  !input.providerKeyError;

/** Skip update/create unless non-secret fields or an explicit secret mutation are dirty. */
export const shouldSkipIdentityProviderPersist = (input: {
  contentDirty: boolean;
  includeSecret: boolean;
  secretDirty: boolean;
}): boolean => !input.contentDirty && !(input.includeSecret && input.secretDirty);

export const mergeIdentityProviderPersistRequests = (
  left: IdentityProviderPersistRequest,
  right: IdentityProviderPersistRequest,
): IdentityProviderPersistRequest => ({
  includeSecret: left.includeSecret || right.includeSecret,
  silent: left.silent && right.silent,
});

/**
 * Close policy after an optional persist. Secret-only dirt stays on the confirm path
 * because autosave never writes secrets.
 */
export const resolveIdentityProviderWizardClose = (input: {
  dirty: boolean;
  persistResult?: IdentityProviderPersistResult;
  secretDirty: boolean;
}): 'close' | 'confirm' | 'persist' | 'stay' => {
  if (!input.dirty) return 'close';
  if (input.persistResult === undefined) return 'persist';
  if (input.persistResult === 'conflict' || input.persistResult === 'error') return 'stay';
  if ((input.persistResult === 'saved' || input.persistResult === 'clean') && !input.secretDirty) {
    return 'close';
  }
  return 'confirm';
};

/** Serialise persist calls and coalesce overlapping requests onto the newest draft. */
export const createIdentityProviderPersistGate = () => {
  let inflight: Promise<IdentityProviderPersistResult> | null = null;
  let queued: IdentityProviderPersistRequest | null = null;
  const waiters: Array<(result: IdentityProviderPersistResult) => void> = [];

  const enqueue = (
    request: IdentityProviderPersistRequest,
    persist: (request: IdentityProviderPersistRequest) => Promise<IdentityProviderPersistResult>,
    cancelScheduled: () => void,
  ): Promise<IdentityProviderPersistResult> => {
    cancelScheduled();
    if (inflight) {
      queued = queued ? mergeIdentityProviderPersistRequests(queued, request) : request;
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    }

    inflight = (async () => {
      let current = request;
      let result = await persist(current);
      while (queued) {
        current = queued;
        queued = null;
        result = await persist(current);
      }
      const pending = waiters.splice(0, waiters.length);
      for (const resolve of pending) resolve(result);
      return result;
    })().finally(() => {
      inflight = null;
    });

    return inflight;
  };

  return { enqueue };
};

/** Empty issuer / clientId persist as null so a first-step save can succeed. */
export const toWritableIdentityProviderFields = (draft: EditableDraft) => ({
  autoProvision: draft.autoProvision,
  buttonLabel: draft.buttonLabel,
  claimMapping: draft.claimMapping,
  clientId: draft.clientId.trim() || null,
  dingtalkAllowedCorps: serializeIdentityProviderAllowedCorps(draft.dingtalkAllowedCorps),
  displayName: draft.displayName,
  domainAllowlist: draft.domainAllowlist,
  groupRoleMapping: draft.groupRoleMapping,
  icon: draft.icon,
  issuer: draft.issuer.trim() || null,
  providerKey: draft.providerKey,
  scopes: draft.scopes,
  type: draft.type,
  usePkce: true as const,
});

export const resolveIdentityProviderSecretMutation = (input: {
  clearSecret: boolean;
  isCreate: boolean;
  secret: string;
}): { operation: 'clear' } | { operation: 'keep' } | { operation: 'replace'; value: string } => {
  if (input.clearSecret) return { operation: 'clear' };
  if (input.secret) return { operation: 'replace', value: input.secret };
  return input.isCreate ? { operation: 'clear' } : { operation: 'keep' };
};

export const formatIdentityProviderAutoSavedAt = (at: Date): string => {
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

export const isIdentityProviderContentDirty = (draft: EditableDraft, baseline: string): boolean =>
  JSON.stringify(draft) !== baseline;
