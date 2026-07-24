'use client';

/**
 * Thin re-export of the users reason+reauth modal so audit mutations share one UX.
 * Keep reason / reauth / abort semantics identical — do not fork a second modal.
 */
export { openReasonModal as openAuditReasonModal } from '@/enterprise/client/features/admin/users/modals/openReasonModal';
