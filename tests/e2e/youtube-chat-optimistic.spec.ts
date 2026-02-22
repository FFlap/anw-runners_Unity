import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TARGET_URL = 'https://www.youtube.com/watch?v=unity-youtube-optimistic-fixture';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const YOUTUBE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>YouTube Optimistic Chat Fixture</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 400px;
        gap: 12px;
        padding: 12px;
        box-sizing: border-box;
        font-family: Arial, sans-serif;
        background: #f5f5f5;
      }
      .player-shell {
        border: 1px solid #222;
        border-radius: 10px;
        overflow: hidden;
        background: #101010;
      }
      .html5-video-player {
        min-height: 420px;
        padding: 16px;
      }
      video {
        display: block;
        width: 100%;
        min-height: 320px;
        background: #000;
      }
      .description {
        color: #ddd;
        font-size: 15px;
        line-height: 1.5;
        margin-top: 14px;
      }
      #secondary-inner {
        min-height: 660px;
        border: 1px solid #ccc;
        border-radius: 10px;
        background: #fff;
      }
    </style>
  </head>
  <body>
    <main class="player-shell">
      <div class="html5-video-player">
        <video controls></video>
        <p class="description">
          This deterministic watch fixture includes enough visible text so Unity can extract context and
          answer grounded questions during automated tests. It repeats useful phrases about transcript
          lines, source snippets, and antiderivatives to ensure predictable extraction length for the
          optimistic chat behavior checks in the YouTube in-page panel.
        </p>
      </div>
    </main>
    <aside id="secondary-inner" aria-label="Secondary rail"></aside>
  </body>
</html>`;

async function saveApiKey(extensionId: string, context: any): Promise<void> {
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.evaluate(async () => {
      const runtime = (globalThis as any).chrome?.runtime;
      await new Promise<void>((resolve, reject) => {
        runtime.sendMessage({ type: 'SAVE_API_KEY', apiKey: 'test-key' }, (response: any) => {
          const error = runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || 'SAVE_API_KEY failed.'));
            return;
          }
          resolve();
        });
      });
    });
  } finally {
    await popup.close().catch(() => {});
  }
}

test('youtube panel renders user bubble immediately, then assistant, and auto-scrolls', async () => {
  test.setTimeout(240_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-youtube-optimistic-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route('https://www.youtube.com/watch?v=unity-youtube-optimistic-fixture*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: YOUTUBE_FIXTURE_HTML,
    });
  });

  await context.route(OPENROUTER_URL, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer:
                  'The assistant reply arrived after the optimistic user bubble, confirming delayed-answer behavior in the in-page YouTube chat.',
                sources: [
                  {
                    id: 'yt-1',
                    quote: 'This deterministic watch fixture includes enough visible text.',
                    score: 0.91,
                  },
                ],
              }),
            },
          },
        ],
      }),
    });
  });

  let page = null as any;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
    const extensionId = new URL(serviceWorker.url()).host;
    await saveApiKey(extensionId, context);

    page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const panel = page.locator('#unity-youtube-chat-root');
    const composer = panel.locator('[data-testid="unity-composer-input"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await composer.fill('Immediate YouTube in-page user message should appear before AI response. '.repeat(35));
    await panel.locator('.unity-primary-btn').click();

    await expect(panel.locator('.unity-bubble--user')).toHaveCount(1, { timeout: 8_000 });
    await expect(panel.locator('.unity-bubble--assistant')).toHaveCount(0);

    await expect(panel.locator('.unity-bubble--assistant')).toHaveCount(1, { timeout: 90_000 });
    await page.waitForTimeout(350);
    const assistantVisibleInFeed = await panel.locator('[data-testid="unity-chat-list"]').evaluate((node: Element) => {
      const feed = node as HTMLElement;
      const assistantBubbles = Array.from(feed.querySelectorAll<HTMLElement>('.unity-bubble--assistant'));
      const assistant = assistantBubbles[assistantBubbles.length - 1] ?? null;
      if (!assistant) return false;
      const feedRect = feed.getBoundingClientRect();
      const assistantRect = assistant.getBoundingClientRect();
      return assistantRect.bottom <= feedRect.bottom + 2;
    });
    expect(assistantVisibleInFeed).toBeTruthy();
  } finally {
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('youtube panel keeps failed user bubble visible when ask request fails', async () => {
  test.setTimeout(240_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-youtube-optimistic-fail-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route('https://www.youtube.com/watch?v=unity-youtube-optimistic-fixture*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: YOUTUBE_FIXTURE_HTML,
    });
  });

  await context.route(OPENROUTER_URL, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Intentional failure for YouTube optimistic UI test.' } }),
    });
  });

  let page = null as any;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
    const extensionId = new URL(serviceWorker.url()).host;
    await saveApiKey(extensionId, context);

    page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const panel = page.locator('#unity-youtube-chat-root');
    const composer = panel.locator('[data-testid="unity-composer-input"]');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await composer.fill('This YouTube in-page request should fail after optimistic render.');
    await panel.locator('.unity-primary-btn').click();

    await expect(panel.locator('.unity-bubble--user')).toHaveCount(1, { timeout: 8_000 });
    await expect(panel.locator('.unity-bubble--user.unity-bubble--failed')).toHaveCount(1, { timeout: 90_000 });
    await expect(panel.locator('.unity-error')).toBeVisible();
    await expect(panel.locator('.unity-bubble--assistant')).toHaveCount(0);
  } finally {
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
