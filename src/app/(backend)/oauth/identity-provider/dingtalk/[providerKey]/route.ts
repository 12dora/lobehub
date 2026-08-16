import type { NextRequest } from 'next/server';

import { handleDingTalkLoginCallback } from '@/enterprise/server/dingtalkLoginCallback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = (request: NextRequest, context: { params: Promise<{ providerKey: string }> }) =>
  handleDingTalkLoginCallback(request, context);
