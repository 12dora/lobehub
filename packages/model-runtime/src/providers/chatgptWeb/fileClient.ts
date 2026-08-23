import { assertAllowedAssetUrl, checkedAssetUrl } from './assetUrls';
import { abortableSleep, MAX_DOWNLOAD_BYTES, readBoundedBody } from './boundedBody';
import { CHATGPT_BASE_URL, PATHS, RETRYABLE_POLL_STATUSES, TIMEOUTS } from './constants';
import { ChatGPTWebConversationClient } from './conversationClient';
import {
  callerAbortReason,
  ChatGPTWebError,
  classifyResponseError,
  isChatGPTWebError,
} from './errors';
import { buildAssetDownloadHeaders, buildBlobUploadHeaders } from './headers';
import { readBodySafely } from './http';
import { buildFileCreateBody } from './requestBuilders';
import type { UploadedFileRef } from './types';

export class ChatGPTWebFileClient extends ChatGPTWebConversationClient {
  async uploadFile(
    bytes: Uint8Array,
    meta: {
      height?: number;
      kind: 'image' | 'document';
      mimeType: string;
      name: string;
      width?: number;
    },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<UploadedFileRef> {
    const created = await this.requestJson<{
      file_id?: string;
      library_file_id?: string;
      upload_url?: string;
    }>({
      ...this.jsonBody(
        buildFileCreateBody({
          height: meta.height,
          kind: meta.kind,
          mimeType: meta.mimeType,
          name: meta.name,
          size: bytes.length,
          browserProfile: this.browserProfile,
          width: meta.width,
        }),
      ),
      context: 'file_create',
      path: PATHS.files,
      signal,
    });

    if (!created.file_id || !created.upload_url)
      throw new ChatGPTWebError('upstream', 'file creation returned no upload url', {
        body: created,
      });

    await this.putBlob(created.upload_url, bytes, meta.mimeType, signal);

    const uploaded = await this.request({
      // the upstream expects the literal two-character body "{}"
      body: '{}',
      context: 'file_uploaded',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      path: `${PATHS.files}/${created.file_id}/uploaded`,
      signal,
    });
    uploaded.release();

    return {
      fileId: created.file_id,
      height: meta.height,
      kind: meta.kind,
      libraryFileId: created.library_file_id,
      mimeType: meta.mimeType,
      name: meta.name,
      size: bytes.length,
      width: meta.width,
    };
  }

  private async putBlob(
    uploadUrl: string,
    bytes: Uint8Array,
    mimeType: string,
    signal?: AbortSignal,
  ) {
    // the upload URL comes back from `POST /backend-api/files`, i.e. from a
    // response body — validate it before handing it to the transport
    assertAllowedAssetUrl(uploadUrl, 'file_upload');
    const managed = await this.rawFetch(
      uploadUrl,
      {
        body: bytes as unknown as BodyInit,
        headers: buildBlobUploadHeaders(this.fingerprint, mimeType),
        method: 'PUT',
      },
      { context: 'file_upload', signal, timeoutMs: TIMEOUTS.binary },
    );

    const { response } = managed;
    if (response.status >= 300) {
      let bodyText: string | undefined;
      try {
        bodyText = await readBodySafely(response, managed.fail);
      } finally {
        managed.release();
      }
      throw classifyResponseError({
        bodyText,
        context: 'file_upload',
        headers: response.headers,
        status: response.status,
      });
    }
    managed.release();
  }

  /**
   * Documents are indexed asynchronously; attaching one before the upstream is
   * done yields an *empty* retrieval — the model then answers about a file it
   * cannot read. Readiness therefore needs BOTH signals (E6 §2.4): a successful
   * retrieval index AND a numeric `file_token_size`.
   *
   * On deadline this THROWS a typed `timeout`. Callers that can degrade (e.g.
   * fall back to injecting the parsed text into the prompt) should catch it;
   * silently returning `{}` would have attached an unindexed document.
   */
  async waitForFileReady(
    fileId: string,
    {
      intervalMs = 2000,
      signal,
      timeoutMs = 120_000,
    }: { intervalMs?: number; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ fileTokenSize?: number; status?: string }> {
    const startedAt = Date.now();
    let last: { fileTokenSize?: number; status?: string } = {};

    while (Date.now() - startedAt < timeoutMs) {
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;

      try {
        const raw = await this.requestJson<Record<string, any>>({
          context: 'file_status',
          path: `${PATHS.files}/${fileId}`,
          signal,
        });
        const status = raw?.retrieval_index_status ?? raw?.status;
        last = {
          fileTokenSize: typeof raw?.file_token_size === 'number' ? raw.file_token_size : undefined,
          status: typeof status === 'string' ? status : undefined,
        };
        if (last.status === 'success' && typeof last.fileTokenSize === 'number') return last;
        if (last.status === 'failed')
          throw new ChatGPTWebError('upstream', `file ${fileId} failed to index`, { body: raw });
      } catch (error) {
        if (!isChatGPTWebError(error) || !RETRYABLE_POLL_STATUSES.has(error.status ?? 0))
          throw error;
      }

      await abortableSleep(intervalMs, signal);
    }

    throw new ChatGPTWebError(
      'timeout',
      `file ${fileId} was still not indexed after ${timeoutMs}ms`,
      { body: last },
    );
  }

  async getFileDownloadUrl(fileId: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.requestJson<{ download_url?: string; url?: string }>({
      context: 'file_download_url',
      path: `${PATHS.files}/${fileId}/download`,
      signal,
    });
    return checkedAssetUrl(raw?.download_url ?? raw?.url, 'file_download_url');
  }

  async getAttachmentDownloadUrl(
    conversationId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const raw = await this.requestJson<{ download_url?: string; url?: string }>({
      context: 'attachment_download_url',
      path: `${PATHS.conversation}/${conversationId}/attachment/${attachmentId}/download`,
      signal,
    });
    return checkedAssetUrl(raw?.download_url ?? raw?.url, 'attachment_download_url');
  }

  /**
   * Resolve a code-interpreter output path (`/mnt/data/report.pdf`) into a
   * download URL.
   *
   * The python tool writes its files into a sandbox the answer text can only
   * reference as `sandbox:/mnt/data/…`; this endpoint is what the web client
   * itself calls to turn such a reference into real bytes. The URL it returns is
   * an `estuary/content` link that still needs the account bearer, which
   * {@link downloadBytes} attaches for chatgpt.com only.
   */
  async resolveInterpreterFile({
    conversationId,
    messageId,
    sandboxPath,
    signal,
  }: {
    conversationId: string;
    messageId: string;
    sandboxPath: string;
    signal?: AbortSignal;
  }): Promise<{ downloadUrl: string; fileId?: string; name?: string }> {
    // callers may pass the reference as it appeared in the text
    const path = sandboxPath.startsWith('sandbox:')
      ? sandboxPath.slice('sandbox:'.length)
      : sandboxPath;

    const raw = await this.requestJson<{
      download_url?: string;
      metadata?: { file_id?: string; file_name?: string; name?: string };
      url?: string;
    }>({
      context: 'interpreter_download',
      headers: { Referer: `${CHATGPT_BASE_URL}/c/${conversationId}` },
      path: `${PATHS.conversation}/${conversationId}/interpreter/download`,
      query: `?message_id=${encodeURIComponent(messageId)}&sandbox_path=${encodeURIComponent(path)}`,
      signal,
    });

    const downloadUrl = checkedAssetUrl(raw?.download_url ?? raw?.url, 'interpreter_download');
    const metadata = raw?.metadata;
    return {
      downloadUrl,
      fileId: typeof metadata?.file_id === 'string' ? metadata.file_id : undefined,
      name:
        (typeof metadata?.file_name === 'string' && metadata.file_name) ||
        (typeof metadata?.name === 'string' && metadata.name) ||
        undefined,
    };
  }

  /**
   * Fetch an asset URL handed to us by a download-url endpoint.
   *
   * Generated images resolve to `https://chatgpt.com/backend-api/estuary/content?…`,
   * which is NOT pre-signed and 403s without the bearer token — so we forward it,
   * but only for chatgpt.com itself. Third-party blob URLs are already signed and
   * must never see the credential.
   */
  async downloadBytes(
    url: string,
    signalOrOptions?: AbortSignal | { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ bytes: Uint8Array; mimeType?: string }> {
    const {
      maxBytes = MAX_DOWNLOAD_BYTES,
      signal,
      timeoutMs = TIMEOUTS.binary,
    } = signalOrOptions && 'aborted' in signalOrOptions
      ? { signal: signalOrOptions }
      : (signalOrOptions ?? {});

    const parsed = assertAllowedAssetUrl(url, 'asset_download');
    const sameOrigin = parsed.origin === CHATGPT_BASE_URL;
    const managed = await this.rawFetch(
      url,
      {
        headers: buildAssetDownloadHeaders(this.fingerprint, { sameOrigin }),
      },
      { context: 'asset_download', signal, timeoutMs },
    );

    const { response } = managed;
    try {
      if (response.status >= 300)
        throw classifyResponseError({
          bodyText: await readBodySafely(response, managed.fail),
          context: 'asset_download',
          headers: response.headers,
          status: response.status,
        });

      // reject an oversized asset before reading it, when it announces itself
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes)
        throw new ChatGPTWebError(
          'upstream',
          `asset is ${declared} bytes, over the ${maxBytes} byte limit`,
          { status: response.status },
        );

      return {
        bytes: await readBoundedBody(response, maxBytes, managed.fail),
        mimeType: response.headers.get('content-type') ?? undefined,
      };
    } finally {
      managed.release();
    }
  }
}
