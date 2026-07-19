import { defineConfig } from '@/libs/better-auth/define-config';

/**
 * Proxy only validates existing Better Auth sessions. Keep its provider config
 * environment-only so the middleware bundle never imports DB snapshot or LKG I/O.
 */
export const proxyAuth = defineConfig({ plugins: [] });
