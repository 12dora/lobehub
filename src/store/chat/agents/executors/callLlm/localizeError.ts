import { type ChatMessageError } from '@lobechat/types';
import { t } from 'i18next';

const getGoogleBlockedReason = (error: ChatMessageError): string | undefined => {
  const body = error.body as
    | {
        context?: {
          finishReason?: unknown;
          promptFeedback?: {
            blockReason?: unknown;
          };
        };
        provider?: unknown;
      }
    | undefined;

  if (body?.provider !== 'google') return undefined;

  const promptFeedbackReason = body.context?.promptFeedback?.blockReason;
  if (typeof promptFeedbackReason === 'string') return promptFeedbackReason;

  const finishReason = body.context?.finishReason;
  if (typeof finishReason === 'string') return finishReason;

  return undefined;
};

const localizeGoogleBlockedError = (error: ChatMessageError): ChatMessageError => {
  const blockReason = getGoogleBlockedReason(error);
  if (!blockReason) return error;

  const translationKey = `response.GoogleAIBlockReason.${blockReason}`;
  const localized = t(translationKey as 'response.GoogleAIBlockReason.default', {
    defaultValue: error.message ?? '',
    ns: 'error',
  }).trim();

  if (!localized || localized === translationKey) return error;

  const normalizedBody =
    error.body && typeof error.body === 'object' ? (error.body as Record<string, unknown>) : {};

  return {
    ...error,
    body: {
      ...normalizedBody,
      message: localized,
    },
    message: localized,
  };
};

export const localizeError = (error: ChatMessageError): ChatMessageError => {
  const body = error.body as
    | {
        provider?: unknown;
      }
    | undefined;

  if (body?.provider === 'google') {
    return localizeGoogleBlockedError(error);
  }

  return error;
};
