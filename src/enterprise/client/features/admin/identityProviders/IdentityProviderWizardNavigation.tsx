'use client';

import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  navigation: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;

    padding-block-end: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

export const IDENTITY_PROVIDER_STEPS = [
  'basic',
  'discovery',
  'client',
  'claims',
  'policy',
  'test',
  'publish',
] as const;

export type IdentityProviderStep = (typeof IDENTITY_PROVIDER_STEPS)[number];

interface IdentityProviderWizardNavigationProps {
  onChange: (step: IdentityProviderStep) => void;
  value: IdentityProviderStep;
}

export const IdentityProviderWizardNavigation = memo<IdentityProviderWizardNavigationProps>(
  ({ onChange, value }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.navigation}>
        {IDENTITY_PROVIDER_STEPS.map((item, index) => (
          <Button
            key={item}
            type={item === value ? 'primary' : 'default'}
            onClick={() => onChange(item)}
          >
            {index + 1}. {t(`identityProviders.steps.${item}` as never)}
          </Button>
        ))}
      </div>
    );
  },
);

IdentityProviderWizardNavigation.displayName = 'IdentityProviderWizardNavigation';
