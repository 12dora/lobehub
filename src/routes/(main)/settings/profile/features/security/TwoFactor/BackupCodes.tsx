'use client';

import { copyToClipboard, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { securityStyles } from '../styles';

const styles = createStaticStyles(({ css }) => ({
  code: css`
    user-select: all;
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSize};
    letter-spacing: 0.04em;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px 12px;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  saveActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
}));

interface BackupCodesProps {
  /** The caller's forward action, placed in this block's own action row. */
  actions?: ReactNode;
  codes: string[];
  /** Runtime brand, used to name the downloaded file; falls back to a neutral stem. */
  downloadName?: string;
}

/**
 * A customised brand name can carry spaces, punctuation or non-ASCII — none of which
 * belong in a filename that has to survive every OS the codes get saved on.
 */
const toFilenameStem = (name: string | undefined): string =>
  (name || '').replaceAll(/[^\w-]+/g, '-').replaceAll(/^-+|-+$/g, '') || 'two-factor';

/**
 * The recovery codes themselves. Rendered in full (never masked, never re-fetchable) —
 * this is the one moment they exist in the user's hands, so both Copy and Download are
 * offered rather than assuming a clipboard is available where they will keep them.
 *
 * Self-contained (a block, not a fragment) and it hosts the caller's forward action, so the
 * screen ends in one action row rather than two stacked ones.
 */
const BackupCodes = memo<BackupCodesProps>(({ actions, codes, downloadName }) => {
  const { t } = useTranslation('auth');

  const handleCopy = useCallback(async () => {
    await copyToClipboard(codes.join('\n'));
    toast.success(t('profile.security.twoFactor.backupCodes.copied'));
  }, [codes, t]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.download = `${toFilenameStem(downloadName)}-recovery-codes.txt`;
    anchor.href = url;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [codes, downloadName]);

  return (
    <div className={securityStyles.section}>
      <Text className={securityStyles.desc}>
        {t('profile.security.twoFactor.backupCodes.desc')}
      </Text>
      <div className={styles.grid}>
        {codes.map((code) => (
          <code className={styles.code} key={code}>
            {code}
          </code>
        ))}
      </div>
      <div className={securityStyles.footerSpread}>
        <div className={styles.saveActions}>
          <Button size="small" onClick={() => void handleCopy()}>
            {t('profile.security.twoFactor.backupCodes.copy')}
          </Button>
          <Button size="small" onClick={handleDownload}>
            {t('profile.security.twoFactor.backupCodes.download')}
          </Button>
        </div>
        {actions}
      </div>
    </div>
  );
});

BackupCodes.displayName = 'TwoFactorBackupCodes';

export default BackupCodes;
