import { type ChatMessageError, type ChatPluginPayload } from '@lobechat/types';
import { Alert, Flexbox, Highlighter } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import type { TFunction } from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PLATFORM_CONNECTOR_ERROR_CODE_VALUES,
  type PlatformConnectorErrorCode,
} from '@/const/platform/errorCodes';
import { getRuntimeErrorMessage } from '@/utils/locale/runtimeErrorMessage';

import PluginSettings from './PluginSettings';

const styles = createStaticStyles(({ css }) => ({
  errorResponseExtra: css`
    padding-inline-start: 12px;
  `,
}));

interface ErrorResponseProps extends ChatMessageError {
  id: string;
  plugin?: ChatPluginPayload;
}

const connectorErrorCodes = new Set<string>(PLATFORM_CONNECTOR_ERROR_CODE_VALUES);

export const getConnectorToolErrorCode = (
  error: unknown,
): PlatformConnectorErrorCode | undefined => {
  if (!error || typeof error !== 'object') return;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && connectorErrorCodes.has(code)
    ? (code as PlatformConnectorErrorCode)
    : undefined;
};

export const getConnectorToolErrorMessage = (
  code: PlatformConnectorErrorCode,
  t: TFunction<'setting'>,
): string => t(`platformConnectors.feedback.${code}` as never);

const ErrorResponse = memo<ErrorResponseProps>(({ id, type, body, message, plugin }) => {
  const { t } = useTranslation(['error', 'modelRuntime']);
  if (type === 'PluginSettingsInvalid') {
    return <PluginSettings id={id} plugin={plugin} />;
  }

  return (
    <Alert
      showIcon
      title={getRuntimeErrorMessage(t, type)}
      type={'secondary'}
      extra={
        <Flexbox className={styles.errorResponseExtra}>
          <Highlighter actionIconSize={'small'} language={'json'} variant={'borderless'}>
            {JSON.stringify(body || { message, type }, null, 2)}
          </Highlighter>
        </Flexbox>
      }
    />
  );
});

export const ConnectorToolErrorResponse = memo<{ error: unknown }>(({ error }) => {
  const { t } = useTranslation('setting');
  const code = getConnectorToolErrorCode(error);
  if (!code) return null;

  return <Alert showIcon title={getConnectorToolErrorMessage(code, t)} type={'secondary'} />;
});

ConnectorToolErrorResponse.displayName = 'ConnectorToolErrorResponse';

export default ErrorResponse;
