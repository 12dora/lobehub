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
 * Map a stored / payload effort onto the five web-UI levels. Only those five
 * tokens remap a family id; missing or unknown values leave the bare family
 * slug alone (a stale agent without `chatgptWebReasoningEffort` must not
 * default to Medium).
 */
const parseFamilyLevel = (effort: string | undefined | null): ChatGPTWebFamilyLevel | undefined => {
  const normalized = String(effort ?? '')
    .trim()
    .toLowerCase();
  if (FAMILY_LEVELS.has(normalized)) return normalized as ChatGPTWebFamilyLevel;
  return undefined;
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
 * Verified against real Chrome captures 2026-08-21: Medium / High / Extra-high
 * = `{family}-thinking` + `standard` / `extended` / `max`; Pro = `{family}-pro`
 * + `standard` (2026-08-19 capture); Instant = `{family}-instant` inferred from
 * the `/models` slug list (no capture). `system_hints` is `[]` on all thinking
 * turns — effort is never expressed via hints.
 *
 * Family ids (`gpt-5-6`, `gpt-5-5`, …) follow the web UI picker: a level
 * changes BOTH the slug and the effort field — but only when the value is one
 * of the five family levels. A family id with no (or unknown) field is sent
 * as the bare slug with no `thinking_effort`.
 *
 * `o3`, `auto`, `*-instant`, and `*-mini` never send `thinking_effort`.
 * `*-pro` always sends `standard` (leftover values are ignored).
 * Legacy `*-thinking` still aliases a leftover via {@link normalizeThinkingEffort}.
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
    const level = parseFamilyLevel(effort);
    if (!level) return { model };
    return FAMILY_TURN[level](model);
  }

  if (model.endsWith('-pro')) {
    return { model, thinkingEffort: 'standard' };
  }

  if (model === 'auto' || model.endsWith('-instant') || model.endsWith('-mini')) {
    return { model };
  }

  if (model.endsWith('-thinking')) {
    const thinkingEffort = normalizeThinkingEffort(effort);
    return thinkingEffort ? { model, thinkingEffort } : { model };
  }

  return { model };
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
