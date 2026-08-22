'use client';

import { Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { Button, Modal, ScrollArea } from '@lobehub/ui/base-ui';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSystemTestDependencyResult } from '@/enterprise/client/services/adminSystem';

import { infraSettingsStyles as styles } from './styles';

export interface Field {
  label: string;
  value: ReactNode;
}

/**
 * Every card answers with the same five rows, so the grid reads as one instrument panel instead of
 * five differently sized boxes. Anything else a dependency has to say lives in 详情.
 */
export const INFRA_SUMMARY_FIELD_LIMIT = 5;

/** Both secondary surfaces are the same size, so opening one does not resize the page. */
const INFRA_MODAL_WIDTH = 720;

export interface InfraSettingsCardProps {
  /** Alert above the summary. Capped in height — the full text is repeated in 详情. */
  banner?: ReactNode;
  canTest: boolean;
  /** Long read-only blocks for 详情 (status panel, package ledger). */
  details?: ReactNode;
  /** The complete field list for 详情; defaults to the summary rows. */
  detailsFields?: readonly Field[];
  /** 保存 / 恢复 / 取消 — rendered in the 编辑 modal footer. */
  editActions?: ReactNode;
  /** Whether the 编辑 modal is open. Owned by the card wrapper, which drives the editor hook. */
  editOpen?: boolean;
  /** Editable body, hosted by the 编辑 modal. Absent on read-only cards, which show 详情 only. */
  editor?: ReactNode;
  /** Environment variables that drive this dependency; listed in 详情. */
  envVars?: readonly string[];
  /** Buttons shown next to 测试连接 on the card (e.g. 重新生成). */
  extraActions?: ReactNode;
  /** Summary rows; only the first `INFRA_SUMMARY_FIELD_LIMIT` reach the card. */
  fields?: readonly Field[];
  /** Rendered next to the status tag — e.g. where the configuration comes from. */
  headerExtra?: ReactNode;
  icon: LucideIcon;
  /** One or two lines of guidance under the actions (module disabled, what the card is). */
  notice?: ReactNode;
  /**
   * Drives the 编辑 modal. Every `false` transition — the mask, Esc, the footer 取消 — goes through
   * the same guarded controller (`useInfraEditModal`), which is where the unsaved-changes
   * confirmation lives, so the card never has to own a second copy of that rule.
   */
  onEditOpenChange?: (open: boolean) => void;
  onTest: () => void;
  probe?: AdminSystemTestDependencyResult;
  probing: boolean;
  status?: string;
  /** Replaces the summary rows (e.g. a skeleton while the card's own request is in flight). */
  summary?: ReactNode;
  /** Disables 测试连接 (e.g. the draft cannot be probed until a credential is re-entered). */
  testDisabled?: boolean;
  title: string;
}

const display = (value: ReactNode): ReactNode => value ?? '—';

/**
 * Settings-card reading of the shared dependency status: a passive-only check ("unknown" on the
 * health page) simply means the dependency is configured but not yet verified — say so instead
 * of "未知", and offer 测试连接 for the verification.
 */
const STATUS_PRESENTATION: Record<
  string,
  { icon: LucideIcon; key: string; tone: 'default' | 'error' | 'success' | 'warning' }
> = {
  degraded: { icon: AlertTriangle, key: 'incomplete', tone: 'warning' },
  disabled: { icon: CircleDashed, key: 'notConfigured', tone: 'default' },
  healthy: { icon: CheckCircle2, key: 'healthy', tone: 'success' },
  unavailable: { icon: XCircle, key: 'unavailable', tone: 'error' },
  unknown: { icon: CheckCircle2, key: 'configured', tone: 'default' },
};

const InfraStatusTag = memo<{ status: string }>(({ status }) => {
  const { t } = useTranslation('admin');
  const p = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.unknown!;
  return (
    <Tag color={p.tone} icon={<Icon icon={p.icon} size={12} />} size="small">
      {t(`systemGeneral.status.${p.key}` as never)}
    </Tag>
  );
});

InfraStatusTag.displayName = 'AdminInfraStatusTag';

/** Label / value rows. Also used by the fingerprint card, whose editor keeps two of them read-only. */
export const InfraFieldRows = memo<{ fields: readonly Field[] }>(({ fields }) => (
  <div className={styles.fields}>
    {fields.map((field) => (
      <div className={styles.fieldRow} key={field.label}>
        <Text className={styles.fieldLabel} type="secondary">
          {field.label}
        </Text>
        <Text className={styles.fieldValue}>{display(field.value)}</Text>
      </div>
    ))}
  </div>
));

InfraFieldRows.displayName = 'AdminInfraFieldRows';

/** The outcome of the last probe, in one line plus its latency. Shared by the card and the editor. */
export const InfraProbeResult = memo<{ probe?: AdminSystemTestDependencyResult }>(({ probe }) => {
  const { t } = useTranslation('admin');
  if (!probe) return null;

  return (
    <Flexbox gap={4}>
      <Text
        type={
          !probe.ok ? 'danger' : probe.message === 'configured_unverified' ? 'secondary' : 'success'
        }
      >
        {t(
          !probe.ok
            ? 'systemGeneral.test.failure'
            : probe.message === 'configured_unverified'
              ? 'systemGeneral.test.unverified'
              : 'systemGeneral.test.success',
        )}
        {probe.message ? ` · ${t(`systemGeneral.test.reason.${probe.message}` as never)}` : ''}
      </Text>
      <Text className={styles.code} type="secondary">
        {t('systemGeneral.test.latency', { ms: probe.latencyMs })}
      </Text>
    </Flexbox>
  );
});

InfraProbeResult.displayName = 'AdminInfraProbeResult';

/**
 * One dependency, always the same shape: header, five summary rows, and a footer pinned to the
 * bottom of the card.
 *
 * The two things that used to make one card three times taller than its neighbours — an editor
 * inline in the body, and a monitoring panel with tables — now live behind 编辑 and 详情. The grid
 * can therefore give every card the same height, and no card body ever scrolls.
 */
export const InfraSettingsCard = memo<InfraSettingsCardProps>(
  ({
    banner,
    canTest,
    details,
    detailsFields,
    editActions,
    editOpen = false,
    editor,
    envVars,
    extraActions,
    fields,
    headerExtra,
    icon,
    notice,
    onEditOpenChange,
    onTest,
    probe,
    probing,
    status,
    summary,
    testDisabled,
    title,
  }) => {
    const { t } = useTranslation('admin');
    const [detailsOpen, setDetailsOpen] = useState(false);

    const canEdit = Boolean(editor) && Boolean(onEditOpenChange);

    const summaryFields = (fields ?? []).slice(0, INFRA_SUMMARY_FIELD_LIMIT);
    const allFields = detailsFields ?? fields ?? [];
    /** A card with nothing behind it (an off module) must not offer a door onto an empty room. */
    const canShowDetails =
      Boolean(details) || allFields.length > 0 || Boolean(envVars?.length) || Boolean(banner);
    /**
     * A card whose only content is a sentence (module off) says it where a reading would be, not
     * as a footnote under a divider at the very bottom of a full-height card.
     */
    const noticeInBody = Boolean(notice) && !summary && summaryFields.length === 0;

    return (
      <section className={styles.card}>
        <div className={styles.header}>
          <div className={styles.title}>
            <Icon icon={icon} size={16} />
            <Text strong>{title}</Text>
          </div>
          <div className={styles.headerTags}>
            {headerExtra}
            {status ? <InfraStatusTag status={status} /> : null}
          </div>
        </div>

        <div className={styles.cardBody}>
          {banner ? <div className={styles.bannerSlot}>{banner}</div> : null}
          {noticeInBody ? (
            <div className={styles.noticeClamp}>{notice}</div>
          ) : (
            (summary ?? <InfraFieldRows fields={summaryFields} />)
          )}

          <div className={styles.footer}>
            <InfraProbeResult probe={probe} />

            <div className={styles.actionsRow}>
              {canTest ? (
                <Button disabled={testDisabled} loading={probing} size="small" onClick={onTest}>
                  {t('systemGeneral.testConnection')}
                </Button>
              ) : null}
              {extraActions}
              {canEdit ? (
                <Button size="small" onClick={() => onEditOpenChange?.(true)}>
                  {t('systemGeneral.card.edit')}
                </Button>
              ) : null}
              {canShowDetails ? (
                <Button size="small" onClick={() => setDetailsOpen(true)}>
                  {t('systemGeneral.card.details')}
                </Button>
              ) : null}
            </div>

            {notice && !noticeInBody ? (
              <div className={styles.hint}>
                <div className={styles.noticeClamp}>{notice}</div>
              </div>
            ) : null}
          </div>
        </div>

        <Modal
          destroyOnHidden
          classNames={{ body: styles.modalBody }}
          open={detailsOpen}
          title={t('systemGeneral.card.detailsTitle', { name: title })}
          width={INFRA_MODAL_WIDTH}
          footer={
            <div className={styles.modalFooter}>
              <Button onClick={() => setDetailsOpen(false)}>{t('systemGeneral.card.close')}</Button>
            </div>
          }
          onCancel={() => setDetailsOpen(false)}
        >
          <ScrollArea className={styles.modalScroller}>
            <div className={styles.modalSection}>
              {banner}
              <InfraFieldRows fields={allFields} />
              {details}
              {envVars?.length ? (
                <div className={styles.hint}>
                  <Text type="secondary">{t('systemGeneral.howToChange.title')}</Text>
                  <div className={styles.envList}>
                    {envVars.map((name) => (
                      <span className={styles.envChip} key={name}>
                        {name}
                      </span>
                    ))}
                  </div>
                  <Text type="secondary">{t('systemGeneral.howToChange.restart')}</Text>
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </Modal>

        {canEdit ? (
          <Modal
            destroyOnHidden
            classNames={{ body: styles.modalBody }}
            footer={<div className={styles.modalFooter}>{editActions}</div>}
            open={editOpen}
            title={t('systemGeneral.card.editTitle', { name: title })}
            width={INFRA_MODAL_WIDTH}
            onCancel={() => onEditOpenChange?.(false)}
          >
            <ScrollArea className={styles.modalScroller}>
              <div className={styles.modalSection}>{editor}</div>
            </ScrollArea>
          </Modal>
        ) : null}
      </section>
    );
  },
);

InfraSettingsCard.displayName = 'AdminInfraSettingsCard';
