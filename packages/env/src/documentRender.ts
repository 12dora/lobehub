import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const emptyStringToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalPositiveInt = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().positive().optional(),
);

export const getDocumentRenderConfig = () => {
  return createEnv({
    runtimeEnv: {
      DOCUMENT_RENDER_CONCURRENCY: process.env.DOCUMENT_RENDER_CONCURRENCY,
      DOCUMENT_RENDER_LONG_EDGE_PX: process.env.DOCUMENT_RENDER_LONG_EDGE_PX,
      DOCUMENT_RENDER_MAX_FILE_BYTES: process.env.DOCUMENT_RENDER_MAX_FILE_BYTES,
      DOCUMENT_RENDER_MAX_PAGES: process.env.DOCUMENT_RENDER_MAX_PAGES,
      DOCUMENT_RENDER_THUMB_EDGE_PX: process.env.DOCUMENT_RENDER_THUMB_EDGE_PX,
      DOCUMENT_RENDER_TIMEOUT_SEC: process.env.DOCUMENT_RENDER_TIMEOUT_SEC,
      DOCUMENT_RENDER_TRIGGER: process.env.DOCUMENT_RENDER_TRIGGER,
      DOCUMENT_RENDER_URL: process.env.DOCUMENT_RENDER_URL,
    },
    server: {
      DOCUMENT_RENDER_CONCURRENCY: optionalPositiveInt,
      DOCUMENT_RENDER_LONG_EDGE_PX: optionalPositiveInt,
      DOCUMENT_RENDER_MAX_FILE_BYTES: optionalPositiveInt,
      DOCUMENT_RENDER_MAX_PAGES: optionalPositiveInt,
      DOCUMENT_RENDER_THUMB_EDGE_PX: optionalPositiveInt,
      DOCUMENT_RENDER_TIMEOUT_SEC: optionalPositiveInt,
      DOCUMENT_RENDER_TRIGGER: z.preprocess(
        emptyStringToUndefined,
        z.enum(['onDemand', 'onUpload']).optional(),
      ),
      DOCUMENT_RENDER_URL: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
    },
  });
};

export const documentRenderEnv = getDocumentRenderConfig();
