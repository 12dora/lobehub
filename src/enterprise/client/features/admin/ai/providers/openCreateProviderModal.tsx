'use client';

import { Input, InputPassword, Text, TextArea } from '@lobehub/ui';
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

import { buildProviderCreatePayload, parseJsonObject } from '../controller';
import type { AdminAiProviderCreateDraftInput } from '../types';

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

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  toggles: css`
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
  `,
}));

interface CreateProviderState {
  configText: string;
  description: string;
  displayName: string;
  enabled: boolean;
  error: string | null;
  fetchOnClient: boolean;
  phase: 'idle' | 'submitting';
  providerKey: string;
  reason: string;
  secretValue: string;
  settingsText: string;
  source: string;
}

type CreateProviderAction =
  | {
      field: keyof Omit<CreateProviderState, 'enabled' | 'fetchOnClient'>;
      type: 'text';
      value: string;
    }
  | { field: 'enabled' | 'fetchOnClient'; type: 'toggle'; value: boolean }
  | { phase: CreateProviderState['phase']; type: 'phase' };

const initialState: CreateProviderState = {
  configText: '{}',
  description: '',
  displayName: '',
  enabled: false,
  error: null,
  fetchOnClient: false,
  phase: 'idle',
  providerKey: '',
  reason: '',
  secretValue: '',
  settingsText: '{}',
  source: 'custom',
};

const reducer = (state: CreateProviderState, action: CreateProviderAction): CreateProviderState => {
  if (action.type === 'phase') return { ...state, phase: action.phase };
  return { ...state, [action.field]: action.value, error: null };
};

export interface CreateProviderContentProps {
  authMethod?: AdminReauthAuthMethod;
  onSubmit: (input: AdminAiProviderCreateDraftInput) => Promise<void>;
}

const CreateProviderContent = memo<CreateProviderContentProps>(({ authMethod, onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [state, dispatch] = useReducer(reducer, initialState);
  const locked = state.phase !== 'idle';

  const setError = (error: string) => dispatch({ field: 'error', type: 'text', value: error });

  const handleSubmit = async () => {
    if (!state.providerKey.trim() || !state.displayName.trim() || !state.reason.trim()) {
      setError(t('aiCatalog.create.required'));
      return;
    }
    const config = parseJsonObject(state.configText);
    const settings = parseJsonObject(state.settingsText);
    if (!config.value || !settings.value) {
      setError(t('aiCatalog.create.jsonInvalid'));
      return;
    }

    const input = buildProviderCreatePayload({
      config: config.value,
      description: state.description,
      displayName: state.displayName,
      enabled: state.enabled,
      fetchOnClient: state.fetchOnClient,
      providerKey: state.providerKey,
      reason: state.reason,
      secretValue: state.secretValue,
      settings: settings.value,
      source: state.source,
    });

    dispatch({ phase: 'submitting', type: 'phase' });
    try {
      await withAdminReauthRetry(() => onSubmit(structuredClone(input)), {
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

  return (
    <div className={styles.body}>
      <Text type="secondary">{t('aiCatalog.create.desc')}</Text>
      <div className={styles.grid}>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.editor.providerKey')}</Text>
          <Input
            disabled={locked}
            maxLength={64}
            value={state.providerKey}
            onChange={(event) =>
              dispatch({ field: 'providerKey', type: 'text', value: event.target.value })
            }
          />
        </div>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.editor.displayName')}</Text>
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
          <Text strong>{t('aiCatalog.providers.columns.source')}</Text>
          <Select
            disabled={locked}
            value={state.source}
            options={(['builtin', 'custom'] as const).map((value) => ({
              label: t(`aiCatalog.providerSources.${value}` as never),
              value,
            }))}
            onChange={(value) => dispatch({ field: 'source', type: 'text', value })}
          />
        </div>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.secret.newValue')}</Text>
          <InputPassword
            autoComplete="new-password"
            disabled={locked}
            maxLength={32_768}
            value={state.secretValue}
            onChange={(event) =>
              dispatch({ field: 'secretValue', type: 'text', value: event.target.value })
            }
          />
        </div>
      </div>
      <div className={styles.toggles}>
        <label>
          <Switch
            checked={state.enabled}
            disabled={locked}
            onChange={(value) => dispatch({ field: 'enabled', type: 'toggle', value })}
          />{' '}
          {t('aiCatalog.editor.enabled')}
        </label>
        <label>
          <Switch
            checked={state.fetchOnClient}
            disabled={locked}
            onChange={(value) => dispatch({ field: 'fetchOnClient', type: 'toggle', value })}
          />{' '}
          {t('aiCatalog.editor.fetchOnClient')}
        </label>
      </div>
      <div className={styles.field}>
        <Text strong>{t('aiCatalog.editor.description')}</Text>
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
      <div className={styles.grid}>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.editor.config')}</Text>
          <TextArea
            disabled={locked}
            rows={5}
            value={state.configText}
            onChange={(event) =>
              dispatch({ field: 'configText', type: 'text', value: event.target.value })
            }
          />
        </div>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.editor.settings')}</Text>
          <TextArea
            disabled={locked}
            rows={5}
            value={state.settingsText}
            onChange={(event) =>
              dispatch({ field: 'settingsText', type: 'text', value: event.target.value })
            }
          />
        </div>
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
          {t('aiCatalog.providers.actions.create')}
        </Button>
      </div>
    </div>
  );
});

CreateProviderContent.displayName = 'AdminAiCreateProviderContent';

export const openCreateProviderModal = (props: CreateProviderContentProps) =>
  createModal({
    content: <CreateProviderContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('aiCatalog.providers.actions.create', { ns: 'admin' }),
    width: 'min(94vw, 760px)',
  });
