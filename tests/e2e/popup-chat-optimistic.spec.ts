import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TARGET_URL = 'https://example.com/unity-popup-optimistic-chat';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Popup Optimistic Chat Fixture</title>
    <style>
      body {
        margin: 40px auto;
        max-width: 920px;
        font-family: Georgia, serif;
        line-height: 1.45;
      }
      article {
        border: 1px solid #ddd;
        border-radius: 12px;
        padding: 22px 24px;
      }
      p {
        margin: 0 0 14px 0;
      }
    </style>
  </head>
  <body>
    <article>
      <h1>Grounded Chat Optimistic Fixture</h1>
      <p>
        This deterministic fixture contains enough clean text for extraction so the extension can build
        context quickly and ask a grounded question without relying on external page structure.
      </p>
      <p>
        Integrals, derivatives, and continuity are included as neutral educational terms to ensure
        predictable snippet generation and avoid empty-context failures during test runs.
      </p>
      <p>
        The final paragraph is intentionally verbose and repeats useful phrases about accumulation,
        antiderivatives, and source citations so the extracted context remains above minimum thresholds.
      </p>
    </article>
  </body>
</html>`;

async function saveApiKeyViaPopupUiPage(popup: any): Promise<void> {
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
}

test('popup renders user bubble immediately, then assistant bubble, and auto-scrolls', async () => {
  test.setTimeout(240_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-popup-optimistic-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route(TARGET_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: FIXTURE_HTML,
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
                  'The page explains accumulation and antiderivatives, and this delayed reply verifies optimistic UI behavior in popup chat.',
                sources: [
                  {
                    id: 's-1',
                    quote: 'The final paragraph is intentionally verbose and repeats useful phrases.',
                    score: 0.95,
                  },
                ],
              }),
            },
          },
        ],
      }),
    });
  });

  let popup = null as any;
  let page = null as any;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
    const extensionId = new URL(serviceWorker.url()).host;

    page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await saveApiKeyViaPopupUiPage(popup);
    await popup.reload({ waitUntil: 'domcontentloaded' });

    const composer = popup.locator('textarea[placeholder="Ask a question about this tab..."]');
    await expect(composer).toBeVisible();

    const question = 'Immediate popup user message should appear first and stay pinned to the bottom. '.repeat(45);
    await composer.fill(question);
    await popup.getByRole('button', { name: 'Ask' }).click();

    await expect(popup.locator('.bubble--user')).toHaveCount(1, { timeout: 8_000 });
    await expect(popup.locator('.bubble--user').first()).toContainText(
      'Immediate popup user message should appear first',
      { timeout: 8_000 },
    );
    await popup.waitForTimeout(700);
    await expect(popup.locator('.bubble--assistant')).toHaveCount(0);

    await expect(popup.locator('.bubble--assistant')).toHaveCount(1, { timeout: 90_000 });
    const assistantVisibleInFeed = await popup.locator('[data-testid="chat-feed"]').evaluate((node: Element) => {
      const feed = node as HTMLElement;
      const assistantBubbles = Array.from(feed.querySelectorAll<HTMLElement>('.bubble--assistant'));
      const assistant = assistantBubbles[assistantBubbles.length - 1] ?? null;
      if (!assistant) return false;
      const feedRect = feed.getBoundingClientRect();
      const assistantRect = assistant.getBoundingClientRect();
      return assistantRect.bottom <= feedRect.bottom + 2;
    });
    expect(assistantVisibleInFeed).toBeTruthy();
  } finally {
    await popup?.close().catch(() => {});
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('popup keeps failed user bubble visible when ask request fails', async () => {
  test.setTimeout(240_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-popup-optimistic-fail-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route(TARGET_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: FIXTURE_HTML,
    });
  });

  await context.route(OPENROUTER_URL, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Intentional failure for optimistic UI test.' } }),
    });
  });

  let popup = null as any;
  let page = null as any;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
    const extensionId = new URL(serviceWorker.url()).host;

    page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await saveApiKeyViaPopupUiPage(popup);
    await popup.reload({ waitUntil: 'domcontentloaded' });

    const composer = popup.locator('textarea[placeholder="Ask a question about this tab..."]');
    await expect(composer).toBeVisible();

    await composer.fill('This request should fail after optimistic user rendering.');
    await popup.getByRole('button', { name: 'Ask' }).click();

    await expect(popup.locator('.bubble--user')).toHaveCount(1, { timeout: 8_000 });
    await expect(popup.locator('.bubble--user.bubble--failed')).toHaveCount(1, { timeout: 90_000 });
    await expect(popup.locator('.error-text')).toBeVisible();
    await expect(popup.locator('.bubble--assistant')).toHaveCount(0);
  } finally {
    await popup?.close().catch(() => {});
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
