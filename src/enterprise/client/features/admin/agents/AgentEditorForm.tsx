'use client';

import { Alert } from '@lobehub/ui';
import { FormGroup } from '@lobehub/ui/base-ui';
import { cx } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { AgentEditorFooter } from './AgentEditorFooter';
import { styles } from './agentEditorForm.styles';
import {
  AgentEditorIdentityFields,
  AgentEditorMoreFields,
  AgentEditorParamsFields,
  AgentEditorPromptFields,
} from './AgentEditorSections';
import { AssignmentPolicySection } from './AssignmentPolicySection';
import { DependencyEditor } from './DependencyEditor';
import { HelpTooltip } from './dependencyEditorShared';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';
import type { AgentEditorSaveMeta } from './useAgentEditorForm';
import { useAgentEditorForm } from './useAgentEditorForm';

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
                    <div className={styles.stack}>
                      <AgentEditorIdentityFields
                        agentKey={form.agentKey}
                        changeAgentKey={form.changeAgentKey}
                        config={config}
                        isCreate={form.isCreate}
                        keyInvalid={keyInvalid}
                        keyMissing={keyMissing}
                        patchConfig={form.patchConfig}
                        readOnly={readOnly}
                        setDisplayName={form.setDisplayName}
                      />
                      {/* The model is required, so it stays above the fold with the other basics. */}
                      {slots.model}
                    </div>
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
                  <div className={styles.groupBody}>
                    <AgentEditorPromptFields
                      patchConfig={form.patchConfig}
                      readOnly={readOnly}
                      systemRole={config.systemRole}
                    />
                  </div>
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
                  <div className={styles.groupBody}>
                    <AgentEditorParamsFields
                      modelParameters={config.modelParameters}
                      patchConfig={form.patchConfig}
                      readOnly={readOnly}
                    />
                  </div>
                </FormGroup>

                <FormGroup
                  collapsible
                  className={styles.group}
                  defaultActive={false}
                  title={t('agentCatalog.editor.section.more')}
                  variant={'borderless'}
                >
                  <div className={styles.groupBody}>
                    <AgentEditorMoreFields
                      config={config}
                      connectors={slots.connectors}
                      patchConfig={form.patchConfig}
                      readOnly={readOnly}
                      skills={slots.skills}
                    />
                  </div>
                </FormGroup>
              </div>
            )}
          </DependencyEditor>
        </div>

        <AgentEditorFooter
          archived={archived}
          blockers={form.depValidity.blockers}
          canSubmit={form.canSubmit}
          conflict={form.conflict}
          error={form.error}
          missingRequirements={form.missingRequirements}
          saving={form.saving}
          showMissing={showMissing}
          submit={form.submit}
          onCancel={onCancel ?? onClose}
        />
      </div>
    );
  },
);

AgentEditorForm.displayName = 'AgentEditorForm';
