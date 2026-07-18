import { Flexbox, Input, Text, TextArea } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useTranslation } from 'react-i18next';

import type { AdminAgentDraft } from './types';

const styles = createStaticStyles(({ css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
  `,
  label: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface AgentEditorFieldsProps {
  draft: AdminAgentDraft;
  editable: boolean;
  onChange: (updater: (draft: AdminAgentDraft) => AdminAgentDraft) => void;
}

const FieldLabel = ({ children }: { children: string }) => (
  <Text className={styles.label}>{children}</Text>
);

export const AgentEditorFields = ({ draft, editable, onChange }: AgentEditorFieldsProps) => {
  const { t } = useTranslation('admin');
  const patchConfig = <Key extends keyof AdminAgentDraft['config']>(
    key: Key,
    value: AdminAgentDraft['config'][Key],
  ) => onChange((current) => ({ ...current, config: { ...current.config, [key]: value } }));

  return (
    <Flexbox gap={16}>
      <div className={styles.grid}>
        <Flexbox gap={6}>
          <FieldLabel>{t('agentCatalog.editor.version')}</FieldLabel>
          <Input
            disabled={!editable}
            value={draft.version}
            onChange={(event) =>
              onChange((current) => ({ ...current, version: event.target.value }))
            }
          />
        </Flexbox>
        <Flexbox gap={6}>
          <FieldLabel>{t('agentCatalog.editor.displayName')}</FieldLabel>
          <Input
            disabled={!editable}
            value={draft.config.displayName}
            onChange={(event) => patchConfig('displayName', event.target.value)}
          />
        </Flexbox>
      </div>
      <Flexbox gap={6}>
        <FieldLabel>{t('agentCatalog.editor.description')}</FieldLabel>
        <TextArea
          disabled={!editable}
          rows={2}
          value={draft.config.description ?? ''}
          onChange={(event) => patchConfig('description', event.target.value || null)}
        />
      </Flexbox>
      <Flexbox gap={6}>
        <FieldLabel>{t('agentCatalog.editor.systemRole')}</FieldLabel>
        <TextArea
          disabled={!editable}
          rows={8}
          value={draft.config.systemRole}
          onChange={(event) => patchConfig('systemRole', event.target.value)}
        />
      </Flexbox>
      <Flexbox gap={6}>
        <FieldLabel>{t('agentCatalog.editor.openingMessage')}</FieldLabel>
        <TextArea
          disabled={!editable}
          rows={2}
          value={draft.config.openingMessage ?? ''}
          onChange={(event) => patchConfig('openingMessage', event.target.value || null)}
        />
      </Flexbox>
      <Flexbox gap={6}>
        <FieldLabel>{t('agentCatalog.editor.questions')}</FieldLabel>
        <TextArea
          disabled={!editable}
          rows={3}
          value={draft.config.openingQuestions.join('\n')}
          onChange={(event) =>
            patchConfig(
              'openingQuestions',
              event.target.value
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean),
            )
          }
        />
      </Flexbox>
    </Flexbox>
  );
};
