// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import AdminAccessProvider from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAccessSnapshot } from '@/enterprise/client/services/adminAuth';
import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import SkillSettingsPage from './SkillSettingsPage';

const mocks = vi.hoisted(() => ({
  connectors: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    deleteDraft: vi.fn(),
    discover: vi.fn(),
    get: vi.fn(),
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
    <MemoryRouter initialEntries={['/admin/ai/skills']}>
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
});

describe('Admin SkillSettingsPage', () => {
  it(
    'renders the user-parity skill settings surface against the org datasource',
    { timeout: 30_000 },
    async () => {
      render(<SkillSettingsPage />, { wrapper: AppProviders });

      // Built-in skills section from the shared SkillList surface (defaultValue fallback).
      expect(
        await screen.findByText('Built-in Skills', {}, { timeout: 10_000 }),
      ).toBeInTheDocument();

      // Left header: "Skills" title plus the add (import dropdown) + store buttons.
      expect(screen.getByText('Skills')).toBeInTheDocument();
      expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(2);

      // The builtin Artifacts skill from the static tool store is listed (list
      // item and/or detail panel may both match).
      const artifactMentions = await screen.findAllByText(/artifacts/i, {}, { timeout: 10_000 });
      expect(artifactMentions.length).toBeGreaterThan(0);

      // Org catalog list was fetched through the admin skills service.
      expect(mocks.skills.list).toHaveBeenCalled();
    },
  );
});
