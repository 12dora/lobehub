import { Flexbox } from '@lobehub/ui';
import { type FC, useEffect } from 'react';

import HomePageTracker from '@/components/Analytics/HomePageTracker';
import HomeConversation, {
  prefetchAgentSurface,
  prefetchGroupSurface,
} from '@/features/HomeConversation';
import { useActiveHomeConversation } from '@/features/HomeConversation/useHomeConversation';
import NavHeader from '@/features/NavHeader';
import WideScreenContainer from '@/features/WideScreenContainer';

import HomeContent from './features';

const Home: FC = () => {
  // `/?agent=…&topic=…` (or `?group=`) opens the conversation **in place**: the
  // pathname stays home, so the left nav, the home overlay and the route
  // transition key are untouched — only this right column swaps.
  const conversation = useActiveHomeConversation();

  // Warm the lazy conversation chunks while the user is still on the landing.
  // Both kinds are reachable from here — the composer sends to an agent, the
  // Recents rows open either — and the column swaps in the very next commit. On
  // a cold chunk `dynamic` would render nothing first (`DelayedFallback` stays
  // blank for its 200ms) before the messages appear.
  //
  // Deferred to idle on purpose: the chunks are split precisely to keep `/`
  // cheap to boot, so they must not compete with the first paint. Composer focus
  // warms the agent one again, immediately — see `InputArea`.
  useEffect(() => {
    if (conversation) return;

    const warm = () => {
      prefetchAgentSurface();
      prefetchGroupSurface();
    };

    if (typeof requestIdleCallback !== 'function') {
      const timer = setTimeout(warm, 1000);
      return () => clearTimeout(timer);
    }

    const handle = requestIdleCallback(warm, { timeout: 3000 });
    return () => cancelIdleCallback(handle);
  }, [conversation]);

  if (conversation) return <HomeConversation {...conversation} />;

  return (
    <>
      <HomePageTracker />
      <NavHeader />
      <Flexbox
        height={'100%'}
        style={{ overflowY: 'auto', paddingBlock: '44px 16vh' }}
        width={'100%'}
      >
        <WideScreenContainer>
          <HomeContent />
        </WideScreenContainer>
      </Flexbox>
    </>
  );
};

export default Home;
