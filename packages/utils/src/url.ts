import mime from 'mime';

/**
 * Build a path string from a path and a hash/search object
 *
 * This function constructs a properly formatted URL path by combining a base path
 * with optional hash and search parameters. It uses URL constructor for proper
 * encoding and formatting while removing the temporary base domain.
 *
 * @param path - The base path (can be relative, absolute, or include protocol)
 * @param options - Optional configuration object
 * @param options.hash - Hash fragment to append (with or without leading #)
 * @param options.search - Search/query parameters to append (with or without leading ?)
 * @returns Formatted path string with hash and search parameters
 *
 * @example
 * ```typescript
 * pathString('/home') // '/home'
 * pathString('/home', { search: 'id=1&name=test' }) // '/home?id=1&name=test'
 * pathString('/home', { hash: 'top' }) // '/home#top'
 * pathString('./home') // '/home'
 * pathString('https://example.com/path') // 'https://example.com/path'
 * ```
 */
export const pathString = (
  path: string,
  {
    hash = '',
    search = '',
  }: {
    hash?: string;
    search?: string;
  } = {},
) => {
  // Use a temporary base URL for proper URL parsing and formatting
  const tempBase = 'https://a.com';
  const url = new URL(path, tempBase);

  // Add hash fragment if provided
  if (hash) url.hash = hash;
  // Add search parameters if provided
  if (search) url.search = search;

  // Return the formatted URL without the temporary base
  return url.toString().replace(tempBase, '');
};

/**
 * Get file extension from URL
 *
 * This function extracts the file extension from a URL's pathname and validates it against
 * common image formats. It properly handles URLs with query parameters, hash fragments,
 * relative paths, and various edge cases. Returns empty string for invalid cases.
 *
 * @param url - The URL to extract extension from (can be relative, absolute, or include query parameters and hash fragments)
 * @returns file extension without dot (e.g., 'jpg', 'png', 'webp'), or empty string for invalid cases
 *
 * @example
 * ```typescript
 * inferFileExtensionFromImageUrl('https://example.com/image.jpg') // 'jpg'
 * inferFileExtensionFromImageUrl('https://example.com/image.png?v=123') // 'png'
 * inferFileExtensionFromImageUrl('https://example.com/image.webp#section') // 'webp'
 * inferFileExtensionFromImageUrl('generations/images/photo.png') // 'png'
 * inferFileExtensionFromImageUrl('https://example.com/document.txt') // '' (empty string)
 * inferFileExtensionFromImageUrl('invalid-url') // '' (empty string)
 * ```
 */
export const inferFileExtensionFromImageUrl = (url: string): string => {
  // Use a temporary base URL for proper URL parsing and formatting (handles relative paths)
  const tempBase = 'https://a.com';
  const urlObj = new URL(url, tempBase);
  const pathname = urlObj.pathname;

  // Find the last dot in the pathname to get the file extension
  const lastDotIndex = pathname.lastIndexOf('.');
  if (lastDotIndex === -1) return ''; // No extension found, return empty string

  // Extract extension after the last dot and convert to lowercase
  const extension = pathname.slice(Math.max(0, lastDotIndex + 1)).toLowerCase();

  // Validate against common image extensions
  const validImageExtensions = ['webp', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'tiff', 'tif'];
  if (validImageExtensions.includes(extension)) {
    return extension;
  }

  // Default fallback for non-image extensions
  return '';
};

/**
 * Infer content type (MIME type) from an image URL
 *
 * This function extracts the file extension from a URL and returns the corresponding MIME type.
 * It properly handles URLs with query parameters, hash fragments, relative paths, and various edge cases.
 *
 * @param url - The image URL to analyze (can be relative, absolute, or include query parameters and hash fragments)
 * @returns MIME type string (e.g., 'image/jpeg', 'image/png')
 * @throws {Error} When the URL doesn't contain a valid file extension
 *
 * @example
 * ```typescript
 * inferContentTypeFromImageUrl('https://example.com/image.jpg') // 'image/jpeg'
 * inferContentTypeFromImageUrl('https://example.com/image.png?v=123') // 'image/png'
 * inferContentTypeFromImageUrl('https://example.com/image.webp#section') // 'image/webp'
 * inferContentTypeFromImageUrl('generations/images/photo.png') // 'image/png'
 * ```
 */
export function inferContentTypeFromImageUrl(url: string) {
  // Get the file extension using the dedicated function
  // inferFileExtensionFromImageUrl only returns valid image extensions or empty string
  const extension = inferFileExtensionFromImageUrl(url);

  // If no valid extension found, throw error
  if (!extension) {
    throw new Error(`Invalid image url: ${url}`);
  }

  // Get MIME type using the mime library
  // Since extension is guaranteed to be a valid image extension from the whitelist,
  // mime.getType() will always return a valid image MIME type
  const mimeType = mime.getType(extension);

  return mimeType!; // Non-null assertion is safe due to whitelist validation
}

/**
 *
 * Check if a URL points to desktop local static server
 *
 * @example
 * ```typescript
 * isDesktopLocalStaticServerUrl('http://127.0.0.1:8080/path') // true
 * isDesktopLocalStaticServerUrl('http://localhost:8080/path') // false
 * isDesktopLocalStaticServerUrl('https://example.com') // false
 * isDesktopLocalStaticServerUrl('invalid-url') // false (instead of throwing)
 * isDesktopLocalStaticServerUrl('') // false (instead of throwing)
 * ```
 *
 * check: apps/desktop/src/main/core/StaticFileServerManager.ts
 */
export function isDesktopLocalStaticServerUrl(url: string) {
  try {
    return new URL(url).hostname === '127.0.0.1';
  } catch {
    // Return false for malformed URLs instead of throwing
    return false;
  }
}

/**
 * Check if a URL points to localhost or private network address
 *
 * This function determines if the provided URL's hostname is a local or private network address.
 * It checks for:
 * - localhost (with or without domain suffix)
 * - 127.0.0.0/8 (loopback addresses)
 * - ::1 (IPv6 loopback)
 * - 0.0.0.0
 * - 10.0.0.0/8 (private network)
 * - 172.16.0.0/12 (private network)
 * - 192.168.0.0/16 (private network)
 *
 * It handles malformed URLs gracefully by returning false instead of throwing errors.
 *
 * @param url - The URL string to check
 * @returns true if the URL points to a local or private network address, false otherwise
 *
 * @example
 * ```typescript
 * isLocalOrPrivateUrl('http://127.0.0.1:8080/path') // true
 * isLocalOrPrivateUrl('http://localhost:3000') // true
 * isLocalOrPrivateUrl('http://192.168.1.1') // true
 * isLocalOrPrivateUrl('http://10.0.0.1') // true
 * isLocalOrPrivateUrl('https://example.com') // false
 * isLocalOrPrivateUrl('invalid-url') // false (instead of throwing)
 * isLocalOrPrivateUrl('') // false (instead of throwing)
 * ```
 */
export function isLocalOrPrivateUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check for localhost variants
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return true;
    }

    // Check for IPv6 loopback
    if (hostname === '::1' || hostname === '[::1]') {
      return true;
    }

    // Check for 0.0.0.0
    if (hostname === '0.0.0.0') {
      return true;
    }

    // Check for IPv4 loopback and private networks
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b, c, d] = ipv4Match.map(Number);

      // Validate that all octets are in valid range (0-255)
      if (a > 255 || b > 255 || c > 255 || d > 255) {
        return false;
      }

      // 127.0.0.0/8 - Loopback
      if (a === 127) {
        return true;
      }

      // 10.0.0.0/8 - Private network
      if (a === 10) {
        return true;
      }

      // 172.16.0.0/12 - Private network
      if (a === 172 && b >= 16 && b <= 31) {
        return true;
      }

      // 192.168.0.0/16 - Private network
      if (a === 192 && b === 168) {
        return true;
      }
    }

    return false;
  } catch {
    // Return false for malformed URLs instead of throwing
    return false;
  }
}

const withProtocol = (value: string): string =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;

const originOf = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return new URL(withProtocol(value)).origin.toLowerCase();
  } catch {
    return undefined;
  }
};

const APP_FILE_PATH = /^\/f\/[^/]+$/;

const normalizeBucket = (bucket: string): string => bucket.trim().replaceAll(/^\/+|\/+$/g, '');

const pathnameIsAppFileRoute = (pathname: string): boolean => APP_FILE_PATH.test(pathname);

const pathnameIsNonRootObject = (pathname: string): boolean =>
  pathname.length > 1 && pathname !== '/';

const pathnameIsPathStyleObject = (pathname: string, bucket: string): boolean => {
  const prefix = `/${normalizeBucket(bucket)}/`;
  return pathname.startsWith(prefix) && pathname.length > prefix.length;
};

export type OwnOriginPathPolicy =
  | { bucket: string; type: 's3-path-style' }
  | { type: 'app-file' }
  | { type: 's3-public' }
  | { type: 's3-virtual-host' };

export interface OwnOriginRule {
  origin: string;
  path: OwnOriginPathPolicy;
}

export interface OwnDeploymentOrigins {
  rewrite?: { fromOrigin: string; toOrigin: string };
  rules: OwnOriginRule[];
}

export interface OwnDeploymentOriginInput {
  appUrl?: string;
  bucket?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  internalAppUrl?: string;
  publicDomain?: string;
}

/**
 * Hostname only — never the path or query (presigned S3 URLs put credentials
 * in the query string). Safe to interpolate into logs.
 */
export const sanitizedUrlHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable url>';
  }
};

/**
 * Virtual-hosted origin only when the synthetic `{bucket}.{endpoint-host}`
 * hostname actually stuck. `URL.hostname` assignment is a silent no-op for
 * IP-literal endpoints (`127.0.0.1`, `[::1]`), which would otherwise yield
 * the original origin and an overly broad `s3-virtual-host` rule.
 */
const virtualHostOrigin = (endpoint: string, bucket: string): string | undefined => {
  try {
    const endpointUrl = new URL(withProtocol(endpoint));
    const expectedHostname = `${normalizeBucket(bucket)}.${endpointUrl.hostname}`;
    const virtual = new URL(endpointUrl.href);
    virtual.hostname = expectedHostname;
    if (virtual.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      return undefined;
    }
    return virtual.origin.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Pure allowlist builder. Callers pass the *effective* storage snapshot
 * (getInfraSnapshot) plus app origins — never read process.env here.
 */
export const buildOwnDeploymentOrigins = (
  input: OwnDeploymentOriginInput,
): OwnDeploymentOrigins => {
  const rules: OwnOriginRule[] = [];
  const appOrigin = originOf(input.appUrl);
  const internalOrigin = originOf(input.internalAppUrl);

  if (appOrigin) rules.push({ origin: appOrigin, path: { type: 'app-file' } });
  if (internalOrigin && internalOrigin !== appOrigin) {
    rules.push({ origin: internalOrigin, path: { type: 'app-file' } });
  }

  const bucket = input.bucket ? normalizeBucket(input.bucket) : '';
  const endpointOrigin = originOf(input.endpoint);
  if (bucket && input.endpoint && endpointOrigin) {
    if (!input.forcePathStyle) {
      const virtualOrigin = virtualHostOrigin(input.endpoint, bucket);
      if (virtualOrigin) {
        rules.push({ origin: virtualOrigin, path: { type: 's3-virtual-host' } });
      }
    }
    // Path-style on the configured endpoint, always under /{bucket}/:
    // - forcePathStyle=true (MinIO, etc.)
    // - IP-literal / non-virtual-host-capable endpoints (assignment no-op)
    // - AWS SDK fallback when forcePathStyle=false but the bucket is dotted
    //   (HTTPS wildcard certs cannot cover `my.bucket.s3.example.net`)
    rules.push({ origin: endpointOrigin, path: { bucket, type: 's3-path-style' } });
  }

  const publicOrigin = originOf(input.publicDomain);
  if (publicOrigin) {
    rules.push({ origin: publicOrigin, path: { type: 's3-public' } });
  }

  const rewrite =
    appOrigin && internalOrigin && appOrigin !== internalOrigin
      ? { fromOrigin: appOrigin, toOrigin: internalOrigin }
      : undefined;

  return { rewrite, rules };
};

const pathMatches = (pathname: string, policy: OwnOriginPathPolicy): boolean => {
  switch (policy.type) {
    case 'app-file': {
      return pathnameIsAppFileRoute(pathname);
    }
    case 's3-path-style': {
      return pathnameIsPathStyleObject(pathname, policy.bucket);
    }
    case 's3-public':
    case 's3-virtual-host': {
      return pathnameIsNonRootObject(pathname);
    }
    default: {
      return false;
    }
  }
};

/**
 * URLs that belong to this deployment's file storage. Compared by exact origin
 * (scheme + host + port) against caller-supplied rules. Fail closed when no
 * rules are provided — do not consult process.env.
 */
export function isOwnDeploymentFileUrl(url: string, origins?: OwnDeploymentOrigins): boolean {
  if (!origins?.rules.length) return false;

  try {
    const parsed = new URL(url);
    const origin = parsed.origin.toLowerCase();
    const pathname = parsed.pathname;

    return origins.rules.some((rule) => rule.origin === origin && pathMatches(pathname, rule.path));
  } catch {
    return false;
  }
}

/**
 * Prefer the internal app origin when fetching a public APP_URL `/f/` link.
 */
export function resolveOwnDeploymentFetchUrl(url: string, origins?: OwnDeploymentOrigins): string {
  const rewrite = origins?.rewrite;
  if (!rewrite) return url;

  try {
    const parsed = new URL(url);
    if (parsed.origin.toLowerCase() !== rewrite.fromOrigin) return url;
    if (!pathnameIsAppFileRoute(parsed.pathname)) return url;

    const internal = new URL(rewrite.toOrigin);
    parsed.protocol = internal.protocol;
    parsed.host = internal.host;
    return parsed.toString();
  } catch {
    return url;
  }
}
