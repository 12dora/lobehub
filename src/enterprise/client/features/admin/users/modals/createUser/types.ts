import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminUsersCreateInput,
  AdminUsersCreateOutput,
} from '@/enterprise/client/services/adminUsers';

/** idle | waiting on reauth popup | server mutation in flight | one-time credentials panel */
export type CreateUserModalPhase = 'idle' | 'reauthing' | 'mutating' | 'success';

/**
 * Shared between content and openCreateUserModal's onOpenChange: base-ui's
 * `maskClosable: false` only suppresses `outside-press` dismissals — Escape still
 * closes — so onOpenChange needs the live phase to veto framework-initiated closes
 * while a create is in flight or the one-time credentials panel is showing.
 */
export interface CreateUserModalDismissGuard {
  /** True once Cancel / Done ran `close()` — vetoes must not resurrect the modal. */
  closedExplicitly: boolean;
  dirty: boolean;
  discardPromptOpen: boolean;
  phase: CreateUserModalPhase;
}

export interface CreateUserModalContentProps {
  /**
   * Shared abort controller for this modal instance.
   * openCreateUserModal wires onOpenChange(false) to abort immediately (Escape/close).
   */
  abortControllerRef?: React.MutableRefObject<AbortController | null>;
  authMethod?: AdminReauthAuthMethod;
  /** Shared dismissal guard — see {@link CreateUserModalDismissGuard}. */
  dismissGuardRef?: React.MutableRefObject<CreateUserModalDismissGuard>;
  /** Called when phase changes (tests / parent). */
  onPhaseChange?: (phase: CreateUserModalPhase) => void;
  onSubmit: (input: AdminUsersCreateInput) => Promise<AdminUsersCreateOutput>;
}
