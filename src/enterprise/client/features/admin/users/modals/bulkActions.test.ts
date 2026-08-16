import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_REASON } from '../auditReasonCodes';
import {
  formatBulkTargetLabel,
  openBulkBanModal,
  openBulkDeleteModal,
  openBulkUnbanModal,
  runBulkUserMutations,
  skipSelfTargets,
} from './bulkActions';
import { openReasonModal } from './openReasonModal';

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'users.modals.bulk.more') return `+${opts?.count}`;
      return key;
    },
  },
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Checkbox: () => null,
  Input: () => null,
  toast,
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
  keyframes: () => '',
}));

vi.mock('@lobehub/ui', () => ({
  DatePicker: () => null,
  Text: ({ children }: { children?: unknown }) => children,
}));

vi.mock('./openReasonModal', () => ({
  openReasonModal: vi.fn(),
}));

vi.mock('./actions', () => ({
  BanExtraFields: () => null,
  buildReplaceGlobalRolesPayload: vi.fn(),
  getEligibleAssignableRoles: () => [],
}));

const lastReasonModal = () => {
  const call = vi.mocked(openReasonModal).mock.calls.at(-1);
  if (!call) throw new Error('openReasonModal was not called');
  return call[0];
};

describe('bulk user helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops the actor from selected targets', () => {
    const targets = [
      { id: 'me', label: 'Me' },
      { id: 'u1', label: 'Alice' },
    ];
    expect(skipSelfTargets(targets, 'me').map((item) => item.id)).toEqual(['u1']);
  });

  it('formats a preview with overflow', () => {
    const targets = [
      { id: '1', label: 'A' },
      { id: '2', label: 'B' },
      { id: '3', label: 'C' },
      { id: '4', label: 'D' },
    ];
    expect(formatBulkTargetLabel(targets)).toBe('A, B, C +1');
  });

  it('runs mutations sequentially, skips self, and collects failures', async () => {
    const mutate = vi.fn(async (item: { id: string }) => {
      if (item.id === 'bad') throw new Error('nope');
    });

    const result = await runBulkUserMutations({
      actorUserId: 'me',
      items: [
        { id: 'me', label: 'Me' },
        { id: 'ok', label: 'Ok' },
        { id: 'bad', label: 'Bad' },
      ],
      mutate,
    });

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls.map(([item]) => item.id)).toEqual(['ok', 'bad']);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.label).toBe('Bad');
  });
});

describe('bulk reason modals', () => {
  const targets = [
    { id: 'me', label: 'Me' },
    { id: 'u1', label: 'Alice' },
    { id: 'u2', label: 'Bob' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not open a modal when every target is the actor', () => {
    openBulkBanModal({
      actorUserId: 'me',
      targets: [{ id: 'me', label: 'Me' }],
      onConfirmEach: vi.fn(),
    });
    expect(openReasonModal).not.toHaveBeenCalled();
  });

  it('bans selected users sequentially with one shared reason and skips self', async () => {
    const order: string[] = [];
    const onConfirmEach = vi.fn(async (input: { userId: string }) => {
      order.push(input.userId);
    });
    const onDone = vi.fn();

    openBulkBanModal({
      actorUserId: 'me',
      authMethod: 'better-auth',
      targets,
      onConfirmEach,
      onDone,
    });

    expect(openReasonModal).toHaveBeenCalledTimes(1);
    const cfg = lastReasonModal();
    expect(cfg.danger).toBe(true);
    expect(cfg.title).toBe('users.modals.bulk.ban.title');
    expect(cfg.submitLabel).toBe('users.modals.bulk.ban.confirm');
    expect(cfg.targetLabel).toBe('Alice, Bob');

    const payload = cfg.buildPayload('abuse');
    await cfg.onSubmit(payload);

    expect(onConfirmEach.mock.calls.map(([input]) => input)).toEqual([
      { reason: 'abuse', userId: 'u1' },
      { reason: 'abuse', userId: 'u2' },
    ]);
    expect(order).toEqual(['u1', 'u2']);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('unbans sequentially and summarizes partial failure', async () => {
    const onConfirmEach = vi.fn(async (input: { userId: string }) => {
      if (input.userId === 'u2') throw new Error('nope');
    });
    const onDone = vi.fn();

    openBulkUnbanModal({
      actorUserId: 'me',
      targets,
      onConfirmEach,
      onDone,
    });

    expect(openReasonModal).toHaveBeenCalledTimes(1);
    const cfg = lastReasonModal();
    expect(cfg.danger).toBeUndefined();
    expect(cfg.title).toBe('users.modals.bulk.unban.title');

    await cfg.onSubmit(cfg.buildPayload('appeal'));

    expect(onConfirmEach).toHaveBeenCalledTimes(2);
    expect(onConfirmEach.mock.calls[0]![0]).toMatchObject({ reason: 'appeal', userId: 'u1' });
    expect(onConfirmEach.mock.calls[1]![0]).toMatchObject({ reason: 'appeal', userId: 'u2' });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(String(toast.warning.mock.calls[0]![0])).toContain('users.toast.bulkSummary');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('deletes through a confirm-only modal with a shared auto reason', async () => {
    const onConfirmEach = vi.fn(async (_input: { reason: string; userId: string }) => undefined);
    const onDone = vi.fn();

    openBulkDeleteModal({
      actorUserId: 'me',
      targets,
      onConfirmEach,
      onDone,
    });

    expect(openReasonModal).toHaveBeenCalledTimes(1);
    const cfg = lastReasonModal();
    expect(cfg.danger).toBe(true);
    expect(cfg.hideReason).toBe(true);
    expect(cfg.autoReason).toBe(AUTO_REASON.delete);
    expect(cfg.title).toBe('users.modals.bulk.delete.title');
    expect(cfg.validateExtra?.()).toBe('users.modals.delete.typeConfirmMismatch');

    const payload = cfg.buildPayload(AUTO_REASON.delete);
    await cfg.onSubmit(payload);

    expect(onConfirmEach.mock.calls.map(([input]) => input)).toEqual([
      { reason: AUTO_REASON.delete, userId: 'u1' },
      { reason: AUTO_REASON.delete, userId: 'u2' },
    ]);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
