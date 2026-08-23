'use client';

import { Flexbox, InputNumber, Text } from '@lobehub/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface RollbackRevisionFieldProps {
  currentRevision: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}

const RollbackRevisionField = ({
  currentRevision,
  disabled,
  onChange,
}: RollbackRevisionFieldProps) => {
  const { t } = useTranslation('admin');
  const [value, setValue] = useState<number | null>(null);

  return (
    <Flexbox gap={6}>
      <Text strong>{t('connectorCatalog.mutations.rollback.target')}</Text>
      <InputNumber
        disabled={disabled}
        min={1}
        precision={0}
        value={value}
        onChange={(next) => {
          const revision = typeof next === 'number' ? next : null;
          setValue(revision);
          onChange(revision);
        }}
      />
      <Text type="secondary">
        {t('connectorCatalog.mutations.rollback.current', { revision: currentRevision })}
      </Text>
    </Flexbox>
  );
};

export default RollbackRevisionField;
