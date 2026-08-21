import { BUILTIN_AGENT_SLUGS } from '../../types';

/**
 * Inbox Agent System Role Template
 *
 * This is the default assistant agent for general conversations.
 */
const systemRoleTemplate = `You are Lobe, an AI Agent will help users.

Today's date: {{date}}

Your role is to:
- Answer questions accurately and helpfully
- Assist with a wide variety of tasks
- Provide clear and concise explanations
- Be friendly and professional in your responses

Respond in the same language the user is using.`;

const LANGUAGE_LINE_PREFIX = 'Preferred reply language: ';
const LANGUAGE_LINE_SUFFIX = '. Use this language unless the user explicitly asks to switch.';

/**
 * BCP-47-ish locale tag as emitted by `createSystemRole` (`en-US`, `zh-CN`,
 * `ar`). Rejects spaces, extra sentences, or any other authored text.
 */
const LOCALE_TAG_RE = /^[A-Z]{2,3}(?:-[A-Z]{2,8})?$/i;

const preferredLanguageLine = (userLocale: string) =>
  `${LANGUAGE_LINE_PREFIX}${userLocale}${LANGUAGE_LINE_SUFFIX}`;

/** Drop trailing whitespace / newlines only — leading or inner edits stay. */
const normalizeTrailingWhitespace = (value: string) => value.replace(/\s+$/u, '');

export const createSystemRole = (userLocale?: string) =>
  [systemRoleTemplate, userLocale ? preferredLanguageLine(userLocale) : '']
    .filter(Boolean)
    .join('\n\n');

export const isInboxAgentSlug = (slug?: string | null): boolean =>
  slug === BUILTIN_AGENT_SLUGS.inbox;

/**
 * True when `systemRole` is exactly a stock inbox prompt (bare template, or
 * template + a well-formed preferred-language line). Locale-agnostic: a stock
 * role generated under `en-US` still matches after the user switches to
 * `zh-CN`. Anything else — extra lines, a changed word, injected text in the
 * language line — is customised.
 */
export const isUnmodifiedInboxSystemRole = (
  systemRole?: string | null,
  userLocale?: string,
): boolean => {
  if (!systemRole) return false;

  const role = normalizeTrailingWhitespace(systemRole);
  if (!role) return false;

  const baseline = createSystemRole();
  if (role === baseline) return true;
  if (userLocale && role === createSystemRole(userLocale)) return true;

  if (!role.startsWith(baseline)) return false;

  const rest = role.slice(baseline.length);
  const languagePrefix = `\n\n${LANGUAGE_LINE_PREFIX}`;
  if (!rest.startsWith(languagePrefix) || !rest.endsWith(LANGUAGE_LINE_SUFFIX)) return false;

  const tag = rest.slice(languagePrefix.length, rest.length - LANGUAGE_LINE_SUFFIX.length);
  if (!LOCALE_TAG_RE.test(tag)) return false;

  return role === createSystemRole(tag);
};

/**
 * Web-app providers skip the unmodified builtin inbox role so it is not
 * folded into the user turn. Callers must still gate on `settings.webApp`;
 * this helper only answers "is this the stock inbox prompt on the inbox
 * agent".
 */
export const shouldOmitBuiltinInboxSystemRole = ({
  agentSlug,
  systemRole,
  userLocale,
}: {
  agentSlug?: string | null;
  systemRole?: string | null;
  userLocale?: string;
}): boolean => isInboxAgentSlug(agentSlug) && isUnmodifiedInboxSystemRole(systemRole, userLocale);
