// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeywordRule } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import type { ModerationSettingsBundle } from '../types';
import SettingsTab from './SettingsTab';

const KEYWORD_COUNT = 10_000;

const rules = (): KeywordRule[] =>
  Array.from({ length: KEYWORD_COUNT }, (_, index) => ({
    action: 'log' as const,
    category: 'other' as const,
    enabled: true,
    id: `rule-${index}`,
    isRegex: true,
    pattern: `term-${index}`,
  }));

const bundle = (): ModerationSettingsBundle =>
  ({
    catalog: [],
    roles: [],
    settings: {
      ...createDefaultContentModerationConfig(),
      keywords: rules(),
      revision: 1,
      updatedAt: new Date('2026-08-17T00:00:00.000Z'),
      updatedBy: null,
    },
  }) as unknown as ModerationSettingsBundle;

const mocks = vi.hoisted(() => ({
  fetch: {
    data: undefined as unknown,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  /** Last `onPatch` handed to the keyword section — the test drives edits through it. */
  patchKeywords: undefined as ((keywords: KeywordRule[]) => void) | undefined,
  /** Patch handed to a non-keyword section, for the "already dirty" half of the mixed state. */
  patchMode: undefined as (() => void) | undefined,
  toastError: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ message, ...rest }: { message?: ReactNode }) => <div {...rest}>{message}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Skeleton: { Block: () => <div /> },
  Text: ({ children, ...rest }: { children?: ReactNode }) => <span {...rest}>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: { error: mocks.toastError, success: vi.fn() },
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));
vi.mock('../hooks', () => ({
  invalidateModerationOverview: vi.fn(),
  useModerationSettings: () => mocks.fetch,
}));
vi.mock('../service', () => ({
  adminContentModerationService: {
    clearDecisionCache: vi.fn(),
    updateSettings: (...args: unknown[]) => mocks.updateSettings(...args),
  },
}));
vi.mock('../../primitives/DangerConfirm', () => ({ openDangerConfirm: vi.fn() }));
vi.mock('../../primitives/runAdminMutation', () => ({
  runAdminMutation: async ({ run }: { run: () => Promise<void> }) => {
    await run();
    return true;
  },
}));
vi.mock('../../primitives/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: vi.fn() }));

// `vi.mock` factories are hoisted, so the shared stub has to be hoisted with them.
const { inert } = vi.hoisted(() => ({ inert: { default: () => <div /> } }));
vi.mock('./sections/BasicSection', () => ({
  default: (props: { onPatch: (patch: Record<string, unknown>) => void }) => {
    mocks.patchMode = () => props.onPatch({ mode: 'observe' });
    return <div data-testid="section-basic" />;
  },
}));
vi.mock('./sections/ScopeSection', () => inert);
vi.mock('./sections/ClassifierSection', () => inert);
vi.mock('./sections/CategoriesSection', () => inert);
vi.mock('./sections/CacheSection', () => inert);
vi.mock('./sections/AutoBanSection', () => inert);
vi.mock('./sections/RecordsSection', () => inert);

// The real section is exercised by its own test; here only the edit → state path matters, so the
// stub records the patch callback and the current rule array without mounting 10,000 editors.
vi.mock('./sections/KeywordsSection', () => ({
  default: (props: {
    config: { keywords: KeywordRule[] };
    onPatch: (patch: { keywords: KeywordRule[] }) => void;
  }) => {
    mocks.patchKeywords = (keywords: KeywordRule[]) => props.onPatch({ keywords });
    return (
      <div data-count={props.config.keywords.length} data-testid="section-keywords">
        <span data-testid="first-pattern">{props.config.keywords[0]?.pattern}</span>
      </div>
    );
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.data = bundle();
  mocks.fetch.error = undefined;
  mocks.fetch.isLoading = false;
});

describe('SettingsTab keyword editing at 10,000 rules', () => {
  it('absorbs ~100 keystrokes quickly and still detects the change once deferred work settles', async () => {
    render(<SettingsTab canManage enabled />);
    expect(screen.getByTestId('section-keywords').dataset.count).toBe(String(KEYWORD_COUNT));
    const save = () => screen.getByText('contentModeration.settings.save') as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    const started = Date.now();
    // Simulate typing 100 characters into one rule: each keystroke replaces that rule by id.
    for (let index = 1; index <= 100; index += 1) {
      const typed = 'e'.repeat(index);
      act(() => {
        mocks.patchKeywords?.(
          (mocks.fetch.data as ModerationSettingsBundle).settings.keywords.map((rule, position) =>
            position === 0 ? { ...rule, pattern: typed } : rule,
          ) as KeywordRule[],
        );
      });
    }
    const elapsed = Date.now() - started;

    expect(screen.getByTestId('first-pattern').textContent).toBe('e'.repeat(100));
    expect(elapsed).toBeLessThan(2000);

    // The dirty check runs against the deferred copy, so Save enables once React settles.
    await waitFor(() => expect(save().disabled).toBe(false));
  });

  it('keeps every other rule untouched while one is edited', () => {
    render(<SettingsTab canManage enabled />);
    act(() => {
      mocks.patchKeywords?.(
        (mocks.fetch.data as ModerationSettingsBundle).settings.keywords.map((rule, position) =>
          position === 5000 ? { ...rule, pattern: 'edited' } : rule,
        ) as KeywordRule[],
      );
    });
    expect(screen.getByTestId('section-keywords').dataset.count).toBe(String(KEYWORD_COUNT));
    expect(screen.getByTestId('first-pattern').textContent).toBe('term-0');
  });

  it('reverting an edit before the deferred pass settles leaves Save disabled', async () => {
    render(<SettingsTab canManage enabled />);
    const save = () => screen.getByText('contentModeration.settings.save') as HTMLButtonElement;
    const original = (mocks.fetch.data as ModerationSettingsBundle).settings.keywords;

    act(() => {
      mocks.patchKeywords?.(
        original.map((rule, position) =>
          position === 0 ? { ...rule, pattern: 'typo' } : rule,
        ) as KeywordRule[],
      );
    });
    act(() => {
      mocks.patchKeywords?.(original.map((rule) => ({ ...rule })) as KeywordRule[]);
    });

    await waitFor(() => expect(screen.getByTestId('first-pattern').textContent).toBe('term-0'));
    expect(save().disabled).toBe(true);
  });
});

describe('SettingsTab deferred-keyword pending guard', () => {
  const editFirstRule = (pattern: string) =>
    act(() => {
      mocks.patchKeywords?.(
        (mocks.fetch.data as ModerationSettingsBundle).settings.keywords.map((rule, position) =>
          position === 0 ? { ...rule, pattern } : rule,
        ) as KeywordRule[],
      );
    });

  it('blocks the save while validation is behind, then blocks it on the invalid rule', async () => {
    render(<SettingsTab canManage enabled />);
    const save = () => screen.getByText('contentModeration.settings.save') as HTMLButtonElement;

    // 1. A non-keyword change alone already makes the form dirty and saveable.
    act(() => mocks.patchMode?.());
    await waitFor(() => expect(save().disabled).toBe(false));

    // 2. Now make a keyword invalid. The old behaviour left Save enabled against stale issues.
    editFirstRule('([a-z');

    // 3. Once the deferred pass catches up the rule is judged and the save stays blocked —
    //    and it is blocked for the RIGHT reason, not because the form looks clean.
    await waitFor(() =>
      expect(screen.getByTestId('moderation-settings-issues').textContent).toBe(
        'contentModeration.errors.keywordRegex',
      ),
    );
    fireEvent.click(save());
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('contentModeration.errors.keywordRegex'),
    );
    // The invalid rule never reached the server.
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('never submits keywords that the synchronous re-check rejects', async () => {
    render(<SettingsTab canManage enabled />);
    act(() => mocks.patchMode?.());
    await waitFor(() =>
      expect(
        (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    editFirstRule('(((');
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('shows a clean, non-dirty status after a reload — no transient unsaved flash', async () => {
    const statuses: string[] = [];
    render(<SettingsTab canManage enabled />);
    const record = () => statuses.push(screen.getByTestId('settings-status').textContent ?? '');

    record();
    // Adopting a fresh snapshot resets both fingerprint halves from the same object.
    act(() => {
      mocks.fetch.mutate.mockResolvedValue(bundle());
    });
    await waitFor(() => record());

    expect(statuses.every((status) => status !== 'contentModeration.settings.dirty')).toBe(true);
    expect(
      (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
