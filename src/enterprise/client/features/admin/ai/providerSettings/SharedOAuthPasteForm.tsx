'use client';

import { parseChatGPTWebPaste } from '@lobechat/utils/chatgptWebPaste';
import { Flexbox } from '@lobehub/ui';
import { memo, useCallback, useId, useMemo, useState } from 'react';

import SharedOAuthCallbackRoute from './SharedOAuthCallbackRoute';
import { resolvePasteDetection, resolvePasteErrorPlacement } from './sharedOAuthPasteErrors';
import SharedOAuthSessionFields from './SharedOAuthSessionFields';
import SharedOAuthSessionOnlyPanel from './SharedOAuthSessionOnlyPanel';
import SharedOAuthSessionSteps from './SharedOAuthSessionSteps';
import SharedOAuthTokenDisclosure from './SharedOAuthTokenDisclosure';
import type { SharedOAuthPasteError, SharedOAuthPasteSource } from './useAdminSharedOAuthFlow';

interface SharedOAuthPasteFormProps {
  /** Provider accepts a pasted credential (web session or access token) as well. */
  allowAccessTokenPaste?: boolean;
  authorizeUri: string;
  /**
   * Open the pasted-credential section immediately. Set when the operator arrived here from
   * the "this connection cannot renew itself" warning: the fix they clicked IS that section,
   * so making them find it again would be the whole failure repeated.
   */
  defaultSessionOpen?: boolean;
  onCancel: () => void;
  onOpenAuthorizePage: () => void;
  onRegenerate: () => void;
  onSubmitAccessToken: (accessToken: string, extras?: { deviceId?: string }) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  onSubmitSessionToken: (
    sessionToken: string,
    extras?: { deviceId?: string; sessionChunks?: string[] },
  ) => void;
  submitError?: SharedOAuthPasteError;
  /** Which input the failed submit came from; decides where the error is shown. */
  submitErrorSource?: SharedOAuthPasteSource;
  submitting?: boolean;
  /**
   * The provider connects through the pasted web session ALONE (card flag
   * `oauthDeviceFlow.webSessionOnly`): the authorization page belongs to a different product
   * and the server refuses a callback exchange, so none of that UI may be offered here.
   */
  webSessionOnly?: boolean;
}

/**
 * Shared-account variant of the authorization-code paste flow: the operator signs in as the
 * ONE platform account in a browser, then brings the callback URL back here. No polling —
 * the provider's redirect URI never reaches this deployment.
 */
const SharedOAuthPasteForm = memo<SharedOAuthPasteFormProps>(
  ({
    allowAccessTokenPaste,
    authorizeUri,
    defaultSessionOpen,
    onCancel,
    onOpenAuthorizePage,
    onRegenerate,
    onSubmitAccessToken,
    onSubmitCallback,
    onSubmitSessionToken,
    submitError,
    submitErrorSource,
    submitting,
    webSessionOnly,
  }) => {
    const [pasted, setPasted] = useState('');
    const [showTokenSection, setShowTokenSection] = useState(Boolean(defaultSessionOpen));
    const fieldGroupId = useId();
    const callbackFieldId = `${fieldGroupId}-callback`;
    const callbackErrorId = `${fieldGroupId}-callback-error`;
    const tokenFieldId = `${fieldGroupId}-token`;
    const tokenErrorId = `${fieldGroupId}-token-error`;
    const tokenSectionId = `${fieldGroupId}-token-section`;
    const detectionId = `${fieldGroupId}-detection`;

    const parsed = useMemo(() => parseChatGPTWebPaste(pasted), [pasted]);
    const deviceMismatch = parsed.kind === 'device_mismatch';

    const { callbackError, tokenError, tokenErrorKey } = resolvePasteErrorPlacement({
      deviceMismatch,
      submitError,
      submitErrorSource,
      webSessionOnly,
    });
    const detection = resolvePasteDetection(pasted, parsed.kind);
    /** Neither half of the paste is redeemable, so the submit that would spend it stands down. */
    const pastedSubmitDisabled = parsed.kind === 'unknown' || parsed.kind === 'device_mismatch';

    /** Always submit the renewable half when the paste carried both. */
    const handleSubmitPasted = useCallback(() => {
      if (parsed.kind === 'device_mismatch') return;
      const deviceExtras = parsed.deviceId ? { deviceId: parsed.deviceId } : undefined;
      if (parsed.sessionToken) {
        const extras = {
          ...deviceExtras,
          ...(parsed.sessionChunks ? { sessionChunks: parsed.sessionChunks } : {}),
        };
        if (Object.keys(extras).length > 0) {
          onSubmitSessionToken(parsed.sessionToken, extras);
        } else {
          onSubmitSessionToken(parsed.sessionToken);
        }
      } else if (parsed.accessToken) {
        if (deviceExtras) onSubmitAccessToken(parsed.accessToken, deviceExtras);
        else onSubmitAccessToken(parsed.accessToken);
      }
    }, [
      onSubmitAccessToken,
      onSubmitSessionToken,
      parsed.accessToken,
      parsed.deviceId,
      parsed.kind,
      parsed.sessionChunks,
      parsed.sessionToken,
    ]);

    const handleToggleTokenSection = useCallback(() => setShowTokenSection((open) => !open), []);

    const sessionSteps = <SharedOAuthSessionSteps />;
    const sessionFields = (
      <SharedOAuthSessionFields
        detection={detection}
        detectionId={detectionId}
        tokenError={tokenError}
        tokenErrorId={tokenErrorId}
        tokenErrorKey={tokenErrorKey || undefined}
        tokenFieldId={tokenFieldId}
        value={pasted}
        onChange={setPasted}
      />
    );

    if (webSessionOnly)
      return (
        <SharedOAuthSessionOnlyPanel
          sessionFields={sessionFields}
          sessionSteps={sessionSteps}
          submitDisabled={pastedSubmitDisabled}
          submitting={submitting}
          onCancel={onCancel}
          onSubmit={handleSubmitPasted}
        />
      );

    return (
      <Flexbox gap={12}>
        <SharedOAuthCallbackRoute
          authorizeUri={authorizeUri}
          error={callbackError}
          errorId={callbackErrorId}
          fieldId={callbackFieldId}
          submitting={submitting}
          onCancel={onCancel}
          onOpenAuthorizePage={onOpenAuthorizePage}
          onRegenerate={onRegenerate}
          onSubmit={onSubmitCallback}
        />

        {allowAccessTokenPaste && (
          <SharedOAuthTokenDisclosure
            open={showTokenSection}
            sectionId={tokenSectionId}
            sessionFields={sessionFields}
            sessionSteps={sessionSteps}
            submitDisabled={pastedSubmitDisabled}
            submitting={submitting}
            onSubmit={handleSubmitPasted}
            onToggle={handleToggleTokenSection}
          />
        )}
      </Flexbox>
    );
  },
);

SharedOAuthPasteForm.displayName = 'AdminSharedOAuthPasteForm';

export default SharedOAuthPasteForm;
