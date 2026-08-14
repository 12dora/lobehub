import { Flexbox, SortableList } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ImperativeModal from '@/components/ImperativeModal';
import { usePermission } from '@/hooks/usePermission';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';
import { type AiProviderListItem } from '@/types/aiProvider';

import GroupItem from './GroupItem';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    height: 36px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadius};
    transition: background 0.2s ease-in-out;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));

/**
 * Cross-boundary marker set by the admin AI-infra adapter after it has already shown a mapped
 * failure toast (reauth cancelled, rate limited, validation…). Read through the global symbol
 * registry rather than importing the enterprise module, which this route may not depend on;
 * the owner is `enterprise/client/services/adminAiInfraAdapter/errors.ts`, which uses the same
 * `Symbol.for` key precisely so shared surfaces can check it.
 */
const ADMIN_AI_INFRA_ERROR_TOASTED = Symbol.for('lobe.adminAiInfraErrorToasted');

const isAlreadyToasted = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    (error as Record<PropertyKey, unknown>)[ADMIN_AI_INFRA_ERROR_TOASTED] === true,
  );

interface ConfigGroupModalProps {
  defaultItems: AiProviderListItem[];
  onCancel: () => void;
  open: boolean;
}
const ConfigGroupModal = memo<ConfigGroupModalProps>(({ open, onCancel, defaultItems }) => {
  const { t } = useTranslation('modelProvider');
  const { allowed: canManageProvider } = usePermission('manage_provider_key');
  const updateAiProviderSort = useAiInfraStore((s) => s.updateAiProviderSort);
  const [loading, setLoading] = useState(false);

  const [items, setItems] = useState(defaultItems);
  return (
    <ImperativeModal
      allowFullscreen
      footer={null}
      open={open}
      title={t('sortModal.title')}
      width={400}
      onCancel={onCancel}
    >
      <Flexbox gap={16}>
        <SortableList
          items={items}
          renderItem={(item: AiProviderListItem) => (
            <SortableList.Item
              horizontal
              align={'center'}
              className={styles.container}
              gap={4}
              id={item.id}
              justify={'space-between'}
            >
              <GroupItem {...item} disabled={!canManageProvider} />
            </SortableList.Item>
          )}
          onChange={async (items: AiProviderListItem[]) => {
            if (!canManageProvider) return;

            setItems(items);
          }}
        />
        <Button
          block
          disabled={!canManageProvider}
          loading={loading}
          style={{ bottom: 0, position: 'sticky' }}
          type={'primary'}
          onClick={async () => {
            if (!canManageProvider) return;

            const sortMap = items.map((item, index) => ({
              id: item.id,
              sort: index,
            }));
            setLoading(true);
            try {
              await updateAiProviderSort(sortMap);
              toast.success(t('sortModal.success'));
              onCancel();
            } catch (error) {
              // The admin adapter maps its own failures (reauth, rate limit, validation) to one
              // toast already — don't stack a generic one on top of it.
              if (!isAlreadyToasted(error)) toast.error(t('sortModal.failure'));
            } finally {
              setLoading(false);
            }
          }}
        >
          {t('sortModal.update')}
        </Button>
      </Flexbox>
    </ImperativeModal>
  );
});

export default ConfigGroupModal;
