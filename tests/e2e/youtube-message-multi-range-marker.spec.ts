import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TARGET_URL = 'https://www.youtube.com/watch?v=unity-message-marker-fixture';

const YOUTUBE_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>YouTube Multi-Range Marker Fixture</title>
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
        position: relative;
      }
      video {
        display: block;
        width: 100%;
        min-height: 320px;
        background: #000;
      }
      .ytp-progress-bar-container {
        margin-top: 10px;
        height: 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.28);
        position: relative;
        overflow: hidden;
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
      <div class="html5-video-player" aria-label="Player">
        <video controls></video>
        <div class="ytp-progress-bar-container" aria-label="Timeline"></div>
      </div>
    </main>
    <aside id="secondary-inner" aria-label="Secondary rail"></aside>
  </body>
</html>`;

test('assistant message click highlights all source ranges on youtube timeline', async () => {
  test.setTimeout(240_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-youtube-message-ranges-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route('https://www.youtube.com/watch?v=unity-message-marker-fixture*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: YOUTUBE_FIXTURE_HTML,
    });
  });

  let page: any = null;
  let popup: any = null;
  const pageErrors: string[] = [];

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }

    const extensionId = new URL(serviceWorker.url()).host;

    page = await context.newPage();
    page.on('pageerror', (error: Error) => {
      pageErrors.push(`pageerror:${error.message}`);
    });
    page.on('console', (message: any) => {
      if (message.type() === 'error') {
        pageErrors.push(`console:${message.text()}`);
      }
    });
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const targetUrl = page.url();

    const seededMessages = [
      {
        id: 'user-1',
        role: 'user',
        text: 'Show me the first cluster.',
        createdAt: new Date(Date.now() - 30_000).toISOString(),
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        text: 'First cluster has three supporting ranges.',
        createdAt: new Date(Date.now() - 29_000).toISOString(),
        sources: [
          {
            id: 'src-1',
            text: 'First timeline segment.',
            score: 0.92,
            timestampSec: 20,
            timestampLabel: '0:20-0:34',
          },
          {
            id: 'src-2',
            text: 'Second point that should fallback to next transcript row.',
            score: 0.87,
            timestampSec: 45,
            timestampLabel: '0:45',
          },
          {
            id: 'src-3',
            text: 'Third timeline segment.',
            score: 0.84,
            timestampSec: 80,
            timestampLabel: '1:20-1:30',
          },
        ],
      },
      {
        id: 'user-2',
        role: 'user',
        text: 'Now show me the later cluster.',
        createdAt: new Date(Date.now() - 20_000).toISOString(),
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        text: 'Later cluster has two ranges.',
        createdAt: new Date(Date.now() - 19_000).toISOString(),
        sources: [
          {
            id: 'src-4',
            text: 'Fourth segment.',
            score: 0.83,
            timestampSec: 130,
            timestampLabel: '2:10-2:20',
          },
          {
            id: 'src-5',
            text: 'Single point with transcript-based end.',
            score: 0.81,
            timestampSec: 144,
            timestampLabel: '2:24',
          },
        ],
      },
    ] as const;

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    const resolvedTabId = await popup.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({
        currentWindow: true,
        url: ['https://www.youtube.com/*', 'http://www.youtube.com/*'],
      });
      const match = tabs.find((tab: { id?: number; url?: string }) =>
        typeof tab.url === 'string' && tab.url.includes('unity-message-marker-fixture'));
      return match?.id ?? null;
    });
    expect(resolvedTabId).not.toBeNull();
    const targetTabId = resolvedTabId as number;

    const persistChatSession = async (messages: any[]) => {
      const writer = await context.newPage();
      try {
        await writer.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
        await writer.evaluate(async ({ tabId, url, value }: { tabId: number; url: string; value: any[] }) => {
          const runtimeChrome = (globalThis as any).chrome;
          await new Promise<void>((resolve, reject) => {
            runtimeChrome.runtime.sendMessage(
              { type: 'CLEAR_CHAT_SESSION', tabId },
              (response: { ok?: boolean; error?: string }) => {
                const runtimeError = runtimeChrome.runtime.lastError;
                if (runtimeError) {
                  reject(new Error(runtimeError.message));
                  return;
                }
                if (!response?.ok) {
                  reject(new Error(response?.error || 'CLEAR_CHAT_SESSION failed.'));
                  return;
                }
                resolve();
              },
            );
          });

          await runtimeChrome.storage.local.set({
            [`chat_session_${tabId}`]: {
              tabId,
              url,
              title: 'Seeded YouTube Timeline Marker Session',
              updatedAt: new Date().toISOString(),
              messages: value,
            },
          });
        },
        { tabId: targetTabId, url: targetUrl, value: messages },
        );
      } finally {
        await writer.close().catch(() => {});
      }
    };

    await popup.evaluate(
      async ({
        tabId,
        url,
        messages,
      }: {
        tabId: number;
        url: string;
        messages: any[];
      }) => {
        const nowIso = new Date().toISOString();
        await (globalThis as any).chrome.storage.local.set({
          [`scan_report_${tabId}`]: {
            tabId,
            url,
            title: 'Seeded YouTube Timeline Marker Report',
            scanKind: 'youtube_video',
            videoId: 'unity-message-marker-fixture',
            transcript: {
              source: 'youtube_api',
              segments: [
                { id: 'seg-1', startSec: 0, startLabel: '0:00', text: 'Intro line.' },
                { id: 'seg-2', startSec: 20, startLabel: '0:20', text: 'First source range starts.' },
                { id: 'seg-3', startSec: 34, startLabel: '0:34', text: 'First source range ends.' },
                { id: 'seg-4', startSec: 45, startLabel: '0:45', text: 'Second source starts.' },
                { id: 'seg-5', startSec: 52, startLabel: '0:52', text: 'Second source fallback end.' },
                { id: 'seg-6', startSec: 80, startLabel: '1:20', text: 'Third source range starts.' },
                { id: 'seg-7', startSec: 90, startLabel: '1:30', text: 'Third source range ends.' },
                { id: 'seg-8', startSec: 130, startLabel: '2:10', text: 'Fourth source range starts.' },
                { id: 'seg-9', startSec: 140, startLabel: '2:20', text: 'Fourth source range ends.' },
                { id: 'seg-10', startSec: 144, startLabel: '2:24', text: 'Fifth source starts.' },
                { id: 'seg-11', startSec: 150, startLabel: '2:30', text: 'Fifth source fallback end.' },
              ],
            },
            scannedAt: nowIso,
            truncated: false,
            contextChars: 1100,
            snippetCount: 11,
          },
          [`chat_session_${tabId}`]: {
            tabId,
            url,
            title: 'Seeded YouTube Timeline Marker Session',
            updatedAt: nowIso,
            messages,
          },
        });
      },
      { tabId: targetTabId, url: targetUrl, messages: seededMessages },
    );

    await popup.close();
    popup = null;

    await page.reload({ waitUntil: 'domcontentloaded' });

    const panel = page.locator('#unity-youtube-chat-root');
    await expect(panel).toBeVisible({ timeout: 30_000 });

    const assistantMessages = panel.locator('[data-testid="unity-chat-message"][data-role="assistant"]');
    await expect(assistantMessages).toHaveCount(2, { timeout: 20_000 });
    const hasSourceRangeFlags = await assistantMessages.evaluateAll((nodes: Element[]) =>
      nodes.map((node: Element) => (node as HTMLElement).dataset.hasSourceRanges ?? 'false'),
    );
    expect(hasSourceRangeFlags.every((value: string) => value === 'true')).toBeTruthy();

    await assistantMessages.nth(0).locator('.unity-bubble-text').click();
    await expect(assistantMessages.nth(0)).toHaveAttribute('data-range-active', 'true');
    expect(pageErrors).toEqual([]);
    await expect
      .poll(async () => page.locator('[data-testid="unity-timeline-marker"]').count(), {
        timeout: 20_000,
      })
      .toBe(3);

    const firstRanges = await page
      .locator('[data-testid="unity-timeline-marker"]')
      .evaluateAll((nodes: Element[]) =>
        nodes
          .map((node: Element) => ({
            start: Number((node as HTMLElement).dataset.startSec ?? '0'),
            end: Number((node as HTMLElement).dataset.endSec ?? '0'),
          }))
          .sort((left: { start: number; end: number }, right: { start: number; end: number }) => left.start - right.start),
      );
    expect(firstRanges.length).toBe(3);
    for (const range of firstRanges) {
      expect(range.end).toBeGreaterThan(range.start);
    }
    expect(firstRanges[0].start).toBeGreaterThanOrEqual(19.5);
    expect(firstRanges[0].end).toBeGreaterThanOrEqual(33.5);
    expect(firstRanges[1].start).toBeGreaterThanOrEqual(44.5);
    expect(firstRanges[1].end).toBeGreaterThanOrEqual(51.5);
    expect(firstRanges[2].start).toBeGreaterThanOrEqual(79.5);
    expect(firstRanges[2].end).toBeGreaterThanOrEqual(89.5);

    await assistantMessages.nth(1).locator('.unity-bubble-text').click();
    await expect
      .poll(async () => page.locator('[data-testid="unity-timeline-marker"]').count(), {
        timeout: 20_000,
      })
      .toBe(2);

    const secondRanges = await page
      .locator('[data-testid="unity-timeline-marker"]')
      .evaluateAll((nodes: Element[]) =>
        nodes
          .map((node: Element) => ({
            start: Number((node as HTMLElement).dataset.startSec ?? '0'),
            end: Number((node as HTMLElement).dataset.endSec ?? '0'),
          }))
          .sort((left: { start: number; end: number }, right: { start: number; end: number }) => left.start - right.start),
      );
    expect(secondRanges.length).toBe(2);
    expect(secondRanges[0].start).toBeGreaterThanOrEqual(129.5);
    expect(secondRanges[0].end).toBeGreaterThanOrEqual(139.5);
    expect(secondRanges[1].start).toBeGreaterThanOrEqual(143.5);
    expect(secondRanges[1].end).toBeGreaterThanOrEqual(149.5);

    await assistantMessages.nth(0).locator('.unity-source').first().click();
    await page.waitForTimeout(400);

    const rangesAfterChipClick = await page
      .locator('[data-testid="unity-timeline-marker"]')
      .evaluateAll((nodes: Element[]) =>
        nodes
          .map((node: Element) => ({
            start: Number((node as HTMLElement).dataset.startSec ?? '0'),
            end: Number((node as HTMLElement).dataset.endSec ?? '0'),
          }))
          .sort((left: { start: number; end: number }, right: { start: number; end: number }) => left.start - right.start),
      );
    expect(rangesAfterChipClick.length).toBe(2);
    expect(rangesAfterChipClick[0].start).toBeGreaterThanOrEqual(129.5);

    await assistantMessages.nth(0).locator('.unity-bubble-text').click();
    await expect(assistantMessages.nth(0)).toHaveAttribute('data-range-active', 'true');
    await expect
      .poll(async () => page.locator('[data-testid="unity-timeline-marker"]').count(), {
        timeout: 20_000,
      })
      .toBe(3);

    const assistantThree = {
      id: 'assistant-3',
      role: 'assistant',
      text: 'Newest answer should auto-take timeline priority.',
      createdAt: new Date(Date.now() - 200).toISOString(),
      sources: [
        {
          id: 'src-6',
          text: 'Newest range source.',
          score: 0.9,
          timestampSec: 5,
          timestampLabel: '0:05-0:12',
        },
      ],
    };
    await persistChatSession([...seededMessages, assistantThree]);

    const assistantMessagesAfterNewest = panel.locator('[data-testid="unity-chat-message"][data-role="assistant"]');
    await expect
      .poll(async () => assistantMessagesAfterNewest.count(), {
        timeout: 30_000,
      })
      .toBe(3);
    await expect(assistantMessagesAfterNewest.nth(2)).toHaveAttribute('data-range-active', 'true', {
      timeout: 30_000,
    });
    await expect
      .poll(async () => page.locator('[data-testid="unity-timeline-marker"]').count(), {
        timeout: 30_000,
      })
      .toBe(1);

    const newestRanges = await page
      .locator('[data-testid="unity-timeline-marker"]')
      .evaluateAll((nodes: Element[]) =>
        nodes.map((node: Element) => ({
          start: Number((node as HTMLElement).dataset.startSec ?? '0'),
          end: Number((node as HTMLElement).dataset.endSec ?? '0'),
        })),
      );
    expect(newestRanges.length).toBe(1);
    expect(newestRanges[0].start).toBeGreaterThanOrEqual(4.5);
    expect(newestRanges[0].end).toBeGreaterThanOrEqual(11.5);

    const assistantFourNoTimestamp = {
      id: 'assistant-4',
      role: 'assistant',
      text: 'This newest answer has no timestamp references.',
      createdAt: new Date().toISOString(),
      sources: [
        {
          id: 'src-7',
          text: 'General source without timestamp metadata.',
          score: 0.76,
        },
      ],
    };
    await persistChatSession([...seededMessages, assistantThree, assistantFourNoTimestamp]);

    const assistantMessagesAfterNoTimestamp = panel.locator('[data-testid="unity-chat-message"][data-role="assistant"]');
    await expect
      .poll(async () => assistantMessagesAfterNoTimestamp.count(), {
        timeout: 30_000,
      })
      .toBe(4);
    await expect
      .poll(async () => page.locator('[data-testid="unity-timeline-marker"]').count(), {
        timeout: 30_000,
      })
      .toBe(0);

    const activeFlagsAfterNoTimestamp = await assistantMessagesAfterNoTimestamp.evaluateAll((nodes: Element[]) =>
      nodes.map((node: Element) => (node as HTMLElement).dataset.rangeActive ?? 'false'),
    );
    expect(activeFlagsAfterNoTimestamp.every((value: string) => value === 'false')).toBeTruthy();

    await page.evaluate(() => {
      history.pushState({}, '', 'https://www.youtube.com/');
    });
    await page.waitForTimeout(1_400);
    await expect(page.locator('[data-testid="unity-timeline-marker"]')).toHaveCount(0);
  } finally {
    await popup?.close().catch(() => {});
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
