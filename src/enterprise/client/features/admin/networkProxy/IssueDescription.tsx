'use client';

import { Button } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EngineIssue } from '@/types/platform/networkProxy';

import { networkProxyIssueKey } from './errors';
import { networkProxyStyles as styles } from './styles';

/** The engine's own reason, plus its technical detail folded away behind a toggle. */
const IssueDescription = memo<{ issue: EngineIssue | null }>(({ issue }) => {
  const { t } = useTranslation('admin');
  const [detailOpen, setDetailOpen] = useState(false);
  const detail = issue?.detail ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span>{t(networkProxyIssueKey(issue?.code) as never)}</span>
      {detail ? (
        <div className={styles.inlineActions}>
          <Button size="small" onClick={() => setDetailOpen((open) => !open)}>
            {t('networkProxy.engineIssue.detailToggle')}
          </Button>
          {detailOpen ? <span className={styles.code}>{detail}</span> : null}
        </div>
      ) : null}
    </div>
  );
});
IssueDescription.displayName = 'NetworkProxyIssueDescription';

export default IssueDescription;
