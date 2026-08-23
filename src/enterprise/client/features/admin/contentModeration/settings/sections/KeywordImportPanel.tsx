'use client';

import { Text } from '@lobehub/ui';
import { Button, TextArea } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { moderationStyles as styles } from '../../styles';
import type { ParsedKeywordImport } from '../draft';

export interface KeywordImportPanelProps {
  disabled: boolean;
  importText: string;
  onApply: () => void;
  onCancel: () => void;
  onImportTextChange: (text: string) => void;
  /** What the pasted block would actually insert, recomputed as it is typed. */
  preview: ParsedKeywordImport | null;
}

/** Batch import: paste a block, see exactly what it would add, then apply it. */
const KeywordImportPanel = memo<KeywordImportPanelProps>(
  ({ disabled, importText, onApply, onCancel, onImportTextChange, preview }) => {
    const { t } = useTranslation('admin');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Text className={styles.hintText}>
          {t('contentModeration.settings.keywords.importHint')}
        </Text>
        <TextArea
          aria-label={t('contentModeration.settings.keywords.import')}
          disabled={disabled}
          rows={5}
          value={importText}
          onChange={(event) => onImportTextChange(event.target.value)}
        />
        <div className={styles.toolbarRow}>
          <Text className={styles.hintText} data-testid="keyword-import-preview">
            {t('contentModeration.settings.keywords.importPreview', {
              capacity: preview?.skippedByCapacity ?? 0,
              duplicates: preview?.skippedDuplicates ?? 0,
              invalid: preview?.invalidLines.length ?? 0,
              valid: preview?.rules.length ?? 0,
            })}
          </Text>
          <Button disabled={disabled} size="small" type="primary" onClick={onApply}>
            {t('contentModeration.settings.keywords.importApply')}
          </Button>
          <Button size="small" type="text" onClick={onCancel}>
            {t('contentModeration.settings.keywords.importCancel')}
          </Button>
        </div>
      </div>
    );
  },
);
KeywordImportPanel.displayName = 'ModerationKeywordImportPanel';

export default KeywordImportPanel;
