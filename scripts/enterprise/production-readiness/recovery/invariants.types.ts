export interface AggregateDigestResult {
  digest: string;
  match: boolean;
  rowCount: number;
}

export interface BooleanInvariant {
  detail?: string;
  match: boolean;
}

export interface TableDigestEntry {
  digest: string;
  name: string;
  rowCount: number;
}
