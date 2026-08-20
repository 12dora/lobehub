'use client';

import type {
  AgentTemplate,
  MarketplaceCategory,
} from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import { getTemplatesByCategoryPriority } from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import { Button, Flexbox, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { Undo2Icon } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { useManagedResource } from '@/features/ManagedResources';
import { useOnboardingAgentTemplates } from '@/hooks/useOnboardingAgentTemplates';
import { installMarketplaceAgents } from '@/services/installMarketplaceAgents';
import {
  trackOnboardingCompleted,
  trackOnboardingMarketplacePicked,
  trackOnboardingMarketplaceShown,
  trackOnboardingStepCompleted,
} from '@/services/onboardingMetrics';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';
import { consumeOnboardingCallbackUrl } from '@/utils/onboardingRedirect';

import LobeMessage from '../../components/LobeMessage';
import { interestsToCategoryHints } from '../../interestCategoryMap';
import AgentCard from './AgentCard';
import CategoryFilter, { type ActiveCategory } from './CategoryFilter';
import AgentPickerSkeleton from './Skeleton';
import { styles } from './style';

interface AgentPickerStepProps {
  onBack: () => void;
}

const EMPTY_TEMPLATES: AgentTemplate[] = [];

const AgentPickerStep = memo<AgentPickerStepProps>(({ onBack }) => {
  const { t } = useTranslation('onboarding');
  const { t: tTool } = useTranslation('tool');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isAgentSkipEntry = searchParams.get('entry') === 'skip';
  const showBack = !isAgentSkipEntry;
  const completionFlow = isAgentSkipEntry ? 'agent' : 'classic';

  const finishOnboarding = useUserStore((s) => s.finishOnboarding);
  const interests = useUserStore(userProfileSelectors.interests);

  // Org-hosted agent catalog: every marketplace install is `agent.createAgent`, which the server
  // denies under takeover — the picker's Continue would 403 on each pick, so skip the whole step.
  //
  // Two different gates, on purpose:
  //  - `skipMarketplace` ends onboarding, an irreversible side effect (`finishOnboarding()`), so it
  //    requires *positive knowledge* that the org hosts agents: settled, no error, `managed`.
  //    `blocked` is unusable here because it is also true while loading and on a transient
  //    capabilities failure — an unmanaged user hitting one flaky request would silently have
  //    onboarding completed out from under them.
  //  - `agentCreationBlocked` still gates the mutation itself (below), fail-closed as everywhere
  //    else: unknown state never attempts an install we may not be allowed to make.
  const {
    blocked: agentCreationBlocked,
    error: managedResourceError,
    loading: managedResourceLoading,
    managed: agentsManaged,
  } = useManagedResource('agents');
  const skipMarketplace = !managedResourceLoading && managedResourceError === null && agentsManaged;

  const categoryHints = useMemo(() => interestsToCategoryHints(interests), [interests]);
  const [requestId] = useState(() => Math.random().toString(36).slice(2));

  const { data: allTemplates = EMPTY_TEMPLATES, error, isLoading } = useOnboardingAgentTemplates();

  const orderedTemplates = useMemo(
    () => getTemplatesByCategoryPriority(allTemplates, categoryHints),
    [allTemplates, categoryHints],
  );

  const availableCategories = useMemo(() => {
    const seen = new Set<MarketplaceCategory>();
    const result: MarketplaceCategory[] = [];
    for (const tpl of orderedTemplates) {
      if (seen.has(tpl.category)) continue;
      seen.add(tpl.category);
      result.push(tpl.category);
    }
    return result;
  }, [orderedTemplates]);

  const [active, setActive] = useState<ActiveCategory>('all');
  const visibleTemplates = useMemo(
    () =>
      active === 'all'
        ? orderedTemplates
        : orderedTemplates.filter((tpl) => tpl.category === active),
    [active, orderedTemplates],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [pending, setPending] = useState<'continue' | 'skip'>();
  const pendingRef = useRef(false);

  const shownRef = useRef(false);
  useEffect(() => {
    if (managedResourceLoading || skipMarketplace) return;
    if (shownRef.current) return;
    shownRef.current = true;
    trackOnboardingMarketplaceShown({ categoryHints, requestId });
  }, [categoryHints, managedResourceLoading, requestId, skipMarketplace]);

  const finish = useCallback(
    async (action: 'continue' | 'skip', selectedCount: number) => {
      await finishOnboarding();
      trackOnboardingStepCompleted({
        action,
        entry: isAgentSkipEntry ? 'agent_skip' : 'classic',
        flow: completionFlow,
        selectedCount,
        step: 'agentpicker',
        stepIndex: 4,
      });
      // Restore the original signup target (threaded through onboarding), if any
      const targetUrl = consumeOnboardingCallbackUrl() || '/';
      trackOnboardingCompleted({ flow: completionFlow, targetUrl });
      navigate(targetUrl);
    },
    [completionFlow, finishOnboarding, isAgentSkipEntry, navigate],
  );

  const handleSkip = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('skip');
    await finish('skip', 0);
  }, [finish]);

  const handleContinue = useCallback(async () => {
    if (pendingRef.current || selected.size === 0) return;
    pendingRef.current = true;
    setPending('continue');

    const selectedTemplateIds = [...selected];
    trackOnboardingMarketplacePicked({ categoryHints, requestId, selectedTemplateIds });
    // Fail closed on the write while still letting the user out of onboarding: when the capability
    // state is unknown (loading / errored) we skip the install rather than fire a request the
    // server may refuse, but the step still completes so nobody gets stranded on a dead button.
    if (!agentCreationBlocked) {
      try {
        await installMarketplaceAgents(selectedTemplateIds);
      } catch (installError) {
        console.error('[AgentPickerStep] install failed', installError);
      }
    }
    await finish('continue', selectedTemplateIds.length);
  }, [agentCreationBlocked, categoryHints, finish, requestId, selected]);

  // Auto-complete onboarding for managed orgs instead of parking the user on a picker that can
  // only fail. Recorded as a `skip` so the funnel keeps a single completion shape.
  const autoSkippedRef = useRef(false);
  useEffect(() => {
    if (!skipMarketplace || autoSkippedRef.current) return;
    autoSkippedRef.current = true;
    void handleSkip();
  }, [handleSkip, skipMarketplace]);

  const handleBack = useCallback(() => {
    if (pendingRef.current) return;
    onBack();
  }, [onBack]);

  const showLoading = isLoading && allTemplates.length === 0;
  const showEmpty = !isLoading && visibleTemplates.length === 0;

  // Don't flash the marketplace grid while we still don't know whether it is reachable, and don't
  // render it at all once we know it isn't — the auto-skip effect above is already navigating away.
  // A settled *error* deliberately falls through to the normal picker: the user keeps the step and
  // just doesn't get an install attempt.
  if (managedResourceLoading || skipMarketplace) {
    return (
      <Flexbox gap={16}>
        <AgentPickerSkeleton />
      </Flexbox>
    );
  }

  return (
    <Flexbox gap={16}>
      <LobeMessage
        sentences={[t('agentPicker.title'), t('agentPicker.title2'), t('agentPicker.title3')]}
      />
      <Text fontSize={14} type={'secondary'}>
        {t('agentPicker.subtitle')}
      </Text>

      {showLoading ? (
        <AgentPickerSkeleton />
      ) : showEmpty ? (
        <div className={styles.empty}>
          {error
            ? tTool('agentMarketplace.picker.failedToLoad')
            : tTool('agentMarketplace.picker.empty')}
        </div>
      ) : (
        <>
          <CategoryFilter
            active={active}
            allLabel={t('agentPicker.allCategories')}
            categories={availableCategories}
            onChange={setActive}
          />
          <div className={styles.scrollArea}>
            <div className={styles.grid}>
              {visibleTemplates.map((tpl) => (
                <AgentCard
                  key={tpl.id}
                  selected={selected.has(tpl.id)}
                  template={tpl}
                  onToggle={toggle}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <div className={styles.footer}>
        {showBack ? (
          <Button
            disabled={!!pending}
            icon={Undo2Icon}
            style={{ color: cssVar.colorTextDescription }}
            type={'text'}
            onClick={handleBack}
          >
            {t('back')}
          </Button>
        ) : (
          <span />
        )}
        <div className={styles.footerActions}>
          <Button disabled={!!pending} type={'text'} onClick={() => void handleSkip()}>
            {t('agentPicker.skip')}
          </Button>
          <Button
            disabled={selected.size === 0 || pending === 'skip'}
            loading={pending === 'continue'}
            type={'primary'}
            onClick={() => void handleContinue()}
          >
            {`${t('agentPicker.continue')} (${selected.size})`}
          </Button>
        </div>
      </div>
    </Flexbox>
  );
});

AgentPickerStep.displayName = 'AgentPickerStep';

export default AgentPickerStep;
