'use client';

import { Flexbox, Icon } from '@lobehub/ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import NavItem from '@/features/NavPanel/components/NavItem';
import type { PlatformPublishedSkill } from '@/types/platform/skills';

const styles = createStaticStyles(({ css, cssVar }) => ({
  badges: css`
    display: flex;
    flex-shrink: 0;
    gap: 4px;
  `,
  badge: css`
    padding-block: 1px;
    padding-inline: 5px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    font-size: 10px;
    line-height: 16px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

/** Minimal list shape — published catalog or admin draft list. */
export type PlatformSkillListPresentation = {
  displayName: string;
  distribution: PlatformPublishedSkill['distribution'] | string;
  source: PlatformPublishedSkill['source'] | string;
  /** When omitted, version badge is hidden (admin draft without version). */
  version?: string | null;
};

interface PlatformSkillItemProps {
  /** Extra badge strings after source/distribution/version (e.g. status). */
  extraBadges?: string[];
  isSelected?: boolean;
  onSelect: () => void;
  skill: PlatformSkillListPresentation;
  /**
   * When true, source/distribution use setting.platformSkills.* keys.
   * When false, raw values are shown (admin catalog).
   * @default true
   */
  translateBadges?: boolean;
}

const PlatformSkillItem = memo<PlatformSkillItemProps>(
  ({ extraBadges, isSelected, onSelect, skill, translateBadges = true }) => {
    const { t } = useTranslation('setting');

    const sourceLabel = translateBadges
      ? t(`platformSkills.source.${skill.source}` as never)
      : skill.source;
    const distributionLabel = translateBadges
      ? t(`platformSkills.distribution.${skill.distribution}` as never)
      : skill.distribution;

    return (
      <Flexbox gap={2}>
        <NavItem
          active={isSelected}
          icon={() => <Icon icon={SkillsIcon} size={18} />}
          title={skill.displayName}
          onClick={onSelect}
        />
        <div className={styles.badges}>
          <span className={styles.badge}>{sourceLabel}</span>
          <span className={styles.badge}>{distributionLabel}</span>
          {skill.version ? <span className={styles.badge}>v{skill.version}</span> : null}
          {extraBadges?.map((badge) => (
            <span className={styles.badge} key={badge}>
              {badge}
            </span>
          ))}
        </div>
      </Flexbox>
    );
  },
);

PlatformSkillItem.displayName = 'PlatformSkillItem';

export default PlatformSkillItem;
