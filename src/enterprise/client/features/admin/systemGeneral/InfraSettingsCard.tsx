'use client';

import { AccordionItem, Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import {
  cloneElement,
  type HTMLAttributes,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSystemTestDependencyResult } from '@/enterprise/client/services/adminSystem';

import { infraSettingsStyles as styles } from './styles';

export interface Field {
  label: string;
  value: ReactNode;
}

export interface InfraSettingsCardProps {
  /** Alert above the body — shown in both the read-only and the editing state. */
  banner?: ReactNode;
  canTest: boolean;
  /**
   * Fold the body away behind the header. Only the two dependencies an operator configures are
   * foldable: the header keeps saying where the configuration comes from and whether it works, so
   * a folded card is still an answer rather than a closed door.
   */
  collapsible?: boolean;
  /** Editable body; replaces the read-only rows when present. */
  editor?: ReactNode;
  /** Environment variables that drive this dependency. Omitted while it is configured here. */
  envVars?: readonly string[];
  /** Buttons shown next to 测试连接 (edit / save / revert). */
  extraActions?: ReactNode;
  fields?: readonly Field[];
  /** Rendered next to the status tag — e.g. where the configuration comes from. */
  headerExtra?: ReactNode;
  icon: LucideIcon;
  /** Replaces the "how to change" guidance with a plain statement of the constraint. */
  notice?: ReactNode;
  onTest: () => void;
  probe?: AdminSystemTestDependencyResult;
  probing: boolean;
  status?: string;
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

export const InfraSettingsCard = memo<InfraSettingsCardProps>(
  ({
    banner,
    canTest,
    collapsible,
    editor,
    envVars,
    extraActions,
    fields,
    headerExtra,
    icon,
    notice,
    onTest,
    probe,
    probing,
    status,
    testDisabled,
    title,
  }) => {
    const { t } = useTranslation('admin');
    const [expanded, setExpanded] = useState(true);

    /**
     * The primitive renders a clickable header, binds Enter/Space to it and even styles a focus
     * ring for it — but never makes it focusable, so folding a section would be mouse-only. Its
     * keyboard handler is on this very element, so the semantics it already behaves like are the
     * only thing missing, and `headerWrapper` is the seam it offers for adding them.
     */
    const headerWrapper = useCallback(
      (header: ReactNode) =>
        isValidElement(header)
          ? // eslint-disable-next-line @eslint-react/no-clone-element
            cloneElement(header as ReactElement<HTMLAttributes<HTMLElement>>, {
              'aria-expanded': expanded,
              'role': 'button',
              'tabIndex': 0,
            })
          : header,
      [expanded],
    );

    const header = (
      <div className={collapsible ? `${styles.header} ${styles.headerInAccordion}` : styles.header}>
        <div className={styles.title}>
          <Icon icon={icon} size={16} />
          <Text strong>{title}</Text>
        </div>
        <div className={styles.headerTags}>
          {headerExtra}
          {status ? <InfraStatusTag status={status} /> : null}
        </div>
      </div>
    );

    const body = (
      <div className={styles.cardBody}>
        {banner}
        {editor ?? <InfraFieldRows fields={fields ?? []} />}

        <div className={styles.footer}>
          {probe ? (
            <Flexbox gap={4}>
              <Text
                type={
                  !probe.ok
                    ? 'danger'
                    : probe.message === 'configured_unverified'
                      ? 'secondary'
                      : 'success'
                }
              >
                {t(
                  !probe.ok
                    ? 'systemGeneral.test.failure'
                    : probe.message === 'configured_unverified'
                      ? 'systemGeneral.test.unverified'
                      : 'systemGeneral.test.success',
                )}
                {probe.message
                  ? ` · ${t(`systemGeneral.test.reason.${probe.message}` as never)}`
                  : ''}
              </Text>
              <Text className={styles.code} type="secondary">
                {t('systemGeneral.test.latency', { ms: probe.latencyMs })}
              </Text>
            </Flexbox>
          ) : null}

          {canTest || extraActions ? (
            <div className={styles.actionsRow}>
              {canTest ? (
                <Button disabled={testDisabled} loading={probing} size="small" onClick={onTest}>
                  {t('systemGeneral.testConnection')}
                </Button>
              ) : null}
              {extraActions}
            </div>
          ) : null}

          {notice || envVars?.length ? (
            <div className={styles.hint}>
              <Text type="secondary">{notice ?? t('systemGeneral.howToChange.title')}</Text>
              {envVars?.length ? (
                <div className={styles.envList}>
                  {envVars.map((name) => (
                    <span className={styles.envChip} key={name}>
                      {name}
                    </span>
                  ))}
                </div>
              ) : null}
              {notice ? null : (
                <Text type="secondary">{t('systemGeneral.howToChange.restart')}</Text>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );

    if (!collapsible)
      return (
        <section className={styles.card}>
          {header}
          {body}
        </section>
      );

    return (
      <section className={styles.card}>
        <AccordionItem
          expand={expanded}
          headerWrapper={headerWrapper}
          indicatorPlacement="end"
          itemKey={title}
          paddingBlock={0}
          paddingInline={0}
          // The card already spaces its own header from its body; the accordion does not.
          styles={{ content: { paddingBlockStart: 16 } }}
          title={header}
          onExpandChange={setExpanded}
        >
          {body}
        </AccordionItem>
      </section>
    );
  },
);

InfraSettingsCard.displayName = 'AdminInfraSettingsCard';
