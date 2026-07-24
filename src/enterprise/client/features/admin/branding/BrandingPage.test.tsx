import { MotionProvider } from '@lobehub/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type {
  AdminBrandingDraft,
  AdminBrandingGetDraftOutput,
} from '@/server/enterprise/contracts/adminBranding';

import BrandingPage from './BrandingPage';
import { useBrandingEditorStore } from './store';

const mocks = vi.hoisted(() => ({
  admin: {
    authMethod: 'better-auth',
    permissions: [] as string[],
    status: 'allowed',
  },
  fetch: {
    data: undefined as AdminBrandingGetDraftOutput | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(async (): Promise<AdminBrandingGetDraftOutput | undefined> => undefined),
  },
  modalCalls: [] as Record<string, unknown>[],
  platformRefresh: vi.fn(async () => {}),
  publish: vi.fn(),
  rollback: vi.fn(),
  saveDraft: vi.fn(),
  uploadAsset: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The application mounts MotionProvider globally. Keep this interaction test
// focused on branding behavior by replacing the motion-aware primitive.
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: vi.fn(),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => mocks.admin,
}));

vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => ({
    capabilities: { features: { runtimeBranding: true } },
    refresh: mocks.platformRefresh,
  }),
}));

vi.mock('@/enterprise/client/services/adminBranding', () => ({
  adminBrandingService: {
    publish: mocks.publish,
    rollback: mocks.rollback,
    saveDraft: mocks.saveDraft,
    uploadAsset: mocks.uploadAsset,
  },
}));

vi.mock('../users/modals/openReasonModal', () => ({
  openReasonModal: (params: Record<string, unknown>) => {
    mocks.modalCalls.push(params);
  },
}));

vi.mock('./useAdminBranding', () => ({
  useFetchAdminBranding: () => mocks.fetch,
}));

const draft = (name = 'Published Brand'): AdminBrandingDraft => ({
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name,
  ogImageUrl: null,
  pageTitleTemplate: `%s · ${name}`,
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
});

const data = (
  override: Partial<AdminBrandingGetDraftOutput> = {},
): AdminBrandingGetDraftOutput => ({
  baseRevision: 2,
  draft: draft(),
  draftMatchesPublished: true,
  draftToken: 'a'.repeat(64),
  published: { ...draft(), name: 'Published Brand', revision: 2 },
  revisions: [{ createdAt: new Date(), createdBy: 'admin', reason: 'initial', revision: 1 }],
  storageConfigured: true,
  ...override,
});

const renderPage = () => {
  const router = createMemoryRouter([{ element: <BrandingPage />, path: '/' }], {
    initialEntries: ['/'],
  });
  return render(
    <MotionProvider motion={motion}>
      <RouterProvider router={router} />
    </MotionProvider>,
  );
};

const latestModal = () =>
  mocks.modalCalls.at(-1) as {
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<void>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.modalCalls.length = 0;
  mocks.admin.permissions = [
    PLATFORM_PERMISSIONS.BRANDING_READ,
    PLATFORM_PERMISSIONS.BRANDING_UPDATE,
    PLATFORM_PERMISSIONS.BRANDING_PUBLISH,
  ];
  mocks.admin.status = 'allowed';
  mocks.fetch.data = data();
  mocks.fetch.error = undefined;
  mocks.fetch.isLoading = false;
  mocks.fetch.mutate.mockImplementation(async () => mocks.fetch.data);
  useBrandingEditorStore.getState().reset();
});

describe('BrandingPage interactions', () => {
  it('saves local edits and shows a persistent pending-publish state', async () => {
    mocks.saveDraft.mockResolvedValue({
      baseRevision: 2,
      draftToken: 'b'.repeat(64),
      ok: true,
    });
    renderPage();
    const name = await screen.findByLabelText('branding.fields.name');
    fireEvent.change(name, { target: { value: 'Saved Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'branding.actions.save' }));
    const modal = latestModal();
    await act(() => modal.onSubmit(modal.buildPayload('save reason')));

    expect(mocks.saveDraft).toHaveBeenCalledOnce();
    expect(screen.getByText('branding.status.pendingPublish')).toBeInTheDocument();
    expect(screen.getByText('branding.status.draftSaved')).toBeInTheDocument();
    expect(screen.getByText('primitives.status.pending')).toBeInTheDocument();
  });

  it('publishes a saved draft and refreshes both admin and anonymous snapshots', async () => {
    mocks.fetch.data = data({ draftMatchesPublished: false });
    mocks.publish.mockResolvedValue({ auditId: 'audit-1', revision: 3 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'branding.actions.publish' }));
    const modal = latestModal();
    await act(() => modal.onSubmit(modal.buildPayload('publish reason')));

    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.fetch.mutate).toHaveBeenCalled();
    expect(mocks.platformRefresh).toHaveBeenCalled();
  });

  it('restores history into a dirty draft and surfaces a conflict without overwriting it', async () => {
    mocks.rollback.mockResolvedValue({
      baseRevision: 2,
      draft: draft('Restored'),
      draftToken: 'c'.repeat(64),
      restoredFromRevision: 1,
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'branding.actions.restoreDraft' }));
    const modal = latestModal();
    await act(() => modal.onSubmit(modal.buildPayload('restore reason')));
    expect(screen.getByDisplayValue('Restored')).toBeInTheDocument();
    expect(screen.getByText('branding.status.restoredDraft')).toBeInTheDocument();
    expect(screen.getByText('branding.status.pendingPublish')).toBeInTheDocument();
    expect(screen.getByText('primitives.status.pending')).toBeInTheDocument();

    act(() => useBrandingEditorStore.getState().markConflict());
    expect(screen.getByText('primitives.revision.conflict')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Restored')).toBeDisabled();
  });

  it('renders a clear read-only state and disables editing controls', async () => {
    mocks.admin.permissions = [PLATFORM_PERMISSIONS.BRANDING_READ];
    renderPage();

    expect(await screen.findByText('branding.readOnly')).toBeInTheDocument();
    expect(screen.getByLabelText('branding.fields.name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'branding.actions.save' })).toBeDisabled();
  });

  it('keeps a failed save retryable with the same canonical modal payload after a transient error', async () => {
    mocks.saveDraft
      .mockRejectedValueOnce(new Error('NETWORK_UNAVAILABLE'))
      .mockResolvedValueOnce({ baseRevision: 2, draftToken: 'd'.repeat(64), ok: true });
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Retry Draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'branding.actions.save' }));
    const modal = latestModal();
    const payload = modal.buildPayload('retry reason');

    await act(async () => {
      await expect(modal.onSubmit(payload)).rejects.toThrow();
    });
    // Transient failure returns to dirty — same payload is retryable.
    expect(screen.getByRole('button', { name: 'branding.actions.save' })).not.toBeDisabled();
    await act(() => modal.onSubmit(payload));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(2));
    expect(screen.getByText('branding.status.draftSaved')).toBeInTheDocument();
  });

  it('enters conflict state on CAS save failure and disables mutations until refresh', async () => {
    mocks.saveDraft.mockRejectedValueOnce(new Error('PLATFORM_REVISION_CONFLICT'));
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Conflict Draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'branding.actions.save' }));
    const modal = latestModal();
    const payload = modal.buildPayload('conflict reason');

    await act(async () => {
      await expect(modal.onSubmit(payload)).rejects.toThrow();
    });
    expect(screen.getByText('enterprise.error.PLATFORM_REVISION_CONFLICT')).toBeInTheDocument();
    expect(screen.getByText('primitives.revision.conflict')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'branding.actions.save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'branding.actions.publish' })).toBeDisabled();
    expect(screen.getByLabelText('branding.fields.name')).toBeDisabled();
  });

  it('rehydrates draft inputs after store reset with the same server snapshot', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('Published Brand')).toBeInTheDocument();

    // Simulate StrictMode/unmount cleanup: reset empties the module store while the page
    // still holds an observed snapshot key for the same SWR-cached data.
    act(() => {
      useBrandingEditorStore.getState().reset();
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('Published Brand')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('branding.fields.name')).toHaveValue('Published Brand');
  });

  it('refills inputs when remounting onto a warm SWR cache of the same revision', async () => {
    const first = renderPage();
    expect(await screen.findByDisplayValue('Published Brand')).toBeInTheDocument();
    first.unmount();
    // Cleanup reset() leaves the store empty; remount must hydrate from the same snapshot.
    expect(useBrandingEditorStore.getState().draft).toBeNull();

    renderPage();
    expect(await screen.findByDisplayValue('Published Brand')).toBeInTheDocument();
    expect(screen.getByLabelText('branding.fields.pageTitleTemplate')).toHaveValue(
      '%s · Published Brand',
    );
  });
});
