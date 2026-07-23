export type AdminMutationRisk = 'critical' | 'high' | 'low' | 'medium';

export type ImplementedControl =
  | { evidence: string; status: 'enforced' }
  | { evidence: string; limitation: string; status: 'conditional' };

export type MissingControl = { gap: string; status: 'gap' } | { gap: string; status: 'planned' };

export interface NotApplicableControl {
  rationale: string;
  status: 'not-applicable';
}

export type AdminMutationControl = ImplementedControl | MissingControl | NotApplicableControl;
export type RequiredAdminMutationControl = ImplementedControl | MissingControl;

export interface AdminMutationControls {
  audit: AdminMutationControl;
  lastKnownGood: AdminMutationControl;
  outbound: AdminMutationControl;
  rateLimit: AdminMutationControl;
  reason: AdminMutationControl;
  reauth: AdminMutationControl;
}

interface AdminMutationDefinitionBase {
  controls: AdminMutationControls;
  procedure: `admin.${string}`;
  summary: string;
}

export interface DangerousAdminMutationDefinition extends AdminMutationDefinitionBase {
  controls: AdminMutationControls & {
    audit: RequiredAdminMutationControl;
    rateLimit: RequiredAdminMutationControl;
    reason: RequiredAdminMutationControl;
    reauth: RequiredAdminMutationControl;
  };
  dangerous: true;
  risk: 'critical' | 'high';
}

export interface RegularAdminMutationDefinition extends AdminMutationDefinitionBase {
  dangerous: false;
  risk: 'low' | 'medium';
}

export type AdminMutationDefinition =
  DangerousAdminMutationDefinition | RegularAdminMutationDefinition;
