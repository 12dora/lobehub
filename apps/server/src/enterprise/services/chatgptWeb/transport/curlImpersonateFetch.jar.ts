import { isBrowserCookieJarTombstoned } from '../../browserSession/cookieJar';
import {
  createContextGoneError,
  ensureCookieJarFile,
  isContextCookieJarKey,
  resolveCookieJarPath,
  seedCookieJar,
} from './cookieJar';

/**
 * Map `X-AIHub-Cookie-Jar` (already stripped from the hop) onto a Netscape jar
 * path. Precedence is load-bearing: a tombstoned context jar is gone; a legacy
 * device-id key still seeds `oai-did`; a factory path is only ensured when no
 * per-request key was supplied.
 */
export const resolveCliCookieJarPath = (
  cookieJarKey: string | undefined,
  factoryCookieJarPath: string | undefined,
): string | undefined => {
  let cookieJarPath = factoryCookieJarPath;
  if (cookieJarKey) {
    cookieJarPath = resolveCookieJarPath(cookieJarKey);
    if (cookieJarPath && isBrowserCookieJarTombstoned(cookieJarPath)) {
      if (isContextCookieJarKey(cookieJarKey)) throw createContextGoneError();
      cookieJarPath = undefined;
    } else if (
      cookieJarPath &&
      !isContextCookieJarKey(cookieJarKey) &&
      !cookieJarKey.startsWith('/') &&
      !cookieJarKey.includes('/')
    ) {
      seedCookieJar(cookieJarPath, [
        { domain: '.chatgpt.com', name: 'oai-did', value: cookieJarKey },
      ]);
    } else if (cookieJarPath) {
      ensureCookieJarFile(cookieJarPath);
    }
  } else if (cookieJarPath && isBrowserCookieJarTombstoned(cookieJarPath)) {
    cookieJarPath = undefined;
  } else if (cookieJarPath) {
    ensureCookieJarFile(cookieJarPath);
  }
  return cookieJarPath;
};
