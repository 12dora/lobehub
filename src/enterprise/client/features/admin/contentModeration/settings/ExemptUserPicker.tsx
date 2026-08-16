'use client';

import { Tag, Text } from '@lobehub/ui';
import { AutoComplete, Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminUsersService } from '@/enterprise/client/services/adminUsers';

import { moderationStyles as styles } from '../styles';

const DEBOUNCE_MS = 300;

export interface ExemptUserPickerProps {
  disabled?: boolean;
  /** Whether the current admin may call `admin.users.list` (USER_READ). */
  enabled: boolean;
  onChange: (userIds: string[]) => void;
  value: readonly string[];
}

interface Candidate {
  id: string;
  label: string;
}

/**
 * Exempt-user picker backed by the existing `admin.users.list` identity search (read-only use).
 *
 * A moderation admin does not necessarily hold USER_READ, so when the search is unavailable
 * the control still accepts a pasted user id — the exemption list is ids either way, and
 * silently disabling the field would make the section unusable for that role.
 */
const ExemptUserPicker = memo<ExemptUserPickerProps>(({ disabled, enabled, onChange, value }) => {
  const { t } = useTranslation('admin');
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<{ label: string; value: string }[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      requestRef.current += 1;
    },
    [],
  );

  const search = useCallback(
    async (query: string) => {
      const trimmed = query.trim();
      if (!enabled || trimmed.length === 0) {
        setOptions([]);
        return;
      }
      const requestId = ++requestRef.current;
      try {
        const result = await adminUsersService.list({ limit: 20, query: trimmed });
        if (requestId !== requestRef.current) return;
        setHint(null);
        const candidates: Candidate[] = result.items.map((item) => ({
          id: item.id,
          label: item.fullName?.trim() || item.username?.trim() || item.email?.trim() || item.id,
        }));
        setLabels((prev) => {
          const next = { ...prev };
          for (const item of candidates) next[item.id] = item.label;
          return next;
        });
        setOptions(candidates.map((item) => ({ label: item.label, value: item.id })));
      } catch {
        if (requestId !== requestRef.current) return;
        setHint(t('contentModeration.settings.scope.userSearchFailed'));
        setOptions([]);
      }
    },
    [enabled, t],
  );

  const scheduleSearch = useCallback(
    (query: string) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void search(query);
      }, DEBOUNCE_MS);
    },
    [search],
  );

  const add = (userId: string) => {
    const trimmed = userId.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setInput('');
    setOptions([]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className={styles.toolbarRow}>
        <AutoComplete
          disabled={disabled}
          filter={null}
          options={options}
          placeholder={t('contentModeration.settings.scope.userSearchPlaceholder')}
          style={{ width: 320 }}
          value={input}
          onChange={(next) => {
            const text = next ?? '';
            setInput(text);
            if (options.some((option) => option.value === text)) {
              add(text);
              return;
            }
            scheduleSearch(text);
          }}
          onSearch={(query) => {
            setInput(query);
            scheduleSearch(query);
          }}
        />
        <Button disabled={disabled || !input.trim()} size="small" onClick={() => add(input)}>
          {t('contentModeration.settings.scope.addUser')}
        </Button>
      </div>
      {hint ? <Text type="secondary">{hint}</Text> : null}
      {!enabled ? (
        <Text className={styles.hintText}>
          {t('contentModeration.settings.scope.userSearchNoPermission')}
        </Text>
      ) : null}
      <div className={styles.formRow}>
        {value.length === 0 ? (
          <Text className={styles.hintText}>
            {t('contentModeration.settings.scope.noExemptUsers')}
          </Text>
        ) : (
          value.map((userId) => (
            <Tag
              closable={!disabled}
              key={userId}
              onClose={() => onChange(value.filter((item) => item !== userId))}
            >
              {labels[userId] ?? userId}
            </Tag>
          ))
        )}
      </div>
    </div>
  );
});

ExemptUserPicker.displayName = 'ModerationExemptUserPicker';

export default ExemptUserPicker;
