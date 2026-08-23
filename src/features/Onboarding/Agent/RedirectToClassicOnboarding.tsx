'use client';

import { memo, useEffect } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';

const CLASSIC_ONBOARDING_PATH = '/onboarding/classic';

const RedirectToClassicOnboarding = memo(() => {
  const navigate = useWorkspaceAwareNavigate();

  useEffect(() => {
    navigate(CLASSIC_ONBOARDING_PATH, { replace: true });
  }, [navigate]);

  return <Loading debugId="AgentOnboardingRedirectClassic" />;
});
RedirectToClassicOnboarding.displayName = 'RedirectToClassicOnboarding';

export default RedirectToClassicOnboarding;
