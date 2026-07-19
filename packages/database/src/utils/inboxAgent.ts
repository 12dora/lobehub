import { DEFAULT_INBOX_AVATAR, DEFAULT_INBOX_TITLE, INBOX_SESSION_ID } from '@lobechat/const';

interface InboxAgentIdentity {
  slug?: string | null;
}

interface InboxAgentMeta {
  avatar: string | null;
  title: string | null;
}

const isBlank = (value: string | null | undefined) => !value || value.trim().length === 0;

export const isInboxAgentIdentity = ({ slug }: InboxAgentIdentity) => slug === INBOX_SESSION_ID;

export function normalizeInboxAgentTitle(
  title: string | null,
  identity: InboxAgentIdentity,
  fallbackTitle?: string | null,
): string | null;
export function normalizeInboxAgentTitle(
  title: string | null | undefined,
  identity: InboxAgentIdentity,
  fallbackTitle?: string | null,
): string | null | undefined;
export function normalizeInboxAgentTitle(
  title: string | null | undefined,
  identity: InboxAgentIdentity,
  fallbackTitle: string | null = DEFAULT_INBOX_TITLE,
) {
  if (!isInboxAgentIdentity(identity) || !isBlank(title)) return title;
  if (fallbackTitle === null) return title;

  return isBlank(fallbackTitle) ? DEFAULT_INBOX_TITLE : fallbackTitle;
}

export function normalizeInboxAgentAvatar(
  avatar: string | null,
  identity: InboxAgentIdentity,
): string | null;
export function normalizeInboxAgentAvatar(
  avatar: string | null | undefined,
  identity: InboxAgentIdentity,
): string | null | undefined;
export function normalizeInboxAgentAvatar(
  avatar: string | null | undefined,
  identity: InboxAgentIdentity,
) {
  return isInboxAgentIdentity(identity) && isBlank(avatar) ? DEFAULT_INBOX_AVATAR : avatar;
}

export const normalizeInboxAgentMeta = <T extends InboxAgentMeta>(
  agent: T,
  identity: InboxAgentIdentity = agent as T & InboxAgentIdentity,
  fallbackTitle?: string | null,
): T => ({
  ...agent,
  avatar: normalizeInboxAgentAvatar(agent.avatar, identity),
  title: normalizeInboxAgentTitle(agent.title, identity, fallbackTitle),
});
