// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openAgentEditorModal } from './openAgentEditorModal';
import type { AdminAgentDetailOutput } from './types';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  confirmModal: vi.fn(),
  createModal: vi.fn(),
  update: vi.fn(),
}));

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: (...args: unknown[]) => mocks.confirmModal(...args),
  createModal: (...args: unknown[]) => {
    mocks.createModal(...args);
    return { close: mocks.close, update: mocks.update };
  },
}));
vi.mock('./AgentEditorForm', () => ({ AgentEditorForm: () => null }));

const agent = { identity: { id: 'agent-1' } } as AdminAgentDetailOutput;

const lastOptions = () =>
  mocks.createModal.mock.calls.at(-1)![0] as {
    footer: unknown;
    maskClosable: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
  };

/** Reach the form props the modal rendered so the dirty ref can be driven like the user would. */
const formProps = () =>
  (mocks.createModal.mock.calls.at(-1)![0] as { content: { props: Record<string, any> } }).content
    .props;

describe('openAgentEditorModal', () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.confirmModal.mockReset();
    mocks.createModal.mockReset();
    mocks.update.mockReset();
  });

  it.each([
    ['create', undefined, 'agentCatalog.editor.title.create'],
    ['edit', agent, 'agentCatalog.editor.title.edit'],
  ])('titles the %s mode and never dismisses on the backdrop', (_label, value, title) => {
    openAgentEditorModal({ agent: value as AdminAgentDetailOutput | undefined });
    const options = lastOptions();
    expect(options.title).toBe(title);
    expect(options.maskClosable).toBe(false);
    // The modal owns its own footer (Cancel / Save), never the default one.
    expect(options.footer).toBeNull();
    expect(formProps().agent).toBe(value);
  });

  it('keeps the modal body from scrolling so the form can pin its own footer', () => {
    openAgentEditorModal({ agent });
    const { styles } = mocks.createModal.mock.calls.at(-1)![0] as {
      styles: { content: Record<string, unknown> };
    };
    // The form owns one scroll region; the modal content must not become a second one.
    expect(styles.content).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    });
  });

  it('closes straight away when nothing is unsaved', () => {
    openAgentEditorModal({ agent });
    lastOptions().onOpenChange(false);
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('re-opens and confirms before discarding unsaved input', () => {
    openAgentEditorModal({ agent });
    formProps().dirtyRef.current = true;

    lastOptions().onOpenChange(false);
    // base-ui already flipped it closed — it must be pinned open until the admin decides.
    expect(mocks.update).toHaveBeenCalledWith({ open: true });
    expect(mocks.close).not.toHaveBeenCalled();

    const confirm = mocks.confirmModal.mock.calls[0]![0] as { onOk: () => void };
    confirm.onOk();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('does not challenge the programmatic close that follows a committed save', () => {
    openAgentEditorModal({ agent });
    const props = formProps();
    props.dirtyRef.current = true;

    props.onClose();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    // The guard is released, so a later onOpenChange cannot resurrect the modal.
    lastOptions().onOpenChange(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('guards Cancel exactly like Escape when input is unsaved', () => {
    openAgentEditorModal({ agent });
    const props = formProps();
    props.dirtyRef.current = true;

    props.onCancel();
    expect(mocks.close).not.toHaveBeenCalled();
    const confirm = mocks.confirmModal.mock.calls[0]![0] as { onOk: () => void };
    confirm.onOk();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('lets Cancel close straight away when nothing is unsaved', () => {
    openAgentEditorModal({ agent });
    formProps().onCancel();
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('vetoes Escape / X while a save is in flight, with no discard prompt', () => {
    openAgentEditorModal({ agent });
    const props = formProps();
    props.dirtyRef.current = true;
    props.pendingRef.current = true;

    lastOptions().onOpenChange(false);
    // The write may still commit — nothing may be discarded and nothing may be asked yet.
    expect(mocks.update).toHaveBeenCalledWith({ open: true });
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();

    // Cancel is disabled mid-write, but a stray invocation must not slip past the guard either.
    props.onCancel();
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('vetoes dismissal mid-write even when nothing is dirty yet', () => {
    openAgentEditorModal({});
    const props = formProps();
    props.pendingRef.current = true;

    lastOptions().onOpenChange(false);
    expect(mocks.update).toHaveBeenCalledWith({ open: true });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it('ignores an open transition', () => {
    openAgentEditorModal({ agent });
    formProps().dirtyRef.current = true;
    lastOptions().onOpenChange(true);
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
