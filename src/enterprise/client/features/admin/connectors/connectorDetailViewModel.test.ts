import { describe, expect, it } from 'vitest';

import {
  type ConnectorDetailViewModelInput,
  resolveConnectorDetailViewModel,
  resolveConnectorSecretConfigured,
} from './connectorDetailViewModel';
import type { AdminConnectorPermissions, EditableAdminConnectorDraft } from './controller';
import type { AdminConnectorGetOutput } from './types';

const draft = (
  overrides: Partial<EditableAdminConnectorDraft> = {},
): EditableAdminConnectorDraft => ({
  credentialMode: 'none',
  description: '',
  displayName: 'Calendar',
  enabled: true,
  endpoint: 'https://calendar.example.com/mcp',
  oauthAuthorizationEndpoint: '',
  oauthClientId: '',
  oauthIssuer: '',
  oauthScopes: '',
  oauthTokenEndpoint: '',
  sort: 0,
  tools: [],
  ...overrides,
});

const snapshot = (overrides: Partial<AdminConnectorGetOutput> = {}): AdminConnectorGetOutput =>
  ({
    baseRevision: 3,
    draft: {
      connectionTest: null,
      credentialMode: 'none',
      description: null,
      displayName: 'Calendar',
      enabled: true,
      endpoint: 'https://calendar.example.com/mcp',
      id: 'connector-1',
      key: 'calendar',
      oauthClientSecret: { configured: false, fingerprint: null, updatedAt: null },
      oauthConfig: null,
      revision: 3,
      sharedSecret: { configured: false, fingerprint: null, updatedAt: null },
      sort: 0,
      status: 'draft',
      tools: [],
      transport: 'http',
    },
    draftToken: 'c'.repeat(64),
    published: null,
    ...overrides,
  }) as AdminConnectorGetOutput;

/** Only `publishedRevision` / truthiness is read by the view model. */
const published = (publishedRevision = 2) =>
  ({ publishedRevision }) as AdminConnectorGetOutput['published'];

const permissions = (
  overrides: Partial<AdminConnectorPermissions> = {},
): AdminConnectorPermissions => ({
  canArchive: true,
  canCreate: true,
  canDelete: true,
  canDiscover: true,
  canPublish: true,
  canRead: true,
  canReadAudit: true,
  canRevokeBindings: true,
  canTest: true,
  canUpdate: true,
  ...overrides,
});

const input = (
  overrides: Partial<ConnectorDetailViewModelInput> = {},
): ConnectorDetailViewModelInput => ({
  busyAction: null,
  conflict: false,
  draft: draft(),
  permissions: permissions(),
  primaryAction: 'test',
  saveState: 'idle',
  snapshot: snapshot(),
  validation: { errors: {}, valid: true },
  ...overrides,
});

describe('resolveConnectorSecretConfigured', () => {
  it('reads the shared secret state only while the draft still selects that mode', () => {
    const snap = snapshot({
      draft: {
        ...snapshot().draft,
        credentialMode: 'shared_service_account',
        sharedSecret: { configured: true, fingerprint: 'a'.repeat(64), updatedAt: null },
      },
    } as Partial<AdminConnectorGetOutput>);

    expect(
      resolveConnectorSecretConfigured(draft({ credentialMode: 'shared_service_account' }), snap),
    ).toBe(true);
    // Mode switched in the draft: the stored secret belongs to the old mode.
    expect(resolveConnectorSecretConfigured(draft({ credentialMode: 'none' }), snap)).toBe(false);
  });

  it('reads the oauth client secret state for per_user_oauth', () => {
    const snap = snapshot({
      draft: {
        ...snapshot().draft,
        credentialMode: 'per_user_oauth',
        oauthClientSecret: { configured: true, fingerprint: 'b'.repeat(64), updatedAt: null },
      },
    } as Partial<AdminConnectorGetOutput>);

    expect(
      resolveConnectorSecretConfigured(draft({ credentialMode: 'per_user_oauth' }), snap),
    ).toBe(true);
  });

  it('reports no secret for the credential-less mode', () => {
    expect(resolveConnectorSecretConfigured(draft(), snapshot())).toBe(false);
  });
});

describe('resolveConnectorDetailViewModel', () => {
  describe('header actions', () => {
    it('shows publish-scoped actions only once a published revision exists', () => {
      const unpublished = resolveConnectorDetailViewModel(input()).headerActions;
      expect(unpublished).toMatchObject({
        showArchive: false,
        showDeleteDraft: true,
        showDiscover: true,
        showRevokeBindings: false,
        showRollback: false,
      });

      const live = resolveConnectorDetailViewModel(
        input({ snapshot: snapshot({ published: published() }) }),
      ).headerActions;
      expect(live).toMatchObject({
        showArchive: true,
        showDeleteDraft: false,
        showRevokeBindings: true,
        showRollback: true,
      });
    });

    it('hides each action behind its own permission', () => {
      const model = resolveConnectorDetailViewModel(
        input({
          permissions: permissions({
            canArchive: false,
            canDelete: false,
            canDiscover: false,
            canPublish: false,
            canRevokeBindings: false,
          }),
          snapshot: snapshot({ published: published() }),
        }),
      ).headerActions;

      expect(model).toMatchObject({
        showArchive: false,
        showDeleteDraft: false,
        showDiscover: false,
        showRevokeBindings: false,
        showRollback: false,
      });
    });

    it.each([
      ['conflict', { conflict: true }],
      ['unsaved edits', { saveState: 'dirty' as const }],
      ['a failed save', { saveState: 'failed' as const }],
      ['a save in flight', { saveState: 'saving' as const }],
      ['another action in flight', { busyAction: 'discover' }],
    ])('disables every header action on %s', (_label, overrides) => {
      expect(resolveConnectorDetailViewModel(input(overrides)).headerActions.disabled).toBe(true);
    });

    it('enables header actions on a settled draft and flags the rollback spinner', () => {
      expect(resolveConnectorDetailViewModel(input()).headerActions).toMatchObject({
        disabled: false,
        rollbackLoading: false,
      });
      expect(
        resolveConnectorDetailViewModel(input({ busyAction: 'rollback' })).headerActions
          .rollbackLoading,
      ).toBe(true);
    });
  });

  describe('editor lock', () => {
    it.each([
      ['no update permission', { permissions: permissions({ canUpdate: false }) }],
      ['conflict', { conflict: true }],
      ['a busy action', { busyAction: 'save' }],
    ])('locks the editors on %s', (_label, overrides) => {
      expect(resolveConnectorDetailViewModel(input(overrides)).editorDisabled).toBe(true);
    });

    it('keeps the editors open while merely dirty', () => {
      expect(resolveConnectorDetailViewModel(input({ saveState: 'dirty' })).editorDisabled).toBe(
        false,
      );
    });

    it('reports read-only from the update permission', () => {
      expect(resolveConnectorDetailViewModel(input()).readOnly).toBe(false);
      expect(
        resolveConnectorDetailViewModel(input({ permissions: permissions({ canUpdate: false }) }))
          .readOnly,
      ).toBe(true);
    });
  });

  describe('footer', () => {
    it('renders the test button whenever the operator may test, primary when it is the next step', () => {
      expect(resolveConnectorDetailViewModel(input()).footer.test).toEqual({
        disabled: false,
        loading: false,
        primary: true,
      });
      expect(
        resolveConnectorDetailViewModel(input({ primaryAction: 'publish' })).footer.test?.primary,
      ).toBe(false);
      expect(
        resolveConnectorDetailViewModel(input({ permissions: permissions({ canTest: false }) }))
          .footer.test,
      ).toBeNull();
    });

    it('blocks the test button on an unsettled or invalid draft', () => {
      expect(
        resolveConnectorDetailViewModel(input({ saveState: 'dirty' })).footer.test?.disabled,
      ).toBe(true);
      expect(
        resolveConnectorDetailViewModel(input({ validation: { errors: {}, valid: false } })).footer
          .test?.disabled,
      ).toBe(true);
    });

    it('renders save for both save and retry, with the retry label', () => {
      expect(
        resolveConnectorDetailViewModel(input({ primaryAction: 'save', saveState: 'dirty' })).footer
          .save,
      ).toEqual({
        action: 'save',
        disabled: false,
        labelKey: 'connectorCatalog.actions.save',
        loading: false,
      });
      expect(
        resolveConnectorDetailViewModel(input({ primaryAction: 'retry', saveState: 'failed' }))
          .footer.save,
      ).toEqual({
        action: 'retry',
        disabled: false,
        labelKey: 'connectorCatalog.actions.retrySave',
        loading: false,
      });
      expect(resolveConnectorDetailViewModel(input()).footer.save).toBeNull();
    });

    it('blocks save on conflict, busy or invalid — but not on unsaved edits', () => {
      const saveInput = { primaryAction: 'save' as const, saveState: 'dirty' as const };
      expect(resolveConnectorDetailViewModel(input(saveInput)).footer.save?.disabled).toBe(false);
      expect(
        resolveConnectorDetailViewModel(input({ ...saveInput, conflict: true })).footer.save
          ?.disabled,
      ).toBe(true);
      expect(
        resolveConnectorDetailViewModel(input({ ...saveInput, busyAction: 'save' })).footer.save,
      ).toEqual(expect.objectContaining({ disabled: true, loading: true }));
      expect(
        resolveConnectorDetailViewModel(
          input({ ...saveInput, validation: { errors: {}, valid: false } }),
        ).footer.save?.disabled,
      ).toBe(true);
    });

    it('renders publish only as the resolved primary action and ignores draft validation', () => {
      expect(
        resolveConnectorDetailViewModel(
          input({ primaryAction: 'publish', validation: { errors: {}, valid: false } }),
        ).footer.publish,
      ).toEqual({ disabled: false, loading: false });
      expect(
        resolveConnectorDetailViewModel(input({ primaryAction: 'publish', conflict: true })).footer
          .publish?.disabled,
      ).toBe(true);
      expect(resolveConnectorDetailViewModel(input()).footer.publish).toBeNull();
    });

    it('tones the save-state label as danger only after a failed save', () => {
      expect(resolveConnectorDetailViewModel(input()).footer.saveStateTone).toBe('secondary');
      expect(
        resolveConnectorDetailViewModel(input({ saveState: 'failed' })).footer.saveStateTone,
      ).toBe('danger');
    });
  });
});
