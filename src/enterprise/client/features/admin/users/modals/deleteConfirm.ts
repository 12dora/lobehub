/**
 * Hard-delete type-to-confirm validator (production).
 * Submit stays disabled until the typed label exactly matches the target.
 */
export const HARD_DELETE_TYPE_CONFIRM_MISMATCH = 'users.modals.delete.typeConfirmMismatch';

export const validateHardDeleteConfirm = (
  confirmText: string,
  targetLabel: string,
): string | null => {
  if (confirmText.trim() !== targetLabel) {
    return HARD_DELETE_TYPE_CONFIRM_MISMATCH;
  }
  return null;
};
