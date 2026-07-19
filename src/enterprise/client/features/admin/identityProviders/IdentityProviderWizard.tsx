'use client';

import {
  GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE,
  type PlatformIdentityProviderDraft,
} from '@lobechat/types';
import { Alert, Flexbox, Input, Tag, Text, TextArea } from '@lobehub/ui';
import { Button, Checkbox, Select, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { openReasonModal } from '../users/modals/openReasonModal';
import { parseIdentityProviderJsonObject } from './controller';
import {
  useIdentityProviderRevisionHistory,
  useIdentityProviderTestResult,
} from './useIdentityProviders';

const styles = createStaticStyles(({ css }) => ({
  callback: css`
    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;

    background: ${cssVar.colorFillQuaternary};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  form: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;

    @media (width <= 760px) {
      grid-template-columns: 1fr;
    }
  `,
  full: css`
    grid-column: 1 / -1;
  `,
  navigation: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;

    padding-block-end: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    padding: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

const STEPS = ['basic', 'discovery', 'client', 'claims', 'policy', 'test', 'publish'] as const;
type Step = (typeof STEPS)[number];

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

const createEmptyDraft = (): EditableDraft => ({
  autoProvision: true,
  buttonLabel: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.buttonLabel,
  claimMapping: structuredClone(GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping),
  clientId: '',
  displayName: '',
  domainAllowlist: [],
  groupRoleMapping: {},
  icon: null,
  issuer: '',
  providerKey: '',
  scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
  type: 'generic_oidc',
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
  onSaved: () => Promise<unknown>;
  provider?: PlatformIdentityProviderDraft;
}

const IdentityProviderWizard = memo<IdentityProviderWizardProps>(
  ({ authMethod, callbacks, canCreate, canPublish, canTest, canUpdate, provider, onSaved }) => {
    const { t } = useTranslation('admin');
    const [step, setStep] = useState<Step>('basic');
    const [draft, setDraft] = useState<EditableDraft>(() =>
      provider ? fromProvider(provider) : createEmptyDraft(),
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
    const baseline = useMemo(
      () => JSON.stringify(provider ? fromProvider(provider) : createEmptyDraft()),
      [provider],
    );
    const invalidJson = jsonErrors.claims || jsonErrors.groups;
    const dirty = JSON.stringify(draft) !== baseline || Boolean(secret) || clearSecret;

    const patch = <Key extends keyof EditableDraft>(key: Key, value: EditableDraft[Key]) =>
      setDraft((current) => ({ ...current, [key]: value }));

    const run = async (name: string, action: () => Promise<void>, propagate = true) => {
      setBusy(name);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (propagate) throw cause;
      } finally {
        setBusy(null);
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
            const result = await adminIdentityProvidersService.testStart({
              expectedRevision: provider.revision,
              id: provider.id,
              reason: (payload as { reason: string }).reason,
            });
            const popup = window.open(
              result.authorizationUrl,
              'oidc-provider-test',
              'width=520,height=720',
            );
            if (!popup) throw new Error(t('identityProviders.test.popupBlocked'));
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
                  <Button
                    type={draft.type === 'generic_oidc' ? 'primary' : 'default'}
                    onClick={() => patch('type', 'generic_oidc')}
                  >
                    OIDC
                  </Button>
                  <Button
                    type={draft.type === 'authentik' ? 'primary' : 'default'}
                    onClick={() => patch('type', 'authentik')}
                  >
                    Authentik
                  </Button>
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
                  placeholder="https://id.example.com/application/o/app/"
                  value={draft.issuer}
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
                <div className={styles.callback}>
                  {discovery.authorizationEndpoint}
                  <br />
                  {discovery.tokenEndpoint}
                  <br />
                  {discovery.jwksUri}
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
                  {t('identityProviders.secret.fingerprint', {
                    fingerprint: provider.secret.fingerprint?.slice(0, 12),
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
              <div className={styles.callback}>{callbacks?.production ?? '—'}</div>
              <Text>{t('identityProviders.callback.test')}</Text>
              <div className={styles.callback}>{callbacks?.test ?? '—'}</div>
              <Text type="secondary">PKCE S256 · {draft.scopes.join(' ')}</Text>
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
                    status: testResult.data.status,
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
                <div className={styles.callback}>
                  {JSON.stringify(testResult.data.result, null, 2)}
                </div>
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
            </Flexbox>
          );
        }
      }
    };

    return (
      <div className={styles.panel} data-testid="identity-provider-wizard">
        <div className={styles.navigation}>
          {STEPS.map((item, index) => (
            <Button
              key={item}
              type={item === step ? 'primary' : 'default'}
              onClick={() => setStep(item)}
            >
              {index + 1}. {t(`identityProviders.steps.${item}` as never)}
            </Button>
          ))}
        </div>
        {provider ? (
          <Flexbox horizontal gap={8}>
            <Tag>{provider.status}</Tag>
            <Text type="secondary">
              rev {provider.revision}
              {dirty ? ` · ${t('identityProviders.unsaved')}` : ''}
            </Text>
          </Flexbox>
        ) : null}
        {error ? <Alert showIcon description={error} type="error" /> : null}
        {renderStep()}
        <Flexbox horizontal justify="space-between">
          <Button
            disabled={step === STEPS[0]}
            onClick={() => setStep(STEPS[Math.max(0, STEPS.indexOf(step) - 1)])}
          >
            {t('identityProviders.actions.previous')}
          </Button>
          <Flexbox horizontal gap={8}>
            <Button
              disabled={invalidJson || (provider ? !canUpdate : !canCreate)}
              loading={busy === 'save'}
              type="primary"
              onClick={save}
            >
              {t('identityProviders.actions.save')}
            </Button>
            <Button
              disabled={invalidJson || step === STEPS.at(-1)}
              onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(step) + 1)])}
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
