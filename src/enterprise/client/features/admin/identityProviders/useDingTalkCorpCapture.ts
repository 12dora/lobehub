'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef } from 'react';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import type { EditableDraft } from './steps';

export const useDingTalkCorpCapture = ({
  attempt,
  captureAttemptId,
  setDraft,
  t,
  testResultData,
}: {
  attempt: { id: string } | null;
  captureAttemptId: string | null;
  setDraft: Dispatch<SetStateAction<EditableDraft>>;
  t: TFunction<'admin'>;
  testResultData: Awaited<ReturnType<typeof adminIdentityProvidersService.testResult>> | undefined;
}): void => {
  const capturedAttemptRef = useRef<string | null>(null);

  // Organisation capture: fold the corpId the DingTalk login reported into the draft
  // allowlist (dedupe by corpId, keep the first label). Runs once per attempt.
  useEffect(() => {
    const captured = testResultData?.result?.dingtalk;
    if (
      !captured ||
      !attempt ||
      attempt.id !== captureAttemptId ||
      capturedAttemptRef.current === attempt.id ||
      testResultData?.status !== 'succeeded'
    ) {
      return;
    }
    capturedAttemptRef.current = attempt.id;
    setDraft((current) => {
      if (current.dingtalkAllowedCorps.some((entry) => entry.corpId === captured.corpId)) {
        toast.success(t('identityProviders.dingtalk.allowedCorps.alreadyAdded'));
        return current;
      }
      toast.success(t('identityProviders.dingtalk.allowedCorps.added'));
      if (!captured.corpName) {
        toast.info(
          captured.corpNameMissingScope
            ? t('identityProviders.dingtalk.allowedCorps.nameNeedsScope', {
                scope: captured.corpNameMissingScope,
              })
            : t('identityProviders.dingtalk.allowedCorps.nameUnavailable'),
        );
      }
      return {
        ...current,
        dingtalkAllowedCorps: [
          ...current.dingtalkAllowedCorps,
          {
            addedAt: new Date().toISOString(),
            corpId: captured.corpId,
            ...(captured.corpName ? { corpName: captured.corpName } : {}),
          },
        ],
      };
    });
  }, [attempt, captureAttemptId, testResultData, t]);
};
