import { Apple, Aws, Google, Microsoft } from '@lobehub/icons';
import {
  Auth0,
  Authelia,
  Authentik,
  Casdoor,
  Cloudflare,
  DingTalk,
  Github,
  Logto,
  MicrosoftEntra,
  Zitadel,
} from '@lobehub/ui/icons';
import { User } from 'lucide-react';
import type { ComponentType } from 'react';

type AuthIconComponent = ComponentType<{ size?: number }>;

/**
 * Provider id → icon. A `Map` (not a plain object) because ids come from admin-managed
 * database rows: an object lookup would resolve inherited keys such as `__proto__` or
 * `constructor` and hand React a non-component, crashing the sign-in page.
 */
const iconComponents = new Map<string, AuthIconComponent>([
  ['apple', Apple],
  ['auth0', Auth0],
  ['authelia', Authelia.Color],
  ['authentik', Authentik.Color],
  ['casdoor', Casdoor.Color],
  ['cloudflare', Cloudflare.Color],
  ['cognito', Aws.Color],
  ['dingtalk', DingTalk.Color],
  ['github', Github],
  ['google', Google.Color],
  ['logto', Logto.Color],
  ['microsoft', Microsoft.Color],
  ['microsoft-entra-id', MicrosoftEntra.Color],
  ['zitadel', Zitadel.Color],
] as [string, AuthIconComponent][]);

/**
 * Get the auth icons component for the given provider id
 */
const AuthIcons = (id: string, size = 36) => {
  const IconComponent = iconComponents.get(id);
  if (IconComponent) {
    return <IconComponent size={size} />;
  }
  // Fallback to generic user icon for unknown providers
  return <User size={size} />;
};

export default AuthIcons;
