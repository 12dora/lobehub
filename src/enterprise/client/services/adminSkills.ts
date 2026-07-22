import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminSkillApplyImmediateInput,
  AdminSkillApplyImmediateOutput,
  AdminSkillArchiveInput,
  AdminSkillCreateInput,
  AdminSkillCreateVersionInput,
  AdminSkillCreateVersionOutput,
  AdminSkillGetDependentsInput,
  AdminSkillGetDependentsOutput,
  AdminSkillGetInput,
  AdminSkillGetOutput,
  AdminSkillGetVersionInput,
  AdminSkillGetVersionOutput,
  AdminSkillListInput,
  AdminSkillListOutput,
  AdminSkillListVersionsInput,
  AdminSkillListVersionsOutput,
  AdminSkillMutationOutput,
  AdminSkillParseImportSourceInput,
  AdminSkillParseImportSourceOutput,
  AdminSkillPublicationOutput,
  AdminSkillPublishInput,
  AdminSkillPublishNowInput,
  AdminSkillRollbackInput,
  AdminSkillUpdateDraftInput,
  AdminSkillValidateInput,
  AdminSkillValidateOutput,
} from '../features/admin/skills/types';
import { withAdminAiInfraErrorToast } from './adminAiInfraAdapter/errors';

/** Last applyImmediate/publishNow outcome for draft banner (module-level; admin page only). */
export type AdminSkillPublishOutcome = {
  published: boolean;
  publishError?: string | null;
  skillId: string;
};

let lastSkillPublishOutcome: AdminSkillPublishOutcome | null = null;

export const getLastAdminSkillPublishOutcome = () => lastSkillPublishOutcome;
export const clearLastAdminSkillPublishOutcome = () => {
  lastSkillPublishOutcome = null;
};
export const setLastAdminSkillPublishOutcome = (outcome: AdminSkillPublishOutcome | null) => {
  lastSkillPublishOutcome = outcome;
};

const withToastAndReauth = <T>(fn: () => Promise<T>): Promise<T> =>
  withAdminAiInfraErrorToast(() => withAdminReauthRetry(fn));

class AdminSkillsService {
  archive = async (input: AdminSkillArchiveInput): Promise<AdminSkillPublicationOutput> =>
    lambdaClient.admin.skills.archive.mutate(input);

  /** Settings-page archive with reauth + toast (advanced catalog keeps bare archive). */
  archiveImmediate = async (input: AdminSkillArchiveInput): Promise<AdminSkillPublicationOutput> =>
    withToastAndReauth(() => lambdaClient.admin.skills.archive.mutate(input));

  create = async (input: AdminSkillCreateInput): Promise<AdminSkillMutationOutput> =>
    lambdaClient.admin.skills.create.mutate(input);

  createVersion = async (
    input: AdminSkillCreateVersionInput,
  ): Promise<AdminSkillCreateVersionOutput> =>
    lambdaClient.admin.skills.createVersion.mutate(input);

  get = async (input: AdminSkillGetInput): Promise<AdminSkillGetOutput> =>
    lambdaClient.admin.skills.get.query(input);

  getDependents = async (
    input: AdminSkillGetDependentsInput,
  ): Promise<AdminSkillGetDependentsOutput> => lambdaClient.admin.skills.getDependents.query(input);

  getVersion = async (input: AdminSkillGetVersionInput): Promise<AdminSkillGetVersionOutput> =>
    lambdaClient.admin.skills.getVersion.query(input);

  list = async (input: AdminSkillListInput): Promise<AdminSkillListOutput> =>
    lambdaClient.admin.skills.list.query(input);

  listVersions = async (
    input: AdminSkillListVersionsInput,
  ): Promise<AdminSkillListVersionsOutput> => lambdaClient.admin.skills.listVersions.query(input);

  /**
   * Parse a skill package from URL / GitHub / uploaded ZIP without persisting anything.
   * Feed the result into applyImmediate (mode: 'create') to publish org-wide.
   */
  parseImportSource = async (
    input: AdminSkillParseImportSourceInput,
  ): Promise<AdminSkillParseImportSourceOutput> =>
    withToastAndReauth(() => lambdaClient.admin.skills.parseImportSource.mutate(input));

  publish = async (input: AdminSkillPublishInput): Promise<AdminSkillPublicationOutput> =>
    lambdaClient.admin.skills.publish.mutate(input);

  rollback = async (input: AdminSkillRollbackInput): Promise<AdminSkillPublicationOutput> =>
    lambdaClient.admin.skills.rollback.mutate(input);

  updateDraft = async (input: AdminSkillUpdateDraftInput): Promise<AdminSkillMutationOutput> =>
    lambdaClient.admin.skills.updateDraft.mutate(input);

  validate = async (input: AdminSkillValidateInput): Promise<AdminSkillValidateOutput> =>
    lambdaClient.admin.skills.validate.mutate(input);

  /**
   * Draft mutation + immediate publish (admin settings UI parity).
   * Soft-fail leaves draft + banner; hard failures toast via wrapper.
   */
  applyImmediate = async (
    input: AdminSkillApplyImmediateInput,
  ): Promise<AdminSkillApplyImmediateOutput> =>
    withToastAndReauth(async () => {
      const result = await lambdaClient.admin.skills.applyImmediate.mutate(input);
      setLastAdminSkillPublishOutcome({
        published: result.published,
        publishError: result.publishError,
        skillId: result.draft.id,
      });
      return result;
    });

  publishNow = async (input: AdminSkillPublishNowInput): Promise<AdminSkillApplyImmediateOutput> =>
    withToastAndReauth(async () => {
      const result = await lambdaClient.admin.skills.publishNow.mutate(input);
      setLastAdminSkillPublishOutcome({
        published: result.published,
        publishError: result.publishError,
        skillId: result.draft.id,
      });
      return result;
    });
}

export const adminSkillsService = new AdminSkillsService();
