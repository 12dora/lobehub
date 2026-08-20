import { Flexbox } from '@lobehub/ui';
import { type FC } from 'react';

import HomePageTracker from '@/components/Analytics/HomePageTracker';
import HomeConversation from '@/features/HomeConversation';
import { useActiveHomeConversation } from '@/features/HomeConversation/useHomeConversation';
import NavHeader from '@/features/NavHeader';
import WideScreenContainer from '@/features/WideScreenContainer';

import HomeContent from './features';

const Home: FC = () => {
  // `/?agent=…&topic=…` (or `?group=`) opens the conversation **in place**: the
  // pathname stays home, so the left nav, the home overlay and the route
  // transition key are untouched — only this right column swaps.
  const conversation = useActiveHomeConversation();

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
