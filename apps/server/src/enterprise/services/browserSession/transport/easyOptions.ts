import { fetchFailed } from '../../chatgptWeb/transport/curlConfig';
import {
  CONNECT_TIMEOUT_MS,
  CURL_HTTP_VERSION_2TLS,
  CURLOPT,
  type LibcurlBindings,
  setoptLong,
  setoptOffT,
  setoptPointer,
  setoptString,
} from './libcurlFfi';

export interface EasyRequestOptions {
  body?: Uint8Array;
  caBundle?: string;
  cookieJarPath?: string;
  dropHeaders?: string[];
  headers: [string, string][];
  method: string;
  proxyUrl?: string;
  timeoutMs: number;
  url: string;
}

const checkEasy = (bindings: LibcurlBindings, rc: number): void => {
  if (rc === 0) return;
  let detail: string;
  try {
    detail = bindings.curl_easy_strerror(rc) ?? '';
  } catch {
    detail = '';
  }
  throw fetchFailed(rc, detail);
};

/**
 * Empty values and `dropHeaders` are rendered as `Name:` (delete the
 * impersonate leftover). The runtime uses empty string as that signal
 * (`headers.ts#dropNavigationOnly`); there is no current need to send a
 * deliberately empty header (`Name;`).
 */
export const buildHeaderSlist = (
  bindings: LibcurlBindings,
  headers: [string, string][],
  dropHeaders: string[],
): unknown => {
  let list: unknown = null;
  const dropped = new Set<string>(dropHeaders);
  const append = (line: string): void => {
    const next = bindings.curl_slist_append(list, line);
    if (!next) {
      if (list) bindings.curl_slist_free_all(list);
      throw new TypeError('fetch failed: curl_slist_append returned null');
    }
    list = next;
  };
  for (const [name, value] of headers) {
    if (value.length === 0) {
      dropped.add(name);
      continue;
    }
    append(`${name}: ${value}`);
  }
  for (const name of dropped) append(`${name}:`);
  return list;
};

export const applyEasyOptions = (
  bindings: LibcurlBindings,
  handle: unknown,
  request: EasyRequestOptions,
  slist: unknown,
  writeCb: bigint,
  headerCb: bigint,
): void => {
  const method = request.method.toUpperCase();
  const body = request.body;

  if ((method === 'GET' || method === 'HEAD') && body && body.byteLength > 0) {
    throw new TypeError(
      `ChatGPT Web transport does not support a request body on ${method} requests.`,
    );
  }

  checkEasy(bindings, setoptString(bindings, handle, CURLOPT.URL, request.url));
  checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.HTTP_VERSION, CURL_HTTP_VERSION_2TLS));
  checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.NOSIGNAL, 1));
  checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.PIPEWAIT, 1));
  checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.FOLLOWLOCATION, 0));
  checkEasy(
    bindings,
    setoptLong(bindings, handle, CURLOPT.TIMEOUT_MS, Math.max(1, request.timeoutMs)),
  );
  checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.CONNECTTIMEOUT_MS, CONNECT_TIMEOUT_MS));
  // Empty string = accept all encodings libcurl knows (`--compressed`).
  checkEasy(bindings, setoptString(bindings, handle, CURLOPT.ACCEPT_ENCODING, ''));
  checkEasy(bindings, setoptPointer(bindings, handle, CURLOPT.WRITEFUNCTION, writeCb));
  checkEasy(bindings, setoptPointer(bindings, handle, CURLOPT.HEADERFUNCTION, headerCb));

  if (slist) checkEasy(bindings, setoptPointer(bindings, handle, CURLOPT.HTTPHEADER, slist));

  if (request.proxyUrl) {
    checkEasy(bindings, setoptString(bindings, handle, CURLOPT.PROXY, request.proxyUrl));
    checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.SUPPRESS_CONNECT_HEADERS, 1));
  }
  if (request.caBundle) {
    checkEasy(bindings, setoptString(bindings, handle, CURLOPT.CAINFO, request.caBundle));
  }
  // COOKIEFILE loads the jar. Do NOT set COOKIEJAR — see cookieDelta.ts.
  if (request.cookieJarPath) {
    checkEasy(bindings, setoptString(bindings, handle, CURLOPT.COOKIEFILE, request.cookieJarPath));
  }

  const hasBody = body !== undefined;
  if (method === 'POST' || hasBody) {
    if (method === 'POST') checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.POST, 1));
    const payload = body ?? new Uint8Array(0);
    const copy = Buffer.from(payload);
    checkEasy(bindings, setoptOffT(bindings, handle, CURLOPT.POSTFIELDSIZE_LARGE, copy.byteLength));
    checkEasy(bindings, setoptPointer(bindings, handle, CURLOPT.COPYPOSTFIELDS, copy));
  }

  if (method !== 'GET' && method !== 'POST') {
    checkEasy(bindings, setoptString(bindings, handle, CURLOPT.CUSTOMREQUEST, method));
  }
  if (method === 'HEAD') checkEasy(bindings, setoptLong(bindings, handle, CURLOPT.NOBODY, 1));
};
