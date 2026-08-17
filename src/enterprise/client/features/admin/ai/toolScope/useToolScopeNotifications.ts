import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isAdminAiInfraErrorToasted } from '@/enterprise/client/services/adminAiInfraAdapter/errors';

export const useToolScopeNotifications = () => {
  const { t } = useTranslation('admin');

  /**
   * Toast adapter-boundary failures unless the service wrapper already did.
   * Covers pre-read hops (`get` / `getGovernance`) and unwrapped local guards.
   */
  const notifyUnlessAlreadyToasted = useCallback((notify: () => void, err: unknown) => {
    if (!isAdminAiInfraErrorToasted(err)) notify();
  }, []);

  const notifySkillFailure = useCallback(() => {
    toast.error(t('skillCatalog.errors.generic'));
  }, [t]);

  const notifyConnectorFailure = useCallback(() => {
    toast.error(t('connectorCatalog.errors.generic'));
  }, [t]);

  // Coalesce rapid tool-permission success toasts (one per ~1.2s window).
  const lastConnectorSavedToastAtRef = useRef(0);
  const notifyConnectorSaved = useCallback(() => {
    const now = Date.now();
    if (now - lastConnectorSavedToastAtRef.current < 1200) return;
    lastConnectorSavedToastAtRef.current = now;
    toast.success(t('connectorCatalog.toast.saved'));
  }, [t]);

  const localizePublishError = useCallback(
    (publishError: string) => {
      // Server may join multiple validation codes with commas; localize the primary code.
      const primary = publishError.split(',')[0]?.trim() || publishError;
      if (primary === 'version_required') {
        return t('skillCatalog.publishError.version_required');
      }
      if (primary === 'publish_failed' || primary === 'validation_failed') {
        return t(`skillCatalog.publishError.${primary}` as never);
      }
      return t(`skillCatalog.validation.issue.${primary}` as never, {
        defaultValue: t('skillCatalog.publishError.validation_failed'),
        path: t('skillCatalog.validation.path.root'),
      });
    },
    [t],
  );

  const notifyApplyOutcome = useCallback(
    (result: { publishError?: string | null; published: boolean }) => {
      if (result.published) {
        toast.success(
          t('aiSkillSettings.orgDefault.saved', { defaultValue: 'Organization default updated' }),
        );
      } else {
        toast.warning(
          result.publishError
            ? localizePublishError(result.publishError)
            : t('aiSkillSettings.actions.draftSaved', {
                defaultValue: 'Saved as draft — publish is pending',
              }),
        );
      }
    },
    [localizePublishError, t],
  );

  return useMemo(
    () => ({
      localizePublishError,
      notifyApplyOutcome,
      notifyConnectorFailure,
      notifyConnectorSaved,
      notifySkillFailure,
      notifyUnlessAlreadyToasted,
    }),
    [
      localizePublishError,
      notifyApplyOutcome,
      notifyConnectorFailure,
      notifyConnectorSaved,
      notifySkillFailure,
      notifyUnlessAlreadyToasted,
    ],
  );
};
