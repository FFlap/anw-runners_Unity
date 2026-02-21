import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Pause, Play, RotateCcw, Send, Settings, Square, Trash2, Volume2 } from 'lucide-react';
import {
  getAudioFollowModeEnabled,
  getAudioRate,
  getColorBlindModeEnabled,
  setAudioFollowModeEnabled,
  setAudioRate,
  setColorBlindModeEnabled,
} from '@/lib/storage';
import type {
  ChatMessage,
  ChatSession,
  RuntimeRequest,
  ScanReport,
  ScanStatus,
  SourceSnippet,
} from '@/lib/types';

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;
const API_KEY_STORAGE_KEY = 'openrouter_api_key';
const LEGACY_API_KEY_STORAGE_KEY = 'gemini_api_key';

type SettingsResponse = { hasApiKey: boolean };
type ReportResponse = { report: ScanReport | null };
type SessionResponse = { session: ChatSession | null };
type AskResponse = {
  ok: boolean;
  answer?: ChatMessage;
  session?: ChatSession;
  error?: string;
};
type PopupTab = 'chat' | 'audio';
type AudioTabMessage =
  | { type: 'AUDIO_GET_STATE' }
  | { type: 'AUDIO_GET_SELECTION' }
  | { type: 'AUDIO_READ_SELECTION'; rate?: number; followMode?: boolean }
  | { type: 'AUDIO_PLAY' }
  | { type: 'AUDIO_PAUSE' }
  | { type: 'AUDIO_STOP' }
  | { type: 'AUDIO_SET_RATE'; rate: number }
  | { type: 'AUDIO_SET_FOLLOW_MODE'; enabled: boolean };
type AudioState = {
  available: boolean;
  hasSelection: boolean;
  selectionText: string;
  isSpeaking: boolean;
  isPaused: boolean;
  rate: number;
  followMode: boolean;
  currentLineIndex: number;
  totalLines: number;
  currentLineText: string;
};
type AudioResponse = {
  ok: boolean;
  state?: AudioState;
  error?: string;
};

const runningStates = new Set<ScanStatus['state']>(['extracting', 'analyzing', 'highlighting']);

const defaultAudioState: AudioState = {
  available: true,
  hasSelection: false,
  selectionText: '',
  isSpeaking: false,
  isPaused: false,
  rate: 1,
  followMode: false,
  currentLineIndex: -1,
  totalLines: 0,
  currentLineText: '',
};

async function sendMessage<T>(message: RuntimeRequest): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = (await ext.runtime.sendMessage(message)) as T | undefined;
      if (typeof response !== 'undefined') {
        return response;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 80));
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Background service is temporarily unavailable.');
}

async function sendTabMessage<T>(tabId: number, message: AudioTabMessage): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = (await ext.tabs.sendMessage(tabId, message)) as T | undefined;
      if (typeof response !== 'undefined') {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 80));
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Unable to reach the page. Refresh the tab and try again.');
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function sourceLabel(source: SourceSnippet, index: number): string {
  if (source.timestampLabel) {
    return `Jump ${source.timestampLabel}`;
  }
  return `Source ${index + 1}`;
}

function SettingsModal({
  open,
  onClose,
  hasApiKey,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  hasApiKey: boolean;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState('');

  const saveKey = useCallback(async () => {
    if (!apiKey.trim()) {
      setMessage('Please enter a valid OpenRouter API key.');
      return;
    }

    setIsSaving(true);
    try {
      const trimmed = apiKey.trim();
      await ext.storage.local.set({
        [API_KEY_STORAGE_KEY]: trimmed,
        [LEGACY_API_KEY_STORAGE_KEY]: trimmed,
      });
      await sendMessage<{ ok: boolean; hasApiKey: boolean }>({ type: 'SAVE_API_KEY', apiKey: trimmed });
      setMessage('API key saved.');
      setApiKey('');
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to save key.');
    } finally {
      setIsSaving(false);
    }
  }, [apiKey, onSaved]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>OpenRouter Key</h2>
          <button type="button" className="ghost-btn" onClick={onClose}>Close</button>
        </div>
        <p className="modal-note">
          Stored locally in your browser. {hasApiKey ? 'A key is already configured.' : 'No key configured yet.'}
        </p>
        <div className="modal-row">
          <input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setMessage('');
            }}
            placeholder="Paste OpenRouter API key"
            className="text-input"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveKey();
              }
            }}
          />
          <button type="button" className="primary-btn" disabled={isSaving || !apiKey.trim()} onClick={() => void saveKey()}>
            {isSaving ? <LoaderCircle className="spin" size={14} /> : 'Save'}
          </button>
        </div>
        {message && <p className="modal-feedback">{message}</p>}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onJump,
}: {
  message: ChatMessage;
  onJump: (source: SourceSnippet) => void;
}) {
  const isAssistant = message.role === 'assistant';

  return (
    <article className={`bubble ${isAssistant ? 'bubble--assistant' : 'bubble--user'}`}>
      <div className="bubble-head">
        <span>{isAssistant ? 'Unity' : 'You'}</span>
        <time>{formatTimestamp(message.createdAt)}</time>
      </div>
      <p className="bubble-text">{message.text}</p>
      {isAssistant && (message.sources?.length ?? 0) > 0 && (
        <div className="sources-wrap">
          {message.sources?.map((source, index) => (
            <button
              key={`${message.id}-${source.id}-${index}`}
              type="button"
              className="source-chip"
              onClick={() => onJump(source)}
              title={source.text}
            >
              {sourceLabel(source, index)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function App() {
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [status, setStatus] = useState<ScanStatus>({
    state: 'idle',
    progress: 0,
    message: 'Ready to scan this tab.',
    updatedAt: Date.now(),
  });
  const [report, setReport] = useState<ScanReport | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isColorBlindMode, setIsColorBlindMode] = useState(false);
  const [activePane, setActivePane] = useState<PopupTab>('chat');
  const [audioState, setAudioState] = useState<AudioState>(defaultAudioState);
  const [audioRate, setAudioRateState] = useState(1);
  const [audioFollowMode, setAudioFollowModeState] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTabData = useCallback(async (tabId: number) => {
    const [nextStatus, reportResponse, sessionResponse] = await Promise.all([
      sendMessage<ScanStatus>({ type: 'GET_SCAN_STATUS', tabId }),
      sendMessage<ReportResponse>({ type: 'GET_REPORT', tabId }),
      sendMessage<SessionResponse>({ type: 'GET_CHAT_SESSION', tabId }),
    ]);

    setStatus(nextStatus);
    setReport(reportResponse.report);
    setSession(sessionResponse.session);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        const [settings, tabs] = await Promise.all([
          sendMessage<SettingsResponse>({ type: 'GET_SETTINGS' }).catch(() => ({ hasApiKey: false })),
          ext.tabs.query({ active: true, lastFocusedWindow: true }),
        ]);

        if (cancelled) return;

        const tab = tabs[0] ?? null;
        const tabId = typeof tab?.id === 'number' ? tab.id : null;
        setActiveTabId(tabId);
        setActiveTabUrl(typeof tab?.url === 'string' ? tab.url : null);

        const localStorageState = await ext.storage.local.get([
          API_KEY_STORAGE_KEY,
          LEGACY_API_KEY_STORAGE_KEY,
        ]);

        const storageHasKey =
          (typeof localStorageState?.[API_KEY_STORAGE_KEY] === 'string' &&
            localStorageState[API_KEY_STORAGE_KEY].trim().length > 0) ||
          (typeof localStorageState?.[LEGACY_API_KEY_STORAGE_KEY] === 'string' &&
            localStorageState[LEGACY_API_KEY_STORAGE_KEY].trim().length > 0);

        const [nextColorBlindMode, nextAudioRate, nextAudioFollow] = await Promise.all([
          getColorBlindModeEnabled(),
          getAudioRate(),
          getAudioFollowModeEnabled(),
        ]);
        setHasApiKey(storageHasKey || Boolean(settings.hasApiKey));
        setIsColorBlindMode(nextColorBlindMode);
        setAudioRateState(nextAudioRate);
        setAudioFollowModeState(nextAudioFollow);

        if (tabId != null) {
          await refreshTabData(tabId);
        }
      } catch (initError) {
        if (cancelled) return;
        setError(initError instanceof Error ? initError.message : 'Failed to initialize popup.');
      }
    }

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [refreshTabData]);

  useEffect(() => {
    if (activeTabId == null) return;

    const timer = window.setInterval(() => {
      void refreshTabData(activeTabId).catch(() => {
        // Ignore transient wakeup failures.
      });
    }, 1700);

    return () => window.clearInterval(timer);
  }, [activeTabId, refreshTabData]);

  const startScan = useCallback(async () => {
    if (activeTabId == null) return;
    setError(null);
    try {
      await sendMessage<{ ok: boolean; tabId: number }>({ type: 'START_SCAN', tabId: activeTabId });
      await refreshTabData(activeTabId);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : 'Failed to start scan.');
    }
  }, [activeTabId, refreshTabData]);

  const clearChat = useCallback(async () => {
    if (activeTabId == null) return;
    setError(null);
    try {
      await sendMessage<{ ok: boolean }>({ type: 'CLEAR_CHAT_SESSION', tabId: activeTabId });
      setSession((previous) => (previous ? { ...previous, messages: [] } : null));
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Failed to clear chat.');
    }
  }, [activeTabId]);

  const askQuestion = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeTabId == null || !question.trim()) return;

    setError(null);
    setIsAsking(true);

    try {
      const response = await sendMessage<AskResponse>({
        type: 'ASK_CHAT_QUESTION',
        tabId: activeTabId,
        question: question.trim(),
      });

      if (!response.ok || !response.session) {
        throw new Error(response.error || 'Failed to get grounded answer.');
      }

      setSession(response.session);
      setQuestion('');
      await refreshTabData(activeTabId);
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : 'Question failed.');
    } finally {
      setIsAsking(false);
    }
  }, [activeTabId, question, refreshTabData]);

  const jumpToSource = useCallback(async (source: SourceSnippet) => {
    if (activeTabId == null) return;
    setError(null);

    try {
      const response = await sendMessage<{ ok: boolean }>({
        type: 'JUMP_TO_SOURCE_SNIPPET',
        tabId: activeTabId,
        source,
      });

      if (!response.ok) {
        throw new Error('Could not locate source text on the page/video.');
      }
    } catch (jumpError) {
      setError(jumpError instanceof Error ? jumpError.message : 'Jump failed.');
    }
  }, [activeTabId]);

  const refreshAudioState = useCallback(async (tabId?: number | null) => {
    const resolvedTabId = tabId ?? activeTabId;
    if (resolvedTabId == null) return;
    try {
      const response = await sendTabMessage<AudioResponse>(resolvedTabId, { type: 'AUDIO_GET_STATE' });
      if (response?.state) {
        setAudioState(response.state);
        setAudioRateState(response.state.rate);
        setAudioFollowModeState(response.state.followMode);
      }
      if (response && !response.ok && response.error) {
        setError(response.error);
      }
    } catch (audioError) {
      setAudioState((previous) => ({ ...previous, available: false }));
      setError(audioError instanceof Error ? audioError.message : 'Audio controls are unavailable on this tab.');
    }
  }, [activeTabId]);

  const runAudioCommand = useCallback(async (command: AudioTabMessage) => {
    if (activeTabId == null) {
      setError('Open an HTTP(S) tab to use Audio.');
      return;
    }
    setError(null);
    setIsAudioLoading(true);
    try {
      const response = await sendTabMessage<AudioResponse>(activeTabId, command);
      if (!response.ok) {
        throw new Error(response.error || 'Audio action failed.');
      }
      if (response.state) {
        setAudioState(response.state);
        setAudioRateState(response.state.rate);
        setAudioFollowModeState(response.state.followMode);
      } else {
        await refreshAudioState(activeTabId);
      }
    } catch (audioError) {
      setError(audioError instanceof Error ? audioError.message : 'Audio action failed.');
    } finally {
      setIsAudioLoading(false);
    }
  }, [activeTabId, refreshAudioState]);

  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const isRunning = runningStates.has(status.state);
  const hasContext = report != null;
  const modeSwitchId = 'unity-color-blind-mode-switch';

  const toggleColorBlindMode = useCallback(async () => {
    const next = !isColorBlindMode;
    setIsColorBlindMode(next);
    try {
      await setColorBlindModeEnabled(next);
    } catch (saveError) {
      setIsColorBlindMode(!next);
      setError(saveError instanceof Error ? saveError.message : 'Failed to update accessibility mode.');
    }
  }, [isColorBlindMode]);

  const onAudioRateChange = useCallback(async (value: number) => {
    const clamped = Math.max(0.75, Math.min(2, Number(value.toFixed(2))));
    setAudioRateState(clamped);
    try {
      await setAudioRate(clamped);
      if (activeTabId != null) {
        await runAudioCommand({ type: 'AUDIO_SET_RATE', rate: clamped });
      }
    } catch (audioError) {
      setError(audioError instanceof Error ? audioError.message : 'Failed to set playback speed.');
    }
  }, [activeTabId, runAudioCommand]);

  const toggleAudioFollowMode = useCallback(async () => {
    const next = !audioFollowMode;
    setAudioFollowModeState(next);
    try {
      await setAudioFollowModeEnabled(next);
      if (activeTabId != null) {
        await runAudioCommand({ type: 'AUDIO_SET_FOLLOW_MODE', enabled: next });
      }
    } catch (audioError) {
      setAudioFollowModeState(!next);
      setError(audioError instanceof Error ? audioError.message : 'Failed to update Follow Mode.');
    }
  }, [activeTabId, audioFollowMode, runAudioCommand]);

  useEffect(() => {
    if (activeTabId == null || activePane !== 'audio') return;
    void refreshAudioState(activeTabId);

    const timer = window.setInterval(() => {
      void refreshAudioState(activeTabId);
    }, 900);

    return () => window.clearInterval(timer);
  }, [activePane, activeTabId, refreshAudioState]);

  const canUseAudio = activeTabId != null;
  const audioLineLabel =
    audioState.currentLineIndex >= 0 && audioState.totalLines > 0
      ? `Line ${audioState.currentLineIndex + 1} of ${audioState.totalLines}`
      : 'No active transcript line';

  return (
    <div className={`unity-shell ${isColorBlindMode ? 'unity-shell--cbm' : ''}`.trim()}>
      <section className="mode-row">
        <div className="mode-label">
          <span className="mode-label-title">Color Blind Mode</span>
          <span className="mode-label-hint">Adds non-color cues for status and highlights.</span>
        </div>
        <button
          id={modeSwitchId}
          type="button"
          className="mode-switch"
          role="switch"
          aria-checked={isColorBlindMode}
          onClick={() => void toggleColorBlindMode()}
          title="Toggle Color Blind Mode"
        >
          <span className="mode-switch-track" aria-hidden="true">
            <span className="mode-switch-knob" />
          </span>
          <span className="mode-switch-text">{isColorBlindMode ? 'On' : 'Off'}</span>
        </button>
      </section>
      <header className="unity-header">
        <div>
          <p className="kicker">Unity</p>
          <h1>{activePane === 'chat' ? 'Grounded Tab Chat' : 'Audio Reader'}</h1>
        </div>
        <div className="header-actions">
          {activePane === 'chat' ? (
            <button type="button" className="icon-btn" onClick={() => void startScan()} disabled={isRunning || activeTabId == null}>
              <RotateCcw size={14} className={isRunning ? 'spin' : ''} />
            </button>
          ) : (
            <button type="button" className="icon-btn" onClick={() => void refreshAudioState()} disabled={!canUseAudio}>
              <RotateCcw size={14} className={isAudioLoading ? 'spin' : ''} />
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={14} />
          </button>
        </div>
      </header>

      <section className="panel-tabs" role="tablist" aria-label="Extension tools">
        <button
          type="button"
          className={`panel-tab ${activePane === 'chat' ? 'panel-tab--active' : ''}`.trim()}
          role="tab"
          aria-selected={activePane === 'chat'}
          onClick={() => setActivePane('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={`panel-tab ${activePane === 'audio' ? 'panel-tab--active' : ''}`.trim()}
          role="tab"
          aria-selected={activePane === 'audio'}
          onClick={() => setActivePane('audio')}
        >
          Audio
        </button>
      </section>

      {activePane === 'chat' ? (
        <>
          <section className="status-row">
            <span className={`pill pill--${status.state}`}>{status.state}</span>
            <p>{status.message}</p>
          </section>

          {!hasApiKey && (
            <section className="warning-card">
              <p>Add your OpenRouter API key in settings before asking questions.</p>
            </section>
          )}

          {!hasContext && (
            <section className="empty-card">
              <p>Run a scan to prepare this tab for grounded Q&A.</p>
              <button type="button" className="primary-btn" onClick={() => void startScan()} disabled={activeTabId == null || isRunning}>
                {isRunning ? <LoaderCircle size={14} className="spin" /> : 'Scan Tab'}
              </button>
            </section>
          )}

          <section className="chat-feed" data-testid="chat-feed">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>Ask about the current tab. Answers are grounded only in page/video context.</p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble key={message.id} message={message} onJump={jumpToSource} />
              ))
            )}
          </section>

          <form className="composer" onSubmit={askQuestion}>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a question about this tab..."
              disabled={!hasApiKey || activeTabId == null || isAsking}
              rows={3}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void clearChat()}
                disabled={activeTabId == null || messages.length === 0}
              >
                <Trash2 size={14} />
                Clear
              </button>
              <button
                type="submit"
                className="primary-btn"
                disabled={!hasApiKey || activeTabId == null || isAsking || !question.trim()}
              >
                {isAsking ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                Ask
              </button>
            </div>
          </form>
        </>
      ) : (
        <section className="audio-pane">
          <div className="audio-read-row">
            <button
              type="button"
              className="primary-btn"
              onClick={() => void runAudioCommand({ type: 'AUDIO_READ_SELECTION', rate: audioRate, followMode: audioFollowMode })}
              disabled={!canUseAudio || isAudioLoading}
            >
              <Volume2 size={14} />
              Read Selection
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void refreshAudioState()}
              disabled={!canUseAudio || isAudioLoading}
            >
              <RotateCcw size={14} />
              Refresh
            </button>
          </div>

          <div className="audio-controls">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void runAudioCommand({ type: 'AUDIO_PLAY' })}
              disabled={!canUseAudio || isAudioLoading}
            >
              <Play size={14} />
              Play
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void runAudioCommand({ type: 'AUDIO_PAUSE' })}
              disabled={!canUseAudio || isAudioLoading || !audioState.isSpeaking || audioState.isPaused}
            >
              <Pause size={14} />
              Pause
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void runAudioCommand({ type: 'AUDIO_STOP' })}
              disabled={!canUseAudio || isAudioLoading || (!audioState.isSpeaking && !audioState.isPaused)}
            >
              <Square size={14} />
              Stop
            </button>
          </div>

          <div className="audio-slider-row">
            <label htmlFor="audio-rate" className="audio-slider-label">Speed</label>
            <input
              id="audio-rate"
              type="range"
              min={0.75}
              max={2}
              step={0.05}
              value={audioRate}
              onChange={(event) => {
                void onAudioRateChange(Number(event.target.value));
              }}
              disabled={!canUseAudio}
            />
            <span className="audio-rate-value">{audioRate.toFixed(2)}x</span>
          </div>

          <div className="audio-follow-row">
            <label htmlFor="audio-follow-toggle" className="audio-follow-label">
              <span>Follow Mode</span>
              <small>Auto-scroll and center the current spoken line.</small>
            </label>
            <button
              id="audio-follow-toggle"
              type="button"
              className="mode-switch"
              role="switch"
              aria-checked={audioFollowMode}
              onClick={() => void toggleAudioFollowMode()}
              disabled={!canUseAudio}
            >
              <span className="mode-switch-track" aria-hidden="true">
                <span className="mode-switch-knob" />
              </span>
              <span className="mode-switch-text">{audioFollowMode ? 'On' : 'Off'}</span>
            </button>
          </div>

          <div className="audio-status-card">
            <p className="audio-status-line"><strong>Status:</strong> {audioState.isPaused ? 'Paused' : audioState.isSpeaking ? 'Speaking' : 'Idle'}</p>
            <p className="audio-status-line"><strong>{audioLineLabel}</strong></p>
            {audioState.currentLineText && <p className="audio-current-line">{audioState.currentLineText}</p>}
          </div>

          <div className="audio-selection-card">
            <p className="audio-selection-title">Current page selection</p>
            <p className="audio-selection-text">
              {audioState.hasSelection
                ? audioState.selectionText
                : 'Highlight text on the webpage, then tap "Read Selection".'}
            </p>
          </div>
        </section>
      )}

      {error && <p className="error-text">{error}</p>}
      {activeTabUrl && <p className="tab-url">{activeTabUrl}</p>}

      <SettingsModal
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        hasApiKey={hasApiKey}
        onSaved={() => {
          setHasApiKey(true);
          setIsSettingsOpen(false);
        }}
      />
    </div>
  );
}

export default App;
