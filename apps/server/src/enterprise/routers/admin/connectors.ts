import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { router } from '@/libs/trpc/lambda';

import {
  adminConnectorApplyImmediateInputSchema,
  adminConnectorApplyImmediateOutputSchema,
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDeleteDraftInputSchema,
  adminConnectorDeleteDraftOutputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorDraftMutationOutputSchema,
  adminConnectorGetBatchInputSchema,
  adminConnectorGetBatchOutputSchema,
  adminConnectorGetInputSchema,
  adminConnectorGetOutputSchema,
  adminConnectorGetPublishedBatchInputSchema,
  adminConnectorGetPublishedBatchOutputSchema,
  adminConnectorListInputSchema,
  adminConnectorListOutputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorPublishNowInputSchema,
  adminConnectorRevisionOutputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRevokeAllBindingsOutputSchema,
  adminConnectorRollbackInputSchema,
  adminConnectorTestInputSchema,
  adminConnectorTestOutputSchema,
  adminConnectorUpdateDraftInputSchema,
} from '../../contracts/platformConnectors';
import {
  withCompoundPlatformPermission,
  withPlatformPermission,
} from '../../guards/platformPermission';
import {
  applyImmediate,
  archive,
  createDraft,
  deleteDraft,
  discover,
  publish,
  publishNow,
  revokeAllBindings,
  rollback,
  testConnection,
  updateDraft,
} from './connectors.mutations';
import { adminConnectorProcedure } from './connectors.procedure';
import { adminConnectorGovernanceProcedures } from './connectorsGovernance';
import { executeAdminConnectorOperation } from './connectorsSupport';

export const adminConnectorsRouter = router({
  ...adminConnectorGovernanceProcedures,

  /**
   * Create/update draft then publish in one procedure (admin settings UI parity).
   * Requires UPDATE+PUBLISH (or CREATE+PUBLISH for create mode). Rate-limit: 1 unit.
   */
  applyImmediate: adminConnectorProcedure
    .use(
      withCompoundPlatformPermission({
        fixed: [PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH],
        select: (raw) => {
          const mode = (raw as { mode?: string } | null)?.mode;
          return mode === 'create'
            ? PLATFORM_PERMISSIONS.CONNECTOR_CREATE
            : PLATFORM_PERMISSIONS.CONNECTOR_UPDATE;
        },
        selectable: [PLATFORM_PERMISSIONS.CONNECTOR_CREATE, PLATFORM_PERMISSIONS.CONNECTOR_UPDATE],
      }),
    )
    .input(adminConnectorApplyImmediateInputSchema)
    .output(adminConnectorApplyImmediateOutputSchema)
    .mutation(applyImmediate),

  /**
   * Banner "retry publish": re-run publish with soft-fail.
   * Same guard combo as applyImmediate (PUBLISH + reauth + rate-limit).
   */
  publishNow: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH))
    .input(adminConnectorPublishNowInputSchema)
    .output(adminConnectorApplyImmediateOutputSchema)
    .mutation(publishNow),

  archive: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_DELETE))
    .input(adminConnectorArchiveInputSchema)
    .output(adminConnectorRevisionOutputSchema)
    .mutation(archive),

  createDraft: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_CREATE))
    .input(adminConnectorCreateDraftInputSchema)
    .output(adminConnectorDraftMutationOutputSchema)
    .mutation(createDraft),

  deleteDraft: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_DELETE))
    .input(adminConnectorDeleteDraftInputSchema)
    .output(adminConnectorDeleteDraftOutputSchema)
    .mutation(deleteDraft),

  discover: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_TEST))
    .input(adminConnectorDiscoverInputSchema)
    .output(adminConnectorDiscoverOutputSchema)
    .mutation(discover),

  get: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .input(adminConnectorGetInputSchema)
    .output(adminConnectorGetOutputSchema)
    .query(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.get', () =>
        ctx.getAdminConnectorReadService().getDraft(input.id),
      ),
    ),

  getBatch: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .input(adminConnectorGetBatchInputSchema)
    .output(adminConnectorGetBatchOutputSchema)
    .query(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.getBatch', () =>
        ctx.getAdminConnectorReadService().getDraftBatch(input.ids),
      ),
    ),

  getPublishedBatch: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .input(adminConnectorGetPublishedBatchInputSchema)
    .output(adminConnectorGetPublishedBatchOutputSchema)
    .query(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.getPublishedBatch', () =>
        ctx.getAdminConnectorReadService().getPublishedBatch(input.ids),
      ),
    ),

  list: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .input(adminConnectorListInputSchema)
    .output(adminConnectorListOutputSchema)
    .query(async ({ ctx, input }) =>
      executeAdminConnectorOperation('admin.connectors.list', () =>
        ctx.getAdminConnectorReadService().listDrafts(input),
      ),
    ),

  publish: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH))
    .input(adminConnectorPublishInputSchema)
    .output(adminConnectorRevisionOutputSchema)
    .mutation(publish),

  revokeAllBindings: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_DELETE))
    .input(adminConnectorRevokeAllBindingsInputSchema)
    .output(adminConnectorRevokeAllBindingsOutputSchema)
    .mutation(revokeAllBindings),

  rollback: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH))
    .input(adminConnectorRollbackInputSchema)
    .output(adminConnectorRevisionOutputSchema)
    .mutation(rollback),

  test: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_TEST))
    .input(adminConnectorTestInputSchema)
    .output(adminConnectorTestOutputSchema)
    .mutation(testConnection),

  updateDraft: adminConnectorProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE))
    .input(adminConnectorUpdateDraftInputSchema)
    .output(adminConnectorDraftMutationOutputSchema)
    .mutation(updateDraft),
});
