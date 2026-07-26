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

/**
 * Keep a leased operation alive while its main task holds a separate transaction.
 * The heartbeat runs through the outer database/pool connection, never the snapshot
 * transaction. A failed heartbeat is surfaced after the task unwinds.
 */
export const runWithPeriodicLeaseMaintenance = async <T>(
  task: () => Promise<T>,
  heartbeat: () => Promise<void>,
  intervalMs: number,
): Promise<T> => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatError: unknown;
  let heartbeatInFlight: Promise<void> | undefined;

  const schedule = () => {
    if (stopped || heartbeatError) return;
    timer = setTimeout(
      () => {
        heartbeatInFlight = heartbeat()
          .catch((error) => {
            heartbeatError = error;
          })
          .finally(() => {
            heartbeatInFlight = undefined;
            schedule();
          });
      },
      Math.max(1, intervalMs),
    );
    timer.unref();
  };

  schedule();
  try {
    const result = await task();
    if (heartbeatInFlight) await heartbeatInFlight;
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (heartbeatInFlight) await heartbeatInFlight;
  }
};
