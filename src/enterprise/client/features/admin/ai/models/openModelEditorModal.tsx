'use client';

import { Input, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, Select, Switch, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthAuthMethod,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { parseJsonObject, parseNullableJsonObject } from '../controller';
import type { AdminAiModelDraft } from '../types';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;

    @media (width <= 700px) {
      grid-template-columns: 1fr;
    }
  `,
}));

export interface AiModelEditorFields {
  abilities: Record<string, unknown>;
  config: Record<string, unknown> | null;
  contextWindowTokens: number | null;
  description: string | null;
  displayName: string | null;
  enabled: boolean;
  parameters: Record<string, unknown>;
  pricing: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  type: AdminAiModelDraft['type'];
}

export interface AiModelEditorSubmission {
  fields: AiModelEditorFields;
  modelKey: string;
  reason: string;
}

interface ModelEditorState {
  abilitiesText: string;
  configText: string;
  contextWindowTokens: string;
  description: string;
  displayName: string;
  enabled: boolean;
  error: string | null;
  modelKey: string;
  parametersText: string;
  phase: 'idle' | 'submitting';
  pricingText: string;
  reason: string;
  settingsText: string;
  type: AdminAiModelDraft['type'];
}

type ModelEditorAction =
  | { field: keyof Omit<ModelEditorState, 'enabled' | 'type'>; type: 'text'; value: string }
  | { type: 'modelType'; value: AdminAiModelDraft['type'] }
  | { phase: ModelEditorState['phase']; type: 'phase' }
  | { type: 'toggle'; value: boolean };

const toState = (model?: AdminAiModelDraft): ModelEditorState => ({
  abilitiesText: JSON.stringify(model?.abilities ?? {}, null, 2),
  configText: JSON.stringify(model ? model.config : {}, null, 2),
  contextWindowTokens: model?.contextWindowTokens ? String(model.contextWindowTokens) : '',
  description: model?.description ?? '',
  displayName: model?.displayName ?? '',
  enabled: model?.enabled ?? false,
  error: null,
  modelKey: model?.modelKey ?? '',
  parametersText: JSON.stringify(model?.parameters ?? {}, null, 2),
  phase: 'idle',
  pricingText: JSON.stringify(model ? model.pricing : {}, null, 2),
  reason: '',
  settingsText: JSON.stringify(model?.settings ?? {}, null, 2),
  type: model?.type ?? 'chat',
});

const reducer = (state: ModelEditorState, action: ModelEditorAction): ModelEditorState => {
  if (action.type === 'phase') return { ...state, phase: action.phase };
  if (action.type === 'toggle') return { ...state, enabled: action.value, error: null };
  if (action.type === 'modelType') return { ...state, error: null, type: action.value };
  return { ...state, [action.field]: action.value, error: null };
};

export interface ModelEditorContentProps {
  authMethod?: AdminReauthAuthMethod;
  disableAvailability?: boolean;
  model?: AdminAiModelDraft;
  onSubmit: (submission: AiModelEditorSubmission) => Promise<void>;
}

const ModelEditorContent = memo<ModelEditorContentProps>(
  ({ authMethod, disableAvailability, model, onSubmit }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [state, dispatch] = useReducer(reducer, model, toState);
    const locked = state.phase !== 'idle';
    const setError = (error: string) => dispatch({ field: 'error', type: 'text', value: error });

    const handleSubmit = async () => {
      if (!state.modelKey.trim() || !state.type.trim() || !state.reason.trim()) {
        setError(t('aiCatalog.modelEditor.required'));
        return;
      }
      const parsed = [
        parseJsonObject(state.abilitiesText),
        parseNullableJsonObject(state.configText),
        parseJsonObject(state.parametersText),
        parseNullableJsonObject(state.pricingText),
        parseJsonObject(state.settingsText),
      ];
      if (parsed.some((item) => item.error)) {
        setError(t('aiCatalog.modelEditor.jsonInvalid'));
        return;
      }
      const contextWindowTokens = state.contextWindowTokens
        ? Number(state.contextWindowTokens)
        : null;
      if (
        contextWindowTokens !== null &&
        (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0)
      ) {
        setError(t('aiCatalog.modelEditor.contextInvalid'));
        return;
      }

      dispatch({ phase: 'submitting', type: 'phase' });
      try {
        const submission: AiModelEditorSubmission = {
          fields: {
            abilities: parsed[0]!.value!,
            config: parsed[1]!.value,
            contextWindowTokens,
            description: state.description.trim() || null,
            displayName: state.displayName.trim() || null,
            enabled: state.enabled,
            parameters: parsed[2]!.value!,
            pricing: parsed[3]!.value,
            settings: parsed[4]!.value!,
            type: state.type,
          },
          modelKey: state.modelKey.trim(),
          reason: state.reason.trim(),
        };
        await withAdminReauthRetry(() => onSubmit(structuredClone(submission)), {
          authMethod: authMethod ?? null,
        });
        close();
      } catch (cause) {
        const mapped = mapEnterpriseError(cause);
        setError(
          mapped
            ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
            : t('aiCatalog.errors.generic'),
        );
        dispatch({ phase: 'idle', type: 'phase' });
      }
    };

    const jsonFields = [
      ['abilitiesText', 'aiCatalog.modelEditor.abilities'],
      ['configText', 'aiCatalog.modelEditor.config'],
      ['parametersText', 'aiCatalog.modelEditor.parameters'],
      ['pricingText', 'aiCatalog.modelEditor.pricing'],
      ['settingsText', 'aiCatalog.modelEditor.settings'],
    ] as const;

    return (
      <div className={styles.body}>
        <div className={styles.grid}>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.modelEditor.modelKey')}</Text>
            <Input
              disabled={locked || Boolean(model)}
              maxLength={150}
              value={state.modelKey}
              onChange={(event) =>
                dispatch({ field: 'modelKey', type: 'text', value: event.target.value })
              }
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.modelEditor.displayName')}</Text>
            <Input
              disabled={locked}
              maxLength={200}
              value={state.displayName}
              onChange={(event) =>
                dispatch({ field: 'displayName', type: 'text', value: event.target.value })
              }
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.modelEditor.type')}</Text>
            <Select
              disabled={locked}
              value={state.type}
              options={[
                'asr',
                'chat',
                'embedding',
                'image',
                'realtime',
                'text2music',
                'tts',
                'video',
              ].map((value) => ({
                label: t(`aiCatalog.modelTypes.${value}` as never),
                value,
              }))}
              onChange={(value) =>
                dispatch({ type: 'modelType', value: value as AdminAiModelDraft['type'] })
              }
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.modelEditor.context')}</Text>
            <Input
              disabled={locked}
              inputMode="numeric"
              value={state.contextWindowTokens}
              onChange={(event) =>
                dispatch({ field: 'contextWindowTokens', type: 'text', value: event.target.value })
              }
            />
          </div>
        </div>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.modelEditor.description')}</Text>
          <TextArea
            disabled={locked}
            maxLength={4000}
            rows={2}
            value={state.description}
            onChange={(event) =>
              dispatch({ field: 'description', type: 'text', value: event.target.value })
            }
          />
        </div>
        <label>
          <Switch
            checked={state.enabled}
            disabled={locked || disableAvailability}
            onChange={(value) => dispatch({ type: 'toggle', value })}
          />{' '}
          {t('aiCatalog.modelEditor.enabled')}
        </label>
        {disableAvailability ? (
          <Text type="secondary">{t('aiCatalog.modelEditor.availabilityBlocked')}</Text>
        ) : null}
        <div className={styles.grid}>
          {jsonFields.map(([field, label]) => (
            <div className={styles.field} key={field}>
              <Text strong>{t(label)}</Text>
              <TextArea
                disabled={locked}
                rows={5}
                value={state[field]}
                onChange={(event) => dispatch({ field, type: 'text', value: event.target.value })}
              />
            </div>
          ))}
        </div>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.secret.reason')}</Text>
          <TextArea
            disabled={locked}
            maxLength={2000}
            rows={2}
            value={state.reason}
            onChange={(event) =>
              dispatch({ field: 'reason', type: 'text', value: event.target.value })
            }
          />
        </div>
        {state.error ? (
          <Text className={styles.error} role="alert">
            {state.error}
          </Text>
        ) : null}
        <div className={styles.footer}>
          <Button disabled={locked} onClick={close}>
            {t('users.modals.cancel')}
          </Button>
          <Button loading={locked} type="primary" onClick={() => void handleSubmit()}>
            {t(model ? 'aiCatalog.models.actions.save' : 'aiCatalog.models.actions.create')}
          </Button>
        </div>
      </div>
    );
  },
);

ModelEditorContent.displayName = 'AdminAiModelEditorContent';

export const openModelEditorModal = (props: ModelEditorContentProps) =>
  createModal({
    content: <ModelEditorContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t(
      props.model ? 'aiCatalog.models.actions.edit' : 'aiCatalog.models.actions.create',
      { ns: 'admin' },
    ),
    width: 'min(94vw, 820px)',
  });
