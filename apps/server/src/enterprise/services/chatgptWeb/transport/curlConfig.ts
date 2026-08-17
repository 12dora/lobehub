import type { CurlImpersonateFetchOptions } from './curlImpersonateFetch';
import { ChatGPTWebTransportPolicyError } from './errors';
import { hasControlCharacters } from './request';
import type { TransportEnvironment } from './resolveBinary';

/** Verified against chatgpt.com: `chrome145` is challenged, `chrome136` is not. */
export const DEFAULT_IMPERSONATE_PROFILE = 'chrome136';

/** Chat streams run long; the per-request cap only guards a wedged connection. */
const DEFAULT_TIMEOUT_MS = 600_000;
const CONNECT_TIMEOUT_SECONDS = 20;
/** Enough for a curl diagnostic; never large enough to hold a response body. */
export const MAX_STDERR_BYTES = 8192;

export const fetchFailed = (code: number | null, stderr: string): TypeError => {
  const detail = stderr.trim().slice(0, 500);
  return new TypeError(`fetch failed: curl(${code ?? 'signal'})${detail ? `: ${detail}` : ''}`);
};

interface CurlInvocation {
  args: string[];
  config: string;
}

/**
 * curl config-file quoting (`docs/cmdline-opts` "config file"): a quoted parameter takes
 * `\\`, `\"`, `\t`, `\n`, `\r`, `\v` escapes. Everything else is literal.
 */
const quoteConfigValue = (value: string): string =>
  `"${value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\t', String.raw`\t`)}"`;

const assertConfigSafe = (label: string, value: string): string => {
  if (hasControlCharacters(value.replaceAll('\t', ''))) {
    throw new ChatGPTWebTransportPolicyError(`${label} contains control characters`);
  }
  return value;
};

/**
 * Split the invocation into ARGV (non-secret constants only) and a CONFIG FILE handed to
 * the child on STDIN as `--config -`.
 *
 * Everything credential-bearing lives in the config: the URL (signed download links carry
 * their signature in the query), the proxy (may embed user:password) and every header
 * (`Authorization: Bearer …`). argv is world-readable through `ps` / `/proc/<pid>/cmdline`
 * and is copied into crash reports and process telemetry; a pipe is readable only by the
 * two processes that hold it.
 *
 * Why stdin and not an extra inherited fd: libuv's `spawn` gives extra `pipe` fds as UNIX
 * SOCKETPAIRS, and on Linux `fopen("/dev/fd/N")` on a socket fails with ENXIO — so
 * `--config /dev/fd/4` died with `curl: cannot read config from '/dev/fd/4'` (exit 26) in
 * every container. It only ever worked on macOS, whose fdesc filesystem re-opens sockets.
 * stdin is a pipe curl opens by descriptor, so it works on both.
 */
export const buildInvocation = (params: {
  bodyFilePath?: string;
  caBundle?: string;
  headers: [string, string][];
  impersonate: string;
  method: string;
  proxyUrl?: string;
  timeoutMs: number;
  url: string;
}): CurlInvocation => {
  const args = [
    // MUST be argv[0]: curl reads `$CURL_HOME/.curlrc` (then XDG_CONFIG_HOME / HOME)
    // BEFORE any other option unless `--disable` is the very first argument. A host config
    // owned by whoever runs the server could turn on `location` (redirects — the hostname
    // allowlist only validates the FIRST url, so a redirect would carry the `Authorization`
    // header to an unvalidated destination), add a second `url`, or `output` the body to a
    // file. Passing it later is not equivalent: by then the file has already been parsed.
    '--disable',
    '--impersonate',
    params.impersonate,
    '--compressed',
    '--no-buffer',
    '--silent',
    '--show-error',
    '--http2',
    '--max-time',
    String(Math.max(1, Math.ceil(params.timeoutMs / 1000))),
    '--connect-timeout',
    String(CONNECT_TIMEOUT_SECONDS),
    // Headers first on STDOUT, body after: curl writes the dump before any body byte, so
    // the two are split by position, not by descriptor (see the note above on /dev/fd).
    '--dump-header',
    '-',
    // Secret-bearing options on stdin, never on the command line.
    '--config',
    '-',
  ];

  if (params.proxyUrl) args.push('--suppress-connect-headers');

  const lines = [
    `url = ${quoteConfigValue(assertConfigSafe('url', params.url))}`,
    `request = ${quoteConfigValue(assertConfigSafe('method', params.method))}`,
  ];
  if (params.proxyUrl) {
    lines.push(`proxy = ${quoteConfigValue(assertConfigSafe('proxy', params.proxyUrl))}`);
  }
  if (params.caBundle) {
    lines.push(`cacert = ${quoteConfigValue(assertConfigSafe('cacert', params.caBundle))}`);
  }
  // Only when there IS a body: `data-binary` alone would turn a GET into a zero-length
  // entity request with a form content-type. stdin is taken by the config, so the bytes
  // travel through an owner-only temp file that is unlinked as soon as curl exits.
  if (params.bodyFilePath) {
    lines.push(
      `data-binary = ${quoteConfigValue(assertConfigSafe('body file', `@${params.bodyFilePath}`))}`,
    );
  }
  for (const [name, value] of params.headers) {
    // curl reads `Name:` as "drop this header"; `Name;` sends it with an empty value.
    const header = value.length === 0 ? `${name};` : `${name}: ${value}`;
    lines.push(`header = ${quoteConfigValue(assertConfigSafe('header', header))}`);
  }

  return { args, config: `${lines.join('\n')}\n` };
};

export const readEnv = (options: CurlImpersonateFetchOptions, env: TransportEnvironment) => ({
  caBundle: options.caBundle || env.SSL_CERT_FILE || env.NODE_EXTRA_CA_CERTS || undefined,
  impersonate: options.impersonate || DEFAULT_IMPERSONATE_PROFILE,
  proxyUrl: options.proxyUrl || env.PROXY_URL || env.HTTPS_PROXY || env.https_proxy || undefined,
  timeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
});
