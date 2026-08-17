import { lazySearchImpl } from '@/server/enterprise/services/search/lazySearchImpl';

import { type SearchServiceImpl } from './type';

/**
 * Available search service implementations
 */
export enum SearchImplType {
  Anspire = 'anspire',
  Bocha = 'bocha',
  Brave = 'brave',
  Exa = 'exa',
  Firecrawl = 'firecrawl',
  Google = 'google',
  Jina = 'jina',
  Kagi = 'kagi',
  Search1API = 'search1api',
  SearXNG = 'searxng',
  Tavily = 'tavily',
}

/**
 * Create a search service implementation instance
 */
export const createSearchServiceImpl = (
  type: SearchImplType = SearchImplType.SearXNG,
): SearchServiceImpl => {
  switch (type) {
    case SearchImplType.Anspire: {
      return lazySearchImpl(() => import('./anspire'));
    }

    case SearchImplType.Bocha: {
      return lazySearchImpl(() => import('./bocha'));
    }

    case SearchImplType.Brave: {
      return lazySearchImpl(() => import('./brave'));
    }

    case SearchImplType.Exa: {
      return lazySearchImpl(() => import('./exa'));
    }

    case SearchImplType.Firecrawl: {
      return lazySearchImpl(() => import('./firecrawl'));
    }

    case SearchImplType.Google: {
      return lazySearchImpl(() => import('./google'));
    }

    case SearchImplType.Jina: {
      return lazySearchImpl(() => import('./jina'));
    }

    case SearchImplType.Kagi: {
      return lazySearchImpl(() => import('./kagi'));
    }

    case SearchImplType.SearXNG: {
      return lazySearchImpl(() => import('./searxng'));
    }

    case SearchImplType.Tavily: {
      return lazySearchImpl(() => import('./tavily'));
    }

    default: {
      return lazySearchImpl(() => import('./search1api'), { useAutoSearchEngineSelection: true });
    }
  }
};

export type { SearchServiceImpl } from './type';
