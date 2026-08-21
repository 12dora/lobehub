import { CURSOR_CONVERSATION_HEADER } from '@lobechat/model-runtime';

import { jsonError } from './transport.gate';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200_000;
const MAX_HISTORY_MESSAGES = 400;
const MAX_HISTORY_TEXT_CHARS = 400_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_DECODED_BYTES = 6 * 1024 * 1024;
const MAX_MODEL_ID_CHARS = 256;
const MODEL_ID_RE = /^[a-z0-9][\w.:\-[\]=,]*$/i;
/**
 * `--new-session-id` is validated by the CLI against exactly this shape (UUIDv4,
 * bundle 2026.08.11-e8db854 `src/state/requested-session-id.ts`) and rejected with a
 * hard exit otherwise, so an ill-formed value is dropped here instead of being passed on.
 */
const UUID_V4_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export interface TurnImage {
  bytes: Buffer;
  mimeType: string;
}

export interface TurnRequest {
  /** Native Cursor WebSearch is allowed when the chat payload opted into search. */
  enabledSearch?: boolean;
  history: unknown;
  images: TurnImage[];
  model: string;
  prompt: string;
  /** Stable per-conversation chat id (UUIDv4) from the runtime, or undefined. */
  sessionId?: string;
}

const countStringChars = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) total += countStringChars(entry);
    return total;
  }
  if (value && typeof value === 'object') {
    let total = 0;
    for (const entry of Object.values(value as Record<string, unknown>)) {
      total += countStringChars(entry);
    }
    return total;
  }
  return 0;
};

export const parseTurnBody = async (request: Request): Promise<TurnRequest | Response> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonError(400, 'invalid_request', 'request body exceeds 32 MiB');
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(await request.arrayBuffer());
  } catch {
    return jsonError(400, 'invalid_request', 'request body is not JSON');
  }
  if (buf.byteLength > MAX_BODY_BYTES) {
    return jsonError(400, 'invalid_request', 'request body exceeds 32 MiB');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    return jsonError(400, 'invalid_request', 'request body is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonError(400, 'invalid_request', 'request body must be an object');
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.model !== 'string' ||
    !MODEL_ID_RE.test(body.model) ||
    body.model.length > MAX_MODEL_ID_CHARS
  ) {
    return jsonError(400, 'invalid_request', 'invalid model id');
  }
  if (typeof body.prompt !== 'string') {
    return jsonError(400, 'invalid_request', 'prompt must be a string');
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    return jsonError(400, 'invalid_request', 'prompt exceeds 200000 characters');
  }
  if (
    body.history !== undefined &&
    (typeof body.history !== 'object' || body.history === null || Array.isArray(body.history))
  ) {
    return jsonError(400, 'invalid_request', 'history must be an object');
  }
  const history = body.history ?? { messages: [], replaceUserInfo: false };
  const historyRecord = history as Record<string, unknown>;
  if (historyRecord.messages !== undefined) {
    if (!Array.isArray(historyRecord.messages)) {
      return jsonError(400, 'invalid_request', 'history.messages must be an array');
    }
    if (historyRecord.messages.length > MAX_HISTORY_MESSAGES) {
      return jsonError(400, 'invalid_request', `history exceeds ${MAX_HISTORY_MESSAGES} messages`);
    }
  }
  if (countStringChars(history) > MAX_HISTORY_TEXT_CHARS) {
    return jsonError(400, 'invalid_request', 'history exceeds 400000 text characters');
  }

  const images: TurnImage[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES) {
      return jsonError(400, 'invalid_request', `images must be an array of at most ${MAX_IMAGES}`);
    }
    for (const entry of body.images) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return jsonError(400, 'invalid_request', 'each image must be an object');
      }
      const image = entry as Record<string, unknown>;
      if (typeof image.mimeType !== 'string' || !/^image\/[a-zA-Z0-9.+-]+$/.test(image.mimeType)) {
        return jsonError(400, 'invalid_request', 'invalid image mimeType');
      }
      if (typeof image.dataBase64 !== 'string') {
        return jsonError(400, 'invalid_request', 'invalid image dataBase64');
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(image.dataBase64, 'base64');
      } catch {
        return jsonError(400, 'invalid_request', 'invalid image dataBase64');
      }
      if (bytes.byteLength > MAX_IMAGE_DECODED_BYTES) {
        return jsonError(400, 'invalid_request', 'image exceeds 6 MiB');
      }
      images.push({ bytes, mimeType: image.mimeType });
    }
  }
  /**
   * Private runtime→transport header (`LobeCursorAI`), stripped here: it is never
   * exported into the child env and never reaches the CLI except as the argv value.
   */
  const requestedSessionId = request.headers.get(CURSOR_CONVERSATION_HEADER)?.trim();

  return {
    ...(body.enabledSearch === true ? { enabledSearch: true } : {}),
    history,
    images,
    model: body.model,
    prompt: body.prompt,
    ...(requestedSessionId && UUID_V4_RE.test(requestedSessionId)
      ? { sessionId: requestedSessionId.toLowerCase() }
      : {}),
  };
};
