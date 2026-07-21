import type { CheckResult, EvidenceGateId, EvidenceScope } from '../constants';

export interface AdaptedGateEvidence {
  artifactSha256: string;
  assertions?: {
    failed: number;
    passed: number;
    skipped: number;
    total: number;
  };
  candidateSha: string;
  details?: Record<string, number | string | boolean>;
  gate: EvidenceGateId;
  generatedAt: string;
  /** Harness classification only — never self-declared production. */
  harnessScope: Exclude<EvidenceScope, 'production-authorized'>;
  rawArtifactPaths: string[];
  status: CheckResult;
}
