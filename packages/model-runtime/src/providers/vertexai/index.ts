import type { GoogleGenAIOptions } from '@google/genai';
import { GoogleGenAI } from '@google/genai';

import { AgentRuntimeErrorType } from '../../types/error';
import type { FetchLike } from '../../utils/boundFetch';
import { AgentRuntimeError } from '../../utils/createError';
import type { ModelIdMappingOptions } from '../../utils/modelIdMapping';
import { LobeGoogleAI } from '../google';

const DEFAULT_VERTEXAI_LOCATION = 'global';
type VertexAIInitOptions = GoogleGenAIOptions &
  ModelIdMappingOptions & {
    fetch?: FetchLike;
  };

/**
 * Force google-auth-library / gaxios token exchange onto a WHATWG fetch boundary.
 * `clientOptions.transporterOptions` is applied to JWT/service-account AuthClients;
 * top-level `transporterOptions` covers GoogleAuth's own transporter defaults.
 */
const withSafeAuthFetch = (
  existingAuth: Record<string, unknown> | undefined,
  customFetch: FetchLike,
): Record<string, unknown> => {
  const auth = { ...existingAuth };
  const existingClientOptions = (auth.clientOptions as Record<string, unknown> | undefined) ?? {};
  const existingClientTransporter =
    (existingClientOptions.transporterOptions as Record<string, unknown> | undefined) ?? {};
  const existingTopTransporter =
    (auth.transporterOptions as Record<string, unknown> | undefined) ?? {};

  return {
    ...auth,
    clientOptions: {
      ...existingClientOptions,
      transporterOptions: {
        ...existingClientTransporter,
        fetchImplementation: customFetch,
      },
    },
    transporterOptions: {
      ...existingTopTransporter,
      fetchImplementation: customFetch,
    },
  };
};

export class LobeVertexAI extends LobeGoogleAI {
  static initFromVertexAI(params?: VertexAIInitOptions) {
    try {
      const { modelIdMapping, fetch: customFetch, ...googleOptions } = params ?? {};

      // Route service-account token exchange and GenAI hops through SafeOutbound
      // when a custom fetch is provided (enterprise connection tests / production probes).
      const googleAuthOptions = customFetch
        ? withSafeAuthFetch(
            googleOptions.googleAuthOptions as Record<string, unknown> | undefined,
            customFetch,
          )
        : googleOptions.googleAuthOptions;

      const client = new GoogleGenAI({
        ...googleOptions,
        ...(googleAuthOptions ? { googleAuthOptions } : {}),
        location: googleOptions.location ?? DEFAULT_VERTEXAI_LOCATION, // @google/genai throws an error if location is not provided
        vertexai: true,
      });

      return new LobeGoogleAI({
        apiKey: 'avoid-error',
        client,
        fetch: customFetch,
        isVertexAi: true,
        modelIdMapping,
      });
    } catch (e) {
      const err = e as Error;

      if (err.name === 'IllegalArgumentError') {
        throw AgentRuntimeError.createError(AgentRuntimeErrorType.InvalidVertexCredentials, {
          message: err.message,
        });
      }

      throw e;
    }
  }
}
