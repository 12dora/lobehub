import { ProviderIcon } from '@lobehub/icons';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import urlJoin from 'url-join';

import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useProviderName } from '@/hooks/useProviderName';
import { type GlobalLLMProviderKey } from '@/types/user/settings/modelProvider';

import { useConversationStore } from '../store';
import BaseErrorForm from './BaseErrorForm';

interface OAuthExpiredErrorProps {
  id: string;
  provider?: string;
}

/**
 * Provider ids are catalog slugs — lowercase, and dotted for the namespaced ones
 * (`azure.gpt-4o`). Anything else is not a path segment we may follow, and the first
 * character must be alphanumeric so a leading `.`/`-`/`_` can never start a relative path.
 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * `ChatMessageError.body` is untyped — it is whatever a runtime put there. Pull a provider id
 * out of it only when it really is one: an object, a numeric, or a traversal string like
 * `../../admin` would otherwise reach `urlJoin` and either throw on click or navigate
 * somewhere the error never named.
 */
export const readErrorProviderId = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { provider } = body as { provider?: unknown };
  if (typeof provider !== 'string') return undefined;
  const trimmed = provider.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  return PROVIDER_ID_PATTERN.test(trimmed) ? trimmed : undefined;
};

/**
 * An expired OAuth connection is not a configuration mistake — there is exactly one way out
 * (reconnect the account in provider settings), so the card names it and takes the user there
 * instead of leaving a raw runtime error on screen.
 */
const OAuthExpiredError = memo<OAuthExpiredErrorProps>(({ id, provider }) => {
  const { t } = useTranslation('error');
  const navigate = useWorkspaceAwareNavigate();
  const [deleteMessage] = useConversationStore((s) => [s.deleteMessage]);
  // Re-narrow here too: the prop is a plain string, so this card stays safe wherever it is
  // rendered from, not only through the one call site that already sanitizes.
  const providerId = readErrorProviderId({ provider });
  // A rejected id leaves `useProviderName` with nothing to echo back, and the copy would read
  // "Reconnect " — name the provider generically instead of trailing off mid-sentence.
  const providerName =
    useProviderName(providerId as GlobalLLMProviderKey) || t('unlock.oauthExpired.genericProvider');

  return (
    <BaseErrorForm
      avatar={<ProviderIcon provider={providerId} shape={'square'} size={40} />}
      desc={t('unlock.oauthExpired.description', { name: providerName })}
      title={t('unlock.oauthExpired.title', { name: providerName })}
      action={
        <Button
          type={'primary'}
          onClick={() => {
            // No usable provider id ⇒ the provider list, which is still the right place to
            // reconnect from. Never a half-built path.
            navigate(urlJoin('/settings/provider', providerId || 'all'));
            deleteMessage(id);
          }}
        >
          {t('unlock.oauthExpired.action')}
        </Button>
      }
    />
  );
});

OAuthExpiredError.displayName = 'OAuthExpiredError';

export default OAuthExpiredError;
