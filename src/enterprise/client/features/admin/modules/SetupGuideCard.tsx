'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { dismissSetupGuide, isSetupGuideDismissed } from './setupGuideDismissal';
import { useAdminModules } from './useAdminModules';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  root: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: center;
    justify-content: space-between;

    padding: 16px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorPrimaryBg};
  `,
  steps: css`
    margin: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  text: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    min-width: 240px;
  `,
}));

/**
 * First-run banner on the overview: a fresh deployment has every module on, which is right as
 * a default but rarely right as a decision. Shown only while the module settings carry no
 * `setupCompletedAt`, and only to someone who can actually act on it (SYSTEM_READ).
 *
 * "稍后再说" hides it for this browser session only (shared with the wizard's own exit) — the
 * deployment is still unconfigured, so the reminder should come back next session rather than
 * disappear silently.
 */
const SetupGuideCard = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { permissions, status } = useAdminAccess();
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());

  const canRead = permissions.includes(PLATFORM_PERMISSIONS.SYSTEM_READ);
  const { data } = useAdminModules(status === 'allowed' && canRead && !dismissed);

  if (!canRead || dismissed || !data || data.snapshot.setupCompletedAt !== null) return null;

  return (
    <section className={styles.root}>
      <div className={styles.text}>
        <Text strong>{t('modules.guide.title')}</Text>
        <p className={styles.steps}>{t('modules.guide.steps')}</p>
      </div>
      <div className={styles.actions}>
        <Button
          type="text"
          onClick={() => {
            dismissSetupGuide();
            setDismissed(true);
          }}
        >
          {t('modules.guide.later')}
        </Button>
        <Button type="primary" onClick={() => navigate('/admin/system/modules?wizard=1')}>
          {t('modules.guide.action')}
        </Button>
      </div>
    </section>
  );
});

SetupGuideCard.displayName = 'AdminSetupGuideCard';

export default SetupGuideCard;
