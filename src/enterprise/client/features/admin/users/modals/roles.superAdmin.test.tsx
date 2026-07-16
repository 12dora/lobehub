/**
 * Role modal: set expiry first, then select super_admin → expiry cleared/hidden; no expiresAt.
 * @vitest-environment happy-dom
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import dayjs from 'dayjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { openReplaceRolesModal } from './actions';

let lastBuildPayload: ((reason: string) => unknown) | null = null;
let lastValidateExtra: (() => string | null) | null = null;
/** Captured DatePicker onChange — used to re-inject expiry for fail-closed. */
let expiryOnChange: ((v: unknown) => void) | null = null;

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
    DatePicker: ({ disabled, 'aria-label': aria, onChange, value }: any) => {
      expiryOnChange = onChange;
      return React.createElement(
        'div',
        null,
        React.createElement('input', {
          'type': 'datetime-local',
          'aria-label': aria || 'expiry',
          disabled,
          'value': value ? String(value) : '',
          'readOnly': true,
        }),
        React.createElement(
          'button',
          {
            'type': 'button',
            'aria-label': 'set-expiry',
            disabled,
            'onClick': () => onChange?.(dayjs('2026-12-01T15:00:00.000Z')),
          },
          'set-expiry',
        ),
      );
    },
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
    lastValidateExtra = props.validateExtra;
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
    lastBuildPayload = null;
    lastValidateExtra = null;
    expiryOnChange = null;
    document.body.innerHTML = '';
  });

  it('sets non-null expiry then selects super_admin: UI hides expiry and payload omits expiresAt', async () => {
    openReplaceRolesModal({
      actorRoles: [{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }],
      currentRoles: [PLATFORM_SYSTEM_ROLES.USER_ADMIN],
      targetLabel: 't',
      userId: 'u1',
      onConfirm: async () => undefined,
    });

    await waitFor(() => expect(screen.getByText('users.roles.super_admin')).toBeTruthy());

    // First set a non-null expiry via functional DatePicker mock
    expect(screen.getByLabelText('set-expiry')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('set-expiry'));

    // Then select super_admin (first checkbox in ASSIGNABLE order)
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);

    await waitFor(() => {
      expect(screen.getByText('users.modals.roles.superAdminNoExpiry')).toBeTruthy();
    });
    // Expiry picker hidden after super selection
    expect(screen.queryByLabelText('set-expiry')).toBeNull();
    expect(screen.queryByLabelText('users.modals.roles.expiryOptional')).toBeNull();

    const payload = lastBuildPayload!('need super') as {
      expiresAt?: Date;
      reason: string;
      roleNames: string[];
    };
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.expiresAt).toBeUndefined();
    expect(lastValidateExtra!()).toBeNull();
  });

  it('validateExtra fail-closes if super_admin somehow coexists with expiry', async () => {
    openReplaceRolesModal({
      actorRoles: [{ name: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN }],
      currentRoles: [],
      targetLabel: 't',
      userId: 'u1',
      onConfirm: async () => undefined,
    });

    await waitFor(() => expect(lastValidateExtra).toBeTruthy());
    await waitFor(() => expect(expiryOnChange).toBeTruthy());

    // Capture onChange while DatePicker is mounted, set expiry, then select super
    // (toggle clears exp). Re-inject expiry via captured setter to simulate both present.
    const setExpiry = expiryOnChange!;
    fireEvent.click(screen.getByLabelText('set-expiry'));
    fireEvent.click(screen.getAllByRole('checkbox')[0]!); // super — clears exp + hides picker

    await waitFor(() => {
      expect(screen.getByText('users.modals.roles.superAdminNoExpiry')).toBeTruthy();
    });
    expect(lastValidateExtra!()).toBeNull();
    expect((lastBuildPayload!('ok') as { expiresAt?: Date }).expiresAt).toBeUndefined();

    // Corrupt/re-inject: force expiresAt while super remains selected
    setExpiry(dayjs('2026-12-01T15:00:00.000Z'));

    await waitFor(() => {
      expect(lastValidateExtra!()).toBe('users.modals.roles.superAdminNoExpiry');
    });

    // Defense in depth: buildPayload still omits expiresAt when super is selected
    const payload = lastBuildPayload!('both') as {
      expiresAt?: Date;
      roleNames: string[];
    };
    expect(payload.roleNames).toContain(PLATFORM_SYSTEM_ROLES.SUPER_ADMIN);
    expect(payload.expiresAt).toBeUndefined();
  });
});
