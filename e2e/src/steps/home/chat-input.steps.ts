import { After, Given, Then, When } from '@cucumber/cucumber';
import { expect } from '@playwright/test';

import { llmMockManager } from '../../mocks/llm';
import type { CustomWorld } from '../../support/world';
import { WAIT_TIMEOUT } from '../../support/world';

const COLD_ROUTE_SCRIPT_DELAY = 2500;

/** Matches `/agent/...` and its workspace-prefixed mirror `/:slug/agent/...`. */
const AGENT_PATHNAME_REGEX = /^\/(?:[^/]+\/)?agent\//;

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const focusHomeChatInput = async (world: CustomWorld): Promise<void> => {
  const candidates = [
    world.page.locator('[data-testid="chat-input"] textarea'),
    world.page.locator('[data-testid="chat-input"] [contenteditable="true"]'),
    world.page.getByRole('textbox'),
    world.page.locator('[data-testid="chat-input"]'),
  ];

  for (const locator of candidates) {
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const visible = await item.isVisible().catch(() => false);
      if (!visible) continue;

      await item.click({ force: true });
      return;
    }
  }

  throw new Error('Could not find a visible Home chat input to focus');
};

Given(
  '用户在冷启动 Home 页面并延迟 Agent 路由加载',
  { timeout: 45_000 },
  async function (this: CustomWorld) {
    console.log('   📍 Step: 设置快速 LLM mock...');
    llmMockManager.clearResponses();
    llmMockManager.setConfig({
      responseDelay: 0,
      streamChunkSize: 1024,
      streamDelay: 0,
    });
    llmMockManager.setResponse('cold route home message', 'cold route response');
    await llmMockManager.setup(this.page);

    console.log('   📍 Step: 注册冷路由脚本延迟...');
    this.testContext.delayColdAgentScripts = false;

    await this.page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const shouldDelay =
        this.testContext.delayColdAgentScripts === true &&
        request.resourceType() === 'script' &&
        (url.includes('/_next/static/') ||
          url.includes('/src/routes/(main)/agent') ||
          url.includes('/src/routes/%28main%29/agent'));

      if (shouldDelay) {
        console.log(`   ⏳ Delaying cold agent script: ${url}`);
        await delay(COLD_ROUTE_SCRIPT_DELAY);
      }

      await route.continue();
    });

    console.log('   📍 Step: 导航到 Home 页面...');
    await this.page.goto('/');

    const chatInputContainer = this.page.locator('[data-testid="chat-input"]').first();
    await expect(chatInputContainer).toBeVisible({ timeout: WAIT_TIMEOUT });

    console.log('   ✅ 已进入冷启动 Home 页面');
  },
);

When(
  '用户在输入框中输入 {string}',
  { timeout: 30_000 },
  async function (this: CustomWorld, text: string) {
    console.log(`   📍 Step: 在 Home 输入框中输入 "${text}"...`);

    await focusHomeChatInput(this);
    await this.page.keyboard.type(text, { delay: 20 });

    console.log('   ✅ 已输入 Home 默认消息');
  },
);

When('用户按 Enter 从 Home 默认输入发送', { timeout: 45_000 }, async function (this: CustomWorld) {
  console.log('   📍 Step: 启用冷路由延迟并发送默认 Home 消息...');

  await this.page.waitForTimeout(200);
  this.testContext.delayColdAgentScripts = true;
  // Pin the pathname the composer was opened on (`/` or `/:workspaceSlug`):
  // sending must keep it byte-for-byte.
  const homePathname = new URL(this.page.url()).pathname;
  this.testContext.homePathname = homePathname;

  await this.page.keyboard.press('Enter');

  // The home composer never leaves the home pathname: the conversation is
  // addressed in place through `?agent=` (and later `?topic=`).
  await this.page.waitForURL(
    (url) => url.searchParams.has('agent') && url.pathname === homePathname,
    { timeout: WAIT_TIMEOUT },
  );

  console.log('   ✅ 已触发 Home 默认发送');
});

Then(
  '页面应该停留在首页并原地打开新建 Topic 对话',
  { timeout: 45_000 },
  async function (this: CustomWorld) {
    console.log('   📍 Step: 验证 URL 原地打开新建 Topic...');

    const homePathname = this.testContext.homePathname;
    expect(homePathname).toBeTruthy();

    await this.page.waitForURL(
      (url) =>
        !!url.searchParams.get('agent') &&
        !!url.searchParams.get('topic') &&
        url.pathname === homePathname,
      { timeout: 30_000 },
    );

    const currentUrl = new URL(this.page.url());
    expect(currentUrl.searchParams.get('agent')).toBeTruthy();
    expect(currentUrl.searchParams.get('topic')).toBeTruthy();
    expect(currentUrl.pathname).toBe(homePathname);
    // Never `/agent/...` — that pathname is what swaps the left nav away from home.
    expect(currentUrl.pathname).not.toMatch(AGENT_PATHNAME_REGEX);

    console.log(`   ✅ 已原地打开 Topic 对话: ${currentUrl.toString()}`);
  },
);

Then(
  '用户消息 {string} 应该保留在对话中',
  { timeout: 45_000 },
  async function (this: CustomWorld, message: string) {
    console.log(`   📍 Step: 验证用户消息仍在对话中: ${message}`);

    await expect(this.page.getByText(message).first()).toBeVisible({ timeout: WAIT_TIMEOUT });

    console.log('   ✅ 用户消息已保留在对话中');
  },
);

After({ tags: '@chat-input' }, async function (this: CustomWorld) {
  llmMockManager.resetConfig();
  llmMockManager.clearResponses();
  this.testContext.delayColdAgentScripts = false;
});
