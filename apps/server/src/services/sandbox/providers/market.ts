import type { SandboxCallToolResult } from '@lobechat/builtin-tool-cloud-sandbox';
import type { CodeInterpreterToolName } from '@lobehub/market-sdk';
import debug from 'debug';

import { SandboxMiddlewareService } from '../service';
import type {
  SandboxInterruptResult,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderFileExportRequest,
  SandboxProviderFileExportResult,
  SandboxService,
  SandboxServiceOptions,
  SandboxSessionContext,
} from '../types';

const log = debug('lobe-server:sandbox:market');
const REDACTED_SANDBOX_PARAM = '[redacted]';
const SANDBOX_AUTH_ENV_PATTERN = /\b(LOBEHUB_JWT|GITHUB_TOKEN)=("[^"]*"|'[^']*'|\S+)/g;
/** Presigned / query-bearing URLs (S3 signatures live in the query string). */
const SIGNED_URL_IN_COMMAND_PATTERN = /https?:\/\/[^\s'"]+\?[^\s'"]+/gi;
const QUERY_CREDENTIAL_PATTERN =
  /\b(X-Amz-(?:Algorithm|Credential|Date|Expires|SignedHeaders|Signature|Security-Token)|AWSAccessKeyId|Signature)=([^&\s'"]+)/gi;

export class MarketSandboxProvider implements SandboxProvider {
  readonly capabilities = {
    backgroundCommands: true,
    exportFile: true,
    files: true,
    languages: ['python', 'javascript', 'typescript'],
    persistentSession: true,
    shell: true,
    skillScripts: true,
  } as const satisfies SandboxProviderCapabilities;

  readonly kind = 'market';

  private readonly options: SandboxServiceOptions;

  constructor(options: SandboxServiceOptions) {
    this.options = options;
  }

  async callTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SandboxCallToolResult> {
    const { marketService, topicId, userId } = this.options;

    log(
      'Calling sandbox tool: %s with params: %O, topicId: %s',
      toolName,
      redactSandboxParams(params),
      topicId,
    );

    try {
      const response = await marketService
        .getSDK()
        .plugins.runBuildInTool(toolName as CodeInterpreterToolName, params as never, {
          topicId,
          userId,
        });

      log('Sandbox tool %s response: %O', toolName, response);

      if (!response.success) {
        return {
          error: {
            message: response.error?.message || 'Unknown error',
            name: response.error?.code,
          },
          result: null,
          sessionExpiredAndRecreated: false,
          success: false,
        };
      }

      return {
        result: response.data?.result,
        sessionExpiredAndRecreated: response.data?.sessionExpiredAndRecreated || false,
        success: true,
      };
    } catch (error) {
      log('Error calling sandbox tool %s: %O', toolName, error);

      return {
        error: {
          message: (error as Error).message,
          name: (error as Error).name,
        },
        result: null,
        sessionExpiredAndRecreated: false,
        success: false,
      };
    }
  }

  async interrupt(_session: SandboxSessionContext): Promise<SandboxInterruptResult> {
    return { killed: 0 };
  }

  async exportFileToUploadUrl({
    path,
    uploadUrl,
  }: SandboxProviderFileExportRequest): Promise<SandboxProviderFileExportResult> {
    const { marketService, topicId, userId } = this.options;

    try {
      const response = await marketService.exportFile({
        path,
        topicId,
        uploadUrl,
        userId,
      });

      log('Sandbox exportFile response: %O', response);

      if (!response.success) {
        return {
          error: {
            message: response.error?.message || 'Failed to export file from sandbox',
            name: response.error?.code,
          },
          success: false,
        };
      }

      const result = response.data?.result;
      const uploadSuccess = result?.success !== false;

      if (!uploadSuccess) {
        return {
          error: { message: result?.error || 'Failed to upload file from sandbox' },
          success: false,
        };
      }

      return {
        mimeType: result?.mimeType,
        result,
        success: true,
      };
    } catch (error) {
      log('Error exporting file: %O', error);

      return {
        error: { message: (error as Error).message },
        success: false,
      };
    }
  }
}

const redactCommandSecrets = (command: string): string => {
  // Internal bootstrap / attachment-sync curls embed presigned URLs. Never log
  // the full command — redacting in place is not enough if a future logger
  // dumps the raw params before this helper runs.
  if (/\bcurl\b/i.test(command) && command.includes('/mnt/data')) {
    return '[redacted sandbox download command]';
  }

  return command
    .replaceAll(SANDBOX_AUTH_ENV_PATTERN, (_, name: string) => `${name}=${REDACTED_SANDBOX_PARAM}`)
    .replaceAll(SIGNED_URL_IN_COMMAND_PATTERN, REDACTED_SANDBOX_PARAM)
    .replaceAll(QUERY_CREDENTIAL_PATTERN, (_, name: string) => `${name}=${REDACTED_SANDBOX_PARAM}`);
};

export const redactSandboxParams = (params: Record<string, unknown>) => {
  const hasCommand = typeof params.command === 'string';
  if (!params.skillZipUrls && !params.zipUrl && !hasCommand) return params;

  const redacted = {
    ...params,
  };

  if (params.zipUrl) redacted.zipUrl = REDACTED_SANDBOX_PARAM;
  if (params.skillZipUrls) redacted.skillZipUrls = REDACTED_SANDBOX_PARAM;
  if (typeof params.command === 'string') {
    redacted.command = redactCommandSecrets(params.command);
  }

  return redacted;
};

/** @deprecated Use createSandboxService. */
export class ServerSandboxService extends SandboxMiddlewareService implements SandboxService {
  constructor(options: SandboxServiceOptions) {
    super(new MarketSandboxProvider(options), options);
  }
}
