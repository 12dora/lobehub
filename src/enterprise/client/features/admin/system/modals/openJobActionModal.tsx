'use client';

import { Text, TextArea } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { t } from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSystemJobAction } from '../controller';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
}));

interface JobActionModalContentProps {
  action: AdminSystemJobAction;
  jobId: string;
  onSubmit: (reason: string) => Promise<void> | void;
}

const JobActionModalContent = memo<JobActionModalContentProps>(({ action, jobId, onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [reason, setReason] = useState('');
  const [showRequired, setShowRequired] = useState(false);

  const submit = () => {
    const value = reason.trim();
    if (!value) {
      setShowRequired(true);
      return;
    }
    // The dialog confirms intent only. Close synchronously and show progress on the originating row.
    close();
    queueMicrotask(() => void onSubmit(value));
  };

  return (
    <div className={styles.body}>
      <Text>{t(`system.jobs.modal.${action}.description` as never, { jobId })}</Text>
      {action === 'cancel' ? (
        <Text type="secondary">{t('system.jobs.modal.cancel.completedItems')}</Text>
      ) : null}
      <div className={styles.field}>
        <Text strong>{t('system.jobs.modal.reason')}</Text>
        <TextArea
          autoFocus
          maxLength={1000}
          placeholder={t('system.jobs.modal.reasonPlaceholder')}
          rows={4}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (event.target.value.trim()) setShowRequired(false);
          }}
        />
        {showRequired ? (
          <Text className={styles.error} role="alert">
            {t('system.jobs.modal.reasonRequired')}
          </Text>
        ) : null}
      </div>
      <div className={styles.footer}>
        <Button onClick={close}>{t('system.actions.close')}</Button>
        <Button danger={action === 'cancel'} type="primary" onClick={submit}>
          {t(`system.jobs.actions.${action}` as never)}
        </Button>
      </div>
    </div>
  );
});

JobActionModalContent.displayName = 'AdminSystemJobActionModalContent';

export type OpenJobActionModalOptions = JobActionModalContentProps;

export const openJobActionModal = (options: OpenJobActionModalOptions) =>
  createModal({
    content: <JobActionModalContent {...options} />,
    footer: null,
    maskClosable: false,
    title: t(`system.jobs.modal.${options.action}.title`, { ns: 'admin' }),
    width: 'min(92vw, 480px)',
  });
