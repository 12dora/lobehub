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

const PREFERRED_LANGUAGE_LINE =
  'Preferred reply language: ${userLocale}. Use this language unless the user explicitly asks to switch.';

/**
 * Trailing locale instruction appended by `createSystemRole` when a locale is
 * known. Matched independently of the actual locale so webApp callers can
 * detect the unmodified builtin role without threading userLocale through.
 */
const INBOX_LOCALE_SUFFIX =
  /\n\nPreferred reply language: .+\. Use this language unless the user explicitly asks to switch\.\s*$/;

export const createSystemRole = (userLocale?: string) =>
  [
    systemRoleTemplate,
    userLocale ? PREFERRED_LANGUAGE_LINE.replace('${userLocale}', userLocale) : '',
  ]
    .filter(Boolean)
    .join('\n\n');

export const isInboxAgentSlug = (slug?: string | null): boolean =>
  slug === BUILTIN_AGENT_SLUGS.inbox;

/**
 * True when `systemRole` is the stock inbox prompt (with or without the
 * preferred-language suffix). A user-edited inbox prompt — or any other
 * agent prompt — returns false so it is preserved verbatim.
 */
export const isUnmodifiedInboxSystemRole = (
  systemRole?: string | null,
  userLocale?: string,
): boolean => {
  if (!systemRole) return false;

  const role = systemRole.trim();
  if (!role) return false;

  const baseline = createSystemRole().trim();
  if (role === baseline) return true;
  if (userLocale && role === createSystemRole(userLocale).trim()) return true;

  return role.startsWith(baseline) && INBOX_LOCALE_SUFFIX.test(role.slice(baseline.length));
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
