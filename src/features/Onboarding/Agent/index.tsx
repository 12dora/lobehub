'use client';

import { ErrorBoundary, Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import OnboardingContainer from '@/routes/onboarding/_layout';

import AnalyticsBridge from './AnalyticsBridge';
import AgentOnboardingConversation from './Conversation';
import DevActions from './DevActions';
import HistoryDrawer from './HistoryDrawer';
import OnboardingConversationProvider from './OnboardingConversationProvider';
import RedirectToClassicOnboarding from './RedirectToClassicOnboarding';
import { useAgentOnboardingConversation } from './useAgentOnboardingConversation';
import { useAgentOnboardingSession } from './useAgentOnboardingSession';

const AgentOnboardingPage = memo(() => {
  const session = useAgentOnboardingSession();
  const { conversationHooks, handleAfterWrapUp, syncOnboardingContext } =
    useAgentOnboardingConversation(session);

  const {
    activeTopicId,
    data,
    effectiveTopicId,
    error,
    finishTargetUrl,
    hasMessages,
    historyDrawerOpen,
    historyTopics,
    isLoading,
    isResetting,
    onboardingAgentId,
    onboardingFinished,
    resetAgentOnboarding,
    setHistoryDrawerOpen,
    setIsResetting,
    setSelectedTopicId,
    viewingHistoricalTopic,
  } = session;

  if (error) {
    return (
      <OnboardingContainer>
        <RedirectToClassicOnboarding />
      </OnboardingContainer>
    );
  }

  // The builtin agent's slug must resolve before the page renders anything
  // useful. This is a short, in-process hydration (the builtin agent table is
  // usually warm); during this brief window we still show the brand loader.
  // Once `onboardingAgentId` is present, render the static Welcome shell
  // immediately — the bootstrap query keeps loading the rest in the background
  // while ChatInput is gated via `isInputReady`.
  if (!onboardingAgentId) {
    return <Loading debugId="AgentOnboarding" />;
  }

  const isInputReady = !isLoading;

  const handleReset = async () => {
    setIsResetting(true);

    try {
      await resetAgentOnboarding();
      const nextContext = await syncOnboardingContext();
      setSelectedTopicId(nextContext.topicId ?? undefined);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <OnboardingContainer>
      <AnalyticsBridge />
      <Flexbox height={'100%'} width={'100%'}>
        <OnboardingConversationProvider
          agentId={onboardingAgentId}
          frozen={onboardingFinished}
          hooks={conversationHooks}
          topicId={effectiveTopicId}
        >
          <ErrorBoundary fallbackRender={() => null}>
            <AgentOnboardingConversation
              discoveryUserMessageCount={data?.context?.discoveryUserMessageCount}
              feedbackSubmitted={!!data?.feedbackSubmitted}
              finishTargetUrl={finishTargetUrl}
              hasMessages={hasMessages}
              isInputReady={isInputReady}
              onboardingFinished={onboardingFinished}
              phase={data?.context?.phase}
              readOnly={viewingHistoricalTopic}
              showFeedback={!viewingHistoricalTopic}
              topicId={effectiveTopicId}
              onAfterWrapUp={handleAfterWrapUp}
            />
          </ErrorBoundary>
        </OnboardingConversationProvider>
        <HistoryDrawer
          activeTopicId={activeTopicId}
          open={historyDrawerOpen}
          selectedTopicId={effectiveTopicId}
          topics={historyTopics}
          onClose={() => setHistoryDrawerOpen(false)}
          onSelectTopic={(id) => {
            setSelectedTopicId(id);
            setHistoryDrawerOpen(false);
          }}
        />
      </Flexbox>
      <DevActions
        agentId={onboardingAgentId}
        hasHistory={historyTopics.length > 0}
        isResetting={isResetting}
        topicId={effectiveTopicId}
        onOpenHistory={() => setHistoryDrawerOpen(true)}
        onReset={handleReset}
      />
    </OnboardingContainer>
  );
});

AgentOnboardingPage.displayName = 'AgentOnboardingPage';

export default AgentOnboardingPage;
