import type {
  AdminMutationControl,
  AdminMutationControls,
  DangerousAdminMutationDefinition,
  ImplementedControl,
  NotApplicableControl,
  RegularAdminMutationDefinition,
  RequiredAdminMutationControl,
} from './types';

export const enforced = (evidence: string): ImplementedControl => ({
  evidence,
  status: 'enforced',
});
export const conditional = (evidence: string, limitation: string): ImplementedControl => ({
  evidence,
  limitation,
  status: 'conditional',
});
export const notApplicable = (rationale: string): NotApplicableControl => ({
  rationale,
  status: 'not-applicable',
});

export const reasonInput = enforced('Bounded non-empty reason in the procedure input contract.');
/**
 * The admin console no longer prompts for an audit reason on non-destructive operations
 * (save / publish / toggle / test / rollout / assignment edits). The contract still bounds and
 * secret-scans a supplied reason; omitted reasons persist as a null audit column.
 */
export const optionalReasonInput = conditional(
  'Bounded optional reason in the procedure input contract, persisted when the caller supplies one.',
  'The admin console does not prompt for a reason on this non-destructive operation, so audit rows may carry none.',
);
export const serviceAudit = enforced('Service persists a sanitized platform audit outcome.');
export const recentReauth = enforced(
  'Router checks the server-authenticated recent-session timestamp.',
);
export const conditionalReauth = conditional(
  'Router checks recent authentication for sensitive input variants.',
  'Ordinary draft variants do not require the check.',
);
export const sharedAdminRateLimit = enforced(
  'Shared multi-instance admin mutation rate limiter is attached to the final tRPC mutation chain.',
);
export const noRemoteRequest = notApplicable(
  'The operation does not make a server-side remote request.',
);
export const databaseStateNoLkg = notApplicable(
  'The procedure reads or changes authoritative database state and has no derived LKG path.',
);
export const validationNoLkg = notApplicable(
  'Validation creates no runtime state that requires recovery.',
);
export const remoteProbeNoLkg = notApplicable(
  'The bounded remote probe creates no published runtime state that requires recovery.',
);
export const assetNoLkg = notApplicable(
  'Asset recovery uses object-storage operation records rather than an LKG file.',
);
export const optionalReason = conditional(
  'Bounded reason accepted in the procedure input contract and persisted when supplied.',
  'Routine draft work does not prompt for one; the audit records an em dash and the change itself is reconstructable from the before/after diff and the revision history.',
);
export const noReason = notApplicable(
  'The validation operation does not persist business configuration.',
);
export const validationAudit = enforced(
  'Service or router persists a sanitized success or failure platform audit outcome.',
);
export const prepareRestartAudit = enforced(
  'Prepared restart intent and sanitized success audit share one transaction; failure and reauth denial audits are best effort after rollback.',
);
export const safeOutbound = enforced(
  'Remote requests use the enterprise outbound policy boundary.',
);
export const identityLkg = conditional(
  'Startup verifies signature, age, ownership, and permissions before reading a local LKG.',
  'A valid database candidate remains active when the local LKG write fails; startup reports degraded.',
);
export const secretRotationExternalGate = conditional(
  'API and worker results always report historicalKeyRemovalReady=false and require identity LKG instance convergence.',
  'OIDC LKG convergence and historical KEK removal approval remain external operational gates.',
);
export const secretRotationAudit = enforced(
  'Coordinator mutation and sanitized success audit share one transaction; failure and reauth denial audits are best effort after rollback.',
);
export const vaultKeyProviderBoundary = enforced(
  'Start verifies the selected Vault provider and exact active key through its bounded fail-closed client.',
);

export const regularMutation = (
  procedure: `admin.${string}`,
  risk: RegularAdminMutationDefinition['risk'],
  summary: string,
  overrides: Partial<AdminMutationControls> = {},
): RegularAdminMutationDefinition => ({
  controls: {
    audit: serviceAudit,
    lastKnownGood: databaseStateNoLkg,
    outbound: noRemoteRequest,
    rateLimit: sharedAdminRateLimit,
    reason: reasonInput,
    reauth: notApplicable('The current policy does not classify this operation as dangerous.'),
    ...overrides,
  },
  dangerous: false,
  procedure,
  risk,
  summary,
});

export const dangerousMutation = (
  procedure: `admin.${string}`,
  risk: DangerousAdminMutationDefinition['risk'],
  summary: string,
  options: {
    audit?: RequiredAdminMutationControl;
    lastKnownGood?: AdminMutationControl;
    outbound?: AdminMutationControl;
    /**
     * Prefer `reasonInput` / `optionalReasonInput`. `noReason` is allowed when
     * the procedure DTO has no reason field (e.g. network-proxy create/update
     * subscription, installArtifact, and installGeodata).
     */
    reason?: AdminMutationControl;
    reauth: RequiredAdminMutationControl;
  },
): DangerousAdminMutationDefinition => ({
  controls: {
    audit: options.audit ?? serviceAudit,
    lastKnownGood: options.lastKnownGood ?? databaseStateNoLkg,
    outbound: options.outbound ?? noRemoteRequest,
    rateLimit: sharedAdminRateLimit,
    reason: options.reason ?? reasonInput,
    reauth: options.reauth,
  },
  dangerous: true,
  procedure,
  risk,
  summary,
});

export const validationMutation = (
  procedure: `admin.${string}`,
  summary: string,
  overrides: Partial<AdminMutationControls> = {},
) =>
  regularMutation(procedure, 'low', summary, {
    audit: validationAudit,
    lastKnownGood: validationNoLkg,
    reason: noReason,
    ...overrides,
  });
