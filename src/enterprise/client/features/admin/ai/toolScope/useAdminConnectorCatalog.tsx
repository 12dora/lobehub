'use client';

import { Alert } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { useClientDataSWR } from '@/libs/swr';
import { useToolStore } from '@/store/tool';
import type { ConnectorWithTools } from '@/store/tool/slices/connector/types';

import { buildBuiltinConnectorRows, buildPlatformConnectorRows } from './adminConnectorRows';
import { listAllAdminConnectors, loadAllConnectorDetails } from './adminToolScopeHelpers';
import { isInitialSwrLoading } from './toolScopeSection';

/**
 * Reads behind the connector view: the platform connector catalog (full list +
 * batched details), the builtin rows synthesized from the in-process manifests,
 * and the org governance document those builtin rows are edited through.
 */
export const useAdminConnectorCatalog = (enabled: boolean) => {
  const { t } = useTranslation('admin');
  const builtinTools = useToolStore((s) => s.builtinTools, isEqual);

  // ── platform connector catalog (full list + batched details) ──────────────
  const connectorsListSWR = useClientDataSWR(
    enabled ? 'admin-tool-scope/connectors/all' : null,
    () => listAllAdminConnectors(),
    { revalidateOnFocus: false },
  );
  // Org governance: builtin tool permission matrix + shared OAuth designation.
  const governanceSWR = useClientDataSWR(
    enabled ? 'admin-tool-scope/connectors/governance' : null,
    () => adminConnectorsService.getGovernance(),
    { revalidateOnFocus: false },
  );
  const mutateGovernance = governanceSWR.mutate;
  const governance = governanceSWR.data;
  const builtinToolPolicies = governance?.doc.builtinToolPolicies;
  const connectorListItems = connectorsListSWR.data ?? [];
  const connectorDetailKey = connectorListItems.map((item) => item.id).join('|');
  const connectorDetailsSWR = useClientDataSWR(
    enabled && connectorListItems.length > 0
      ? ['admin-tool-scope/connectors/details', connectorDetailKey]
      : null,
    async () => loadAllConnectorDetails(connectorListItems.map((item) => item.id)),
    { revalidateOnFocus: false },
  );

  const connectorDetails = useMemo(
    () => connectorDetailsSWR.data?.items ?? [],
    [connectorDetailsSWR.data],
  );
  const connectorDetailFailedCount = connectorDetailsSWR.data?.failedIds.length ?? 0;
  const connectorDetailById = useMemo(
    () => new Map(connectorDetails.map((detail) => [detail.draft.id, detail])),
    [connectorDetails],
  );

  const connectors: ConnectorWithTools[] = useMemo(
    () => [
      ...buildBuiltinConnectorRows(builtinTools, builtinToolPolicies),
      ...buildPlatformConnectorRows(connectorDetails),
    ],
    [builtinToolPolicies, builtinTools, connectorDetails],
  );

  const retry = useCallback(() => {
    void connectorsListSWR.mutate();
    void connectorDetailsSWR.mutate();
    void mutateGovernance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorsListSWR.mutate, connectorDetailsSWR.mutate, mutateGovernance]);
  const retryGovernance = useCallback(() => {
    void mutateGovernance();
  }, [mutateGovernance]);

  const connectorPartialDetailError =
    connectorDetailFailedCount > 0
      ? new Error(
          t('aiToolSettings.connectors.partialLoadFailed', {
            count: connectorDetailFailedCount,
          }),
        )
      : undefined;
  const governanceFailureActiveRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      governanceFailureActiveRef.current = false;
      return;
    }

    if (governanceSWR.error) {
      if (governanceFailureActiveRef.current) return;
      governanceFailureActiveRef.current = true;
      toast.error(t('aiToolSettings.connectors.governanceLoadFailed'));
      return;
    }

    if (governanceSWR.data && !governanceSWR.isValidating) {
      governanceFailureActiveRef.current = false;
    }
  }, [enabled, governanceSWR.data, governanceSWR.error, governanceSWR.isValidating, t]);

  const error =
    connectorsListSWR.error ??
    governanceSWR.error ??
    connectorDetailsSWR.error ??
    connectorPartialDetailError;
  const isLoading = Boolean(
    isInitialSwrLoading(connectorsListSWR) || isInitialSwrLoading(governanceSWR),
  );

  const connectorNotice = useMemo(
    () =>
      governanceSWR.error ? (
        <Alert
          showIcon
          type="error"
          action={
            <Button onClick={retryGovernance}>
              {t('aiToolSettings.connectors.retryGovernance', {
                defaultValue: 'Retry permissions',
              })}
            </Button>
          }
          message={t('aiToolSettings.connectors.governanceLoadFailed', {
            defaultValue: 'Connector permissions could not be loaded. Retry before making changes.',
          })}
        />
      ) : undefined,
    [governanceSWR.error, retryGovernance, t],
  );

  return {
    connectorDetailById,
    connectorNotice,
    connectors,
    error,
    governance,
    isLoading,
    mutateGovernance,
    retry,
  };
};
