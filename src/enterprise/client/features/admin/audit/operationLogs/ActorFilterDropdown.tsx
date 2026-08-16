'use client';

import type { FilterDropdownProps } from 'antd/es/table/interface';
import { createStaticStyles } from 'antd-style';
import { useTranslation } from 'react-i18next';

import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';

const styles = createStaticStyles(({ css }) => ({
  dropdown: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    min-width: 240px;
    padding: 8px;
  `,
}));

export const ActorFilterDropdown = ({
  confirm,
  enabled,
  onChange,
  value,
}: FilterDropdownProps & {
  enabled: boolean;
  onChange: (userId: string | undefined) => void;
  value?: string;
}) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.dropdown}>
      <AuditUserSearchSelect
        enabled={enabled}
        placeholder={t('audit.logs.filters.actor')}
        style={{ minWidth: 0, width: '100%' }}
        value={value}
        onChange={(userId) => {
          onChange(userId);
          confirm({ closeDropdown: true });
        }}
      />
    </div>
  );
};
