// @vitest-environment node
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ADMIN_WEBAPI_ROUTE_REGISTRY } from './adminWebapiRouteRegistry';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../../');
const adminWebapiRoot = path.join(repoRoot, 'src/app/(backend)/webapi/admin');

const collectRouteFiles = (dir: string, out: string[] = []): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectRouteFiles(full, out);
      continue;
    }
    if (entry === 'route.ts') out.push(full);
  }
  return out;
};

const routeFileToPath = (file: string): string => {
  const relative = path
    .relative(path.join(repoRoot, 'src/app/(backend)'), file)
    .replaceAll('\\', '/');
  return `/${relative.replace(/\/route\.ts$/, '')}`;
};

describe('admin webapi route registry', () => {
  it('registers every src/app/(backend)/webapi/admin/**/route.ts file', () => {
    const files = collectRouteFiles(adminWebapiRoot);
    const livePaths = files.map(routeFileToPath).sort();
    const registered = ADMIN_WEBAPI_ROUTE_REGISTRY.map((entry) => entry.path).sort();

    expect(livePaths, 'every admin webapi route.ts must be registered').toEqual(registered);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('marks the artifact upload as a dangerous NETWORK_PROXY_MANAGE mutation', () => {
    expect(ADMIN_WEBAPI_ROUTE_REGISTRY).toEqual([
      expect.objectContaining({
        dangerous: true,
        method: 'POST',
        path: '/webapi/admin/network-proxy/artifact',
        rateLimit: 'admin-mutation',
        reauth: true,
      }),
    ]);
  });
});
