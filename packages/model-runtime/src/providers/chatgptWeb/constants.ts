/**
 * Wire constants for the ChatGPT Web (chatgpt.com) private protocol.
 *
 * Everything here is copied from the observed browser traffic / the
 * `basketikun/chatgpt2api` reference implementation. Values that are known to
 * rot over time are flagged with a ROTS comment.
 */

import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';

export const CHATGPT_BASE_URL = 'https://chatgpt.com';

export const PATHS = {
  accountsCheck: '/backend-api/accounts/check/v4-2023-04-27',
  conversation: '/backend-api/conversation',
  conversationInit: '/backend-api/conversation/init',
  fConversation: '/backend-api/f/conversation',
  fConversationPrepare: '/backend-api/f/conversation/prepare',
  fConversationResume: '/backend-api/f/conversation/resume',
  files: '/backend-api/files',
  me: '/backend-api/me',
  models: '/backend-api/models',
  sentinelRequirements: '/backend-api/sentinel/chat-requirements',
  tasks: '/backend-api/tasks',
} as const;

/**
 * `X-OpenAI-Target-Route` for per-conversation endpoints is sent by the real web
 * client as a *template*, with literal braces. Reproduce verbatim.
 */
export const TEMPLATED_ROUTES = {
  conversation: '/backend-api/conversation/{conversation_id}',
} as const;

/** Fallback pow script when the bootstrap HTML cannot be scraped (403 etc.). */
export const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/sentinel/20260810913b/sdk.js';

/**
 * ROTS: these two are pinned build markers of the chatgpt.com web bundle. They
 * are only the FALLBACK — the live values are scraped from the bootstrap HTML we
 * already fetch for the pow resources (see `parseClientBuildInfo`). Refresh them
 * from a fresh browser session's request headers if the bootstrap ever stops
 * being reachable and the sentinel flow starts failing wholesale.
 */
export const OAI_CLIENT_VERSION = 'prod-7fbaec23e81031dd954e1cf0bc3eecaf58cdd2ab';
export const OAI_CLIENT_BUILD_NUMBER = '9544329';

/** Proof-of-work token prefixes. */
export const POW_CONFIG_PREFIX = 'gAAAAAC';
export const POW_PROOF_PREFIX = 'gAAAAAB';

export const POW_ITERATION_LIMIT = 500_000;
/** Yield to the event loop every N iterations so a long solve cannot freeze it. */
export const POW_YIELD_EVERY = 2000;

/** React uses one random internal-key suffix for the lifetime of the page bundle. */
const REACT_INTERNAL_SUFFIX = Math.random().toString(36).slice(2);

export const POW_DOCUMENT_KEYS = [
  `__reactContainer$${REACT_INTERNAL_SUFFIX}`,
  `_reactListening${REACT_INTERNAL_SUFFIX}`,
  'location',
];
/**
 * NOTE: the separator below is U+2212 MINUS SIGN, not an ASCII hyphen. Keep it.
 * Locale and core-count keys are appended from the persisted browser profile.
 */
const POW_NAVIGATOR_KEYS_BASE = [
  'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
  'storage−[object StorageManager]',
  'locks−[object LockManager]',
  'appCodeName−Mozilla',
  'permissions−[object Permissions]',
  'share−function share() { [native code] }',
  'webdriver−false',
  'managed−[object NavigatorManagedData]',
  'canShare−function canShare() { [native code] }',
  'vendor−Google Inc.',
  'mediaDevices−[object MediaDevices]',
  'vibrate−function vibrate() { [native code] }',
  'storageBuckets−[object StorageBucketManager]',
  'mediaCapabilities−[object MediaCapabilities]',
  'cookieEnabled−true',
  'virtualKeyboard−[object VirtualKeyboard]',
  'product−Gecko',
  'presentation−[object Presentation]',
  'onLine−true',
  'mimeTypes−[object MimeTypeArray]',
  'plugins−[object PluginArray]',
  'credentials−[object CredentialsContainer]',
  'serviceWorker−[object ServiceWorkerContainer]',
  'keyboard−[object Keyboard]',
  'gpu−[object GPU]',
  'doNotTrack',
  'serial−[object Serial]',
  'pdfViewerEnabled−true',
  'geolocation−[object Geolocation]',
  'userAgentData−[object NavigatorUAData]',
  'getUserMedia−function getUserMedia() { [native code] }',
  'sendBeacon−function sendBeacon() { [native code] }',
  'windowControlsOverlay−[object WindowControlsOverlay]',
] as const;

export const buildPowNavigatorKeys = (profile: RuntimeBrowserDeviceProfile): string[] => [
  ...POW_NAVIGATOR_KEYS_BASE,
  `language\u2212${profile.languages[0] ?? profile.oaiLanguage}`,
  `hardwareConcurrency\u2212${profile.hardwareConcurrency}`,
];

export const POW_WINDOW_KEYS = [
  '0',
  'window',
  'self',
  'document',
  'name',
  'location',
  'customElements',
  'history',
  'navigation',
  'innerWidth',
  'innerHeight',
  'scrollX',
  'scrollY',
  'scrollBy',
  'visualViewport',
  'screenX',
  'screenY',
  'outerWidth',
  'outerHeight',
  'devicePixelRatio',
  'screen',
  'chrome',
  'navigator',
  'onresize',
  'performance',
  'crypto',
  'indexedDB',
  'sessionStorage',
  'localStorage',
  'scheduler',
  'alert',
  'atob',
  'btoa',
  'fetch',
  'matchMedia',
  'postMessage',
  'queueMicrotask',
  'requestAnimationFrame',
  'setInterval',
  'setTimeout',
  'caches',
  '__NEXT_DATA__',
  '__BUILD_MANIFEST',
  '__NEXT_PRELOADREADY',
];

/** ROTS: localStorage keys the turnstile VM expects to see on chatgpt.com. */
export const TURNSTILE_LOCAL_STORAGE_KEYS = [
  'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4',
  'STATSIG_LOCAL_STORAGE_STABLE_ID',
  'client-correlated-secret',
  'oai/apps/capExpiresAt',
  'oai-did',
  'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST',
  'UiState.isNavigationCollapsed.1',
];

/** Private-use-area annotation markers used for inline citations. */
export const ANNOTATION_START = '\uE200';
export const ANNOTATION_END = '\uE201';
export const ANNOTATION_SEPARATOR = '\uE202';

export const ASSET_POINTER_PREFIXES = {
  fileService: 'file-service://',
  sediment: 'sediment://',
} as const;

/** Azure blob PUT headers for the signed upload URL. */
export const AZURE_BLOB_HEADERS = {
  'x-ms-blob-type': 'BlockBlob',
  'x-ms-version': '2020-04-08',
} as const;

/** Statuses worth retrying while polling conversation / file documents. */
export const RETRYABLE_POLL_STATUSES = new Set([404, 409, 423, 429, 500, 502, 503, 504]);

export const TIMEOUTS = {
  /** Signed-blob PUT + binary downloads. */
  binary: 120_000,
  /** GET https://chatgpt.com/ bootstrap. */
  bootstrap: 30_000,
  /** Regular JSON calls. */
  json: 60_000,
  /** Sentinel prepare / finalize. */
  sentinel: 30_000,
  /** Whole SSE conversation. */
  streamHardCap: 300_000,
  /** No SSE frame for this long ⇒ give up. */
  streamIdle: 60_000,
} as const;

export const buildClientContextualInfo = (profile: RuntimeBrowserDeviceProfile) => ({
  is_dark_mode: profile.prefersColorScheme === 'dark',
  page_height: Math.min(900, profile.screen.availHeight),
  page_width: Math.min(1400, profile.screen.availWidth),
  pixel_ratio: profile.screen.dpr,
  screen_height: profile.screen.height,
  screen_width: profile.screen.width,
  time_since_loaded: 120,
});

/**
 * `/backend-api/f/conversation` sends a viewport fingerprint that differs per
 * flow in the observed traffic (E6 §1.3 for search, E3 §1.4 for picture_v2, and
 * the editable/attachment flow for documents). They are transcribed verbatim
 * rather than collapsed into one block — this is a fingerprinted endpoint.
 *
 * `attachments` doubles as the DEFAULT composer fingerprint: a plain turn with
 * no attachment at all sends exactly this block (verified live 2026-08-15), and
 * every plain chat turn now takes the conduit path.
 */
export const buildFlowClientContextualInfo = (profile: RuntimeBrowserDeviceProfile) => ({
  attachments: {
    app_name: 'chatgpt.com',
    has_web_push_capabilities: true,
    is_dark_mode: profile.prefersColorScheme === 'dark',
    page_height: Math.min(856, profile.screen.availHeight),
    page_width: Math.min(741, profile.screen.availWidth),
    pixel_ratio: profile.screen.dpr,
    screen_height: profile.screen.height,
    screen_width: profile.screen.width,
    time_since_loaded: 874,
    web_push_notification_permission: 'default',
  },
  picture: {
    app_name: 'chatgpt.com',
    is_dark_mode: profile.prefersColorScheme === 'dark',
    page_height: Math.min(1072, profile.screen.availHeight),
    page_width: Math.min(1724, profile.screen.availWidth),
    pixel_ratio: profile.screen.dpr,
    screen_height: profile.screen.height,
    screen_width: profile.screen.width,
    time_since_loaded: 1200,
  },
  search: {
    app_name: 'chatgpt.com',
    is_dark_mode: profile.prefersColorScheme === 'dark',
    page_height: Math.min(925, profile.screen.availHeight),
    page_width: Math.min(886, profile.screen.availWidth),
    pixel_ratio: profile.screen.dpr,
    screen_height: profile.screen.height,
    screen_width: profile.screen.width,
    time_since_loaded: 36,
  },
});

/**
 * `client_prepare_state` on the `/f/conversation` call. Search reports
 * `success`; the image and attachment flows report `sent`.
 */
export const FLOW_CLIENT_PREPARE_STATE = {
  attachments: 'sent',
  picture: 'sent',
  search: 'success',
} as const;

export const SEARCH_SOURCE = 'conversation_composer_web_icon';
export const CLIENT_CREATED_ROOT = 'client-created-root';
