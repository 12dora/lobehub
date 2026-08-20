import { ActionIcon, Flexbox, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { Lightbulb, RefreshCw } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { usePlatformAgentTemplates } from '@/enterprise/client/hooks/usePlatformAgentTemplates';
import { useRandomQuestions } from '@/routes/(main)/home/features/SuggestQuestions/useRandomQuestions';

import ExampleItem from './ExampleItem';
import { type CreateAgentExampleCard, resolveCreateAgentExamplesView } from './resolveExamples';

export interface CreateAgentExamplesProps {
  onExampleClick: (prompt: string) => void;
  /** `agent` consults the platform catalog; `group` always uses the locale pool. */
  suggestMode: 'agent' | 'group';
}

/**
 * Example grid under the create-agent / create-group modal.
 *
 * For agents the platform catalog wins when an operator authored one (admin order, no refresh —
 * the order is the product). Otherwise, and always for groups, the built-in locale pool is
 * shuffled exactly as before.
 */
const CreateAgentExamples = memo<CreateAgentExamplesProps>(({ suggestMode, onExampleClick }) => {
  const { t: tCommon } = useTranslation('common');
  const { t: tSuggest } = useTranslation('suggestQuestions');
  const { questions, refresh } = useRandomQuestions(suggestMode);
  const platform = usePlatformAgentTemplates();

  const view = resolveCreateAgentExamplesView({ mode: suggestMode, platform });

  if (view.kind === 'hidden') return null;

  const cards: CreateAgentExampleCard[] =
    view.kind === 'platform'
      ? view.cards
      : questions.map((item) => {
          const prompt = tSuggest(item.promptKey as any);
          return {
            description: prompt,
            id: String(item.id),
            prompt,
            title: tSuggest(item.titleKey as any),
          };
        });

  if (cards.length === 0) return null;

  return (
    <Flexbox gap={16}>
      <Flexbox horizontal align={'center'} justify={'space-between'}>
        <Flexbox horizontal align={'center'} gap={8}>
          <Lightbulb color={cssVar.colorTextDescription} size={18} />
          <Text color={cssVar.colorTextSecondary}>{tCommon('home.suggestQuestions')}</Text>
        </Flexbox>
        {/* Platform-managed cards are an authored, ordered list — there is nothing to reshuffle. */}
        {view.kind === 'locale' ? (
          <Flexbox
            horizontal
            align={'center'}
            gap={4}
            style={{ cursor: 'pointer' }}
            onClick={refresh}
          >
            <ActionIcon icon={RefreshCw} size={'small'} />
            <Text color={cssVar.colorTextSecondary} fontSize={12}>
              {tCommon('switch')}
            </Text>
          </Flexbox>
        ) : null}
      </Flexbox>
      <Flexbox gap={12} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' }}>
        {cards.map((card) => (
          <ExampleItem
            avatar={card.avatar}
            backgroundColor={card.backgroundColor}
            description={card.description}
            key={card.id}
            prompt={card.prompt}
            title={card.title}
            onClick={onExampleClick}
          />
        ))}
      </Flexbox>
    </Flexbox>
  );
});

CreateAgentExamples.displayName = 'CreateAgentExamples';

export default CreateAgentExamples;
export { default as ExampleItem } from './ExampleItem';
export * from './resolveExamples';
