import type { TopicReferenceItem } from '../../providers/TopicReferenceContextInjector';
import {
  parseReferTopicTags,
  type TopicLookupResult,
  type TopicMessageItem,
} from './resolveTopicReferences';

/** Max recent messages to fetch as fallback — same as the legacy resolver. */
const MAX_RECENT_MESSAGES = 5;
/** Max characters per message content — same as the legacy resolver. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Batch lookups: one topics `IN (...)` and one messages `IN (...)`.
 * Missing / forbidden ids are omitted from the maps (same as a null per-id lookup).
 */
export interface TopicReferenceBatchLookups {
  lookupMessages?: (topicIds: string[]) => Promise<ReadonlyMap<string, TopicMessageItem[]>>;
  lookupTopics: (
    topicIds: string[],
  ) => Promise<ReadonlyMap<string, TopicLookupResult | null | undefined>>;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

const toRecentMessages = (allMessages: TopicMessageItem[]) =>
  allMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_RECENT_MESSAGES)
    .map((m) => ({
      content: truncate((m.content as string).trim(), MAX_MESSAGE_LENGTH),
      role: m.role,
    }));

/**
 * Batch form of {@link resolveTopicReferences}: one topics lookup + one messages
 * lookup. Behaviour for missing/forbidden topics matches the per-id path.
 */
export async function resolveTopicReferencesBatch(
  messages: Array<{ content: string | unknown }>,
  lookups: TopicReferenceBatchLookups,
): Promise<TopicReferenceItem[] | undefined> {
  const parsed = parseReferTopicTags(messages);
  if (parsed.length === 0) return undefined;

  let topicMap: ReadonlyMap<string, TopicLookupResult | null | undefined>;
  try {
    topicMap = await lookups.lookupTopics(parsed.map((item) => item.topicId));
  } catch {
    return parsed.map(({ topicId, topicTitle }) => ({ topicId, topicTitle }));
  }

  const needMessageIds = parsed
    .filter((item) => !topicMap.get(item.topicId)?.historySummary)
    .map((item) => item.topicId);

  let messageMap: ReadonlyMap<string, TopicMessageItem[]> = new Map();
  if (lookups.lookupMessages && needMessageIds.length > 0) {
    try {
      messageMap = await lookups.lookupMessages(needMessageIds);
    } catch {
      // fallthrough to no-context per topic
    }
  }

  const refs: TopicReferenceItem[] = [];
  for (const { topicId, topicTitle } of parsed) {
    const topic = topicMap.get(topicId);
    const title = topic?.title || topicTitle;

    if (topic?.historySummary) {
      refs.push({ summary: topic.historySummary, topicId, topicTitle: title });
      continue;
    }

    const recent = toRecentMessages(messageMap.get(topicId) ?? []);
    if (recent.length > 0) {
      refs.push({ recentMessages: recent, topicId, topicTitle: title });
      continue;
    }

    refs.push({ topicId, topicTitle: title });
  }

  return refs.length > 0 ? refs : undefined;
}
