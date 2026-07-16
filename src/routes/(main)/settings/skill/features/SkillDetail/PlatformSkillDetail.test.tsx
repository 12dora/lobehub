// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PlatformSkillDetail from './PlatformSkillDetail';

const mocks = vi.hoisted(() => ({
  catalog: {
    data: {
      revision: 'revision-1',
      skills: [] as Array<{
        checksum: string;
        description: string | null;
        displayName: string;
        distribution: 'mandatory' | 'default' | 'optional';
        skillKey: string;
        source: 'builtin' | 'uploaded';
        version: string;
      }>,
    },
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(),
  },
  config: { plugins: [] as Array<string | { identifier: string; mode: string }> },
  setPluginModeById: vi.fn(),
  toolState: {
    platformSkillRuntimeEnforced: true,
    platformSkillRuntimeStatus: 'ready' as 'error' | 'loading' | 'ready' | 'unmanaged',
  },
}));

vi.mock('@/enterprise/client/features/skills', () => ({
  getPublishedSkillToggleMode: (distribution: string, enabled: boolean) => {
    if (distribution === 'mandatory') return null;
    if (!enabled) return 'disabled';
    return distribution === 'optional' ? 'pinned' : 'auto';
  },
  isPublishedSkillEnabled: (distribution: string, mode: string) =>
    distribution === 'mandatory' ||
    (distribution === 'optional' ? mode === 'pinned' : mode !== 'disabled'),
  usePublishedSkillCatalog: () => mocks.catalog,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (
    selector: (state: {
      activeAgentId: string;
      setPluginModeById: typeof mocks.setPluginModeById;
    }) => unknown,
  ) => selector({ activeAgentId: 'agent-a', setPluginModeById: mocks.setPluginModeById }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentSelectors: { currentAgentConfig: () => mocks.config },
}));

vi.mock('@/store/tool', () => ({
  useToolStore: (selector: (state: typeof mocks.toolState) => unknown) => selector(mocks.toolState),
}));

vi.mock('@/components/AsyncError', () => ({ default: () => <div>catalog-error</div> }));
vi.mock('@/components/Loading/BrandTextLoading', () => ({
  default: () => <div>catalog-loading</div>,
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
  }) => (
    <input
      aria-label="use-skill"
      checked={checked}
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
    />
  ),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => ({ body: '', card: '', description: '', header: '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const skill = (distribution: 'mandatory' | 'default' | 'optional') => ({
  checksum: 'a'.repeat(64),
  description: 'Approved description',
  displayName: 'Approved Skill',
  distribution,
  skillKey: 'approved.skill',
  source: 'uploaded' as const,
  version: '1.0.0',
});

describe('PlatformSkillDetail', () => {
  beforeEach(() => {
    mocks.catalog.data.skills = [];
    mocks.config.plugins = [];
    mocks.setPluginModeById.mockReset();
    mocks.setPluginModeById.mockResolvedValue(undefined);
    mocks.toolState.platformSkillRuntimeEnforced = true;
    mocks.toolState.platformSkillRuntimeStatus = 'ready';
  });

  it('shows mandatory Skills as enabled without a mutation control', () => {
    mocks.catalog.data.skills = [skill('mandatory')];
    render(<PlatformSkillDetail skillKey="approved.skill" />);

    const toggle = screen.getByLabelText('use-skill') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText('platformSkills.detail.mandatoryManaged')).toBeTruthy();
  });

  it('pins an optional Skill when the user enables it for the current assistant', async () => {
    mocks.catalog.data.skills = [skill('optional')];
    render(<PlatformSkillDetail skillKey="approved.skill" />);

    fireEvent.click(screen.getByLabelText('use-skill'));

    await waitFor(() =>
      expect(mocks.setPluginModeById).toHaveBeenCalledWith('agent-a', 'approved.skill', 'pinned'),
    );
  });
});
