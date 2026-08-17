'use client';

import { Text } from '@lobehub/ui';
import { Button, confirmModal } from '@lobehub/ui/base-ui';
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
  /** sha256 of the file as it is stored on the server (decompressed binary / raw data file). */
  expectedDigest?: string | null;
  /** sha256 of the gzip release asset, when the kind is normally shipped compressed. */
  expectedGzDigest?: string | null;
  kind: NetworkProxyArtifactKind;
  /** Refresh artifact status once a file has been verified and installed. */
  onInstalled: () => void;
  service: AdminNetworkProxyService;
}

type UploadPhase =
  | { phase: 'idle' }
  | { phase: 'hashing' }
  | { phase: 'uploading'; ratio: number }
  | { phase: 'verified'; result: AdminNetworkProxyUploadResult }
  | { errorKey: string; errorParams?: Record<string, string>; phase: 'failed' };

const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** sha256 of the picked file, plus whether it is a gzip stream (decided by magic bytes). */
const digestFile = async (file: File): Promise<{ gzip: boolean; sha256: string }> => {
  const bytes = await file.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const gzip = head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { gzip, sha256 };
};

/**
 * Manual artifact install (design §3.2 / §6.1): the file is streamed to
 * `POST /webapi/admin/network-proxy/artifact`, where its sha256 is compared with the pinned
 * manifest digest.
 *
 * The digest is checked here first, before a single byte is uploaded: a matching file goes
 * straight up; a mismatch opens a warning the administrator can dismiss or override — the
 * override uploads with `acceptMismatch`, the server records the accepted digest next to the file
 * and marks the install as unverified. Oversized files are rejected before hashing.
 *
 * antd `Upload` is used only as the file picker; the transfer itself is our own XHR because the
 * platform needs upload progress for a ~45 MB artifact.
 */
const ArtifactUploadButton = memo<ArtifactUploadButtonProps>(
  ({ disabled, expectedDigest, expectedGzDigest, kind, onInstalled, service }) => {
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

    const transfer = useCallback(
      async (file: File, acceptMismatch: boolean) => {
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
              acceptMismatch,
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

        // Nothing to compare against (catalogue unavailable) — let the server be the judge.
        if (!expectedDigest && !expectedGzDigest) {
          await transfer(file, false);
          return;
        }

        setState({ phase: 'hashing' });
        let local: { gzip: boolean; sha256: string };
        try {
          local = await digestFile(file);
        } catch {
          // No WebCrypto (very old browser / insecure context): fall back to the server check.
          await transfer(file, false);
          return;
        }
        const expected = local.gzip && expectedGzDigest ? expectedGzDigest : expectedDigest;
        if (!expected || local.sha256 === expected) {
          await transfer(file, false);
          return;
        }

        setState({ phase: 'idle' });
        confirmModal({
          cancelText: t('networkProxy.engine.digestMismatch.cancel'),
          content: t('networkProxy.engine.digestMismatch.desc', {
            actual: shortDigest(local.sha256),
            expected: shortDigest(expected),
          }),
          okButtonProps: { danger: true },
          okText: t('networkProxy.engine.digestMismatch.confirm'),
          onOk: async () => {
            await transfer(file, true);
          },
          title: t('networkProxy.engine.digestMismatch.title'),
        });
      },
      [expectedDigest, expectedGzDigest, t, transfer],
    );

    const uploading = state.phase === 'uploading';
    const busy = uploading || state.phase === 'hashing';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div className={styles.inlineActions}>
          <Upload
            accept=".gz,.dat,.metadb,application/gzip,application/octet-stream"
            disabled={disabled || busy}
            showUploadList={false}
            beforeUpload={(file) => {
              void upload(file as unknown as File);
              // We own the transfer; keep antd out of the request and the file list.
              return Upload.LIST_IGNORE;
            }}
          >
            <Button disabled={disabled} loading={busy} size="small">
              {t('networkProxy.engine.upload')}
            </Button>
          </Upload>
          {uploading ? (
            <Button size="small" onClick={() => abortRef.current?.abort()}>
              {t('networkProxy.actions.cancel')}
            </Button>
          ) : null}
        </div>

        {state.phase === 'hashing' ? (
          <span className={styles.hintText}>{t('networkProxy.engine.hashing')}</span>
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
          <Text
            style={{ fontSize: 12 }}
            type={state.result.pinnedDigestMatch === false ? 'warning' : 'success'}
          >
            {t(
              state.result.pinnedDigestMatch === false
                ? 'networkProxy.engine.uploadAccepted'
                : 'networkProxy.engine.uploadVerified',
              {
                sha: state.result.sha256.slice(0, 12),
                version: state.result.version,
              },
            )}
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
