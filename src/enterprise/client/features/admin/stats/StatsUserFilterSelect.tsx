'use client';

import { Avatar, Flexbox, Icon, Text } from '@lobehub/ui';
import { AutoComplete } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { UserIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR } from '@/const/meta';
import type { AdminUsersListOutput } from '@/enterprise/client/services/adminUsers';
import { adminUsersService } from '@/enterprise/client/services/adminUsers';

type AdminUserListItem = AdminUsersListOutput['items'][number];

const DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 20;

/** Display label for a user row — never the raw email alone. */
export const displayStatsUserLabel = (user: {
  email?: string | null;
  fullName?: string | null;
  id: string;
  username?: string | null;
}): string => user.fullName || user.username || user.email || user.id;

export interface StatsUserFilterSelectProps {
  onChange: (userId: string | undefined, name?: string) => void;
  /** Currently selected user id. */
  value?: string;
  /** Known display name for `value`, so the input is labelled before any search runs. */
  valueLabel?: string;
}

/**
 * Fuzzy user picker for the admin stats page. Searches `admin.users.list`
 * (requires USER_READ) with a 300ms debounce; clearing the input restores the
 * "all users" default. An admin without USER_READ gets an inline hint instead of
 * a silently empty dropdown.
 */
const StatsUserFilterSelect = memo<StatsUserFilterSelectProps>(
  ({ onChange, value, valueLabel }) => {
    const { t } = useTranslation('admin');
    const [options, setOptions] = useState<{ label: React.ReactNode; value: string }[]>([]);
    const [inputValue, setInputValue] = useState(valueLabel ?? '');
    const [errorHint, setErrorHint] = useState<string | null>(null);
    // base-ui AutoComplete opens on click; only surface the popup once there are matches.
    const [open, setOpen] = useState(false);
    const debounceRef = useRef<number | null>(null);
    /** Monotonic request id — only the latest in-flight search may apply results. */
    const requestIdRef = useRef(0);
    const mountedRef = useRef(true);
    const usersById = useRef(new Map<string, AdminUserListItem>());

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        requestIdRef.current += 1;
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
      };
    }, []);

    useEffect(() => {
      if (!value) setInputValue('');
      else if (valueLabel) setInputValue(valueLabel);
      else if (usersById.current.has(value)) {
        setInputValue(displayStatsUserLabel(usersById.current.get(value)!));
      }
    }, [value, valueLabel]);

    const runSearch = useCallback(
      async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) {
          requestIdRef.current += 1;
          setOptions([]);
          setErrorHint(null);
          return;
        }
        const requestId = ++requestIdRef.current;
        try {
          const result = await adminUsersService.list({ limit: SEARCH_LIMIT, query: trimmed });
          if (!mountedRef.current || requestId !== requestIdRef.current) return;
          setErrorHint(null);
          for (const item of result.items) usersById.current.set(item.id, item);
          setOptions(
            result.items.map((item) => ({
              label: (
                <Flexbox horizontal align={'center'} gap={8}>
                  <Avatar
                    alt={displayStatsUserLabel(item)}
                    avatar={item.avatar || DEFAULT_AVATAR}
                    size={20}
                  />
                  <span>{displayStatsUserLabel(item)}</span>
                  {item.email ? (
                    <span style={{ color: cssVar.colorTextTertiary, fontSize: 12 }}>
                      {item.email}
                    </span>
                  ) : null}
                </Flexbox>
              ),
              value: item.id,
            })),
          );
        } catch {
          if (!mountedRef.current || requestId !== requestIdRef.current) return;
          // The most likely failure here is a missing USER_READ grant — say so and
          // keep "all users" selected rather than leaving an empty popup.
          setErrorHint(t('stats.userFilter.searchFailed'));
          setOptions([]);
        }
      },
      [t],
    );

    const scheduleSearch = useCallback(
      (query: string) => {
        if (debounceRef.current) window.clearTimeout(debounceRef.current);
        debounceRef.current = window.setTimeout(() => void runSearch(query), DEBOUNCE_MS);
      },
      [runSearch],
    );

    const clear = useCallback(() => {
      requestIdRef.current += 1;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      setInputValue('');
      setOptions([]);
      setErrorHint(null);
      setOpen(false);
      onChange(undefined);
    }, [onChange]);

    /**
     * base-ui's AutoComplete exposes ONE signal: `onValueChange` fans the same string out
     * to `onChange` **and** `onSearch` (see `@lobehub/ui/base-ui/AutoComplete`). Handling
     * both would run the selection branch and then immediately overwrite the committed
     * name with the raw option value (the user id) and reopen the popup — so typing and
     * selection are handled here, once.
     *
     * Typing yields the raw text; picking an option yields `option.value`, i.e. the id of
     * a user we just listed, which is what tells the two apart.
     */
    const handleValueChange = useCallback(
      (next?: string) => {
        const text = next ?? '';
        if (!text.trim()) {
          clear();
          return;
        }
        const picked = usersById.current.get(text);
        if (picked) {
          // Drop the debounced search for the text that was typed before picking:
          // it would land after the commit and reopen the popup over the choice.
          if (debounceRef.current) window.clearTimeout(debounceRef.current);
          requestIdRef.current += 1;
          const name = displayStatsUserLabel(picked);
          setInputValue(name);
          setOpen(false);
          onChange(picked.id, name);
          return;
        }
        setInputValue(text);
        setOpen(true);
        scheduleSearch(text);
      },
      [clear, onChange, scheduleSearch],
    );

    // `filter={null}`: rows are already filtered server-side and base-ui's default
    // filter matches on option.value (the user id), which would hide every match.
    const showDropdown = open && inputValue.trim().length > 0 && options.length > 0;

    // Capped width: the picker now sits in the page action row, where an unbounded
    // error hint would stretch the row instead of wrapping under the input.
    return (
      <Flexbox gap={4} style={{ maxWidth: 280, minWidth: 220 }}>
        <AutoComplete
          allowClear
          filter={null}
          open={showDropdown}
          options={options}
          placeholder={t('stats.userFilter.allUsers')}
          prefix={<Icon icon={UserIcon} size={16} />}
          style={{ width: '100%' }}
          value={inputValue}
          onChange={handleValueChange}
          onOpenChange={setOpen}
        />
        {errorHint ? (
          <Text role="status" style={{ fontSize: 12 }} type="secondary">
            {errorHint}
          </Text>
        ) : null}
      </Flexbox>
    );
  },
);

StatsUserFilterSelect.displayName = 'StatsUserFilterSelect';

export default StatsUserFilterSelect;
