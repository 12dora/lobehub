/**
 * IdP-only status presentation. Server statuses stay unchanged (`draft` is load-bearing);
 * the list and wizard never show "draft" / "unpublished" to administrators.
 */

export type IdentityProviderStatusKind =
  'disabled' | 'enabled' | 'error' | 'pendingConfiguration' | 'restartPending';

export type IdentityProviderStatusLabelKey =
  | 'identityProviders.status.disabled'
  | 'identityProviders.status.enabled'
  | 'identityProviders.status.error'
  | 'identityProviders.status.pendingConfiguration'
  | 'identityProviders.status.restartPending';

export type IdentityProviderStatusDescriptionKey =
  | 'identityProviders.status.pendingConfiguration.configured'
  | 'identityProviders.status.pendingConfiguration.incomplete';

export interface IdentityProviderStatusPresentation {
  color: 'default' | 'error' | 'info' | 'success' | 'warning';
  configured?: boolean;
  descriptionKey?: IdentityProviderStatusDescriptionKey;
  icon: 'alert' | 'ban' | 'check' | 'clock' | 'file';
  kind: IdentityProviderStatusKind;
  labelKey: IdentityProviderStatusLabelKey;
}

export interface IdentityProviderConfiguredRow {
  clientId?: string | null;
  dingtalkAllowedCorps?: readonly unknown[] | null;
  displayName?: string | null;
  issuer?: string | null;
  providerKey?: string | null;
  secret?: { configured?: boolean } | null;
  type?: string | null;
}

/** Publish-snapshot completeness minus the safe-login test. Used only for display. */
export const isIdentityProviderConfigured = (row: IdentityProviderConfiguredRow): boolean => {
  if (!row.displayName?.trim()) return false;
  if (!row.providerKey?.trim()) return false;
  if (!row.issuer?.trim()) return false;
  if (!row.clientId?.trim()) return false;
  if (!row.secret?.configured) return false;
  if (row.type === 'dingtalk' && !(row.dingtalkAllowedCorps && row.dingtalkAllowedCorps.length > 0))
    return false;
  return true;
};

const PRESENTATION: Record<
  IdentityProviderStatusKind,
  Omit<IdentityProviderStatusPresentation, 'kind'>
> = {
  disabled: {
    color: 'default',
    icon: 'ban',
    labelKey: 'identityProviders.status.disabled',
  },
  enabled: {
    color: 'success',
    icon: 'check',
    labelKey: 'identityProviders.status.enabled',
  },
  error: {
    color: 'error',
    icon: 'alert',
    labelKey: 'identityProviders.status.error',
  },
  pendingConfiguration: {
    color: 'warning',
    icon: 'file',
    labelKey: 'identityProviders.status.pendingConfiguration',
  },
  restartPending: {
    color: 'info',
    icon: 'clock',
    labelKey: 'identityProviders.status.restartPending',
  },
};

const presentation = (kind: IdentityProviderStatusKind): IdentityProviderStatusPresentation => ({
  kind,
  ...PRESENTATION[kind],
});

/**
 * Map a provider row onto the five user-visible states.
 * Unpublished (`draft`) is always 待配置 — configured-but-unpublished is not "enabled".
 * Completeness is a secondary description, not a different badge label.
 */
export const getIdentityProviderStatusPresentation = (
  row: IdentityProviderConfiguredRow & { status?: string | null },
): IdentityProviderStatusPresentation => {
  switch (row.status) {
    case 'pending_restart':
    case 'published': {
      return presentation('restartPending');
    }
    case 'active': {
      return presentation('enabled');
    }
    case 'disabled':
    case 'archived': {
      return presentation('disabled');
    }
    case 'error': {
      return presentation('error');
    }
    default: {
      const configured = isIdentityProviderConfigured(row);
      return {
        ...presentation('pendingConfiguration'),
        configured,
        descriptionKey: configured
          ? 'identityProviders.status.pendingConfiguration.configured'
          : 'identityProviders.status.pendingConfiguration.incomplete',
      };
    }
  }
};
