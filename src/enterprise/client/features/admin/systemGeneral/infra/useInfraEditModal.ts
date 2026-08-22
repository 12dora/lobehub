'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface UseInfraEditModalParams {
  /** Seeds the draft from the current snapshot; the same step the inline editor used to run. */
  beginEdit: () => void;
  /** Throws the draft away. Closing the modal is the only way an edit is abandoned. */
  cancelEdit: () => void;
  /** Unsaved work in the draft — every way out of the modal has to ask before discarding it. */
  dirty?: boolean;
  /** Successful writes reported by the editor hook; each one closes the modal. */
  saveCount: number;
}

export interface InfraEditModal {
  /**
   * The modal's open state. Every `false` transition is guarded: the mask, Esc and the footer
   * 取消 all go through the same confirmation when the draft is dirty.
   */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Footer 取消. An alias for `onOpenChange(false)` so no call site can skip the guard. */
  requestClose: () => void;
}

/**
 * Open/close state for the 编辑 modal, tied to the editor hook that owns the draft.
 *
 * Opening seeds the draft and closing discards it, so a modal that was dismissed can never leave a
 * half-typed configuration behind the card's summary. An abandoned draft is a real loss, so the
 * confirmation lives HERE rather than in the card chrome: the footer 取消 button used to call the
 * setter directly and wipe the draft without asking, which is exactly the kind of second door a
 * component-level guard cannot see. A write the server accepted closes the modal on its own — the
 * operator does not have to dismiss a form whose work is done.
 */
export const useInfraEditModal = ({
  beginEdit,
  cancelEdit,
  dirty = false,
  saveCount,
}: UseInfraEditModalParams): InfraEditModal => {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);

  /**
   * The editor hooks rebuild `beginEdit` / `cancelEdit` on every render and close over the current
   * baseline draft. They are read through refs so the callback identity stays stable without
   * capturing the first render's baseline — which would restore the wrong draft on cancel.
   */
  const beginRef = useRef(beginEdit);
  const cancelRef = useRef(cancelEdit);
  const dirtyRef = useRef(dirty);
  const tRef = useRef(t);
  beginRef.current = beginEdit;
  cancelRef.current = cancelEdit;
  dirtyRef.current = dirty;
  tRef.current = t;

  const onOpenChange = useCallback((next: boolean) => {
    if (next) {
      beginRef.current();
      setOpen(true);
      return;
    }

    const discard = () => {
      cancelRef.current();
      setOpen(false);
    };

    if (!dirtyRef.current) {
      discard();
      return;
    }

    confirmModal({
      cancelText: tRef.current('systemGeneral.unsaved.stay'),
      content: tRef.current('systemGeneral.unsaved.description'),
      okText: tRef.current('systemGeneral.unsaved.leave'),
      onOk: discard,
      title: tRef.current('systemGeneral.unsaved.title'),
    });
  }, []);

  const requestClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  // Fires once per accepted write, never on the first render (`saveCount` starts at 0).
  useEffect(() => {
    if (saveCount > 0) setOpen(false);
  }, [saveCount]);

  return { onOpenChange, open, requestClose };
};
