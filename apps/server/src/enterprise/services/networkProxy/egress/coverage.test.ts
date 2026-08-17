import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Static inventory of outbound `fetch(` / SDK client constructions in
 * `packages/model-runtime/src`. Every site must be classified so a new
 * unannotated call fails this test (design §3.5 / B0_INTERFACE §3).
 *
 *   explicit-fetch — constructor / call receives an injected `fetch`
 *   als            — invoked from a runtime method wrapped by ALS
 *   excluded:<why> — not a live server-side provider hop
 */
type SiteKind = 'als' | 'explicit-fetch' | `excluded:${string}`;

const ROOT = join(__dirname, '../../../../../../../packages/model-runtime/src');

const SITE_RE =
  /\b(?:ssrfSafeFetch|globalThis\.fetch|injectedFetch|fetchImpl|fetch)\s*\(|new\s+(?:OpenAI|Anthropic|Ollama|Replicate|GoogleGenAI|AzureOpenAI)\s*\(/;

const SKIP_DIR = new Set(['__tests__', '__mocks__', 'fixtures', 'node_modules']);
const isTestFile = (file: string) => /\.(?:test|spec)\.(?:ts|tsx|js|mts)$/.test(file);

/** Collapse whitespace so `fetch(\n  url)` is visible to the same regex as a one-liner. */
export const scanCollapsedSource = (source: string): string[] => {
  const collapsed = source.replaceAll(/\s+/g, ' ');
  const sites: string[] = [];
  const seen = new Map<string, number>();
  const re = new RegExp(SITE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(collapsed))) {
    const snippet = collapsed.slice(match.index, match.index + 96).trim();
    const n = (seen.get(snippet) ?? 0) + 1;
    seen.set(snippet, n);
    sites.push(n === 1 ? snippet : `${snippet}#${n}`);
  }
  return sites;
};

const ALLOWLIST: Record<string, SiteKind> = {
  'core/anthropicCompatibleFactory/index.ts:new Anthropic({ ...options, ...(baseURL ? { baseURL } : {}), defaultHeaders, timeout: options.ti':
    'explicit-fetch',
  "core/anthropicCompatibleFactory/index.ts:injectedFetch(`${baseURL}/v1/models`, { headers: { 'anthropic-version': '2023-06-01', 'x-api-key":
    'explicit-fetch',
  'core/anthropicCompatibleFactory/index.ts:new Anthropic(initOptions as ConstructorOptions<T>); } this.baseURL = finalBaseURL || this.clien':
    'explicit-fetch',
  'core/contextBuilders/openai.ts:fetch(imageUrl); if (!response.ok) { throw new Error(`Failed to fetch image from ${imageUrl}: ${':
    'als',
  "core/openaiCompatibleFactory/createVideo.ts:fetch(statusUrl, { headers: { 'Authorization': `Bearer ${options.apiKey}`, 'Content-Type': 'appl":
    'als',
  "core/openaiCompatibleFactory/createVideo.ts:fetch(`${baseURL}/videos`, { body: JSON.stringify(body), headers: { 'Authorization': `Bearer ${o":
    'als',
  'core/openaiCompatibleFactory/index.ts:new OpenAI(initOptions); } this.baseURL = baseURL || this.client.baseURL; this.id = options.id |':
    'explicit-fetch',
  'core/openaiCompatibleFactory/index.ts:new OpenAI(initOptions); } this.baseURL = targetBaseURL; } const messages = await convertOpenAIM':
    'explicit-fetch',
  "providers/aihubmix/index.ts:fetch(urlJoin(rootBaseURL, '/api/v1/models'), { headers: { 'Authorization': `Bearer ${apiKey}`,":
    'als',
  "providers/bfl/createImage.ts:fetch(url, { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', 'x-ke":
    'als',
  "providers/bfl/createImage.ts:fetch(pollingUrl, { headers: { 'accept': 'application/json', 'x-key': options.apiKey, }, method:":
    'als',
  'providers/chatGPT/index.ts:new OpenAI({ ...options, defaultHeaders: { ...options.defaultHeaders, ...(chatgptAccountId && {':
    'explicit-fetch',
  'providers/chatgptWeb/assetDownload.ts:ssrfSafeFetch(url, { signal }, { maxContentLength: MAX_DOWNLOAD_BYTES + 1 }), ) : await globalTh':
    'als',
  'providers/chatgptWeb/assetDownload.ts:globalThis.fetch(url, { signal }); } catch (error) { // the caller pressing stop keeps its own A':
    'als',
  'providers/chatgptWeb/createImage.references.ts:ssrfSafeFetch( url, { signal: composed.signal }, // one byte over the limit is enough to prove t':
    'als',
  "providers/chatgptWeb/http.ts:fetchImpl(url, { ...init, headers: this.withCookieJarHeader(url, init.headers), redirect: 'manua":
    'explicit-fetch',
  'providers/cloudflare/index.ts:globalThis.fetch(input, init)); } async chat(payload: ChatStreamPayload, options?: ChatMethodOpt':
    'explicit-fetch',
  "providers/cloudflare/index.ts:fetchImpl(url, { body: JSON.stringify({ tools: functions, ...restPayload }), headers: { 'Content":
    'explicit-fetch',
  "providers/cloudflare/index.ts:fetchImpl(url, { headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'applicati":
    'explicit-fetch',
  'providers/comfyui/index.ts:globalThis.fetch(input, init)); this.baseURL = options.baseURL || process.env.COMFYUI_DEFAULT_UR':
    'explicit-fetch',
  'providers/comfyui/index.ts:fetchImpl(`${appUrl}/webapi/create-image/comfyui`, { body: JSON.stringify({ model: payload.model':
    'explicit-fetch',
  'providers/cursor/index.ts:globalThis.fetch(input, init)); } async chat(payload: ChatStreamPayload, options?: ChatMethodOpt':
    'explicit-fetch',
  'providers/cursor/index.ts:fetchImpl(url, { ...init, headers: { ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}`':
    'explicit-fetch',
  "providers/github/index.ts:fetch('https://models.github.ai/catalog/models'); const modelList: GithubModelCard[] = await res":
    'als',
  "providers/githubCopilot/index.ts:fetch(TOKEN_EXCHANGE_URL, { headers: { 'Accept': 'application/json', 'Authorization': `Token ${g":
    'als',
  "providers/githubCopilot/index.ts:new Anthropic({ apiKey: bearerToken, baseURL: this.baseURL, defaultHeaders: { 'Authorization': `":
    'explicit-fetch',
  "providers/githubCopilot/index.ts:new OpenAI({ apiKey: bearerToken, baseURL: COPILOT_BASE_URL, defaultHeaders: { 'Copilot-Integrat":
    'explicit-fetch',
  "providers/githubCopilot/index.ts:fetch(`${COPILOT_BASE_URL}/models`, { headers: { 'Accept': 'application/json', 'Authorization':":
    'als',
  'providers/google/index.ts:new GoogleGenAI({ apiKey, httpOptions }); this.baseURL = client ? undefined : baseURL || DEFAULT':
    'als',
  "providers/google/index.ts:fetch(url, { headers: { 'x-goog-api-key': this.apiKey!, }, method: 'GET', signal: options?.signa":
    'als',
  "providers/grok/index.ts:new OpenAI({ ...options, defaultHeaders: { ...options.defaultHeaders, ...suppressStainlessHeader":
    'explicit-fetch',
  "providers/huggingface/index.ts:fetch('https://router.huggingface.co/v1/models'); if (!response.ok) { throw new Error(`HuggingFa":
    'als',
  "providers/hunyuan/createImage.ts:fetch(submitUrl, { body: JSON.stringify(requestBody), headers: { 'Authorization': `Bearer ${apiK":
    'als',
  "providers/hunyuan/createImage.ts:fetch(submitUrl, { body: JSON.stringify(requestBody), headers: { 'Authorization': `Bearer ${apiK#2":
    'als',
  "providers/hunyuan/createImage.ts:fetch(queryUrl, { body: JSON.stringify({ model, id: jobId }), headers: { 'Authorization': `Beare":
    'als',
  "providers/hunyuan/createVideo.ts:fetch(submitUrl, { body: JSON.stringify(requestBody), headers: { 'Authorization': `Bearer ${apiK":
    'als',
  "providers/hunyuan/createVideo.ts:fetch(queryUrl, { body: JSON.stringify(queryBody), headers: { 'Authorization': `Bearer ${apiKey}":
    'als',
  "providers/minimax/createImage.ts:fetch(endpoint, { body: JSON.stringify(requestBody), headers: { 'Authorization': `Bearer ${apiKe":
    'als',
  'providers/minimax/createVideo.ts:fetch(urlWithParams.toString(), { headers: { Authorization: `Bearer ${options.apiKey}`, }, metho':
    'als',
  'providers/minimax/createVideo.ts:fetch(urlWithParams.toString(), { headers: { Authorization: `Bearer ${options.apiKey}`, }, metho#2':
    'als',
  "providers/minimax/createVideo.ts:fetch(`${baseURL}/video_generation`, { body: JSON.stringify(body), headers: { 'Authorization': `":
    'als',
  "providers/nebius/index.ts:fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${client.apiKey}`, },":
    'als',
  'providers/newapi/index.ts:fetch(`/webapi/models/${encodeURIComponent(providerId)}/pricing`); } else { const fetchWithAuth':
    'als',
  'providers/newapi/index.ts:fetch(pricingUrl, { headers }); }; let usedAuth = true; try { res = await fetchWithAuth(true); }':
    'als',
  'providers/ollama/index.ts:new Ollama( !baseURL && !fetch ? undefined : { ...(baseURL ? { host: baseURL } : {}), fetch }, )':
    'explicit-fetch',
  'providers/opencodeCodingPlan/index.ts:fetch(MODELS_DEV_URL); if (!res.ok) throw new Error(`HTTP ${res.status}`); const data: ModelsDev':
    'als',
  "providers/openrouter/index.ts:fetch('https://openrouter.ai/api/v1/models'); if (!response.ok) { throw new Error(`OpenRouter mo":
    'als',
  "providers/qwen/createImage.ts:fetch(url, { body: JSON.stringify({ input, model, parameters, }), headers: { 'Authorization': `B":
    'als',
  "providers/qwen/createImage.ts:fetch(endpoint, { body: JSON.stringify({ input: { messages: [ { content, role: 'user', }, ], },":
    'als',
  "providers/qwen/createImage.ts:fetch(endpoint, { body: JSON.stringify({ input: { messages: [ { content, role: 'user', }, ], },#2":
    'als',
  'providers/qwen/createImage.ts:fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}`, }, }); if (!response.ok) { let e':
    'als',
  "providers/qwen/createVideo.ts:fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}`, }, method: 'GET', }); if (!respo":
    'als',
  "providers/qwen/createVideo.ts:fetch(url, { body: JSON.stringify({ input, model, parameters, }), headers: { 'Authorization': `B":
    'als',
  'providers/replicate/index.ts:new Replicate({ auth: apiKey, baseUrl: baseURL !== DEFAULT_BASE_URL ? baseURL : undefined, ...(f':
    'explicit-fetch',
  'providers/replicate/index.ts:ssrfSafeFetch(imageUrl); if (!imageResponse.ok) { throw new Error( `Failed to fetch image: ${ima':
    'als',
  "providers/siliconcloud/createImage.ts:fetch(endpoint, { body: JSON.stringify(body), headers: { 'Authorization': `Bearer ${apiKey}`, 'C":
    'als',
  "providers/siliconcloud/createVideo.ts:fetch(statusUrl, { body: JSON.stringify({ requestId }), headers: { 'Authorization': `Bearer ${op":
    'als',
  "providers/siliconcloud/createVideo.ts:fetch(`${baseURL}/video/submit`, { body: JSON.stringify(body), headers: { 'Authorization': `Bear":
    'als',
  'providers/siliconcloud/index.ts:fetch(input, init); const response = await defaultFetch(input, init); if (!response || response.':
    'als',
  "providers/stepfun/createImage.ts:fetch(`${baseURL}/images/${endpoint}`, { method: 'POST', headers: { 'Authorization': `Bearer ${a":
    'als',
  "providers/straico/index.ts:fetch(url, { headers: { Authorization: `Bearer ${client.apiKey}`, }, method: 'GET', }); if (!res":
    'als',
  'providers/vertexai/index.ts:new GoogleGenAI({ ...googleOptions, ...(googleAuthOptions ? { googleAuthOptions } : {}), locatio':
    'explicit-fetch',
  "providers/volcengine/createImage.ts:new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL || 'https://ark.cn-beijing.volces.":
    'als',
  "providers/volcengine/video/createVideo.ts:fetch(`${baseURL}/contents/generations/tasks`, { body: JSON.stringify(body), headers: { 'Authori":
    'als',
  "providers/wenxin/createImage.ts:fetch(endpoint, { body: JSON.stringify(requestBody), headers: { 'Authorization': `Bearer ${apiKe":
    'als',
  "providers/wenxin/createVideo.ts:fetch(statusUrl, { headers: { 'Authorization': `Bearer ${options.apiKey}`, 'Content-Type': 'appl":
    'als',
  "providers/wenxin/createVideo.ts:fetch(`${baseURL}/video/generations`, { body: JSON.stringify(body), headers: { 'Authorization':":
    'als',
  "providers/xai/createImage.ts:fetch(endpoint, { body: JSON.stringify(requestBody), headers: { 'Authorization': `Bearer ${apiKe":
    'als',
  "providers/xai/createVideo.ts:fetch(statusUrl, { headers: { 'Authorization': `Bearer ${options.apiKey}`, 'Content-Type': 'appl":
    'als',
  "providers/xai/createVideo.ts:fetch(`${baseURL}/videos/generations`, { body: JSON.stringify(body), headers: { 'Authorization':":
    'als',
  "providers/zhipu/createImage.ts:fetch(statusUrl, { headers: { 'Authorization': `Bearer ${options.apiKey}`, 'Content-Type': 'appl":
    'als',
  "providers/zhipu/createImage.ts:fetch(endpoint, { body: JSON.stringify(body), headers: { 'Authorization': `Bearer ${options.apiK":
    'als',
  "providers/zhipu/createVideo.ts:fetch(statusUrl, { headers: { 'Authorization': `Bearer ${options.apiKey}`, 'Content-Type': 'appl":
    'als',
  "providers/zhipu/createVideo.ts:fetch(`${baseURL}/videos/generations`, { body: JSON.stringify(body), headers: { 'Authorization':":
    'als',
  "providers/zhipu/index.ts:fetch(url, { headers: { 'Authorization': `Bearer ${client.apiKey}`, 'Bigmodel-Organization': 'lo":
    'als',
  'utils/azureFetchHttpClient.ts:fetchImpl(request.url, { body, headers, method: request.method, signal, }); const text = await r':
    'explicit-fetch',
  'utils/fetchRequestHandler.ts:fetchImpl(url, { body, headers, method: request.method, signal, }); const arrayBuffer = await re':
    'explicit-fetch',
  "utils/uriParser.ts:ssrfSafeFetch( url, { headers: { 'User-Agent': 'LobeChat/1.0 (https://lobehub.com)', }, method:":
    'als',
};

const siteKey = (rel: string, snippet: string): string => `${rel}:${snippet}`;

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry) || isTestFile(entry)) continue;
    acc.push(full);
  }
  return acc;
};

describe('model-runtime outbound coverage inventory', () => {
  it('classifies every fetch( / SDK constructor site', () => {
    const files = walk(ROOT);
    const found: string[] = [];
    const unknown: string[] = [];

    for (const file of files) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      for (const snippet of scanCollapsedSource(readFileSync(file, 'utf8'))) {
        const key = siteKey(rel, snippet);
        found.push(key);
        if (!ALLOWLIST[key]) unknown.push(key);
      }
    }

    const stale = Object.keys(ALLOWLIST).filter((key) => !found.includes(key));

    if (unknown.length > 0 || stale.length > 0) {
      const message = [
        unknown.length
          ? `Unclassified outbound sites (add to ALLOWLIST as explicit-fetch | als | excluded:<reason>):\n${unknown.join('\n')}`
          : '',
        stale.length ? `Stale ALLOWLIST keys (site disappeared):\n${stale.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      expect.fail(message);
    }

    expect(found.length).toBeGreaterThan(20);
  });

  it('detects a synthetic multiline bare fetch as unclassified', () => {
    const snippets = scanCollapsedSource(
      'export const go = () => fetch(\n  "https://evil.test/new"\n);',
    );
    expect(snippets.some((s) => s.includes('fetch('))).toBe(true);
    const key = siteKey('synthetic.ts', snippets[0]!);
    expect(ALLOWLIST[key]).toBeUndefined();
  });
});
