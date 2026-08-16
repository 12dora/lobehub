'use client';

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { GripVertical } from 'lucide-react';
import { createContext, type HTMLAttributes, type ReactNode, use, useMemo } from 'react';

const styles = createStaticStyles(({ css }) => ({
  handle: css`
    cursor: grab;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    padding: 4px;
    border: none;
    border-radius: 4px;

    color: ${cssVar.colorTextTertiary};

    background: transparent;

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 1px;
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }
  `,
  row: css`
    /* The dragged row must paint above its neighbours while it moves. */
    &[data-dragging='true'] {
      position: relative;
      z-index: 1;
      background: ${cssVar.colorFillQuaternary};
    }
  `,
}));

/** Borrow dnd-kit's own types rather than restating them (or importing from its dist paths). */
type SortableApi = ReturnType<typeof useSortable>;

interface SortableRowContextValue {
  attributes: SortableApi['attributes'];
  disabled: boolean;
  listeners: SortableApi['listeners'];
  setActivatorNodeRef: SortableApi['setActivatorNodeRef'];
}

const SortableRowContext = createContext<SortableRowContextValue | null>(null);

/**
 * Drag handle for the current row. Rendered from a table column so the handle sits in its own
 * cell, while the drag sensors live on the row itself.
 *
 * Keyboard: the handle is a real focusable button wired to dnd-kit's keyboard sensor, so
 * Space picks the row up, arrow keys move it and Space drops it (Escape cancels).
 */
export const TaskTemplateDragHandle = ({ label }: { label: string }) => {
  const context = use(SortableRowContext);
  if (!context) return null;

  return (
    <button
      aria-label={label}
      className={styles.handle}
      disabled={context.disabled}
      ref={context.setActivatorNodeRef}
      type="button"
      {...context.attributes}
      {...context.listeners}
    >
      <Icon icon={GripVertical} size={16} />
    </button>
  );
};

type SortableRowProps = HTMLAttributes<HTMLTableRowElement> & {
  'data-row-key'?: string;
};

/** Ant Design `components.body.row` replacement that makes one table row draggable. */
export const createSortableRow = (disabled: boolean) => {
  const SortableRow = ({ 'data-row-key': rowKey, style, ...props }: SortableRowProps) => {
    const {
      attributes,
      isDragging,
      listeners,
      setActivatorNodeRef,
      setNodeRef,
      transform,
      transition,
    } = useSortable({ disabled, id: rowKey ?? '' });

    // `disabled` is closed over from createSortableRow, which builds a fresh component
    // identity whenever it changes — it is not a reactive dependency here.
    const context = useMemo<SortableRowContextValue>(
      () => ({ attributes, disabled, listeners, setActivatorNodeRef }),

      [attributes, listeners, setActivatorNodeRef],
    );

    return (
      <SortableRowContext value={context}>
        <tr
          {...props}
          className={[props.className, styles.row].filter(Boolean).join(' ')}
          data-dragging={isDragging}
          ref={setNodeRef}
          style={{
            ...style,
            // Vertical-only: zero the horizontal translation and the scale dnd-kit would apply,
            // so a row slides within the table instead of drifting sideways.
            transform: CSS.Transform.toString(
              transform && { ...transform, scaleX: 1, scaleY: 1, x: 0 },
            ),
            transition,
          }}
        />
      </SortableRowContext>
    );
  };
  SortableRow.displayName = 'AdminTaskTemplateSortableRow';
  return SortableRow;
};

export interface SortableTableProps {
  children: ReactNode;
  /** Row ids in their current display order. */
  ids: string[];
  onReorder: (orderedIds: string[]) => void;
}

/** Vertical, list-constrained drag context around the admin table. */
export const SortableTable = ({ children, ids, onReorder }: SortableTableProps) => {
  const sensors = useSensors(
    // A small activation distance keeps a plain click on the handle from starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onReorder(next);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
};
