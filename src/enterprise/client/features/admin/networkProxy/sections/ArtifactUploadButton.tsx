'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Upload } from 'antd';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminNetworkProxyService,
  AdminNetworkProxyUploadResult,
} from '@/enterprise/client/services/adminNetworkProxy';
import type { NetworkProxyArtifactKind } from '@/types/platform/networkProxy';

import { runAdminMutation } from '../../primitives/runAdminMutation';
import { networkProxyErrorKey } from '../errors';
import { formatBytes, shortDigest } from '../format';
import { networkProxyStyles as styles } from '../styles';

export interface ArtifactUploadButtonProps {
  disabled?: boolean;
  /** sha256 the file must match. Shown here — the only place it is of any use — never on the row. */
  expectedDigest?: string | null;
  kind: NetworkProxyArtifactKind;
  /** Refresh artifact status once a file has been verified and installed. */
  onInstalled: () => void;
  service: AdminNetworkProxyService;
}

type UploadPhase =
  | { phase: 'idle' }
  | { phase: 'uploading'; ratio: number }
  | { phase: 'verified'; result: AdminNetworkProxyUploadResult }
  | { errorKey: string; errorParams?: Record<string, string>; phase: 'failed' };

/**
 * Manual artifact install (design §3.2 / §6.1): the file is streamed to
 * `POST /webapi/admin/network-proxy/artifact`, where its sha256 must equal the pinned manifest
 * digest — so this button cannot install an arbitrary binary.
 *
 * Three states, never a lone toast: uploading (with progress and a cancel control) → verified
 * (digest + version) or failed (with the reason and the button still available to retry).
 * Oversized files are rejected here so a 60 MB upload is not spent to learn it was too big.
 *
 * antd `Upload` is used only as the file picker; the transfer itself is our own XHR because the
 * platform needs upload progress for a ~45 MB artifact.
 */
const ArtifactUploadButton = memo<ArtifactUploadButtonProps>(
  ({ disabled, expectedDigest, kind, onInstalled, service }) => {
    const { t } = useTranslation('admin');
    const { authMethod } = useAdminAccess();
    const [state, setState] = useState<UploadPhase>({ phase: 'idle' });
    const abortRef = useRef<AbortController | null>(null);

    // Leaving the page mid-upload must not keep the request (or its progress handler) alive.
    useEffect(
      () => () => {
        abortRef.current?.abort();
        abortRef.current = null;
      },
      [],
    );

    const upload = useCallback(
      async (file: File) => {
        if (file.size > NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES) {
          setState({
            errorKey: 'networkProxy.engine.uploadTooLarge',
            errorParams: {
              limit: formatBytes(NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES),
              size: formatBytes(file.size),
            },
            phase: 'failed',
          });
          return;
        }

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setState({ phase: 'uploading', ratio: 0 });

        await runAdminMutation({
          authMethod,
          onError: (error) => {
            if (controller.signal.aborted) {
              setState({ phase: 'idle' });
              return;
            }
            setState({ errorKey: networkProxyErrorKey(error), phase: 'failed' });
          },
          run: async () => {
            const result = await service.uploadArtifact({
              file,
              kind,
              onProgress: (ratio) => setState({ phase: 'uploading', ratio }),
              signal: controller.signal,
            });
            setState({ phase: 'verified', result });
            onInstalled();
          },
        });
        if (abortRef.current === controller) abortRef.current = null;
      },
      [authMethod, kind, onInstalled, service],
    );

    const uploading = state.phase === 'uploading';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div className={styles.inlineActions}>
          <Upload
            accept=".gz,application/gzip,application/octet-stream"
            disabled={disabled || uploading}
            showUploadList={false}
            beforeUpload={(file) => {
              void upload(file as unknown as File);
              // We own the transfer; keep antd out of the request and the file list.
              return Upload.LIST_IGNORE;
            }}
          >
            <Button disabled={disabled} loading={uploading} size="small">
              {t('networkProxy.engine.upload')}
            </Button>
          </Upload>
          {uploading ? (
            <Button size="small" onClick={() => abortRef.current?.abort()}>
              {t('networkProxy.actions.cancel')}
            </Button>
          ) : null}
        </div>

        {expectedDigest ? (
          <span className={styles.hintText}>
            {t('networkProxy.engine.expectedDigestLine', { sha: shortDigest(expectedDigest) })}
          </span>
        ) : null}

        {uploading ? (
          <div
            aria-label={t('networkProxy.engine.uploading')}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(state.ratio * 100)}
            className={styles.progressTrack}
            role="progressbar"
          >
            <div className={styles.progressValue} style={{ width: `${state.ratio * 100}%` }} />
          </div>
        ) : null}

        {state.phase === 'verified' ? (
          <Text style={{ fontSize: 12 }} type="success">
            {t('networkProxy.engine.uploadVerified', {
              sha: state.result.sha256.slice(0, 12),
              version: state.result.version,
            })}
          </Text>
        ) : null}

        {state.phase === 'failed' ? (
          <Text role="alert" style={{ fontSize: 12 }} type="danger">
            {t(state.errorKey as never, state.errorParams)}
          </Text>
        ) : null}
      </div>
    );
  },
);

ArtifactUploadButton.displayName = 'NetworkProxyArtifactUploadButton';

export default ArtifactUploadButton;
