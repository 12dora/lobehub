'use client';

import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { AlertCircle, Check } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  extra: css`
    flex-shrink: 0;
  `,
  navigation: css`
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 6px;

    min-width: 0;
  `,
  wrap: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block-end: 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

export const IDENTITY_PROVIDER_STEPS = [
  'basic',
  'discovery',
  'client',
  'claims',
  'policy',
  'publish',
] as const;

export type IdentityProviderStep = (typeof IDENTITY_PROVIDER_STEPS)[number];

export type IdentityProviderStepState = 'complete' | 'current' | 'error' | 'pending';

interface IdentityProviderWizardNavigationProps {
  /** Optional trailing slot (status tag when the wizard is embedded). */
  extra?: ReactNode;
  onChange: (step: IdentityProviderStep) => void;
  /** Visible steps. Kinds with a fixed protocol drop discovery/claims. */
  steps?: readonly IdentityProviderStep[];
  stepStates: Partial<Record<IdentityProviderStep, IdentityProviderStepState>>;
  value: IdentityProviderStep;
}

export const IdentityProviderWizardNavigation = memo<IdentityProviderWizardNavigationProps>(
  ({ extra, onChange, steps = IDENTITY_PROVIDER_STEPS, stepStates, value }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.wrap}>
        <div className={styles.navigation} role="tablist">
          {steps.map((item, index) => {
            const state = item === value ? 'current' : (stepStates[item] ?? 'pending');
            return (
              <Button
                aria-current={item === value ? 'step' : undefined}
                icon={state === 'complete' ? Check : state === 'error' ? AlertCircle : undefined}
                key={item}
                type={state === 'current' ? 'primary' : 'default'}
                onClick={() => onChange(item)}
              >
                {index + 1}. {t(`identityProviders.steps.${item}` as never)}
              </Button>
            );
          })}
        </div>
        {extra ? <div className={styles.extra}>{extra}</div> : null}
      </div>
    );
  },
);

IdentityProviderWizardNavigation.displayName = 'IdentityProviderWizardNavigation';
