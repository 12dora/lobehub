import { getCachedTextInputUnitRate, getWriteCacheInputUnitRate } from '@lobechat/utils';
import { ModelIcon } from '@lobehub/icons';
import { Flexbox, Icon, Tooltip } from '@lobehub/ui';
import { Tabs } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import {
  ArrowDownToDot,
  ArrowUpFromDot,
  BookUp2Icon,
  CircleFadingArrowUp,
  Info,
} from 'lucide-react';
import { type LobeDefaultAiModelListItem } from 'model-bank';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useProviderDescription } from '@/hooks/useProviderDescription';
import { useProviderDisplayName } from '@/hooks/useProviderName';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { a11yStyles } from '@/styles/a11y';
import { nonInteractiveTooltipProps } from '@/styles/tooltip';

import { getPrice } from './pricing';

export const styles = createStaticStyles(({ css, cssVar }) => {
  return {
    container: css`
      font-size: ${cssVar.fontSizeSM};
    `,
    desc: css`
      line-height: 12px;
      color: ${cssVar.colorTextDescription};
    `,
    pricing: css`
      font-size: ${cssVar.fontSizeSM};
      color: ${cssVar.colorTextSecondary};
    `,
    /**
     * Same affordance the model picker uses for the same fact. Must clear WCAG 1.4.11's 3:1,
     * which `colorTextTertiary` and below do not.
     */
    providerInfo: css`
      display: inline-flex;
      flex: none;
      align-items: center;
      color: ${cssVar.colorTextSecondary};

      &:hover {
        color: ${cssVar.colorText};
      }
    `,
  };
});

interface ModelCardProps extends LobeDefaultAiModelListItem {
  provider: string;
}

const ModelCard = memo<ModelCardProps>(({ pricing, id, provider, displayName }) => {
  const { t } = useTranslation('chat');
  /**
   * The raw id ("chatgptweb") is an implementation detail; name the service instead — and for
   * a CUSTOM provider that name lives in the store, not in the model-bank. The id stays as
   * the last resort, since this line is the only thing telling two identical model names
   * apart.
   */
  const providerName = useProviderDisplayName(provider) ?? provider;
  const providerDescription = useProviderDescription(provider);

  const isShowCredit = useGlobalStore(systemStatusSelectors.isShowCredit) && !!pricing;
  const updateSystemStatus = useGlobalStore((s) => s.updateSystemStatus);

  const formatPrice = getPrice(pricing || { units: [] });

  return (
    <Flexbox gap={8}>
      <Flexbox
        horizontal
        align={'center'}
        className={styles.container}
        flex={1}
        gap={40}
        justify={'space-between'}
      >
        <Flexbox horizontal align={'center'} gap={8}>
          <ModelIcon model={id} size={22} />
          <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
            <Flexbox horizontal align={'center'} gap={8} style={{ lineHeight: '12px' }}>
              {displayName || id}
            </Flexbox>
            {/*
              One affordance for "this provider has a description", shared with the model
              picker: the ⓘ glyph. The dotted underline this used to carry appears nowhere else
              in the design system, and read as a link on a name that is not one.
            */}
            <Flexbox horizontal align={'center'} gap={4}>
              <span className={styles.desc}>{providerName}</span>
              {providerDescription && (
                <>
                  <Tooltip
                    {...nonInteractiveTooltipProps}
                    placement={'right'}
                    title={providerDescription}
                  >
                    <span aria-hidden className={styles.providerInfo}>
                      <Icon icon={Info} size={12} />
                    </span>
                  </Tooltip>
                  {/*
                    The tooltip is a pointer affordance only: hovering is not available to a
                    keyboard or a screen reader, so the same copy is carried in text that is
                    visually hidden but part of the accessibility tree. Deliberately NOT a
                    focusable control — this sits inside a card, and a nested button would add
                    a tab stop that does nothing on activation.
                  */}
                  <span className={a11yStyles.srOnly}>{providerDescription}</span>
                </>
              )}
            </Flexbox>
          </Flexbox>
        </Flexbox>
        {!!pricing && (
          <Flexbox>
            <Tabs
              activeKey={isShowCredit ? 'credit' : 'token'}
              size={'small'}
              items={[
                { key: 'token', label: 'Token' },
                {
                  key: 'credit',
                  label: (
                    <Tooltip title={t('messages.modelCard.creditTooltip')}>
                      <span>{t('messages.modelCard.credit')}</span>
                    </Tooltip>
                  ),
                },
              ]}
              onChange={(key) => {
                updateSystemStatus({ isShowCredit: key === 'credit' });
              }}
            />
          </Flexbox>
        )}
      </Flexbox>
      {isShowCredit ? (
        <Flexbox horizontal justify={'space-between'}>
          <div />
          <Flexbox horizontal align={'center'} className={styles.pricing} gap={8}>
            {t('messages.modelCard.creditPricing')}:
            {getCachedTextInputUnitRate(pricing) && (
              <Tooltip
                title={t('messages.modelCard.pricing.inputCachedTokens', {
                  amount: formatPrice.cachedInput,
                })}
              >
                <Flexbox horizontal gap={2}>
                  <Icon icon={CircleFadingArrowUp} />
                  {formatPrice.cachedInput}
                </Flexbox>
              </Tooltip>
            )}
            {getWriteCacheInputUnitRate(pricing) && (
              <Tooltip
                title={t('messages.modelCard.pricing.writeCacheInputTokens', {
                  amount: formatPrice.writeCacheInput,
                })}
              >
                <Flexbox horizontal gap={2}>
                  <Icon icon={BookUp2Icon} />
                  {formatPrice.writeCacheInput}
                </Flexbox>
              </Tooltip>
            )}
            <Tooltip
              title={t('messages.modelCard.pricing.inputTokens', { amount: formatPrice.input })}
            >
              <Flexbox horizontal gap={2}>
                <Icon icon={ArrowUpFromDot} />
                {formatPrice.input}
              </Flexbox>
            </Tooltip>
            <Tooltip
              title={t('messages.modelCard.pricing.outputTokens', { amount: formatPrice.output })}
            >
              <Flexbox horizontal gap={2}>
                <Icon icon={ArrowDownToDot} />
                {formatPrice.output}
              </Flexbox>
            </Tooltip>
          </Flexbox>
        </Flexbox>
      ) : (
        <div style={{ height: 18 }} />
      )}
    </Flexbox>
  );
});

export default ModelCard;
