'use client';

import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  buildModelDependency,
  buildSkillDependency,
  withModel,
  withSkillAdded,
  withSkillRemoved,
} from './dependencyCatalog';
import type { AdminAgentDraftDependencies } from './types';
import {
  useAdminProviderModelSource,
  useAdminPublishedProviders,
  useAdminPublishedSkills,
} from './useDependencyCatalog';

const styles = createStaticStyles(({ css }) => ({
  label: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  mono: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
    word-break: break-all;
  `,
}));

interface DependencyEditorProps {
  dependencies: AdminAgentDraftDependencies;
  editable: boolean;
  enabled: boolean;
  onChange: (next: AdminAgentDraftDependencies) => void;
}

const FieldLabel = ({ children }: { children: string }) => (
  <Text className={styles.label}>{children}</Text>
);

export const DependencyEditor = ({
  dependencies,
  editable,
  enabled,
  onChange,
}: DependencyEditorProps) => {
  const { t } = useTranslation('admin');

  const providers = useAdminPublishedProviders(enabled);
  const skills = useAdminPublishedSkills(enabled);

  const [providerId, setProviderId] = useState<string | undefined>();

  // Initialise the provider selection from an existing model ref (edit / recovery).
  useEffect(() => {
    if (providerId || !dependencies.model || !providers.data) return;
    const match = providers.data.find(
      (provider) => provider.providerKey === dependencies.model!.providerKey,
    );
    if (match) setProviderId(match.id);
  }, [dependencies.model, providerId, providers.data]);

  const source = useAdminProviderModelSource(providerId);

  const chooseProvider = (nextId: string | undefined) => {
    setProviderId(nextId);
    // Switching provider invalidates the previous exact model ref — clear it fully.
    if (dependencies.model) onChange(withModel(dependencies, null));
  };

  const chooseModel = (modelKey: string | undefined) => {
    if (!modelKey || !source.data) return;
    onChange(withModel(dependencies, buildModelDependency(source.data, modelKey)));
  };

  const skillOptions = useMemo(
    () =>
      (skills.data ?? [])
        .filter((skill) => !dependencies.skills.some((s) => s.skillKey === skill.skillKey))
        .map((skill) => ({
          label: `${skill.displayName} · ${skill.version}`,
          value: skill.skillKey,
        })),
    [dependencies.skills, skills.data],
  );

  const addSkill = (skillKey: string | undefined) => {
    const published = skills.data?.find((skill) => skill.skillKey === skillKey);
    if (!published) return;
    onChange(withSkillAdded(dependencies, buildSkillDependency(published)));
  };

  const model = dependencies.model;

  return (
    <Flexbox gap={20}>
      {/* ---- Model (required, exact) ---- */}
      <Flexbox gap={8}>
        <Text as="h4" fontSize={14} weight={600}>
          {t('agentCatalog.dependency.model.title')}
        </Text>
        {providers.error ? (
          <Alert
            showIcon
            message={t('agentCatalog.dependency.model.loadError')}
            type="error"
            action={
              <Button size="small" onClick={() => void providers.mutate()}>
                {t('agentCatalog.dependency.retry')}
              </Button>
            }
          />
        ) : providers.isLoading ? (
          <Text type="secondary">{t('agentCatalog.dependency.loading')}</Text>
        ) : providers.data && providers.data.length === 0 ? (
          <Alert showIcon message={t('agentCatalog.dependency.model.empty')} type="warning" />
        ) : (
          <Flexbox gap={12}>
            <Flexbox gap={6}>
              <FieldLabel>{t('agentCatalog.dependency.model.provider')}</FieldLabel>
              <Select
                aria-label={t('agentCatalog.dependency.model.provider')}
                disabled={!editable}
                placeholder={t('agentCatalog.dependency.model.providerPlaceholder')}
                value={providerId}
                options={(providers.data ?? []).map((provider) => ({
                  label: `${provider.displayName} (${provider.providerKey})`,
                  value: provider.id,
                }))}
                onChange={(value) => chooseProvider(value as string | undefined)}
              />
            </Flexbox>
            {providerId ? (
              source.error ? (
                <Alert
                  showIcon
                  message={t('agentCatalog.dependency.model.loadError')}
                  type="error"
                  action={
                    <Button size="small" onClick={() => void source.mutate()}>
                      {t('agentCatalog.dependency.retry')}
                    </Button>
                  }
                />
              ) : source.isLoading ? (
                <Text type="secondary">{t('agentCatalog.dependency.loading')}</Text>
              ) : source.data === null ? (
                <Alert
                  showIcon
                  message={t('agentCatalog.dependency.model.unresolvable')}
                  type="warning"
                />
              ) : source.data ? (
                <Flexbox gap={6}>
                  <FieldLabel>{t('agentCatalog.dependency.model.model')}</FieldLabel>
                  <Select
                    aria-label={t('agentCatalog.dependency.model.model')}
                    disabled={!editable}
                    placeholder={t('agentCatalog.dependency.model.modelPlaceholder')}
                    value={model?.modelKey}
                    options={source.data.chatModels.map((option) => ({
                      label: option.displayName
                        ? `${option.displayName} (${option.modelKey})`
                        : option.modelKey,
                      value: option.modelKey,
                    }))}
                    onChange={(value) => chooseModel(value as string | undefined)}
                  />
                </Flexbox>
              ) : null
            ) : null}
            {model ? (
              <Block padding={12} variant="outlined">
                <Flexbox gap={2}>
                  <Text>
                    {model.providerKey}/{model.modelKey}
                  </Text>
                  <Text className={styles.mono}>
                    {t('agentCatalog.dependency.model.pinned', {
                      checksum: model.providerChecksum.slice(0, 16),
                      revision: model.providerRevision,
                    })}
                  </Text>
                </Flexbox>
              </Block>
            ) : (
              <Text type="danger">{t('agentCatalog.dependency.model.required')}</Text>
            )}
          </Flexbox>
        )}
      </Flexbox>

      {/* ---- Skills (optional, exact) ---- */}
      <Flexbox gap={8}>
        <Text as="h4" fontSize={14} weight={600}>
          {t('agentCatalog.dependency.skill.title')}
        </Text>
        {skills.error ? (
          <Alert
            showIcon
            message={t('agentCatalog.dependency.skill.loadError')}
            type="error"
            action={
              <Button size="small" onClick={() => void skills.mutate()}>
                {t('agentCatalog.dependency.retry')}
              </Button>
            }
          />
        ) : (
          <Flexbox gap={8}>
            {dependencies.skills.length === 0 ? (
              <Text type="secondary">{t('agentCatalog.dependency.skill.empty')}</Text>
            ) : (
              dependencies.skills.map((skill) => (
                <Flexbox
                  horizontal
                  align="center"
                  gap={8}
                  justify="space-between"
                  key={skill.skillKey}
                >
                  <Flexbox gap={2}>
                    <Text>
                      {skill.skillKey} · {skill.version}
                    </Text>
                    <Text className={styles.mono}>{skill.checksum.slice(0, 16)}…</Text>
                  </Flexbox>
                  {editable ? (
                    <Button
                      size="small"
                      onClick={() => onChange(withSkillRemoved(dependencies, skill.skillKey))}
                    >
                      {t('agentCatalog.dependency.skill.remove')}
                    </Button>
                  ) : null}
                </Flexbox>
              ))
            )}
            {editable ? (
              <Select
                aria-label={t('agentCatalog.dependency.skill.add')}
                disabled={skills.isLoading}
                options={skillOptions}
                value={null}
                placeholder={
                  skills.isLoading
                    ? t('agentCatalog.dependency.loading')
                    : t('agentCatalog.dependency.skill.add')
                }
                onChange={(value) => addSkill(value as string | undefined)}
              />
            ) : null}
          </Flexbox>
        )}
      </Flexbox>

      {/* ---- Connectors (deferred: catalog does not expose published checksums yet) ---- */}
      <Flexbox gap={8}>
        <Text as="h4" fontSize={14} weight={600}>
          {t('agentCatalog.dependency.connector.title')}
        </Text>
        {dependencies.connectors.length > 0 ? (
          dependencies.connectors.map((connector) => (
            <Flexbox horizontal align="center" gap={8} key={connector.connectorKey}>
              <Tag>{connector.connectorKey}</Tag>
              <Text className={styles.mono}>
                {t('agentCatalog.dependency.connector.pinned', {
                  revision: connector.publishedRevision,
                })}
              </Text>
            </Flexbox>
          ))
        ) : (
          <Text type="secondary">{t('agentCatalog.dependency.connector.empty')}</Text>
        )}
        <Alert
          showIcon
          description={t('agentCatalog.dependency.connector.deferred')}
          message={t('agentCatalog.dependency.connector.deferredTitle')}
          type="info"
        />
      </Flexbox>
    </Flexbox>
  );
};
