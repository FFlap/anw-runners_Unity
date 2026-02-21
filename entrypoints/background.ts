import { answerQuestionFromContext, buildContextSnippets } from '@/lib/analysis';
import { simplifySelectionText } from '@/lib/simplify';
import { summarizeSelectionText } from '@/lib/summarize';
import {
  clearChatSession,
  clearTabContext,
  getApiKey,
  getChatSession,
  getColorBlindModeEnabled,
  getContext,
  getReport,
  hasApiKey,
  saveApiKey,
  saveChatSession,
  saveContext,
  saveReport,
} from '@/lib/storage';
import type {
  ChatMessage,
  ChatSession,
  EmbeddedPanelUpdate,
  ExtractionResult,
  MainArticleContent,
  RuntimeRequest,
  ScanKind,
  ScanReport,
  ScanState,
  ScanStatus,
  SourceSnippet,
  TabContext,
  TranscriptSegment,
  YouTubeTranscriptExtractionResult,
} from '@/lib/types';
import { fetchTranscript } from 'youtube-transcript-plus';
import { formatTimeLabel, normalizeTranscriptSegments, validateTranscriptSegments } from '@/lib/youtube-transcript';

const MAX_CONTEXT_CHARS = 90_000;
const statusByTab = new Map<number, ScanStatus>();
const reportByTab = new Map<number, ScanReport>();
const contextByTab = new Map<number, TabContext>();
const chatSessionByTab = new Map<number, ChatSession>();
const inFlightScans = new Map<number, Promise<void>>();
const inFlightQuestions = new Map<number, Promise<{ answer: ChatMessage; session: ChatSession }>>();

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

type MainArticleTabResponse =
  | { ok: true; article: MainArticleContent; url: string; title: string }
  | { ok: false; error?: string };

function parseYouTubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHosts = new Set([
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
    ]);
    if (!allowedHosts.has(hostname)) return undefined;
    return parsed.pathname === '/watch' ? (parsed.searchParams.get('v') ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

function isYouTubeWatchUrl(url: string): boolean {
  return parseYouTubeVideoId(url) !== undefined;
}

function createMessageId(prefix: 'user' | 'assistant'): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${entropy}`;
}

function normalizeUrlWithoutHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function contextMatchesTabUrl(context: TabContext | null, tabUrl: string): boolean {
  if (!context) return false;
  const contextVideoId = context.videoId ?? parseYouTubeVideoId(context.url);
  const tabVideoId = parseYouTubeVideoId(tabUrl);
  if (contextVideoId && tabVideoId) {
    return contextVideoId === tabVideoId;
  }
  return normalizeUrlWithoutHash(context.url) === normalizeUrlWithoutHash(tabUrl);
}

function buildReportFromContext(context: TabContext): ScanReport {
  return {
    tabId: context.tabId,
    url: context.url,
    title: context.title,
    scanKind: context.scanKind,
    videoId: context.videoId,
    transcript: context.transcript,
    scannedAt: context.scannedAt,
    truncated: context.truncated,
    contextChars: context.contextChars,
    snippetCount: context.snippets.length,
  };
}

async function getReportForTab(tabId: number): Promise<ScanReport | null> {
  return reportByTab.get(tabId) ?? (await getReport(tabId));
}

async function getContextForTab(tabId: number): Promise<TabContext | null> {
  return contextByTab.get(tabId) ?? (await getContext(tabId));
}

async function getChatSessionForTab(tabId: number): Promise<ChatSession | null> {
  return chatSessionByTab.get(tabId) ?? (await getChatSession(tabId));
}

function notifyEmbeddedPanel(tabId: number) {
  const status = statusByTab.get(tabId);
  if (!status) return;

  const payload: EmbeddedPanelUpdate = {
    type: 'EMBEDDED_PANEL_UPDATE',
    tabId,
    status,
    report: reportByTab.get(tabId) ?? null,
    session: chatSessionByTab.get(tabId) ?? null,
  };

  void Promise.resolve(ext.tabs.sendMessage(tabId, payload)).catch(() => {
    // No content script attached for this tab.
  });
}

function setStatus(tabId: number, state: ScanState, message: string, progress: number, errorCode?: string) {
  statusByTab.set(tabId, {
    tabId,
    state,
    message,
    progress,
    updatedAt: Date.now(),
    errorCode,
  });
  notifyEmbeddedPanel(tabId);
}

async function getActiveTabId(): Promise<number> {
  const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
  const activeUrl = activeTab?.url ?? '';
  if (activeTab?.id && /^https?:\/\//i.test(activeUrl)) {
    return activeTab.id;
  }

  const candidates = await ext.tabs.query({ currentWindow: true });
  const scannable = candidates
    .filter((tab) => tab.id && typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));

  if (!scannable[0]?.id) {
    throw new Error('No scannable HTTP(S) tab found. Open a website tab and try again.');
  }
  return scannable[0].id;
}

async function resolveScannableTabId(preferredTabId?: number): Promise<number> {
  if (preferredTabId) {
    try {
      const tab = await ext.tabs.get(preferredTabId);
      if (tab?.id && typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url)) {
        return tab.id;
      }
    } catch {
      // Fall back.
    }
  }
  return getActiveTabId();
}

async function resolveStatusTabId(preferred?: number, senderTabId?: number): Promise<number | undefined> {
  if (preferred) return preferred;
  if (senderTabId) return senderTabId;
  try {
    return await getActiveTabId();
  } catch {
    return undefined;
  }
}

function clearHighlightsInPage() {
  const marks = Array.from(document.querySelectorAll('mark[data-unity-source-id]'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }
}

function highlightAndScrollSnippetInPage(
  quote: string,
  sourceId: string,
  colorBlindMode = false,
): boolean {
  const styleId = 'unity-source-highlight-style';
  const marks = Array.from(document.querySelectorAll('mark[data-unity-source-id]'));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
    parent.normalize();
  }

  const highlightCss = colorBlindMode
    ? `
      mark[data-unity-source-id] {
        background: linear-gradient(
          90deg,
          rgba(0, 95, 204, 0.9) 0 0.32em,
          rgba(255, 236, 173, 0.86) 0,
          rgba(255, 248, 218, 0.94) 100%
        );
        border-left: 5px solid rgba(0, 74, 159, 0.98);
        border-bottom: 2px solid rgba(131, 95, 0, 0.95);
        color: inherit;
        border-radius: 0.22em;
        padding: 0 0.08em 0 0.18em;
        box-shadow: 0 0 0 2px rgba(0, 95, 204, 0.35);
      }
    `
    : `
      mark[data-unity-source-id] {
        background: linear-gradient(90deg, rgba(255,213,79,0.5), rgba(255,241,118,0.75));
        border-bottom: 2px solid rgba(181,137,0,0.9);
        color: inherit;
        border-radius: 0.25em;
        padding: 0 0.08em;
        box-shadow: 0 0 0 1px rgba(181, 137, 0, 0.35);
      }
    `;

  const existingStyle = document.getElementById(styleId) as HTMLStyleElement | null;
  if (existingStyle) {
    existingStyle.textContent = highlightCss;
  } else {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = highlightCss;
    document.documentElement.appendChild(style);
  }

  const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
  const cleanedQuote = quote
    .replace(/[…]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanedQuote.length < 6) {
    return false;
  }

  const normalizeForMatch = (input: string): { normalized: string; map: number[] } => {
    let normalized = '';
    const map: number[] = [];
    let previousWasSpace = true;

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (/\w/.test(char)) {
        normalized += char.toLowerCase();
        map.push(index);
        previousWasSpace = false;
        continue;
      }
      if (!previousWasSpace) {
        normalized += ' ';
        map.push(index);
        previousWasSpace = true;
      }
    }

    while (normalized.startsWith(' ')) {
      normalized = normalized.slice(1);
      map.shift();
    }
    while (normalized.endsWith(' ')) {
      normalized = normalized.slice(0, -1);
      map.pop();
    }

    return { normalized, map };
  };

  const variants = new Set<string>();
  variants.add(cleanedQuote);
  variants.add(cleanedQuote.replace(/[“”"'`]+/g, '').trim());
  const words = cleanedQuote.split(' ').filter(Boolean);
  if (words.length > 8) variants.add(words.slice(0, 8).join(' '));
  if (words.length > 12) variants.add(words.slice(0, 12).join(' '));
  if (words.length > 16) variants.add(words.slice(-12).join(' '));
  if (words.length > 20) {
    const middleStart = Math.max(0, Math.floor(words.length / 2) - 6);
    variants.add(words.slice(middleStart, middleStart + 12).join(' '));
  }
  if (words.length >= 6) {
    // Add sliding windows to survive inline-link and formatting node splits.
    const maxWindows = 48;
    let added = 0;
    for (let size = 8; size >= 5; size -= 1) {
      if (words.length < size) continue;
      for (let start = 0; start <= words.length - size; start += 1) {
        variants.add(words.slice(start, start + size).join(' '));
        added += 1;
        if (added >= maxWindows) break;
      }
      if (added >= maxWindows) break;
    }
  }

  const findTextMatch = (needle: string): { node: Text; start: number; end: number } | null => {
    const wantedRaw = needle.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!wantedRaw) return null;
    const wantedNormalized = normalizeForMatch(wantedRaw).normalized;
    if (!wantedNormalized) return null;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('mark[data-unity-source-id]')) return NodeFilter.FILTER_REJECT;
        const text = (node.textContent ?? '').trim();
        return text.length < 15 ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });

    let current = walker.nextNode() as Text | null;
    while (current) {
      const haystack = current.textContent ?? '';
      const haystackLower = haystack.toLowerCase();
      const exactStart = haystackLower.indexOf(wantedRaw);
      if (exactStart !== -1) {
        return { node: current, start: exactStart, end: exactStart + wantedRaw.length };
      }

      const normalizedHaystack = normalizeForMatch(haystack);
      const normalizedStart = normalizedHaystack.normalized.indexOf(wantedNormalized);
      if (normalizedStart !== -1) {
        const normalizedEnd = normalizedStart + wantedNormalized.length - 1;
        const start = normalizedHaystack.map[normalizedStart];
        const endAnchor = normalizedHaystack.map[normalizedEnd];
        if (Number.isFinite(start) && Number.isFinite(endAnchor)) {
          return {
            node: current,
            start,
            end: Math.min(haystack.length, endAnchor + 1),
          };
        }
      }

      current = walker.nextNode() as Text | null;
    }

    return null;
  };

  let match: { node: Text; start: number; end: number } | null = null;
  for (const variant of variants) {
    if (!variant || variant.length < 6) continue;
    match = findTextMatch(variant);
    if (match) break;
  }

  if (!match) return false;

  const { node, start, end } = match;
  const middle = node.splitText(start);
  const tail = middle.splitText(end - start);

  const mark = document.createElement('mark');
  mark.dataset.unitySourceId = sourceId;
  mark.textContent = middle.textContent;
  middle.parentNode?.replaceChild(mark, middle);

  if (!tail.textContent) {
    tail.remove();
  }

  mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  mark.style.outline = colorBlindMode
    ? '3px solid rgba(0,95,204,0.72)'
    : '2px solid rgba(181,137,0,0.7)';
  window.setTimeout(() => {
    mark.style.outline = '';
  }, 1800);

  return true;
}

function seekVideoToTimestampInPage(timestampSec: number): boolean {
  if (!Number.isFinite(timestampSec) || timestampSec < 0) return false;
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video) return false;

  video.currentTime = Math.max(0, timestampSec);
  video.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

function extractVisibleTextInPage(): ExtractionResult {
  const blockedTags = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEXTAREA',
    'SVG',
    'CANVAS',
    'IFRAME',
  ]);
  const blockedContainers = new Set(['NAV', 'FOOTER', 'ASIDE', 'FORM']);
  const containerNoisePattern =
    /\b(ad|ads|advert|sponsor|promo|outbrain|taboola|recirc|related|recommend|newsletter|subscribe|cookie|consent|banner|sidebar|comments?|footer|header|nav|menu)\b/i;
  const lineNoisePattern =
    /^(advertisement|sponsored|related|recommended|read more|sign up|subscribe|cookie settings|privacy policy|terms of use|terms of service)$/i;
  const minBlockLength = 20;

  const markerCache = new WeakMap<Element, boolean>();
  const linkDensityCache = new WeakMap<Element, boolean>();
  const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

  const isVisible = (element: Element | null): boolean => {
    if (!element) return false;
    if ((element as HTMLElement).hidden) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  };

  const hasNoiseMarker = (element: Element): boolean => {
    const cached = markerCache.get(element);
    if (typeof cached === 'boolean') return cached;

    const markerText = [
      element.id,
      typeof element.className === 'string' ? element.className : '',
      element.getAttribute('role') ?? '',
      element.getAttribute('aria-label') ?? '',
      element.getAttribute('data-testid') ?? '',
      element.getAttribute('data-component') ?? '',
      element.getAttribute('data-module') ?? '',
    ]
      .join(' ')
      .toLowerCase();

    const flagged =
      blockedContainers.has(element.tagName) ||
      markerText.includes('sponsored') ||
      markerText.includes('advertisement') ||
      containerNoisePattern.test(markerText);

    markerCache.set(element, flagged);
    return flagged;
  };

  const isLinkDense = (container: Element): boolean => {
    const cached = linkDensityCache.get(container);
    if (typeof cached === 'boolean') return cached;

    const totalText = normalizeText(container.textContent ?? '');
    if (totalText.length < 120) {
      linkDensityCache.set(container, false);
      return false;
    }

    const linkText = normalizeText(
      Array.from(container.querySelectorAll('a'))
        .map((anchor) => anchor.textContent ?? '')
        .join(' '),
    );

    const dense = linkText.length / Math.max(1, totalText.length) > 0.62;
    linkDensityCache.set(container, dense);
    return dense;
  };

  const shouldSkipNode = (node: Node): boolean => {
    const parent = (node as Text).parentElement;
    if (!parent) return true;
    if (blockedTags.has(parent.tagName)) return true;
    if (!isVisible(parent)) return true;

    let cursor: Element | null = parent;
    for (let depth = 0; cursor && depth < 7; depth += 1) {
      if (blockedTags.has(cursor.tagName)) return true;
      if (!isVisible(cursor)) return true;
      if (hasNoiseMarker(cursor)) return true;
      cursor = cursor.parentElement;
    }

    const normalized = normalizeText(node.textContent ?? '');
    if (normalized.length < minBlockLength) return true;
    if (normalized.length < 120 && lineNoisePattern.test(normalized.toLowerCase())) return true;

    const container = parent.closest('article,section,div,p,li,main') ?? parent;
    if (isLinkDense(container)) return true;

    return false;
  };

  const collectBlocks = (root: Element, maxBlocks = 1200): string[] => {
    const seen = new Set<string>();
    const blocks: string[] = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return shouldSkipNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      const text = normalizeText(node.textContent ?? '');
      const normalizedKey = text.toLowerCase();
      if (!seen.has(normalizedKey)) {
        blocks.push(text);
        seen.add(normalizedKey);
      }
      if (blocks.length >= maxBlocks) break;
      node = walker.nextNode();
    }

    return blocks;
  };

  const scoreBlocks = (blocks: string[]): number => {
    if (blocks.length === 0) return 0;
    const joined = blocks.join(' ');
    const punctuationCount = (joined.match(/[.!?]/g) ?? []).length;
    return joined.length + punctuationCount * 12 + blocks.length * 18;
  };

  const collectRootCandidates = (): Element[] => {
    const selectors = [
      '[itemprop="articleBody"]',
      'main article',
      '[role="main"] article',
      'article',
      '.article-body',
      '.article-content',
      '.story-body',
      '.post-content',
      '.entry-content',
      'main',
      '[role="main"]',
      '#main-content',
      '#content',
      '.main-content',
    ];

    const seen = new Set<Element>();
    const candidates: Element[] = [];

    const add = (element: Element | null) => {
      if (!element) return;
      if (!isVisible(element)) return;
      if (seen.has(element)) return;
      if (hasNoiseMarker(element)) return;
      seen.add(element);
      candidates.push(element);
    };

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        add(element as Element);
      }
    }

    add(document.querySelector('body'));
    return candidates;
  };

  const candidates = collectRootCandidates();
  let chosenRoot: Element = document.body;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreBlocks(collectBlocks(candidate, 320));
    if (score > bestScore) {
      bestScore = score;
      chosenRoot = candidate;
    }
  }

  let finalBlocks = collectBlocks(chosenRoot, 1600);
  const finalChars = finalBlocks.join('\n').length;
  if (finalChars < 650 && chosenRoot !== document.body) {
    finalBlocks = collectBlocks(document.body, 1600);
  }

  const text = finalBlocks.join('\n');
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || navigator.language || 'unknown',
    text,
    charCount: text.length,
  };
}

async function executeOnTab<T>(
  tabId: number,
  func: (...args: any[]) => T | Promise<T>,
  args: any[] = [],
  world: 'ISOLATED' | 'MAIN' = 'ISOLATED',
): Promise<T> {
  const [result] = await ext.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: world as any,
  });

  if (!result || typeof result.result === 'undefined') {
    throw new Error('Failed to execute script on the active page.');
  }

  return result.result as T;
}

async function extractMainArticleOnTab(tabId: number): Promise<{
  article: MainArticleContent;
  url: string;
  title: string;
}> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = (await ext.tabs.sendMessage(tabId, { type: 'ARTICLE_EXTRACT_MAIN' })) as
        | MainArticleTabResponse
        | undefined;

      if (!response) {
        throw new Error('No response from page while extracting article.');
      }

      if (!response.ok) {
        throw new Error(response.error || 'Could not isolate main article text on this page.');
      }

      const articleText = response.article?.text?.trim();
      if (!articleText) {
        throw new Error('Main article extraction returned empty text.');
      }

      return {
        article: response.article,
        url: response.url,
        title: response.title,
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 140 + attempt * 120));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Could not isolate main article text on this page.');
}

async function fetchTranscriptByVideoId(
  videoId: string,
  tabId?: number,
): Promise<YouTubeTranscriptExtractionResult> {
  const preferredLang = (globalThis.navigator?.language ?? 'en').split('-')[0];
  const languageAttempts = Array.from(new Set([preferredLang, 'en'])).filter(Boolean);

  const runTabFetch = async (params: {
    url: string;
    method: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
    lang?: string;
  }): Promise<Response> => {
    if (!tabId) {
      throw new Error('No YouTube tab context available for transcript fetch.');
    }

    const result = await executeOnTab<{
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      body: string;
    }>(
      tabId,
      async (request) => {
        const safeHeaders = new Headers(request.headers ?? {});
        safeHeaders.delete('User-Agent');
        if (request.lang && !safeHeaders.has('Accept-Language')) {
          safeHeaders.set('Accept-Language', request.lang);
        }
        const response = await fetch(request.url, {
          method: request.method ?? 'GET',
          headers: safeHeaders,
          body: request.method === 'POST' ? request.body : undefined,
          credentials: 'include',
          cache: 'no-store',
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(response.headers.entries()),
          body: await response.text(),
        };
      },
      [params],
      'MAIN',
    );

    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };

  const extensionFetch = async (params: {
    url: string;
    lang?: string;
    userAgent?: string;
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
  }): Promise<Response> => {
    const safeHeaders = new Headers(params.headers ?? {});
    safeHeaders.delete('User-Agent');
    if (params.lang && !safeHeaders.has('Accept-Language')) {
      safeHeaders.set('Accept-Language', params.lang);
    }

    return fetch(params.url, {
      method: params.method ?? 'GET',
      headers: safeHeaders,
      body: params.method === 'POST' ? params.body : undefined,
      credentials: 'include',
      cache: 'no-store',
    });
  };

  const transcriptFetchHook = async (params: {
    url: string;
    lang?: string;
    userAgent?: string;
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
  }): Promise<Response> => {
    const normalized = {
      ...params,
      method: params.method ?? 'GET',
    };
    if (tabId) {
      return runTabFetch(normalized);
    }
    return extensionFetch(normalized);
  };

  let lastError: string | undefined;
  for (const lang of [...languageAttempts, undefined]) {
    try {
      const rawSegments = await fetchTranscript(videoId, {
        ...(lang ? { lang } : {}),
        videoFetch: transcriptFetchHook,
        playerFetch: transcriptFetchHook,
        transcriptFetch: transcriptFetchHook,
      });

      const segments = normalizeTranscriptSegments(
        rawSegments.map((segment: { offset: number | string; text: string }) => ({
          startSec: Number(segment.offset),
          startLabel: formatTimeLabel(Number(segment.offset)),
          text: segment.text,
        })),
      );

      const validation = validateTranscriptSegments(segments);
      if (!validation.ok) {
        lastError = `Transcript validation failed (${validation.reason ?? 'invalid_segments'}).`;
        continue;
      }

      return {
        ok: true,
        source: 'youtube_api',
        segments,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown transcript error.';
    }
  }

  return {
    ok: false,
    reason: lastError ?? 'Transcript unavailable for this video.',
  };
}

async function runScan(tabId: number): Promise<void> {
  try {
    setStatus(tabId, 'extracting', 'Collecting page content from this tab...', 0.2);
    await executeOnTab(tabId, clearHighlightsInPage).catch(() => {});

    const extraction = await executeOnTab<ExtractionResult>(tabId, extractVisibleTextInPage);
    const scanKind: ScanKind = isYouTubeWatchUrl(extraction.url) ? 'youtube_video' : 'webpage';
    const videoId = parseYouTubeVideoId(extraction.url);
    let resolvedUrl = extraction.url;
    let resolvedTitle = extraction.title;

    let transcriptSegments: TranscriptSegment[] = [];
    let transcriptUnavailableReason: string | undefined;
    let mainArticle: MainArticleContent | undefined;
    let rawText = '';

    if (scanKind === 'youtube_video' && videoId) {
      setStatus(tabId, 'extracting', 'Loading YouTube transcript for grounded chat...', 0.45);
      const transcript = await fetchTranscriptByVideoId(videoId, tabId);
      if (transcript.ok && transcript.segments && transcript.segments.length > 0) {
        transcriptSegments = transcript.segments;
      } else {
        transcriptUnavailableReason = transcript.reason ?? 'Transcript unavailable.';
      }

      rawText = transcriptSegments.length > 0
        ? transcriptSegments.map((segment) => `[${segment.startLabel}] ${segment.text}`).join('\n')
        : extraction.text;

      if (!rawText || rawText.trim().length < 50) {
        throw new Error('The page did not provide enough visible text to analyze.');
      }
    } else {
      setStatus(tabId, 'extracting', 'Isolating main article text...', 0.45);
      const extractedArticle = await extractMainArticleOnTab(tabId);
      mainArticle = extractedArticle.article;
      resolvedUrl = extractedArticle.url || extraction.url;
      resolvedTitle = extractedArticle.title || extraction.title;
      rawText = extractedArticle.article.text;
    }

    const text = rawText.slice(0, MAX_CONTEXT_CHARS);
    const snippets = buildContextSnippets({ text, transcriptSegments });

    const context: TabContext = {
      tabId,
      url: resolvedUrl,
      title: resolvedTitle,
      scanKind,
      videoId,
      scannedAt: new Date().toISOString(),
      text,
      snippets,
      transcript:
        scanKind === 'youtube_video'
          ? {
            source: 'youtube_api',
            segments: transcriptSegments,
            ...(transcriptUnavailableReason ? { unavailableReason: transcriptUnavailableReason } : {}),
          }
          : undefined,
      ...(mainArticle ? { mainArticle } : {}),
      truncated: rawText.length > text.length,
      contextChars: text.length,
    };

    const report = buildReportFromContext(context);
    contextByTab.set(tabId, context);
    reportByTab.set(tabId, report);
    await saveContext(tabId, context);
    await saveReport(tabId, report);

    await clearChatSession(tabId);
    chatSessionByTab.delete(tabId);

    const suffix = context.snippets.length > 0
      ? `Context ready with ${context.snippets.length} source snippets.`
      : 'Context ready. Ask a question in Unity chat.';
    setStatus(tabId, 'done', suffix, 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scan error.';
    setStatus(tabId, 'error', message, 1, 'scan_failed');
  }
}

async function startScan(tabId: number): Promise<void> {
  const existing = inFlightScans.get(tabId);
  if (existing) {
    return existing;
  }

  const job = runScan(tabId).finally(() => {
    inFlightScans.delete(tabId);
  });

  inFlightScans.set(tabId, job);
  return job;
}

async function ensureFreshContext(tabId: number): Promise<TabContext> {
  const tab = await ext.tabs.get(tabId);
  const tabUrl = tab.url ?? '';
  if (!/^https?:\/\//i.test(tabUrl)) {
    throw new Error('Current tab is not an HTTP(S) page.');
  }

  const existing = await getContextForTab(tabId);
  if (contextMatchesTabUrl(existing, tabUrl)) {
    const needsMainArticleRefresh =
      existing?.scanKind === 'webpage' &&
      (!existing.mainArticle || !existing.mainArticle.text || !existing.mainArticle.text.trim());
    if (!needsMainArticleRefresh) {
      contextByTab.set(tabId, existing as TabContext);
      return existing as TabContext;
    }
    contextByTab.set(tabId, existing as TabContext);
  }

  setStatus(tabId, 'extracting', 'Preparing fresh context for this tab...', 0.1);
  await startScan(tabId);

  const refreshed = await getContextForTab(tabId);
  if (!refreshed || !contextMatchesTabUrl(refreshed, tabUrl)) {
    const status = statusByTab.get(tabId);
    if (status?.state === 'error' && status.message) {
      throw new Error(status.message);
    }
    throw new Error('Could not prepare a valid context for this tab.');
  }

  contextByTab.set(tabId, refreshed);
  return refreshed;
}

async function appendChatTurn(options: {
  tabId: number;
  context: TabContext;
  question: string;
  answer: string;
  sources: SourceSnippet[];
}): Promise<{ answer: ChatMessage; session: ChatSession }> {
  const { tabId, context, question, answer, sources } = options;

  const existing = (await getChatSessionForTab(tabId)) ?? {
    tabId,
    url: context.url,
    title: context.title,
    messages: [],
    updatedAt: context.scannedAt,
  };

  const userMessage: ChatMessage = {
    id: createMessageId('user'),
    role: 'user',
    text: question,
    createdAt: new Date().toISOString(),
  };

  const assistantMessage: ChatMessage = {
    id: createMessageId('assistant'),
    role: 'assistant',
    text: answer,
    sources,
    createdAt: new Date().toISOString(),
  };

  const nextMessages = [...existing.messages, userMessage, assistantMessage].slice(-60);
  const session: ChatSession = {
    tabId,
    url: context.url,
    title: context.title,
    messages: nextMessages,
    updatedAt: new Date().toISOString(),
  };

  chatSessionByTab.set(tabId, session);
  await saveChatSession(tabId, session);

  return { answer: assistantMessage, session };
}

async function askQuestion(options: {
  tabId: number;
  question: string;
}): Promise<{ answer: ChatMessage; session: ChatSession }> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('OpenRouter API key is required. Add it in Settings.');
  }

  const question = options.question.trim();
  if (!question) {
    throw new Error('Question cannot be empty.');
  }

  const context = await ensureFreshContext(options.tabId);

  setStatus(options.tabId, 'analyzing', 'Drafting grounded answer...', 0.7);

  const result = await answerQuestionFromContext({
    apiKey,
    question,
    context,
  });

  const turn = await appendChatTurn({
    tabId: options.tabId,
    context,
    question,
    answer: result.answer,
    sources: result.sources,
  });

  setStatus(options.tabId, 'done', 'Answer ready.', 1);
  notifyEmbeddedPanel(options.tabId);
  return turn;
}

async function jumpToSourceSnippet(tabId: number, source: SourceSnippet): Promise<boolean> {
  const context = await getContextForTab(tabId);
  const contextSource = context?.snippets.find((item) => item.id === source.id);
  const resolvedTimestampSec =
    typeof source.timestampSec === 'number' && Number.isFinite(source.timestampSec)
      ? source.timestampSec
      : contextSource?.timestampSec;

  const report = await getReportForTab(tabId);
  const canSeek =
    report?.scanKind === 'youtube_video' &&
    typeof resolvedTimestampSec === 'number' &&
    Number.isFinite(resolvedTimestampSec);

  if (canSeek) {
    return executeOnTab<boolean>(tabId, seekVideoToTimestampInPage, [resolvedTimestampSec as number]);
  }

  const quote = (contextSource?.text ?? source.text)?.trim();
  if (!quote) return false;
  const colorBlindModeEnabled = await getColorBlindModeEnabled().catch(() => false);
  return executeOnTab<boolean>(tabId, highlightAndScrollSnippetInPage, [quote, source.id, colorBlindModeEnabled]);
}

export default defineBackground(() => {
  ext.tabs.onRemoved.addListener((tabId) => {
    statusByTab.delete(tabId);
    reportByTab.delete(tabId);
    contextByTab.delete(tabId);
    chatSessionByTab.delete(tabId);
    inFlightScans.delete(tabId);
    inFlightQuestions.delete(tabId);
    void clearTabContext(tabId);
    void clearChatSession(tabId);
  });

  ext.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
    void (async () => {
      switch (message.type) {
        case 'SAVE_API_KEY': {
          const apiKey = message.apiKey.trim();
          if (!apiKey) {
            throw new Error('API key cannot be empty.');
          }
          await saveApiKey(apiKey);
          sendResponse({ ok: true, hasApiKey: true });
          return;
        }

        case 'GET_SETTINGS': {
          sendResponse({
            hasApiKey: await hasApiKey(),
          });
          return;
        }

        case 'SIMPLIFY_TEXT': {
          const apiKey = await getApiKey();
          if (!apiKey) {
            sendResponse({ ok: false, error: 'OpenRouter API key is required.' });
            return;
          }
          const level = message.level === 1 || message.level === 2 || message.level === 3 ? message.level : 2;
          const simplified = await simplifySelectionText({
            apiKey,
            text: message.text,
            level,
          });
          sendResponse({ ok: true, simplified });
          return;
        }

        case 'SUMMARIZE_TEXT': {
          const apiKey = await getApiKey();
          if (!apiKey) {
            sendResponse({ ok: false, error: 'OpenRouter API key is required.' });
            return;
          }
          const level = message.level === 1 || message.level === 2 || message.level === 3 ? message.level : 2;
          const summary = await summarizeSelectionText({
            apiKey,
            text: message.text,
            level,
          });
          sendResponse({ ok: true, summary });
          return;
        }

        case 'GET_EMBEDDED_PANEL_STATE': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveStatusTabId(undefined, senderTabId);
          if (!tabId) {
            sendResponse({
              tabId: null,
              status: { state: 'idle', progress: 0, message: 'No active tab.', updatedAt: Date.now() },
              report: null,
              session: null,
            });
            return;
          }

          const status = statusByTab.get(tabId) ?? {
            tabId,
            state: 'idle',
            progress: 0,
            message: 'Ready to scan this tab.',
            updatedAt: Date.now(),
          };

          const report = await getReportForTab(tabId);
          if (report) reportByTab.set(tabId, report);

          const session = await getChatSessionForTab(tabId);
          if (session) chatSessionByTab.set(tabId, session);

          sendResponse({
            tabId,
            status,
            report: report ?? null,
            session: session ?? null,
          });
          return;
        }

        case 'START_SCAN': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveScannableTabId(message.tabId ?? senderTabId);
          setStatus(tabId, 'extracting', 'Preparing tab context...', 0.05);
          void startScan(tabId);
          sendResponse({ ok: true, tabId });
          return;
        }

        case 'GET_SCAN_STATUS': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveStatusTabId(message.tabId, senderTabId);
          if (!tabId) {
            sendResponse({ state: 'idle', progress: 0, message: 'No active tab.' });
            return;
          }

          const status = statusByTab.get(tabId) ?? {
            tabId,
            state: 'idle',
            progress: 0,
            message: 'Ready to scan this tab.',
            updatedAt: Date.now(),
          };
          sendResponse(status);
          return;
        }

        case 'GET_REPORT': {
          const report = await getReportForTab(message.tabId);
          if (report) reportByTab.set(message.tabId, report);
          sendResponse({ report: report ?? null });
          return;
        }

        case 'GET_MAIN_ARTICLE': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveScannableTabId(message.tabId ?? senderTabId);
          const context = await ensureFreshContext(tabId);

          if (context.scanKind !== 'webpage') {
            sendResponse({ ok: false, error: 'Reader mode is available for webpages only.' });
            return;
          }

          if (!context.mainArticle || !context.mainArticle.text.trim()) {
            sendResponse({ ok: false, error: 'Could not isolate the main article on this page.' });
            return;
          }

          sendResponse({ ok: true, article: context.mainArticle, tabId });
          return;
        }

        case 'GET_TRANSCRIPT': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = message.tabId ?? senderTabId;
          const result = await fetchTranscriptByVideoId(message.videoId, tabId);
          sendResponse(result);
          return;
        }

        case 'GET_CHAT_SESSION': {
          const session = await getChatSessionForTab(message.tabId);
          if (session) chatSessionByTab.set(message.tabId, session);
          sendResponse({ session: session ?? null });
          return;
        }

        case 'CLEAR_CHAT_SESSION': {
          await clearChatSession(message.tabId);
          chatSessionByTab.delete(message.tabId);
          notifyEmbeddedPanel(message.tabId);
          sendResponse({ ok: true });
          return;
        }

        case 'ASK_CHAT_QUESTION': {
          const senderTabId = typeof sender.tab?.id === 'number' ? sender.tab.id : undefined;
          const tabId = await resolveScannableTabId(message.tabId ?? senderTabId);

          const existing = inFlightQuestions.get(tabId);
          if (existing) {
            const pending = await existing;
            sendResponse({ ok: true, answer: pending.answer, session: pending.session, tabId });
            return;
          }

          const job = askQuestion({
            tabId,
            question: message.question,
          }).finally(() => {
            inFlightQuestions.delete(tabId);
          });

          inFlightQuestions.set(tabId, job);
          const result = await job;
          sendResponse({ ok: true, answer: result.answer, session: result.session, tabId });
          return;
        }

        case 'JUMP_TO_SOURCE_SNIPPET': {
          const jumped = await jumpToSourceSnippet(message.tabId, message.source);
          sendResponse({ ok: jumped });
          return;
        }

        default: {
          sendResponse({ ok: false, message: 'Unsupported request.' });
          return;
        }
      }
    })().catch((error) => {
      const messageText = error instanceof Error ? error.message : 'Unknown background error.';
      sendResponse({ ok: false, error: messageText });
    });

    return true;
  });
});
