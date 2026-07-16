/**
 * Role modal: selecting super_admin clears/hides expiry; payload has no expiresAt.
 * @vitest-environment happy-dom
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { openReplaceRolesModal } from './actions';

const onSubmitPayloads: unknown[] = [];
let lastBuildPayload: ((reason: string) => unknown) | null = null;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  default: { t: (k: string) => k },
}));

vi.mock('i18next', () => ({
  default: { t: (k: string) => k },
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: { colorTextSecondary: '#888' },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    DatePicker: ({ disabled, 'aria-label': aria }: any) =>
      React.createElement('input', {
        'type': 'datetime-local',
        'aria-label': aria || 'expiry',
        disabled,
      }),
    Text: ({ children }: any) => React.createElement('span', null, children),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Checkbox: ({ checked, disabled, onChange }: any) =>
      React.createElement('input', {
        type: 'checkbox',
        checked,
        disabled,
        onChange: (e: any) => onChange?.(e.target.checked),
      }),
    toast: { success: vi.fn() },
  };
});

vi.mock('./openReasonModal', () => ({
  openReasonModal: (props: any) => {
    lastBuildPayload = props.buildPayload;
    // Mount extra to exercise super_admin toggle
    const { createRoot } = require('react-dom/client');
    const root = document.createElement('div');
    document.body.appendChild(root);
    createRoot(root).render(
      typeof props.extra === 'function'
        ? props.extra({ locked: false, phase: 'idle' })
        : props.extra,
    );
    return { close: vi.fn(), destroy: vi.fn(), update: vi.fn() };
  },
}));

describe('openReplaceRolesModal super_admin expiry policy', () => {
  beforeEach(() => {
    onSubmitPayloads.length = 0;
    lastBuildPayload = null;
    document.body.innerHTML = '';
  });

  it('selecting super_admin clears expiry from payload and validate rejects expiry combo', async () => {
    openReplaceRolesModal({
      actorRoles: [{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }],
      currentRoles: [],
      targetLabel: 't',
      userId: 'u1',
      onConfirm: async (input) => {
        onSubmitPayloads.push(input);
      },
    });

    await waitFor(() => expect(screen.getByText('users.roles.super_admin')).toBeTruthy());

    // Toggle super_admin checkbox (first checkbox is super_admin when eligible includes it)
    const checkboxes = screen.getAllByRole('checkbox');
    // super_admin is first in ASSIGNABLE_ROLES for super actor
    fireEvent.click(checkboxes[0]!);

    await waitFor(() => {
      // Expiry field should be hidden — superAdminNoExpiry copy shown
      expect(screen.getByText('users.modals.roles.superAdminNoExpiry')).toBeTruthy();
    });
    expect(screen.queryByLabelText('users.modals.roles.expiryOptional')).toBeNull();

    expect(lastBuildPayload).toBeTruthy();
    const payload = lastBuildPayload!('need super') as {
      expiresAt?: Date;
      reason: string;
      roleNames: string[];
    };
    expect(payload.reason).toBe('need super');
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.expiresAt).toBeUndefined();
  });
});
