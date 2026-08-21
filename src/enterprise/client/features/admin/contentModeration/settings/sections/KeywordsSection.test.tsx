// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KeywordRule } from '@/types/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { DEFAULT_PAGE_SIZE } from '../../../primitives/dataTableChange';
import type { ModerationConfigView } from '../draft';
import KeywordsSection from './KeywordsSection';

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
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
  Input: ({
    'aria-label': ariaLabel,
    onChange,
    value,
  }: {
    'aria-label'?: string;
    'onChange'?: (event: { target: { value: string } }) => void;
    'value'?: string;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  Select: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <select aria-label={ariaLabel} />
  ),
  Switch: () => <input type="checkbox" />,
  TextArea: ({
    onChange,
    value,
  }: {
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
  }) => (
    <textarea
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('../SettingsSection', () => ({
  default: ({ actions, children }: { actions?: ReactNode; children?: ReactNode }) => (
    <section>
      {actions}
      {children}
    </section>
  ),
}));

const rule = (index: number): KeywordRule => ({
  action: 'log',
  category: 'other',
  enabled: true,
  id: `rule-${index}`,
  isRegex: false,
  note: index === 7 ? 'needle-note' : undefined,
  pattern: `term-${index}`,
});

const configWith = (count: number): ModerationConfigView =>
  ({
    ...createDefaultContentModerationConfig(),
    keywords: Array.from({ length: count }, (_, index) => rule(index)),
  }) as unknown as ModerationConfigView;

const renderSection = (
  config: ModerationConfigView,
  importText = '',
  fieldError?: { message: string; ruleIndex?: number } | null,
) => {
  const onPatch = vi.fn();
  const onImportTextChange = vi.fn();
  const utils = render(
    <KeywordsSection
      config={config}
      disabled={false}
      fieldError={fieldError}
      importText={importText}
      onImportTextChange={onImportTextChange}
      onPatch={onPatch}
    />,
  );
  return { ...utils, onImportTextChange, onPatch };
};

beforeEach(() => vi.clearAllMocks());

describe('KeywordsSection at the 10,000-rule ceiling', () => {
  it('renders only the current page and does so quickly', () => {
    const started = Date.now();
    renderSection(configWith(10_000));
    const elapsed = Date.now() - started;

    // Only one page of editors is mounted — never all 10k.
    expect(screen.getAllByTestId(/^keyword-row-/)).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(screen.queryByTestId(`keyword-row-${DEFAULT_PAGE_SIZE}`)).toBeNull();
    expect(screen.getByTestId('keyword-page-info').textContent).toContain(
      'contentModeration.settings.keywords.pageInfo',
    );
    expect(elapsed).toBeLessThan(2000);
  });

  it('pages forward without remounting the whole list', () => {
    renderSection(configWith(10_000));
    fireEvent.click(screen.getByText('contentModeration.settings.keywords.nextPage'));
    expect(screen.getByTestId(`keyword-row-${DEFAULT_PAGE_SIZE}`)).toBeTruthy();
    expect(screen.queryByTestId('keyword-row-0')).toBeNull();
    expect(screen.getAllByTestId(/^keyword-row-/)).toHaveLength(DEFAULT_PAGE_SIZE);
  });

  it('filters by pattern and by note, keeping the original row numbers', () => {
    renderSection(configWith(200));
    const filter = screen.getByLabelText('contentModeration.settings.keywords.search');

    fireEvent.change(filter, { target: { value: 'term-123' } });
    expect(screen.getAllByTestId(/^keyword-row-/)).toHaveLength(1);
    expect(screen.getByTestId('keyword-row-123')).toBeTruthy();

    fireEvent.change(filter, { target: { value: 'needle-note' } });
    expect(screen.getByTestId('keyword-row-7')).toBeTruthy();

    fireEvent.change(filter, { target: { value: 'nothing-matches' } });
    expect(screen.getByTestId('keyword-search-empty')).toBeTruthy();
  });

  it('edits a rule by id rather than by visible position', () => {
    const { onPatch } = renderSection(configWith(200));
    const filter = screen.getByLabelText('contentModeration.settings.keywords.search');
    fireEvent.change(filter, { target: { value: 'term-123' } });

    fireEvent.change(screen.getByLabelText('contentModeration.settings.keywords.pattern'), {
      target: { value: 'edited' },
    });
    const patched = onPatch.mock.calls[0][0].keywords as KeywordRule[];
    expect(patched[123].pattern).toBe('edited');
    expect(patched[122].pattern).toBe('term-122');
    expect(patched).toHaveLength(200);
  });

  it('refuses to add past the ceiling instead of silently dropping the rule', () => {
    const { onPatch } = renderSection(configWith(10_000));
    fireEvent.click(screen.getByText('contentModeration.settings.keywords.add'));
    expect(onPatch).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('contentModeration.errors.keywordCount');
  });

  it('reports the truncated import count, not the pasted count', () => {
    const config = configWith(9_999);
    const { onImportTextChange, onPatch } = renderSection(config, 'a\nb\nc');
    fireEvent.click(screen.getByText('contentModeration.settings.keywords.import'));
    fireEvent.click(screen.getByText('contentModeration.settings.keywords.importApply'));

    expect((onPatch.mock.calls[0][0].keywords as KeywordRule[]).length).toBe(10_000);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'contentModeration.settings.keywords.importedPartial',
    );
    expect(onImportTextChange).toHaveBeenCalledWith('');
  });
});

describe('KeywordsSection server rejections', () => {
  it('pages to the rejected rule and highlights it', () => {
    renderSection(configWith(10_000), '', {
      message: 'regex #4243 is unsafe',
      ruleIndex: 4242,
    });

    const row = screen.getByTestId('keyword-row-4242');
    expect(row.dataset.rejected).toBe('true');
    expect(screen.getByTestId('keyword-server-error-4242').textContent).toBe(
      'regex #4243 is unsafe',
    );
    // Only the page containing the offending rule is mounted.
    expect(screen.queryByTestId('keyword-row-0')).toBeNull();
    expect(screen.getAllByTestId(/^keyword-row-/)).toHaveLength(DEFAULT_PAGE_SIZE);
  });

  it('clears an active filter so the rejected rule is actually reachable', () => {
    renderSection(configWith(200), '', { message: 'too slow', ruleIndex: 150 });
    const filter = screen.getByLabelText(
      'contentModeration.settings.keywords.search',
    ) as HTMLInputElement;
    expect(filter.value).toBe('');
    expect(screen.getByTestId('keyword-row-150')).toBeTruthy();
  });

  it('marks no row when the rejection names none', () => {
    renderSection(configWith(200), '', {
      message: 'contentModeration.errors.reason.tooManyRegexChanges',
    });
    expect(screen.getByTestId('keyword-section-error').textContent).toBe(
      'contentModeration.errors.reason.tooManyRegexChanges',
    );
    expect(screen.getByTestId('keyword-row-0').dataset.rejected).toBeUndefined();
  });

  it('shows nothing extra when the save was accepted', () => {
    renderSection(configWith(200));
    expect(screen.queryByTestId('keyword-section-error')).toBeNull();
    expect(screen.getByTestId('keyword-row-0').dataset.rejected).toBeUndefined();
  });
});
