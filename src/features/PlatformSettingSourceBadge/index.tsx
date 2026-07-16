'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Building2, RotateCcw, User } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type PlatformSettingSource = 'builtin' | 'environment' | 'platform' | 'user' | 'legacy';

export interface PlatformSettingSourceBadgeProps {
  /** Optional custom label override. */
  children?: ReactNode;
  /** Hide entirely when path is hidden by policy. */
  hidden?: boolean;
  /** When true, control is managed by organization (locked). */
  locked?: boolean;
  /** Show personal vs organization source when mode is default and user overrode. */
  mode?: 'user' | 'default' | 'locked';
  /** Single-path reset (delete override). */
  onReset?: () => void;
  /** Effective value source. */
  source?: PlatformSettingSource;
}

const styles = createStaticStyles(({ css }) => ({
  badge: css`
    display: inline-flex;
    gap: 6px;
    align-items: center;

    padding-block: 2px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadiusSM};

    font-size: 12px;
    line-height: 1.4;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};
  `,
  locked: css`
    color: ${cssVar.colorWarning};
    background: ${cssVar.colorWarningBg};
  `,
  root: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
}));

/**
 * Reusable source / managed badge for registered platform settings in user UI.
 * UI hiding never replaces server enforcement — locked still requires server deny.
 */
const PlatformSettingSourceBadge = memo<PlatformSettingSourceBadgeProps>(
  ({ locked, hidden, source, mode, onReset, children }) => {
    const { t } = useTranslation('setting');

    if (hidden) return null;

    if (locked) {
      return (
        <div className={styles.root}>
          <span className={`${styles.badge} ${styles.locked}`}>
            <Building2 size={12} />
            <Text as="span" type="warning">
              {t('platformSource.managedByOrg')}
            </Text>
          </span>
          {children}
        </div>
      );
    }

    const showOrgDefault = mode === 'default' && source === 'platform';
    const showPersonal = mode === 'default' && source === 'user';

    if (!showOrgDefault && !showPersonal && !children) return null;

    return (
      <div className={styles.root}>
        {showOrgDefault ? (
          <span className={styles.badge}>
            <Building2 size={12} />
            {t('platformSource.organizationDefault')}
          </span>
        ) : null}
        {showPersonal ? (
          <Flexbox horizontal align="center" gap={6}>
            <span className={styles.badge}>
              <User size={12} />
              {t('platformSource.personal')}
            </span>
            {onReset ? (
              <Button size="small" type="text" onClick={onReset}>
                <RotateCcw size={12} style={{ marginInlineEnd: 4 }} />
                {t('platformSource.resetToOrg')}
              </Button>
            ) : null}
          </Flexbox>
        ) : null}
        {children}
      </div>
    );
  },
);

PlatformSettingSourceBadge.displayName = 'PlatformSettingSourceBadge';

export default PlatformSettingSourceBadge;

/**
 * Wrapper that disables children when locked and shows source badge.
 */
export const ManagedSettingControl = memo<{
  children: ReactNode;
  hidden?: boolean;
  locked?: boolean;
  mode?: 'user' | 'default' | 'locked';
  onReset?: () => void;
  source?: PlatformSettingSource;
}>(({ children, hidden, locked, mode, onReset, source }) => {
  if (hidden) return null;

  return (
    <Flexbox gap={6}>
      <PlatformSettingSourceBadge locked={locked} mode={mode} source={source} onReset={onReset} />
      <div style={{ opacity: locked ? 0.6 : 1, pointerEvents: locked ? 'none' : undefined }}>
        {children}
      </div>
    </Flexbox>
  );
});

ManagedSettingControl.displayName = 'ManagedSettingControl';
