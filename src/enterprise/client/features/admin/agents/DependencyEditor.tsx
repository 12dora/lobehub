'use client';

import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  allowedConnectorToolKeys,
  buildConnectorDependency,
  buildModelDependency,
  buildSkillDependency,
  isModelCurrent,
  staleConnectorKeys,
  staleSkillKeys,
  withConnectorAdded,
  withConnectorRemoved,
  withModel,
  withSkillAdded,
  withSkillRemoved,
} from './dependencyCatalog';
import type { AdminAgentDraftDependencies } from './types';
import {
  useAdminConnectorDetail,
  useAdminConnectorDetails,
  useAdminProviderModelSource,
  useAdminPublishedConnectors,
  useAdminPublishedProviders,
  useAdminPublishedSkills,
} from './useDependencyCatalog';

const styles = createStaticStyles(({ css }) => ({
  label: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
}));

export interface DependencyValidity {
  issues: string[];
  ready: boolean;
}

interface DependencyEditorProps {
  /** Owning Agent id — changing it resets the provider/connector selection so it never bleeds. */
  agentId: string;
  dependencies: AdminAgentDraftDependencies;
  editable: boolean;
  enabled: boolean;
  onChange: (next: AdminAgentDraftDependencies) => void;
  onValidityChange?: (validity: DependencyValidity) => void;
}

const FieldLabel = ({ children }: { children: string }) => (
  <Text className={styles.label}>{children}</Text>
);

export const DependencyEditor = ({
  agentId,
  dependencies,
  editable,
  enabled,
  onChange,
  onValidityChange,
}: DependencyEditorProps) => {
  const { t } = useTranslation('admin');

  const providers = useAdminPublishedProviders(enabled);
  const skills = useAdminPublishedSkills(enabled);
  const connectors = useAdminPublishedConnectors(enabled);

  const [providerId, setProviderId] = useState<string | undefined>();
  const [connectorId, setConnectorId] = useState<string | undefined>();

  // Reset all selection state whenever the Agent context changes — never bleed across Agents.
  const agentRef = useRef(agentId);
  useEffect(() => {
    if (agentRef.current === agentId) return;
    agentRef.current = agentId;
    setProviderId(undefined);
    setConnectorId(undefined);
  }, [agentId]);

  // Initialise the provider selection from an existing model ref (edit / recovery).
  useEffect(() => {
    if (providerId || !dependencies.model || !providers.data) return;
    const match = providers.data.find(
      (provider) => provider.providerKey === dependencies.model!.providerKey,
    );
    if (match) setProviderId(match.id);
  }, [dependencies.model, providerId, providers.data]);

  const source = useAdminProviderModelSource(providerId);
  const connectorDetail = useAdminConnectorDetail(connectorId);

  const model = dependencies.model;

  // Fetch the exact detail for every referenced connector so existing refs can be exact-validated.
  const referencedConnectorIds = useMemo(
    () => dependencies.connectors.map((connector) => connector.connectorId),
    [dependencies.connectors],
  );
  const connectorRefDetails = useAdminConnectorDetails(enabled ? referencedConnectorIds : []);

  // A source is usable for validation ONLY when it has a successful, settled snapshot: data present,
  // no error, and NOT revalidating. Retained data from a prior success while an error or background
  // revalidation is in flight is NOT trustworthy → readiness fails closed.
  const usable = (hook: { data?: unknown; error?: unknown; isValidating?: boolean }) =>
    hook.data !== undefined && !hook.error && !hook.isValidating;

  const sourceSettled = usable(source);
  const skillsSettled = usable(skills);
  const connectorsSettled = usable(connectorRefDetails);
  // The provider list, connector list and currently-selected connector detail ALSO fail closed:
  // a revalidating/errored list is not trustworthy for authoring or for gating save readiness.
  const providersUsable = usable(providers);
  const connectorsListUsable = usable(connectors);
  const connectorDetailUsable = usable(connectorDetail);

  // Display staleness only once the relevant source has a settled success (no spurious "Outdated").
  const displayModelStale = Boolean(model) && sourceSettled && !isModelCurrent(model, source.data);
  const staleSkills = useMemo(
    () => (skillsSettled ? staleSkillKeys(dependencies.skills, skills.data) : []),
    [dependencies.skills, skills.data, skillsSettled],
  );
  const staleConnectors = useMemo(
    () =>
      connectorsSettled
        ? staleConnectorKeys(dependencies.connectors, connectorRefDetails.data)
        : [],
    [connectorRefDetails.data, connectorsSettled, dependencies.connectors],
  );

  // Readiness FAILS CLOSED. EVERY authorable dependency catalog must be freshly settled
  // (non-error, non-validating) — not just the ones the current draft already references — because
  // the operator can author from any of them. So an errored/revalidating provider list, model
  // source, skill catalog OR connector list blocks save even when the skill/connector ref arrays
  // are EMPTY. When refs are present, the referenced batch must also be settled and match exactly.
  const modelReady =
    Boolean(model) && providersUsable && sourceSettled && isModelCurrent(model, source.data);
  const skillsReady =
    skillsSettled && (dependencies.skills.length === 0 || staleSkills.length === 0);
  // A connector selected for add/update means an authoring operation is in flight: its current
  // detail must be a settled, RESOLVED success (not undefined/loading, not retained-data+error,
  // not retained-data+isValidating, and not a null/unresolvable projection). Otherwise save FAILS
  // CLOSED — the operator could otherwise commit while authoring from a stale/absent snapshot. With
  // no connector selected, no current detail is required.
  const connectorDetailReady =
    !connectorId || (connectorDetailUsable && connectorDetail.data != null);
  const connectorsReady =
    connectorsListUsable &&
    connectorDetailReady &&
    (dependencies.connectors.length === 0 || (connectorsSettled && staleConnectors.length === 0));
  const ready = modelReady && skillsReady && connectorsReady;

  const issues = useMemo(() => {
    const list: string[] = [];
    if (displayModelStale) list.push('agentCatalog.dependency.issues.modelStale');
    if (staleSkills.length > 0) list.push('agentCatalog.dependency.issues.skillStale');
    if (staleConnectors.length > 0) list.push('agentCatalog.dependency.issues.connectorStale');
    return list;
  }, [displayModelStale, staleConnectors.length, staleSkills.length]);

  const issuesKey = issues.join('|');
  useEffect(() => {
    onValidityChange?.({ issues: issuesKey ? issuesKey.split('|') : [], ready });
  }, [issuesKey, onValidityChange, ready]);

  const chooseProvider = (nextId: string | undefined) => {
    if (!providersUsable) return; // never select against a loading/revalidating/errored provider list
    setProviderId(nextId);
    if (dependencies.model) onChange(withModel(dependencies, null));
  };

  const chooseModel = (modelKey: string | undefined) => {
    // Fail closed: never author a model ref from a loading/revalidating/errored source snapshot.
    if (!modelKey || !sourceSettled || !source.data) return;
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
    if (!skillsSettled) return; // never author from a loading/revalidating/errored skill catalog
    const published = skills.data?.find((skill) => skill.skillKey === skillKey);
    if (published) onChange(withSkillAdded(dependencies, buildSkillDependency(published)));
  };

  const connectorOptions = useMemo(
    () =>
      (connectors.data ?? []).map((connector) => ({
        label: `${connector.displayName} (${connector.key})`,
        value: connector.id,
      })),
    [connectors.data],
  );
  const addConnector = () => {
    // Fail closed: never author a connector ref from a loading/revalidating/errored detail snapshot.
    if (!connectorDetailUsable || !connectorDetail.data) return;
    onChange(
      withConnectorAdded(
        dependencies,
        buildConnectorDependency(
          connectorDetail.data,
          allowedConnectorToolKeys(connectorDetail.data),
        ),
      ),
    );
    setConnectorId(undefined);
  };

  const retry = (mutate: () => Promise<unknown>) => (
    <Button size="small" onClick={() => void mutate()}>
      {t('agentCatalog.dependency.retry')}
    </Button>
  );

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
            action={retry(providers.mutate)}
            message={t('agentCatalog.dependency.model.loadError')}
            type="error"
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
                disabled={!editable || !providersUsable}
                placeholder={t('agentCatalog.dependency.model.providerPlaceholder')}
                value={providerId}
                options={(providers.data ?? []).map((provider) => ({
                  label: `${provider.displayName} (${provider.providerKey})`,
                  value: provider.id,
                }))}
                onChange={(value) => chooseProvider(value as string | undefined)}
              />
              {providers.isValidating && providers.data ? (
                <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>
              ) : null}
            </Flexbox>
            {providerId ? (
              source.error ? (
                <Alert
                  showIcon
                  action={retry(source.mutate)}
                  message={t('agentCatalog.dependency.model.loadError')}
                  type="error"
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
                    disabled={!editable || !sourceSettled}
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
                  <Flexbox horizontal align="center" gap={8}>
                    <Text>
                      {model.providerKey}/{model.modelKey}
                    </Text>
                    {displayModelStale ? (
                      <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
                    ) : null}
                    {source.isValidating && source.data ? (
                      <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>
                    ) : null}
                  </Flexbox>
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
            action={retry(skills.mutate)}
            message={t('agentCatalog.dependency.skill.loadError')}
            type="error"
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
                    <Flexbox horizontal align="center" gap={8}>
                      <Text>
                        {skill.skillKey} · {skill.version}
                      </Text>
                      {staleSkills.includes(skill.skillKey) ? (
                        <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
                      ) : null}
                    </Flexbox>
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
                disabled={!skillsSettled}
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
            {dependencies.skills.length > 0 && skills.isValidating && skills.data ? (
              <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>
            ) : null}
          </Flexbox>
        )}
      </Flexbox>

      {/* ---- Connectors (optional, exact) ---- */}
      <Flexbox gap={8}>
        <Text as="h4" fontSize={14} weight={600}>
          {t('agentCatalog.dependency.connector.title')}
        </Text>
        {/* Referenced-connector validation state: an error or in-flight revalidation blocks save
            (readiness fails closed) and is surfaced here with a sanitized message + explicit retry. */}
        {enabled && dependencies.connectors.length > 0 && connectorRefDetails.error ? (
          <Alert
            showIcon
            action={retry(connectorRefDetails.mutate)}
            message={t('agentCatalog.dependency.connector.validateError')}
            type="error"
          />
        ) : enabled && dependencies.connectors.length > 0 && !connectorsSettled ? (
          <Text type="secondary">{t('agentCatalog.dependency.connector.validating')}</Text>
        ) : null}
        {connectors.error ? (
          <Alert
            showIcon
            action={retry(connectors.mutate)}
            message={t('agentCatalog.dependency.connector.loadError')}
            type="error"
          />
        ) : (
          <Flexbox gap={8}>
            {dependencies.connectors.length === 0 ? (
              <Text type="secondary">{t('agentCatalog.dependency.connector.empty')}</Text>
            ) : (
              dependencies.connectors.map((connector) => (
                <Flexbox
                  horizontal
                  align="center"
                  gap={8}
                  justify="space-between"
                  key={connector.connectorKey}
                >
                  <Flexbox gap={2}>
                    <Flexbox horizontal align="center" gap={8}>
                      <Tag>{connector.connectorKey}</Tag>
                      <Text type="secondary">
                        {connector.allowedToolKeys.length}{' '}
                        {t('agentCatalog.dependency.connector.toolsLabel')}
                      </Text>
                      {staleConnectors.includes(connector.connectorKey) ? (
                        <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
                      ) : null}
                    </Flexbox>
                  </Flexbox>
                  {editable ? (
                    <Flexbox horizontal gap={8}>
                      <Button
                        disabled={!connectorsListUsable}
                        size="small"
                        onClick={() => {
                          if (!connectorsListUsable) return; // never re-select from a stale list
                          const match = connectors.data?.find(
                            (option) => option.key === connector.connectorKey,
                          );
                          if (match) setConnectorId(match.id);
                        }}
                      >
                        {t('agentCatalog.dependency.connector.update')}
                      </Button>
                      <Button
                        size="small"
                        onClick={() =>
                          onChange(withConnectorRemoved(dependencies, connector.connectorKey))
                        }
                      >
                        {t('agentCatalog.dependency.connector.remove')}
                      </Button>
                    </Flexbox>
                  ) : null}
                </Flexbox>
              ))
            )}
            {editable ? (
              <Flexbox gap={8}>
                <Select
                  aria-label={t('agentCatalog.dependency.connector.add')}
                  disabled={!connectorsListUsable}
                  options={connectorOptions}
                  value={connectorId}
                  placeholder={
                    connectors.isLoading
                      ? t('agentCatalog.dependency.loading')
                      : t('agentCatalog.dependency.connector.add')
                  }
                  onChange={(value) => {
                    // Never mutate the selection from a stale/errored/revalidating connector list.
                    if (!connectorsListUsable) return;
                    setConnectorId(value as string | undefined);
                  }}
                />
                {connectors.isValidating && connectors.data ? (
                  <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>
                ) : null}
                {connectorId ? (
                  connectorDetail.error ? (
                    <Alert
                      showIcon
                      action={retry(connectorDetail.mutate)}
                      message={t('agentCatalog.dependency.connector.loadError')}
                      type="error"
                    />
                  ) : connectorDetail.isLoading ? (
                    <Text type="secondary">{t('agentCatalog.dependency.loading')}</Text>
                  ) : connectorDetail.data === null ? (
                    <Alert
                      showIcon
                      message={t('agentCatalog.dependency.connector.unresolvable')}
                      type="warning"
                    />
                  ) : connectorDetail.data ? (
                    <Flexbox horizontal align="center" gap={8}>
                      <Text type="secondary">
                        {t('agentCatalog.dependency.connector.toolsAvailable', {
                          count: allowedConnectorToolKeys(connectorDetail.data).length,
                        })}
                      </Text>
                      {/* Add is disabled while the detail is revalidating — never author from a stale snapshot. */}
                      <Button
                        disabled={!connectorDetailUsable}
                        type="primary"
                        onClick={addConnector}
                      >
                        {t('agentCatalog.dependency.connector.addAction')}
                      </Button>
                      {connectorDetail.isValidating ? (
                        <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>
                      ) : null}
                    </Flexbox>
                  ) : null
                ) : null}
              </Flexbox>
            ) : null}
          </Flexbox>
        )}
      </Flexbox>
    </Flexbox>
  );
};
