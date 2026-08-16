import type { FilterValue } from 'antd/es/table/interface';

export const firstFilterValue = (value: FilterValue | null | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null || raw === '') return undefined;
  return String(raw);
};

export const parseIsoDay = (value: unknown): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
};

export const startOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
};

export const endOfDay = (value: Date) => {
  const next = new Date(value);
  next.setHours(23, 59, 59, 999);
  return next;
};

export const sameCalendarDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();
