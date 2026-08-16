// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminTaskTemplateItem } from './types';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  created: [] as { content: unknown }[],
  formProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    t: (key: string) => key,
  }),
}));

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));

vi.mock('@lobehub/ui/base-ui', () => ({
  createModal: (config: { content: ReactNode }) => {
    mocks.created.push(config);
    return config;
  },
  useModalContext: () => ({ close: mocks.close }),
}));

vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: (error: unknown) =>
    (error as { code?: string })?.code ? { code: (error as { code: string }).code } : null,
}));

// Stand-in editor: exposes the props the modal computes, so the test asserts behaviour
// (conflict banner, reload wiring, submit gating) rather than markup.
vi.mock('./TaskTemplateEditorForm', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.formProps = props;
    return (
      <div>
        {props.conflict ? <div role="alert">conflict</div> : null}
        {props.reloadError ? (
          <div data-testid="reload-error">{String(props.reloadError)}</div>
        ) : null}
        {props.reloading ? <div data-testid="reloading">reloading</div> : null}
        {props.submitError ? <div role="status">{String(props.submitError)}</div> : null}
        <button disabled={!props.valid} onClick={props.onSubmit as () => void}>
          submit
        </button>
        {props.onReload ? <button onClick={props.onReload as () => void}>reload</button> : null}
      </div>
    );
  },
}));

const item: AdminTaskTemplateItem = {
  category: 'engineering',
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Daily digest',
  enabled: true,
  icon: null,
  id: 'tpl-1',
  identifier: 'daily-digest',
  instruction: 'Summarize',
  interests: [],
  revision: 3,
  sortOrder: 0,
  source: 'manual',
  title: 'Engineering digest',
  updatedAt: new Date('2026-08-16T00:00:00Z'),
};

const renderModal = async (props: Record<string, unknown>) => {
  const { openTaskTemplateEditorModal } = await import('./openTaskTemplateEditorModal');
  const config = openTaskTemplateEditorModal(props as never) as unknown as { content: ReactNode };
  return render(<>{config.content}</>);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formProps = undefined;
  mocks.created = [];
});

describe('openTaskTemplateEditorModal', () => {
  it('turns a revision conflict into an explicit reload instead of a generic save error', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }));
    const onReload = vi.fn().mockResolvedValue(item);
    await renderModal({ item, onReload, onSubmit });

    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Not the catch-all copy: the captured revision can never win, so retrying in place is futile.
    expect(screen.queryByRole('status')).toBeNull();
    // …and the submit button is disabled until the operator reloads.
    expect((screen.getByText('submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the editor open and reports the failure when the reload itself fails', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }));
    const onReload = vi.fn().mockRejectedValue(new Error('offline'));
    await renderModal({ item, onReload, onSubmit });

    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    fireEvent.click(screen.getByText('reload'));

    await waitFor(() =>
      expect(screen.getByTestId('reload-error').textContent).toBe(
        'taskTemplateCatalog.form.conflictReloadFailed',
      ),
    );
    // The draft survives: nothing was closed and no replacement editor was opened.
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.created).toHaveLength(1);
  });

  it('explains that the row is gone when the refresh cannot find it', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }));
    const onReload = vi.fn().mockResolvedValue(undefined);
    await renderModal({ item, onReload, onSubmit });

    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    fireEvent.click(screen.getByText('reload'));

    await waitFor(() =>
      expect(screen.getByTestId('reload-error').textContent).toBe(
        'taskTemplateCatalog.form.conflictDeleted',
      ),
    );
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('swaps in a fresh editor only once the current row is in hand', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }));
    const fresh = { ...item, revision: 9, title: 'Renamed by someone else' };
    const onReload = vi.fn().mockResolvedValue(fresh);
    await renderModal({ item, onReload, onSubmit });

    fireEvent.click(screen.getByText('submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    fireEvent.click(screen.getByText('reload'));

    await waitFor(() => expect(mocks.created).toHaveLength(2));
    // Closed only after the replacement was built.
    expect(mocks.close).toHaveBeenCalled();
    expect(onReload).toHaveBeenCalledWith(item);
  });

  it('reports a taken identifier with its own message', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('taken'), { code: 'PLATFORM_INVALID_INPUT' }));
    await renderModal({ item, onSubmit });

    fireEvent.click(screen.getByText('submit'));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'taskTemplateCatalog.form.errors.identifierTaken',
      ),
    );
  });

  it('closes on a successful save', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await renderModal({ item, onSubmit });

    fireEvent.click(screen.getByText('submit'));

    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Engineering digest' }));
  });

  it('offers no reload action for a create flow (there is nothing to reload)', async () => {
    await renderModal({ onSubmit: vi.fn() });
    expect(screen.queryByText('reload')).toBeNull();
  });
});
