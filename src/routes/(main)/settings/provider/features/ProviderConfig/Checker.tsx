'use client';

import { CheckCircleFilled } from '@ant-design/icons';
import { type ChatMessageError } from '@lobechat/types';
import { TraceNameMap } from '@lobechat/types';
import { ModelIcon } from '@lobehub/icons';
import { Alert, Button, Flexbox, Highlighter, Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { Loader2Icon } from 'lucide-react';
import { type ReactNode } from 'react';
import { memo, use, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { useProviderName } from '@/hooks/useProviderName';
import { lambdaClient } from '@/libs/trpc/client';
import { chatService } from '@/services/chat';
import { aiProviderSelectors, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';
import { getRuntimeErrorMessage } from '@/utils/locale/runtimeErrorMessage';

import { ProviderSettingsContext } from '../ModelList/ProviderSettingsContext';

const styles = createStaticStyles(({ css }) => ({
  popup: css`
    width: 380px;
  `,
}));
/**
 * `title` overrides the error-type headline. The platform probe answers with its own sanitized
 * reason ("authentication rejected", "check model is not enabled", …); rendering the generic
 * `ConnectionCheckFailed` copy over it told operators to inspect a `/v1` proxy suffix that had
 * nothing to do with the failure, and buried the real reason in the expandable JSON.
 */
const Error = memo<{ error: ChatMessageError; title?: string }>(({ error, title }) => {
  const { t } = useTranslation(['error', 'modelRuntime']);
  const providerName = useProviderName(error.body?.provider);

  return (
    <Flexbox gap={8} style={{ maxWidth: 600, width: '100%' }}>
      <Alert
        showIcon
        title={title ?? getRuntimeErrorMessage(t, error.type, { provider: providerName })}
        type={'error'}
        extra={
          <Flexbox paddingBlock={8} paddingInline={16}>
            <Highlighter
              actionIconSize={'small'}
              language={'json'}
              variant={'borderless'}
              wrap={true}
            >
              {JSON.stringify(error.body || error, null, 2)}
            </Highlighter>
          </Flexbox>
        }
      />
    </Flexbox>
  );
});

export type CheckErrorRender = (props: {
  defaultError: ReactNode;
  error?: ChatMessageError;
  setError: (error?: ChatMessageError) => void;
}) => ReactNode;

interface ConnectionCheckerProps {
  checkErrorRender?: CheckErrorRender;
  model: string;
  onAfterCheck: () => Promise<void>;
  onBeforeCheck: () => Promise<void>;
  provider: string;
}

/**
 * Stable reasons the platform probe reports when it refuses to run at all. They are actionable
 * by the operator, so they get their own copy instead of the server's terse sanitized string.
 * Matched loosely (case/punctuation-insensitive) so the wording can evolve server-side without
 * silently falling back to the generic message.
 */
const CHECK_MODEL_REASON_KEYS: Record<string, string> = {
  check_model_not_configured: 'llm.checker.reason.checkModelNotConfigured',
  check_model_not_enabled: 'llm.checker.reason.checkModelNotEnabled',
};

const normalizeReason = (message: string): string =>
  message
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');

const Checker = memo<ConnectionCheckerProps>(
  ({ model, provider, checkErrorRender: CheckErrorRender, onBeforeCheck, onAfterCheck }) => {
    const { t } = useTranslation('setting');
    const { allowed: canManageProvider } = usePermission('manage_provider_key');
    // Admin parity page sets hideFetchOnClient; use platform catalog test API there.
    const { hideFetchOnClient: isAdminPlatformCatalog } = use(ProviderSettingsContext);

    const [isProviderConfigUpdating, updateAiProviderConfig] = useAiInfraStore((s) => [
      aiProviderSelectors.isProviderConfigUpdating(provider)(s),
      s.updateAiProviderConfig,
    ]);
    const aiProviderModelList = useAiInfraStore((s) => s.aiProviderModelList);

    // Sort models for better UX:
    // 1. checkModel first (provider's recommended test model)
    // 2. enabled models (user is actively using)
    // 3. by releasedAt descending (newer models first)
    // 4. models without releasedAt last
    const sortedModels = useMemo(() => {
      const chatModels = aiProviderModelList.filter((m) => m.type === 'chat');

      const sorted = [...chatModels].sort((a, b) => {
        // checkModel always first
        if (a.id === model) return -1;
        if (b.id === model) return 1;

        // enabled models come before disabled
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;

        // sort by releasedAt descending, models without releasedAt go last
        if (a.releasedAt && b.releasedAt) {
          return new Date(b.releasedAt).getTime() - new Date(a.releasedAt).getTime();
        }
        if (a.releasedAt && !b.releasedAt) return -1;
        if (!a.releasedAt && b.releasedAt) return 1;

        return 0;
      });

      return sorted.map((m) => m.id);
    }, [aiProviderModelList, model]);

    const [loading, setLoading] = useState(false);
    const [pass, setPass] = useState(false);
    const [checkModel, setCheckModel] = useState(model);

    const [error, setError] = useState<ChatMessageError | undefined>();
    const [errorTitle, setErrorTitle] = useState<string | undefined>();

    /**
     * Models the runtime will actually accept for this provider. For a platform-managed provider
     * this is the admin-published set; for BYOK it is the user's enabled set.
     */
    const runtimeEnabledChatModels = useAiInfraStore(
      (s) =>
        (s.enabledAiModels ?? [])
          .filter((item) => item.providerId === provider && item.type === 'chat')
          .map((item) => item.id),
      // Derived array: compare by value, or every store tick re-renders and re-runs the effect.
      isEqual,
    );

    // Sync checkModel state when model prop changes.
    //
    // The card's default check model (e.g. chatgpt's `gpt-5.5`) is NOT necessarily one the
    // runtime serves: on a platform-managed provider only admin-published models pass the
    // allowlist, so checking the card default returned PLATFORM_AI_MODEL_NOT_PUBLISHED. Fall
    // back to a model that is actually enabled. The admin surface keeps the persisted value —
    // there the dropdown IS the stored `checkModel`, and silently showing something else would
    // misrepresent the saved config.
    useEffect(() => {
      if (isAdminPlatformCatalog || runtimeEnabledChatModels.length === 0) {
        setCheckModel(model);
        return;
      }
      setCheckModel(
        runtimeEnabledChatModels.includes(model) ? model : runtimeEnabledChatModels[0]!,
      );
    }, [isAdminPlatformCatalog, model, runtimeEnabledChatModels]);

    const checkConnection = async () => {
      // Clear previous check results immediately
      setPass(false);
      setError(undefined);
      setErrorTitle(undefined);

      if (isAdminPlatformCatalog) {
        // Platform catalog: admin.aiProviders.test updates draft connectionTest for publish gates.
        setLoading(true);
        try {
          // Resolve platform UUID via list/get through admin API (provider key is public id).
          let cursor: string | undefined;
          let platformId: string | undefined;
          for (let page = 0; page < 20 && !platformId; page += 1) {
            const pageResult = await lambdaClient.admin.aiProviders.list.query({
              cursor,
              limit: 100,
            });
            const hit = pageResult.items.find(
              (item) => item.providerKey === provider || item.id === provider,
            );
            if (hit) platformId = hit.id;
            if (!pageResult.nextCursor) break;
            cursor = pageResult.nextCursor;
          }
          if (!platformId) {
            // `Error` is shadowed by the local alert component in this file.
            throw new globalThis.Error(`Platform provider not found: ${provider}`);
          }
          const result = await lambdaClient.admin.aiProviders.test.mutate({
            id: platformId,
            // Probe what the operator picked, not only the persisted `checkModel` — selecting a
            // model in the dropdown used to have no effect on the check that ran.
            model: checkModel,
            reason: 'admin provider settings connectivity check',
          });
          if (result.status === 'success') {
            setPass(true);
            setError(undefined);
            setErrorTitle(undefined);
          } else {
            setPass(false);
            // Prefer the server's own reason. Known actionable refusals get dedicated copy;
            // anything else shows the sanitized message verbatim. `ConnectionCheckFailed` (the
            // "empty response / proxy must not end in /v1" guidance) is now reserved for the
            // transport-level catch below, where it is actually the right advice.
            const reasonKey = result.sanitizedMessage
              ? CHECK_MODEL_REASON_KEYS[normalizeReason(result.sanitizedMessage)]
              : undefined;
            setErrorTitle(
              reasonKey
                ? t(reasonKey as never)
                : result.sanitizedMessage || getRuntimeErrorMessage(t, 'ConnectionCheckFailed'),
            );
            setError({
              body: {
                errorCategory: result.errorCategory,
                latencyMs: result.latencyMs,
                model: checkModel,
                sanitizedMessage: result.sanitizedMessage,
              },
              message:
                result.sanitizedMessage || getRuntimeErrorMessage(t, 'ConnectionCheckFailed'),
              type: 'ConnectionCheckFailed',
            });
          }
        } catch (cause) {
          setPass(false);
          // Genuine transport failure (network, permission, provider row missing): the generic
          // connectivity guidance is the correct copy here.
          setErrorTitle(undefined);
          setError({
            body: cause,
            message: getRuntimeErrorMessage(t, 'ConnectionCheckFailed'),
            type: 'ConnectionCheckFailed',
          });
        } finally {
          setLoading(false);
        }
        return;
      }

      let isError = false;

      await chatService.fetchPresetTaskResult({
        onError: (_, rawError) => {
          setError(rawError);
          setPass(false);
          isError = true;
        },

        onFinish: async (value) => {
          if (!isError && value) {
            setError(undefined);
            setErrorTitle(undefined);
            setPass(true);
          } else {
            setPass(false);
            setError({
              body: value,
              message: getRuntimeErrorMessage(t, 'ConnectionCheckFailed'),
              type: 'ConnectionCheckFailed',
            });
          }
        },
        onLoadingChange: (loading) => {
          setLoading(loading);
        },
        params: {
          messages: [
            {
              content: 'hello',
              role: 'user',
            },
          ],
          model: checkModel,
          provider,
        },
        trace: {
          sessionId: `connection:${provider}`,
          topicId: checkModel,
          traceName: TraceNameMap.ConnectivityChecker,
        },
      });
    };

    const defaultError = error ? (
      <Error error={error as ChatMessageError} title={errorTitle} />
    ) : null;

    const errorContent = CheckErrorRender ? (
      <CheckErrorRender defaultError={defaultError} error={error} setError={setError} />
    ) : (
      defaultError
    );

    return (
      <Flexbox gap={8}>
        <Flexbox horizontal gap={8}>
          <Select
            virtual
            disabled={!canManageProvider}
            listItemHeight={36}
            options={sortedModels.map((id) => ({ label: id, value: id }))}
            popupClassName={cx(styles.popup)}
            suffixIcon={isProviderConfigUpdating && <Icon spin icon={Loader2Icon} />}
            value={checkModel}
            optionRender={({ value }) => {
              return (
                <Flexbox horizontal align={'center'} gap={6}>
                  <ModelIcon model={value as string} size={20} />
                  {value}
                </Flexbox>
              );
            }}
            style={{
              flex: 1,
              overflow: 'hidden',
            }}
            onSelect={async (value) => {
              if (!canManageProvider) return;

              // Update local state
              setCheckModel(value);
              setPass(false);
              setError(undefined);
              setErrorTitle(undefined);

              // Persist the selected model to provider config
              // This allows the model to be retained after page refresh
              await updateAiProviderConfig(provider, { checkModel: value });
            }}
          />
          <Button
            disabled={!canManageProvider || isProviderConfigUpdating}
            loading={loading}
            icon={
              pass ? (
                <CheckCircleFilled
                  style={{
                    color: cssVar.colorSuccess,
                  }}
                />
              ) : undefined
            }
            style={
              pass
                ? {
                    borderColor: cssVar.colorSuccess,
                    color: cssVar.colorSuccess,
                  }
                : undefined
            }
            onClick={async () => {
              if (!canManageProvider) return;

              await onBeforeCheck();
              try {
                await checkConnection();
              } finally {
                await onAfterCheck();
              }
            }}
          >
            {pass ? t('llm.checker.pass') : t('llm.checker.button')}
          </Button>
        </Flexbox>
        {error && errorContent}
      </Flexbox>
    );
  },
);

export default Checker;
