'use client';

import { AutoComplete } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditUserSearchItem } from '@/enterprise/client/services/adminAudit';
import { adminAuditService } from '@/enterprise/client/services/adminAudit';

import { displayAuditUserLabel } from './format';

const DEBOUNCE_MS = 300;

export interface AuditUserSearchSelectProps {
  allowClear?: boolean;
  disabled?: boolean;
  enabled?: boolean;
  onChange: (userId: string | undefined, user?: AdminAuditUserSearchItem) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  value?: string;
  /** Pre-seeded option when value is known but not in search results. */
  valueLabel?: string;
}

/**
 * Remote user search against `admin.audit.users.search` (requires AUDIT_READ).
 * Debounced; does not request when disabled or `enabled=false`.
 */
const AuditUserSearchSelect = memo<AuditUserSearchSelectProps>(
  ({
    allowClear = true,
    disabled,
    enabled = true,
    onChange,
    placeholder,
    style,
    value,
    valueLabel,
  }) => {
    const { t } = useTranslation('admin');
    const [options, setOptions] = useState<{ label: string; value: string }[]>([]);
    const [inputValue, setInputValue] = useState(valueLabel ?? value ?? '');
    const debounceRef = useRef<number | null>(null);
    const usersById = useRef(new Map<string, AdminAuditUserSearchItem>());

    useEffect(() => {
      if (valueLabel) setInputValue(valueLabel);
      else if (value && usersById.current.has(value)) {
        setInputValue(displayAuditUserLabel(usersById.current.get(value)!));
      } else if (!value) {
        setInputValue('');
      }
    }, [value, valueLabel]);

    const runSearch = useCallback(
      async (q: string) => {
        if (!enabled || q.trim().length < 1) {
          setOptions([]);
          return;
        }
        try {
          const result = await adminAuditService.searchUsers({ limit: 20, q: q.trim() });
          for (const item of result.items) {
            usersById.current.set(item.id, item);
          }
          setOptions(
            result.items.map((item) => ({
              label: [
                displayAuditUserLabel(item),
                item.email ? `(${item.email})` : null,
                item.username ? `@${item.username}` : null,
              ]
                .filter(Boolean)
                .join(' '),
              value: item.id,
            })),
          );
        } catch {
          setOptions([]);
        }
      },
      [enabled],
    );

    const scheduleSearch = useCallback(
      (q: string) => {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => {
          void runSearch(q);
        }, DEBOUNCE_MS);
      },
      [runSearch],
    );

    useEffect(
      () => () => {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
      },
      [],
    );

    return (
      <AutoComplete
        allowClear={allowClear}
        disabled={disabled || !enabled}
        options={options}
        placeholder={placeholder ?? t('audit.shared.userSearchPlaceholder')}
        style={style ?? { minWidth: 220 }}
        value={inputValue}
        onChange={(next) => {
          const text = next ?? '';
          setInputValue(text);
          // Selecting an option sets value to the option value (user id)
          if (usersById.current.has(text)) {
            onChange(text, usersById.current.get(text));
            setInputValue(displayAuditUserLabel(usersById.current.get(text)!));
            return;
          }
          // Match by label
          const byLabel = options.find((o) => o.label === text);
          if (byLabel) {
            onChange(byLabel.value, usersById.current.get(byLabel.value));
            return;
          }
          if (!text.trim()) {
            onChange(undefined);
          }
          scheduleSearch(text);
        }}
        onSearch={(q) => {
          setInputValue(q);
          scheduleSearch(q);
        }}
      />
    );
  },
);

AuditUserSearchSelect.displayName = 'AuditUserSearchSelect';

export default AuditUserSearchSelect;
