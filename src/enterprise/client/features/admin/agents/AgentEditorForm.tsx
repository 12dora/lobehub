'use client';

import { Alert, Text } from '@lobehub/ui';
import { Button, FormGroup, Input, InputNumber, Select, TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import EmojiPicker from '@/components/EmojiPicker';
import { DEFAULT_AVATAR } from '@/const/meta';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import BackgroundSwatches from '@/features/AgentSetting/AgentMeta/BackgroundSwatches';

import { AssignmentPolicySection } from './AssignmentPolicySection';
import { DependencyEditor } from './DependencyEditor';
import { FieldLabel, HelpTooltip } from './dependencyEditorShared';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';
import type { AgentEditorSaveMeta } from './useAgentEditorForm';
import { AGENT_KEY_MAX_LENGTH, useAgentEditorForm } from './useAgentEditorForm';

const styles = createStaticStyles(({ css }) => ({
  /** The one scrolling region: only the form fields move, never the footer. */
  body: css`
    overflow-y: auto;
    flex: 1 1 auto;

    min-height: 0;
    padding-block: 16px;
    padding-inline: 16px;
  `,
  error: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorError};
  `,
  /** Label above control — the house pattern for admin modals. */
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  footer: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
  `,
  footerActions: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  `,
  /** Pinned below the scroll region: status first, then the actions. Never scrolls out of reach. */
  footerRegion: css`
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /**
   * base-ui's borderless group header ships 16px between the title and its rule and nothing after
   * it, which reads as a title floating away from its own section. The rhythm here is
   * title → 8px → rule → 16px → first field, for collapsible and plain groups alike.
   */
  group: css`
    & > :first-child {
      padding-block-end: 8px;
    }
  `,
  groupBody: css`
    padding-block-start: 16px;
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  /**
   * Avatar, name and identifier are one identity, read left to right. The identifier wraps under
   * them and takes the full width once the row can no longer hold all three.
   */
  identityAvatar: css`
    flex: 0 0 auto;
  `,
  identityKey: css`
    flex: 1 1 240px;
    min-width: 0;
  `,
  /**
   * The name box and the swatch strip are ONE column at every width — the strip is a child of the
   * name's own column, so it can never be reflowed away from the box it colours.
   */
  identityName: css`
    display: flex;
    flex: 1 1 240px;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
  `,
  identityRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 16px;
    align-items: flex-start;
  `,
  identitySwatches: css`
    min-width: 0;
  `,
  paramsGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  `,
  root: css`
    overflow: hidden;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;

    min-height: 0;
  `,
  sections: css`
    display: flex;
    flex-direction: column;
    gap: 24px;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  status: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding-block: 12px 0;
    padding-inline: 16px;
  `,
}));

const NAME_ID = 'admin-agent-editor-name';
const DESCRIPTION_ID = 'admin-agent-editor-description';
const KEY_ID = 'admin-agent-editor-key';
const SYSTEM_ROLE_ID = 'admin-agent-editor-system-role';
const OPENING_MESSAGE_ID = 'admin-agent-editor-opening-message';
const OPENING_QUESTIONS_ID = 'admin-agent-editor-opening-questions';
const TAGS_ID = 'admin-agent-editor-tags';

/** Already named by the "still needed" line beside Save — never say the same thing twice. */
const MODEL_BLOCKER = 'agentCatalog.editor.blocked.model';

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
  /** AGENT_ASSIGN: without it 分配策略 is hidden and no assignment is ever written. */
  canAssign?: boolean;
  /** AGENT_UPDATE + AGENT_PUBLISH. Without it every config field is read-only. */
  canEditConfig?: boolean;
  dirtyRef?: { current: boolean };
  /** Explicit dismissal — guarded by the host when input is unsaved. Defaults to `onClose`. */
  onCancel?: () => void;
  /** Unconditional close, used once the write has committed. */
  onClose?: () => void;
  onSaved?: (
    output: AdminPlatformAgentSaveOutput | null,
    meta: AgentEditorSaveMeta,
  ) => Promise<void> | void;
  /** Set by the hook while a write is in flight so the host can veto dismissal. */
  pendingRef?: { current: boolean };
}

export const AgentEditorForm = memo<AgentEditorFormProps>(
  ({
    agent,
    authMethod,
    canAssign,
    canEditConfig,
    dirtyRef,
    onCancel,
    onClose,
    onSaved,
    pendingRef,
  }) => {
    const { t } = useTranslation('admin');
    const form = useAgentEditorForm({
      agent,
      authMethod,
      canAssign,
      canEditConfig,
      dirtyRef,
      onClose,
      onSaved,
      pendingRef,
    });
    const { config } = form.value;
    const background = config.backgroundColor ?? undefined;
    // Saving republishes an archived assistant, so say so instead of letting it happen silently.
    const archived = agent?.identity.status === 'archived';

    // One flag for every config control: an assignment-only operator (or an assistant whose live
    // version could not be loaded) reads the configuration but never authors it.
    const readOnly = !form.configEditable;
    const keyInvalid = form.isCreate && form.agentKey.length > 0 && !form.keyValid;
    // An empty identifier is only worth raising once the admin has named the assistant — before
    // that the whole form is empty and there is nothing to correct yet.
    const keyMissing =
      form.isCreate && form.agentKey.length === 0 && config.displayName.trim().length > 0;
    // Requirements are guidance until the admin starts, then the honest reason Save stays closed.
    const showMissing = !readOnly && form.dirty && form.missingRequirements.length > 0;
    const blockers = form.depValidity.blockers.filter(
      (blocker) => blocker.message !== MODEL_BLOCKER,
    );

    const basics = (model: ReactNode): ReactNode => (
      <div className={styles.stack}>
        <div
          aria-label={t('agentCatalog.editor.identity')}
          className={styles.identityRow}
          role={'group'}
        >
          <div className={cx(styles.field, styles.identityAvatar)}>
            <FieldLabel>{t('agentCatalog.editor.avatar')}</FieldLabel>
            <EmojiPicker
              background={background}
              size={48}
              // Display-only fallback: an unset avatar must not render as the text "NU"
              // (`String(null)`); the platform default stays out of the persisted config.
              value={config.avatar ?? DEFAULT_AVATAR}
              onChange={(next: string) => form.patchConfig('avatar', next || null)}
            />
          </div>

          {/* One column: the swatch strip is part of the name box, ending exactly where it ends. */}
          <div className={styles.identityName}>
            <div className={styles.field}>
              <FieldLabel required htmlFor={NAME_ID}>
                {t('agentCatalog.editor.name')}
              </FieldLabel>
              <Input
                required
                aria-label={t('agentCatalog.editor.name')}
                disabled={readOnly}
                id={NAME_ID}
                placeholder={t('agentCatalog.editor.namePlaceholder')}
                value={config.displayName}
                onChange={(event) => form.setDisplayName(event.target.value)}
              />
            </div>

            <div
              aria-label={t('agentCatalog.editor.background')}
              className={styles.identitySwatches}
              role={'group'}
            >
              <BackgroundSwatches
                value={background}
                onChange={(next) => form.patchConfig('backgroundColor', next || null)}
              />
            </div>
          </div>

          <div className={cx(styles.field, styles.identityKey)}>
            <FieldLabel
              htmlFor={KEY_ID}
              required={form.isCreate}
              help={
                form.isCreate
                  ? t('agentCatalog.editor.keyDesc')
                  : t('agentCatalog.editor.keyLockedDesc')
              }
            >
              {t('agentCatalog.editor.key')}
            </FieldLabel>
            <Input
              aria-label={t('agentCatalog.editor.key')}
              disabled={readOnly || !form.isCreate}
              id={KEY_ID}
              maxLength={AGENT_KEY_MAX_LENGTH}
              placeholder={t('agentCatalog.editor.keyPlaceholder')}
              required={form.isCreate}
              value={form.agentKey}
              onChange={(event) => form.changeAgentKey(event.target.value)}
            />
            {keyInvalid || keyMissing ? (
              <span className={styles.error} role={'alert'}>
                {keyMissing
                  ? t('agentCatalog.editor.keyRequired')
                  : t('agentCatalog.editor.keyInvalid', { max: AGENT_KEY_MAX_LENGTH })}
              </span>
            ) : null}
          </div>
        </div>

        <div className={styles.field}>
          <FieldLabel htmlFor={DESCRIPTION_ID}>{t('agentCatalog.editor.description')}</FieldLabel>
          <TextArea
            aria-label={t('agentCatalog.editor.description')}
            autoSize={{ maxRows: 3, minRows: 1 }}
            disabled={readOnly}
            id={DESCRIPTION_ID}
            placeholder={t('agentCatalog.editor.descriptionPlaceholder')}
            value={config.description ?? ''}
            onChange={(event) => form.patchConfig('description', event.target.value || null)}
          />
        </div>

        {/* The model is required, so it stays above the fold with the other basics. */}
        {model}
      </div>
    );

    const prompt: ReactNode = (
      <div className={styles.field}>
        <FieldLabel
          required
          help={t('agentCatalog.editor.systemRoleDesc')}
          htmlFor={SYSTEM_ROLE_ID}
        >
          {t('agentCatalog.editor.systemRole')}
        </FieldLabel>
        <TextArea
          required
          aria-label={t('agentCatalog.editor.systemRole')}
          autoSize={{ maxRows: 18, minRows: 6 }}
          disabled={readOnly}
          id={SYSTEM_ROLE_ID}
          placeholder={t('agentCatalog.editor.systemRolePlaceholder')}
          value={config.systemRole}
          onChange={(event) => form.patchConfig('systemRole', event.target.value)}
        />
      </div>
    );

    const params: ReactNode = (
      <div className={styles.stack}>
        <div className={styles.paramsGrid}>
          {PARAM_ROWS.map(({ key, max, min, step }) => (
            <div className={styles.field} key={key}>
              <FieldLabel htmlFor={`admin-agent-editor-param-${key}`}>
                {t(`agentCatalog.editor.param.${key}` as never)}
              </FieldLabel>
              <InputNumber
                disabled={readOnly}
                id={`admin-agent-editor-param-${key}`}
                max={max}
                min={min}
                placeholder={t('agentCatalog.editor.paramDefault')}
                step={step}
                value={config.modelParameters[key] ?? null}
                onChange={(next) =>
                  form.patchConfig('modelParameters', {
                    ...config.modelParameters,
                    [key]: typeof next === 'number' ? next : undefined,
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>
    );

    const more = (skills: ReactNode, connectors: ReactNode): ReactNode => (
      <div className={styles.stack}>
        <div className={styles.field}>
          <FieldLabel htmlFor={TAGS_ID}>{t('agentCatalog.editor.tags')}</FieldLabel>
          <Select
            allowClear
            aria-label={t('agentCatalog.editor.tags')}
            disabled={readOnly}
            id={TAGS_ID}
            mode={'tags'}
            options={config.tags.map((tag) => ({ label: tag, value: tag }))}
            placeholder={t('agentCatalog.editor.tagsPlaceholder')}
            tokenSeparators={[',']}
            value={config.tags}
            onChange={(next) =>
              form.patchConfig('tags', Array.isArray(next) ? next : next ? [next] : [])
            }
          />
        </div>
        <div className={styles.field}>
          <FieldLabel htmlFor={OPENING_MESSAGE_ID}>
            {t('agentCatalog.editor.openingMessage')}
          </FieldLabel>
          <TextArea
            aria-label={t('agentCatalog.editor.openingMessage')}
            autoSize={{ maxRows: 6, minRows: 2 }}
            disabled={readOnly}
            id={OPENING_MESSAGE_ID}
            placeholder={t('agentCatalog.editor.openingMessagePlaceholder')}
            value={config.openingMessage ?? ''}
            onChange={(event) => form.patchConfig('openingMessage', event.target.value || null)}
          />
        </div>
        <div className={styles.field}>
          <FieldLabel
            help={t('agentCatalog.editor.openingQuestionsDesc')}
            htmlFor={OPENING_QUESTIONS_ID}
          >
            {t('agentCatalog.editor.openingQuestions')}
          </FieldLabel>
          <TextArea
            aria-label={t('agentCatalog.editor.openingQuestions')}
            autoSize={{ maxRows: 8, minRows: 3 }}
            disabled={readOnly}
            id={OPENING_QUESTIONS_ID}
            placeholder={t('agentCatalog.editor.openingQuestionsPlaceholder')}
            value={config.openingQuestions.join('\n')}
            onChange={(event) =>
              form.patchConfig('openingQuestions', event.target.value.split('\n'))
            }
          />
        </div>
        {skills}
        {connectors}
      </div>
    );

    return (
      <div className={styles.root}>
        <div className={styles.body}>
          <DependencyEditor
            enabled
            agentId={agent?.identity.id ?? 'new-platform-agent'}
            dependencies={form.value.dependencies}
            editable={!readOnly}
            onChange={form.setDependencies}
            onValidityChange={form.setDepValidity}
          >
            {(slots) => (
              <div className={styles.sections}>
                <FormGroup
                  className={styles.group}
                  title={t('agentCatalog.editor.section.basic')}
                  variant={'borderless'}
                >
                  <div className={cx(styles.stack, styles.groupBody)}>
                    {/* Say WHY the fields are locked, once, where the fields are. */}
                    {readOnly ? (
                      <Alert
                        showIcon
                        role={'status'}
                        type={form.currentVersionMissing ? 'error' : 'info'}
                        message={t(
                          form.currentVersionMissing
                            ? 'agentCatalog.editor.versionUnavailable'
                            : 'agentCatalog.editor.readOnlyConfig',
                        )}
                      />
                    ) : null}
                    {basics(slots.model)}
                    {form.depValidity.issues.length > 0 ? (
                      <Alert
                        showIcon
                        type={'warning'}
                        message={form.depValidity.issues
                          .map((issue) => t(issue as never))
                          .join(' · ')}
                      />
                    ) : null}
                  </div>
                </FormGroup>

                <FormGroup
                  className={styles.group}
                  title={t('agentCatalog.editor.section.prompt')}
                  variant={'borderless'}
                >
                  <div className={styles.groupBody}>{prompt}</div>
                </FormGroup>

                {form.canAssign ? (
                  <FormGroup
                    className={styles.group}
                    title={t('agentCatalog.editor.section.assignment')}
                    variant={'borderless'}
                    extra={
                      <HelpTooltip
                        field={t('agentCatalog.editor.section.assignment')}
                        title={t('agentCatalog.editor.section.assignmentDesc')}
                      />
                    }
                  >
                    <div className={styles.groupBody}>
                      <AssignmentPolicySection
                        assignments={form.assignments}
                        isDefaultInbox={form.systemKey === 'default-inbox'}
                      />
                    </div>
                  </FormGroup>
                ) : null}

                <FormGroup
                  collapsible
                  className={styles.group}
                  defaultActive={false}
                  title={t('agentCatalog.editor.section.params')}
                  variant={'borderless'}
                  extra={
                    <HelpTooltip
                      field={t('agentCatalog.editor.section.params')}
                      title={t('agentCatalog.editor.section.paramsDesc')}
                    />
                  }
                >
                  <div className={styles.groupBody}>{params}</div>
                </FormGroup>

                <FormGroup
                  collapsible
                  className={styles.group}
                  defaultActive={false}
                  title={t('agentCatalog.editor.section.more')}
                  variant={'borderless'}
                >
                  <div className={styles.groupBody}>{more(slots.skills, slots.connectors)}</div>
                </FormGroup>
              </div>
            )}
          </DependencyEditor>
        </div>

        <div className={styles.footerRegion}>
          {form.conflict || form.error || showMissing || blockers.length > 0 ? (
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
              {/* One honest line for what Save is still waiting on, right where Save is. */}
              {showMissing ? (
                <Text type={'secondary'}>
                  {t('agentCatalog.editor.missing.title', {
                    fields: form.missingRequirements.map((key) => t(key as never)).join(' · '),
                  })}
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
