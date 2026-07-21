'use client';

import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { AlertCircle, Check } from 'lucide-react';
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

export type IdentityProviderStepState = 'complete' | 'current' | 'error' | 'pending';

interface IdentityProviderWizardNavigationProps {
  onChange: (step: IdentityProviderStep) => void;
  stepStates: Partial<Record<IdentityProviderStep, IdentityProviderStepState>>;
  value: IdentityProviderStep;
}

export const IdentityProviderWizardNavigation = memo<IdentityProviderWizardNavigationProps>(
  ({ onChange, stepStates, value }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.navigation} role="tablist">
        {IDENTITY_PROVIDER_STEPS.map((item, index) => {
          const state = item === value ? 'current' : (stepStates[item] ?? 'pending');
          return (
            <Button
              aria-current={item === value ? 'step' : undefined}
              key={item}
              type={state === 'current' ? 'primary' : 'default'}
              icon={state === 'complete' ? Check : state === 'error' ? AlertCircle : undefined}
              onClick={() => onChange(item)}
            >
              {index + 1}. {t(`identityProviders.steps.${item}` as never)}
            </Button>
          );
        })}
      </div>
    );
  },
);

IdentityProviderWizardNavigation.displayName = 'IdentityProviderWizardNavigation';
