'use client';

import { DatePicker, Text } from '@lobehub/ui';
import { Input, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import dayjs, { type Dayjs } from 'dayjs';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
}));

export type BanMode = 'permanent' | 'temporary';

export const BanExtraFields = memo<{
  expiresAt: Dayjs | null;
  locked: boolean;
  mode: BanMode;
  onExpiresAtChange: (v: Dayjs | null) => void;
  onModeChange: (mode: BanMode) => void;
}>(({ mode, expiresAt, locked, onModeChange, onExpiresAtChange }) => {
  const { t: tr } = useTranslation('admin');
  return (
    <div className={styles.field}>
      <Text>{tr('users.modals.ban.duration')}</Text>
      <Select
        disabled={locked}
        value={mode}
        options={[
          { label: tr('users.modals.ban.permanent'), value: 'permanent' },
          { label: tr('users.modals.ban.temporary'), value: 'temporary' },
        ]}
        onChange={(value) => {
          onModeChange(value === 'temporary' ? 'temporary' : 'permanent');
        }}
      />
      {mode === 'temporary' ? (
        <DatePicker
          showTime
          aria-label={tr('users.modals.ban.expiryLabel')}
          disabled={locked}
          disabledDate={(d) => d.isBefore(dayjs(), 'day')}
          placeholder={tr('primitives.datePicker.placeholder')}
          size="small"
          value={expiresAt}
          onChange={(v) => onExpiresAtChange(v as Dayjs | null)}
        />
      ) : null}
    </div>
  );
});
BanExtraFields.displayName = 'BanExtraFields';

export type BanExtraState = {
  expiresAt: Dayjs | null;
  mode: BanMode;
};

export const validateBanExtra = (
  banState: BanExtraState,
): 'users.modals.ban.expiryRequired' | 'users.modals.ban.expiryFuture' | null => {
  if (banState.mode === 'permanent') return null;
  if (!banState.expiresAt) return 'users.modals.ban.expiryRequired';
  if (!banState.expiresAt.isAfter(dayjs())) return 'users.modals.ban.expiryFuture';
  return null;
};

export const createBanExtra = (
  banState: BanExtraState,
  options: { displayName: string; prefix?: ReactNode },
) => {
  const ControlledBan = memo<{ locked: boolean; reportExtraChange: () => void }>(
    ({ locked, reportExtraChange }) => {
      const [m, setM] = useState<BanMode>('permanent');
      const [exp, setExp] = useState<Dayjs | null>(null);
      const fields = (
        <BanExtraFields
          expiresAt={exp}
          locked={locked}
          mode={m}
          onExpiresAtChange={(next) => {
            setExp(next);
            banState.expiresAt = next;
            reportExtraChange();
          }}
          onModeChange={(next) => {
            setM(next);
            banState.mode = next;
            if (next === 'permanent') {
              setExp(null);
              banState.expiresAt = null;
            }
            reportExtraChange();
          }}
        />
      );
      if (!options.prefix) return fields;
      return (
        <div className={styles.field}>
          {options.prefix}
          {fields}
        </div>
      );
    },
  );
  ControlledBan.displayName = options.displayName;
  return ControlledBan;
};

export type TypeToConfirmState = {
  confirmText: string;
};

export const createTypeToConfirmExtra = (
  state: TypeToConfirmState,
  options: {
    ariaLabelKey: string;
    displayName: string;
    hintKey: string;
    hintParams?: Record<string, unknown>;
    placeholder: string;
    prefix?: ReactNode;
  },
) => {
  const ControlledDeleteConfirm = memo<{ locked: boolean; reportExtraChange: () => void }>(
    ({ locked, reportExtraChange }) => {
      const { t: tr } = useTranslation('admin');
      const [text, setText] = useState('');
      return (
        <div className={styles.field}>
          {options.prefix}
          <Text type="danger">{tr(options.hintKey as never, options.hintParams)}</Text>
          <Input
            aria-label={tr(options.ariaLabelKey as never)}
            disabled={locked}
            placeholder={options.placeholder}
            value={text}
            onChange={(e) => {
              const next = e.target.value;
              setText(next);
              state.confirmText = next;
              reportExtraChange();
            }}
          />
        </div>
      );
    },
  );
  ControlledDeleteConfirm.displayName = options.displayName;
  return ControlledDeleteConfirm;
};
