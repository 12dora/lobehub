/**
 * Shared helpers for export worker modules (SAO-009).
 */

export type ExportTimeWindow = { from: Date; to: Date };

export const jsonlLine = (row: Record<string, unknown>): string => `${JSON.stringify(row)}\n`;

export const toIso = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
