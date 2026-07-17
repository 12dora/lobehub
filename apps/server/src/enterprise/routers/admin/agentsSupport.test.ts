import { describe, expect, it } from 'vitest';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentDependencyValidationError,
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentResourceInUseError,
  PlatformAgentRevisionConflictError,
} from '../../services/agentCatalog';
import { mapAgentServiceError } from './agentsSupport';

describe('admin Agent service error mapping', () => {
  it.each([
    [new PlatformAgentNotFoundError(), 'NOT_FOUND', 'PLATFORM_NOT_FOUND'],
    [new PlatformAgentRevisionConflictError(), 'CONFLICT', 'PLATFORM_REVISION_CONFLICT'],
    [
      new PlatformAgentDependencyValidationError(['AI_MODEL_UNAVAILABLE']),
      'PRECONDITION_FAILED',
      'PLATFORM_CONFIG_VALIDATION_FAILED',
    ],
    [
      new PlatformAgentDefaultRequiredError(),
      'PRECONDITION_FAILED',
      'PLATFORM_DEFAULT_AGENT_REQUIRED',
    ],
    [new PlatformAgentResourceInUseError(), 'CONFLICT', 'PLATFORM_RESOURCE_IN_USE'],
    [new PlatformAgentInvalidInputError(), 'BAD_REQUEST', 'PLATFORM_INVALID_INPUT'],
  ])('maps stable public errors without internal identifiers', (source, trpcCode, publicCode) => {
    try {
      mapAgentServiceError(source);
      expect.fail('expected mapped error');
    } catch (error) {
      expect(error).toMatchObject({ code: trpcCode });
      const body = getEnterpriseErrorBody(error);
      expect(body?.code).toBe(publicCode);
      // No SQLSTATE / constraint / target / value leaks into the public body.
      expect(JSON.stringify(body ?? {})).not.toMatch(
        /AI_MODEL_UNAVAILABLE|23505|23503|constraint|platform_agents_|_unique|_fk|__global__/,
      );
    }
  });
});
