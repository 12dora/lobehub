import { MotionProvider } from '@lobehub/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type {
  AdminBrandingGetOutput,
  AdminBrandingPayload,
} from '@/enterprise/client/services/adminBranding';

import BrandingPage from './BrandingPage';
import { useBrandingEditorStore } from './store';

const mocks = vi.hoisted(() => ({
  admin: {
    authMethod: 'better-auth',
    permissions: [] as string[],
    status: 'allowed',
  },
  fetch: {
    data: undefined as AdminBrandingGetOutput | undefined,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(async (): Promise<AdminBrandingGetOutput | undefined> => undefined),
  },
  /** Mounted subscribers of the fake SWR hook, so a snapshot change re-renders the page. */
  listeners: new Set<() => void>(),
  platformRefresh: vi.fn(async () => {}),
  save: vi.fn(),
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
    save: mocks.save,
    uploadAsset: mocks.uploadAsset,
  },
}));

// Stands in for the SWR hook: same shape, plus a subscription so a changed snapshot
// re-renders the page the way a revalidation would.
vi.mock('./useAdminBranding', async () => {
  const { useEffect, useReducer } = await import('react');
  return {
    useFetchAdminBranding: () => {
      const [, bump] = useReducer((count: number) => count + 1, 0);
      useEffect(() => {
        mocks.listeners.add(bump);
        return () => {
          mocks.listeners.delete(bump);
        };
      }, [bump]);
      return mocks.fetch;
    },
  };
});

// Real reauth semantics without a popup: one interactive reauth, then exactly one replay of the
// SAME frozen request (so a reauth retry must never mint a new requestId).
vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => {
  const isAdminReauthRequiredError = (error: unknown) =>
    (error as { code?: string })?.code === 'ADMIN_REAUTH_REQUIRED';
  return {
    AdminReauthBlockedError: class AdminReauthBlockedError extends Error {},
    AdminReauthCancelledError: class AdminReauthCancelledError extends Error {},
    isAdminReauthRequiredError,
    withAdminReauthRetry: async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (!isAdminReauthRequiredError(error)) throw error;
        return await fn();
      }
    },
  };
});

vi.mock('../primitives/readFileBase64', () => ({
  readFileBase64: vi.fn(async () => 'base64payload'),
}));

const payload = (name: string | null = 'Live Brand'): AdminBrandingPayload => ({
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

const data = (override: Partial<AdminBrandingGetOutput> = {}): AdminBrandingGetOutput => ({
  branding: payload(),
  revision: 2,
  storageConfigured: true,
  token: 'a'.repeat(64),
  updatedAt: '2026-08-16T00:00:00.000Z',
  updatedBy: 'admin',
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

/** Publishes the current `mocks.fetch.data` to the mounted page, like a finished revalidation. */
const emitSnapshot = async () => {
  await act(async () => {
    for (const listener of mocks.listeners) listener();
  });
};

/** Save and upload fire directly — no audit-reason prompt stands between click and request. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const saveButton = () => screen.getByRole('button', { name: 'branding.actions.save' });

/** True when the leave guard is armed: it is the `beforeunload` listener that cancels the event. */
const leaveGuardArmed = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

/** A save whose response can be released after other events have been processed. */
const deferredSave = () => {
  let release!: (result: AdminBrandingGetOutput) => void;
  mocks.save.mockImplementation(
    () =>
      new Promise<AdminBrandingGetOutput>((resolve) => {
        release = resolve;
      }),
  );
  return (result: AdminBrandingGetOutput) => release(result);
};

beforeEach(() => {
  vi.clearAllMocks();
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
  it('saves the edited values in one step and confirms they are live', async () => {
    mocks.save.mockResolvedValue(
      data({ branding: payload('Saved Brand'), revision: 3, token: 'b'.repeat(64) }),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Saved Brand' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 2, expectedToken: 'a'.repeat(64) }),
    );
    // No audit reason is collected for an ordinary branding save.
    expect(mocks.save.mock.calls[0][0]).not.toHaveProperty('reason');

    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.platformRefresh).toHaveBeenCalled();
    expect(screen.getByText('branding.status.saved')).toBeInTheDocument();
    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { name: 'Saved Brand' },
      editorState: 'idle',
      revision: 3,
      token: 'b'.repeat(64),
    });
    // The saved values are the new baseline — nothing left to save or to warn about on leave.
    expect(saveButton()).toBeDisabled();
    expect(leaveGuardArmed()).toBe(false);
  });

  it('keeps save disabled until the values actually differ from the live ones', async () => {
    renderPage();
    const name = await screen.findByLabelText('branding.fields.name');
    expect(saveButton()).toBeDisabled();

    fireEvent.change(name, { target: { value: 'Edited' } });
    expect(saveButton()).not.toBeDisabled();

    fireEvent.change(name, { target: { value: 'Live Brand' } });
    expect(saveButton()).toBeDisabled();
  });

  it('blocks saving while required or malformed values are on screen', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: '' },
    });
    expect(screen.getByText('branding.fields.nameRequired')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('branding.fields.name'), {
      target: { value: 'Live Brand 2' },
    });
    fireEvent.change(screen.getByLabelText('branding.fields.primaryColor'), {
      target: { value: '#12' },
    });
    expect(screen.getByText('branding.fields.primaryColorInvalid')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('branding.fields.primaryColor'), {
      target: { value: '#1677FF' },
    });
    expect(screen.queryByText('branding.fields.primaryColorInvalid')).not.toBeInTheDocument();
    expect(saveButton()).not.toBeDisabled();
  });

  it('surfaces a CAS conflict and reloads the live values on demand', async () => {
    mocks.save.mockRejectedValueOnce(new Error('PLATFORM_REVISION_CONFLICT'));
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Conflicting' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(screen.getByText('enterprise.error.PLATFORM_REVISION_CONFLICT')).toBeInTheDocument();
    expect(screen.getByText('branding.conflict.title')).toBeInTheDocument();
    // The local edits survive the conflict; the editor is frozen until an explicit reload.
    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { name: 'Conflicting' },
      editorState: 'conflict',
    });
    expect(screen.getByLabelText('branding.fields.name')).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    const latest = data({ branding: payload('Someone Else'), revision: 3, token: 'c'.repeat(64) });
    mocks.fetch.mutate.mockImplementationOnce(async () => {
      mocks.fetch.data = latest;
      return latest;
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'branding.conflict.reload' }));
    });

    await waitFor(() =>
      expect(screen.queryByText('branding.conflict.title')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('branding.fields.name')).toHaveValue('Someone Else');
    expect(useBrandingEditorStore.getState()).toMatchObject({
      editorState: 'idle',
      revision: 3,
      token: 'c'.repeat(64),
    });
  });

  it('keeps the conflict banner and retry when the reload itself fails', async () => {
    renderPage();
    await screen.findByLabelText('branding.fields.name');
    act(() => useBrandingEditorStore.getState().markConflict());
    mocks.fetch.mutate.mockRejectedValueOnce(new Error('reload boom'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'branding.conflict.reload' }));
    });

    expect(screen.getByText('branding.conflict.reloadFailed')).toBeInTheDocument();
    expect(useBrandingEditorStore.getState().editorState).toBe('conflict');
  });

  it('follows a newer server snapshot while the editor is idle', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('Live Brand')).toBeInTheDocument();

    mocks.fetch.data = data({
      branding: payload('Renamed Elsewhere'),
      revision: 3,
      token: 'd'.repeat(64),
    });
    await emitSnapshot();

    expect(screen.getByDisplayValue('Renamed Elsewhere')).toBeInTheDocument();
    expect(useBrandingEditorStore.getState()).toMatchObject({ editorState: 'idle', revision: 3 });
  });

  it('flags a conflict instead of overwriting unsaved edits when the server moves on', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Mine' },
    });

    mocks.fetch.data = data({
      branding: payload('Theirs'),
      revision: 3,
      token: 'd'.repeat(64),
    });
    await emitSnapshot();

    expect(screen.getByText('branding.conflict.title')).toBeInTheDocument();
    expect(screen.getByLabelText('branding.fields.name')).toHaveValue('Mine');
  });

  it('follows a newer server snapshot after the local edit was undone', async () => {
    renderPage();
    const name = await screen.findByLabelText('branding.fields.name');
    fireEvent.change(name, { target: { value: 'Typo' } });
    fireEvent.change(name, { target: { value: 'Live Brand' } });

    mocks.fetch.data = data({
      branding: payload('Renamed Elsewhere'),
      revision: 3,
      token: 'k'.repeat(64),
    });
    await emitSnapshot();

    // Nothing of the admin's own is on screen, so there is nothing to conflict over.
    expect(screen.queryByText('branding.conflict.title')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Renamed Elsewhere')).toBeInTheDocument();
    expect(useBrandingEditorStore.getState()).toMatchObject({ editorState: 'idle', revision: 3 });
  });

  it('ignores a stale read that is older than the revision already committed', async () => {
    mocks.save.mockResolvedValue(
      data({ branding: payload('Saved Brand'), revision: 3, token: 'b'.repeat(64) }),
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Saved Brand' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    // A cached revalidation still holding revision 2 must not roll the editor back.
    await emitSnapshot();

    expect(screen.getByLabelText('branding.fields.name')).toHaveValue('Saved Brand');
    expect(useBrandingEditorStore.getState()).toMatchObject({ revision: 3 });
  });

  it('ignores a save response that lands after a newer revision was observed', async () => {
    const release = deferredSave();
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Mine' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(useBrandingEditorStore.getState().editorState).toBe('saving');

    // Someone else commits revision 4 while our request for revision 3 is still in flight.
    mocks.fetch.data = data({ branding: payload('Theirs'), revision: 4, token: 'g'.repeat(64) });
    await emitSnapshot();
    expect(screen.getByText('branding.conflict.title')).toBeInTheDocument();

    release(data({ branding: payload('Mine'), revision: 3, token: 'h'.repeat(64) }));
    await flush();

    // The older response neither rolls the editor back nor overwrites the SWR entry.
    expect(useBrandingEditorStore.getState()).toMatchObject({
      editorState: 'conflict',
      observedRevision: 4,
      revision: 2,
    });
    expect(screen.getByLabelText('branding.fields.name')).toHaveValue('Mine');
    expect(mocks.fetch.mutate).not.toHaveBeenCalled();
  });

  it('keeps the leave guard armed while saving and after a conflict', async () => {
    const release = deferredSave();
    renderPage();
    expect(leaveGuardArmed()).toBe(false);
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Unsaved' },
    });
    expect(leaveGuardArmed()).toBe(true);

    await act(async () => {
      fireEvent.click(saveButton());
    });
    // The edits are still only local while the request is in flight.
    expect(leaveGuardArmed()).toBe(true);

    mocks.fetch.data = data({ branding: payload('Theirs'), revision: 4, token: 'i'.repeat(64) });
    await emitSnapshot();
    release(data({ branding: payload('Unsaved'), revision: 3, token: 'j'.repeat(64) }));
    await flush();

    expect(screen.getByText('branding.conflict.title')).toBeInTheDocument();
    expect(leaveGuardArmed()).toBe(true);
  });

  it('renders a clear read-only state and disables editing controls', async () => {
    mocks.admin.permissions = [PLATFORM_PERMISSIONS.BRANDING_READ];
    renderPage();

    expect(await screen.findByText('branding.readOnly')).toBeInTheDocument();
    expect(screen.getByLabelText('branding.fields.name')).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });

  it('keeps a failed save retryable on the same frozen CAS', async () => {
    mocks.save
      .mockRejectedValueOnce(new Error('NETWORK_UNAVAILABLE'))
      .mockResolvedValueOnce(
        data({ branding: payload('Retry Brand'), revision: 3, token: 'e'.repeat(64) }),
      );
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Retry Brand' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });
    // Transient failure returns to dirty — the same CAS is retryable.
    expect(saveButton()).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][0]).toMatchObject({
      expectedRevision: 2,
      expectedToken: 'a'.repeat(64),
    });
    // A user-initiated retry is a NEW request: it must not reuse the failed attempt's
    // idempotency key (the CAS is what keeps a double apply impossible).
    expect(mocks.save.mock.calls[0][0].requestId).not.toBe(mocks.save.mock.calls[1][0].requestId);
    expect(screen.getByText('branding.status.saved')).toBeInTheDocument();
  });

  it('replays the identical frozen request after a reauth challenge', async () => {
    const reauth = Object.assign(new Error('reauth'), { code: 'ADMIN_REAUTH_REQUIRED' });
    mocks.save
      .mockRejectedValueOnce(reauth)
      .mockResolvedValueOnce(
        data({ branding: payload('Reauth Brand'), revision: 3, token: 'k'.repeat(64) }),
      );
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Reauth Brand' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    // One logical save: the reauth retry replays the SAME payload, idempotency key included.
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[0][0]).toEqual(mocks.save.mock.calls[1][0]);
    expect(screen.getByText('branding.status.saved')).toBeInTheDocument();
  });

  it('warns when the runtime snapshot cannot be refreshed after a committed save', async () => {
    mocks.save.mockResolvedValue(
      data({ branding: payload('Saved Brand'), revision: 3, token: 'f'.repeat(64) }),
    );
    mocks.platformRefresh.mockRejectedValueOnce(new Error('runtime refresh failed'));
    renderPage();
    fireEvent.change(await screen.findByLabelText('branding.fields.name'), {
      target: { value: 'Saved Brand' },
    });
    await act(async () => {
      fireEvent.click(saveButton());
    });

    expect(screen.getByText('branding.refresh.postCommitFailed')).toBeInTheDocument();
    // The save itself committed: the editor stays usable on the new revision.
    expect(useBrandingEditorStore.getState()).toMatchObject({ editorState: 'idle', revision: 3 });
    expect(screen.getByLabelText('branding.fields.name')).not.toBeDisabled();

    // A retry that fails again keeps the warning instead of rejecting into the console.
    mocks.platformRefresh.mockRejectedValueOnce(new Error('runtime refresh failed again'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'branding.refresh.retry' }));
    });
    expect(screen.getByText('branding.refresh.postCommitFailed')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'branding.refresh.retry' }));
    });
    expect(screen.queryByText('branding.refresh.postCommitFailed')).not.toBeInTheDocument();
  });

  it('refills inputs when remounting onto a warm SWR cache of the same revision', async () => {
    const first = renderPage();
    expect(await screen.findByDisplayValue('Live Brand')).toBeInTheDocument();
    first.unmount();
    // Cleanup reset() leaves the store empty; remount must hydrate from the same snapshot.
    expect(useBrandingEditorStore.getState().branding).toBeNull();

    renderPage();
    expect(await screen.findByDisplayValue('Live Brand')).toBeInTheDocument();
    expect(screen.getByLabelText('branding.fields.pageTitleTemplate')).toHaveValue(
      '%s · Live Brand',
    );
  });

  it('uploads a desktop icon and patches the values with the returned URL', async () => {
    const { readFileBase64 } = await import('../primitives/readFileBase64');
    vi.mocked(readFileBase64).mockResolvedValueOnce('dGVzdA==');
    mocks.uploadAsset.mockResolvedValueOnce({ url: '/f/desktop-icon' });
    renderPage();
    await screen.findByLabelText('branding.fields.desktopProductName');

    const fileInputs = document.querySelectorAll('input[type="file"]');
    // logo, icon, favicon, ogImage, desktopIcon — the last asset input is desktop.
    expect(fileInputs.length).toBeGreaterThanOrEqual(5);
    const desktopInput = Array.from(fileInputs).at(-1) as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'desktop.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(desktopInput, { target: { files: [file] } });
    });
    await waitFor(() => expect(mocks.uploadAsset).toHaveBeenCalled());
    await flush();

    expect(mocks.uploadAsset).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'desktop.png', kind: 'desktopIcon' }),
    );
    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { desktop: { iconUrl: '/f/desktop-icon' } },
      editorState: 'dirty',
    });
    expect(screen.getByText('branding.status.assetUploaded')).toBeInTheDocument();
  });

  it('merges a finished desktop upload into the values current at that moment', async () => {
    let releaseUpload!: (result: { url: string }) => void;
    mocks.uploadAsset.mockImplementationOnce(
      () =>
        new Promise<{ url: string }>((resolve) => {
          releaseUpload = resolve;
        }),
    );
    renderPage();
    await screen.findByLabelText('branding.fields.desktopProductName');

    const desktopInput = Array.from(document.querySelectorAll('input[type="file"]')).at(
      -1,
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(desktopInput, {
        target: { files: [new File([new Uint8Array([1])], 'desktop.png', { type: 'image/png' })] },
      });
    });
    await waitFor(() => expect(mocks.uploadAsset).toHaveBeenCalled());

    // A newer snapshot lands between starting the upload and its response.
    mocks.fetch.data = data({
      branding: { ...payload(), desktop: { iconUrl: null, productName: 'Renamed Desktop' } },
      revision: 3,
      token: 'l'.repeat(64),
    });
    await emitSnapshot();

    releaseUpload({ url: '/f/desktop-icon' });
    await flush();

    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { desktop: { iconUrl: '/f/desktop-icon', productName: 'Renamed Desktop' } },
      editorState: 'dirty',
      revision: 3,
    });
  });

  it('keeps a failed load retry from escaping as an unhandled rejection', async () => {
    mocks.fetch.data = undefined;
    mocks.fetch.error = new Error('branding load failed');
    mocks.fetch.mutate.mockRejectedValue(new Error('still unreachable'));
    renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'branding.actions.retry' }));
    });

    expect(mocks.fetch.mutate).toHaveBeenCalled();
    expect(screen.getByText('branding.errors.generic')).toBeInTheDocument();
  });

  it('exports the desktop package fields as JSON', async () => {
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:desktop-branding');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      renderPage();
      fireEvent.change(await screen.findByLabelText('branding.fields.desktopProductName'), {
        target: { value: 'Acme Desktop' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'branding.actions.exportDesktop' }));
      });

      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:desktop-branding');
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
      click.mockRestore();
    }
  });

  it('hangs field guidance off a keyboard-reachable help icon instead of a text block', async () => {
    renderPage();
    await screen.findByLabelText('branding.fields.name');

    // The rebuild note used to render twice as text, offsetting the desktop inputs.
    expect(screen.queryAllByText('branding.fields.rebuildRequired')).toHaveLength(0);
    expect(screen.queryAllByText('branding.fields.immediate')).toHaveLength(0);
    const hints = screen.getAllByLabelText('branding.fields.helpFor');
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) expect(hint).toHaveAttribute('tabindex', '0');
  });
});
