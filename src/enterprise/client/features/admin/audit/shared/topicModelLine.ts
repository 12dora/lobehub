import { getModelDisplayName } from '@/utils/modelLabels';

interface TopicModelSource {
  agentId?: string | null;
  model?: string | null;
  provider?: string | null;
}

/**
 * `provider · model · agent` as shown on every conversation evidence surface. The em dash keeps
 * the row height stable when a topic carries no model attribution at all.
 */
export const formatTopicModelLine = (
  providerLabel: (providerId: string | null | undefined) => string,
  topic: TopicModelSource,
): string =>
  [providerLabel(topic.provider), getModelDisplayName(topic.model, topic.provider), topic.agentId]
    .filter(Boolean)
    .join(' · ') || '—';
