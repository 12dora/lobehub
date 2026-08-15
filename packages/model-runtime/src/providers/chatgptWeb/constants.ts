/**
 * Wire constants for the ChatGPT Web (chatgpt.com) private protocol.
 *
 * Everything here is copied from the observed browser traffic / the
 * `basketikun/chatgpt2api` reference implementation. Values that are known to
 * rot over time are flagged with a ROTS comment.
 */

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
export const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js';

/**
 * ROTS: these two are pinned build markers of the chatgpt.com web bundle. They
 * are only the FALLBACK — the live values are scraped from the bootstrap HTML we
 * already fetch for the pow resources (see `parseClientBuildInfo`). Refresh them
 * from a fresh browser session's request headers if the bootstrap ever stops
 * being reachable and the sentinel flow starts failing wholesale.
 */
export const OAI_CLIENT_VERSION = 'prod-ee87f098e2f639d6379472eb197d55ab7018cdff';
export const OAI_CLIENT_BUILD_NUMBER = '9395725';

/**
 * Browser fingerprint. Kept coherent with the TLS impersonation profile used by
 * the server-side transport (curl-impersonate `chrome136`): a Chrome 136 on
 * Windows. Do NOT mix Edge UA with a Chrome TLS fingerprint.
 */
export const CHROME_MAJOR = '136';
export const CHROME_FULL_VERSION = '136.0.7103.114';
export const DEFAULT_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
export const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not.A/Brand";v="99"`;
export const SEC_CH_UA_FULL_VERSION_LIST = `"Chromium";v="${CHROME_FULL_VERSION}", "Google Chrome";v="${CHROME_FULL_VERSION}", "Not.A/Brand";v="99.0.0.0"`;
export const SEC_CH_UA_PLATFORM = '"Windows"';
export const SEC_CH_UA_PLATFORM_VERSION = '"19.0.0"';

export const DEFAULT_LOCALE = 'en-US';
export const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
export const DEFAULT_TIMEZONE = 'UTC';
export const DEFAULT_TIMEZONE_OFFSET_MIN = 0;

/** Proof-of-work token prefixes. */
export const POW_CONFIG_PREFIX = 'gAAAAAC';
export const POW_PROOF_PREFIX = 'gAAAAAB';

export const POW_ITERATION_LIMIT = 500_000;
/** Yield to the event loop every N iterations so a long solve cannot freeze it. */
export const POW_YIELD_EVERY = 2000;

export const POW_CORES = [8, 16, 24, 32];
/** ROTS: React internal property names observed on chatgpt.com's document. */
export const POW_DOCUMENT_KEYS = [
  '__reactContainer$fzelfjyxej8',
  '_reactListening5dehydibo78',
  'location',
];
export const POW_SCREEN_RESOLUTIONS = [
  [1920, 1080],
  [1440, 900],
  [2560, 1440],
  [3840, 2160],
];

/**
 * NOTE: the separator below is U+2212 MINUS SIGN, not an ASCII hyphen. Keep it.
 */
export const POW_NAVIGATOR_KEYS = [
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
  'credentials−[object CredentialsContainer]',
  'serviceWorker−[object ServiceWorkerContainer]',
  'keyboard−[object Keyboard]',
  'gpu−[object GPU]',
  'doNotTrack',
  'serial−[object Serial]',
  'pdfViewerEnabled−true',
  'language−en-US',
  'geolocation−[object Geolocation]',
  'userAgentData−[object NavigatorUAData]',
  'getUserMedia−function getUserMedia() { [native code] }',
  'sendBeacon−function sendBeacon() { [native code] }',
  'hardwareConcurrency−32',
  'windowControlsOverlay−[object WindowControlsOverlay]',
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

export const CLIENT_CONTEXTUAL_INFO = {
  is_dark_mode: false,
  page_height: 900,
  page_width: 1400,
  pixel_ratio: 2,
  screen_height: 1440,
  screen_width: 2560,
  time_since_loaded: 120,
} as const;

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
export const FLOW_CLIENT_CONTEXTUAL_INFO = {
  attachments: {
    app_name: 'chatgpt.com',
    is_dark_mode: false,
    page_height: 1138,
    page_width: 803,
    pixel_ratio: 2,
    screen_height: 1440,
    screen_width: 2560,
    time_since_loaded: 401,
  },
  picture: {
    app_name: 'chatgpt.com',
    is_dark_mode: false,
    page_height: 1072,
    page_width: 1724,
    pixel_ratio: 1.2,
    screen_height: 1440,
    screen_width: 2560,
    time_since_loaded: 1200,
  },
  search: {
    app_name: 'chatgpt.com',
    is_dark_mode: false,
    page_height: 925,
    page_width: 886,
    pixel_ratio: 2,
    screen_height: 1440,
    screen_width: 2560,
    time_since_loaded: 36,
  },
} as const;

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
