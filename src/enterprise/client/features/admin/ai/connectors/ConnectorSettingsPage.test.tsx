// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { render, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerConfigStoreProvider } from '@/store/serverConfig/Provider';

import ConnectorSettingsPage from './ConnectorSettingsPage';

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
  clearLastAdminSkillPublishOutcome: vi.fn(),
  getLastAdminSkillPublishOutcome: vi.fn(() => null),
  setLastAdminSkillPublishOutcome: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: mocks.connectors,
  clearLastAdminConnectorPublishOutcome: vi.fn(),
  getLastAdminConnectorPublishOutcome: vi.fn(() => null),
  setLastAdminConnectorPublishOutcome: vi.fn(),
}));

const AppProviders = ({ children }: { children: ReactNode }) => (
  <MotionProvider motion={motion}>
    <MemoryRouter initialEntries={['/admin/ai/connectors']}>
      <ServerConfigStoreProvider>
        <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
      </ServerConfigStoreProvider>
    </MemoryRouter>
  </MotionProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skills.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.connectors.list.mockResolvedValue({ items: [], nextCursor: null });
});

describe('Admin ConnectorSettingsPage', () => {
  it(
    'renders the user-parity connector surface with the org-wide notice',
    { timeout: 30_000 },
    async () => {
      render(<ConnectorSettingsPage />, { wrapper: AppProviders });

      // Built-in tools section from the shared SkillList surface (defaultValue fallback).
      expect(
        await screen.findByText('Built-in Tools', {}, { timeout: 10_000 }),
      ).toBeInTheDocument();

      // Org notice alert (admin:aiConnectorSettings.orgNotice defaultValue).
      expect(
        await screen.findByText(/Changes here apply to every user/, {}, { timeout: 10_000 }),
      ).toBeInTheDocument();

      // Left header: "Connectors" title plus the add-custom-connector + store buttons.
      expect(screen.getByText('Connectors')).toBeInTheDocument();
      expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(2);

      // Platform connector catalog was fetched through the admin connectors service.
      expect(mocks.connectors.list).toHaveBeenCalled();
    },
  );
});
