import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SUCCESS_URL = 'https://example.com/unity-reader-success';
const FAILURE_URL = 'https://example.com/unity-reader-failure';

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Reader Success Fixture</title>
  </head>
  <body>
    <nav>
      <a href="https://external.example/nav-1">Top Navigation Link</a>
      <a href="https://external.example/nav-2">Pricing</a>
      <a href="https://external.example/nav-3">Docs</a>
    </nav>
    <aside class="sidebar sponsor">
      Sidebar sponsor text that should be removed from reader output.
      <a href="https://external.example/sponsor">Buy now</a>
    </aside>
    <main>
      <article>
        <h1>How Integrals Connect Geometry and Change</h1>
        <p>
          The first core paragraph explains that integrals measure accumulation,
          not just area under a curve, and the same notation appears in physics,
          probability, and engineering contexts.
        </p>
        <p>
          A second paragraph states that students should track units while integrating
          because the integral combines a rate with a tiny change in the input quantity.
        </p>
        <blockquote>
          Integration is best understood as adding infinitely many tiny contributions.
        </blockquote>
        <p>
          The final paragraph emphasizes that antiderivatives connect definite integrals
          with endpoint evaluation through the fundamental theorem.
        </p>
        <h2>External links</h2>
        <ul>
          <li><a href="https://external.example/read-more">Read more</a></li>
          <li><a href="https://external.example/related">Related article</a></li>
        </ul>
      </article>
    </main>
    <footer>Footer utility links and legal text.</footer>
  </body>
</html>`;

const FAILURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Reader Failure Fixture</title>
  </head>
  <body>
    <nav>
      <a href="https://example.com/a">Home</a>
      <a href="https://example.com/b">Shop</a>
      <a href="https://example.com/c">Deals</a>
    </nav>
    <main>
      <section class="link-hub">
        <h2>Recommended</h2>
        <p>https://external.example/a</p>
        <p>https://external.example/b</p>
        <p>https://external.example/c</p>
        <ul>
          <li><a href="https://external.example/1">Story 1</a></li>
          <li><a href="https://external.example/2">Story 2</a></li>
          <li><a href="https://external.example/3">Story 3</a></li>
          <li><a href="https://external.example/4">Story 4</a></li>
          <li><a href="https://external.example/5">Story 5</a></li>
          <li><a href="https://external.example/6">Story 6</a></li>
        </ul>
      </section>
    </main>
    <footer>Contact and policy links.</footer>
  </body>
</html>`;

async function sendRuntimeMessage(popup: any, message: Record<string, unknown>): Promise<any> {
  return popup.evaluate(async (payload: Record<string, unknown>) => {
    const runtime = (globalThis as any).chrome?.runtime;
    return await new Promise<any>((resolve, reject) => {
      runtime.sendMessage(payload, (response: any) => {
        const error = runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }, message);
}

async function waitForScanTerminalState(popup: any, tabId: number): Promise<any> {
  return popup.evaluate(async (targetTabId: number) => {
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
      if (state === 'done' || state === 'error') {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    throw new Error('Timed out waiting for scan completion.');
  }, tabId);
}

test('reader tab isolates main article and scan context uses isolated text', async () => {
  test.setTimeout(180_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-reader-success-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route(SUCCESS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: SUCCESS_HTML,
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
    await articlePage.goto(SUCCESS_URL, { waitUntil: 'domcontentloaded' });

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    await popup.getByRole('tab', { name: 'Reader' }).click();
    await popup.getByRole('button', { name: 'Clean Page' }).click();
    await expect(popup.locator('.reader-state-line')).toContainText('Reader mode is active');

    const applied = await articlePage.evaluate(() => {
      const nav = document.querySelector('nav');
      const readerRoot = document.getElementById('unity-page-reader-root');
      return {
        modeAttr: document.body?.getAttribute('data-unity-reader-mode') ?? null,
        hasRoot: Boolean(readerRoot),
        navHidden: nav ? window.getComputedStyle(nav).display === 'none' : false,
        rootText: readerRoot?.textContent ?? '',
      };
    });
    expect(applied.modeAttr).toBe('true');
    expect(applied.hasRoot).toBeTruthy();
    expect(applied.navHidden).toBeTruthy();
    expect(applied.rootText).toContain('The first core paragraph explains that integrals measure accumulation');
    expect(applied.rootText).not.toContain('Sidebar sponsor text that should be removed from reader output.');

    await popup.getByRole('button', { name: 'Restore Page' }).click();
    await expect(popup.locator('.reader-state-line')).toContainText('inactive');

    const restored = await articlePage.evaluate(() => {
      const nav = document.querySelector('nav');
      return {
        modeAttr: document.body?.getAttribute('data-unity-reader-mode') ?? null,
        hasRoot: Boolean(document.getElementById('unity-page-reader-root')),
        navDisplay: nav ? window.getComputedStyle(nav).display : null,
      };
    });
    expect(restored.modeAttr).toBeNull();
    expect(restored.hasRoot).toBeFalsy();
    expect(restored.navDisplay).not.toBe('none');

    const tabId = await popup.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({
        currentWindow: true,
        url: ['https://example.com/*', 'http://example.com/*'],
      });
      const match = tabs.find((tab: any) => String(tab.url ?? '').includes('unity-reader-success'));
      return match?.id ?? null;
    });
    expect(tabId).not.toBeNull();

    const scanStart = await sendRuntimeMessage(popup, { type: 'START_SCAN', tabId });
    expect(scanStart?.ok).toBeTruthy();

    const scanStatus = await waitForScanTerminalState(popup, tabId);
    expect(String(scanStatus?.state ?? '').toLowerCase()).toBe('done');

    const storedContext = await popup.evaluate(async (targetTabId: number) => {
      const key = `scan_context_${targetTabId}`;
      const stored = await (globalThis as any).chrome.storage.local.get(key);
      return stored[key] ?? null;
    }, tabId);

    expect(storedContext).toBeTruthy();
    expect(storedContext?.mainArticle?.text).toContain(
      'The first core paragraph explains that integrals measure accumulation',
    );
    expect(storedContext?.mainArticle?.text).not.toContain('Sidebar sponsor text that should be removed');
    expect(storedContext?.text).not.toContain('Related article');
  } finally {
    await popup?.close().catch(() => {});
    await articlePage?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});

test('reader and scan fail strictly when no main article is isolatable', async () => {
  test.setTimeout(180_000);

  const extensionPath = path.resolve(process.cwd(), '.output/chrome-mv3');
  await fs.access(extensionPath);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'unity-e2e-reader-failure-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env.PW_HEADLESS !== '0',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  await context.route(FAILURE_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: FAILURE_HTML,
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
    await page.goto(FAILURE_URL, { waitUntil: 'domcontentloaded' });

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

    await popup.getByRole('tab', { name: 'Reader' }).click();
    await popup.getByRole('button', { name: 'Clean Page' }).click();
    await expect(popup.locator('.reader-empty-card')).toContainText(/main article/i);

    const failedApplyState = await page.evaluate(() => ({
      modeAttr: document.body?.getAttribute('data-unity-reader-mode') ?? null,
      hasRoot: Boolean(document.getElementById('unity-page-reader-root')),
    }));
    expect(failedApplyState.modeAttr).toBeNull();
    expect(failedApplyState.hasRoot).toBeFalsy();

    const tabId = await popup.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({
        currentWindow: true,
        url: ['https://example.com/*', 'http://example.com/*'],
      });
      const match = tabs.find((tab: any) => String(tab.url ?? '').includes('unity-reader-failure'));
      return match?.id ?? null;
    });
    expect(tabId).not.toBeNull();

    const scanStart = await sendRuntimeMessage(popup, { type: 'START_SCAN', tabId });
    expect(scanStart?.ok).toBeTruthy();

    const scanStatus = await waitForScanTerminalState(popup, tabId);
    expect(String(scanStatus?.state ?? '').toLowerCase()).toBe('error');
    expect(String(scanStatus?.message ?? '').toLowerCase()).toContain('main article');
  } finally {
    await popup?.close().catch(() => {});
    await page?.close().catch(() => {});
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
