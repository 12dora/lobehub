import { AgentDocumentVfsError } from './errors';

/**
 * Canonical path normalization shared by the VFS implementation and policy guards.
 * Keeping one implementation prevents authorization from classifying a different
 * path than the operation eventually resolves.
 */
export const normalizeAgentDocumentPath = (path: string): string => {
  const raw = path.trim();
  if (!raw || raw.includes('\\')) {
    throw new AgentDocumentVfsError(`Invalid VFS path: ${path}`, 'BAD_REQUEST');
  }

  const withDot =
    raw === '/' ? './' : raw.startsWith('./') ? raw : raw.startsWith('/') ? `.${raw}` : `./${raw}`;
  const collapsed = withDot.replaceAll(/\/+/g, '/');

  if (collapsed.includes('/./') || collapsed.includes('/../') || collapsed.endsWith('/..')) {
    throw new AgentDocumentVfsError(`Invalid VFS path: ${path}`, 'BAD_REQUEST');
  }

  return collapsed === './' ? './' : collapsed.replace(/\/$/, '');
};
