// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import AdminAccessProvider from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAccessSnapshot } from '@/enterprise/client/services/adminAuth';
import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import ConnectorSettingsPage from './ConnectorSettingsPage';

const mocks = vi.hoisted(() => ({
  connectors: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    deleteDraft: vi.fn(),
    discover: vi.fn(),
    get: vi.fn(),
    getGovernance: vi.fn(async () => ({
      doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
      managedActive: false,
      revision: 0,
    })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  },
  skills: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    get: vi.fn(),
    getVersion: vi.fn(),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    parseImportSource: vi.fn(),
  },
}));

const governanceFixture = {
  doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
  managedActive: false,
  revision: 0,
};

vi.mock('@/enterprise/client/services/adminSkills', () => ({
  adminSkillsService: mocks.skills,
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: mocks.connectors,
}));

/** Explicit admin-access fixture — page tree uses useAdminAccess via useAdminGlobalToolScope. */
const fetchAdminAccessFixture = async (): Promise<AdminAccessSnapshot> => ({
  authMethod: 'better-auth',
  hasAdminAccess: true,
  permissions: [
    PLATFORM_PERMISSIONS.ADMIN_ACCESS,
    PLATFORM_PERMISSIONS.CONNECTOR_READ,
    PLATFORM_PERMISSIONS.CONNECTOR_CREATE,
    PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
    PLATFORM_PERMISSIONS.CONNECTOR_DELETE,
    PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH,
    PLATFORM_PERMISSIONS.SKILL_READ,
    PLATFORM_PERMISSIONS.SKILL_CREATE,
    PLATFORM_PERMISSIONS.SKILL_UPDATE,
    PLATFORM_PERMISSIONS.SKILL_DELETE,
    PLATFORM_PERMISSIONS.SKILL_PUBLISH,
  ],
  roles: [{ displayName: 'ai_admin', name: 'ai_admin' }],
});

const AppProviders = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>
    <MemoryRouter initialEntries={['/admin/ai/connectors']}>
      <ServerConfigStoreProvider>
        <AdminAccessProvider fetchAccess={fetchAdminAccessFixture}>
          <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
        </AdminAccessProvider>
      </ServerConfigStoreProvider>
    </MemoryRouter>
  </MotionProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.connectors.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.connectors.getGovernance.mockResolvedValue(governanceFixture);
});

describe('Admin ConnectorSettingsPage', () => {
  it(
    'renders the user-parity connector surface without the per-user caveat notice',
    { timeout: 30_000 },
    async () => {
      render(<ConnectorSettingsPage />, { wrapper: AppProviders });

      // Built-in tools section from the shared SkillList surface (defaultValue fallback).
      expect(
        await screen.findByText('Built-in Tools', {}, { timeout: 10_000 }),
      ).toBeInTheDocument();

      // The per-user caveat notice is gone: org governance now makes builtin
      // permissions and shared OAuth genuinely global.
      expect(screen.queryByText(/Changes here apply to every user/)).toBeNull();

      // Left header: "Connectors" title plus the add-custom-connector + store buttons.
      expect(screen.getByText('Connectors')).toBeInTheDocument();
      expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(2);

      // Platform connector catalog was fetched through the admin connectors service.
      expect(mocks.connectors.list).toHaveBeenCalled();
    },
  );

  it(
    'keeps a governance failure actionable with built-ins, dedupes its toast, and clears it after Retry',
    { timeout: 30_000 },
    async () => {
      const governanceErrorA = new Error('governance unavailable A');
      const governanceErrorB = new Error('governance unavailable B');
      mocks.connectors.getGovernance
        .mockRejectedValueOnce(governanceErrorA)
        .mockRejectedValueOnce(governanceErrorB)
        .mockResolvedValueOnce(governanceFixture);
      const toastError = vi.spyOn(toast, 'error').mockImplementation(() => '' as never);

      render(<ConnectorSettingsPage />, { wrapper: AppProviders });

      expect(
        await screen.findByText(
          'Connector permissions could not be loaded. Retry before making changes.',
          {},
          { timeout: 10_000 },
        ),
      ).toBeInTheDocument();
      expect(await screen.findByText('Built-in Tools')).toBeInTheDocument();
      // Governance is absent, so builtin fallback rows stay display-only.
      expect(screen.queryByRole('button', { name: 'Reset permissions' })).toBeNull();
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));

      const retry = screen.getByRole('button', { name: 'Retry permissions' });
      const callsBeforeFailedRetry = mocks.connectors.getGovernance.mock.calls.length;
      const listCallsBeforeRetry = mocks.connectors.list.mock.calls.length;
      fireEvent.click(retry);
      await waitFor(() =>
        expect(mocks.connectors.getGovernance.mock.calls.length).toBeGreaterThan(
          callsBeforeFailedRetry,
        ),
      );
      expect(
        screen.getByText('Connector permissions could not be loaded. Retry before making changes.'),
      ).toBeInTheDocument();
      expect(mocks.connectors.list).toHaveBeenCalledTimes(listCallsBeforeRetry);
      // A fresh Error instance in the same visible failure episode must not create another toast.
      expect(toastError).toHaveBeenCalledTimes(1);

      fireEvent.click(retry);
      await waitFor(() =>
        expect(
          screen.queryByText(
            'Connector permissions could not be loaded. Retry before making changes.',
          ),
        ).toBeNull(),
      );
      expect(mocks.connectors.list).toHaveBeenCalledTimes(listCallsBeforeRetry);
      toastError.mockRestore();
    },
  );
});
