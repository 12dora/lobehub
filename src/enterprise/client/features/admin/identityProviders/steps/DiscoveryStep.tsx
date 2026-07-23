'use client';

import { Alert, Flexbox, Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { AUTHENTIK_ISSUER_PLACEHOLDER } from '../controller';
import { identityProviderStyles as styles } from '../styles';
import type { EditableDraft, PatchDraft } from './types';

type DiscoveryMetadata = Awaited<ReturnType<typeof adminIdentityProvidersService.discover>>;

interface DiscoveryStepProps {
  busy: string | null;
  canTest: boolean;
  discovery: DiscoveryMetadata | null;
  draft: EditableDraft;
  networkValid: boolean;
  onDiscover: () => void;
  /** Clears discovery/network validity when the issuer value changes. */
  onIssuerChange: () => void;
  patch: PatchDraft;
}

export const DiscoveryStep = memo<DiscoveryStepProps>(
  ({ busy, canTest, discovery, draft, networkValid, onDiscover, onIssuerChange, patch }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={12}>
        <label className={styles.field}>
          <Text>{t('identityProviders.fields.issuer')}</Text>
          <Input
            value={draft.issuer}
            placeholder={
              draft.type === 'authentik'
                ? AUTHENTIK_ISSUER_PLACEHOLDER
                : 'https://id.example.com/application/o/app/'
            }
            onChange={(e) => {
              patch('issuer', e.target.value);
              onIssuerChange();
            }}
          />
        </label>
        <Button
          disabled={!canTest || !draft.issuer}
          loading={busy === 'discover'}
          onClick={onDiscover}
        >
          {t('identityProviders.actions.discover')}
        </Button>
        {networkValid ? (
          <Alert showIcon description={t('identityProviders.discovery.valid')} type="success" />
        ) : null}
        {discovery ? (
          <div className={styles.discoveryGrid}>
            <Text strong>{t('identityProviders.discovery.endpoints')}</Text>
            {(
              [
                ['authorization', discovery.authorizationEndpoint],
                ['token', discovery.tokenEndpoint],
                ['jwks', discovery.jwksUri],
              ] as const
            ).map(([key, value]) => (
              <div className={styles.discoveryRow} key={key}>
                <Text type="secondary">{t(`identityProviders.discovery.${key}` as never)}</Text>
                <Text className={styles.endpointValue}>{value}</Text>
              </div>
            ))}
          </div>
        ) : null}
      </Flexbox>
    );
  },
);

DiscoveryStep.displayName = 'DiscoveryStep';
