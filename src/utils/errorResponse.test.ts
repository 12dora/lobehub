import { AgentRuntimeErrorType } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { createErrorResponse } from './errorResponse';

describe('createErrorResponse', () => {
  // 测试各种错误类型的状态码
  it('returns a 401 status for NoOpenAIAPIKey error type', () => {
    const errorType = ChatErrorType.NoOpenAIAPIKey;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(401);
  });

  it('returns a 401 status for InvalidAccessCode error type', () => {
    const errorType = ChatErrorType.InvalidAccessCode;
    const response = createErrorResponse(errorType as any);
    expect(response.status).toBe(401);
  });

  // 测试包含Invalid的错误类型
  it('returns a 401 status for Invalid error type', () => {
    const errorType = 'InvalidTestError';
    const response = createErrorResponse(errorType as any);
    expect(response.status).toBe(401);
  });

  it('returns a 403 status for LocationNotSupportError error type', () => {
    const errorType = AgentRuntimeErrorType.LocationNotSupportError;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(403);
  });

  it('returns a 404 status for ModelNotFound error type', () => {
    const errorType = AgentRuntimeErrorType.ModelNotFound;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(404);
  });

  it('returns a 429 status for InsufficientQuota error type', () => {
    const errorType = AgentRuntimeErrorType.InsufficientQuota;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(429);
  });

  it('returns a 429 status for QuotaLimitReached error type', () => {
    const errorType = AgentRuntimeErrorType.QuotaLimitReached;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(429);
  });

  it('returns a 400 status for ExceededContextWindow error type', () => {
    const errorType = AgentRuntimeErrorType.ExceededContextWindow;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(400);
  });

  it('returns a 400 status for SystemTimeNotMatchError error type', () => {
    const errorType = ChatErrorType.SystemTimeNotMatchError;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(400);
  });

  it('returns a 400 status for SubscriptionKeyMismatch error type', () => {
    const errorType = ChatErrorType.SubscriptionKeyMismatch;
    const response = createErrorResponse(errorType);
    expect(response.status).toBe(400);
  });

  describe('Provider Biz Error', () => {
    it('returns a 471 status for ProviderBizError error type', () => {
      const errorType = AgentRuntimeErrorType.ProviderBizError;
      const response = createErrorResponse(errorType);
      expect(response.status).toBe(471);
    });

    it('returns a 471 status for ProviderContentPolicyViolation error type', () => {
      const errorType = AgentRuntimeErrorType.ProviderContentPolicyViolation;
      const response = createErrorResponse(errorType);
      expect(response.status).toBe(471);
    });

    it('returns a 470 status for AgentRuntimeError error type', () => {
      const errorType = AgentRuntimeErrorType.AgentRuntimeError;
      const response = createErrorResponse(errorType);
      expect(response.status).toBe(470);
    });

    it('returns a 472 status for OllamaBizError error type', () => {
      const errorType = AgentRuntimeErrorType.OllamaBizError;
      const response = createErrorResponse(errorType);
      expect(response.status).toBe(472);
    });

    it('returns a 472 status for OllamaServiceUnavailable error type', () => {
      const errorType = ChatErrorType.OllamaServiceUnavailable;
      const response = createErrorResponse(errorType);
      expect(response.status).toBe(472);
    });
  });

  // 测试状态码不在200-599范围内的情况
  it('logs an error when the status code is not a number or not in the range of 200-599', () => {
    const errorType = 'Unknown Error';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createErrorResponse(errorType as any);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  describe('platform-managed catalog refusals', () => {
    it('returns 403 when the requested model is not published', () => {
      const response = createErrorResponse('PLATFORM_AI_MODEL_NOT_PUBLISHED' as any);
      expect(response.status).toBe(403);
    });

    it('returns 403 when the provider was disabled by an administrator', () => {
      const response = createErrorResponse('PLATFORM_AI_PROVIDER_DISABLED' as any);
      expect(response.status).toBe(403);
    });
  });

  describe('unmapped status hardening', () => {
    // Regression: an unmapped errorType used to reach `new Response({ status })` as a raw
    // string. The constructor threw RangeError inside the route's catch block, so the client
    // got an opaque 500 with no errorType at all.
    it.each([
      ['a non-numeric error type', 'SOME_UNMAPPED_ERROR_TYPE'],
      ['an out-of-range numeric status', 120],
      ['a non-integer status', 404.5],
    ])('falls back to 500 without throwing for %s', (_case, errorType) => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      let response: Response | undefined;
      expect(() => {
        response = createErrorResponse(errorType as any);
      }).not.toThrow();

      expect(response!.status).toBe(500);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('still reports the original errorType in the payload', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = createErrorResponse('SOME_UNMAPPED_ERROR_TYPE' as any);
      consoleSpy.mockRestore();

      await expect(response.json()).resolves.toMatchObject({
        errorType: 'SOME_UNMAPPED_ERROR_TYPE',
      });
    });
  });

  // 测试默认情况
  it('returns the same error type as status for unknown error types', () => {
    const errorType = 500; // 假设500是一个未知的错误类型
    const response = createErrorResponse(errorType as any);
    expect(response.status).toBe(errorType);
  });

  // 测试返回的Response对象是否包含正确的body和errorType
  it('returns a Response object with the correct body and errorType', () => {
    const errorType = ChatErrorType.NoOpenAIAPIKey;
    const body = { message: 'No API key provided' };
    const response = createErrorResponse(errorType, body);
    return response.json().then((data) => {
      expect(data).toEqual({
        body,
        errorType,
      });
    });
  });

  // 测试没有提供body时，返回的Response对象的body是否为undefined
  it('returns a Response object with an undefined body when no body is provided', () => {
    const errorType = ChatErrorType.NoOpenAIAPIKey;
    const response = createErrorResponse(errorType);
    return response.json().then((data) => {
      expect(data.body).toBeUndefined();
    });
  });
});
