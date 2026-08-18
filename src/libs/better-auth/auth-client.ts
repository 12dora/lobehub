import { passkeyClient } from '@better-auth/passkey/client';
import {
  adminClient,
  genericOAuthClient,
  inferAdditionalFields,
  magicLinkClient,
  twoFactorClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { type auth } from '@/auth';

export const {
  changeEmail,
  changePassword,
  linkSocial,
  oauth2,
  accountInfo,
  listAccounts,
  passkey,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  signIn,
  signOut,
  signUp,
  twoFactor,
  unlinkAccount,
  useListPasskeys,
  useSession,
} = createAuthClient({
  plugins: [
    adminClient(),
    inferAdditionalFields<typeof auth>(),
    genericOAuthClient(),
    // Always include magicLinkClient - server will reject if not enabled
    magicLinkClient(),
    // `onTwoFactorRedirect` is deliberately NOT set here: the sign-in form drives its own
    // step machine, and the plugin's built-in alternative is a full page reload. The form
    // reads `twoFactorRedirect` off the sign-in response instead.
    twoFactorClient(),
    passkeyClient(),
  ],
});
