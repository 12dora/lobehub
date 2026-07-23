/**
 * Re-export shim — canonical snapshot helpers live in admin primitives so
 * shared hooks (e.g. useReauthMutation) do not reverse-depend on users/modals.
 */
export {
  cloneFromCanonical,
  createCanonicalSnapshot,
  deepFreeze,
} from '@/enterprise/client/features/admin/primitives/payloadSnapshot';
