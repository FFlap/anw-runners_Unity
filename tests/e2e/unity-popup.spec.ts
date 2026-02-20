import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('popup bootstraps Unity chat shell', async () => {
  test.setTimeout(120_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }

    const extensionId = new URL(serviceWorker.url()).host;
    const popup = await context.newPage();

    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(popup.locator('h1')).toContainText('Grounded Tab Chat');

    const settings = await popup.evaluate(async () => {
      const runtime = (globalThis as any).chrome?.runtime;
      return await new Promise<{ hasApiKey: boolean }>((resolve, reject) => {
        runtime.sendMessage({ type: 'GET_SETTINGS' }, (response: unknown) => {
          const runtimeError = runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response as { hasApiKey: boolean });
        });
      });
    });

    expect(typeof settings.hasApiKey).toBe('boolean');
    await popup.close();
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
