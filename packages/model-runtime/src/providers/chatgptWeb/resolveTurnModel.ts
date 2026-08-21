import { normalizeThinkingEffort } from './requestBuilders';
import type { ThinkingEffort } from './types';

/** Bare GPT-5.x family id advertised by the ChatGPT web UI (`gpt-5-6`, `gpt-5-5`, …). */
export const CHATGPT_WEB_FAMILY_BASE_RE = /^gpt-5-\d+$/;

/** Instant / thinking / Pro SKUs that collapse into a family card. */
export const CHATGPT_WEB_FAMILY_SKU_RE = /^(gpt-5-\d+)-(instant|thinking|pro)$/;

export type ChatGPTWebFamilyLevel = 'instant' | 'medium' | 'high' | 'xhigh' | 'pro';

export interface ChatGPTWebTurn {
  model: string;
  thinkingEffort?: ThinkingEffort;
}

export const isChatGPTWebFamilyId = (model: string): boolean =>
  CHATGPT_WEB_FAMILY_BASE_RE.test(model);

/**
 * The family id a live slug belongs to, or `undefined` when the slug is not a
 * GPT-5.x family member (`o3`, minis, `auto`, …).
 */
export const chatgptWebFamilyBase = (slug: string): string | undefined => {
  if (CHATGPT_WEB_FAMILY_BASE_RE.test(slug)) return slug;
  const match = slug.match(CHATGPT_WEB_FAMILY_SKU_RE);
  return match?.[1];
};

const FAMILY_LEVELS = new Set<string>(['instant', 'medium', 'high', 'xhigh', 'pro']);

/**
 * Map a stored / payload effort onto the five web-UI levels. Missing values
 * default to Medium (the chatgpt.com default). Unknown tokens fall through to
 * Medium rather than leaking onto the wire.
 */
const resolveFamilyLevel = (effort: string | undefined | null): ChatGPTWebFamilyLevel => {
  const normalized = String(effort ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return 'medium';
  if (FAMILY_LEVELS.has(normalized)) return normalized as ChatGPTWebFamilyLevel;
  return 'medium';
};

const FAMILY_TURN: Record<ChatGPTWebFamilyLevel, (family: string) => ChatGPTWebTurn> = {
  instant: (family) => ({ model: `${family}-instant` }),
  medium: (family) => ({ model: `${family}-thinking`, thinkingEffort: 'standard' }),
  high: (family) => ({ model: `${family}-thinking`, thinkingEffort: 'extended' }),
  xhigh: (family) => ({ model: `${family}-thinking`, thinkingEffort: 'max' }),
  pro: (family) => ({ model: `${family}-pro`, thinkingEffort: 'standard' }),
};

/**
 * Resolve the chatgpt.com wire model + `thinking_effort` for one turn.
 *
 * Family ids (`gpt-5-6`, `gpt-5-5`, …) follow the web UI picker: a level
 * changes BOTH the slug and the effort field. `o3` has no effort control.
 * Legacy SKU ids (`-instant` / `-thinking` / `-pro` / `-mini`, `auto`) pass
 * through; `thinking_effort` is still aliased by {@link normalizeThinkingEffort}.
 */
export const resolveChatGPTWebTurn = ({
  model,
  effort,
}: {
  effort?: string | null;
  model: string;
}): ChatGPTWebTurn => {
  if (model === 'o3') return { model: 'o3' };

  if (isChatGPTWebFamilyId(model)) {
    return FAMILY_TURN[resolveFamilyLevel(effort)](model);
  }

  const thinkingEffort = normalizeThinkingEffort(effort);
  return thinkingEffort ? { model, thinkingEffort } : { model };
};

const FAMILY_TITLE_SUFFIXES = [' Instant', ' Thinking', ' Pro'] as const;

/**
 * Display name for a live family that is not yet in the model-bank. Prefer the
 * bare family's own title; otherwise strip Instant / Thinking / Pro from a
 * SKU title.
 */
export const deriveChatGPTWebFamilyDisplayName = (
  base: string,
  members: readonly { slug: string; title?: string }[],
): string => {
  const own = members.find((member) => member.slug === base)?.title?.trim();
  if (own) return own;

  for (const member of members) {
    const title = member.title?.trim();
    if (!title) continue;
    for (const suffix of FAMILY_TITLE_SUFFIXES) {
      if (title.endsWith(suffix)) return title.slice(0, -suffix.length);
    }
    return title;
  }

  return base;
};
