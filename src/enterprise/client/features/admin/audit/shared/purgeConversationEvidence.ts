'use client';

import { mutate } from '@/libs/swr';

import {
  ADMIN_AUDIT_CONVERSATIONS_GET_KEY,
  ADMIN_AUDIT_CONVERSATIONS_LIST_KEY,
  ADMIN_AUDIT_CONVERSATIONS_MESSAGES_KEY,
  ADMIN_AUDIT_USERS_TIMELINE_KEY,
} from '../swrKeys';

const EVIDENCE_KEY_PREFIXES = new Set<string>([
  ADMIN_AUDIT_CONVERSATIONS_GET_KEY,
  ADMIN_AUDIT_CONVERSATIONS_LIST_KEY,
  ADMIN_AUDIT_CONVERSATIONS_MESSAGES_KEY,
  ADMIN_AUDIT_USERS_TIMELINE_KEY,
]);

/**
 * True for any conversation-list / topic-detail / message / timeline SWR key,
 * including cursor, topic, filter, page-size, body-mode, and workspace suffixes.
 */
export const isAuditConversationEvidenceKey = (key: unknown): boolean =>
  Array.isArray(key) && typeof key[0] === 'string' && EVIDENCE_KEY_PREFIXES.has(key[0]);

/**
 * Drop every cached conversation-evidence page and revalidate mounted subscribers.
 * Bound `mutate` only reaches the active key; revisiting an earlier cursor/topic
 * would otherwise serve a stale `'off'` payload. Evict (`undefined`) so unmounted
 * keys also start empty on the next mount.
 */
export const purgeAuditConversationEvidenceCaches = (): Promise<unknown> =>
  mutate(isAuditConversationEvidenceKey, undefined, { revalidate: true });
