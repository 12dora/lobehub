'use client';

import { Button, Input, Select } from '@lobehub/ui/base-ui';
import type { FilterDropdownProps } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { auditTargetTypeLabel } from '../shared/format';
import { AUDIT_LOG_TARGET_TYPES } from './targetTypes';

const styles = createStaticStyles(({ css }) => ({
  dropdown: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    min-width: 240px;
    padding: 8px;
  `,
  filterActions: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
}));

export const TargetFilterDropdown = ({
  clearFilters,
  confirm,
  onApply,
  targetId,
  targetType,
}: FilterDropdownProps & {
  onApply: (next: { targetId?: string; targetType?: string }) => void;
  targetId?: string;
  targetType?: string;
}) => {
  const { t } = useTranslation('admin');
  const [typeDraft, setTypeDraft] = useState(targetType ?? '');
  const [idDraft, setIdDraft] = useState(targetId ?? '');

  const apply = () => {
    onApply({
      targetId: idDraft.trim() || undefined,
      targetType: typeDraft.trim() || undefined,
    });
    confirm({ closeDropdown: true });
  };

  const reset = () => {
    setTypeDraft('');
    setIdDraft('');
    clearFilters?.();
    onApply({ targetId: undefined, targetType: undefined });
    confirm({ closeDropdown: true });
  };

  return (
    <div className={styles.dropdown}>
      <Select
        allowClear
        placeholder={t('audit.logs.filters.targetType')}
        style={{ width: '100%' }}
        value={typeDraft || undefined}
        options={AUDIT_LOG_TARGET_TYPES.map((item) => ({
          label: auditTargetTypeLabel(t, item),
          value: item,
        }))}
        onChange={(value) => setTypeDraft(typeof value === 'string' ? value : '')}
      />
      <Input
        placeholder={t('audit.logs.filters.targetId')}
        value={idDraft}
        onChange={(event) => setIdDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.stopPropagation();
          apply();
        }}
      />
      <div className={styles.filterActions}>
        <Button size="small" type="default" onClick={reset}>
          {t('primitives.columnFilter.reset')}
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          {t('primitives.columnFilter.apply')}
        </Button>
      </div>
    </div>
  );
};
