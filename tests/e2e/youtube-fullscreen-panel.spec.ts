import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TARGET_URL = 'https://www.youtube.com/watch?v=unity-fullscreen-fixture';

const YOUTUBE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>YouTube Fullscreen Fixture</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 380px;
        gap: 12px;
        padding: 12px;
        box-sizing: border-box;
        font-family: Arial, sans-serif;
      }
      .html5-video-player {
        width: 100%;
        min-height: 420px;
        background: #111;
        border: 1px solid #222;
        border-radius: 8px;
        position: relative;
      }
      video {
        width: 100%;
        min-height: 420px;
        display: block;
      }
      #secondary-inner {
        width: 380px;
        min-height: 620px;
        border: 1px solid #ccc;
        background: #fff;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="html5-video-player" aria-label="Player">
        <video controls></video>
      </div>
    </main>
    <aside id="secondary-inner" aria-label="Secondary rail"></aside>
  </body>
</html>`;

test('youtube panel hides during fullscreen and restores when fullscreen exits', async () => {
  test.setTimeout(180_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-youtube-fullscreen-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route('https://www.youtube.com/watch?v=unity-fullscreen-fixture*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: YOUTUBE_FIXTURE_HTML,
    });
  });

  let page = null as any;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }

    page = await context.newPage();
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const panel = page.locator('#unity-youtube-chat-root');
    const composer = page.locator('[data-testid="unity-composer-input"]');

    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill('Keep this question draft');
    await expect(composer).toHaveValue('Keep this question draft');

    await page.evaluate(() => {
      const player = document.querySelector('.html5-video-player');
      if (!player) throw new Error('Fixture player element is missing.');
      player.classList.add('ytp-fullscreen');
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(2_100);
    await expect(panel).toHaveCount(0);

    await page.evaluate(() => {
      const player = document.querySelector('.html5-video-player');
      if (!player) throw new Error('Fixture player element is missing.');
      player.classList.remove('ytp-fullscreen');
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await expect(composer).toHaveValue('Keep this question draft');
  } finally {
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
