'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Select, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { TASK_TEMPLATE_MAX_CONNECTORS } from '@/server/enterprise/contracts/adminTaskTemplates';

import {
  buildConnectorOptions,
  decodeConnectorValue,
  encodeConnectorValue,
} from '../connectorCatalog';
import type { TaskTemplateFormErrors } from '../useTaskTemplateForm';
import { taskTemplateEditorStyles as styles } from './styles';
import type { TaskTemplateFieldSectionProps } from './types';

interface ConnectorFieldsProps extends Omit<TaskTemplateFieldSectionProps, 'id'> {
  errors: TaskTemplateFormErrors;
}

/** The connector rows plus the capped "add" affordance. */
export const ConnectorFields = memo<ConnectorFieldsProps>(
  ({ dispatch, errors, state, submitting }) => {
    const { t } = useTranslation('admin');

    return (
      <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend className={styles.label}>{t('taskTemplateCatalog.form.connectors')}</legend>
        {state.connectors.length === 0 ? (
          <Text type="secondary">{t('taskTemplateCatalog.form.connectorEmpty')}</Text>
        ) : null}
        {state.connectors.map((connector, index) => (
          <div className={styles.connectorRow} key={index}>
            {/* Catalog-backed: an identifier outside these lists makes the user-side card
                disappear silently, so it must not be typeable. */}
            <Select
              aria-label={t('taskTemplateCatalog.form.connectorIdentifier')}
              disabled={submitting}
              placeholder={t('taskTemplateCatalog.form.connectorPlaceholder')}
              value={connector.identifier ? encodeConnectorValue(connector) : undefined}
              options={buildConnectorOptions(connector, (identifier) =>
                t('taskTemplateCatalog.form.connectorRetired', { identifier }),
              )}
              onChange={(value) => {
                const decoded = decodeConnectorValue(String(value ?? ''));
                if (decoded) dispatch({ index, type: 'setConnector', value: decoded });
              }}
            />
            <label>
              <Switch
                checked={connector.required}
                disabled={submitting}
                onChange={(value) => dispatch({ index, type: 'setConnectorRequired', value })}
              />{' '}
              {t('taskTemplateCatalog.form.connectorRequired')}
            </label>
            <Button
              disabled={submitting}
              htmlType="button"
              size="small"
              onClick={() => dispatch({ index, type: 'removeConnector' })}
            >
              {t('taskTemplateCatalog.form.connectorRemove')}
            </Button>
          </div>
        ))}
        <Flexbox horizontal>
          <Button
            // The API contract caps the array — do not offer a row the server would reject.
            disabled={submitting || state.connectors.length >= TASK_TEMPLATE_MAX_CONNECTORS}
            htmlType="button"
            size="small"
            onClick={() => dispatch({ type: 'addConnector' })}
          >
            {t('taskTemplateCatalog.form.connectorAdd')}
          </Button>
        </Flexbox>
        {errors.connectors ? (
          <Text className={styles.error} role="alert">
            {errors.connectors}
          </Text>
        ) : null}
      </fieldset>
    );
  },
);

ConnectorFields.displayName = 'AdminTaskTemplateConnectorFields';
