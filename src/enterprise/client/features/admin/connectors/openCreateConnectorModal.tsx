'use client';

import { Input, InputPassword, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, Select, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthAuthMethod,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { AdminConnectorCreateDraftInput, ConnectorCredentialMode } from './types';

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
}));

export interface CreateConnectorState {
  authorizationEndpoint: string;
  clientId: string;
  credentialMode: ConnectorCredentialMode;
  description: string;
  displayName: string;
  endpoint: string;
  error: string | null;
  issuer: string;
  key: string;
  locked: boolean;
  reason: string;
  scopes: string;
  secret: string;
  tokenEndpoint: string;
}

export type CreateConnectorAction =
  | {
      field: keyof Omit<CreateConnectorState, 'credentialMode' | 'locked'>;
      type: 'text';
      value: string;
    }
  | { type: 'mode'; value: ConnectorCredentialMode }
  | { type: 'locked'; value: boolean };

export const initialCreateConnectorState: CreateConnectorState = {
  authorizationEndpoint: '',
  clientId: '',
  credentialMode: 'none',
  description: '',
  displayName: '',
  endpoint: '',
  error: null,
  issuer: '',
  key: '',
  locked: false,
  reason: '',
  scopes: '',
  secret: '',
  tokenEndpoint: '',
};

export const reduceCreateConnectorState = (
  state: CreateConnectorState,
  action: CreateConnectorAction,
): CreateConnectorState => {
  if (action.type === 'locked') return { ...state, locked: action.value };
  if (action.type === 'mode') {
    return { ...state, credentialMode: action.value, error: null, secret: '' };
  }
  return { ...state, [action.field]: action.value, error: null };
};

export const buildCreateConnectorInput = (
  state: CreateConnectorState,
): AdminConnectorCreateDraftInput | null => {
  const base = {
    credentialMode: state.credentialMode,
    description: state.description.trim() || null,
    displayName: state.displayName.trim(),
    endpoint: state.endpoint.trim(),
    key: state.key.trim(),
    reason: state.reason.trim(),
    transport: 'http' as const,
  };
  if (!base.key || !base.displayName || !base.endpoint || !base.reason) return null;
  if (state.credentialMode === 'none') return { ...base, credentialMode: 'none' };
  if (state.credentialMode === 'shared_service_account') {
    return {
      ...base,
      credentialMode: 'shared_service_account',
      ...(state.secret
        ? { sharedSecret: { operation: 'replace' as const, value: { bearerToken: state.secret } } }
        : {}),
    };
  }
  if (
    !state.issuer.trim() ||
    !state.authorizationEndpoint.trim() ||
    !state.tokenEndpoint.trim() ||
    !state.clientId.trim() ||
    !state.scopes.trim()
  ) {
    return null;
  }
  return {
    ...base,
    credentialMode: 'per_user_oauth',
    ...(state.secret
      ? { oauthClientSecret: { operation: 'replace' as const, value: state.secret } }
      : {}),
    oauthConfig: {
      authorizationEndpoint: state.authorizationEndpoint.trim(),
      clientId: state.clientId.trim(),
      issuer: state.issuer.trim(),
      scopes: state.scopes.split(/\s+/).filter(Boolean),
      tokenEndpoint: state.tokenEndpoint.trim(),
    },
  };
};

interface CreateConnectorContentProps {
  authMethod?: AdminReauthAuthMethod;
  onSubmit: (input: AdminConnectorCreateDraftInput) => Promise<void>;
}

const CreateConnectorContent = memo<CreateConnectorContentProps>(({ authMethod, onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [state, dispatch] = useReducer(reduceCreateConnectorState, initialCreateConnectorState);
  const text =
    (field: keyof Omit<CreateConnectorState, 'credentialMode' | 'locked'>) => (value: string) =>
      dispatch({ field, type: 'text', value });

  const submit = async () => {
    const input = buildCreateConnectorInput(state);
    if (!input) {
      text('error')(t('connectorCatalog.create.required'));
      return;
    }
    dispatch({ type: 'locked', value: true });
    try {
      await withAdminReauthRetry(() => onSubmit(structuredClone(input)), {
        authMethod: authMethod ?? null,
      });
      close();
    } catch (cause) {
      const mapped = mapEnterpriseError(cause);
      text('error')(
        mapped
          ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
          : t('connectorCatalog.errors.generic'),
      );
      dispatch({ type: 'locked', value: false });
    }
  };

  const field = (name: keyof CreateConnectorState, label: string) => (
    <div className={styles.field} key={name}>
      <Text strong>{t(label as never)}</Text>
      <Input
        disabled={state.locked}
        value={String(state[name] ?? '')}
        onChange={(event) =>
          text(name as keyof Omit<CreateConnectorState, 'credentialMode' | 'locked'>)(
            event.target.value,
          )
        }
      />
    </div>
  );

  return (
    <div className={styles.body}>
      <Text type={'secondary'}>{t('connectorCatalog.create.description')}</Text>
      <div className={styles.grid}>
        {field('key', 'connectorCatalog.create.key')}
        {field('displayName', 'connectorCatalog.editor.displayName')}
        {field('endpoint', 'connectorCatalog.editor.endpoint')}
        <div className={styles.field}>
          <Text strong>{t('connectorCatalog.editor.credentialMode')}</Text>
          <Select
            disabled={state.locked}
            value={state.credentialMode}
            options={(['none', 'shared_service_account', 'per_user_oauth'] as const).map(
              (value) => ({
                label: t(`connectorCatalog.credentialMode.${value}` as never),
                value,
              }),
            )}
            onChange={(value) =>
              dispatch({ type: 'mode', value: value as ConnectorCredentialMode })
            }
          />
        </div>
      </div>
      <div className={styles.field}>
        <Text strong>{t('connectorCatalog.editor.description')}</Text>
        <TextArea
          disabled={state.locked}
          rows={2}
          value={state.description}
          onChange={(event) => text('description')(event.target.value)}
        />
      </div>
      {state.credentialMode === 'per_user_oauth' ? (
        <div className={styles.grid}>
          {field('issuer', 'connectorCatalog.editor.issuer')}
          {field('authorizationEndpoint', 'connectorCatalog.editor.authorizationEndpoint')}
          {field('tokenEndpoint', 'connectorCatalog.editor.tokenEndpoint')}
          {field('clientId', 'connectorCatalog.editor.clientId')}
          {field('scopes', 'connectorCatalog.editor.scopes')}
        </div>
      ) : null}
      {state.credentialMode !== 'none' ? (
        <div className={styles.field}>
          <Text strong>{t('connectorCatalog.create.secret')}</Text>
          <InputPassword
            autoComplete={'new-password'}
            disabled={state.locked}
            value={state.secret}
            onChange={(event) => text('secret')(event.target.value)}
          />
          <Text type={'secondary'}>{t('connectorCatalog.editor.secretNeverReturned')}</Text>
        </div>
      ) : null}
      <div className={styles.field}>
        <Text strong>{t('connectorCatalog.create.reason')}</Text>
        <TextArea
          disabled={state.locked}
          rows={3}
          value={state.reason}
          onChange={(event) => text('reason')(event.target.value)}
        />
      </div>
      {state.error ? (
        <Text className={styles.error} role={'alert'}>
          {state.error}
        </Text>
      ) : null}
      <div className={styles.footer}>
        <Button disabled={state.locked} onClick={close}>
          {t('users.modals.cancel')}
        </Button>
        <Button loading={state.locked} type={'primary'} onClick={() => void submit()}>
          {t('connectorCatalog.actions.create')}
        </Button>
      </div>
    </div>
  );
});

CreateConnectorContent.displayName = 'CreateConnectorContent';

export const openCreateConnectorModal = (props: CreateConnectorContentProps) =>
  createModal({
    content: <CreateConnectorContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('connectorCatalog.create.title', { ns: 'admin' }),
    width: 'min(94vw, 760px)',
  });
