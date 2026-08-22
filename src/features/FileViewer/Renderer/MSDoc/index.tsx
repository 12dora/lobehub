'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import NotSupport from '../../NotSupport';
import PDFViewer from '../PDF';
import Preparing from './Preparing';
import PreviewFallback from './PreviewFallback';
import { useDocumentPreview } from './useDocumentPreview';

interface MSDocViewerProps {
  fileId: string;
  fileName?: string;
  /** Original office file URL — kept for the download fallback. */
  url: string | null;
}

/**
 * Office documents (doc/docx/ppt/pptx/xls/xlsx/odt) are previewed through the
 * server-side PDF rendition produced by our document-render sidecar, so the file
 * never leaves the deployment.
 */
const MSDocViewer = memo<MSDocViewerProps>(({ fileId, fileName, url }) => {
  const { t } = useTranslation('file');
  const { data, error, isLoading, retry, timedOut } = useDocumentPreview(fileId);

  if (isLoading && !data) return <Preparing />;

  if (error || !data) {
    return <PreviewFallback fileName={fileName} title={t('preview.document.failed')} url={url} />;
  }

  switch (data.status) {
    case 'ready': {
      if (!data.url) break;

      // The rendition is a different document from the office file: chunk
      // highlights are indexed against the original, so key the PDF viewer on a
      // derived id to keep them (and their cache entry) apart.
      return <PDFViewer fileId={`${fileId}:preview`} url={data.url} />;
    }

    case 'pending': {
      return <Preparing timedOut={timedOut} onRetry={retry} />;
    }

    case 'unavailable': {
      return (
        <PreviewFallback fileName={fileName} title={t('preview.document.unavailable')} url={url} />
      );
    }

    case 'unsupported': {
      return <NotSupport fileName={fileName} url={url} />;
    }
  }

  return (
    <PreviewFallback
      description={data.error}
      fileName={fileName}
      title={t('preview.document.failed')}
      url={url}
    />
  );
});

export default MSDocViewer;
