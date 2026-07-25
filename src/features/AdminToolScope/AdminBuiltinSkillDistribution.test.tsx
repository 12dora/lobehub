// @vitest-environment happy-dom
import { toast } from '@lobehub/ui/base-ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AdminBuiltinSkillDistribution from './AdminBuiltinSkillDistribution';
import type { AdminToolScope } from './index';

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Segmented: ({
      disabled,
      onChange,
      options,
      value,
    }: {
      disabled?: boolean;
      onChange?: (next: string) => void;
      options: { label: string; value: string }[];
      value: string;
    }) => (
      <div data-disabled={disabled ? 'true' : 'false'} data-testid="distribution-segmented">
        {options.map((opt) => (
          <button
            data-testid={`dist-${opt.value}`}
            disabled={disabled || opt.value === value}
            key={opt.value}
            type="button"
            onClick={() => onChange?.(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    ),
    toast: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const makeScope = (overrides: Partial<AdminToolScope> = {}): AdminToolScope =>
  ({
    canSetBuiltinSkillDistribution: () => true,
    capabilities: {
      canCreateConnector: false,
      canCreateSkill: true,
      canDeleteConnector: false,
      canDeleteSkill: false,
      canUpdateConnector: false,
      canUpdateSkill: true,
    },
    connectors: [],
    deleteConnector: vi.fn(),
    deleteOrgSkill: vi.fn(),
    getBuiltinSkillDistribution: () => 'optional' as const,
    importFromGithub: vi.fn(),
    importFromUrl: vi.fn(),
    importFromZip: vi.fn(),
    installFromMarket: vi.fn(),
    isBuiltinSkillEnabled: () => true,
    isConnectorReadOnly: () => false,
    listLoading: false,
    orgSkills: [],
    resetConnectorPermissions: vi.fn(),
    retry: vi.fn(),
    setBuiltinSkillDistribution: vi.fn().mockResolvedValue(undefined),
    submitCustomConnector: vi.fn(),
    toggleBuiltinSkill: vi.fn(),
    updateToolPermission: vi.fn(),
    useOrgSkillDetail: () => ({ isLoading: false }),
    ...overrides,
  }) as AdminToolScope;

describe('AdminBuiltinSkillDistribution', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it('disables the control when canSetBuiltinSkillDistribution is false (ASKC-03)', () => {
    const scope = makeScope({
      canSetBuiltinSkillDistribution: () => false,
    });
    render(<AdminBuiltinSkillDistribution identifier="lobe-artifacts" scope={scope} />);

    expect(screen.getByTestId('distribution-segmented')).toHaveAttribute('data-disabled', 'true');
    expect(scope.setBuiltinSkillDistribution).not.toHaveBeenCalled();
  });

  it('toasts a translated error when the distribution mutation rejects (ASKC-03)', async () => {
    const scope = makeScope({
      setBuiltinSkillDistribution: vi
        .fn()
        .mockRejectedValue(new Error('PLATFORM_PERMISSION_DENIED')),
    });
    render(<AdminBuiltinSkillDistribution identifier="lobe-artifacts" scope={scope} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('dist-mandatory'));
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith('skillCatalog.toast.distributionFailed');
    });
    expect(scope.setBuiltinSkillDistribution).toHaveBeenCalledWith('lobe-artifacts', 'mandatory');
  });
});
