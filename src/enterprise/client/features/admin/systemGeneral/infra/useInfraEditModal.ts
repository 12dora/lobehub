'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseInfraEditModalParams {
  /** Seeds the draft from the current snapshot; the same step the inline editor used to run. */
  beginEdit: () => void;
  /** Throws the draft away. Closing the modal is the only way an edit is abandoned. */
  cancelEdit: () => void;
  /** Successful writes reported by the editor hook; each one closes the modal. */
  saveCount: number;
}

export interface InfraEditModal {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

/**
 * Open/close state for the 编辑 modal, tied to the editor hook that owns the draft.
 *
 * Opening seeds the draft and closing discards it, so a modal that was dismissed can never leave a
 * half-typed configuration behind the card's summary. A write the server accepted closes the modal
 * on its own — the operator does not have to dismiss a form whose work is done.
 */
export const useInfraEditModal = ({
  beginEdit,
  cancelEdit,
  saveCount,
}: UseInfraEditModalParams): InfraEditModal => {
  const [open, setOpen] = useState(false);

  /**
   * The editor hooks rebuild `beginEdit` / `cancelEdit` on every render and close over the current
   * baseline draft. They are read through refs so the callback identity stays stable without
   * capturing the first render's baseline — which would restore the wrong draft on cancel.
   */
  const beginRef = useRef(beginEdit);
  const cancelRef = useRef(cancelEdit);
  beginRef.current = beginEdit;
  cancelRef.current = cancelEdit;

  const onOpenChange = useCallback((next: boolean) => {
    if (next) beginRef.current();
    else cancelRef.current();
    setOpen(next);
  }, []);

  // Fires once per accepted write, never on the first render (`saveCount` starts at 0).
  useEffect(() => {
    if (saveCount > 0) setOpen(false);
  }, [saveCount]);

  return { onOpenChange, open };
};
