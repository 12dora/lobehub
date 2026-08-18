import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { type AiProviderListItem, AiProviderSourceEnum } from '@/types/aiProvider';

/**
 * Ids the model-bank ships a card for, resolved once at module load: a Set so a long provider
 * list does not pay a linear scan per rendered row.
 */
const BUILTIN_PROVIDER_IDS = new Set(DEFAULT_MODEL_PROVIDER_LIST.map((card) => card.id));

/**
 * Whether a provider row is named by the platform rather than by the operator.
 *
 * Two signals, because neither alone is trustworthy: `source` is NULLABLE in the database
 * (rows written before the column existed carry nothing), so trusting it alone made every
 * legacy row look custom; and a card id alone would miss a builtin the catalog has since
 * dropped. A row is builtin when it says so, or when the id still has a card.
 *
 * Everything else — including a custom row whose `source` was never written — is the
 * operator's own, and keeps the name they gave it.
 */
export const isBuiltinProviderRow = (
  id: string,
  source?: AiProviderListItem['source'] | null,
): boolean => source === AiProviderSourceEnum.Builtin || BUILTIN_PROVIDER_IDS.has(id);
