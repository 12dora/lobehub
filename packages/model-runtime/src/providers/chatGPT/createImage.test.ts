// @vitest-environment node
import * as imageToBase64Module from '@lobechat/utils';
import { AttachmentFetchError, AttachmentInlineLimitError } from '@lobechat/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateImageOptions } from '../../core/openaiCompatibleFactory';
import { AgentRuntimeErrorType } from '../../types/error';
import type { CreateImagePayload } from '../../types/image';
import { createChatGPTImage, MAX_REFERENCE_IMAGES } from './createImage';

const mockPost = vi.fn();
const mockGenerate = vi.fn();
const mockEdit = vi.fn();

const mockClient = {
  images: {
    edit: mockEdit,
    generate: mockGenerate,
  },
  post: mockPost,
};

const mockOptions: CreateImageOptions = {
  apiKey: 'access-token',
  baseURL: 'https://chatgpt.com/backend-api/codex',
  client: mockClient as never,
  provider: 'chatgpt',
};

const generatePayload = (
  params: CreateImagePayload['params'] = { prompt: 'a cube' },
): CreateImagePayload => ({
  model: 'gpt-image-2',
  params,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(imageToBase64Module, 'imageUrlToBase64').mockResolvedValue({
    base64: 'refbytes',
    mimeType: 'image/png',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createChatGPTImage', () => {
  describe('generate', () => {
    it('POSTs JSON to /images/generations with Codex headers', async () => {
      mockPost.mockResolvedValueOnce({
        created: 1,
        data: [{ b64_json: 'generated' }],
        size: '1024x1024',
      });

      const result = await createChatGPTImage(
        generatePayload({
          background: 'opaque',
          prompt: 'a small red cube',
          quality: 'high',
          size: '1024x1024',
        }),
        mockOptions,
      );

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledWith('/images/generations', {
        body: {
          background: 'opaque',
          model: 'gpt-image-2',
          prompt: 'a small red cube',
          quality: 'high',
          size: '1024x1024',
        },
        headers: {
          'originator': 'lobehub',
          'x-codex-image-turn-id': expect.any(String),
        },
      });
      expect(mockGenerate).not.toHaveBeenCalled();
      expect(mockEdit).not.toHaveBeenCalled();
      expect(result).toEqual({
        height: 1024,
        imageUrl: 'data:image/png;base64,generated',
        width: 1024,
      });
    });

    it('converts b64_json into a PNG data URL when size is omitted', async () => {
      mockPost.mockResolvedValueOnce({
        data: [{ b64_json: 'plain' }],
      });

      const result = await createChatGPTImage(generatePayload(), mockOptions);

      expect(result).toEqual({
        imageUrl: 'data:image/png;base64,plain',
      });
    });

    it('derives width and height from a PNG payload when size is absent', async () => {
      const png1x1 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      mockPost.mockResolvedValueOnce({
        data: [{ b64_json: png1x1 }],
      });

      const result = await createChatGPTImage(generatePayload(), mockOptions);

      expect(result).toEqual({
        height: 1,
        imageUrl: `data:image/png;base64,${png1x1}`,
        width: 1,
      });
    });
  });

  describe('edit', () => {
    it('POSTs JSON to /images/edits with inlined data-URL references', async () => {
      mockPost.mockResolvedValueOnce({
        data: [{ b64_json: 'edited' }],
      });

      const result = await createChatGPTImage(
        generatePayload({
          imageUrls: ['data:image/png;base64,aaa', 'https://files.example.test/ref.png?sig=secret'],
          prompt: 'make it blue',
        }),
        mockOptions,
      );

      expect(imageToBase64Module.imageUrlToBase64).toHaveBeenCalledTimes(1);
      expect(imageToBase64Module.imageUrlToBase64).toHaveBeenCalledWith(
        'https://files.example.test/ref.png?sig=secret',
        expect.objectContaining({
          maxBytes: 5 * 1024 * 1024,
          ownOriginOnly: true,
        }),
      );
      expect(mockPost).toHaveBeenCalledWith('/images/edits', {
        body: {
          images: [
            { image_url: 'data:image/png;base64,aaa' },
            { image_url: 'data:image/png;base64,refbytes' },
          ],
          model: 'gpt-image-2',
          prompt: 'make it blue',
        },
        headers: {
          'originator': 'lobehub',
          'x-codex-image-turn-id': expect.any(String),
        },
      });
      expect(mockGenerate).not.toHaveBeenCalled();
      expect(result.imageUrl).toBe('data:image/png;base64,edited');
    });

    it('rejects an oversized data URL reference as InvalidRequestFormat', async () => {
      vi.spyOn(imageToBase64Module, 'assertDecodedBase64WithinLimit').mockImplementationOnce(() => {
        throw new AttachmentInlineLimitError(5 * 1024 * 1024, 5 * 1024 * 1024 + 1);
      });

      await expect(
        createChatGPTImage(
          generatePayload({
            imageUrls: ['data:image/png;base64,aaa'],
            prompt: 'make it blue',
          }),
          mockOptions,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('inlining limit'),
          }),
          errorType: AgentRuntimeErrorType.InvalidRequestFormat,
          provider: 'chatgpt',
        }),
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('maps host-only fetch failures without leaking the signed query', async () => {
      vi.spyOn(imageToBase64Module, 'imageUrlToBase64').mockRejectedValueOnce(
        new AttachmentFetchError('localhost:9000'),
      );

      const error = await createChatGPTImage(
        generatePayload({
          imageUrls: [
            'http://localhost:9000/bucket/cat.png?X-Amz-Signature=super-secret-signature',
          ],
          prompt: 'edit',
        }),
        mockOptions,
      ).catch((caught: unknown) => caught);

      expect(error).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'failed to download attachment from localhost:9000',
          }),
          errorType: AgentRuntimeErrorType.ProviderBizError,
        }),
      );
      expect(JSON.stringify(error)).not.toContain('X-Amz-Signature');
      expect(JSON.stringify(error)).not.toContain('super-secret-signature');
    });

    it('maps AttachmentInlineLimitError from fetched references to InvalidRequestFormat', async () => {
      vi.spyOn(imageToBase64Module, 'imageUrlToBase64').mockRejectedValueOnce(
        new AttachmentInlineLimitError(5 * 1024 * 1024, 5 * 1024 * 1024 + 1),
      );

      await expect(
        createChatGPTImage(
          generatePayload({
            imageUrls: ['https://files.example.test/huge.png'],
            prompt: 'edit',
          }),
          mockOptions,
        ),
      ).rejects.toEqual(
        expect.objectContaining({
          errorType: AgentRuntimeErrorType.InvalidRequestFormat,
          provider: 'chatgpt',
        }),
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('rejects more than five reference images without calling Codex', async () => {
      const urls = Array.from(
        { length: MAX_REFERENCE_IMAGES + 1 },
        (_, index) => `https://x.test/${index}.png`,
      );

      await expect(
        createChatGPTImage(generatePayload({ imageUrls: urls, prompt: 'too many' }), mockOptions),
      ).rejects.toEqual(
        expect.objectContaining({
          errorType: AgentRuntimeErrorType.InvalidRequestFormat,
          provider: 'chatgpt',
        }),
      );
      expect(mockPost).not.toHaveBeenCalled();
      expect(imageToBase64Module.imageUrlToBase64).not.toHaveBeenCalled();
    });
  });

  describe('errors', () => {
    it('maps 401 to InvalidProviderAPIKey', async () => {
      mockPost.mockRejectedValueOnce(Object.assign(new Error('token expired'), { status: 401 }));

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'token expired', status: 401 }),
          errorType: AgentRuntimeErrorType.InvalidProviderAPIKey,
          provider: 'chatgpt',
        }),
      );
    });

    it('maps 403 to PermissionDenied', async () => {
      mockPost.mockRejectedValueOnce(Object.assign(new Error('Plus required'), { status: 403 }));

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'Plus required' }),
          errorType: AgentRuntimeErrorType.PermissionDenied,
          provider: 'chatgpt',
        }),
      );
    });

    it('maps 400 to InvalidRequestFormat with the upstream message', async () => {
      mockPost.mockRejectedValueOnce(
        Object.assign(new Error('HTTP 400'), {
          error: { message: 'unknown size' },
          status: 400,
        }),
      );

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'unknown size' }),
          errorType: AgentRuntimeErrorType.InvalidRequestFormat,
          provider: 'chatgpt',
        }),
      );
    });

    it('maps 429 to RateLimitExceeded', async () => {
      mockPost.mockRejectedValueOnce(Object.assign(new Error('slow down'), { status: 429 }));

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'slow down', status: 429 }),
          errorType: AgentRuntimeErrorType.RateLimitExceeded,
          provider: 'chatgpt',
        }),
      );
    });

    it('maps 503 to ProviderServiceUnavailable', async () => {
      mockPost.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 503 }));

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'overloaded', status: 503 }),
          errorType: AgentRuntimeErrorType.ProviderServiceUnavailable,
          provider: 'chatgpt',
        }),
      );
    });

    it('maps content-policy codes to ProviderContentPolicyViolation', async () => {
      mockPost.mockRejectedValueOnce(
        Object.assign(new Error('blocked'), {
          error: { code: 'content_policy_violation', message: 'blocked' },
          status: 400,
        }),
      );

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'content_policy_violation' }),
          errorType: AgentRuntimeErrorType.ProviderContentPolicyViolation,
          provider: 'chatgpt',
        }),
      );
    });

    it('maps a missing data array to AgentRuntimeError.createImage', async () => {
      mockPost.mockResolvedValueOnce({ created: 1, data: [] });

      await expect(createChatGPTImage(generatePayload(), mockOptions)).rejects.toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Invalid image response: missing or empty data array',
          }),
          errorType: AgentRuntimeErrorType.ProviderBizError,
          provider: 'chatgpt',
        }),
      );
    });
  });
});
