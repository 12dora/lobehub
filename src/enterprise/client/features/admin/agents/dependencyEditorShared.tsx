'use client';

import { Flexbox, Icon, NeuralNetworkLoading, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { CircleHelp } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export const styles = createStaticStyles(({ css }) => ({
  help: css`
    cursor: help;

    display: inline-flex;
    align-items: center;

    padding: 0;
    border: none;

    color: ${cssVar.colorTextTertiary};

    background: none;

    &:hover,
    &:focus-visible {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  label: css`
    font-size: ${cssVar.fontSize};
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  labelRow: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
  `,
  required: css`
    margin-inline-start: 4px;
    color: ${cssVar.colorError};
  `,
}));

/**
 * The help affordance for a field's static guidance. It is a real button, so the guidance is not
 * pointer-only: Tab reaches it, focus opens the tooltip and blur closes it again. It is rendered
 * beside the `<label>` rather than inside it, so its accessible name never leaks into the
 * control's own name.
 */
export const HelpTooltip = ({ field, title }: { field?: string; title: ReactNode }) => {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} title={title} onOpenChange={setOpen}>
      <button
        className={styles.help}
        type="button"
        aria-label={
          field ? t('agentCatalog.editor.helpFor', { field }) : t('agentCatalog.editor.help')
        }
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(true)}
      >
        <Icon icon={CircleHelp} size={14} />
      </button>
    </Tooltip>
  );
};

/**
 * The one field label used across the assistant editor: a real `<label>` so pointer and assistive
 * technology reach the control, with an explicit marker for the fields the contract requires.
 * Static guidance belongs in `help` — a hover/focus target next to the label instead of a
 * paragraph between the label and the box it explains.
 */
export const FieldLabel = ({
  children,
  help,
  htmlFor,
  required,
}: {
  children: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  required?: boolean;
}) => (
  <span className={styles.labelRow}>
    <label className={styles.label} htmlFor={htmlFor}>
      {children}
      {required ? (
        <span aria-hidden className={styles.required}>
          *
        </span>
      ) : null}
    </label>
    {help ? (
      <HelpTooltip field={typeof children === 'string' ? children : undefined} title={help} />
    ) : null}
  </span>
);

/**
 * A source is usable for validation ONLY when it has a successful, settled snapshot: data present,
 * no error, and NOT revalidating. Retained data from a prior success while an error or background
 * revalidation is in flight is NOT trustworthy → readiness fails closed.
 */
export const usable = (hook: { data?: unknown; error?: unknown; isValidating?: boolean }) =>
  hook.data !== undefined && !hook.error && !hook.isValidating;

export const RetryAction = ({ mutate }: { mutate: () => Promise<unknown> }) => {
  const { t } = useTranslation('admin');
  return (
    <Button size="small" onClick={() => void mutate()}>
      {t('agentCatalog.dependency.retry')}
    </Button>
  );
};

export const LoadingHint = () => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  if (reduceMotion) {
    return <Text type="secondary">{t('agentCatalog.dependency.loading')}</Text>;
  }
  return (
    <Flexbox horizontal align="center" gap={8} role="status">
      <NeuralNetworkLoading size={16} />
      <Text type="secondary">{t('agentCatalog.dependency.loading')}</Text>
    </Flexbox>
  );
};

export const RevalidatingHint = () => {
  const { t } = useTranslation('admin');
  const reduceMotion = useReducedMotion();
  if (reduceMotion) {
    return <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>;
  }
  return (
    <Flexbox horizontal align="center" gap={8} role="status">
      <NeuralNetworkLoading size={16} />
      <Text type="secondary">{t('agentCatalog.dependency.revalidating')}</Text>
    </Flexbox>
  );
};

/**
 * Catalog-list async branch: error → loading → empty → data.
 * Replaces nested ternary chains for provider/skill/connector list loads.
 */
export const CatalogListBody = ({
  children,
  empty,
  error,
  errorNode,
  isEmpty,
  isLoading,
  loading,
}: {
  children: ReactNode;
  empty?: ReactNode;
  error?: unknown;
  errorNode: ReactNode;
  isEmpty?: boolean;
  isLoading?: boolean;
  loading: ReactNode;
}): ReactNode => {
  if (error) return errorNode;
  if (isLoading) return loading;
  if (isEmpty) return empty ?? null;
  return children;
};

/**
 * Detail-fetch async branch (nullable projection): error → loading → null-unresolvable → data → none.
 * Used for provider model source and selected connector detail.
 */
export const DetailFetchBody = <T,>({
  children,
  data,
  error,
  errorNode,
  isLoading,
  loading,
  unresolvable,
}: {
  children: (data: T) => ReactNode;
  data: T | null | undefined;
  error?: unknown;
  errorNode: ReactNode;
  isLoading?: boolean;
  loading: ReactNode;
  unresolvable: ReactNode;
}): ReactNode => {
  if (error) return errorNode;
  if (isLoading) return loading;
  if (data === null) return unresolvable;
  if (data) return children(data);
  return null;
};
