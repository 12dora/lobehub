import { Flexbox } from '@lobehub/ui';
// import { PencilLineIcon } from 'lucide-react';
import { type FC } from 'react';

import AsyncBoundary from '@/components/AsyncBoundary';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import NavHeader from '@/features/NavHeader';
import WideScreenContainer from '@/features/WideScreenContainer';
import WideScreenButton from '@/features/WideScreenContainer/WideScreenButton';
import ActionBar from '@/routes/(main)/memory/features/ActionBar';
import Loading from '@/routes/(main)/memory/features/Loading';
import MemoryAnalysis from '@/routes/(main)/memory/features/MemoryAnalysis';
import MemoryEmpty from '@/routes/(main)/memory/features/MemoryEmpty';
import { SCROLL_PARENT_ID } from '@/routes/(main)/memory/features/TimeLineView/useScrollParent';
import { useUserMemoryStore } from '@/store/userMemory';

import Persona from './features/Persona';
import PersonaHeader from './features/Persona/PersonaHeader';
import RoleTagCloud from './features/RoleTagCloud';

const Home: FC = () => {
  const useFetchTags = useUserMemoryStore((s) => s.useFetchTags);
  const useFetchPersona = useUserMemoryStore((s) => s.useFetchPersona);
  const roles = useUserMemoryStore((s) => s.roles);
  const persona = useUserMemoryStore((s) => s.persona);

  const { isLoading: isTagsLoading, error: tagsError, mutate: mutateTags } = useFetchTags();
  const {
    isLoading: isPersonaLoading,
    error: personaError,
    mutate: mutatePersona,
  } = useFetchPersona();
  // const { EditorModalElement, openEditor } = usePersonaEditor();

  // The first load used to early-return the FULLSCREEN brand loader inside the
  // memory pane: the chrome vanished and a 100dvh splash took over the panel on
  // every visit. Loading is now just one more state of the body below, folded
  // into the AsyncBoundary that already arbitrates error / empty / data — and
  // the store keeps persona + tags, so a revisit renders straight from them
  // while SWR revalidates in the background.
  const isColdLoading = isTagsLoading || isPersonaLoading;

  // Persona / tags feed the store, so a failed fetch left the render falling
  // through to the "analyze to get started" onboarding — telling the user they
  // have no memories when the load merely errored. Branch error before empty.
  const hasData = !!persona || roles?.length > 0;
  const error = tagsError ?? personaError;

  return (
    <Flexbox flex={1} height={'100%'}>
      <NavHeader
        right={
          <ActionBar showAnalysis showPurge>
            {/* <ActionIcon icon={PencilLineIcon} onClick={openEditor} /> */}
            <WideScreenButton />
          </ActionBar>
        }
        style={{
          zIndex: 1,
        }}
      />
      <Flexbox
        height={'100%'}
        id={SCROLL_PARENT_ID}
        style={{ overflowY: 'auto', paddingBottom: '16vh' }}
        width={'100%'}
      >
        <WideScreenContainer gap={32} paddingBlock={48}>
          <AsyncBoundary
            data={persona ?? (roles?.length ? roles : undefined)}
            error={error}
            errorVariant={'page'}
            isEmpty={!hasData}
            isLoading={isColdLoading}
            empty={
              <MemoryEmpty>
                <MemoryAnalysis />
              </MemoryEmpty>
            }
            loading={
              <DelayedFallback>
                <Loading />
              </DelayedFallback>
            }
            onRetry={() => {
              mutateTags();
              mutatePersona();
            }}
          >
            {roles?.length > 0 && <RoleTagCloud tags={roles} />}
            {persona && (
              <>
                <PersonaHeader />
                <Persona />
              </>
            )}
          </AsyncBoundary>
        </WideScreenContainer>
      </Flexbox>
      {/* {EditorModalElement} */}
    </Flexbox>
  );
};

export default Home;
