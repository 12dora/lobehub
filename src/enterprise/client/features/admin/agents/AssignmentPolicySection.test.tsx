// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssignmentEntry } from './assignmentDraft';
import { AssignmentPolicySection } from './AssignmentPolicySection';
import type { AgentAssignmentDraft } from './useAgentAssignmentDraft';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'target' in options ? `${key}|${options.target}` : key,
  }),
}));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}));
vi.mock('@lobehub/ui', () => ({
  Tag: ({ children, size }: { children?: ReactNode; size?: string }) => (
    <span data-size={size}>{children}</span>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => (
    <input
      aria-label={props['aria-label']}
      disabled={props.disabled}
      id={props.id}
      placeholder={props.placeholder}
      value={props.value}
      onChange={props.onChange}
    />
  ),
  Select: (props: any) => (
    <select
      aria-label={props['aria-label']}
      id={props.id}
      value={props.value}
      onChange={(event) => props.onChange?.(event.target.value)}
    >
      {(props.options ?? []).map((option: { label: string; value: string }) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Switch: (props: any) => (
    <input
      aria-label={props['aria-label']}
      checked={props.checked}
      id={props.id}
      type="checkbox"
      onChange={(event) => props.onChange?.(event.target.checked)}
    />
  ),
}));

const entry = (over: Partial<AssignmentEntry> = {}): AssignmentEntry => ({
  enabled: true,
  id: 'assignment-1',
  mode: 'optional',
  pinnedVersionId: null,
  targetId: 'user-1',
  targetType: 'user',
  versionPolicy: 'latest_published',
  ...over,
});

const draftState = (over: Partial<AgentAssignmentDraft> = {}) =>
  ({
    add: vi.fn(),
    dirty: false,
    draft: { enabled: true, mode: 'optional', targetId: '', targetType: 'global' },
    draftError: null,
    entries: [],
    error: null,
    markRemoved: vi.fn(),
    markUpserted: vi.fn(),
    patchDraft: vi.fn(),
    plan: { removals: [], upserts: [] },
    remove: vi.fn(),
    truncated: false,
    ...over,
  }) as unknown as AgentAssignmentDraft;

let assignments: AgentAssignmentDraft;

beforeEach(() => {
  assignments = draftState();
});

describe('AssignmentPolicySection', () => {
  it('pairs the fields two per row rather than one field per line', () => {
    render(<AssignmentPolicySection assignments={assignments} />);
    for (const key of ['targetType', 'targetId', 'mode', 'enabled'] as const) {
      expect(screen.getByLabelText(`agentCatalog.assignment.${key}`)).toBeTruthy();
    }
    // Versions are gone from the UI, so nothing here can pin one.
    expect(screen.queryByLabelText('agentCatalog.assignment.versionPolicy')).toBeNull();
    expect(screen.queryByLabelText('agentCatalog.assignment.pinnedVersion')).toBeNull();
  });

  it('locks the identifier for a global target and says why', () => {
    render(<AssignmentPolicySection assignments={assignments} />);
    const input = screen.getByLabelText('agentCatalog.assignment.targetId');
    expect(input).toBeDisabled();
    expect(input.getAttribute('placeholder')).toBe('agentCatalog.assignment.targetIdGlobal');
  });

  it('opens the identifier once a role or user target is chosen', () => {
    assignments = draftState({
      draft: { enabled: true, mode: 'optional', targetId: 'role-a', targetType: 'global_role' },
    });
    render(<AssignmentPolicySection assignments={assignments} />);
    const input = screen.getByLabelText('agentCatalog.assignment.targetId');
    expect(input).not.toBeDisabled();
    expect((input as HTMLInputElement).value).toBe('role-a');
  });

  it('routes every control through the draft state', () => {
    render(<AssignmentPolicySection assignments={assignments} />);
    fireEvent.change(screen.getByLabelText('agentCatalog.assignment.mode'), {
      target: { value: 'mandatory' },
    });
    fireEvent.click(screen.getByLabelText('agentCatalog.assignment.enabled'));
    fireEvent.click(screen.getByText('agentCatalog.assignment.add'));
    expect(assignments.patchDraft).toHaveBeenCalledWith('mode', 'mandatory');
    expect(assignments.patchDraft).toHaveBeenCalledWith('enabled', false);
    expect(assignments.add).toHaveBeenCalledOnce();
  });

  it('names an empty list instead of showing a bare box', () => {
    render(<AssignmentPolicySection assignments={assignments} />);
    expect(screen.getByText('agentCatalog.assignment.empty')).toBeTruthy();
  });

  it('lists each assignment with a uniformly sized tag row and its own remove action', () => {
    assignments = draftState({
      entries: [entry(), entry({ enabled: false, id: 'a2', targetId: 'user-2' })],
    });
    render(<AssignmentPolicySection assignments={assignments} />);
    expect(screen.getAllByText('agentCatalog.assignment.remove')).toHaveLength(2);
    expect(screen.getByText('agentCatalog.assignment.disabledTag')).toBeTruthy();
    // Tag sizes are unified so a row never mixes 20px and 22px chips.
    for (const tag of document.querySelectorAll('[data-size]')) {
      expect(tag.getAttribute('data-size')).toBe('small');
    }
  });

  it('gives the remove action an accessible name that says which target it drops', () => {
    assignments = draftState({ entries: [entry()] });
    render(<AssignmentPolicySection assignments={assignments} />);
    const button = screen.getByLabelText('agentCatalog.assignment.removeTarget|user-1');
    fireEvent.click(button);
    expect(assignments.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'assignment-1' }),
    );
  });

  it('surfaces a rejected Add as an alert next to the form', () => {
    assignments = draftState({ error: 'agentCatalog.assignment.errors.targetRequired' });
    render(<AssignmentPolicySection assignments={assignments} />);
    expect(screen.getByRole('alert').textContent).toBe(
      'agentCatalog.assignment.errors.targetRequired',
    );
  });

  it('falls back to a read-only view when the loaded list is incomplete', () => {
    assignments = draftState({ entries: [entry()], truncated: true });
    render(<AssignmentPolicySection assignments={assignments} />);

    // The rows stay readable — hiding them would be worse than saying why they are locked.
    expect(screen.getByText('user-1')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('agentCatalog.assignment.tooManyToEdit');
    // …but nothing that would author a partial diff is reachable.
    expect(screen.queryByText('agentCatalog.assignment.add')).toBeNull();
    expect(screen.getByText('agentCatalog.assignment.remove').closest('[hidden]')).toBeTruthy();
  });

  it('explains that the default assistant already reaches everyone', () => {
    render(<AssignmentPolicySection isDefaultInbox assignments={assignments} />);
    expect(screen.getByText('agentCatalog.assignment.defaultInboxHint')).toBeTruthy();
  });

  it('locks the default assistant’s mandatory global delivery instead of offering to drop it', () => {
    assignments = draftState({
      entries: [
        entry({ id: 'global', mode: 'mandatory', targetId: 'global', targetType: 'global' }),
        entry({ id: 'extra', mode: 'optional', targetId: 'user-2', targetType: 'user' }),
      ],
    });
    render(<AssignmentPolicySection isDefaultInbox assignments={assignments} />);

    // Removing it would silently demote the platform default — the server owns that row.
    expect(screen.getByText('agentCatalog.assignment.lockedTag')).toBeTruthy();
    expect(screen.getAllByText('agentCatalog.assignment.remove')).toHaveLength(1);
    expect(screen.getByLabelText('agentCatalog.assignment.removeTarget|user-2')).toBeTruthy();
  });

  it('leaves the same mandatory global row removable on an ordinary assistant', () => {
    assignments = draftState({
      entries: [
        entry({ id: 'global', mode: 'mandatory', targetId: 'global', targetType: 'global' }),
      ],
    });
    render(<AssignmentPolicySection assignments={assignments} />);

    expect(screen.queryByText('agentCatalog.assignment.lockedTag')).toBeNull();
    expect(screen.getByText('agentCatalog.assignment.remove')).toBeTruthy();
  });
});
