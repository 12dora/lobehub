/**
 * Resume-leg request construction and retry policy for the ChatGPT Web protocol
 * client. The backoff schedule and the retry count are one value: retries are
 * always `RESUME_BACKOFF_MS.length`.
 */

import { randomUuid } from './binary';
import { PATHS } from './constants';
import { isChatGPTWebError } from './errors';
import { sanitizeHeaderValue } from './headers';
import type { ConversationEvent } from './types';

/** Backoff between resume attempts (network / 5xx only). */
export const RESUME_BACKOFF_MS = [300, 700, 1500];

const RESUME_RETRIES = RESUME_BACKOFF_MS.length;

export interface LegRequest {
  body: string;
  context: string;
  headers: Record<string, string>;
  path: string;
  /** Retries allowed while ESTABLISHING this leg (network / 5xx). */
  retries?: number;
}

export interface LegState {
  conversationId?: string;
  handoff?: Extract<ConversationEvent, { type: 'handoff' }>;
  resumeToken?: string;
  sawOutput: boolean;
}

export const isRetryableLegError = (error: unknown): boolean => {
  if (!isChatGPTWebError(error)) return false;
  return error.kind === 'network' || (error.status ?? 0) >= 500;
};

export const buildResumeLeg = ({
  conversationId,
  offset = 0,
  resumeToken,
}: {
  conversationId: string;
  offset?: number;
  resumeToken: string;
}): LegRequest => ({
  body: JSON.stringify({ conversation_id: conversationId, offset }),
  context: 'conversation_resume',
  headers: {
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Conduit-Token': sanitizeHeaderValue(resumeToken),
    'X-Oai-Turn-Trace-Id': randomUuid(),
  },
  path: PATHS.fConversationResume,
  retries: RESUME_RETRIES,
});
