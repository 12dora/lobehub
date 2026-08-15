'use client';

import type { FormGroupItemType, FormItemProps } from '@lobehub/ui';
import { Alert, Flexbox, Form, Input, InputNumber, Text, TextArea } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import EmojiPicker from '@/components/EmojiPicker';
import { DEFAULT_AVATAR } from '@/const/meta';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import BackgroundSwatches from '@/features/AgentSetting/AgentMeta/BackgroundSwatches';

import { DependencyEditor } from './DependencyEditor';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';
import { AGENT_KEY_MAX_LENGTH, useAgentEditorForm } from './useAgentEditorForm';

const styles = createStaticStyles(({ css }) => ({
  /** The one scrolling region: only the form fields move, never the footer. */
  body: css`
    overflow-y: auto;
    flex: 1 1 auto;

    min-height: 0;
    padding-block: 12px;
    padding-inline: 16px;
  `,
  footer: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
  `,
  /** Pinned below the scroll region: status first, then the actions. Never scrolls out of reach. */
  footerRegion: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  footerActions: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  keyError: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorError};
  `,
  root: css`
    overflow: hidden;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;

    min-height: 0;
  `,
  status: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding-block: 12px 0;
    padding-inline: 16px;
  `,
}));

const FULL_WIDTH = { style: { maxWidth: '100%', width: '100%' } };

/** Model parameters are optional: an empty box means "follow the model default". */
interface ParamRow {
  key: 'temperature' | 'topP' | 'presencePenalty' | 'frequencyPenalty' | 'maxTokens';
  max: number;
  min: number;
  step: number;
}

const PARAM_ROWS: ParamRow[] = [
  { key: 'temperature', max: 2, min: 0, step: 0.1 },
  { key: 'topP', max: 1, min: 0, step: 0.01 },
  { key: 'presencePenalty', max: 2, min: -2, step: 0.1 },
  { key: 'frequencyPenalty', max: 2, min: -2, step: 0.1 },
  { key: 'maxTokens', max: 10_000_000, min: 1, step: 1 },
];

export interface AgentEditorFormProps {
  /** Present → edit mode; absent → create mode. */
  agent?: AdminAgentDetailOutput;
  authMethod?: AdminReauthAuthMethod | null;
  dirtyRef?: { current: boolean };
  /** Explicit dismissal — guarded by the host when input is unsaved. Defaults to `onClose`. */
  onCancel?: () => void;
  /** Unconditional close, used once the write has committed. */
  onClose?: () => void;
  onSaved?: (output: AdminPlatformAgentSaveOutput, created: boolean) => Promise<void> | void;
  /** Set by the hook while a write is in flight so the host can veto dismissal. */
  pendingRef?: { current: boolean };
}

export const AgentEditorForm = memo<AgentEditorFormProps>(
  ({ agent, authMethod, dirtyRef, onCancel, onClose, onSaved, pendingRef }) => {
    const { t } = useTranslation('admin');
    const form = useAgentEditorForm({
      agent,
      authMethod,
      dirtyRef,
      onClose,
      onSaved,
      pendingRef,
    });
    const { config } = form.value;
    const background = config.backgroundColor ?? undefined;
    const blockers = form.depValidity.blockers;
    // Saving republishes an archived assistant, so say so instead of letting it happen silently.
    const archived = agent?.identity.status === 'archived';

    const keyInvalid = form.isCreate && form.agentKey.length > 0 && !form.keyValid;

    const basicItems: FormItemProps[] = [
      {
        // One identity row, like `AgentSetting/AgentMeta`: the swatch strip reads as the avatar's
        // background instead of an unrelated second field.
        children: (
          <Flexbox horizontal align={'center'} gap={16} wrap={'wrap'}>
            <EmojiPicker
              background={background}
              size={48}
              // Display-only fallback: an unset avatar must not render as the text "NU"
              // (`String(null)`); the platform default stays out of the persisted config.
              value={config.avatar ?? DEFAULT_AVATAR}
              onChange={(next: string) => form.patchConfig('avatar', next || null)}
            />
            <BackgroundSwatches
              value={background}
              onChange={(next) => form.patchConfig('backgroundColor', next || null)}
            />
          </Flexbox>
        ),
        label: t('agentCatalog.editor.avatarBackground'),
        layout: 'horizontal',
        minWidth: undefined,
      },
      {
        children: (
          <Input
            aria-label={t('agentCatalog.editor.name')}
            placeholder={t('agentCatalog.editor.namePlaceholder')}
            value={config.displayName}
            onChange={(event) => form.setDisplayName(event.target.value)}
          />
        ),
        label: t('agentCatalog.editor.name'),
      },
      {
        children: (
          <TextArea
            aria-label={t('agentCatalog.editor.description')}
            placeholder={t('agentCatalog.editor.descriptionPlaceholder')}
            rows={2}
            value={config.description ?? ''}
            onChange={(event) => form.patchConfig('description', event.target.value || null)}
          />
        ),
        label: t('agentCatalog.editor.description'),
      },
      {
        children: (
          <Flexbox gap={4}>
            <Input
              aria-label={t('agentCatalog.editor.key')}
              disabled={!form.isCreate}
              maxLength={AGENT_KEY_MAX_LENGTH}
              placeholder={'research-assistant'}
              value={form.agentKey}
              onChange={(event) => form.changeAgentKey(event.target.value)}
            />
            {keyInvalid ? (
              <span className={styles.keyError} role={'alert'}>
                {t('agentCatalog.editor.keyInvalid', { max: AGENT_KEY_MAX_LENGTH })}
              </span>
            ) : null}
          </Flexbox>
        ),
        desc: form.isCreate
          ? t('agentCatalog.editor.keyDesc')
          : t('agentCatalog.editor.keyLockedDesc'),
        label: t('agentCatalog.editor.key'),
      },
    ];

    const moreItems = (skills: ReactNode, connectors: ReactNode): FormItemProps[] => [
      {
        children: (
          <Select
            allowClear
            aria-label={t('agentCatalog.editor.tags')}
            mode={'tags'}
            options={config.tags.map((tag) => ({ label: tag, value: tag }))}
            placeholder={t('agentCatalog.editor.tagsPlaceholder')}
            tokenSeparators={[',']}
            value={config.tags}
            onChange={(next) =>
              form.patchConfig('tags', Array.isArray(next) ? next : next ? [next] : [])
            }
          />
        ),
        label: t('agentCatalog.editor.tags'),
        layout: 'vertical',
        wrapperCol: FULL_WIDTH,
      },
      {
        children: (
          <TextArea
            aria-label={t('agentCatalog.editor.openingMessage')}
            placeholder={t('agentCatalog.editor.openingMessagePlaceholder')}
            rows={2}
            value={config.openingMessage ?? ''}
            onChange={(event) => form.patchConfig('openingMessage', event.target.value || null)}
          />
        ),
        label: t('agentCatalog.editor.openingMessage'),
        layout: 'vertical',
        wrapperCol: FULL_WIDTH,
      },
      {
        children: (
          <TextArea
            aria-label={t('agentCatalog.editor.openingQuestions')}
            placeholder={t('agentCatalog.editor.openingQuestionsPlaceholder')}
            rows={3}
            value={config.openingQuestions.join('\n')}
            onChange={(event) =>
              form.patchConfig('openingQuestions', event.target.value.split('\n'))
            }
          />
        ),
        desc: t('agentCatalog.editor.openingQuestionsDesc'),
        label: t('agentCatalog.editor.openingQuestions'),
        layout: 'vertical',
        wrapperCol: FULL_WIDTH,
      },
      { children: skills, layout: 'vertical', wrapperCol: FULL_WIDTH },
      { children: connectors, layout: 'vertical', wrapperCol: FULL_WIDTH },
    ];

    const paramItems: FormItemProps[] = PARAM_ROWS.map(({ key, max, min, step }) => ({
      children: (
        <InputNumber
          aria-label={t(`agentCatalog.editor.param.${key}` as never)}
          max={max}
          min={min}
          placeholder={t('agentCatalog.editor.paramDefault')}
          step={step}
          style={{ width: 160 }}
          value={config.modelParameters[key]}
          onChange={(next) =>
            form.patchConfig('modelParameters', {
              ...config.modelParameters,
              [key]: typeof next === 'number' ? next : undefined,
            })
          }
        />
      ),
      label: t(`agentCatalog.editor.param.${key}` as never),
    }));

    return (
      <div className={styles.root}>
        <div className={styles.body}>
          <DependencyEditor
            editable
            enabled
            agentId={agent?.identity.id ?? 'new-platform-agent'}
            dependencies={form.value.dependencies}
            onChange={form.setDependencies}
            onValidityChange={form.setDepValidity}
          >
            {(slots) => (
              <Form
                gap={16}
                itemsType={'group'}
                variant={'borderless'}
                items={
                  [
                    { children: basicItems, title: t('agentCatalog.editor.section.basic') },
                    {
                      children: (
                        <TextArea
                          aria-label={t('agentCatalog.editor.systemRole')}
                          autoSize={{ maxRows: 24, minRows: 10 }}
                          placeholder={t('agentCatalog.editor.systemRolePlaceholder')}
                          value={config.systemRole}
                          onChange={(event) => form.patchConfig('systemRole', event.target.value)}
                        />
                      ),
                      desc: t('agentCatalog.editor.systemRoleDesc'),
                      title: t('agentCatalog.editor.section.prompt'),
                    },
                    {
                      children: (
                        <Flexbox gap={12}>
                          {slots.model}
                          {form.depValidity.issues.length > 0 ? (
                            <Alert
                              showIcon
                              type={'warning'}
                              message={form.depValidity.issues
                                .map((issue) => t(issue as never))
                                .join(' · ')}
                            />
                          ) : null}
                        </Flexbox>
                      ),
                      title: t('agentCatalog.editor.section.model'),
                    },
                    {
                      children: paramItems,
                      collapsible: true,
                      defaultActive: false,
                      desc: t('agentCatalog.editor.section.paramsDesc'),
                      title: t('agentCatalog.editor.section.params'),
                    },
                    {
                      children: moreItems(slots.skills, slots.connectors),
                      collapsible: true,
                      defaultActive: false,
                      title: t('agentCatalog.editor.section.more'),
                    },
                  ] as FormGroupItemType[]
                }
              />
            )}
          </DependencyEditor>
        </div>

        <div className={styles.footerRegion}>
          {form.conflict || form.error || blockers.length > 0 ? (
            <div className={styles.status}>
              {form.conflict ? (
                <Alert
                  showIcon
                  message={t('agentCatalog.editor.conflict')}
                  role={'alert'}
                  type={'error'}
                />
              ) : null}
              {form.error ? (
                <Text role={'alert'} type={'danger'}>
                  {form.error}
                </Text>
              ) : null}
              {/* Why Save is unavailable, next to Save — the catalog that is blocking it may live
                  in a collapsed group the admin never opened. */}
              {blockers.map((blocker) => (
                <Alert
                  showIcon
                  key={blocker.message}
                  message={t(blocker.message as never)}
                  role={'status'}
                  type={'warning'}
                  action={
                    blocker.retry ? (
                      <Button size={'small'} onClick={() => void blocker.retry?.()}>
                        {t('agentCatalog.dependency.retry')}
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          ) : null}

          <div className={styles.footer}>
            <span className={styles.hint}>
              {t(
                archived
                  ? 'agentCatalog.editor.effectHintArchived'
                  : 'agentCatalog.editor.effectHint',
              )}
            </span>
            <div className={styles.footerActions}>
              <Button disabled={form.saving} onClick={onCancel ?? onClose}>
                {t('agentCatalog.editor.cancel')}
              </Button>
              <Button
                disabled={!form.canSubmit}
                type={'primary'}
                onClick={() => void form.submit()}
              >
                {form.saving ? t('agentCatalog.editor.saving') : t('agentCatalog.editor.save')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

AgentEditorForm.displayName = 'AgentEditorForm';
