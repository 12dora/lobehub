// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import type { ConflictState } from './conflictStateMachine';
import SettingsPolicyConflictBanner from './SettingsPolicyConflictBanner';

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ description, message }: { description?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {description}
    </div>
  ),
  Text: ({ as: Component = 'span', children }: any) => <Component>{children}</Component>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'settingsPolicy.unknownSetting') return `Localized setting ${values?.index}`;
      if (key === 'missing.title') return String(values?.defaultValue ?? '');
      if (typeof values?.value === 'string') return `${key}: ${values.value}`;
      return key;
    },
  }),
}));

const sentinelPath = 'machine.private.sentinel';
const policy = {
  mode: 'locked' as const,
  schemaVersion: 1,
  value: 'visible-value',
  visibility: 'hidden' as const,
};
const conflictState: ConflictState = {
  conflictingPaths: [sentinelPath],
  localBaseRevision: 1,
  localDraft: { [sentinelPath]: policy },
  localDraftToken: 'a'.repeat(64),
  originalBaseDraft: {},
  phase: 'conflict',
  serverBaseRevision: 2,
  serverDraft: { [sentinelPath]: { ...policy, value: 'new-value' } },
  serverDraftToken: 'b'.repeat(64),
};

const renderBanner = (registry: AdminSettingsGetDraftOutput['registry'] = []) =>
  render(
    <SettingsPolicyConflictBanner
      canUpdate
      conflictState={conflictState}
      registryByPath={new Map(registry.map((entry) => [entry.path, entry]))}
      onDiscard={vi.fn()}
      onRebase={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );

describe('SettingsPolicyConflictBanner safe labels', () => {
  it('does not expose a machine path when registry metadata is absent', () => {
    const { container } = renderBanner();

    expect(screen.getByText('Localized setting 1')).toBeInTheDocument();
    expect(container.textContent).not.toContain(sentinelPath);
  });

  it('uses the same localized fallback when title translation metadata is absent', () => {
    const { container } = renderBanner([
      {
        control: 'text',
        descriptionKey: 'missing.description',
        group: 'general',
        path: sentinelPath,
        schemaVersion: 1,
        titleKey: 'missing.title',
      },
    ]);

    expect(screen.getByText('Localized setting 1')).toBeInTheDocument();
    expect(container.textContent).not.toContain(sentinelPath);
  });
});
