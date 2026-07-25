'use client';

import { AutoComplete } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditUserSearchItem } from '@/enterprise/client/services/adminAudit';
import { adminAuditService } from '@/enterprise/client/services/adminAudit';

import { displayAuditUserLabel } from './format';

const DEBOUNCE_MS = 300;
/** Synthetic option value for free-form ID fallback (must not collide with real user ids). */
const USE_TYPED_PREFIX = '__use_typed__:';

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
 * Always allows free-form user ID entry as a fallback (legal holds / offline search).
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
    const [errorHint, setErrorHint] = useState<string | null>(null);
    // Only open the dropdown once the user has typed something. Base-ui AutoComplete
    // sets openOnInputClick:true, which otherwise pops an empty result box on focus.
    const [open, setOpen] = useState(false);
    const debounceRef = useRef<number | null>(null);
    /** Monotonic request id — only the latest in-flight search may apply results. */
    const requestIdRef = useRef(0);
    const mountedRef = useRef(true);
    const usersById = useRef(new Map<string, AdminAuditUserSearchItem>());

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    useEffect(() => {
      if (valueLabel) setInputValue(valueLabel);
      else if (value && usersById.current.has(value)) {
        setInputValue(displayAuditUserLabel(usersById.current.get(value)!));
      } else if (value) {
        setInputValue(value);
      } else if (!value) {
        setInputValue('');
      }
    }, [value, valueLabel]);

    const withTypedFallback = useCallback(
      (base: { label: string; value: string }[], typed: string) => {
        const trimmed = typed.trim();
        if (!trimmed) return base;
        const useTyped = {
          label: t('audit.shared.userSearchUseId', {
            id: trimmed,
            defaultValue: `Use ID: ${trimmed}`,
          }),
          value: `${USE_TYPED_PREFIX}${trimmed}`,
        };
        if (base.some((o) => o.value === trimmed)) return base;
        return [...base, useTyped];
      },
      [t],
    );

    const runSearch = useCallback(
      async (q: string) => {
        const trimmed = q.trim();
        if (!enabled) {
          // Invalidate any in-flight search so a late response cannot overwrite this state.
          requestIdRef.current += 1;
          setErrorHint(t('audit.shared.userSearchNoPermission'));
          setOptions(withTypedFallback([], trimmed));
          return;
        }
        if (trimmed.length < 1) {
          requestIdRef.current += 1;
          setOptions([]);
          setErrorHint(null);
          return;
        }
        const requestId = ++requestIdRef.current;
        try {
          const result = await adminAuditService.searchUsers({ limit: 20, q: trimmed });
          if (!mountedRef.current || requestId !== requestIdRef.current) return;
          setErrorHint(null);
          for (const item of result.items) {
            usersById.current.set(item.id, item);
          }
          const mapped = result.items.map((item) => ({
            label: [
              displayAuditUserLabel(item),
              item.email ? `(${item.email})` : null,
              item.username ? `@${item.username}` : null,
            ]
              .filter(Boolean)
              .join(' '),
            value: item.id,
          }));
          setOptions(withTypedFallback(mapped, trimmed));
        } catch {
          if (!mountedRef.current || requestId !== requestIdRef.current) return;
          setErrorHint(t('audit.shared.userSearchFailed'));
          setOptions(withTypedFallback([], trimmed));
        }
      },
      [enabled, t, withTypedFallback],
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
        // Invalidate in-flight responses on unmount.
        requestIdRef.current += 1;
      },
      [],
    );

    const commitValue = useCallback(
      (raw: string) => {
        const text = raw ?? '';
        if (text.startsWith(USE_TYPED_PREFIX)) {
          const id = text.slice(USE_TYPED_PREFIX.length).trim();
          setInputValue(id);
          onChange(id || undefined);
          setOpen(false);
          return;
        }
        if (usersById.current.has(text)) {
          onChange(text, usersById.current.get(text));
          setInputValue(displayAuditUserLabel(usersById.current.get(text)!));
          setOpen(false);
          return;
        }
        const byLabel = options.find(
          (o) => o.label === text && !o.value.startsWith(USE_TYPED_PREFIX),
        );
        if (byLabel) {
          onChange(byLabel.value, usersById.current.get(byLabel.value));
          setOpen(false);
          return;
        }
        // Free-form: treat current text as user id
        const id = text.trim();
        onChange(id || undefined);
      },
      [onChange, options],
    );

    // `filter={null}`: results are already filtered server-side; base-ui's default filter
    // matches the query against each option's value (the user id), which would hide every
    // real match and leave only the "Use ID" row.
    // `open`: only surface the popup once a query has matches (no empty box on focus).
    const showDropdown = open && inputValue.trim().length > 0 && options.length > 0;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220, ...style }}>
        <AutoComplete
          allowClear={allowClear}
          disabled={disabled}
          filter={null}
          open={showDropdown}
          options={options}
          placeholder={placeholder ?? t('audit.shared.userSearchPlaceholder')}
          style={{ width: '100%' }}
          value={inputValue}
          onOpenChange={setOpen}
          onChange={(next) => {
            const text = next ?? '';
            setInputValue(text);
            if (!text.trim()) {
              requestIdRef.current += 1;
              if (debounceRef.current) window.clearTimeout(debounceRef.current);
              onChange(undefined);
              setOptions([]);
              setErrorHint(null);
              setOpen(false);
              return;
            }
            // Immediate commit when user picks an option value (id or use-typed)
            if (text.startsWith(USE_TYPED_PREFIX) || usersById.current.has(text)) {
              commitValue(text);
              return;
            }
            setOpen(true);
            scheduleSearch(text);
          }}
          onSearch={(q) => {
            setInputValue(q);
            setOpen(q.trim().length > 0);
            scheduleSearch(q);
          }}
        />
        {errorHint ? (
          <span role="status" style={{ fontSize: 12, opacity: 0.75 }}>
            {errorHint}
          </span>
        ) : null}
      </div>
    );
  },
);

AuditUserSearchSelect.displayName = 'AuditUserSearchSelect';

export default AuditUserSearchSelect;
