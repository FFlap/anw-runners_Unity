import type {
  ChatSession,
  EmbeddedPanelUpdate,
  ScanReport,
  ScanStatus,
  SourceSnippet,
  TranscriptSegment,
} from '@/lib/types';
import {
  DICTATION_SILENCE_TIMEOUT_MS,
  dictationErrorMessage,
  getDictationRecognitionCtor,
  insertDictationText,
  type DictationRecognitionLike,
} from '@/lib/dictation';
import { COLOR_BLIND_MODE_STORAGE_KEY } from '@/lib/storage';

const PANEL_ID = 'unity-youtube-chat-root';
const STYLE_ID = 'unity-youtube-chat-style';
const URL_CHECK_INTERVAL_MS = 900;
const POLL_INTERVAL_MS = 1700;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

interface EmbeddedStateResponse {
  tabId: number | null;
  status: ScanStatus;
  report: ScanReport | null;
  session: ChatSession | null;
}

function isWatchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHosts = new Set([
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
    ]);
    return allowedHosts.has(hostname) && parsed.pathname === '/watch' && parsed.searchParams.has('v');
  } catch {
    return false;
  }
}

function getVideoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const allowedHosts = new Set([
      'www.youtube.com',
      'youtube.com',
      'm.youtube.com',
      'music.youtube.com',
    ]);
    if (!allowedHosts.has(hostname)) return null;
    if (parsed.pathname !== '/watch') return null;
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

function sourceLabel(source: SourceSnippet, index: number): string {
  if (source.timestampLabel) return `Jump ${source.timestampLabel}`;
  return `Source ${index + 1}`;
}

function seekVideo(seconds: number): boolean {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  const video = document.querySelector<HTMLVideoElement>('video');
  if (!video) return false;
  video.currentTime = Math.max(0, seconds);
  return true;
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function createRefreshIcon(spinning: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('unity-btn-icon');
  if (spinning) {
    svg.classList.add('unity-spin');
  }

  const pathA = document.createElementNS(ns, 'path');
  pathA.setAttribute('d', 'M3 2v6h6');
  const pathB = document.createElementNS(ns, 'path');
  pathB.setAttribute('d', 'M21 12A9 9 0 0 0 6 5.3L3 8');
  const pathC = document.createElementNS(ns, 'path');
  pathC.setAttribute('d', 'M21 22v-6h-6');
  const pathD = document.createElementNS(ns, 'path');
  pathD.setAttribute('d', 'M3 12a9 9 0 0 0 15 6.7L21 16');

  svg.append(pathA, pathB, pathC, pathD);
  return svg;
}

function createMicIcon(active: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('unity-btn-icon');

  const body = document.createElementNS(ns, 'rect');
  body.setAttribute('x', '9');
  body.setAttribute('y', '2');
  body.setAttribute('width', '6');
  body.setAttribute('height', '11');
  body.setAttribute('rx', '3');

  const stem = document.createElementNS(ns, 'path');
  stem.setAttribute('d', 'M12 19v3');

  const base = document.createElementNS(ns, 'path');
  base.setAttribute('d', 'M8 22h8');

  const arc = document.createElementNS(ns, 'path');
  arc.setAttribute('d', 'M19 10v2a7 7 0 0 1-14 0v-2');

  svg.append(body, stem, base, arc);

  if (active) {
    const slash = document.createElementNS(ns, 'path');
    slash.setAttribute('d', 'M4 4l16 16');
    svg.appendChild(slash);
  }

  return svg;
}

async function sendRuntimeMessageWithRetry<TRequest, TResponse>(
  message: TRequest,
  attempts = 6,
): Promise<TResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return (await ext.runtime.sendMessage(message)) as TResponse;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 120 + attempt * 120));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Runtime message failed after retries.');
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      --unity-panel-border: rgba(214, 190, 157, 0.7);
      --unity-panel-bg-start: #fff8ee;
      --unity-panel-bg-end: #f6ead7;
      --unity-panel-text: #2b241d;
      --unity-panel-shadow: rgba(52, 34, 18, 0.12);
      --unity-panel-head-bg: rgba(255, 252, 247, 0.82);
      --unity-panel-muted: #6f6152;
      --unity-panel-btn-border: rgba(196, 167, 130, 0.9);
      --unity-panel-btn-bg: #fffdf9;
      --unity-panel-btn-text: #3b3026;
      --unity-panel-btn-hover: #b86a2e;
      --unity-panel-scroll-thumb: rgba(190, 160, 126, 0.7);
      --unity-panel-empty-border: rgba(202, 177, 145, 0.8);
      --unity-panel-empty-text: #7a6b5b;
      --unity-panel-bubble-border: rgba(214, 190, 157, 0.8);
      --unity-panel-bubble-user-bg: #d8ecf7;
      --unity-panel-bubble-user-border: rgba(136, 181, 205, 0.95);
      --unity-panel-bubble-assistant-bg: #fff4df;
      --unity-panel-compose-bg: #fffefb;
      --unity-panel-error: #b52f2f;
      --unity-transcript-border: rgba(214, 190, 157, 0.85);
      --unity-transcript-bg: rgba(255, 253, 248, 0.9);
      --unity-transcript-row-border: rgba(214, 190, 157, 0.4);
      --unity-transcript-row-bg: #fff;
      --unity-transcript-current-border: rgba(184, 106, 46, 0.95);
      --unity-transcript-current-shadow: rgba(184, 106, 46, 0.22);
      --unity-transcript-current-bg: #fff8ea;
      --unity-transcript-btn-bg: #fffefb;
      --unity-transcript-btn-border: rgba(196, 167, 130, 0.9);
      --unity-transcript-btn-text: #3b3026;
      --unity-transcript-text: #3d3024;
      --unity-focus-ring: transparent;
      --unity-focus-ring-shadow: transparent;
      --unity-transcript-stripe: transparent;
      --unity-transcript-current-stripe: transparent;
      --unity-transcript-current-outline: transparent;
      width: 100%;
      margin-bottom: 16px;
      border-radius: 12px;
      border: 1px solid var(--unity-panel-border);
      background: linear-gradient(180deg, var(--unity-panel-bg-start) 0%, var(--unity-panel-bg-end) 100%);
      color: var(--unity-panel-text);
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 10px 24px var(--unity-panel-shadow);
      overflow: hidden;
      z-index: 9998;
    }
    #${PANEL_ID}[data-color-blind-mode="true"] {
      --unity-panel-border: #77879b;
      --unity-panel-bg-start: #fcfdff;
      --unity-panel-bg-end: #ecf2f8;
      --unity-panel-text: #132132;
      --unity-panel-shadow: rgba(12, 32, 56, 0.18);
      --unity-panel-head-bg: #f6faff;
      --unity-panel-muted: #304255;
      --unity-panel-btn-border: #6e839a;
      --unity-panel-btn-bg: #fbfdff;
      --unity-panel-btn-text: #1a2f46;
      --unity-panel-btn-hover: #075ead;
      --unity-panel-scroll-thumb: rgba(73, 101, 133, 0.65);
      --unity-panel-empty-border: #8ea2b9;
      --unity-panel-empty-text: #384d64;
      --unity-panel-bubble-border: #7d92a6;
      --unity-panel-bubble-user-bg: #e5f0fa;
      --unity-panel-bubble-user-border: #628ab3;
      --unity-panel-bubble-assistant-bg: #fff5d8;
      --unity-panel-compose-bg: #ffffff;
      --unity-panel-error: #8f1f2f;
      --unity-transcript-border: #6f86a1;
      --unity-transcript-bg: #f8fbff;
      --unity-transcript-row-border: #93a5ba;
      --unity-transcript-row-bg: #ffffff;
      --unity-transcript-current-border: #0b5da8;
      --unity-transcript-current-shadow: rgba(11, 93, 168, 0.32);
      --unity-transcript-current-bg: #e7f0fb;
      --unity-transcript-btn-bg: #ffffff;
      --unity-transcript-btn-border: #6e839a;
      --unity-transcript-btn-text: #1d344b;
      --unity-transcript-text: #16283d;
      --unity-focus-ring: #005fcc;
      --unity-focus-ring-shadow: rgba(0, 95, 204, 0.28);
      --unity-transcript-stripe: #8ea2b9;
      --unity-transcript-current-stripe: #005fcc;
      --unity-transcript-current-outline: rgba(0, 95, 204, 0.3);
    }
    #${PANEL_ID}[data-unity-floating="true"] {
      position: fixed;
      top: 76px;
      right: 12px;
      width: min(380px, calc(100vw - 24px));
      max-height: 78vh;
      overflow: auto;
      margin: 0;
      z-index: 2147483000;
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID} .unity-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--unity-panel-border);
      background: var(--unity-panel-head-bg);
    }
    #${PANEL_ID} .unity-title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    #${PANEL_ID} .unity-status {
      margin: 2px 0 0;
      font-size: 11px;
      color: var(--unity-panel-muted);
    }
    #${PANEL_ID} .unity-head-actions {
      display: flex;
      gap: 6px;
    }
    #${PANEL_ID} .unity-btn {
      border: 1px solid var(--unity-panel-btn-border);
      background: var(--unity-panel-btn-bg);
      color: var(--unity-panel-btn-text);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    #${PANEL_ID} .unity-btn--icon {
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #${PANEL_ID} .unity-btn-icon {
      width: 14px;
      height: 14px;
      display: block;
    }
    #${PANEL_ID} .unity-spin {
      animation: unity-spin 0.9s linear infinite;
    }
    #${PANEL_ID} .unity-btn:hover:not(:disabled) {
      border-color: var(--unity-panel-btn-hover);
      color: var(--unity-panel-btn-hover);
    }
    #${PANEL_ID} .unity-btn:disabled { opacity: 0.5; cursor: default; }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-btn:hover:not(:disabled),
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-source:hover:not(:disabled),
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-ts-btn:hover:not(:disabled) {
      border-width: 2px;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    @keyframes unity-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    #${PANEL_ID} .unity-body {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #${PANEL_ID} .unity-note {
      margin: 0;
      font-size: 11px;
      color: var(--unity-panel-muted);
    }
    #${PANEL_ID} .unity-chat {
      max-height: 260px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-right: 2px;
    }
    #${PANEL_ID} .unity-chat::-webkit-scrollbar,
    #${PANEL_ID} .unity-transcript::-webkit-scrollbar { width: 8px; }
    #${PANEL_ID} .unity-chat::-webkit-scrollbar-thumb,
    #${PANEL_ID} .unity-transcript::-webkit-scrollbar-thumb {
      background: var(--unity-panel-scroll-thumb);
      border-radius: 999px;
    }
    #${PANEL_ID} .unity-empty {
      border: 1px dashed var(--unity-panel-empty-border);
      border-radius: 10px;
      padding: 10px;
      color: var(--unity-panel-empty-text);
      font-size: 12px;
      margin: 0;
    }
    #${PANEL_ID} .unity-bubble {
      border-radius: 10px;
      border: 1px solid var(--unity-panel-bubble-border);
      padding: 8px 9px;
      font-size: 12px;
      line-height: 1.42;
    }
    #${PANEL_ID} .unity-bubble--user {
      background: var(--unity-panel-bubble-user-bg);
      border-color: var(--unity-panel-bubble-user-border);
    }
    #${PANEL_ID} .unity-bubble--assistant {
      background: var(--unity-panel-bubble-assistant-bg);
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-bubble--user,
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-bubble--assistant {
      border-left: 4px solid;
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-bubble--user {
      border-left-color: #0d4d8a;
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-bubble--assistant {
      border-left-color: #8a6a00;
    }
    #${PANEL_ID} .unity-bubble-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 10px;
      color: var(--unity-panel-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    #${PANEL_ID} .unity-source-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 7px;
    }
    #${PANEL_ID} .unity-source {
      border: 1px solid var(--unity-panel-btn-border);
      border-radius: 999px;
      background: var(--unity-panel-btn-bg);
      color: var(--unity-panel-btn-text);
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    #${PANEL_ID} .unity-source:hover {
      border-color: var(--unity-panel-btn-hover);
      color: var(--unity-panel-btn-hover);
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-source {
      border-width: 2px;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #${PANEL_ID} .unity-compose textarea {
      width: 100%;
      min-height: 56px;
      border-radius: 10px;
      border: 1px solid var(--unity-panel-btn-border);
      background: var(--unity-panel-compose-bg);
      color: var(--unity-panel-text);
      font-size: 12px;
      line-height: 1.4;
      padding: 8px;
      resize: vertical;
      font-family: inherit;
    }
    #${PANEL_ID} .unity-compose-actions {
      margin-top: 7px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
    }
    #${PANEL_ID} .unity-btn--dictation {
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #${PANEL_ID} .unity-btn--dictation[data-active="true"] {
      border-color: #b86a2e;
      background: #fbe9d3;
      color: #9d4f16;
    }
    #${PANEL_ID} .unity-error {
      margin: 0;
      font-size: 11px;
      color: var(--unity-panel-error);
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-error {
      border-left: 4px solid var(--unity-panel-error);
      background: rgba(143, 31, 47, 0.09);
      padding: 6px 8px;
      border-radius: 8px;
      font-weight: 600;
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-error::before {
      content: "Error: ";
    }
    #${PANEL_ID} .unity-transcript-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-top: 2px;
    }
    #${PANEL_ID} .unity-transcript-title {
      margin: 0;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--unity-panel-btn-text);
    }
    #${PANEL_ID} .unity-transcript-meta {
      margin: 0;
      font-size: 11px;
      color: var(--unity-panel-muted);
    }
    #${PANEL_ID} .unity-transcript {
      max-height: 220px;
      overflow: auto;
      border: 1px solid var(--unity-transcript-border);
      border-radius: 10px;
      background: var(--unity-transcript-bg);
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #${PANEL_ID} .unity-transcript-row {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 8px;
      align-items: start;
      border: 1px solid var(--unity-transcript-row-border);
      border-radius: 8px;
      padding: 6px;
      background: var(--unity-transcript-row-bg);
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-transcript-row {
      border-left: 5px solid var(--unity-transcript-stripe);
      padding-left: 8px;
    }
    #${PANEL_ID} .unity-transcript-row[data-current="true"] {
      border-color: var(--unity-transcript-current-border);
      box-shadow: 0 0 0 1px var(--unity-transcript-current-shadow);
      background: var(--unity-transcript-current-bg);
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-transcript-row[data-current="true"] {
      border-left-color: var(--unity-transcript-current-stripe);
      outline: 3px solid var(--unity-transcript-current-outline);
      outline-offset: 1px;
    }
    #${PANEL_ID} .unity-ts-btn {
      border: 1px solid var(--unity-transcript-btn-border);
      background: var(--unity-transcript-btn-bg);
      color: var(--unity-transcript-btn-text);
      border-radius: 7px;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 6px;
      cursor: pointer;
      white-space: nowrap;
      min-width: 52px;
      text-align: center;
    }
    #${PANEL_ID} .unity-ts-btn:hover {
      border-color: var(--unity-panel-btn-hover);
      color: var(--unity-panel-btn-hover);
    }
    #${PANEL_ID} .unity-transcript-text {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--unity-transcript-text);
      cursor: pointer;
    }
    #${PANEL_ID}[data-color-blind-mode="true"] .unity-transcript-row[data-current="true"] .unity-transcript-text::before {
      content: "Now: ";
      font-weight: 700;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #${PANEL_ID}[data-color-blind-mode="true"] :is(button, textarea):focus-visible {
      outline: 3px solid var(--unity-focus-ring);
      outline-offset: 2px;
      box-shadow: 0 0 0 3px var(--unity-focus-ring-shadow);
    }
  `;
  document.documentElement.appendChild(style);
}

function findPanelHost(): HTMLElement | null {
  const isHostVisible = (node: HTMLElement): boolean => {
    if (!node.isConnected) return false;
    if (node.closest('[hidden]')) return false;

    const style = window.getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;

    return true;
  };

  const rightRailTargets = [
    '#secondary-inner',
    '#secondary #related',
    '#related',
    '#secondary',
    'ytd-watch-next-secondary-results-renderer',
    'ytd-watch-flexy #columns',
  ];

  for (const selector of rightRailTargets) {
    const match = document.querySelector<HTMLElement>(selector);
    if (match && isHostVisible(match)) return match;
  }

  const below = document.querySelector<HTMLElement>('#below');
  if (below && isHostVisible(below)) return below;

  // Fallback for layout variants where right-rail hosts are missing/delayed.
  return document.body;
}

function createPanelRoot(): HTMLElement {
  const root = document.createElement('section');
  root.id = PANEL_ID;
  root.setAttribute('data-testid', 'unity-youtube-panel');
  return root;
}

function statusFingerprint(value: ScanStatus): string {
  return [
    value.state,
    Math.round(value.progress * 1000),
    value.message,
    value.errorCode ?? '',
  ].join('|');
}

function reportFingerprint(value: ScanReport | null): string {
  if (!value) return 'null';
  return [
    value.scannedAt,
    value.scanKind,
    value.snippetCount,
    value.transcript?.segments.length ?? 0,
    value.transcript?.unavailableReason ?? '',
  ].join('|');
}

function sessionFingerprint(value: ChatSession | null): string {
  if (!value) return 'null';
  const last = value.messages[value.messages.length - 1];
  return [value.updatedAt, value.messages.length, last?.id ?? ''].join('|');
}

export default defineContentScript({
  matches: [
    '*://www.youtube.com/*',
    '*://youtube.com/*',
    '*://m.youtube.com/*',
    '*://music.youtube.com/*',
  ],
  main() {
    installStyles();

    let currentUrl = location.href;
    let panelRoot: HTMLElement | null = null;

    let tabId: number | null = null;
    let status: ScanStatus = {
      state: 'idle',
      progress: 0,
      message: 'Ready to scan this video.',
      updatedAt: Date.now(),
    };
    let report: ScanReport | null = null;
    let session: ChatSession | null = null;
    let question = '';
    let isAsking = false;
    let localError: string | null = null;
    let dictationSupported = false;
    let dictationActive = false;
    let dictation: DictationRecognitionLike | null = null;
    let dictationSilenceTimer: number | null = null;
    let pendingDictationTranscript = '';

    let transcriptSegments: TranscriptSegment[] = [];
    let transcriptLoading = false;
    let transcriptResolved = false;
    let transcriptError: string | null = null;
    let activeTranscriptSegmentId: string | null = null;
    let watchedVideo: HTMLVideoElement | null = null;
    let colorBlindModeEnabled = false;

    let composerFocused = false;
    let composerSelectionStart = 0;
    let composerSelectionEnd = 0;
    let lastRenderedFingerprint = '';

    const applyColorBlindModeAttribute = () => {
      if (!panelRoot) return;
      panelRoot.setAttribute('data-color-blind-mode', String(colorBlindModeEnabled));
    };

    const getDisplayTranscriptSegments = (): TranscriptSegment[] => {
      const reported = report?.transcript?.segments ?? [];
      return reported.length > 0 ? reported : transcriptSegments;
    };

    const viewFingerprint = (): string => [
      statusFingerprint(status),
      reportFingerprint(report),
      sessionFingerprint(session),
      transcriptSegments.length,
      transcriptLoading ? '1' : '0',
      transcriptResolved ? '1' : '0',
      transcriptError ?? '',
      isAsking ? '1' : '0',
      dictationSupported ? '1' : '0',
      dictationActive ? '1' : '0',
      localError ?? '',
      question,
      colorBlindModeEnabled ? '1' : '0',
    ].join('|');

    const ensurePanelMounted = () => {
      if (!isWatchUrl(location.href)) {
        if (dictationActive) {
          stopDictation();
        }
        panelRoot?.remove();
        panelRoot = null;
        return;
      }

      const host = findPanelHost();
      if (!host) return;

      if (!panelRoot || !panelRoot.isConnected) {
        panelRoot = createPanelRoot();
      }
      applyColorBlindModeAttribute();

      const floatingMode = host === document.body;
      if (floatingMode) {
        panelRoot.setAttribute('data-unity-floating', 'true');
        if (!panelRoot.isConnected || panelRoot.parentElement !== document.body) {
          document.body.appendChild(panelRoot);
        }
        return;
      }

      panelRoot.removeAttribute('data-unity-floating');
      if (!panelRoot.isConnected || panelRoot.parentElement !== host || host.firstElementChild !== panelRoot) {
        host.prepend(panelRoot);
      }
    };

    const resolveActiveSegmentId = (
      segments: TranscriptSegment[],
      currentTimeSec: number,
    ): string | null => {
      if (segments.length === 0 || !Number.isFinite(currentTimeSec)) return null;
      let active = segments[0];
      for (const segment of segments) {
        if (segment.startSec <= currentTimeSec + 0.1) {
          active = segment;
        } else {
          break;
        }
      }
      return active.id;
    };

    const updateCurrentTranscriptHighlight = () => {
      if (!panelRoot) return;
      const transcriptWrap = panelRoot.querySelector<HTMLElement>('[data-testid="unity-transcript-list"]');
      if (!transcriptWrap) return;

      const video = document.querySelector<HTMLVideoElement>('video');
      if (!video) return;

      const segments = getDisplayTranscriptSegments();
      if (segments.length === 0) {
        activeTranscriptSegmentId = null;
        return;
      }

      const nextActiveId = resolveActiveSegmentId(segments, video.currentTime);
      if (nextActiveId === activeTranscriptSegmentId) return;
      activeTranscriptSegmentId = nextActiveId;

      const rows = Array.from(
        transcriptWrap.querySelectorAll<HTMLElement>('[data-testid="unity-transcript-row"]'),
      );
      for (const row of rows) {
        row.dataset.current = String(row.dataset.segmentId === nextActiveId);
      }
    };

    const onVideoTimelineUpdate = () => {
      updateCurrentTranscriptHighlight();
    };

    const syncVideoListener = () => {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video === watchedVideo) return;

      if (watchedVideo) {
        watchedVideo.removeEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeked', onVideoTimelineUpdate);
      }

      watchedVideo = video;
      if (watchedVideo) {
        watchedVideo.addEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.addEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.addEventListener('seeked', onVideoTimelineUpdate);
      }
    };

    const loadTranscript = async (force = false) => {
      if (!isWatchUrl(location.href)) return;
      if (transcriptLoading && !force) return;
      if (!force && (transcriptResolved || getDisplayTranscriptSegments().length > 0)) return;

      const videoId = getVideoIdFromUrl(location.href);
      if (!videoId) {
        transcriptError = 'Missing YouTube video id.';
        transcriptResolved = true;
        render();
        return;
      }

      transcriptLoading = true;
      transcriptError = null;
      render();

      try {
        const response = await sendRuntimeMessageWithRetry<
          { type: 'GET_TRANSCRIPT'; videoId: string; tabId?: number },
          { ok: boolean; source?: 'youtube_api'; segments?: TranscriptSegment[]; reason?: string }
        >({
          type: 'GET_TRANSCRIPT',
          videoId,
          ...(tabId ? { tabId } : {}),
        });

        if (response.ok && Array.isArray(response.segments) && response.segments.length > 0) {
          transcriptSegments = response.segments;
          transcriptError = null;
        } else {
          transcriptSegments = [];
          transcriptError = response.reason ?? 'Transcript unavailable for this video.';
        }
      } catch {
        transcriptSegments = [];
        transcriptError = 'Transcript request failed. Try again in a moment.';
      } finally {
        transcriptLoading = false;
        transcriptResolved = true;
        render();
      }
    };

    const captureComposerSelection = (input: HTMLTextAreaElement) => {
      composerSelectionStart = input.selectionStart ?? question.length;
      composerSelectionEnd = input.selectionEnd ?? composerSelectionStart;
    };

    const clearDictationSilenceTimer = () => {
      if (dictationSilenceTimer == null) return;
      window.clearTimeout(dictationSilenceTimer);
      dictationSilenceTimer = null;
    };

    const scheduleDictationSilenceStop = () => {
      clearDictationSilenceTimer();
      dictationSilenceTimer = window.setTimeout(() => {
        dictationSilenceTimer = null;
        if (!dictationActive) return;
        stopDictation();
      }, DICTATION_SILENCE_TIMEOUT_MS);
    };

    const stopDictation = () => {
      clearDictationSilenceTimer();
      if (!dictation) return;
      try {
        dictation.stop();
      } catch {
        // Recognition can already be stopped.
      }
    };

    const insertDictatedQuestionText = (transcript: string) => {
      const input = panelRoot?.querySelector<HTMLTextAreaElement>('[data-testid="unity-composer-input"]');
      if (input) {
        captureComposerSelection(input);
      }
      const next = insertDictationText(question, transcript, composerSelectionStart, composerSelectionEnd);
      question = next.value;
      composerSelectionStart = next.cursor;
      composerSelectionEnd = next.cursor;
      composerFocused = true;
    };

    const initializeDictation = () => {
      const DictationCtor = getDictationRecognitionCtor(window);
      if (!DictationCtor) {
        dictationSupported = false;
        dictation = null;
        dictationActive = false;
        return;
      }

      dictationSupported = true;
      let recognition: DictationRecognitionLike;
      try {
        recognition = new DictationCtor();
      } catch {
        dictationSupported = false;
        dictation = null;
        dictationActive = false;
        return;
      }
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';

      recognition.onstart = () => {
        pendingDictationTranscript = '';
        dictationActive = true;
        localError = null;
        scheduleDictationSilenceStop();
        render();
      };

      recognition.onend = () => {
        if (pendingDictationTranscript.trim()) {
          insertDictatedQuestionText(pendingDictationTranscript);
        }
        pendingDictationTranscript = '';
        dictationActive = false;
        clearDictationSilenceTimer();
        render();
      };

      recognition.onerror = (event) => {
        pendingDictationTranscript = '';
        dictationActive = false;
        clearDictationSilenceTimer();
        if (event.error && event.error !== 'aborted') {
          localError = dictationErrorMessage(event.error);
        }
        render();
      };

      recognition.onspeechstart = () => {
        clearDictationSilenceTimer();
      };

      recognition.onspeechend = () => {
        scheduleDictationSilenceStop();
      };

      recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? '';
          if (!transcript.trim()) continue;
          if (result.isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }
        if (finalTranscript.trim()) {
          pendingDictationTranscript = '';
          insertDictatedQuestionText(finalTranscript);
          scheduleDictationSilenceStop();
          render();
          return;
        }
        pendingDictationTranscript = interimTranscript.trim();
        if (pendingDictationTranscript) {
          scheduleDictationSilenceStop();
        }
      };

      dictation = recognition;
    };

    const disposeDictation = () => {
      if (!dictation) return;
      stopDictation();
      dictation.onstart = null;
      dictation.onend = null;
      dictation.onerror = null;
      dictation.onresult = null;
      dictation.onspeechstart = null;
      dictation.onspeechend = null;
      dictation = null;
      dictationActive = false;
      pendingDictationTranscript = '';
      clearDictationSilenceTimer();
    };

    const render = () => {
      if (!panelRoot) return;
      applyColorBlindModeAttribute();

      const nextFingerprint = viewFingerprint();
      if (panelRoot.childElementCount > 0 && nextFingerprint === lastRenderedFingerprint) {
        updateCurrentTranscriptHighlight();
        return;
      }
      lastRenderedFingerprint = nextFingerprint;

      const shouldRestoreComposerFocus = composerFocused && !isAsking;
      const restoreStart = composerSelectionStart;
      const restoreEnd = composerSelectionEnd;

      panelRoot.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'unity-head';

      const titleWrap = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'unity-title';
      title.textContent = 'Unity';
      const statusLine = document.createElement('p');
      statusLine.className = 'unity-status';
      statusLine.textContent = status.message;
      titleWrap.append(title, statusLine);

      const headActions = document.createElement('div');
      headActions.className = 'unity-head-actions';

      const isScanning = status.state === 'extracting' || status.state === 'analyzing';
      const scanBtn = document.createElement('button');
      scanBtn.className = 'unity-btn unity-btn--icon';
      scanBtn.type = 'button';
      scanBtn.title = isScanning ? 'Scanning...' : 'Scan';
      scanBtn.setAttribute('aria-label', isScanning ? 'Scanning' : 'Scan');
      scanBtn.disabled = isScanning;
      scanBtn.appendChild(createRefreshIcon(isScanning));
      scanBtn.addEventListener('click', () => {
        void (async () => {
          localError = null;
          try {
            await sendRuntimeMessageWithRetry<{ type: 'START_SCAN'; tabId?: number }, { ok: boolean }>({
              type: 'START_SCAN',
              ...(tabId ? { tabId } : {}),
            });
          } catch (error) {
            localError = error instanceof Error ? error.message : 'Failed to start scan.';
          }
          render();
        })();
      });

      const clearBtn = document.createElement('button');
      clearBtn.className = 'unity-btn';
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear';
      clearBtn.disabled = (session?.messages.length ?? 0) === 0;
      clearBtn.addEventListener('click', () => {
        if (tabId == null) return;
        void (async () => {
          localError = null;
          try {
            await sendRuntimeMessageWithRetry<{ type: 'CLEAR_CHAT_SESSION'; tabId: number }, { ok: boolean }>({
              type: 'CLEAR_CHAT_SESSION',
              tabId,
            });
            session = session ? { ...session, messages: [] } : null;
          } catch (error) {
            localError = error instanceof Error ? error.message : 'Failed to clear chat.';
          }
          render();
        })();
      });

      headActions.append(scanBtn, clearBtn);
      head.append(titleWrap, headActions);

      const body = document.createElement('div');
      body.className = 'unity-body';

      const note = document.createElement('p');
      note.className = 'unity-note';
      const snippetCount = report?.snippetCount ?? 0;
      note.textContent = snippetCount > 0
        ? 'Context ready for grounded Q&A.'
        : 'Run scan to prepare grounded context.';
      body.appendChild(note);

      if (report?.transcript?.unavailableReason && !transcriptLoading) {
        const transcriptWarning = document.createElement('p');
        transcriptWarning.className = 'unity-note';
        transcriptWarning.textContent = `Transcript note: ${report.transcript.unavailableReason}`;
        body.appendChild(transcriptWarning);
      }

      const chat = document.createElement('div');
      chat.className = 'unity-chat';
      chat.setAttribute('data-testid', 'unity-chat-list');

      const messages = session?.messages ?? [];
      if (messages.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'unity-empty';
        empty.textContent = 'Ask about this video. Answers are grounded in transcript/page context only.';
        chat.appendChild(empty);
      } else {
        for (const message of messages) {
          const bubble = document.createElement('article');
          bubble.className = `unity-bubble unity-bubble--${message.role === 'assistant' ? 'assistant' : 'user'}`;

          const bubbleHead = document.createElement('div');
          bubbleHead.className = 'unity-bubble-head';
          const speaker = document.createElement('span');
          speaker.textContent = message.role === 'assistant' ? 'Unity' : 'You';
          const ts = document.createElement('span');
          ts.textContent = formatTime(message.createdAt);
          bubbleHead.append(speaker, ts);

          const text = document.createElement('p');
          text.textContent = message.text;
          text.style.margin = '0';

          bubble.append(bubbleHead, text);

          if (message.role === 'assistant' && (message.sources?.length ?? 0) > 0) {
            const sourceRow = document.createElement('div');
            sourceRow.className = 'unity-source-row';
            for (let index = 0; index < (message.sources?.length ?? 0); index += 1) {
              const source = message.sources![index];
              const sourceBtn = document.createElement('button');
              sourceBtn.type = 'button';
              sourceBtn.className = 'unity-source';
              sourceBtn.textContent = sourceLabel(source, index);
              sourceBtn.title = source.text;
              sourceBtn.addEventListener('click', () => {
                if (tabId == null) return;
                void sendRuntimeMessageWithRetry<
                  { type: 'JUMP_TO_SOURCE_SNIPPET'; tabId: number; source: SourceSnippet },
                  { ok: boolean }
                >({
                  type: 'JUMP_TO_SOURCE_SNIPPET',
                  tabId,
                  source,
                }).catch(() => {
                  localError = 'Could not jump to the selected source.';
                  render();
                });
              });
              sourceRow.appendChild(sourceBtn);
            }
            bubble.appendChild(sourceRow);
          }

          chat.appendChild(bubble);
        }
      }

      body.appendChild(chat);

      const compose = document.createElement('form');
      compose.className = 'unity-compose';
      compose.addEventListener('submit', (event) => {
        event.preventDefault();
        if (isAsking || !question.trim()) return;
        if (dictationActive) {
          stopDictation();
        }

        void (async () => {
          isAsking = true;
          localError = null;
          render();

          try {
            const response = await sendRuntimeMessageWithRetry<
              { type: 'ASK_CHAT_QUESTION'; question: string; tabId?: number },
              { ok: boolean; session?: ChatSession; error?: string }
            >({
              type: 'ASK_CHAT_QUESTION',
              question: question.trim(),
              ...(tabId ? { tabId } : {}),
            });

            if (!response.ok || !response.session) {
              throw new Error(response.error || 'Failed to answer question.');
            }

            session = response.session;
            question = '';
            composerSelectionStart = 0;
            composerSelectionEnd = 0;
          } catch (error) {
            localError = error instanceof Error ? error.message : 'Question failed.';
          } finally {
            isAsking = false;
            render();
          }
        })();
      });

      const input = document.createElement('textarea');
      input.value = question;
      input.placeholder = 'Ask a grounded question about this video...';
      input.disabled = isAsking;
      input.setAttribute('data-testid', 'unity-composer-input');
      let askButton: HTMLButtonElement | null = null;
      const syncAskButtonState = () => {
        if (!askButton) return;
        askButton.disabled = isAsking || !question.trim();
      };
      input.addEventListener('focus', () => {
        composerFocused = true;
        captureComposerSelection(input);
      });
      input.addEventListener('blur', () => {
        composerFocused = false;
      });
      input.addEventListener('input', () => {
        question = input.value;
        captureComposerSelection(input);
        syncAskButtonState();
      });
      input.addEventListener('keyup', () => {
        captureComposerSelection(input);
      });
      input.addEventListener('click', () => {
        captureComposerSelection(input);
      });
      input.addEventListener('select', () => {
        captureComposerSelection(input);
      });

      const composeActions = document.createElement('div');
      composeActions.className = 'unity-compose-actions';

      const dictationButton = document.createElement('button');
      dictationButton.type = 'button';
      dictationButton.className = 'unity-btn unity-btn--dictation';
      dictationButton.dataset.active = String(dictationActive);
      const dictationTitle = !dictationSupported
        ? 'Voice dictation is unavailable in this browser.'
        : dictationActive
          ? 'Stop voice dictation'
          : 'Start voice dictation';
      dictationButton.title = dictationTitle;
      dictationButton.setAttribute('aria-label', dictationTitle);
      dictationButton.disabled = isAsking || !dictationSupported;
      dictationButton.appendChild(createMicIcon(dictationActive));
      dictationButton.addEventListener('click', () => {
        if (!dictation || !dictationSupported) return;
        localError = null;
        try {
          if (dictationActive) {
            dictation.stop();
          } else {
            dictation.start();
          }
        } catch (error) {
          dictationActive = false;
          localError = error instanceof Error ? error.message : dictationErrorMessage();
          render();
        }
      });

      askButton = document.createElement('button');
      askButton.type = 'submit';
      askButton.className = 'unity-btn';
      askButton.textContent = isAsking ? 'Asking...' : 'Ask';
      syncAskButtonState();
      composeActions.append(dictationButton, askButton);

      compose.append(input, composeActions);
      body.appendChild(compose);

      const transcriptHead = document.createElement('div');
      transcriptHead.className = 'unity-transcript-head';
      const transcriptTitle = document.createElement('p');
      transcriptTitle.className = 'unity-transcript-title';
      transcriptTitle.textContent = 'Transcript';
      const transcriptMeta = document.createElement('p');
      transcriptMeta.className = 'unity-transcript-meta';
      transcriptMeta.textContent = transcriptLoading
        ? 'Loading...'
        : `${getDisplayTranscriptSegments().length} lines`;
      transcriptHead.append(transcriptTitle, transcriptMeta);
      body.appendChild(transcriptHead);

      if (transcriptError && !transcriptLoading) {
        const transcriptErrorLine = document.createElement('p');
        transcriptErrorLine.className = 'unity-note';
        transcriptErrorLine.textContent = transcriptError;
        body.appendChild(transcriptErrorLine);
      }

      const transcriptWrap = document.createElement('div');
      transcriptWrap.className = 'unity-transcript';
      transcriptWrap.setAttribute('data-testid', 'unity-transcript-list');

      const segments = getDisplayTranscriptSegments();
      if (segments.length === 0) {
        const emptyTranscript = document.createElement('p');
        emptyTranscript.className = 'unity-empty';
        emptyTranscript.textContent = transcriptLoading
          ? 'Loading transcript from YouTube...'
          : 'Transcript unavailable for this video.';
        transcriptWrap.appendChild(emptyTranscript);
      } else {
        for (const segment of segments) {
          const row = document.createElement('article');
          row.className = 'unity-transcript-row';
          row.setAttribute('data-testid', 'unity-transcript-row');
          row.dataset.segmentId = segment.id;
          row.dataset.current = String(segment.id === activeTranscriptSegmentId);

          const tsButton = document.createElement('button');
          tsButton.type = 'button';
          tsButton.className = 'unity-ts-btn';
          tsButton.textContent = segment.startLabel;
          tsButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            seekVideo(segment.startSec);
          });

          const textNode = document.createElement('p');
          textNode.className = 'unity-transcript-text';
          textNode.textContent = segment.text;
          textNode.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            seekVideo(segment.startSec);
          });

          row.append(tsButton, textNode);
          transcriptWrap.appendChild(row);
        }
      }

      body.appendChild(transcriptWrap);

      if (localError) {
        const error = document.createElement('p');
        error.className = 'unity-error';
        error.textContent = localError;
        body.appendChild(error);
      }

      panelRoot.append(head, body);

      if (shouldRestoreComposerFocus) {
        const max = input.value.length;
        const start = Math.max(0, Math.min(restoreStart, max));
        const end = Math.max(start, Math.min(restoreEnd, max));
        window.requestAnimationFrame(() => {
          if (!panelRoot || !panelRoot.isConnected) return;
          input.focus();
          input.setSelectionRange(start, end);
        });
      }

      updateCurrentTranscriptHighlight();
    };

    const applyEmbeddedResponse = (response: EmbeddedStateResponse) => {
      tabId = response.tabId ?? tabId;
      status = response.status ?? status;
      report = response.report ?? report;
      session = response.session ?? session;

      if (report?.transcript?.segments?.length) {
        transcriptSegments = report.transcript.segments;
        transcriptError = report.transcript.unavailableReason ?? null;
        transcriptResolved = true;
      } else if (report?.transcript?.unavailableReason) {
        transcriptError = report.transcript.unavailableReason;
        transcriptResolved = true;
      }
    };

    const loadEmbeddedState = async () => {
      try {
        const before = [
          statusFingerprint(status),
          reportFingerprint(report),
          sessionFingerprint(session),
          transcriptSegments.length,
          transcriptLoading ? '1' : '0',
          transcriptResolved ? '1' : '0',
          transcriptError ?? '',
        ].join('|');

        const response = await sendRuntimeMessageWithRetry<
          { type: 'GET_EMBEDDED_PANEL_STATE' },
          EmbeddedStateResponse | undefined
        >({ type: 'GET_EMBEDDED_PANEL_STATE' }, 8);

        if (!response) return;
        applyEmbeddedResponse(response);

        const after = [
          statusFingerprint(status),
          reportFingerprint(report),
          sessionFingerprint(session),
          transcriptSegments.length,
          transcriptLoading ? '1' : '0',
          transcriptResolved ? '1' : '0',
          transcriptError ?? '',
        ].join('|');

        if (before !== after) {
          render();
        } else {
          updateCurrentTranscriptHighlight();
        }
      } catch {
        // Ignore transient startup issues.
      }
    };

    const onMessage = (message: EmbeddedPanelUpdate) => {
      if (!message || message.type !== 'EMBEDDED_PANEL_UPDATE') return;

      const before = [
        statusFingerprint(status),
        reportFingerprint(report),
        sessionFingerprint(session),
        transcriptSegments.length,
        transcriptLoading ? '1' : '0',
        transcriptResolved ? '1' : '0',
        transcriptError ?? '',
      ].join('|');

      applyEmbeddedResponse(message);

      const after = [
        statusFingerprint(status),
        reportFingerprint(report),
        sessionFingerprint(session),
        transcriptSegments.length,
        transcriptLoading ? '1' : '0',
        transcriptResolved ? '1' : '0',
        transcriptError ?? '',
      ].join('|');

      if (before !== after) {
        render();
      } else {
        updateCurrentTranscriptHighlight();
      }
    };

    const onStorageChanged = (
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      if (!(COLOR_BLIND_MODE_STORAGE_KEY in changes)) return;
      colorBlindModeEnabled = Boolean(changes[COLOR_BLIND_MODE_STORAGE_KEY]?.newValue);
      applyColorBlindModeAttribute();
      render();
    };

    ext.runtime.onMessage.addListener(onMessage as any);
    ext.storage.onChanged.addListener(onStorageChanged);

    initializeDictation();
    ensurePanelMounted();
    syncVideoListener();
    render();
    void ext.storage.local
      .get(COLOR_BLIND_MODE_STORAGE_KEY)
      .then((stored) => {
        colorBlindModeEnabled = Boolean(stored?.[COLOR_BLIND_MODE_STORAGE_KEY]);
        applyColorBlindModeAttribute();
        render();
      })
      .catch(() => {
        // Ignore storage read errors.
      });
    void loadEmbeddedState();
    void loadTranscript();

    const pollTimer = window.setInterval(() => {
      if (!isWatchUrl(location.href)) return;
      void loadEmbeddedState();
      syncVideoListener();
      if (!transcriptResolved && !transcriptLoading && getDisplayTranscriptSegments().length === 0) {
        void loadTranscript();
      } else {
        updateCurrentTranscriptHighlight();
      }
    }, POLL_INTERVAL_MS);

    const urlTimer = window.setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        if (dictationActive) {
          stopDictation();
        }

        if (!isWatchUrl(currentUrl)) {
          if (watchedVideo) {
            watchedVideo.removeEventListener('timeupdate', onVideoTimelineUpdate);
            watchedVideo.removeEventListener('seeking', onVideoTimelineUpdate);
            watchedVideo.removeEventListener('seeked', onVideoTimelineUpdate);
            watchedVideo = null;
          }
          panelRoot?.remove();
          panelRoot = null;
          return;
        }

        status = {
          state: 'idle',
          progress: 0,
          message: 'Ready to scan this video.',
          updatedAt: Date.now(),
        };
        report = null;
        session = null;
        question = '';
        isAsking = false;
        localError = null;
        dictationActive = false;

        transcriptSegments = [];
        transcriptLoading = false;
        transcriptResolved = false;
        transcriptError = null;
        activeTranscriptSegmentId = null;

        composerFocused = false;
        composerSelectionStart = 0;
        composerSelectionEnd = 0;
        lastRenderedFingerprint = '';

        ensurePanelMounted();
        syncVideoListener();
        render();
        void loadEmbeddedState();
        void loadTranscript(true);
      } else {
        ensurePanelMounted();
        syncVideoListener();
        updateCurrentTranscriptHighlight();
      }
    }, URL_CHECK_INTERVAL_MS);

    window.addEventListener('beforeunload', () => {
      window.clearInterval(pollTimer);
      window.clearInterval(urlTimer);
      disposeDictation();
      if (watchedVideo) {
        watchedVideo.removeEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeked', onVideoTimelineUpdate);
      }
      ext.runtime.onMessage.removeListener(onMessage as any);
      ext.storage.onChanged.removeListener(onStorageChanged);
    });
  },
});
