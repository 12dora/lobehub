import type { NextRequest } from 'next/server';

import { serverDB } from '@/database/server';
import { handleIdentityProviderTestCallback } from '@/enterprise/server/identityProviderTestCallback';

export const GET = (request: NextRequest) => handleIdentityProviderTestCallback(request, serverDB);
