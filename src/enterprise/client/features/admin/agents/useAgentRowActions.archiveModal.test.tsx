// @vitest-environment happy-dom
/**
 * Integration test for the ONE thing a mocked modal cannot show: whether the archive confirmation's
 * submit button ever becomes clickable. `validateExtra` is only re-read when `reportExtraChange()`
 * fires, so a discarded callback leaves the default assistant permanently un-archivable.
 *
 * The hook builds the props; the REAL `ReasonModalContent` renders them.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ReasonModalContent,
  type ReasonModalContentProps,
} from '@/enterprise/client/features/admin/primitives/openReasonModal';

import type { AdminAgentListItem } from './types';
import { useAgentRowActions } from './useAgentRowActions';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  candidates: [] as Array<{ displayName: string; identity: { id: string } }>,
  close: vi.fn(),
  get: vi.fn(),
  onChanged: vi.fn(),
  reasonModal: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}));
vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, ...rest }: any) => <span {...rest}>{children}</span>,
  TextArea: (props: any) => <textarea {...props} />,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  // `loading` is a base-ui prop, not a DOM one — swallow it so React does not warn.
  Button: ({ children, loading: _loading, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  createModal: vi.fn(),
  Input: (props: any) => (
    <input aria-label={props['aria-label']} disabled={props.disabled} onChange={props.onChange} />
  ),
  Select: (props: any) => (
    <select
      aria-label={props['aria-label']}
      disabled={props.disabled}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(event.target.value || undefined)}
    >
      <option value="">—</option>
      {(props.options ?? []).map((option: { label: string; value: string }) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  TextArea: (props: any) => <textarea {...props} />,
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  useModalContext: () => ({ close: mocks.close }),
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: (...args: unknown[]) => mocks.reasonModal(...args),
}));
vi.mock('./useAdminAgentReplacementCandidates', () => ({
  useAdminAgentReplacementCandidates: () => ({
    data: mocks.candidates,
    error: undefined,
    isLoading: false,
    isValidating: false,
  }),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    archive: (...args: unknown[]) => mocks.archive(...args),
    get: (...args: unknown[]) => mocks.get(...args),
    list: vi.fn(),
    setDefaultInbox: vi.fn(),
  },
}));

const defaultRow = {
  assignmentCount: 0,
  displayName: 'Inbox',
  identity: {
    agentKey: 'default-inbox',
    id: 'agent-default',
    isDefault: true,
    status: 'published',
    systemKey: 'default-inbox',
  },
} as unknown as AdminAgentListItem;

/** Drive the real hook, then hand its props to the real modal body. */
const openArchiveModal = async () => {
  mocks.get.mockResolvedValue({
    draftToken: 'c'.repeat(64),
    identity: { ...defaultRow.identity, revision: 4 },
  });
  const { result } = renderHook(() =>
    useAgentRowActions({ authMethod: 'better-auth', onChanged: mocks.onChanged }),
  );
  await act(async () => {
    await result.current.archive(defaultRow);
  });
  const props = mocks.reasonModal.mock.calls.at(-1)![0] as ReasonModalContentProps;
  return render(<ReasonModalContent {...props} />);
};

beforeEach(() => {
  mocks.archive.mockReset();
  mocks.close.mockReset();
  mocks.get.mockReset();
  mocks.onChanged.mockReset().mockResolvedValue(undefined);
  mocks.reasonModal.mockReset();
  mocks.candidates = [
    { displayName: 'Research', identity: { id: 'agent-research' } },
    { displayName: 'Support', identity: { id: 'agent-support' } },
  ];
});

describe('archive confirmation for the DEFAULT assistant', () => {
  it('enables the submit button once a replacement is chosen', async () => {
    await openArchiveModal();

    const submit = screen.getByText('agentCatalog.archive.submit');
    // The server refuses a default archive without a successor, so submit starts closed.
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('agentCatalog.archive.replacement'), {
      target: { value: 'agent-research' },
    });

    // This is the regression: without `reportExtraChange()` the button never re-validates.
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('sends the chosen replacement with the frozen CAS when submitted', async () => {
    await openArchiveModal();

    fireEvent.change(screen.getByLabelText('agentCatalog.archive.replacement'), {
      target: { value: 'agent-support' },
    });
    const submit = screen.getByText('agentCatalog.archive.submit');
    await waitFor(() => expect(submit).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => expect(mocks.archive).toHaveBeenCalledOnce());
    expect(mocks.archive.mock.calls[0]![0]).toMatchObject({
      agentId: 'agent-default',
      expectedDraftToken: 'c'.repeat(64),
      expectedRevision: 4,
      replacementAgentId: 'agent-support',
    });
    expect(mocks.onChanged).toHaveBeenCalledOnce();
  });

  it('keeps submit closed while the choice is cleared again', async () => {
    await openArchiveModal();
    const select = screen.getByLabelText('agentCatalog.archive.replacement');
    const submit = screen.getByText('agentCatalog.archive.submit');

    fireEvent.change(select, { target: { value: 'agent-research' } });
    await waitFor(() => expect(submit).not.toBeDisabled());

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(submit).toBeDisabled());
  });
});

describe('archive confirmation for an ORDINARY assistant', () => {
  it('needs no replacement, so submit is open immediately and no picker is shown', async () => {
    const ordinary = {
      ...defaultRow,
      identity: { ...defaultRow.identity, isDefault: false, systemKey: null },
    } as AdminAgentListItem;
    mocks.get.mockResolvedValue({
      draftToken: 'c'.repeat(64),
      identity: { ...ordinary.identity, revision: 4 },
    });
    const { result } = renderHook(() =>
      useAgentRowActions({ authMethod: 'better-auth', onChanged: mocks.onChanged }),
    );
    await act(async () => {
      await result.current.archive(ordinary);
    });
    render(
      <ReasonModalContent
        {...(mocks.reasonModal.mock.calls.at(-1)![0] as ReasonModalContentProps)}
      />,
    );

    expect(screen.queryByLabelText('agentCatalog.archive.replacement')).toBeNull();
    expect(screen.getByText('agentCatalog.archive.submit')).not.toBeDisabled();
    // Reason-free confirmation: no textarea to fill in before the operator can act.
    expect(screen.queryByText('users.modals.reasonLabel')).toBeNull();
  });
});
