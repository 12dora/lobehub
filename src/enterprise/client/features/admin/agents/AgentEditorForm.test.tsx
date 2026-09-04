// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentEditorForm } from './AgentEditorForm';

const formMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Keys pass through; interpolated values are appended so the composed line stays assertable.
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'fields' in options ? `${key}|${options.fields}` : key,
  }),
}));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
  cx: (...names: unknown[]) => names.filter(Boolean).join(' '),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message, ...rest }: any) => (
    <div {...rest}>
      {message}
      {action}
    </div>
  ),
  Flexbox: ({ children, horizontal }: { children?: ReactNode; horizontal?: boolean }) => (
    <div data-horizontal={String(Boolean(horizontal))}>{children}</div>
  ),
  Icon: () => <i />,
  NeuralNetworkLoading: () => null,
  Text: ({ children, ...rest }: any) => <span {...rest}>{children}</span>,
  // The real tooltip only paints its title on hover, so the mock keeps it off the text content too.
  Tooltip: ({ children, title }: any) => <span data-tooltip={String(title)}>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  FormGroup: ({ children, collapsible, defaultActive, extra, title }: any) => (
    <section
      data-collapsed={String(collapsible === true && defaultActive === false)}
      data-group={title}
    >
      {extra}
      {children}
    </section>
  ),
  Input: (props: any) => (
    <input
      aria-label={props['aria-label']}
      disabled={props.disabled}
      id={props.id}
      maxLength={props.maxLength}
      required={props.required}
    />
  ),
  InputNumber: (props: any) => <input disabled={props.disabled} id={props.id} type="number" />,
  Select: (props: any) => (
    <select
      aria-label={props['aria-label']}
      disabled={props.disabled}
      id={props.id}
      required={props.required}
    />
  ),
  TextArea: (props: any) => (
    <textarea
      aria-label={props['aria-label']}
      disabled={props.disabled}
      id={props.id}
      required={props.required}
    />
  ),
}));
vi.mock('@/components/EmojiPicker', () => ({ default: () => <div>emoji-picker</div> }));
vi.mock('@/features/AgentSetting/AgentMeta/BackgroundSwatches', () => ({
  default: () => <div>background-swatches</div>,
}));
vi.mock('./DependencyEditor', () => ({
  DependencyEditor: ({
    children,
    editable,
  }: {
    children: (slots: Record<string, ReactNode>) => ReactNode;
    editable?: boolean;
  }) => (
    <div data-dependency-editable={String(Boolean(editable))}>
      {children({
        connectors: <div>connectors-field</div>,
        model: <div>model-field</div>,
        skills: <div>skills-field</div>,
      })}
    </div>
  ),
}));
vi.mock('./AssignmentPolicySection', () => ({
  AssignmentPolicySection: ({ isDefaultInbox }: { isDefaultInbox?: boolean }) => (
    <div data-default-inbox={String(Boolean(isDefaultInbox))}>assignment-policy</div>
  ),
}));
vi.mock('./useAgentEditorForm', () => ({
  AGENT_KEY_MAX_LENGTH: 128,
  useAgentEditorForm: () => formMock.value,
}));

const baseForm = () => ({
  agentKey: '',
  assignments: {} as Record<string, unknown>,
  canAssign: false,
  canSubmit: false,
  configEditable: true,
  currentVersionMissing: false,
  changeAgentKey: vi.fn(),
  conflict: false,
  depValidity: {
    blockers: [] as { message: string; retry?: () => Promise<unknown> }[],
    issues: [] as string[],
    ready: false,
  },
  dirty: false,
  error: null as string | null,
  isCreate: true,
  keyValid: true,
  missingRequirements: [] as string[],
  patchConfig: vi.fn(),
  saving: false,
  setDependencies: vi.fn(),
  setDepValidity: vi.fn(),
  resumeBlocked: false,
  setDisplayName: vi.fn(),
  submit: vi.fn(),
  systemKey: null as string | null,
  value: {
    config: {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: '',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: '',
      tags: [],
    },
    dependencies: { connectors: [], model: null, skills: [] },
  },
});

const named = (displayName: string) => {
  const form = baseForm();
  return { ...form, value: { ...form.value, config: { ...form.value.config, displayName } } };
};

const groupOf = (node: HTMLElement | null) => node?.closest('section')?.dataset.group;
/** Static guidance lives on a hover target, never as a paragraph between a label and its box. */
const helpFor = (key: string) => document.querySelector(`[data-tooltip="${key}"]`);

beforeEach(() => {
  formMock.value = baseForm();
});

describe('AgentEditorForm layout', () => {
  it('lays the editor out as basics → role → parameters → more', () => {
    render(<AgentEditorForm />);
    const groups = [...document.querySelectorAll('section')].map((node) => node.dataset.group);
    expect(groups).toEqual([
      'agentCatalog.editor.section.basic',
      'agentCatalog.editor.section.prompt',
      'agentCatalog.editor.section.params',
      'agentCatalog.editor.section.more',
    ]);
    // Only the advanced sections start folded; the everyday fields are always visible.
    expect([...document.querySelectorAll('section')].map((node) => node.dataset.collapsed)).toEqual(
      ['false', 'false', 'true', 'true'],
    );
  });

  it('locks every config control for an assignment-only operator and says why', () => {
    formMock.value = { ...baseForm(), canAssign: true, configEditable: false, isCreate: false };
    render(<AgentEditorForm />);

    for (const label of [
      'agentCatalog.editor.name',
      'agentCatalog.editor.key',
      'agentCatalog.editor.description',
      'agentCatalog.editor.systemRole',
      'agentCatalog.editor.tags',
      'agentCatalog.editor.openingMessage',
      'agentCatalog.editor.openingQuestions',
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    // The dependency pickers are config too — read-only, not merely visually quiet.
    expect(
      document
        .querySelector('[data-dependency-editable]')
        ?.getAttribute('data-dependency-editable'),
    ).toBe('false');
    expect(screen.getByText('agentCatalog.editor.readOnlyConfig')).toBeTruthy();
    // …and 分配策略 is still theirs to edit — that is the whole point of opening the modal.
    expect(screen.getByText('assignment-policy')).toBeTruthy();
  });

  it('blocks the config with a distinct error when the live version could not be loaded', () => {
    formMock.value = {
      ...baseForm(),
      configEditable: false,
      currentVersionMissing: true,
      isCreate: false,
    };
    render(<AgentEditorForm />);
    expect(screen.getByText('agentCatalog.editor.versionUnavailable')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.editor.readOnlyConfig')).toBeNull();
    expect(screen.getByLabelText('agentCatalog.editor.systemRole')).toBeDisabled();
  });

  it('leaves every config control editable for a full editor', () => {
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.name')).not.toBeDisabled();
    expect(
      document
        .querySelector('[data-dependency-editable]')
        ?.getAttribute('data-dependency-editable'),
    ).toBe('true');
    expect(screen.queryByText('agentCatalog.editor.readOnlyConfig')).toBeNull();
  });

  it('hides 分配策略 from an operator without the assign grant', () => {
    render(<AgentEditorForm />);
    expect(screen.queryByText('assignment-policy')).toBeNull();
    expect(
      [...document.querySelectorAll('section')].map((node) => node.dataset.group),
    ).not.toContain('agentCatalog.editor.section.assignment');
  });

  it('puts 分配策略 right after the role, before the advanced groups', () => {
    formMock.value = { ...baseForm(), canAssign: true };
    render(<AgentEditorForm />);
    expect([...document.querySelectorAll('section')].map((node) => node.dataset.group)).toEqual([
      'agentCatalog.editor.section.basic',
      'agentCatalog.editor.section.prompt',
      'agentCatalog.editor.section.assignment',
      'agentCatalog.editor.section.params',
      'agentCatalog.editor.section.more',
    ]);
    // Who receives the assistant is everyday information, so the group never starts folded.
    expect(groupOf(screen.getByText('assignment-policy'))).toBe(
      'agentCatalog.editor.section.assignment',
    );
    expect(helpFor('agentCatalog.editor.section.assignmentDesc')).toBeTruthy();
  });

  it('tells the assignment editor when it is looking at the default assistant', () => {
    formMock.value = { ...baseForm(), canAssign: true, systemKey: 'default-inbox' };
    render(<AgentEditorForm />);
    expect(screen.getByText('assignment-policy').dataset.defaultInbox).toBe('true');
  });

  it('keeps the mandatory model picker with the basics, above the fold', () => {
    render(<AgentEditorForm />);
    expect(groupOf(screen.getByText('model-field'))).toBe('agentCatalog.editor.section.basic');
    expect(groupOf(screen.getByLabelText('agentCatalog.editor.systemRole'))).toBe(
      'agentCatalog.editor.section.prompt',
    );
    expect(groupOf(screen.getByText('skills-field'))).toBe('agentCatalog.editor.section.more');
    expect(groupOf(screen.getByText('connectors-field'))).toBe('agentCatalog.editor.section.more');
  });

  it('reads the avatar, name, identifier and swatches as one identity block', () => {
    render(<AgentEditorForm />);
    const identity = screen.getByRole('group', { name: 'agentCatalog.editor.identity' });
    expect(identity).toContainElement(screen.getByText('emoji-picker'));
    expect(identity).toContainElement(screen.getByText('background-swatches'));
    expect(identity).toContainElement(screen.getByLabelText('agentCatalog.editor.name'));
    expect(identity).toContainElement(screen.getByLabelText('agentCatalog.editor.key'));
  });

  it('puts the identifier beside the name, with the swatch strip in the name column', () => {
    render(<AgentEditorForm />);
    const nameColumn = screen.getByLabelText('agentCatalog.editor.name').closest('.identityName')!;
    const identifier = screen.getByLabelText('agentCatalog.editor.key');

    // Placement is structural, not a breakpoint rule: the strip lives INSIDE the name's own
    // column, so no width can reflow it away from the box it colours or behind the identifier.
    expect(nameColumn).toContainElement(screen.getByText('background-swatches'));
    // …and the identifier is a sibling column, never inside it — it wraps as a whole when narrow.
    expect(nameColumn).not.toContainElement(identifier);
    expect(identifier.parentElement!.className).toContain('identityKey');
  });

  it('reads name → swatches → identifier in DOM order, so keyboard order matches the layout', () => {
    render(<AgentEditorForm />);
    const identity = screen.getByRole('group', { name: 'agentCatalog.editor.identity' });
    const inOrder = [...identity.querySelectorAll('*')];
    const at = (node: Element) => inOrder.indexOf(node);

    expect(at(screen.getByLabelText('agentCatalog.editor.name'))).toBeLessThan(
      at(screen.getByText('background-swatches')),
    );
    expect(at(screen.getByText('background-swatches'))).toBeLessThan(
      at(screen.getByLabelText('agentCatalog.editor.key')),
    );
  });

  it('labels every field the contract requires as required', () => {
    render(<AgentEditorForm />);
    const requiredLabels = [...document.querySelectorAll('label')]
      .filter((label) => label.querySelector('span[aria-hidden]'))
      .map((label) => label.textContent);
    expect(requiredLabels).toEqual(['agentCatalog.editor.name*', 'agentCatalog.editor.key*']);
    // The prompt is NOT among them: the contract accepts an empty system role.
    expect(screen.getByLabelText('agentCatalog.editor.systemRole')).not.toBeRequired();
  });

  it('binds every required label to its control and marks the control required', () => {
    render(<AgentEditorForm />);
    for (const field of ['name', 'key'] as const) {
      const label = [...document.querySelectorAll('label')].find(
        (node) => node.textContent === `agentCatalog.editor.${field}*`,
      )!;
      const control = screen.getByLabelText(`agentCatalog.editor.${field}`);
      // A real association: clicking the label reaches the control, and AT reads the required state.
      expect(label.getAttribute('for')).toBe(control.id);
      expect(control).toBeRequired();
    }
  });

  it('keeps the long guidance available but out of the way, behind a help hint', () => {
    render(<AgentEditorForm />);
    for (const key of [
      'agentCatalog.editor.systemRoleDesc',
      'agentCatalog.editor.section.paramsDesc',
      'agentCatalog.editor.openingQuestionsDesc',
    ]) {
      expect(helpFor(key)).toBeTruthy();
      // …and not as a paragraph wedged between the label and the box it explains.
      expect(screen.queryByText(key)).toBeNull();
    }
  });

  it('lays the model parameters out as compact labelled boxes', () => {
    render(<AgentEditorForm />);
    for (const key of ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty', 'maxTokens']) {
      const input = screen.getByLabelText(`agentCatalog.editor.param.${key}`);
      expect(input.getAttribute('type')).toBe('number');
      expect(groupOf(input)).toBe('agentCatalog.editor.section.params');
    }
  });

  it('offers the identifier only while creating, and states its rules in the label help', () => {
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key')).not.toBeDisabled();
    expect(helpFor('agentCatalog.editor.keyDesc')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.editor.keyDesc')).toBeNull();
  });

  it('caps the identifier at the contract length and explains an illegal one inline', () => {
    formMock.value = { ...baseForm(), agentKey: 'Nope!', keyValid: false };
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key').getAttribute('maxlength')).toBe('128');
    expect(screen.getByRole('alert').textContent).toBe('agentCatalog.editor.keyInvalid');
  });

  it('explains an EMPTY identifier once the assistant has been named', () => {
    // Regression: an all-CJK name used to blank the identifier and disable Save with no message.
    formMock.value = { ...named('测试助理'), agentKey: '', keyValid: false };
    render(<AgentEditorForm />);
    expect(screen.getByRole('alert').textContent).toBe('agentCatalog.editor.keyRequired');
  });

  it('says nothing about the identifier before anything has been typed', () => {
    formMock.value = { ...baseForm(), agentKey: '', keyValid: false };
    render(<AgentEditorForm />);
    expect(screen.queryByText('agentCatalog.editor.keyRequired')).toBeNull();
    expect(screen.queryByText('agentCatalog.editor.keyInvalid')).toBeNull();
  });

  it('locks the identifier when editing an existing assistant', () => {
    formMock.value = { ...baseForm(), isCreate: false };
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key')).toBeDisabled();
    expect(helpFor('agentCatalog.editor.keyLockedDesc')).toBeTruthy();
  });

  it('reserves the default assistant’s identifier and says the platform owns it', () => {
    formMock.value = { ...baseForm(), isCreate: false, systemKey: 'default-inbox' };
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key')).toBeDisabled();
    expect(helpFor('agentCatalog.editor.keyDefaultInboxDesc')).toBeTruthy();
  });

  it('keeps the default assistant’s presentation fully editable', () => {
    formMock.value = { ...baseForm(), isCreate: false, systemKey: 'default-inbox' };
    render(<AgentEditorForm />);

    // Only identity and mandatory delivery are reserved — the copy members read is the admin's.
    for (const label of [
      'agentCatalog.editor.name',
      'agentCatalog.editor.description',
      'agentCatalog.editor.systemRole',
      'agentCatalog.editor.openingMessage',
      'agentCatalog.editor.openingQuestions',
    ]) {
      expect(screen.getByLabelText(label)).not.toBeDisabled();
    }
  });

  it('states the immediate effect and keeps Save closed until the form can commit', () => {
    render(<AgentEditorForm />);
    expect(screen.getByText('agentCatalog.editor.effectHint')).toBeTruthy();
    expect(screen.getByText('agentCatalog.editor.save')).toBeDisabled();
  });

  it('routes Cancel through the host guard rather than closing directly', () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(<AgentEditorForm onCancel={onCancel} onClose={onClose} />);
    fireEvent.click(screen.getByText('agentCatalog.editor.cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('submits once the hook reports the form is complete', () => {
    formMock.value = { ...baseForm(), canSubmit: true };
    render(<AgentEditorForm />);
    fireEvent.click(screen.getByText('agentCatalog.editor.save'));
    expect(formMock.value.submit).toHaveBeenCalledOnce();
  });

  it('names the in-progress state while saving', () => {
    formMock.value = { ...baseForm(), saving: true };
    render(<AgentEditorForm />);
    expect(screen.getByText('agentCatalog.editor.saving')).toBeTruthy();
    // Cancel is withheld mid-write so a half-committed save cannot be abandoned by accident.
    expect(screen.getByText('agentCatalog.editor.cancel')).toBeDisabled();
  });

  it('announces a concurrent-edit conflict without discarding the input', () => {
    formMock.value = { ...baseForm(), canSubmit: true, conflict: true };
    render(<AgentEditorForm />);
    const alert = screen.getByText('agentCatalog.editor.conflict');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByLabelText('agentCatalog.editor.name')).toBeTruthy();
  });

  it('surfaces a save failure as an assertive message above the footer', () => {
    formMock.value = { ...baseForm(), error: 'agentCatalog.errors.generic' };
    render(<AgentEditorForm />);
    expect(screen.getByRole('alert').textContent).toBe('agentCatalog.errors.generic');
  });
});

describe('AgentEditorForm: why Save is unavailable', () => {
  it('lists every field Save is still waiting on, next to Save', () => {
    formMock.value = {
      ...named('测试助理'),
      dirty: true,
      missingRequirements: ['agentCatalog.editor.missing.key', 'agentCatalog.editor.missing.model'],
    };
    render(<AgentEditorForm />);
    const line = screen.getByText(
      'agentCatalog.editor.missing.title|agentCatalog.editor.missing.key · agentCatalog.editor.missing.model',
    );
    // Rendered outside every form group, i.e. in the pinned footer region beside Save.
    expect(line.closest('section')).toBeNull();
  });

  it('stays quiet about missing fields until the admin has started', () => {
    formMock.value = {
      ...baseForm(),
      missingRequirements: ['agentCatalog.editor.missing.name'],
    };
    render(<AgentEditorForm />);
    expect(screen.queryByText(/agentCatalog\.editor\.missing\.title/)).toBeNull();
  });

  it('does not repeat the unchosen model as a separate catalog alert', () => {
    formMock.value = {
      ...named('测试助理'),
      depValidity: {
        blockers: [{ message: 'agentCatalog.editor.blocked.model' }],
        issues: [],
        ready: false,
      },
      dirty: true,
      missingRequirements: ['agentCatalog.editor.missing.model'],
    };
    render(<AgentEditorForm />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByText('agentCatalog.editor.missing.title|agentCatalog.editor.missing.model'),
    ).toBeTruthy();
  });

  it('explains a Save blocked by a HIDDEN catalog next to the button, with its retry', () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    formMock.value = {
      ...baseForm(),
      depValidity: {
        // Skills live in the collapsed "More" group — the admin would never see this failure there.
        blockers: [{ message: 'agentCatalog.dependency.skill.loadError', retry }],
        issues: [],
        ready: false,
      },
    };
    render(<AgentEditorForm />);

    const blocker = screen.getByRole('status');
    expect(blocker.textContent).toContain('agentCatalog.dependency.skill.loadError');
    expect(blocker.closest('section')).toBeNull();

    fireEvent.click(screen.getByText('agentCatalog.dependency.retry'));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('reports a loading-catalog blocker without inventing a retry action', () => {
    formMock.value = {
      ...baseForm(),
      depValidity: {
        blockers: [{ message: 'agentCatalog.editor.blocked.providerCatalog' }],
        issues: [],
        ready: false,
      },
    };
    render(<AgentEditorForm />);
    expect(screen.getByRole('status').textContent).toBe(
      'agentCatalog.editor.blocked.providerCatalog',
    );
    expect(screen.queryByText('agentCatalog.dependency.retry')).toBeNull();
  });

  it('stays quiet when nothing blocks the save', () => {
    formMock.value = { ...baseForm(), canSubmit: true };
    render(<AgentEditorForm />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns about stale dependencies beside the model picker', () => {
    formMock.value = {
      ...baseForm(),
      depValidity: {
        blockers: [],
        issues: ['agentCatalog.dependency.issues.modelStale'],
        ready: false,
      },
    };
    render(<AgentEditorForm />);
    expect(groupOf(screen.getByText('agentCatalog.dependency.issues.modelStale'))).toBe(
      'agentCatalog.editor.section.basic',
    );
  });
});
