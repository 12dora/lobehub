'use client';

import type { PlatformAgentSkillDependencyRef } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { RetryAction, RevalidatingHint } from './dependencyEditorShared';

interface SelectOption {
  label: string;
  value: string;
}

interface SwrSlice {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
  isValidating?: boolean;
  mutate: () => Promise<unknown>;
}

export interface SkillDependencyFieldProps {
  editable: boolean;
  onAdd: (skillKey: string | undefined) => void;
  onRemove: (skillKey: string) => void;
  skillOptions: SelectOption[];
  skills: SwrSlice;
  skillsSettled: boolean;
  staleSkills: string[];
  value: PlatformAgentSkillDependencyRef[];
}

export const SkillDependencyField = ({
  editable,
  onAdd,
  onRemove,
  skillOptions,
  skills,
  skillsSettled,
  staleSkills,
  value,
}: SkillDependencyFieldProps) => {
  const { t } = useTranslation('admin');

  if (skills.error) {
    return (
      <Flexbox gap={8}>
        <Text as="h4" fontSize={14} weight={600}>
          {t('agentCatalog.dependency.skill.title')}
        </Text>
        <Alert
          showIcon
          action={<RetryAction mutate={skills.mutate} />}
          message={t('agentCatalog.dependency.skill.loadError')}
          type="error"
        />
      </Flexbox>
    );
  }

  return (
    <Flexbox gap={8}>
      <Text as="h4" fontSize={14} weight={600}>
        {t('agentCatalog.dependency.skill.title')}
      </Text>
      <Flexbox gap={8}>
        {value.length === 0 ? (
          <Text type="secondary">{t('agentCatalog.dependency.skill.empty')}</Text>
        ) : (
          value.map((skill) => (
            <Flexbox horizontal align="center" gap={8} justify="space-between" key={skill.skillKey}>
              <Flexbox gap={2}>
                <Flexbox horizontal align="center" gap={8}>
                  <Text>
                    {skill.skillKey} · {skill.version}
                  </Text>
                  {staleSkills.includes(skill.skillKey) ? (
                    <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
                  ) : null}
                </Flexbox>
              </Flexbox>
              {editable ? (
                <Button size="small" onClick={() => onRemove(skill.skillKey)}>
                  {t('agentCatalog.dependency.skill.remove')}
                </Button>
              ) : null}
            </Flexbox>
          ))
        )}
        {editable ? (
          <Select
            aria-label={t('agentCatalog.dependency.skill.add')}
            disabled={!skillsSettled}
            options={skillOptions}
            value={null}
            placeholder={
              skills.isLoading
                ? t('agentCatalog.dependency.loading')
                : t('agentCatalog.dependency.skill.add')
            }
            onChange={(next) => onAdd(next as string | undefined)}
          />
        ) : null}
        {value.length > 0 && skills.isValidating && skills.data ? <RevalidatingHint /> : null}
      </Flexbox>
    </Flexbox>
  );
};
