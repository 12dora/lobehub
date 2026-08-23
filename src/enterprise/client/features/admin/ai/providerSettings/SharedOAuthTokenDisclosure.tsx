'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SharedOAuthTokenDisclosureProps {
  onSubmit: () => void;
  onToggle: () => void;
  open: boolean;
  sectionId: string;
  sessionFields: ReactNode;
  sessionSteps: ReactNode;
  submitDisabled: boolean;
  submitting?: boolean;
}

/**
 * The second route of the paste flow, kept behind a disclosure: a pasted web session (or a
 * bare access token) instead of the callback URL. Secondary here because the provider's own
 * authorization page is the route most operators can complete.
 */
const SharedOAuthTokenDisclosure = memo<SharedOAuthTokenDisclosureProps>(
  ({
    onSubmit,
    onToggle,
    open,
    sectionId,
    sessionFields,
    sessionSteps,
    submitDisabled,
    submitting,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={8}>
        <Flexbox horizontal>
          <Button
            aria-controls={sectionId}
            aria-expanded={open}
            size={'small'}
            type={'text'}
            onClick={onToggle}
          >
            {t('aiProviderSettings.sharedOAuth.paste.sessionToggle')}
          </Button>
        </Flexbox>
        {open && (
          <Flexbox gap={8} id={sectionId}>
            {sessionFields}
            {sessionSteps}
            <Flexbox horizontal>
              <Button disabled={submitDisabled} loading={submitting} onClick={onSubmit}>
                {t('aiProviderSettings.sharedOAuth.paste.sessionSubmit')}
              </Button>
            </Flexbox>
          </Flexbox>
        )}
      </Flexbox>
    );
  },
);

SharedOAuthTokenDisclosure.displayName = 'AdminSharedOAuthTokenDisclosure';

export default SharedOAuthTokenDisclosure;
