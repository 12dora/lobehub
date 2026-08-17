'use client';

import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { CREDITS_PER_DOLLAR } from '@lobechat/const/currency';
import { ModelIcon, ProviderIcon } from '@lobehub/icons';
import { Flexbox, Icon, Popover, Text, Tooltip } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { Info } from 'lucide-react';
import type { AiModelForSelect } from 'model-bank';
import numeral from 'numeral';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import NewModelBadge from '@/components/ModelSelect/NewModelBadge';
import { useIsDark } from '@/hooks/useIsDark';
import { useProviderDescription } from '@/hooks/useProviderDescription';
import { useProviderDisplayName } from '@/hooks/useProviderName';
import { useServerConfigStore } from '@/store/serverConfig';
import { serverConfigSelectors } from '@/store/serverConfig/selectors';
import { a11yStyles } from '@/styles/a11y';
import { nonInteractiveTooltipProps } from '@/styles/tooltip';

const POPOVER_MAX_WIDTH = 320;
/**
 * The popover already tops out ~4px from the window edge at a 1000px viewport; a long model
 * description used to grow past it and clip. Scroll inside instead.
 */
const POPOVER_MAX_HEIGHT = 420;

const styles = createStaticStyles(({ css, cssVar }) => ({
  descriptionText: css`
    color: ${cssVar.colorTextSecondary};
  `,
  descriptionText_dark: css`
    color: ${cssVar.colorText};
  `,
  popover: css`
    .ant-popover-inner {
      background: ${cssVar.colorBgElevated};
    }
  `,
  popover_dark: css`
    .ant-popover-inner {
      background: ${cssVar.colorBgSpotlight};
    }
  `,
  priceText: css`
    font-weight: 500;
    color: ${cssVar.colorTextTertiary};
    word-break: keep-all;
    white-space: nowrap;
  `,
  provider: css`
    /* Ruled off from the model's own description below: the line above says which service
       serves this model, the paragraph below describes the model itself. */
    padding-block-end: 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /* The popover swaps to `colorBgSpotlight` in dark mode, where `colorBorderSecondary` is
     darker than the surface and the rule disappears entirely. */
  provider_dark: css`
    border-block-end-color: ${cssVar.colorTextQuaternary};
  `,
  /** Same ⓘ affordance the model picker uses for the same fact. */
  providerInfo: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    color: ${cssVar.colorTextSecondary};

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  providerInfo_dark: css`
    color: ${cssVar.colorTextLightSolid};
  `,
  providerName: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  providerName_dark: css`
    color: ${cssVar.colorText};
  `,
  priceText_dark: css`
    font-weight: 500;
    color: ${cssVar.colorTextLightSolid};
  `,
}));

export interface GenerationModelItemProps extends AiModelForSelect {
  /**
   * Which USD price fields to use: image uses approximatePricePerImage / pricePerImage; video uses approximatePricePerVideo / pricePerVideo.
   * @default 'image'
   */
  priceKind?: 'image' | 'video';
  /**
   * Provider ID for determining price display format (when showPrice is true)
   */
  providerId?: string;
  /**
   * Whether to show new model badge
   * @default true
   */
  showBadge?: boolean;
  /**
   * Whether to show popover on hover
   * @default true
   */
  showPopover?: boolean;
  /**
   * Whether to show price in popover (e.g. true for image, false for video)
   * @default false
   */
  showPrice?: boolean;
}

const GenerationModelItem = memo<GenerationModelItemProps>(
  ({
    approximatePricePerImage,
    approximatePricePerVideo,
    description,
    pricePerImage,
    pricePerVideo,
    providerId,
    showPopover = true,
    showBadge = true,
    showPrice = false,
    priceKind = 'image',
    ...model
  }) => {
    const isDarkMode = useIsDark();
    const { t } = useTranslation('components');
    /** Which service serves this model — the row itself only ever shows the model name. */
    const providerName = useProviderDisplayName(providerId);
    const providerDescription = useProviderDescription(providerId);
    const enableBusinessFeatures = useServerConfigStore(
      serverConfigSelectors.enableBusinessFeatures,
    );

    const priceLabel = useMemo(() => {
      if (!showPrice) return undefined;

      const isVideo = priceKind === 'video';
      const exactUsd = isVideo ? pricePerVideo : pricePerImage;
      const approxUsd = isVideo ? approximatePricePerVideo : approximatePricePerImage;

      if (enableBusinessFeatures && providerId === BRANDING_PROVIDER) {
        if (typeof exactUsd === 'number') {
          const credits = exactUsd * CREDITS_PER_DOLLAR;
          return t(
            isVideo
              ? 'GenerationModelItem.creditsPerVideoExact'
              : 'GenerationModelItem.creditsPerImageExact',
            { amount: numeral(credits).format('0,0') },
          );
        }
        if (typeof approxUsd === 'number') {
          const credits = approxUsd * CREDITS_PER_DOLLAR;
          return t(
            isVideo
              ? 'GenerationModelItem.creditsPerVideoApproximate'
              : 'GenerationModelItem.creditsPerImageApproximate',
            { amount: numeral(credits).format('0,0') },
          );
        }
      } else {
        if (typeof exactUsd === 'number') {
          return `${numeral(exactUsd).format('$0,0.00[000]')} / ${isVideo ? 'video' : 'image'}`;
        }
        if (typeof approxUsd === 'number') {
          return `~ ${numeral(approxUsd).format('$0,0.00[000]')} / ${isVideo ? 'video' : 'image'}`;
        }
      }
      return undefined;
    }, [
      showPrice,
      approximatePricePerImage,
      approximatePricePerVideo,
      enableBusinessFeatures,
      pricePerImage,
      pricePerVideo,
      priceKind,
      providerId,
      t,
    ]);

    const popoverContent = useMemo(() => {
      if (!description && !priceLabel && !providerDescription) return null;

      return (
        <Flexbox
          gap={8}
          style={{ maxHeight: POPOVER_MAX_HEIGHT, maxWidth: POPOVER_MAX_WIDTH, overflowY: 'auto' }}
        >
          {providerDescription && (
            /**
             * ONE line: which service serves this model. The description hangs off the same ⓘ
             * tooltip the model picker uses, so the popover's subject stays the model instead
             * of opening with a paragraph that repeats for every row in the group.
             */
            <Flexbox
              horizontal
              align={'center'}
              className={cx(styles.provider, isDarkMode && styles.provider_dark)}
              gap={6}
            >
              <ProviderIcon provider={providerId} size={14} type={'mono'} />
              {/* Nothing rather than a raw id: the icon already carries the identity, and a
                  custom provider whose row has not loaded has no name to print. */}
              {providerName && (
                <span className={cx(styles.providerName, isDarkMode && styles.providerName_dark)}>
                  {providerName}
                </span>
              )}
              <Tooltip
                {...nonInteractiveTooltipProps}
                placement={'right'}
                title={providerDescription}
              >
                <span
                  aria-hidden
                  className={cx(styles.providerInfo, isDarkMode && styles.providerInfo_dark)}
                >
                  <Icon icon={Info} size={12} />
                </span>
              </Tooltip>
              {/* The tooltip is a pointer affordance only; the copy is carried in visually
                  hidden text so it is announced with the name it qualifies. */}
              <span className={a11yStyles.srOnly}>{providerDescription}</span>
            </Flexbox>
          )}
          {description && (
            <Text className={cx(styles.descriptionText, isDarkMode && styles.descriptionText_dark)}>
              {description}
            </Text>
          )}
          {priceLabel && (
            <Text className={cx(styles.priceText, isDarkMode && styles.priceText_dark)}>
              {priceLabel}
            </Text>
          )}
        </Flexbox>
      );
    }, [description, priceLabel, providerDescription, providerId, providerName, isDarkMode]);

    const content = (
      <Flexbox horizontal align={'center'} gap={8} style={{ overflow: 'hidden' }}>
        <ModelIcon model={model.id} size={20} />
        <Text ellipsis title={model.displayName || model.id}>
          {model.displayName || model.id}
        </Text>
        {showBadge && <NewModelBadge releasedAt={model.releasedAt} />}
      </Flexbox>
    );

    if (!showPopover || !popoverContent) return content;

    return (
      <Popover
        classNames={{ root: cx(styles.popover, isDarkMode && styles.popover_dark) }}
        content={popoverContent}
        placement="rightTop"
      >
        {content}
      </Popover>
    );
  },
);

GenerationModelItem.displayName = 'GenerationModelItem';

export default GenerationModelItem;
