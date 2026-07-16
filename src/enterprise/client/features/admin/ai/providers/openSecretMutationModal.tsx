'use client';

import { InputPassword, Text, TextArea } from '@lobehub/ui';
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

import { buildAiSecretMutation } from '../controller';
import type { AiSecretMutation } from '../types';

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
}));

interface SecretModalState {
  error: string | null;
  operation: AiSecretMutation['operation'];
  phase: 'idle' | 'submitting';
  reason: string;
  value: string;
}

type SecretModalAction =
  | { error: string | null; type: 'error' }
  | { operation: AiSecretMutation['operation']; type: 'operation' }
  | { phase: SecretModalState['phase']; type: 'phase' }
  | { reason: string; type: 'reason' }
  | { type: 'value'; value: string };

const initialState: SecretModalState = {
  error: null,
  operation: 'keep',
  phase: 'idle',
  reason: '',
  value: '',
};

const reducer = (state: SecretModalState, action: SecretModalAction): SecretModalState => {
  switch (action.type) {
    case 'error': {
      return { ...state, error: action.error };
    }
    case 'operation': {
      return { ...state, error: null, operation: action.operation, value: '' };
    }
    case 'phase': {
      return { ...state, phase: action.phase };
    }
    case 'reason': {
      return { ...state, error: null, reason: action.reason };
    }
    case 'value': {
      return { ...state, error: null, value: action.value };
    }
  }
};

export interface SecretMutationContentProps {
  authMethod?: AdminReauthAuthMethod;
  configured: boolean;
  onSubmit: (params: { reason: string; secret: AiSecretMutation }) => Promise<void>;
  providerName: string;
}

export const SecretMutationContent = memo<SecretMutationContentProps>(
  ({ authMethod, configured, onSubmit, providerName }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [state, dispatch] = useReducer(reducer, initialState);
    const locked = state.phase !== 'idle';

    const handleSubmit = async () => {
      const reason = state.reason.trim();
      if (!reason) {
        dispatch({ error: t('aiCatalog.secret.reasonRequired'), type: 'error' });
        return;
      }
      if (state.operation === 'replace' && !state.value) {
        dispatch({ error: t('aiCatalog.secret.valueRequired'), type: 'error' });
        return;
      }

      const secret = buildAiSecretMutation(state.operation, state.value);
      if (!secret) return;
      dispatch({ phase: 'submitting', type: 'phase' });
      try {
        const canonical = { reason, secret };
        await withAdminReauthRetry(() => onSubmit(structuredClone(canonical)), {
          authMethod: authMethod ?? null,
        });
        close();
      } catch (cause) {
        const mapped = mapEnterpriseError(cause);
        dispatch({
          error: mapped
            ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
            : t('aiCatalog.errors.generic'),
          type: 'error',
        });
        dispatch({ phase: 'idle', type: 'phase' });
      }
    };

    return (
      <div className={styles.body}>
        <Text type="secondary">{t('aiCatalog.secret.desc', { provider: providerName })}</Text>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.secret.operation')}</Text>
          <Select
            disabled={locked}
            value={state.operation}
            options={(['keep', 'replace', 'clear'] as const).map((operation) => ({
              disabled: operation === 'clear' && !configured,
              label: t(`aiCatalog.secret.operation.${operation}` as never),
              value: operation,
            }))}
            onChange={(operation) =>
              dispatch({ operation: operation as AiSecretMutation['operation'], type: 'operation' })
            }
          />
        </div>
        {state.operation === 'replace' ? (
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.secret.newValue')}</Text>
            <InputPassword
              autoComplete="new-password"
              disabled={locked}
              maxLength={32_768}
              value={state.value}
              onChange={(event) => dispatch({ type: 'value', value: event.target.value })}
            />
            <Text type="secondary">{t('aiCatalog.secret.neverStoredClient')}</Text>
          </div>
        ) : null}
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.secret.reason')}</Text>
          <TextArea
            disabled={locked}
            maxLength={2000}
            rows={3}
            value={state.reason}
            onChange={(event) => dispatch({ reason: event.target.value, type: 'reason' })}
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
          <Button
            danger={state.operation === 'clear'}
            loading={locked}
            type="primary"
            onClick={() => void handleSubmit()}
          >
            {t('aiCatalog.secret.apply')}
          </Button>
        </div>
      </div>
    );
  },
);

SecretMutationContent.displayName = 'AdminAiSecretMutationContent';

export const openSecretMutationModal = (props: SecretMutationContentProps) =>
  createModal({
    content: <SecretMutationContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('aiCatalog.editor.secret.title', { ns: 'admin' }),
    width: 'min(92vw, 520px)',
  });
