'use client';

import { Tag, Text } from '@lobehub/ui';
import { Button, Input, Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AssignmentEntry, AssignmentMode, AssignmentTargetType } from './assignmentDraft';
import { assignmentTargetKey } from './assignmentDraft';
import { FieldLabel } from './dependencyEditorShared';
import type { AgentAssignmentDraft } from './useAgentAssignmentDraft';

const styles = createStaticStyles(({ css }) => ({
  error: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  /** Two logical fields per line; one column below 480px so nothing is squeezed. */
  row: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px 16px;
    align-items: end;
  `,
  rowActions: css`
    display: flex;
    flex-shrink: 0;
    gap: 4px;
    align-items: center;
  `,
  /** The switch reads as a control on the same baseline as the select beside it. */
  switchField: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-height: 32px;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  target: css`
    overflow: hidden;
    flex: 1 1 auto;

    min-width: 0;

    font-size: ${cssVar.fontSizeSM};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  targets: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding-block: 8px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
  `,
  targetRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  `,
  tags: css`
    display: flex;
    flex-shrink: 0;
    gap: 4px;
    align-items: center;
  `,
}));

const TARGET_TYPE_ID = 'admin-agent-assignment-target-type';
const TARGET_ID = 'admin-agent-assignment-target-id';
const MODE_ID = 'admin-agent-assignment-mode';
const ENABLED_ID = 'admin-agent-assignment-enabled';

const TARGET_TYPES: AssignmentTargetType[] = ['global', 'global_role', 'user'];
const MODES: AssignmentMode[] = ['mandatory', 'default', 'optional'];

export interface AssignmentPolicySectionProps {
  assignments: AgentAssignmentDraft;
  /** `default-inbox` already reaches every member, so its assignments are additive only. */
  isDefaultInbox?: boolean;
}

/**
 * 分配策略 inside the assistant editor. Every edit here is local until the modal's own Save
 * commits it, so there is exactly one write boundary for the whole assistant.
 */
export const AssignmentPolicySection = memo<AssignmentPolicySectionProps>(
  ({ assignments, isDefaultInbox = false }) => {
    const { t } = useTranslation('admin');
    const { draft, truncated } = assignments;
    const describe = (entry: AssignmentEntry) =>
      entry.targetType === 'global' ? t('agentCatalog.assignment.target.global') : entry.targetId;
    /**
     * The mandatory global row IS the default assistant's delivery to every member — dropping it
     * would silently demote the platform default. The server owns it; the editor shows it.
     */
    const locked = (entry: AssignmentEntry) =>
      isDefaultInbox && entry.targetType === 'global' && entry.mode === 'mandatory';

    return (
      <div className={styles.stack}>
        {isDefaultInbox ? (
          <span className={styles.hint}>{t('agentCatalog.assignment.defaultInboxHint')}</span>
        ) : null}

        {/* The loaded list is incomplete, so a diff written from it could not be trusted: the
            section falls back to a read-only view rather than half-applying the operator's edit. */}
        {truncated ? (
          <span className={styles.error} role={'status'}>
            {t('agentCatalog.assignment.tooManyToEdit')}
          </span>
        ) : null}

        <div className={styles.row} hidden={truncated}>
          <div className={styles.field}>
            <FieldLabel htmlFor={TARGET_TYPE_ID}>
              {t('agentCatalog.assignment.targetType')}
            </FieldLabel>
            <Select
              aria-label={t('agentCatalog.assignment.targetType')}
              id={TARGET_TYPE_ID}
              value={draft.targetType}
              options={TARGET_TYPES.map((value) => ({
                label: t(`agentCatalog.assignment.target.${value}` as never),
                value,
              }))}
              onChange={(value) =>
                assignments.patchDraft('targetType', value as AssignmentTargetType)
              }
            />
          </div>
          <div className={styles.field}>
            <FieldLabel htmlFor={TARGET_ID}>{t('agentCatalog.assignment.targetId')}</FieldLabel>
            <Input
              aria-label={t('agentCatalog.assignment.targetId')}
              disabled={draft.targetType === 'global'}
              id={TARGET_ID}
              value={draft.targetType === 'global' ? '' : draft.targetId}
              placeholder={
                draft.targetType === 'global'
                  ? t('agentCatalog.assignment.targetIdGlobal')
                  : t('agentCatalog.assignment.targetId')
              }
              onChange={(event) => assignments.patchDraft('targetId', event.target.value)}
            />
          </div>
        </div>

        <div className={styles.row} hidden={truncated}>
          <div className={styles.field}>
            <FieldLabel htmlFor={MODE_ID}>{t('agentCatalog.assignment.mode')}</FieldLabel>
            <Select
              aria-label={t('agentCatalog.assignment.mode')}
              id={MODE_ID}
              value={draft.mode}
              options={MODES.map((value) => ({
                label: t(`agentCatalog.assignment.mode.${value}` as never),
                value,
              }))}
              onChange={(value) => assignments.patchDraft('mode', value as AssignmentMode)}
            />
          </div>
          <div className={styles.field}>
            <FieldLabel htmlFor={ENABLED_ID}>{t('agentCatalog.assignment.enabled')}</FieldLabel>
            <div className={styles.switchField}>
              <Switch
                aria-label={t('agentCatalog.assignment.enabled')}
                checked={draft.enabled}
                id={ENABLED_ID}
                onChange={(checked) => assignments.patchDraft('enabled', checked)}
              />
              <span className={styles.hint}>
                {t(
                  draft.enabled
                    ? 'agentCatalog.assignment.enabledOn'
                    : 'agentCatalog.assignment.enabledOff',
                )}
              </span>
            </div>
          </div>
        </div>

        {assignments.error ? (
          <span className={styles.error} role={'alert'}>
            {t(assignments.error as never)}
          </span>
        ) : null}

        {truncated ? null : (
          <div>
            <Button size={'small'} onClick={assignments.add}>
              {t('agentCatalog.assignment.add')}
            </Button>
          </div>
        )}

        {assignments.entries.length === 0 ? (
          <Text type={'secondary'}>{t('agentCatalog.assignment.empty')}</Text>
        ) : (
          <div className={styles.targets}>
            {assignments.entries.map((entry) => (
              <div className={styles.targetRow} key={assignmentTargetKey(entry)}>
                <span className={styles.tags}>
                  <Tag size={'small'}>
                    {t(`agentCatalog.assignment.target.${entry.targetType}` as never)}
                  </Tag>
                  <Tag size={'small'}>
                    {t(`agentCatalog.assignment.mode.${entry.mode}` as never)}
                  </Tag>
                  {entry.enabled ? null : (
                    <Tag color={'warning'} size={'small'}>
                      {t('agentCatalog.assignment.disabledTag')}
                    </Tag>
                  )}
                </span>
                <span className={styles.target}>{describe(entry)}</span>
                <span className={styles.rowActions} hidden={truncated}>
                  {locked(entry) ? (
                    <span className={styles.hint}>{t('agentCatalog.assignment.lockedTag')}</span>
                  ) : (
                    <Button
                      danger
                      size={'small'}
                      type={'text'}
                      aria-label={t('agentCatalog.assignment.removeTarget', {
                        target: describe(entry),
                      })}
                      onClick={() => assignments.remove(entry)}
                    >
                      {t('agentCatalog.assignment.remove')}
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  },
);

AssignmentPolicySection.displayName = 'AssignmentPolicySection';
