'use client';

import { Flexbox, NeuralNetworkLoading, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export const styles = createStaticStyles(({ css }) => ({
  label: css`
    font-size: ${cssVar.fontSize};
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  required: css`
    margin-inline-start: 4px;
    color: ${cssVar.colorError};
  `,
}));

/**
 * The one field label used across the assistant editor: a real `<label>` so pointer and assistive
 * technology reach the control, with an explicit marker for the fields the contract requires.
 */
export const FieldLabel = ({
  children,
  htmlFor,
  required,
}: {
  children: ReactNode;
  htmlFor?: string;
  required?: boolean;
}) => (
  <label className={styles.label} htmlFor={htmlFor}>
    {children}
    {required ? (
      <span aria-hidden className={styles.required}>
        *
      </span>
    ) : null}
  </label>
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
