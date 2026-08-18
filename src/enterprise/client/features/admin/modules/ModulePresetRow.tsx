'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_MODULE_PRESETS, type PlatformModulePreset } from '@/const/platform/modules';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    cursor: pointer;

    display: flex;
    flex: 1 1 180px;
    flex-direction: column;
    gap: 4px;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    text-align: start;

    background: ${cssVar.colorBgContainer};

    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }

    /* Soft filled selected state — hue-independent, no outline ring. Matches the
       stat cards above the operation-log table. */
    &[data-active='true'] {
      border-color: transparent;
      background: ${cssVar.colorFillTertiary};
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    /* Last: the selected card must keep its fill while hovered, so this is scoped
       narrower than both rules above and therefore has to follow them. */
    &:hover:not(:disabled, [data-active='true']) {
      background: ${cssVar.colorFillQuaternary};
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  `,
  custom: css`
    display: flex;
    flex: 1 1 180px;
    flex-direction: column;
    gap: 4px;
    justify-content: center;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px dashed ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    transition:
      background 0.15s ease,
      border-color 0.15s ease;

    &[data-active='true'] {
      border-color: transparent;
      background: ${cssVar.colorFillTertiary};
    }
  `,
  root: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  `,
}));

export interface ModulePresetRowProps {
  /** Preset the draft currently equals; null renders the 自定义 state as active. */
  activePreset: PlatformModulePreset | null;
  disabled: boolean;
  onSelect: (preset: PlatformModulePreset) => void;
}

/**
 * Presets are a starting point, not a mode: picking one only rewrites the draft, and every
 * switch below stays free afterwards. The 自定义 card lights up on its own once the selection
 * stops matching any preset, so the operator always knows which of the two they are in.
 */
const ModulePresetRow = memo<ModulePresetRowProps>(({ activePreset, disabled, onSelect }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.root}>
      {PLATFORM_MODULE_PRESETS.map((preset) => (
        <button
          className={styles.card}
          data-active={activePreset === preset}
          disabled={disabled}
          key={preset}
          type="button"
          onClick={() => onSelect(preset)}
        >
          <Text strong>{t(`modules.presets.${preset}.title` as never)}</Text>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t(`modules.presets.${preset}.desc` as never)}
          </Text>
        </button>
      ))}
      <div className={styles.custom} data-active={activePreset === null}>
        <Text strong>{t('modules.presets.custom.title')}</Text>
        <Text style={{ fontSize: 12 }} type="secondary">
          {t('modules.presets.custom.desc')}
        </Text>
      </div>
    </div>
  );
});

ModulePresetRow.displayName = 'AdminModulePresetRow';

export default ModulePresetRow;
