import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EnabledModelList from './index';

const mocks = vi.hoisted(() => ({
  batchToggleAiModels: vi.fn(),
  canManageProvider: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));

vi.mock('@/features/ManagedResources', () => ({
  useManagedResource: () => ({ managed: false }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: mocks.canManageProvider, reason: 'requires owner' }),
}));

vi.mock('@/store/aiInfra', () => ({
  useScopedAiInfraStore: (selector: (s: any) => unknown) =>
    selector({
      batchToggleAiModels: mocks.batchToggleAiModels,
      enabledModels: [
        { enabled: true, id: 'gpt-4o', type: 'chat' },
        { enabled: true, id: 'gpt-4.1', type: 'chat' },
      ],
    }),
}));

vi.mock('@/store/aiInfra/selectors', () => ({
  aiModelSelectors: { enabledAiProviderModelList: (s: any) => s.enabledModels },
}));

vi.mock('../ModelItem', () => ({ default: ({ id }: { id: string }) => <div>{id}</div> }));
vi.mock('../SortModelModal', () => ({ default: () => null }));

const clickDisableAll = () => fireEvent.click(screen.getAllByRole('button')[0]!);

describe('EnabledModelList disable-all', () => {
  beforeEach(() => {
    mocks.batchToggleAiModels.mockReset();
    mocks.canManageProvider = true;
  });

  it('batch-disables every togglable model', async () => {
    mocks.batchToggleAiModels.mockResolvedValue(undefined);

    render(<EnabledModelList activeTab="all" />);
    clickDisableAll();

    await waitFor(() =>
      expect(mocks.batchToggleAiModels).toHaveBeenCalledWith(['gpt-4o', 'gpt-4.1'], false),
    );
  });

  it('recovers from a rejected batch instead of spinning forever', async () => {
    // The production symptom: the batch threw (unmaterialized builtin) and the spinner was
    // never cleared, so the control was dead until a page reload.
    mocks.batchToggleAiModels.mockRejectedValue(new Error('Model not found: gpt-4o'));

    render(<EnabledModelList activeTab="all" />);
    clickDisableAll();
    await waitFor(() => expect(mocks.batchToggleAiModels).toHaveBeenCalledTimes(1));

    // Still operable: the loading state cleared, so a retry actually reaches the store.
    mocks.batchToggleAiModels.mockResolvedValue(undefined);
    clickDisableAll();
    await waitFor(() => expect(mocks.batchToggleAiModels).toHaveBeenCalledTimes(2));
  });

  it('does nothing when provider management is denied', () => {
    mocks.canManageProvider = false;

    render(<EnabledModelList activeTab="all" />);
    clickDisableAll();

    expect(mocks.batchToggleAiModels).not.toHaveBeenCalled();
  });
});
