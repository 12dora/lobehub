'use client';

import { Center, Empty } from '@lobehub/ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { usePublishedSkillCatalog } from '@/enterprise/client/features/skills';

import PlatformSkillItem from './PlatformSkillItem';
import type { ToolDetailType } from './SkillDetail';

interface PlatformSkillListProps {
  onSelect?: (identifier: string, type: ToolDetailType) => void;
  selectedIdentifier?: string;
}

const PlatformSkillList = memo<PlatformSkillListProps>(({ onSelect, selectedIdentifier }) => {
  const { t } = useTranslation('setting');
  const catalog = usePublishedSkillCatalog(true);

  if (catalog.error && !catalog.data) {
    return (
      <Center paddingBlock={48}>
        <AsyncError error={catalog.error} variant="block" onRetry={() => void catalog.mutate()} />
      </Center>
    );
  }
  if (catalog.isLoading && !catalog.data) {
    return <Loading debugId="Settings > Skill > Published catalog" />;
  }
  if (!catalog.data?.skills.length) {
    return (
      <Center paddingBlock={48}>
        <Empty
          description={t('platformSkills.empty.desc')}
          icon={SkillsIcon}
          title={t('platformSkills.empty.title')}
        />
      </Center>
    );
  }
  const catalogData = catalog.data;

  return (
    <div>
      {catalog.error ? (
        <AsyncError error={catalog.error} variant="block" onRetry={() => void catalog.mutate()} />
      ) : null}
      {catalogData.skills.map((skill) => (
        <PlatformSkillItem
          isSelected={selectedIdentifier === skill.skillKey}
          key={`${catalogData.revision}:${skill.skillKey}`}
          skill={skill}
          onSelect={() => onSelect?.(skill.skillKey, 'platform-skill')}
        />
      ))}
    </div>
  );
});

PlatformSkillList.displayName = 'PlatformSkillList';

export default PlatformSkillList;
