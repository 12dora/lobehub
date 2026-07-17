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

interface PlatformSkillItemProps {
  isSelected?: boolean;
  onSelect: () => void;
  skill: PlatformPublishedSkill;
}

const PlatformSkillItem = memo<PlatformSkillItemProps>(({ isSelected, onSelect, skill }) => {
  const { t } = useTranslation('setting');

  return (
    <Flexbox gap={2}>
      <NavItem
        active={isSelected}
        icon={() => <Icon icon={SkillsIcon} size={18} />}
        title={skill.displayName}
        onClick={onSelect}
      />
      <div className={styles.badges}>
        <span className={styles.badge}>{t(`platformSkills.source.${skill.source}` as never)}</span>
        <span className={styles.badge}>
          {t(`platformSkills.distribution.${skill.distribution}` as never)}
        </span>
        <span className={styles.badge}>v{skill.version}</span>
      </div>
    </Flexbox>
  );
});

PlatformSkillItem.displayName = 'PlatformSkillItem';

export default PlatformSkillItem;
