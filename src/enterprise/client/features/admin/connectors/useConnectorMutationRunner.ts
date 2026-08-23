'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { runAdminMutation } from '@/enterprise/client/features/admin/primitives/runAdminMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { AdminConnectorGetOutput } from './types';
import { refreshAdminConnectorLists } from './useAdminConnectorCatalog';
import type { useConnectorEditor } from './useConnectorEditor';

interface UseConnectorMutationRunnerParams {
  authMethod: AdminReauthAuthMethod | null;
  editor: ReturnType<typeof useConnectorEditor>;
  mutate: () => Promise<AdminConnectorGetOutput | undefined>;
}

export type ConnectorMutationRunner = ReturnType<typeof useConnectorMutationRunner>;

/**
 * Plumbing shared by every connector mutation: the single busy slot, the inline error surface and
 * the post-commit refresh. Kept apart from the actions themselves so each action stays a thin
 * description of what it calls.
 */
export const useConnectorMutationRunner = ({
  authMethod,
  editor,
  mutate,
}: UseConnectorMutationRunnerParams) => {
  const { t } = useTranslation('admin');
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const errorText = useCallback(
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      return mapped
        ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
        : t('connectorCatalog.errors.generic');
    },
    [t],
  );

  const run = useCallback(
    async (action: string, operation: () => Promise<unknown>, successKey: string) => {
      setBusyAction(action);
      editor.setActionError(null);
      try {
        // Mutation commit is authoritative. Cache revalidation failures must not
        // reclassify a successful server write as a failed action (false conflict
        // on retry / stuck editor revision).
        await operation();
        toast.success(t(successKey as never));
        await Promise.allSettled([mutate(), refreshAdminConnectorLists()]);
      } catch (cause) {
        const mapped = mapEnterpriseError(cause);
        if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') editor.setConflict(true);
        editor.setActionError(errorText(cause));
        throw cause;
      } finally {
        setBusyAction(null);
      }
    },
    [editor, errorText, mutate, t],
  );

  /** Reason-less catalog action: no prompt, optional confirmation, shared error/refresh path. */
  const runSimple = useCallback(
    async (params: {
      action: string;
      operation: () => Promise<unknown>;
      permission: boolean;
      successKey: string;
    }) => {
      if (!params.permission || editor.dirty || editor.conflict || busyAction) return;
      await runAdminMutation({
        authMethod,
        // `run` already mapped the failure into the editor's inline error surface.
        onError: () => undefined,
        run: () => run(params.action, params.operation, params.successKey),
      });
    },
    [authMethod, busyAction, editor.conflict, editor.dirty, run],
  );

  return { busyAction, errorText, run, runSimple, setBusyAction };
};
