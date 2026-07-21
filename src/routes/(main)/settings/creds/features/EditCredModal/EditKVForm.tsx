'use client';

import { type UserCredSummary } from '@lobechat/types';
import { Button, Flexbox } from '@lobehub/ui';
import { useMutation } from '@tanstack/react-query';
import { Form, Input, Spin } from 'antd';
import { createStaticStyles } from 'antd-style';
import { Minus, Plus } from 'lucide-react';
import { type FC, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';

import { type CredsApi } from '../useCredsApi';
import {
  buildKvUpdateValues,
  marketPrefillKvPairs,
  platformPrefillKvPairs,
} from './editKvFormUtils';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-block-start: 24px;
  `,
  kvPair: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
  `,
}));

interface EditKVFormProps {
  cred: UserCredSummary;
  credsApi: CredsApi;
  onCancel: () => void;
  onSuccess: () => void;
}

interface FormValues {
  description?: string;
  kvPairs: Array<{ key: string; value: string }>;
  name: string;
}

const EditKVForm: FC<EditKVFormProps> = ({ cred, credsApi, onCancel, onSuccess }) => {
  const { t } = useTranslation('setting');
  const { allowed: canManageCredentials } = usePermission('manage_provider_key');
  const [form] = Form.useForm<FormValues>();
  const [isLoading, setIsLoading] = useState(true);
  const isPlatformMode = credsApi.mode === 'platform';

  // Fetch values on mount — platform mode never pre-fills secret material.
  useEffect(() => {
    const fetchDecryptedValues = async () => {
      if (!canManageCredentials) {
        setIsLoading(false);
        return;
      }

      try {
        if (isPlatformMode) {
          // Prefer valueKeys from list summary; fall back to get() key names only.
          let valueKeys = (cred as { valueKeys?: string[] }).valueKeys;
          if (!valueKeys?.length) {
            const result = await credsApi.client.get.query({
              decrypt: true,
              id: cred.id,
            });
            valueKeys = Object.keys(
              (result as { plaintext?: Record<string, string> })?.plaintext ?? {},
            );
          }
          form.setFieldsValue({
            description: cred.description,
            kvPairs: platformPrefillKvPairs(valueKeys),
            name: cred.name,
          });
        } else {
          const result = await credsApi.client.get.query({
            decrypt: true,
            id: cred.id,
          });
          const values = (result as { plaintext?: Record<string, string> }).plaintext || {};
          form.setFieldsValue({
            description: cred.description,
            kvPairs: marketPrefillKvPairs(values),
            name: cred.name,
          });
        }
      } catch {
        form.setFieldsValue({
          description: cred.description,
          kvPairs: [{ key: '', value: '' }],
          name: cred.name,
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchDecryptedValues();
  }, [canManageCredentials, cred, credsApi, form, isPlatformMode]);

  const updateMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!canManageCredentials) return;

      const valuesObj = buildKvUpdateValues(values.kvPairs);

      await credsApi.client.update.mutate({
        description: values.description,
        id: cred.id,
        name: values.name,
        // Omit values when empty → metadata-only update (server keeps secret).
        ...(valuesObj ? { values: valuesObj } : {}),
      });
    },
    onSuccess: () => {
      onSuccess();
    },
  });

  const handleSubmit = (values: FormValues) => {
    if (!canManageCredentials) return;

    updateMutation.mutate(values);
  };

  if (isLoading) {
    return (
      <Flexbox align="center" justify="center" style={{ padding: 48 }}>
        <Spin />
      </Flexbox>
    );
  }

  const valuePlaceholder = isPlatformMode
    ? t('creds.form.valueKeepPlaceholder')
    : t('creds.form.valuePlaceholder');

  return (
    <Form<FormValues> form={form} layout="vertical" onFinish={handleSubmit}>
      <Form.Item
        label={t('creds.form.name')}
        name="name"
        rules={[{ required: true, message: t('creds.form.nameRequired') }]}
      >
        <Input disabled={!canManageCredentials} />
      </Form.Item>

      <Form.Item label={t('creds.form.values')}>
        <Form.List name="kvPairs">
          {(fields, { add, remove }) => (
            <Flexbox gap={8}>
              {fields.map(({ key, name, ...restField }) => (
                <div className={styles.kvPair} key={key}>
                  <Form.Item
                    {...restField}
                    name={[name, 'key']}
                    style={{ flex: 1, marginBottom: 0 }}
                  >
                    <Input
                      disabled={!canManageCredentials}
                      placeholder={cred.type === 'kv-env' ? 'ENV_VAR_NAME' : 'Header-Name'}
                    />
                  </Form.Item>
                  <Form.Item
                    {...restField}
                    name={[name, 'value']}
                    style={{ flex: 2, marginBottom: 0 }}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      disabled={!canManageCredentials}
                      placeholder={valuePlaceholder}
                    />
                  </Form.Item>
                  {fields.length > 1 && (
                    <Button
                      disabled={!canManageCredentials}
                      icon={Minus}
                      size="small"
                      type="text"
                      onClick={() => remove(name)}
                    />
                  )}
                </div>
              ))}
              <Button
                block
                disabled={!canManageCredentials}
                icon={Plus}
                type="dashed"
                onClick={() => add({ key: '', value: '' })}
              >
                {t('creds.form.addPair')}
              </Button>
            </Flexbox>
          )}
        </Form.List>
      </Form.Item>

      <Form.Item label={t('creds.form.description')} name="description">
        <Input.TextArea
          disabled={!canManageCredentials}
          placeholder={t('creds.form.descriptionPlaceholder')}
          rows={2}
        />
      </Form.Item>

      <div className={styles.footer}>
        <Button onClick={onCancel}>{t('creds.form.cancel')}</Button>
        <Button
          disabled={!canManageCredentials}
          htmlType="submit"
          loading={updateMutation.isPending}
          type="primary"
        >
          {t('creds.form.save')}
        </Button>
      </div>
    </Form>
  );
};

export default EditKVForm;
