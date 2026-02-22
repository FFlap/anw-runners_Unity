import type {
  ChatMessage,
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
import { parseTimestampLabelToSeconds } from '@/lib/youtube-transcript';

const PANEL_ID = 'unity-youtube-chat-root';
const MOTION_EXEMPT_ATTR = 'data-unity-motion-exempt';
const STYLE_ID = 'unity-youtube-chat-style';
const TIMELINE_MARKER_HOST_ATTR = 'data-unity-source-range-host';
const TIMELINE_MARKER_LAYER_CLASS = 'unity-yt-source-range-markers';
const TIMELINE_MARKER_CLASS = 'unity-yt-source-range-marker';
const TIMELINE_MARKER_TEST_ID = 'unity-timeline-marker';
const URL_CHECK_INTERVAL_MS = 900;
const POLL_INTERVAL_MS = 1700;
const SOURCE_RANGE_FALLBACK_SECONDS = 8;
const SOURCE_RANGE_MIN_DURATION_SECONDS = 0.2;
const SOURCE_RANGE_MERGE_GAP_SECONDS = 0.35;

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

interface EmbeddedStateResponse {
  tabId: number | null;
  status: ScanStatus;
  report: ScanReport | null;
  session: ChatSession | null;
}

type LocalMessageState = 'pending' | 'failed';

interface LocalOptimisticChatMessage extends ChatMessage {
  localState: LocalMessageState;
  localOnly: true;
}

type RenderedChatMessage = ChatMessage | LocalOptimisticChatMessage;

interface TimelineSourceRange {
  startSec: number;
  endSec: number;
  startLabel: string;
  endLabel: string;
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

function isYouTubeFullscreen(): boolean {
  const fullscreenDocument = document as Document & {
    webkitFullscreenElement?: Element | null;
    msFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
  };

  if (Boolean(fullscreenDocument.fullscreenElement)) return true;
  if (Boolean(fullscreenDocument.webkitFullscreenElement)) return true;
  if (Boolean(fullscreenDocument.msFullscreenElement)) return true;
  if (Boolean(fullscreenDocument.mozFullScreenElement)) return true;

  return document.querySelector('.html5-video-player.ytp-fullscreen') !== null;
}

function createLocalMessageId(prefix: 'user'): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${prefix}-local-${Date.now()}-${entropy}`;
}

function messageTimestampMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareMessagesByCreatedAt(
  left: Pick<RenderedChatMessage, 'createdAt'>,
  right: Pick<RenderedChatMessage, 'createdAt'>,
): number {
  return messageTimestampMs(left.createdAt) - messageTimestampMs(right.createdAt);
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

function urlsRepresentSameResource(
  leftUrl: string,
  rightUrl: string,
  leftVideoId?: string | null,
  rightVideoId?: string | null,
): boolean {
  const resolvedLeftVideoId = leftVideoId ?? getVideoIdFromUrl(leftUrl);
  const resolvedRightVideoId = rightVideoId ?? getVideoIdFromUrl(rightUrl);
  if (resolvedLeftVideoId && resolvedRightVideoId) {
    return resolvedLeftVideoId === resolvedRightVideoId;
  }
  return normalizeUrlWithoutHash(leftUrl) === normalizeUrlWithoutHash(rightUrl);
}

function sourceLabel(source: SourceSnippet, index: number): string {
  if (source.timestampLabel) return `Jump ${source.timestampLabel}`;
  return `Source ${index + 1}`;
}

function formatSecondsLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function parseTimestampRangeLabel(
  label: string | undefined,
): { startSec: number; endSec: number; startLabel: string; endLabel: string } | null {
  if (!label) return null;
  const cleaned = label.trim();
  if (!cleaned) return null;
  const parts = cleaned
    .split(/\s*[-–—]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;

  const startSec = parseTimestampLabelToSeconds(parts[0]);
  const endSec = parseTimestampLabelToSeconds(parts[1]);
  if (
    startSec == null ||
    endSec == null ||
    !Number.isFinite(startSec) ||
    !Number.isFinite(endSec) ||
    endSec <= startSec + SOURCE_RANGE_MIN_DURATION_SECONDS
  ) {
    return null;
  }

  return {
    startSec,
    endSec,
    startLabel: parts[0],
    endLabel: parts[1],
  };
}

function hasTimestampSource(source: SourceSnippet): boolean {
  if (typeof source.timestampSec === 'number' && Number.isFinite(source.timestampSec) && source.timestampSec >= 0) {
    return true;
  }
  if (!source.timestampLabel) return false;
  if (parseTimestampRangeLabel(source.timestampLabel)) return true;
  const parsedSingle = parseTimestampLabelToSeconds(source.timestampLabel.trim());
  return parsedSingle != null && Number.isFinite(parsedSingle) && parsedSingle >= 0;
}

function mergeTimelineSourceRanges(ranges: TimelineSourceRange[]): TimelineSourceRange[] {
  if (ranges.length <= 1) return ranges.slice();

  const sorted = [...ranges]
    .filter((range) =>
      Number.isFinite(range.startSec) &&
      Number.isFinite(range.endSec) &&
      range.endSec > range.startSec + SOURCE_RANGE_MIN_DURATION_SECONDS,
    )
    .sort((left, right) => {
      if (left.startSec !== right.startSec) return left.startSec - right.startSec;
      return left.endSec - right.endSec;
    });

  if (sorted.length <= 1) return sorted;

  const merged: TimelineSourceRange[] = [];
  let current: TimelineSourceRange = { ...sorted[0] };

  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    if (next.startSec <= current.endSec + SOURCE_RANGE_MERGE_GAP_SECONDS) {
      if (next.endSec > current.endSec) {
        current.endSec = next.endSec;
        current.endLabel = next.endLabel;
      }
      continue;
    }
    merged.push(current);
    current = { ...next };
  }

  merged.push(current);
  return merged;
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
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap');
    #${PANEL_ID} {
      --unity-panel-border: #000;
      --unity-panel-bg-start: #fff;
      --unity-panel-bg-end: #fff;
      --unity-panel-text: #000;
      --unity-panel-shadow: rgba(0, 0, 0, 0.12);
      --unity-panel-head-bg: #fff;
      --unity-panel-muted: #aaaaaa;
      --unity-panel-btn-border: #000;
      --unity-panel-btn-bg: #fff;
      --unity-panel-btn-text: #000;
      --unity-panel-btn-hover: #000;
      --unity-panel-btn-hover-bg: #000;
      --unity-panel-btn-hover-text: #fff;
      --unity-panel-scroll-thumb: rgba(0, 0, 0, 0.35);
      --unity-panel-empty-border: #000;
      --unity-panel-empty-text: #555;
      --unity-panel-bubble-border: #000;
      --unity-panel-bubble-user-bg: #000;
      --unity-panel-bubble-user-border: #000;
      --unity-panel-bubble-user-text: #fff;
      --unity-panel-bubble-user-muted: #bdbdbd;
      --unity-panel-bubble-assistant-bg: #e6e6e6;
      --unity-panel-compose-bg: #fff;
      --unity-panel-error: #d00;
      --unity-panel-error-bg: #fff0f0;
      --unity-panel-dictation-active-border: #000;
      --unity-panel-dictation-active-bg: #000;
      --unity-panel-dictation-active-text: #fff;
      --unity-transcript-border: #000;
      --unity-transcript-bg: #fff;
      --unity-transcript-row-border: #d4d4d4;
      --unity-transcript-row-bg: #fff;
      --unity-transcript-current-border: #000;
      --unity-transcript-current-shadow: rgba(0, 0, 0, 0.14);
      --unity-transcript-current-bg: #f5f5f5;
      --unity-transcript-btn-bg: #fff;
      --unity-transcript-btn-border: #000;
      --unity-transcript-btn-text: #000;
      --unity-transcript-text: #000;
      --unity-panel-content-height: clamp(360px, 62vh, 620px);
      --unity-focus-ring: transparent;
      --unity-focus-ring-shadow: transparent;
      --unity-transcript-stripe: transparent;
      --unity-transcript-current-stripe: transparent;
      --unity-transcript-current-outline: transparent;
      width: 100%;
      margin-bottom: 16px;
      border-radius: 0;
      border: 2px solid var(--unity-panel-border);
      background: var(--unity-panel-bg-start);
      color: var(--unity-panel-text);
      font-family: 'Plus Jakarta Sans', ui-sans-serif, -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      box-shadow: none;
      display: flex;
      flex-direction: column;
      min-height: 640px;
      overflow: hidden;
      z-index: 9998;
    }
    #${PANEL_ID}[data-unity-floating="true"] {
      position: fixed;
      top: 76px;
      right: 12px;
      width: min(380px, calc(100vw - 24px));
      max-height: 78vh;
      min-height: 0;
      margin: 0;
      z-index: 2147483000;
    }
    #${PANEL_ID} * { box-sizing: border-box; }
    #${PANEL_ID} .unity-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 24px 24px 8px;
      border-bottom: none;
      background: var(--unity-panel-head-bg);
    }
    #${PANEL_ID} .unity-head-title {
      flex: 1;
      min-width: 0;
    }
    #${PANEL_ID} .unity-title {
      margin: 0;
      font-size: 3rem;
      font-weight: 700;
      letter-spacing: -0.04em;
      line-height: 1;
    }
    #${PANEL_ID} .unity-head-actions {
      display: flex;
      gap: 12px;
    }
    #${PANEL_ID} .unity-icon-btn {
      border: 2px solid var(--unity-panel-btn-border);
      background: var(--unity-panel-btn-bg);
      color: var(--unity-panel-btn-text);
      border-radius: 50%;
      width: 40px;
      height: 40px;
      padding: 0;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s ease;
    }
    #${PANEL_ID} .unity-btn-icon {
      width: 18px;
      height: 18px;
      display: block;
    }
    #${PANEL_ID} .unity-spin {
      animation: unity-spin 0.9s linear infinite;
    }
    #${PANEL_ID} .unity-icon-btn:hover:not(:disabled) {
      border-color: var(--unity-panel-btn-hover);
      background: var(--unity-panel-btn-hover-bg);
      color: var(--unity-panel-btn-hover-text);
    }
    #${PANEL_ID} .unity-icon-btn:disabled { opacity: 0.5; cursor: default; }
    @keyframes unity-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    #${PANEL_ID} .unity-body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      padding: 0;
      gap: 0;
    }
    #${PANEL_ID} .unity-note {
      margin: 0;
      padding: 10px 24px 0;
      font-size: 13px;
      color: var(--unity-panel-muted);
    }
    #${PANEL_ID} .unity-tabs {
      display: flex;
      gap: 16px;
      margin: 0;
      padding: 0 24px 12px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 2px solid var(--unity-panel-border);
      overflow-x: auto;
      scrollbar-width: none;
      background: var(--unity-panel-head-bg);
    }
    #${PANEL_ID} .unity-tabs::-webkit-scrollbar { display: none; }
    #${PANEL_ID} .unity-tab {
      border: none;
      background: transparent;
      color: var(--unity-panel-muted);
      padding: 0;
      margin: 0;
      font-size: inherit;
      font-weight: inherit;
      text-transform: inherit;
      letter-spacing: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: color 0.2s ease;
    }
    #${PANEL_ID} .unity-tab[data-active="true"],
    #${PANEL_ID} .unity-tab:hover {
      color: var(--unity-panel-text);
    }
    #${PANEL_ID} .unity-tab-panel {
      height: var(--unity-panel-content-height);
      min-height: var(--unity-panel-content-height);
      max-height: var(--unity-panel-content-height);
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    #${PANEL_ID} .unity-chat {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 24px;
      font-size: 12px;
    }
    #${PANEL_ID} .unity-chat::-webkit-scrollbar,
    #${PANEL_ID} .unity-transcript::-webkit-scrollbar { width: 8px; }
    #${PANEL_ID} .unity-chat::-webkit-scrollbar-thumb,
    #${PANEL_ID} .unity-transcript::-webkit-scrollbar-thumb {
      background: var(--unity-panel-scroll-thumb);
      border-radius: 999px;
    }
    #${PANEL_ID} .unity-empty {
      border: 2px dashed var(--unity-panel-empty-border);
      border-radius: 16px;
      padding: 24px;
      color: var(--unity-panel-empty-text);
      font-size: 12px;
      margin: 0;
      text-align: center;
    }
    #${PANEL_ID} .unity-bubble {
      border-radius: 20px;
      border: none;
      padding: 16px 20px;
      max-width: 85%;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #${PANEL_ID} .unity-bubble--user {
      align-self: flex-end;
      text-align: right;
      align-items: flex-end;
      background: var(--unity-panel-bubble-user-bg);
      color: var(--unity-panel-bubble-user-text);
      border-bottom-right-radius: 6px;
      margin-bottom: 24px;
    }
    #${PANEL_ID} .unity-bubble--assistant {
      align-self: flex-start;
      text-align: left;
      align-items: flex-start;
      background: var(--unity-panel-bubble-assistant-bg);
      border-bottom-left-radius: 6px;
    }
    #${PANEL_ID} .unity-bubble--assistant[data-has-source-ranges="true"] {
      cursor: pointer;
      transition: box-shadow 0.18s ease;
    }
    #${PANEL_ID} .unity-bubble--assistant[data-has-source-ranges="true"]:hover {
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.25);
    }
    #${PANEL_ID} .unity-bubble--assistant[data-range-active="true"] {
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.45);
    }
    #${PANEL_ID} .unity-bubble--user.unity-bubble--failed {
      border: 2px solid var(--unity-panel-error);
      background: var(--unity-panel-error-bg);
      color: var(--unity-panel-error);
    }
    #${PANEL_ID} .unity-bubble--user.unity-bubble--failed .unity-bubble-head {
      color: var(--unity-panel-error);
    }
    #${PANEL_ID} .unity-bubble-head {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      font-weight: 700;
      color: var(--unity-panel-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    #${PANEL_ID} .unity-bubble-text {
      margin: 0;
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.5;
      font-weight: 400;
    }
    #${PANEL_ID} .unity-bubble--user .unity-bubble-head {
      color: var(--unity-panel-bubble-user-muted);
    }
    #${PANEL_ID} .unity-bubble-local-state {
      margin: 0;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    #${PANEL_ID} .unity-bubble-local-state--failed {
      color: var(--unity-panel-error);
    }
    #${PANEL_ID} .unity-source-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 7px;
    }
    #${PANEL_ID} .unity-source {
      border: 2px solid var(--unity-panel-btn-border);
      border-radius: 999px;
      background: var(--unity-panel-btn-bg);
      color: var(--unity-panel-btn-text);
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    #${PANEL_ID} .unity-source:hover {
      border-color: var(--unity-panel-btn-hover);
      background: var(--unity-panel-btn-hover-bg);
      color: var(--unity-panel-btn-hover-text);
    }
    #${PANEL_ID} .unity-compose {
      border-top: 2px solid var(--unity-panel-border);
      background: var(--unity-panel-compose-bg);
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #${PANEL_ID} .unity-compose textarea {
      width: 100%;
      min-height: 48px;
      border: none;
      border-bottom: 2px solid var(--unity-panel-muted);
      border-radius: 0;
      background: transparent;
      color: var(--unity-panel-text);
      font-size: 12px;
      line-height: 1.4;
      padding: 0 0 8px;
      resize: none;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s ease;
    }
    #${PANEL_ID} .unity-compose textarea:focus {
      border-bottom-color: var(--unity-panel-btn-border);
    }
    #${PANEL_ID} .unity-compose-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    #${PANEL_ID} .unity-compose-submit-actions {
      display: inline-flex;
      align-items: center;
      gap: 12px;
    }
    #${PANEL_ID} .unity-ghost-btn,
    #${PANEL_ID} .unity-primary-btn {
      border: 2px solid var(--unity-panel-btn-border);
      border-radius: 20px;
      background: transparent;
      color: var(--unity-panel-text);
      padding: 8px 16px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: all 0.2s ease;
      min-height: 40px;
    }
    #${PANEL_ID} .unity-ghost-btn:hover:not(:disabled) {
      background: var(--unity-panel-btn-hover-bg);
      color: var(--unity-panel-btn-hover-text);
    }
    #${PANEL_ID} .unity-primary-btn {
      background: var(--unity-panel-text);
      color: var(--unity-panel-btn-bg);
      min-width: 124px;
    }
    #${PANEL_ID} .unity-primary-btn:hover:not(:disabled) {
      background: var(--unity-panel-btn-hover-bg);
      color: var(--unity-panel-btn-hover-text);
    }
    #${PANEL_ID} .unity-ghost-btn:disabled,
    #${PANEL_ID} .unity-primary-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    #${PANEL_ID} .unity-icon-btn--dictation {
      width: 34px;
      height: 34px;
    }
    #${PANEL_ID} .unity-icon-btn--dictation[data-active="true"] {
      border-color: var(--unity-panel-dictation-active-border);
      background: var(--unity-panel-dictation-active-bg);
      color: var(--unity-panel-dictation-active-text);
    }
    #${PANEL_ID} .unity-error {
      margin: 10px 24px;
      font-size: 11px;
      color: var(--unity-panel-error);
    }
    #${PANEL_ID} .unity-transcript-head {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      padding: 20px 24px 8px;
    }
    #${PANEL_ID} .unity-transcript-title {
      margin: 0;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--unity-panel-text);
    }
    #${PANEL_ID} .unity-transcript-meta {
      margin: 0;
      font-size: 12px;
      color: var(--unity-panel-muted);
    }
    #${PANEL_ID} .unity-transcript {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 2px solid var(--unity-transcript-border);
      border-radius: 10px;
      background: var(--unity-transcript-bg);
      margin: 0 24px 24px;
      padding: 8px;
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
      padding: 8px;
      background: var(--unity-transcript-row-bg);
    }
    #${PANEL_ID} .unity-transcript-row[data-current="true"] {
      border-color: var(--unity-transcript-current-border);
      box-shadow: 0 0 0 1px var(--unity-transcript-current-shadow);
      background: var(--unity-transcript-current-bg);
    }
    #${PANEL_ID} .unity-ts-btn {
      border: 2px solid var(--unity-transcript-btn-border);
      background: var(--unity-transcript-btn-bg);
      color: var(--unity-transcript-btn-text);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      padding: 5px 8px;
      cursor: pointer;
      white-space: nowrap;
      min-width: 58px;
      text-align: center;
      transition: all 0.2s ease;
    }
    #${PANEL_ID} .unity-ts-btn:hover {
      border-color: var(--unity-panel-btn-hover);
      background: var(--unity-panel-btn-hover-bg);
      color: var(--unity-panel-btn-hover-text);
    }
    #${PANEL_ID} .unity-transcript-text {
      margin: 0;
      font-size: 13px;
      line-height: 1.4;
      color: var(--unity-transcript-text);
      cursor: pointer;
    }
    .ytp-progress-bar-container[${TIMELINE_MARKER_HOST_ATTR}="true"] {
      position: relative;
    }
    .${TIMELINE_MARKER_LAYER_CLASS} {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 9999;
    }
    .${TIMELINE_MARKER_CLASS} {
      position: absolute;
      top: 0;
      bottom: 0;
      min-width: 2px;
      border-radius: 999px;
      background: rgba(255, 242, 0, 0.9);
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.45),
        0 0 6px rgba(0, 0, 0, 0.22);
      opacity: 1;
      z-index: 10000;
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
  root.setAttribute(MOTION_EXEMPT_ATTR, 'true');
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
    let timelineMarkerHost: HTMLElement | null = null;
    let timelineMarkerFingerprint = '';
    let activeTab: 'chat' | 'transcript' = 'chat';
    let localOptimisticMessages: LocalOptimisticChatMessage[] = [];
    let activeSourceMessageId: string | null = null;
    let activeSourceMessageRanges: TimelineSourceRange[] = [];
    let lastSeenAssistantMessageId: string | null = null;
    let assistantPriorityPrimed = false;

    let composerFocused = false;
    let composerSelectionStart = 0;
    let composerSelectionEnd = 0;
    let lastRenderedFingerprint = '';
    let lastRenderedChatFingerprint = '';

    const getDisplayTranscriptSegments = (): TranscriptSegment[] => {
      const reported = report?.transcript?.segments ?? [];
      return reported.length > 0 ? reported : transcriptSegments;
    };

    const getRenderedChatMessages = (): RenderedChatMessage[] => {
      const persistedMessages = session?.messages ?? [];
      const merged = [...persistedMessages, ...localOptimisticMessages];
      if (merged.length < 2) return merged;
      return [...merged].sort(compareMessagesByCreatedAt);
    };

    const resolveMessageSourceRanges = (sources: SourceSnippet[]): TimelineSourceRange[] => {
      const orderedSegments = getDisplayTranscriptSegments()
        .filter((segment) => Number.isFinite(segment.startSec) && segment.startSec >= 0)
        .sort((left, right) => left.startSec - right.startSec);

      const ranges: TimelineSourceRange[] = [];
      for (const source of sources) {
        const rangeFromLabel = parseTimestampRangeLabel(source.timestampLabel);
        const sourceLabel = source.timestampLabel?.trim() ?? '';
        const canParseSingleLabel = sourceLabel.length > 0 && !/[-–—]/.test(sourceLabel);
        const parsedSingleLabelSec = canParseSingleLabel ? parseTimestampLabelToSeconds(sourceLabel) : null;
        const rawStartSec =
          typeof source.timestampSec === 'number' &&
          Number.isFinite(source.timestampSec) &&
          source.timestampSec >= 0
            ? source.timestampSec
            : rangeFromLabel?.startSec ?? (parsedSingleLabelSec ?? null);
        if (rawStartSec == null) continue;

        const startSec = Math.max(0, rawStartSec);
        let endSec: number | null = null;
        let endLabel: string | null = null;

        if (rangeFromLabel && rangeFromLabel.endSec > startSec + SOURCE_RANGE_MIN_DURATION_SECONDS) {
          endSec = rangeFromLabel.endSec;
          endLabel = rangeFromLabel.endLabel;
        } else {
          const nextSegment = orderedSegments.find(
            (segment) => segment.startSec > startSec + SOURCE_RANGE_MIN_DURATION_SECONDS,
          );
          if (nextSegment) {
            endSec = nextSegment.startSec;
            endLabel = nextSegment.startLabel;
          }
        }

        if (endSec == null || endSec <= startSec + SOURCE_RANGE_MIN_DURATION_SECONDS) {
          endSec = startSec + SOURCE_RANGE_FALLBACK_SECONDS;
          endLabel = formatSecondsLabel(endSec);
        }

        const startLabel = rangeFromLabel?.startLabel ?? (canParseSingleLabel ? sourceLabel : formatSecondsLabel(startSec));
        ranges.push({
          startSec,
          endSec,
          startLabel,
          endLabel: endLabel ?? formatSecondsLabel(endSec),
        });
      }

      return mergeTimelineSourceRanges(ranges);
    };

    const clearSourceTimelineMarkers = (clearActive = false) => {
      if (timelineMarkerHost) {
        timelineMarkerHost
          .querySelector<HTMLElement>(`.${TIMELINE_MARKER_LAYER_CLASS}`)
          ?.remove();
        timelineMarkerHost.removeAttribute(TIMELINE_MARKER_HOST_ATTR);
      } else {
        const looseLayers = document.querySelectorAll<HTMLElement>(`.${TIMELINE_MARKER_LAYER_CLASS}`);
        for (const layer of looseLayers) {
          layer.remove();
        }
        const hosts = document.querySelectorAll<HTMLElement>(
          `.ytp-progress-bar-container[${TIMELINE_MARKER_HOST_ATTR}="true"]`,
        );
        for (const host of hosts) {
          host.removeAttribute(TIMELINE_MARKER_HOST_ATTR);
        }
      }

      timelineMarkerHost = null;
      timelineMarkerFingerprint = '';
      if (clearActive) {
        activeSourceMessageId = null;
        activeSourceMessageRanges = [];
      }
    };

    const updateSourceTimelineMarkers = () => {
      if (!isWatchUrl(location.href) || isYouTubeFullscreen()) {
        clearSourceTimelineMarkers();
        return;
      }

      const video = document.querySelector<HTMLVideoElement>('video');
      const measuredDurationSec = video?.duration ?? Number.NaN;
      const transcriptEndSec = getDisplayTranscriptSegments().reduce(
        (max, segment) => Math.max(max, segment.startSec),
        0,
      );
      const rangeEndSec = activeSourceMessageRanges.reduce(
        (max, range) => Math.max(max, range.endSec),
        0,
      );
      const inferredDurationSec = Math.max(transcriptEndSec, rangeEndSec);
      const durationSec =
        Number.isFinite(measuredDurationSec) && measuredDurationSec > SOURCE_RANGE_MIN_DURATION_SECONDS
          ? measuredDurationSec
          : inferredDurationSec > SOURCE_RANGE_MIN_DURATION_SECONDS
            ? inferredDurationSec
            : Number.NaN;

      if (
        !video ||
        !Number.isFinite(durationSec) ||
        durationSec <= SOURCE_RANGE_MIN_DURATION_SECONDS ||
        activeSourceMessageRanges.length === 0
      ) {
        clearSourceTimelineMarkers();
        return;
      }

      const clampedRanges = mergeTimelineSourceRanges(
        activeSourceMessageRanges
          .map((range) => {
            const maxStart = Math.max(0, durationSec - SOURCE_RANGE_MIN_DURATION_SECONDS);
            const cappedStart = Math.max(0, Math.min(maxStart, range.startSec));
            const boundedEnd = Math.max(
              cappedStart + SOURCE_RANGE_MIN_DURATION_SECONDS,
              Math.min(durationSec, range.endSec),
            );
            const cappedEnd = Math.min(durationSec, boundedEnd);
            if (cappedEnd <= cappedStart + SOURCE_RANGE_MIN_DURATION_SECONDS) return null;
            return {
              ...range,
              startSec: cappedStart,
              endSec: cappedEnd,
            } satisfies TimelineSourceRange;
          })
          .filter((range): range is TimelineSourceRange => range != null),
      );
      if (clampedRanges.length === 0) {
        clearSourceTimelineMarkers();
        return;
      }

      const player = video.closest<HTMLElement>('.html5-video-player');
      const nextHost = player?.querySelector<HTMLElement>('.ytp-progress-bar-container') ?? null;
      if (!nextHost) {
        clearSourceTimelineMarkers();
        return;
      }

      const markerFingerprint = [
        getVideoIdFromUrl(location.href) ?? '',
        durationSec.toFixed(3),
        activeSourceMessageId ?? '',
        ...clampedRanges.map(
          (range) => `${range.startSec.toFixed(3)}-${range.endSec.toFixed(3)}:${range.startLabel}:${range.endLabel}`,
        ),
      ].join('|');

      if (timelineMarkerHost === nextHost && timelineMarkerFingerprint === markerFingerprint) {
        return;
      }

      if (timelineMarkerHost && timelineMarkerHost !== nextHost) {
        timelineMarkerHost
          .querySelector<HTMLElement>(`.${TIMELINE_MARKER_LAYER_CLASS}`)
          ?.remove();
        timelineMarkerHost.removeAttribute(TIMELINE_MARKER_HOST_ATTR);
      }

      let layer = nextHost.querySelector<HTMLElement>(`.${TIMELINE_MARKER_LAYER_CLASS}`);
      if (!layer) {
        layer = document.createElement('div');
        layer.className = TIMELINE_MARKER_LAYER_CLASS;
      }
      nextHost.appendChild(layer);
      nextHost.setAttribute(TIMELINE_MARKER_HOST_ATTR, 'true');

      layer.innerHTML = '';
      for (const range of clampedRanges) {
        const marker = document.createElement('span');
        marker.className = TIMELINE_MARKER_CLASS;
        marker.setAttribute('data-testid', TIMELINE_MARKER_TEST_ID);
        marker.dataset.messageId = activeSourceMessageId ?? '';
        marker.dataset.startSec = range.startSec.toFixed(3);
        marker.dataset.endSec = range.endSec.toFixed(3);
        marker.title = `${range.startLabel} - ${range.endLabel}`;

        const startPercent = Math.max(0, Math.min(100, (range.startSec / durationSec) * 100));
        const endPercent = Math.max(0, Math.min(100, (range.endSec / durationSec) * 100));
        const widthPercent = Math.max(0.25, endPercent - startPercent);
        marker.style.left = `${startPercent}%`;
        marker.style.width = `${widthPercent}%`;
        layer.appendChild(marker);
      }

      timelineMarkerHost = nextHost;
      timelineMarkerFingerprint = markerFingerprint;
    };

    const syncActiveSourceSelection = () => {
      if (!activeSourceMessageId) return;
      const messages = getRenderedChatMessages();
      const activeMessage = messages.find(
        (message) => message.id === activeSourceMessageId && message.role === 'assistant',
      );
      if (!activeMessage) {
        activeSourceMessageId = null;
        activeSourceMessageRanges = [];
        return;
      }

      const timestampSources = (activeMessage.sources ?? []).filter(hasTimestampSource);
      if (timestampSources.length === 0) {
        activeSourceMessageId = null;
        activeSourceMessageRanges = [];
        return;
      }

      activeSourceMessageRanges = resolveMessageSourceRanges(timestampSources);
      if (activeSourceMessageRanges.length === 0) {
        activeSourceMessageId = null;
      }
    };

    const getLatestAssistantMessage = (
      messages: RenderedChatMessage[],
    ): RenderedChatMessage | null => {
      if (messages.length === 0) return null;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role === 'assistant') return message;
      }
      return null;
    };

    const applyLatestAssistantPriority = (options?: { force?: boolean; primeOnly?: boolean }) => {
      const force = options?.force === true;
      const primeOnly = options?.primeOnly === true;
      const messages = getRenderedChatMessages();
      const latestAssistant = getLatestAssistantMessage(messages);

      if (!latestAssistant) {
        lastSeenAssistantMessageId = null;
        if (!primeOnly) {
          activeSourceMessageId = null;
          activeSourceMessageRanges = [];
        }
        return;
      }

      if (primeOnly) {
        lastSeenAssistantMessageId = latestAssistant.id;
        return;
      }

      if (!force && lastSeenAssistantMessageId === latestAssistant.id) {
        return;
      }

      lastSeenAssistantMessageId = latestAssistant.id;
      const timestampSources = (latestAssistant.sources ?? []).filter(hasTimestampSource);
      if (timestampSources.length === 0) {
        activeSourceMessageId = null;
        activeSourceMessageRanges = [];
        return;
      }

      const ranges = resolveMessageSourceRanges(timestampSources);
      activeSourceMessageRanges = ranges;
      activeSourceMessageId = ranges.length > 0 ? latestAssistant.id : null;
    };

    const viewFingerprint = (): string => [
      statusFingerprint(status),
      reportFingerprint(report),
      sessionFingerprint(session),
      localOptimisticMessages.map((message) => `${message.id}:${message.localState}`).join(','),
      transcriptSegments.length,
      transcriptLoading ? '1' : '0',
      transcriptResolved ? '1' : '0',
      transcriptError ?? '',
      isAsking ? '1' : '0',
      dictationSupported ? '1' : '0',
      dictationActive ? '1' : '0',
      localError ?? '',
      question,
      activeTab,
      activeSourceMessageId ?? '',
      activeSourceMessageRanges
        .map((range) => `${range.startSec.toFixed(2)}-${range.endSec.toFixed(2)}`)
        .join(','),
      lastSeenAssistantMessageId ?? '',
      assistantPriorityPrimed ? '1' : '0',
    ].join('|');

    const ensurePanelMounted = () => {
      if (!isWatchUrl(location.href)) {
        if (dictationActive) {
          stopDictation();
        }
        localOptimisticMessages = [];
        lastRenderedChatFingerprint = '';
        lastSeenAssistantMessageId = null;
        assistantPriorityPrimed = false;
        clearSourceTimelineMarkers(true);
        panelRoot?.remove();
        panelRoot = null;
        return;
      }

      if (isYouTubeFullscreen()) {
        if (dictationActive) {
          stopDictation();
        }
        localOptimisticMessages = [];
        lastRenderedChatFingerprint = '';
        clearSourceTimelineMarkers(true);
        panelRoot?.remove();
        panelRoot = null;
        return;
      }

      const host = findPanelHost();
      if (!host) return;

      if (!panelRoot || !panelRoot.isConnected) {
        panelRoot = createPanelRoot();
      }

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
      updateSourceTimelineMarkers();
    };

    const syncVideoListener = () => {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (video === watchedVideo) return;

      if (watchedVideo) {
        watchedVideo.removeEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('seeked', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('loadedmetadata', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('durationchange', onVideoTimelineUpdate);
      }

      watchedVideo = video;
      if (watchedVideo) {
        watchedVideo.addEventListener('timeupdate', onVideoTimelineUpdate);
        watchedVideo.addEventListener('seeking', onVideoTimelineUpdate);
        watchedVideo.addEventListener('seeked', onVideoTimelineUpdate);
        watchedVideo.addEventListener('loadedmetadata', onVideoTimelineUpdate);
        watchedVideo.addEventListener('durationchange', onVideoTimelineUpdate);
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
      if (assistantPriorityPrimed) {
        applyLatestAssistantPriority();
      }
      syncActiveSourceSelection();

      const nextFingerprint = viewFingerprint();
      if (panelRoot.childElementCount > 0 && nextFingerprint === lastRenderedFingerprint) {
        updateCurrentTranscriptHighlight();
        updateSourceTimelineMarkers();
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
      titleWrap.className = 'unity-head-title';
      const title = document.createElement('p');
      title.className = 'unity-title';
      title.textContent = 'Unity';
      titleWrap.append(title);

      const headActions = document.createElement('div');
      headActions.className = 'unity-head-actions';

      const isScanning = status.state === 'extracting' || status.state === 'analyzing';
      const scanBtn = document.createElement('button');
      scanBtn.className = 'unity-icon-btn';
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

      const clearChat = () => {
        if (tabId == null) return;
        void (async () => {
          localError = null;
          try {
            await sendRuntimeMessageWithRetry<{ type: 'CLEAR_CHAT_SESSION'; tabId: number }, { ok: boolean }>({
              type: 'CLEAR_CHAT_SESSION',
              tabId,
            });
            session = session ? { ...session, messages: [] } : null;
            localOptimisticMessages = [];
            lastRenderedChatFingerprint = '';
          } catch (error) {
            localError = error instanceof Error ? error.message : 'Failed to clear chat.';
          }
          render();
        })();
      };

      headActions.append(scanBtn);
      head.append(titleWrap, headActions);

      const body = document.createElement('div');
      body.className = 'unity-body';

      const tabs = document.createElement('div');
      tabs.className = 'unity-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Panel sections');

      const chatTab = document.createElement('button');
      chatTab.type = 'button';
      chatTab.className = 'unity-tab';
      chatTab.dataset.active = String(activeTab === 'chat');
      chatTab.setAttribute('role', 'tab');
      chatTab.setAttribute('aria-selected', String(activeTab === 'chat'));
      chatTab.textContent = 'Chat';
      chatTab.addEventListener('click', () => {
        if (activeTab === 'chat') return;
        activeTab = 'chat';
        composerFocused = true;
        render();
      });

      const transcriptTab = document.createElement('button');
      transcriptTab.type = 'button';
      transcriptTab.className = 'unity-tab';
      transcriptTab.dataset.active = String(activeTab === 'transcript');
      transcriptTab.setAttribute('role', 'tab');
      transcriptTab.setAttribute('aria-selected', String(activeTab === 'transcript'));
      transcriptTab.textContent = 'Transcript';
      transcriptTab.addEventListener('click', () => {
        if (activeTab === 'transcript') return;
        activeTab = 'transcript';
        composerFocused = false;
        render();
      });

      tabs.append(chatTab, transcriptTab);
      body.appendChild(tabs);

      let input: HTMLTextAreaElement | null = null;
      let chatList: HTMLElement | null = null;
      let chatMessageFingerprint = '';
      if (activeTab === 'chat') {
        const chatPanel = document.createElement('section');
        chatPanel.className = 'unity-tab-panel unity-tab-panel--chat';

        const chat = document.createElement('div');
        chat.className = 'unity-chat';
        chat.setAttribute('data-testid', 'unity-chat-list');
        chatList = chat;

        const messages = getRenderedChatMessages();
        chatMessageFingerprint = messages
          .map((message) => {
            const localState = 'localState' in message ? message.localState : '';
            return `${message.id}:${localState}`;
          })
          .join('|');
        if (messages.length > 0) {
          for (const message of messages) {
            const bubble = document.createElement('article');
            const isAssistant = message.role === 'assistant';
            const timestampSources = isAssistant
              ? (message.sources ?? []).filter(hasTimestampSource)
              : [];
            const localState =
              !isAssistant && 'localState' in message ? message.localState : undefined;
            const failedState = localState === 'failed' ? 'failed' : undefined;
            bubble.className = [
              'unity-bubble',
              `unity-bubble--${isAssistant ? 'assistant' : 'user'}`,
              failedState ? `unity-bubble--${failedState}` : '',
            ]
              .filter(Boolean)
              .join(' ');
            bubble.dataset.localState = failedState ?? '';
            bubble.dataset.messageId = message.id;
            bubble.dataset.role = message.role;
            bubble.dataset.hasSourceRanges = String(timestampSources.length > 0);
            bubble.dataset.rangeActive = String(activeSourceMessageId === message.id);
            bubble.setAttribute('data-testid', 'unity-chat-message');

            const bubbleHead = document.createElement('div');
            bubbleHead.className = 'unity-bubble-head';
            const speaker = document.createElement('span');
            speaker.textContent = isAssistant ? 'Unity' : 'You';
            const ts = document.createElement('span');
            ts.textContent = formatTime(message.createdAt);
            bubbleHead.append(speaker, ts);

            const text = document.createElement('p');
            text.className = 'unity-bubble-text';
            text.textContent = message.text;

            bubble.append(bubbleHead, text);

            if (isAssistant && timestampSources.length > 0) {
              bubble.addEventListener('click', () => {
                activeSourceMessageId = message.id;
                activeSourceMessageRanges = resolveMessageSourceRanges(timestampSources);
                render();
              });
            }

            if (!isAssistant && failedState) {
              const stateLine = document.createElement('p');
              stateLine.className = `unity-bubble-local-state unity-bubble-local-state--${failedState}`;
              stateLine.textContent = 'Send failed';
              bubble.appendChild(stateLine);
            }

            if (isAssistant && (message.sources?.length ?? 0) > 0) {
              const sourceRow = document.createElement('div');
              sourceRow.className = 'unity-source-row';
              for (let index = 0; index < (message.sources?.length ?? 0); index += 1) {
                const source = message.sources![index];
                const sourceBtn = document.createElement('button');
                sourceBtn.type = 'button';
                sourceBtn.className = 'unity-source';
                sourceBtn.textContent = sourceLabel(source, index);
                sourceBtn.title = source.text;
                sourceBtn.addEventListener('click', (event) => {
                  event.preventDefault();
                  event.stopPropagation();
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

        chatPanel.appendChild(chat);

        const compose = document.createElement('form');
        compose.className = 'unity-compose';
        compose.addEventListener('submit', (event) => {
          event.preventDefault();
          const trimmedQuestion = question.trim();
          if (isAsking || !trimmedQuestion) return;
          if (dictationActive) {
            stopDictation();
          }

          const optimisticMessageId = createLocalMessageId('user');
          const optimisticMessage: LocalOptimisticChatMessage = {
            id: optimisticMessageId,
            role: 'user',
            text: trimmedQuestion,
            createdAt: new Date().toISOString(),
            localState: 'pending',
            localOnly: true,
          };

          void (async () => {
            localOptimisticMessages = [...localOptimisticMessages, optimisticMessage].sort(compareMessagesByCreatedAt);
            question = '';
            composerSelectionStart = 0;
            composerSelectionEnd = 0;
            composerFocused = true;
            isAsking = true;
            localError = null;
            render();

            try {
              const response = await sendRuntimeMessageWithRetry<
                { type: 'ASK_CHAT_QUESTION'; question: string; tabId?: number },
                { ok: boolean; session?: ChatSession; error?: string }
              >({
                type: 'ASK_CHAT_QUESTION',
                question: trimmedQuestion,
                ...(tabId ? { tabId } : {}),
              });

              if (!response.ok || !response.session) {
                throw new Error(response.error || 'Failed to answer question.');
              }

              session = response.session;
              assistantPriorityPrimed = true;
              applyLatestAssistantPriority({ force: true });
              localOptimisticMessages = localOptimisticMessages.filter(
                (message) => message.id !== optimisticMessageId,
              );
            } catch (error) {
              localOptimisticMessages = localOptimisticMessages.map((message) =>
                message.id === optimisticMessageId ? { ...message, localState: 'failed' } : message,
              );
              localError = error instanceof Error ? error.message : 'Question failed.';
            } finally {
              isAsking = false;
              render();
            }
          })();
        });

        const composeInput = document.createElement('textarea');
        composeInput.value = question;
        composeInput.placeholder = 'Ask a question about this video...';
        composeInput.disabled = isAsking;
        composeInput.setAttribute('data-testid', 'unity-composer-input');
        let askButton: HTMLButtonElement | null = null;
        const syncAskButtonState = () => {
          if (!askButton) return;
          askButton.disabled = isAsking || !question.trim();
        };
        composeInput.addEventListener('focus', () => {
          composerFocused = true;
          captureComposerSelection(composeInput);
        });
        composeInput.addEventListener('blur', () => {
          composerFocused = false;
        });
        composeInput.addEventListener('input', () => {
          question = composeInput.value;
          captureComposerSelection(composeInput);
          syncAskButtonState();
        });
        composeInput.addEventListener('keyup', () => {
          captureComposerSelection(composeInput);
        });
        composeInput.addEventListener('click', () => {
          captureComposerSelection(composeInput);
        });
        composeInput.addEventListener('select', () => {
          captureComposerSelection(composeInput);
        });

        const composeActions = document.createElement('div');
        composeActions.className = 'unity-compose-actions';

        const clearChatButton = document.createElement('button');
        clearChatButton.type = 'button';
        clearChatButton.className = 'unity-ghost-btn';
        clearChatButton.textContent = 'Clear';
        clearChatButton.disabled = messages.length === 0;
        clearChatButton.addEventListener('click', clearChat);

        const dictationButton = document.createElement('button');
        dictationButton.type = 'button';
        dictationButton.className = 'unity-icon-btn unity-icon-btn--dictation';
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
        askButton.className = 'unity-primary-btn';
        askButton.textContent = isAsking ? 'Asking...' : 'Ask';
        syncAskButtonState();

        const composeSubmitActions = document.createElement('div');
        composeSubmitActions.className = 'unity-compose-submit-actions';
        composeSubmitActions.append(dictationButton, askButton);
        composeActions.append(clearChatButton, composeSubmitActions);

        compose.append(composeInput, composeActions);
        chatPanel.appendChild(compose);
        body.appendChild(chatPanel);
        input = composeInput;
      } else {
        const transcriptPanel = document.createElement('section');
        transcriptPanel.className = 'unity-tab-panel unity-tab-panel--transcript';

        if (report?.transcript?.unavailableReason && !transcriptLoading) {
          const transcriptWarning = document.createElement('p');
          transcriptWarning.className = 'unity-note';
          transcriptWarning.textContent = `Transcript note: ${report.transcript.unavailableReason}`;
          transcriptPanel.appendChild(transcriptWarning);
        }

        const transcriptHead = document.createElement('div');
        transcriptHead.className = 'unity-transcript-head';
        const transcriptMeta = document.createElement('p');
        transcriptMeta.className = 'unity-transcript-meta';
        transcriptMeta.textContent = transcriptLoading
          ? 'Loading...'
          : `${getDisplayTranscriptSegments().length} lines`;
        transcriptHead.append(transcriptMeta);
        transcriptPanel.appendChild(transcriptHead);

        if (transcriptError && !transcriptLoading) {
          const transcriptErrorLine = document.createElement('p');
          transcriptErrorLine.className = 'unity-note';
          transcriptErrorLine.textContent = transcriptError;
          transcriptPanel.appendChild(transcriptErrorLine);
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

        transcriptPanel.appendChild(transcriptWrap);
        body.appendChild(transcriptPanel);
      }

      if (localError) {
        const error = document.createElement('p');
        error.className = 'unity-error';
        error.textContent = localError;
        body.appendChild(error);
      }

      panelRoot.append(head, body);

      if (shouldRestoreComposerFocus && input) {
        const max = input.value.length;
        const start = Math.max(0, Math.min(restoreStart, max));
        const end = Math.max(start, Math.min(restoreEnd, max));
        window.requestAnimationFrame(() => {
          if (!panelRoot || !panelRoot.isConnected) return;
          input.focus();
          input.setSelectionRange(start, end);
        });
      }

      if (activeTab === 'chat' && chatList) {
        const shouldAutoScroll =
          chatMessageFingerprint !== '' && chatMessageFingerprint !== lastRenderedChatFingerprint;
        if (shouldAutoScroll) {
          window.requestAnimationFrame(() => {
            if (!chatList || !chatList.isConnected) return;
            chatList.scrollTop = chatList.scrollHeight;
          });
        }
        lastRenderedChatFingerprint = chatMessageFingerprint;
      }

      updateCurrentTranscriptHighlight();
      updateSourceTimelineMarkers();
    };

    const onFullscreenChange = () => {
      if (!isWatchUrl(location.href)) return;

      if (isYouTubeFullscreen()) {
        if (dictationActive) {
          stopDictation();
        }
        localOptimisticMessages = [];
        lastRenderedChatFingerprint = '';
        clearSourceTimelineMarkers(true);
        panelRoot?.remove();
        panelRoot = null;
        return;
      }

      ensurePanelMounted();
      syncVideoListener();
      render();
    };

    const applyEmbeddedResponse = (response: EmbeddedStateResponse) => {
      const previousSessionKey = sessionFingerprint(session);
      tabId = response.tabId ?? tabId;
      const currentUrl = location.href;
      const currentVideoId = getVideoIdFromUrl(currentUrl);

      const nextReport = response.report;
      const reportMatchesCurrentUrl = nextReport
        ? urlsRepresentSameResource(
          nextReport.url,
          currentUrl,
          nextReport.videoId ?? null,
          currentVideoId,
        )
        : false;

      const nextSession = response.session;
      const sessionMatchesCurrentUrl = nextSession
        ? urlsRepresentSameResource(nextSession.url, currentUrl, undefined, currentVideoId)
        : false;

      if ((nextReport && !reportMatchesCurrentUrl) || (nextSession && !sessionMatchesCurrentUrl)) {
        status = {
          state: 'idle',
          progress: 0,
          message: isWatchUrl(currentUrl) ? 'Ready to scan this video.' : 'Ready to scan this tab.',
          updatedAt: Date.now(),
        };
      } else {
        status = response.status ?? status;
      }

      report = reportMatchesCurrentUrl ? nextReport : null;
      session = sessionMatchesCurrentUrl ? nextSession : null;
      const nextSessionKey = sessionFingerprint(session);
      const sessionChanged = previousSessionKey !== nextSessionKey;
      if (sessionChanged) {
        if (!assistantPriorityPrimed) {
          const hasExistingSelection =
            activeSourceMessageId !== null ||
            activeSourceMessageRanges.length > 0 ||
            lastSeenAssistantMessageId !== null;
          applyLatestAssistantPriority({ primeOnly: !hasExistingSelection });
          assistantPriorityPrimed = true;
        } else {
          applyLatestAssistantPriority();
        }
      }

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
          updateSourceTimelineMarkers();
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
        updateSourceTimelineMarkers();
      }
    };

    ext.runtime.onMessage.addListener(onMessage as any);

    initializeDictation();
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange as EventListener);
    ensurePanelMounted();
    syncVideoListener();
    render();
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
        updateSourceTimelineMarkers();
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
            watchedVideo.removeEventListener('loadedmetadata', onVideoTimelineUpdate);
            watchedVideo.removeEventListener('durationchange', onVideoTimelineUpdate);
            watchedVideo = null;
          }
          lastSeenAssistantMessageId = null;
          assistantPriorityPrimed = false;
          clearSourceTimelineMarkers(true);
          localOptimisticMessages = [];
          lastRenderedChatFingerprint = '';
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
        localOptimisticMessages = [];
        question = '';
        isAsking = false;
        localError = null;
        dictationActive = false;

        transcriptSegments = [];
        transcriptLoading = false;
        transcriptResolved = false;
        transcriptError = null;
        activeTranscriptSegmentId = null;
        activeSourceMessageId = null;
        activeSourceMessageRanges = [];
        lastSeenAssistantMessageId = null;
        assistantPriorityPrimed = false;
        clearSourceTimelineMarkers();

        composerFocused = false;
        composerSelectionStart = 0;
        composerSelectionEnd = 0;
        lastRenderedFingerprint = '';
        lastRenderedChatFingerprint = '';

        ensurePanelMounted();
        syncVideoListener();
        render();
        void loadEmbeddedState();
        void loadTranscript(true);
      } else {
        ensurePanelMounted();
        syncVideoListener();
        updateCurrentTranscriptHighlight();
        updateSourceTimelineMarkers();
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
        watchedVideo.removeEventListener('loadedmetadata', onVideoTimelineUpdate);
        watchedVideo.removeEventListener('durationchange', onVideoTimelineUpdate);
      }
      clearSourceTimelineMarkers(true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange as EventListener);
      ext.runtime.onMessage.removeListener(onMessage as any);
    });
  },
});
