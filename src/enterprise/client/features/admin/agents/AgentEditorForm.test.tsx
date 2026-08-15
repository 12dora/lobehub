// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentEditorForm } from './AgentEditorForm';

const formMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}));

interface GroupItem {
  children: ReactNode;
  label?: ReactNode;
  layout?: string;
}
interface Group {
  children: GroupItem[] | ReactNode;
  collapsible?: boolean;
  defaultActive?: boolean;
  title: string;
}

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
  Form: ({ items }: { items: Group[] }) => (
    <div>
      {items.map((group) => (
        <section
          data-collapsed={String(group.collapsible === true && group.defaultActive === false)}
          data-group={group.title}
          key={group.title}
        >
          {Array.isArray(group.children)
            ? (group.children as GroupItem[]).map((item, index) => (
                <div data-layout={item.layout} key={index}>
                  {item.label}
                  {item.children}
                </div>
              ))
            : (group.children as ReactNode)}
        </section>
      ))}
    </div>
  ),
  Input: (props: any) => (
    <input aria-label={props['aria-label']} disabled={props.disabled} maxLength={props.maxLength} />
  ),
  InputNumber: (props: any) => <input aria-label={props['aria-label']} type="number" />,
  Text: ({ children, ...rest }: any) => <span {...rest}>{children}</span>,
  TextArea: (props: any) => <textarea aria-label={props['aria-label']} />,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: (props: any) => <select aria-label={props['aria-label']} />,
}));
vi.mock('@/components/EmojiPicker', () => ({ default: () => <div>emoji-picker</div> }));
vi.mock('@/features/AgentSetting/AgentMeta/BackgroundSwatches', () => ({
  default: () => <div>background-swatches</div>,
}));
vi.mock('./DependencyEditor', () => ({
  DependencyEditor: ({ children }: { children: (slots: Record<string, ReactNode>) => ReactNode }) =>
    children({
      connectors: <div>connectors-field</div>,
      model: <div>model-field</div>,
      skills: <div>skills-field</div>,
    }),
}));
vi.mock('./useAgentEditorForm', () => ({
  AGENT_KEY_MAX_LENGTH: 128,
  useAgentEditorForm: () => formMock.value,
}));

const baseForm = () => ({
  agentKey: '',
  canSubmit: false,
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
  patchConfig: vi.fn(),
  saving: false,
  setDependencies: vi.fn(),
  setDepValidity: vi.fn(),
  setDisplayName: vi.fn(),
  submit: vi.fn(),
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

const groupOf = (node: HTMLElement | null) => node?.closest('section')?.dataset.group;

beforeEach(() => {
  formMock.value = baseForm();
});

describe('AgentEditorForm layout', () => {
  it('lays the editor out as basics → role → model → parameters → more', () => {
    render(<AgentEditorForm />);
    const groups = [...document.querySelectorAll('section')].map((node) => node.dataset.group);
    expect(groups).toEqual([
      'agentCatalog.editor.section.basic',
      'agentCatalog.editor.section.prompt',
      'agentCatalog.editor.section.model',
      'agentCatalog.editor.section.params',
      'agentCatalog.editor.section.more',
    ]);
    // Only the advanced sections start folded; the everyday fields are always visible.
    expect([...document.querySelectorAll('section')].map((node) => node.dataset.collapsed)).toEqual(
      ['false', 'false', 'false', 'true', 'true'],
    );
  });

  it('puts the role prompt front and centre and the dependency fields where the copy promises', () => {
    render(<AgentEditorForm />);
    expect(groupOf(screen.getByLabelText('agentCatalog.editor.systemRole'))).toBe(
      'agentCatalog.editor.section.prompt',
    );
    expect(groupOf(screen.getByText('model-field'))).toBe('agentCatalog.editor.section.model');
    expect(groupOf(screen.getByText('skills-field'))).toBe('agentCatalog.editor.section.more');
    expect(groupOf(screen.getByText('connectors-field'))).toBe('agentCatalog.editor.section.more');
  });

  it('puts the avatar and its background swatches on one horizontal row', () => {
    render(<AgentEditorForm />);
    const avatar = screen.getByText('emoji-picker');
    const swatches = screen.getByText('background-swatches');
    // Same Flexbox parent, laid out horizontally — one identity row, not two labelled fields.
    expect(avatar.parentElement).toBe(swatches.parentElement);
    expect(avatar.parentElement?.dataset.horizontal).toBe('true');
    expect(avatar.parentElement?.parentElement?.dataset.layout).toBe('horizontal');
    expect(document.body.textContent).toContain('agentCatalog.editor.avatarBackground');
  });

  it('offers the identifier only while creating', () => {
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key')).not.toBeDisabled();
  });

  it('caps the identifier at the contract length and explains an illegal one inline', () => {
    formMock.value = { ...baseForm(), agentKey: 'Nope!', keyValid: false };
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key').getAttribute('maxlength')).toBe('128');
    expect(screen.getByRole('alert').textContent).toBe('agentCatalog.editor.keyInvalid');
  });

  it('says nothing about the identifier before anything has been typed', () => {
    formMock.value = { ...baseForm(), agentKey: '', keyValid: false };
    render(<AgentEditorForm />);
    expect(screen.queryByText('agentCatalog.editor.keyInvalid')).toBeNull();
  });

  it('locks the identifier when editing an existing assistant', () => {
    formMock.value = { ...baseForm(), isCreate: false };
    render(<AgentEditorForm />);
    expect(screen.getByLabelText('agentCatalog.editor.key')).toBeDisabled();
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
    // Rendered outside every form group, i.e. in the pinned footer region beside Save.
    expect(blocker.closest('section')).toBeNull();

    fireEvent.click(screen.getByText('agentCatalog.dependency.retry'));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('reports a loading-catalog blocker without inventing a retry action', () => {
    formMock.value = {
      ...baseForm(),
      depValidity: {
        blockers: [{ message: 'agentCatalog.editor.blocked.connectorCatalog' }],
        issues: [],
        ready: false,
      },
    };
    render(<AgentEditorForm />);
    expect(screen.getByRole('status').textContent).toBe(
      'agentCatalog.editor.blocked.connectorCatalog',
    );
    expect(screen.queryByText('agentCatalog.dependency.retry')).toBeNull();
  });

  it('stays quiet when nothing blocks the save', () => {
    formMock.value = { ...baseForm(), canSubmit: true };
    render(<AgentEditorForm />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns about stale dependencies inside the model section', () => {
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
      'agentCatalog.editor.section.model',
    );
  });
});
