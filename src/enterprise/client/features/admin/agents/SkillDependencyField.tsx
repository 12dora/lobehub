'use client';

import type { PlatformAgentSkillDependencyRef } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { FieldLabel, RetryAction, RevalidatingHint } from './dependencyEditorShared';

const SKILL_SELECT_ID = 'admin-agent-editor-skills';

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
  /** The whole selection after a pick or an unpick — one control, one change. */
  onChange: (skillKeys: string[]) => void;
  onRemove: (skillKey: string) => void;
  /** Every published Skill plus the referenced ones the catalog no longer offers. */
  skillOptions: SelectOption[];
  skills: SwrSlice;
  skillsSettled: boolean;
  staleSkills: string[];
  value: PlatformAgentSkillDependencyRef[];
}

export const SkillDependencyField = ({
  editable,
  onChange,
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
      <FieldLabel htmlFor={SKILL_SELECT_ID}>{t('agentCatalog.dependency.skill.title')}</FieldLabel>
      {/* One searchable control that both picks and shows what is picked. */}
      <Select
        showSearch
        aria-label={t('agentCatalog.dependency.skill.add')}
        disabled={!editable || !skillsSettled}
        id={SKILL_SELECT_ID}
        mode="multiple"
        options={skillOptions}
        value={value.map((skill) => skill.skillKey)}
        placeholder={
          skills.isLoading
            ? t('agentCatalog.dependency.loading')
            : t('agentCatalog.dependency.skill.add')
        }
        onChange={(next) => onChange(Array.isArray(next) ? (next as string[]) : [])}
      />
      {/* A Skill the catalog no longer publishes blocks Save, so it gets its own way out. */}
      {value
        .filter((skill) => staleSkills.includes(skill.skillKey))
        .map((skill) => (
          <Flexbox horizontal align="center" gap={8} justify="space-between" key={skill.skillKey}>
            <Flexbox horizontal align="center" gap={8}>
              <Text>
                {skill.skillKey} · {skill.version}
              </Text>
              <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
            </Flexbox>
            {editable ? (
              <Button size="small" onClick={() => onRemove(skill.skillKey)}>
                {t('agentCatalog.dependency.skill.remove')}
              </Button>
            ) : null}
          </Flexbox>
        ))}
      {value.length > 0 && skills.isValidating && skills.data ? <RevalidatingHint /> : null}
    </Flexbox>
  );
};
