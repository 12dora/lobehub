import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
import dynamic from '@/libs/next/dynamic';

/**
 * Provider forms are lazy chunks that normally land inside the grace period, so
 * the loader is delayed and inline — the settings shell is already painted
 * around it, a fullscreen splash here read as a page reload.
 */
const loading = (debugId: string) => () => (
  <DelayedFallback>
    <Loading debugId={debugId} variant={'inline'} />
  </DelayedFallback>
);

const NewAPI = dynamic(() => import('./newapi'), {
  loading: loading('Provider > NewAPI'),
  ssr: false,
});
const OpenAI = dynamic(() => import('./openai'), {
  loading: loading('Provider > OpenAI'),
  ssr: false,
});
const VertexAI = dynamic(() => import('./vertexai'), {
  loading: loading('Provider > VertexAI'),
  ssr: false,
});
const GitHub = dynamic(() => import('./github'), {
  loading: loading('Provider > GitHub'),
  ssr: false,
});
const Ollama = dynamic(() => import('./ollama'), {
  loading: loading('Provider > Ollama'),
  ssr: false,
});
const ComfyUI = dynamic(() => import('./comfyui'), {
  loading: loading('Provider > ComfyUI'),
  ssr: false,
});
const Cloudflare = dynamic(() => import('./cloudflare'), {
  loading: loading('Provider > Cloudflare'),
  ssr: false,
});
const Bedrock = dynamic(() => import('./bedrock'), {
  loading: loading('Provider > Bedrock'),
  ssr: false,
});
const AzureAI = dynamic(() => import('./azureai'), {
  loading: loading('Provider > AzureAI'),
  ssr: false,
});
const Azure = dynamic(() => import('./azure'), {
  loading: loading('Provider > Azure'),
  ssr: false,
});
const ProviderGrid = dynamic(() => import('../(list)/ProviderGrid'), {
  loading: loading('Provider > Grid'),
  ssr: false,
});
const DefaultPage = dynamic(() => import('./default/ProviderDetialPage'), {
  loading: loading('Provider > Default'),
  ssr: false,
});

type ProviderDetailPageProps = {
  id?: string | null;
  onProviderSelect: (provider: string) => void;
};

const ProviderDetailPage = (props: ProviderDetailPageProps) => {
  const { id, onProviderSelect } = props;

  switch (id) {
    case 'all': {
      return <ProviderGrid onProviderSelect={onProviderSelect} />;
    }
    case 'azure': {
      return <Azure />;
    }
    case 'azureai': {
      return <AzureAI />;
    }
    case 'bedrock': {
      return <Bedrock />;
    }
    case 'cloudflare': {
      return <Cloudflare />;
    }
    case 'comfyui': {
      return <ComfyUI />;
    }
    case 'github': {
      return <GitHub />;
    }
    case 'ollama': {
      return <Ollama />;
    }
    case 'newapi': {
      return <NewAPI />;
    }
    case 'openai': {
      return <OpenAI />;
    }
    case 'vertexai': {
      return <VertexAI />;
    }
    default: {
      return <DefaultPage id={id} />;
    }
  }
};

export default ProviderDetailPage;
