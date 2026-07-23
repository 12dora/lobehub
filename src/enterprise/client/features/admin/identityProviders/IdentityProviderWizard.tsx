'use client';

import { DEFAULT_IDP_BUTTON_LABEL, type PlatformIdentityProviderDraft } from '@lobechat/types';
import { Alert, copyToClipboard, Flexbox, Input, Tag, Text, TextArea } from '@lobehub/ui';
import { Button, Checkbox, Select, toast } from '@lobehub/ui/base-ui';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { openReasonModal } from '../users/modals/openReasonModal';
import {
  AUTHENTIK_ISSUER_PLACEHOLDER,
  type IdentityProviderCreateDraftSeed,
  IdentityProviderTestPopupBlockedError,
  openIdentityProviderTestPopup,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRevisionRefresh,
} from './controller';
import { IdentityProviderConflictAlert } from './IdentityProviderConflictAlert';
import {
  IDENTITY_PROVIDER_STEPS,
  type IdentityProviderStep,
  type IdentityProviderStepState,
  IdentityProviderWizardNavigation,
} from './IdentityProviderWizardNavigation';
import { identityProviderStyles as styles } from './styles';
import {
  useIdentityProviderRevisionHistory,
  useIdentityProviderTestResult,
} from './useIdentityProviders';
import { useUnsavedIdentityProviderGuard } from './useUnsavedIdentityProviderGuard';

type EditableDraft = {
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderDraft['claimMapping'];
  clientId: string;
  displayName: string;
  domainAllowlist: string[];
  groupRoleMapping: Record<string, string>;
  icon: string | null;
  issuer: string;
  providerKey: string;
  scopes: string[];
  type: 'authentik' | 'generic_oidc';
  usePkce: true;
};

const fromSeed = (seed: IdentityProviderCreateDraftSeed): EditableDraft => ({
  autoProvision: true,
  buttonLabel: seed.buttonLabel,
  claimMapping: structuredClone(seed.claimMapping),
  clientId: '',
  displayName: '',
  domainAllowlist: [],
  groupRoleMapping: {},
  icon: null,
  issuer: '',
  providerKey: '',
  scopes: [...seed.scopes],
  type: seed.type,
  usePkce: true,
});

const fromProvider = (provider: PlatformIdentityProviderDraft): EditableDraft => ({
  autoProvision: provider.autoProvision,
  buttonLabel: provider.buttonLabel,
  claimMapping: structuredClone(provider.claimMapping),
  clientId: provider.clientId ?? '',
  displayName: provider.displayName,
  domainAllowlist: [...provider.domainAllowlist],
  groupRoleMapping: structuredClone(provider.groupRoleMapping),
  icon: provider.icon,
  issuer: provider.issuer ?? '',
  providerKey: provider.providerKey,
  scopes: [...provider.scopes],
  type: provider.type,
  usePkce: true,
});

interface IdentityProviderWizardProps {
  authMethod: AdminReauthAuthMethod;
  callbacks?: { production: string; test: string };
  canCreate: boolean;
  canPublish: boolean;
  canTest: boolean;
  canUpdate: boolean;
  /** Prefill when creating from a type template. */
  createSeed?: IdentityProviderCreateDraftSeed;
  /** Drop the card chrome when hosted inside a modal. */
  embedded?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDiscard: () => void;
  onRefresh: () => Promise<unknown>;
  onSaved: () => Promise<unknown>;
  provider?: PlatformIdentityProviderDraft;
}

const IdentityProviderWizard = memo<IdentityProviderWizardProps>(
  ({
    authMethod,
    callbacks,
    canCreate,
    canPublish,
    canTest,
    canUpdate,
    createSeed,
    embedded,
    provider,
    onDirtyChange,
    onDiscard,
    onRefresh,
    onSaved,
  }) => {
    const { t } = useTranslation('admin');
    const [step, setStep] = useState<IdentityProviderStep>('basic');
    const [draft, setDraft] = useState<EditableDraft>(() =>
      provider
        ? fromProvider(provider)
        : createSeed
          ? fromSeed(createSeed)
          : fromSeed({
              buttonLabel: DEFAULT_IDP_BUTTON_LABEL,
              claimMapping: {
                dingtalkTitle: [],
                dingtalkUserId: [],
                email: ['email'],
                name: ['name', 'preferred_username'],
                picture: ['picture'],
                subject: ['sub'],
              },
              scopes: ['openid', 'profile', 'email'],
              type: 'generic_oidc',
              usePkce: true,
            }),
    );
    const [claimJson, setClaimJson] = useState(() => JSON.stringify(draft.claimMapping, null, 2));
    const [groupRoleJson, setGroupRoleJson] = useState(() =>
      JSON.stringify(draft.groupRoleMapping, null, 2),
    );
    const [jsonErrors, setJsonErrors] = useState({ claims: false, groups: false });
    const [secret, setSecret] = useState('');
    const [clearSecret, setClearSecret] = useState(false);
    const [discovery, setDiscovery] = useState<Awaited<
      ReturnType<typeof adminIdentityProvidersService.discover>
    > | null>(null);
    const [networkValid, setNetworkValid] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState<{ id: string; startedAt: number } | null>(null);
    const [testPolling, setTestPolling] = useState(false);
    const testResult = useIdentityProviderTestResult(attempt?.id ?? null, testPolling, () =>
      setTestPolling(false),
    );
    const revisions = useIdentityProviderRevisionHistory(
      provider?.id,
      Boolean(provider && canPublish),
    );
    const [rollbackTarget, setRollbackTarget] = useState<number | undefined>(undefined);
    const [conflict, setConflict] = useState(false);
    const [conflictRefreshFailed, setConflictRefreshFailed] = useState(false);
    const lastProviderRevisionRef = useRef(provider?.revision);
    const preserveDraftOnRefreshRef = useRef(false);
    const baseline = useMemo(
      () =>
        JSON.stringify(
          provider ? fromProvider(provider) : createSeed ? fromSeed(createSeed) : draft,
        ),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- baseline is fixed at mount via key remount
      [provider, createSeed],
    );
    const invalidJson = jsonErrors.claims || jsonErrors.groups;
    const dirty = JSON.stringify(draft) !== baseline || Boolean(secret) || clearSecret;

    useEffect(() => {
      const refresh = resolveIdentityProviderRevisionRefresh({
        currentRevision: lastProviderRevisionRef.current,
        nextRevision: provider?.revision,
        preserveDraft: preserveDraftOnRefreshRef.current,
      });
      if (!provider || refresh === 'unchanged') return;
      lastProviderRevisionRef.current = provider.revision;
      if (refresh === 'preserve') {
        preserveDraftOnRefreshRef.current = false;
        return;
      }
      const refreshed = fromProvider(provider);
      setDraft(refreshed);
      setClaimJson(JSON.stringify(refreshed.claimMapping, null, 2));
      setGroupRoleJson(JSON.stringify(refreshed.groupRoleMapping, null, 2));
      setJsonErrors({ claims: false, groups: false });
      setSecret('');
      setClearSecret(false);
    }, [provider]);

    useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
    useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

    useUnsavedIdentityProviderGuard(dirty);

    useEffect(() => {
      if (!attempt || !testPolling) return;
      const remaining = Math.max(0, 120_000 - (Date.now() - attempt.startedAt));
      const timeout = window.setTimeout(() => setTestPolling(false), remaining);
      return () => window.clearTimeout(timeout);
    }, [attempt, testPolling]);

    const patch = <Key extends keyof EditableDraft>(key: Key, value: EditableDraft[Key]) =>
      setDraft((current) => ({ ...current, [key]: value }));

    const friendlyError = (cause: unknown): string => {
      if (cause instanceof IdentityProviderTestPopupBlockedError) {
        return t('identityProviders.test.popupBlocked');
      }
      if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
        return t('identityProviders.conflict.description');
      }
      return t('identityProviders.errors.generic');
    };

    const refreshConflict = async () => {
      setConflictRefreshFailed(false);
      try {
        await onRefresh();
      } catch {
        setConflictRefreshFailed(true);
      }
    };

    const run = async (name: string, action: () => Promise<void>, propagate = true) => {
      setBusy(name);
      setError(null);
      try {
        await action();
      } catch (cause) {
        if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
          setConflict(true);
          preserveDraftOnRefreshRef.current = true;
          await refreshConflict();
        }
        setError(friendlyError(cause));
        if (propagate) throw cause;
      } finally {
        setBusy(null);
      }
    };

    const copyUrl = async (url: string) => {
      if (!url) return;
      try {
        await copyToClipboard(url);
        toast.success(t('identityProviders.callback.copied'));
      } catch {
        toast.error(t('identityProviders.callback.copyFailed'));
      }
    };

    const save = () => {
      if (
        invalidJson ||
        !draft.displayName.trim() ||
        !draft.providerKey.trim() ||
        !draft.issuer ||
        !draft.clientId
      ) {
        setError(t('identityProviders.errors.required'));
        return;
      }
      openReasonModal({
        buildPayload: (reason) => ({ reason }),
        description: t('identityProviders.save.description'),
        onSubmit: async (payload) => {
          const { reason } = payload as { reason: string };
          await run('save', async () => {
            const secretMutation = clearSecret
              ? ({ operation: 'clear' } as const)
              : secret
                ? ({ operation: 'replace', value: secret } as const)
                : ({ operation: 'keep' } as const);
            if (provider) {
              await adminIdentityProvidersService.update({
                ...draft,
                expectedRevision: provider.revision,
                id: provider.id,
                reason,
                secret: secretMutation,
              });
            } else {
              await adminIdentityProvidersService.create({
                ...draft,
                reason,
                secret:
                  secretMutation.operation === 'keep' ? { operation: 'clear' } : secretMutation,
              });
            }
            setSecret('');
            setClearSecret(false);
            setConflict(false);
            await onSaved();
            toast.success(t('identityProviders.save.success'));
          });
        },
        submitLabel: t('identityProviders.actions.save'),
        targetLabel: draft.displayName || draft.providerKey || t('identityProviders.newProvider'),
        title: t('identityProviders.save.title'),
      });
    };

    const discover = () =>
      void run(
        'discover',
        async () => {
          const [metadata] = await Promise.all([
            adminIdentityProvidersService.discover({ issuer: draft.issuer }),
            adminIdentityProvidersService.validateNetwork({ issuer: draft.issuer }),
          ]);
          setDiscovery(metadata);
          setNetworkValid(true);
        },
        false,
      );

    const startTest = () => {
      if (!provider) return;
      openReasonModal({
        authMethod,
        buildPayload: (reason) => ({ reason }),
        onSubmit: async (payload) =>
          run('test', async () => {
            const result = await openIdentityProviderTestPopup(() =>
              adminIdentityProvidersService.testStart({
                expectedRevision: provider.revision,
                id: provider.id,
                reason: (payload as { reason: string }).reason,
              }),
            );
            setAttempt({ id: result.attemptId, startedAt: Date.now() });
            setTestPolling(true);
          }),
        submitLabel: t('identityProviders.actions.startTest'),
        targetLabel: provider.displayName,
        title: t('identityProviders.test.title'),
      });
    };

    const publish = (rollback = false) => {
      if (!provider) return;
      if (rollback && !rollbackTarget) {
        setError(t('identityProviders.rollback.targetRequired'));
        return;
      }
      openReasonModal({
        authMethod,
        buildPayload: (reason) => ({ reason }),
        danger: rollback,
        impact: t(
          rollback ? 'identityProviders.rollback.impact' : 'identityProviders.publish.impact',
        ),
        onSubmit: async (payload) =>
          run(rollback ? 'rollback' : 'publish', async () => {
            const common = {
              expectedRevision: provider.revision,
              id: provider.id,
              reason: (payload as { reason: string }).reason,
              requestId: crypto.randomUUID(),
            };
            if (rollback) {
              await adminIdentityProvidersService.rollback({
                ...common,
                targetRevision: rollbackTarget!,
              });
            } else {
              await adminIdentityProvidersService.publish(common);
            }
            await onSaved();
            toast.success(
              t(
                rollback
                  ? 'identityProviders.rollback.success'
                  : 'identityProviders.publish.success',
              ),
            );
          }),
        submitLabel: t(
          rollback ? 'identityProviders.actions.rollback' : 'identityProviders.actions.publish',
        ),
        targetLabel: provider.displayName,
        title: t(rollback ? 'identityProviders.rollback.title' : 'identityProviders.publish.title'),
      });
    };

    const navigateStep = (offset: -1 | 1) => {
      const nextIndex = Math.min(
        IDENTITY_PROVIDER_STEPS.length - 1,
        Math.max(0, IDENTITY_PROVIDER_STEPS.indexOf(step) + offset),
      );
      setStep(IDENTITY_PROVIDER_STEPS[nextIndex]);
    };

    const stepStates = useMemo((): Partial<
      Record<IdentityProviderStep, IdentityProviderStepState>
    > => {
      const basicComplete = Boolean(draft.displayName.trim() && draft.providerKey.trim());
      const discoveryComplete = Boolean(draft.issuer && networkValid && discovery);
      const clientComplete = Boolean(draft.clientId && (secret || provider?.secret.configured));
      const claimsComplete = !jsonErrors.claims;
      const policyComplete = !jsonErrors.groups;
      const testComplete =
        testResult.data?.status === 'succeeded' && Boolean(testResult.data.result?.valid);
      return {
        basic: basicComplete ? 'complete' : 'pending',
        claims: jsonErrors.claims ? 'error' : claimsComplete ? 'complete' : 'pending',
        client: clientComplete ? 'complete' : 'pending',
        discovery: discoveryComplete ? 'complete' : 'pending',
        policy: jsonErrors.groups ? 'error' : policyComplete ? 'complete' : 'pending',
        publish:
          provider?.status === 'published' ||
          provider?.status === 'active' ||
          provider?.status === 'pending_restart'
            ? 'complete'
            : 'pending',
        test: testComplete
          ? 'complete'
          : testResult.data?.status === 'failed'
            ? 'error'
            : 'pending',
      };
    }, [
      discovery,
      draft.clientId,
      draft.displayName,
      draft.issuer,
      draft.providerKey,
      jsonErrors.claims,
      jsonErrors.groups,
      networkValid,
      provider?.secret.configured,
      provider?.status,
      secret,
      testResult.data,
    ]);

    const renderStep = () => {
      switch (step) {
        case 'basic': {
          return (
            <div className={styles.form}>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.displayName')}</Text>
                <Input
                  value={draft.displayName}
                  onChange={(e) => patch('displayName', e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.providerKey')}</Text>
                <Input
                  disabled={Boolean(provider)}
                  value={draft.providerKey}
                  onChange={(e) => patch('providerKey', e.target.value.toLowerCase())}
                />
              </label>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.buttonLabel')}</Text>
                <Input
                  value={draft.buttonLabel}
                  onChange={(e) => patch('buttonLabel', e.target.value)}
                />
              </label>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.icon')}</Text>
                <Input
                  placeholder="https://…"
                  value={draft.icon ?? ''}
                  onChange={(e) => patch('icon', e.target.value || null)}
                />
              </label>
              <div className={`${styles.field} ${styles.full}`}>
                <Text>{t('identityProviders.fields.type')}</Text>
                <Flexbox horizontal gap={8}>
                  <Tag color={draft.type === 'authentik' ? 'blue' : 'default'}>
                    {draft.type === 'authentik'
                      ? 'Authentik'
                      : t('identityProviders.templates.genericOidc.label')}
                  </Tag>
                  <Text type="secondary">{t('identityProviders.fields.typeLocked')}</Text>
                </Flexbox>
              </div>
            </div>
          );
        }
        case 'discovery': {
          return (
            <Flexbox gap={12}>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.issuer')}</Text>
                <Input
                  value={draft.issuer}
                  placeholder={
                    draft.type === 'authentik'
                      ? AUTHENTIK_ISSUER_PLACEHOLDER
                      : 'https://id.example.com/application/o/app/'
                  }
                  onChange={(e) => {
                    patch('issuer', e.target.value);
                    setNetworkValid(false);
                    setDiscovery(null);
                  }}
                />
              </label>
              <Button
                disabled={!canTest || !draft.issuer}
                loading={busy === 'discover'}
                onClick={discover}
              >
                {t('identityProviders.actions.discover')}
              </Button>
              {networkValid ? (
                <Alert
                  showIcon
                  description={t('identityProviders.discovery.valid')}
                  type="success"
                />
              ) : null}
              {discovery ? (
                <div className={styles.discoveryGrid}>
                  <Text strong>{t('identityProviders.discovery.endpoints')}</Text>
                  {(
                    [
                      ['authorization', discovery.authorizationEndpoint],
                      ['token', discovery.tokenEndpoint],
                      ['jwks', discovery.jwksUri],
                    ] as const
                  ).map(([key, value]) => (
                    <div className={styles.discoveryRow} key={key}>
                      <Text type="secondary">
                        {t(`identityProviders.discovery.${key}` as never)}
                      </Text>
                      <Text className={styles.endpointValue}>{value}</Text>
                    </div>
                  ))}
                </div>
              ) : null}
            </Flexbox>
          );
        }
        case 'client': {
          return (
            <Flexbox gap={12}>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.clientId')}</Text>
                <Input value={draft.clientId} onChange={(e) => patch('clientId', e.target.value)} />
              </label>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.clientSecret')}</Text>
                <Input
                  autoComplete="new-password"
                  type="password"
                  value={secret}
                  placeholder={
                    provider?.secret.configured ? t('identityProviders.secret.configured') : ''
                  }
                  onChange={(e) => {
                    setSecret(e.target.value);
                    setClearSecret(false);
                  }}
                />
              </label>
              {provider?.secret.configured ? (
                <Text type="secondary">
                  {t('identityProviders.secret.updatedAt', {
                    updatedAt: provider.secret.updatedAt?.toLocaleString() ?? '—',
                  })}
                </Text>
              ) : null}
              <label>
                <Checkbox
                  checked={clearSecret}
                  onChange={(checked) => {
                    setClearSecret(checked);
                    if (checked) setSecret('');
                  }}
                />{' '}
                {t('identityProviders.secret.clear')}
              </label>
              <Text>{t('identityProviders.callback.production')}</Text>
              <div className={styles.callback}>
                <span className={styles.callbackUrl}>{callbacks?.production ?? '—'}</span>
                {callbacks?.production ? (
                  <Button size="small" onClick={() => void copyUrl(callbacks.production)}>
                    {t('identityProviders.callback.copy')}
                  </Button>
                ) : null}
              </div>
              <Text>{t('identityProviders.callback.test')}</Text>
              <div className={styles.callback}>
                <span className={styles.callbackUrl}>{callbacks?.test ?? '—'}</span>
                {callbacks?.test ? (
                  <Button size="small" onClick={() => void copyUrl(callbacks.test)}>
                    {t('identityProviders.callback.copy')}
                  </Button>
                ) : null}
              </div>
            </Flexbox>
          );
        }
        case 'claims': {
          return (
            <label className={styles.field}>
              <Text>{t('identityProviders.fields.claimMapping')}</Text>
              <TextArea
                rows={14}
                value={claimJson}
                onChange={(e) => {
                  const raw = e.target.value;
                  setClaimJson(raw);
                  const parsed = parseIdentityProviderJsonObject(raw);
                  setJsonErrors((current) => ({ ...current, claims: !parsed.valid }));
                  if (parsed.valid)
                    patch('claimMapping', parsed.value as unknown as EditableDraft['claimMapping']);
                }}
              />
              {jsonErrors.claims ? (
                <Text type="danger">{t('identityProviders.errors.invalidJson')}</Text>
              ) : null}
            </label>
          );
        }
        case 'policy': {
          return (
            <Flexbox gap={12}>
              <label>
                <Checkbox
                  checked={draft.autoProvision}
                  onChange={(checked) => patch('autoProvision', checked)}
                />{' '}
                {t('identityProviders.fields.autoProvision')}
              </label>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.domains')}</Text>
                <TextArea
                  rows={4}
                  value={draft.domainAllowlist.join('\n')}
                  onChange={(e) =>
                    patch(
                      'domainAllowlist',
                      e.target.value
                        .split(/[,\n]/)
                        .map((value) => value.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <label className={styles.field}>
                <Text>{t('identityProviders.fields.groupRoles')}</Text>
                <TextArea
                  rows={8}
                  value={groupRoleJson}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setGroupRoleJson(raw);
                    const parsed = parseIdentityProviderJsonObject(raw);
                    setJsonErrors((current) => ({ ...current, groups: !parsed.valid }));
                    if (parsed.valid)
                      patch('groupRoleMapping', parsed.value as EditableDraft['groupRoleMapping']);
                  }}
                />
                {jsonErrors.groups ? (
                  <Text type="danger">{t('identityProviders.errors.invalidJson')}</Text>
                ) : null}
              </label>
            </Flexbox>
          );
        }
        case 'test': {
          return (
            <Flexbox gap={12}>
              <Text>{t('identityProviders.test.description')}</Text>
              <Button
                disabled={!provider || dirty || !canTest}
                loading={busy === 'test'}
                onClick={startTest}
              >
                {t('identityProviders.actions.startTest')}
              </Button>
              {attempt && Date.now() - attempt.startedAt > 120_000 ? (
                <Alert showIcon description={t('identityProviders.test.timeout')} type="warning" />
              ) : null}
              {testResult.data ? (
                <Alert
                  showIcon
                  description={t('identityProviders.test.status', {
                    status: t(
                      `identityProviders.values.testStatus.${testResult.data.status}` as never,
                    ),
                  })}
                  type={
                    testResult.data.status === 'succeeded' && testResult.data.result?.valid
                      ? 'success'
                      : testResult.data.status === 'failed'
                        ? 'error'
                        : 'info'
                  }
                />
              ) : null}
              {testResult.data?.result ? (
                <Flexbox horizontal gap={6} wrap="wrap">
                  {Object.entries(testResult.data.result.claims).map(([claim, summary]) => (
                    <Tag key={claim}>
                      {t('identityProviders.test.claimPresent', {
                        claim,
                        type: t(`identityProviders.values.claimType.${summary.type}` as never),
                      })}
                    </Tag>
                  ))}
                </Flexbox>
              ) : null}
              {testResult.error ? (
                <Alert
                  showIcon
                  description={t('identityProviders.test.resultLoadError')}
                  type="error"
                  action={
                    <Button size="small" onClick={() => void testResult.mutate()}>
                      {t('identityProviders.actions.retry')}
                    </Button>
                  }
                />
              ) : null}
            </Flexbox>
          );
        }
        case 'publish': {
          return (
            <Flexbox gap={12}>
              <Text>{t('identityProviders.publish.description')}</Text>
              <Flexbox horizontal gap={8}>
                <Button
                  disabled={!provider || dirty || !canPublish}
                  loading={busy === 'publish'}
                  type="primary"
                  onClick={() => publish(false)}
                >
                  {t('identityProviders.actions.publish')}
                </Button>
                <Select
                  aria-label={t('identityProviders.rollback.target')}
                  placeholder={t('identityProviders.rollback.target')}
                  style={{ minWidth: 220 }}
                  value={rollbackTarget}
                  options={(revisions.data ?? [])
                    .filter((item) => item.revision !== provider?.activationRevision)
                    .map((item) => ({
                      label: `rev ${item.revision} · ${item.publishedAt.toLocaleString()}`,
                      value: item.revision,
                    }))}
                  onChange={(value) => setRollbackTarget(value as number | undefined)}
                />
                <Button
                  danger
                  loading={busy === 'rollback'}
                  disabled={
                    !provider?.activationRevision || !rollbackTarget || dirty || !canPublish
                  }
                  onClick={() => publish(true)}
                >
                  {t('identityProviders.actions.rollback')}
                </Button>
              </Flexbox>
              {revisions.error ? (
                <Alert
                  showIcon
                  description={t('identityProviders.rollback.historyLoadError')}
                  type="error"
                  action={
                    <Button size="small" onClick={() => void revisions.mutate()}>
                      {t('identityProviders.actions.retry')}
                    </Button>
                  }
                />
              ) : null}
            </Flexbox>
          );
        }
      }
    };

    return (
      <div
        className={embedded ? styles.stack : styles.panel}
        data-testid="identity-provider-wizard"
      >
        <IdentityProviderWizardNavigation stepStates={stepStates} value={step} onChange={setStep} />
        {provider ? (
          <Flexbox horizontal align="center" gap={8}>
            <Tag>{t(`identityProviders.values.providerStatus.${provider.status}` as never)}</Tag>
            {dirty ? <Text type="secondary">{t('identityProviders.unsaved')}</Text> : null}
          </Flexbox>
        ) : (
          <Text type="secondary">
            {t('identityProviders.newProvider')} ·{' '}
            {draft.type === 'authentik'
              ? 'Authentik'
              : t('identityProviders.templates.genericOidc.label')}
          </Text>
        )}
        {error ? <Alert showIcon description={error} type="error" /> : null}
        {conflict ? (
          <IdentityProviderConflictAlert
            refreshFailed={conflictRefreshFailed}
            onDiscard={onDiscard}
            onRefresh={refreshConflict}
          />
        ) : null}
        {renderStep()}
        <Flexbox horizontal justify="space-between">
          <Button disabled={step === IDENTITY_PROVIDER_STEPS[0]} onClick={() => navigateStep(-1)}>
            {t('identityProviders.actions.previous')}
          </Button>
          <Flexbox horizontal gap={8}>
            <Button
              loading={busy === 'save'}
              type="primary"
              disabled={
                invalidJson || conflictRefreshFailed || (provider ? !canUpdate : !canCreate)
              }
              onClick={save}
            >
              {t('identityProviders.actions.save')}
            </Button>
            <Button
              disabled={invalidJson || step === IDENTITY_PROVIDER_STEPS.at(-1)}
              onClick={() => navigateStep(1)}
            >
              {t('identityProviders.actions.next')}
            </Button>
          </Flexbox>
        </Flexbox>
      </div>
    );
  },
);

IdentityProviderWizard.displayName = 'IdentityProviderWizard';
export default IdentityProviderWizard;
