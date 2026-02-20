import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RotateCcw, Send, Settings, Trash2 } from 'lucide-react';
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

const runningStates = new Set<ScanStatus['state']>(['extracting', 'analyzing', 'highlighting']);

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

        setHasApiKey(storageHasKey || Boolean(settings.hasApiKey));

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

  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const isRunning = runningStates.has(status.state);
  const hasContext = report != null;

  return (
    <div className="unity-shell">
      <header className="unity-header">
        <div>
          <p className="kicker">Unity</p>
          <h1>Grounded Tab Chat</h1>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" onClick={() => void startScan()} disabled={isRunning || activeTabId == null}>
            <RotateCcw size={14} className={isRunning ? 'spin' : ''} />
          </button>
          <button type="button" className="icon-btn" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={14} />
          </button>
        </div>
      </header>

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
