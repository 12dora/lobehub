import { describe, expect, it } from 'vitest';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentDependencyValidationError,
  PlatformAgentNotFoundError,
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
  ])('maps stable public errors without internal identifiers', (source, trpcCode, publicCode) => {
    try {
      mapAgentServiceError(source);
      expect.fail('expected mapped error');
    } catch (error) {
      expect(error).toMatchObject({ code: trpcCode });
      const body = getEnterpriseErrorBody(error);
      expect(body?.code).toBe(publicCode);
      expect(JSON.stringify(body)).not.toContain('AI_MODEL_UNAVAILABLE');
    }
  });
});
