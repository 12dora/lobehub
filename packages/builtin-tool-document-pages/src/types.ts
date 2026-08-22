export const DocumentPagesIdentifier = 'lobe-document-pages';

export const DocumentPagesApiName = {
  viewDocumentPages: 'viewDocumentPages',
} as const;

export type DocumentPagesApiNameType =
  (typeof DocumentPagesApiName)[keyof typeof DocumentPagesApiName];

export type DocumentPagesZoom = 'page' | 'tiles';

export interface ViewDocumentPagesParams {
  fileId: string;
  pages: number[];
  zoom?: DocumentPagesZoom;
}

export interface ViewDocumentPagesState {
  fileId?: string;
  fileName?: string;
  markerCount?: number;
  pages?: number[];
  status?: 'pending' | 'processing' | 'ready' | 'unavailable';
  zoom?: DocumentPagesZoom;
}

export type DocumentPageImageKind = 'page' | 'tile';

export interface DocumentPageImageMarker {
  fileId: string;
  key: string;
  kind: DocumentPageImageKind;
  page: number;
}

/** Marker line emitted in tool `content` so the inliner can inject `image_url` parts. */
export const formatDocumentPageImageMarker = (marker: DocumentPageImageMarker): string =>
  `<document_page_image fileId="${marker.fileId}" page="${marker.page}" kind="${marker.kind}" key="${marker.key}"/>`;

export const DOCUMENT_PAGE_IMAGE_MARKER_RE =
  /<document_page_image\s+fileId="([^"]+)"\s+page="(\d+)"\s+kind="(page|tile)"\s+key="([^"]+)"\s*\/>/g;

export const PAGE_IMAGES_SHOWN_EARLIER = '[page images were shown earlier]';

export const parseDocumentPageImageMarkers = (content: string): DocumentPageImageMarker[] => {
  const markers: DocumentPageImageMarker[] = [];
  const re = new RegExp(DOCUMENT_PAGE_IMAGE_MARKER_RE.source, 'g');
  for (const match of content.matchAll(re)) {
    const page = Number(match[2]);
    if (!match[1] || !match[4] || !Number.isFinite(page)) continue;
    const kind = match[3] === 'tile' ? 'tile' : 'page';
    markers.push({ fileId: match[1], key: match[4], kind, page });
  }
  return markers;
};

export const replaceDocumentPageImageMarkers = (content: string, replacement: string): string => {
  const re = new RegExp(DOCUMENT_PAGE_IMAGE_MARKER_RE.source, 'g');
  if (!re.test(content)) return content;
  const stripped = content
    .replace(new RegExp(DOCUMENT_PAGE_IMAGE_MARKER_RE.source, 'g'), '')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
  return stripped ? `${stripped}\n${replacement}` : replacement;
};
