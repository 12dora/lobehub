import { AUTH_REQUIRED_HEADER } from '@lobechat/desktop-bridge';
import { type ILobeAgentRuntimeErrorType } from '@lobechat/model-runtime';
import { AgentRuntimeErrorType } from '@lobechat/model-runtime';
import { type ErrorResponse, type ErrorType } from '@lobechat/types';
import { ChatErrorType } from '@lobechat/types';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

/**
 * Status used when an error type has no mapping. A non-numeric or out-of-range status makes the
 * `Response` constructor throw `RangeError`, and because `createErrorResponse` is called from
 * inside route catch blocks that throw surfaces as an opaque HTTP 500 — hiding the real error
 * type from the client. Falling back to 500 keeps the payload (which carries `errorType`) intact.
 */
const FALLBACK_STATUS = 500;

/** Platform catalog refusals that are a client-side permission problem, not a server fault. */
const PLATFORM_FORBIDDEN_ERROR_CODES = new Set<string>([
  PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_NOT_PUBLISHED,
  PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED,
  PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED,
]);

const PLATFORM_UNAVAILABLE_ERROR_CODES = new Set<string>([
  PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNAVAILABLE,
]);

const isValidHttpStatus = (status: unknown): status is number =>
  typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599;

/**
 * Error types that indicate a real authentication failure.
 * When these errors occur, the response will include X-Auth-Required header
 * to signal the client that re-authentication is needed.
 */
const AUTH_REQUIRED_ERROR_TYPES = new Set<ErrorType>([ChatErrorType.Unauthorized]);

const getStatus = (errorType: ILobeAgentRuntimeErrorType | ErrorType) => {
  // InvalidAccessCode / InvalidAzureAPIKey / InvalidOpenAIAPIKey / InvalidZhipuAPIKey ....
  if (errorType.toString().includes('Invalid')) return 401;

  switch (errorType) {
    case ChatErrorType.SubscriptionPlanLimit:
    case ChatErrorType.FreePlanLimit:
    case ChatErrorType.InsufficientBudgetForModel:
    case ChatErrorType.WorkspaceFrozenByAdmin:
    case ChatErrorType.WorkspaceFrozenByRiskControl:
    case ChatErrorType.WorkspaceSubscriptionInactive: {
      return 403;
    }

    // TODO: Need to refactor to Invalid OpenAI API Key
    case AgentRuntimeErrorType.InvalidProviderAPIKey:
    case AgentRuntimeErrorType.OAuthAuthorizationExpired:
    case AgentRuntimeErrorType.NoOpenAIAPIKey: {
      return 401;
    }

    case AgentRuntimeErrorType.ExceededContextWindow:
    case AgentRuntimeErrorType.ExceededToolLimit:
    case ChatErrorType.SubscriptionKeyMismatch:
    case ChatErrorType.SystemTimeNotMatchError:
    case ChatErrorType.LobeHubModelDeprecated: {
      return 400;
    }

    case AgentRuntimeErrorType.LocationNotSupportError: {
      return 403;
    }

    case AgentRuntimeErrorType.ModelNotFound: {
      return 404;
    }

    case AgentRuntimeErrorType.AccountDeactivated: {
      return 403;
    }

    case AgentRuntimeErrorType.InsufficientQuota:
    case AgentRuntimeErrorType.QuotaLimitReached: {
      return 429;
    }

    // define the 471~480 as provider error
    case AgentRuntimeErrorType.AgentRuntimeError: {
      return 470;
    }

    case AgentRuntimeErrorType.ProviderBizError:
    case AgentRuntimeErrorType.ProviderContentPolicyViolation: {
      return 471;
    }

    // all local provider connection error
    case AgentRuntimeErrorType.OllamaServiceUnavailable:
    case ChatErrorType.OllamaServiceUnavailable:
    case AgentRuntimeErrorType.OllamaBizError: {
      return 472;
    }
  }

  // Platform-managed catalog refusals. Both mean "the admin has not made this available to you",
  // which is a forbidden request, not a server fault — and without an explicit mapping they fell
  // through as raw strings and blew up the Response constructor.
  //
  // Compared outside the switch above: these codes are raised by the enterprise catalog layer
  // and are deliberately not members of the shared `ErrorType` union.
  if (PLATFORM_FORBIDDEN_ERROR_CODES.has(errorType as string)) return 403;
  if (PLATFORM_UNAVAILABLE_ERROR_CODES.has(errorType as string)) return 503;

  return errorType as number;
};

export const createErrorResponse = (
  errorType: ErrorType | ILobeAgentRuntimeErrorType,
  body?: any,
) => {
  const mappedStatus = getStatus(errorType);

  const data: ErrorResponse = { body, errorType };

  if (!isValidHttpStatus(mappedStatus)) {
    console.error(
      `current StatusCode: \`${mappedStatus}\` .`,
      'Please go to `./src/app/api/errorResponse.ts` to defined the statusCode.',
    );
  }

  // Never hand an unmapped value to `Response`: it throws RangeError, and callers invoke this
  // from a catch block, so the throw becomes a bare 500 with no errorType for the client to read.
  const statusCode = isValidHttpStatus(mappedStatus) ? mappedStatus : FALLBACK_STATUS;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add X-Auth-Required header for real authentication failures
  // This allows the client to distinguish between auth failures and other 401 errors (e.g., invalid API keys)
  if (AUTH_REQUIRED_ERROR_TYPES.has(errorType as ErrorType)) {
    headers[AUTH_REQUIRED_HEADER] = 'true';
  }

  return new Response(JSON.stringify(data), { headers, status: statusCode });
};
