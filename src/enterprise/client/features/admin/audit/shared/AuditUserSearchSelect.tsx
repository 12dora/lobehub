'use client';

import { Select } from '@lobehub/ui/base-ui';
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
    const [options, setOptions] = useState<
      { label: string; value: string; user: AdminAuditUserSearchItem }[]
    >([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const debounceRef = useRef<number | null>(null);
    const usersById = useRef(new Map<string, AdminAuditUserSearchItem>());

    const runSearch = useCallback(
      async (q: string) => {
        if (!enabled || q.trim().length < 1) {
          setOptions([]);
          return;
        }
        setLoading(true);
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
              user: item,
              value: item.id,
            })),
          );
        } catch {
          setOptions([]);
        } finally {
          setLoading(false);
        }
      },
      [enabled],
    );

    useEffect(() => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (!enabled) return;
      debounceRef.current = window.setTimeout(() => {
        void runSearch(search);
      }, DEBOUNCE_MS);
      return () => {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
      };
    }, [enabled, runSearch, search]);

    const mergedOptions =
      value && valueLabel && !options.some((o) => o.value === value)
        ? [{ label: valueLabel, value }, ...options]
        : options;

    return (
      <Select
        showSearch
        allowClear={allowClear}
        disabled={disabled || !enabled}
        filterOption={false}
        loading={loading}
        options={mergedOptions}
        placeholder={placeholder ?? t('audit.shared.userSearchPlaceholder')}
        style={style ?? { minWidth: 220 }}
        value={value}
        onSearch={(q) => setSearch(q)}
        onChange={(next) => {
          const id = (next as string | null | undefined) || undefined;
          onChange(id, id ? usersById.current.get(id) : undefined);
        }}
      />
    );
  },
);

AuditUserSearchSelect.displayName = 'AuditUserSearchSelect';

export default AuditUserSearchSelect;
