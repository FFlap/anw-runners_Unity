import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TARGET_URL = 'https://en.wikipedia.org/wiki/Integral';
const QUESTION = 'what is the integral formula';

test('source jump works on wikipedia integral page', async () => {
  test.setTimeout(180_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-integral-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  // Deterministic OpenRouter response for this test.
  await context.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer: 'A common integral formula is the fundamental theorem form: integral from a to b of f(x) dx equals F(b) - F(a), where F is an antiderivative of f.',
              sources: [
                { id: 'w-1', quote: 'The notation f(x) and the antiderivative relation are used in defining integrals.', score: 0.93 },
                { id: 'w-2', quote: 'The definite integral from a to b is tied to area and antiderivatives.', score: 0.88 },
              ],
            }),
          },
        },
      ],
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  let popup = null as any;
  let articlePage = null as any;

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }

    const extensionId = new URL(serviceWorker.url()).host;

    articlePage = await context.newPage();
    await articlePage.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await articlePage.waitForLoadState('networkidle', { timeout: 40_000 }).catch(() => {});

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    // Ensure key requirement is satisfied.
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
            reject(new Error(response?.error || 'Failed to save key.'));
            return;
          }
          resolve();
        });
      });
    });

    const resolvedTabId = await popup.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({
        currentWindow: true,
        url: ['https://en.wikipedia.org/*', 'http://en.wikipedia.org/*'],
      });
      return tabs[0]?.id ?? null;
    });

    expect(resolvedTabId).not.toBeNull();

    await popup.evaluate(async (targetTabId: number) => {
      const runtime = (globalThis as any).chrome?.runtime;
      await new Promise<void>((resolve, reject) => {
        runtime.sendMessage({ type: 'START_SCAN', tabId: targetTabId }, (response: any) => {
          const error = runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || 'START_SCAN failed'));
            return;
          }
          resolve();
        });
      });
    }, resolvedTabId);

    await popup.evaluate(async (targetTabId: number) => {
      const runtime = (globalThis as any).chrome?.runtime;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const status = await new Promise<any>((resolve, reject) => {
          runtime.sendMessage({ type: 'GET_SCAN_STATUS', tabId: targetTabId }, (response: any) => {
            const error = runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve(response);
          });
        });

        const state = String(status?.state ?? '').toLowerCase();
        if (state === 'done') return;
        if (state === 'error') throw new Error(`Scan failed: ${status?.message ?? 'unknown error'}`);

        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      throw new Error('Timed out waiting for scan completion.');
    }, resolvedTabId);

    const askResponse = await popup.evaluate(
      async ({ targetTabId, question }: { targetTabId: number; question: string }) => {
        const runtime = (globalThis as any).chrome?.runtime;
        return await new Promise<any>((resolve, reject) => {
          runtime.sendMessage(
            { type: 'ASK_CHAT_QUESTION', tabId: targetTabId, question },
            (response: any) => {
              const error = runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(response);
            },
          );
        });
      },
      { targetTabId: resolvedTabId, question: QUESTION },
    );

    expect(askResponse?.ok).toBeTruthy();
    expect(Array.isArray(askResponse?.session?.messages)).toBeTruthy();

    const assistant = [...(askResponse.session.messages as any[])].reverse().find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(Array.isArray(assistant.sources) && assistant.sources.length > 0).toBeTruthy();

    const jumpResponse = await popup.evaluate(
      async ({ targetTabId, source }: { targetTabId: number; source: any }) => {
        const runtime = (globalThis as any).chrome?.runtime;
        return await new Promise<any>((resolve, reject) => {
          runtime.sendMessage(
            { type: 'JUMP_TO_SOURCE_SNIPPET', tabId: targetTabId, source },
            (response: any) => {
              const error = runtime.lastError;
              if (error) {
                reject(new Error(error.message));
                return;
              }
              resolve(response);
            },
          );
        });
      },
      { targetTabId: resolvedTabId, source: assistant.sources[0] },
    );

    expect(jumpResponse?.ok).toBeTruthy();

    await articlePage.waitForTimeout(700);
    const highlightCount = await articlePage.locator('mark[data-unity-source-id]').count();
    expect(highlightCount).toBeGreaterThan(0);
  } finally {
    await popup?.close().catch(() => {});
    await articlePage?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
