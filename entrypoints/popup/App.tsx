import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Send,
  Settings,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  clearAutofillProfile,
  createEmptyAutofillProfile,
  getAutofillProfile,
  getAudioFollowModeEnabled,
  getAudioRate,
  getColorBlindModeEnabled,
  getForcedFont,
  getReduceMotionEnabled,
  saveAutofillProfile,
  setAudioFollowModeEnabled,
  setAudioRate,
  setColorBlindModeEnabled,
  setForcedFont,
  setReduceMotionEnabled,
  type ForcedFontOption,
} from '@/lib/storage';
import type {
  AutofillFieldKey,
  AutofillProfile,
  ChatMessage,
  ChatSession,
  DetectedFormField,
  RuntimeRequest,
  ScanStatus,
  SourceSnippet,
} from '@/lib/types';
import {
  DICTATION_SILENCE_TIMEOUT_MS,
  dictationErrorMessage,
  getDictationRecognitionCtor,
  insertDictationText,
  type DictationRecognitionLike,
} from '@/lib/dictation';

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;
const API_KEY_STORAGE_KEY = 'openrouter_api_key';
const LEGACY_API_KEY_STORAGE_KEY = 'gemini_api_key';
const COLOR_BLIND_SWITCH_ID = 'unity-color-blind-mode-switch';
const REDUCE_MOTION_SWITCH_ID = 'unity-reduce-motion-switch';
const FORCED_FONT_SELECT_ID = 'unity-forced-font-select';

type SettingsResponse = { hasApiKey: boolean };
type SessionResponse = { session: ChatSession | null };
type AskResponse = {
  ok: boolean;
  answer?: ChatMessage;
  session?: ChatSession;
  error?: string;
};
type PopupTab = 'chat' | 'audio' | 'profile' | 'autofill';
type ToastState = {
  tone: 'success' | 'error';
  text: string;
};
type AudioTabMessage =
  | { type: 'AUDIO_GET_STATE' }
  | { type: 'AUDIO_GET_SELECTION' }
  | { type: 'AUDIO_READ_SELECTION'; rate?: number; followMode?: boolean }
  | { type: 'AUDIO_PLAY' }
  | { type: 'AUDIO_PAUSE' }
  | { type: 'AUDIO_STOP' }
  | { type: 'AUDIO_SET_RATE'; rate: number }
  | { type: 'AUDIO_SET_FOLLOW_MODE'; enabled: boolean };
type FormFillSelection = {
  index: number;
  fieldKey: AutofillFieldKey;
  value: string;
};
type FormTabMessage =
  | { type: 'FORM_SCAN_FIELDS' }
  | { type: 'FORM_FILL_FIELDS'; selections: FormFillSelection[] }
  | { type: 'FORM_UNDO_FILL' }
  | { type: 'FORM_GET_UNDO_STATUS' };
type ContentTabMessage = AudioTabMessage | FormTabMessage;
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
type FormScanResponse = {
  ok: boolean;
  fields?: DetectedFormField[];
  error?: string;
};
type FormFillSummary = {
  requested: number;
  filled: number;
  skipped: number;
  skippedByReason: Record<string, number>;
};
type FormUndoSummary = {
  undoable: number;
  restored: number;
  skipped: number;
  skippedByReason: Record<string, number>;
};
type FormFillResponse = {
  ok: boolean;
  summary?: FormFillSummary;
  undoAvailable?: boolean;
  error?: string;
};
type FormUndoResponse = {
  ok: boolean;
  summary?: FormUndoSummary;
  undoAvailable?: boolean;
  error?: string;
};
type FormUndoStatusResponse = {
  ok: boolean;
  undoAvailable?: boolean;
  error?: string;
};

async function getPopupMicrophonePermissionState(): Promise<PermissionState | 'unknown'> {
  if (!('permissions' in navigator) || typeof navigator.permissions?.query !== 'function') {
    return 'unknown';
  }

  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

async function requestPopupMicrophoneAccess(): Promise<{ ok: boolean; error?: string }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: 'Microphone API is unavailable in this browser.' };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { ok: true };
  } catch (error) {
    const code = error instanceof DOMException ? error.name : undefined;
    if (code === 'NotAllowedError' || code === 'PermissionDeniedError') {
      return { ok: false, error: 'Microphone permission was denied.' };
    }
    if (code === 'NotFoundError' || code === 'DevicesNotFoundError') {
      return { ok: false, error: 'No microphone device was found.' };
    }
    return { ok: false, error: 'Microphone permission request failed.' };
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

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

const paneTitleByTab: Record<PopupTab, string> = {
  chat: 'Grounded Tab Chat',
  audio: 'Audio Reader',
  profile: 'Profile',
  autofill: 'Autofill Preview',
};

const profileFieldConfigs: Array<{
  key: keyof AutofillProfile;
  label: string;
  type?: string;
  autoComplete?: string;
}> = [
  { key: 'fullName', label: 'Full Name', autoComplete: 'name' },
  { key: 'firstName', label: 'First Name', autoComplete: 'given-name' },
  { key: 'lastName', label: 'Last Name', autoComplete: 'family-name' },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', autoComplete: 'tel' },
  { key: 'addressLine1', label: 'Address Line 1', autoComplete: 'address-line1' },
  { key: 'addressLine2', label: 'Address Line 2', autoComplete: 'address-line2' },
  { key: 'city', label: 'City', autoComplete: 'address-level2' },
  { key: 'stateOrProvince', label: 'Province/State', autoComplete: 'address-level1' },
  { key: 'postalOrZip', label: 'Postal/ZIP', autoComplete: 'postal-code' },
  { key: 'country', label: 'Country', autoComplete: 'country-name' },
];

function getProfileValueForFieldKey(
  profile: AutofillProfile,
  fieldKey: AutofillFieldKey | null,
): string {
  if (!fieldKey) return '';
  switch (fieldKey) {
    case 'email':
      return profile.email;
    case 'firstName':
      return profile.firstName;
    case 'lastName':
      return profile.lastName;
    case 'fullName':
      return profile.fullName;
    case 'phone':
      return profile.phone;
    case 'addressLine1':
      return profile.addressLine1;
    case 'addressLine2':
      return profile.addressLine2;
    case 'city':
      return profile.city;
    case 'stateProvince':
      return profile.stateOrProvince;
    case 'postalZip':
      return profile.postalOrZip;
    case 'country':
      return profile.country;
    default:
      return '';
  }
}

function getDetectedFieldLabel(field: DetectedFormField): string {
  const primaryLabel = field.labelText
    .split('|')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (primaryLabel) return primaryLabel;
  if (field.placeholder) return field.placeholder;
  if (field.name) return field.name;
  if (field.id) return field.id;
  return `${field.elementType} field ${field.index + 1}`;
}

function getFieldKeyLabel(fieldKey: AutofillFieldKey | null): string {
  if (!fieldKey) return 'unclassified';
  switch (fieldKey) {
    case 'email':
      return 'email';
    case 'firstName':
      return 'firstName';
    case 'lastName':
      return 'lastName';
    case 'fullName':
      return 'fullName';
    case 'phone':
      return 'phone';
    case 'addressLine1':
      return 'addressLine1';
    case 'addressLine2':
      return 'addressLine2';
    case 'city':
      return 'city';
    case 'stateProvince':
      return 'stateProvince';
    case 'postalZip':
      return 'postalZip';
    case 'country':
      return 'country';
    default:
      return 'unclassified';
  }
}

function formatSkipReason(reason: string): string {
  return reason.replace(/_/g, ' ').trim();
}

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

async function sendTabMessage<T>(tabId: number, message: ContentTabMessage): Promise<T> {
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
  isColorBlindMode,
  isReduceMotion,
  forcedFont,
  onToggleColorBlindMode,
  onToggleReduceMotion,
  onForcedFontChange,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  hasApiKey: boolean;
  isColorBlindMode: boolean;
  isReduceMotion: boolean;
  forcedFont: ForcedFontOption;
  onToggleColorBlindMode: () => void | Promise<void>;
  onToggleReduceMotion: () => void | Promise<void>;
  onForcedFontChange: (font: ForcedFontOption) => void | Promise<void>;
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
          <h2>Settings</h2>
          <button type="button" className="ghost-btn" onClick={onClose}>Close</button>
        </div>
        <p className="modal-section-title">OpenRouter API Key</p>
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

        <section className="modal-section" aria-label="Accessibility settings">
          <p className="modal-section-title">Accessibility</p>
          <div className="audio-follow-row">
            <label htmlFor={COLOR_BLIND_SWITCH_ID} className="audio-follow-label">
              <span>Color Blind Mode</span>
              <small>Adds non-color cues for status and highlights.</small>
            </label>
            <button
              id={COLOR_BLIND_SWITCH_ID}
              type="button"
              className="mode-switch"
              role="switch"
              aria-checked={isColorBlindMode}
              onClick={() => void onToggleColorBlindMode()}
              title="Toggle Color Blind Mode"
            >
              <span className="mode-switch-track" aria-hidden="true">
                <span className="mode-switch-knob" />
              </span>
              <span className="mode-switch-text">{isColorBlindMode ? 'On' : 'Off'}</span>
            </button>
          </div>
          <div className="audio-follow-row">
            <label htmlFor={REDUCE_MOTION_SWITCH_ID} className="audio-follow-label">
              <span>Stop Motion</span>
              <small>Pauses webpage motion, including autoplay media and animated effects.</small>
            </label>
            <button
              id={REDUCE_MOTION_SWITCH_ID}
              type="button"
              className="mode-switch"
              role="switch"
              aria-checked={isReduceMotion}
              onClick={() => void onToggleReduceMotion()}
              title="Toggle Stop Motion"
            >
              <span className="mode-switch-track" aria-hidden="true">
                <span className="mode-switch-knob" />
              </span>
              <span className="mode-switch-text">{isReduceMotion ? 'On' : 'Off'}</span>
            </button>
          </div>
          <div className="audio-follow-row">
            <label htmlFor={FORCED_FONT_SELECT_ID} className="audio-follow-label">
              <span>Force Web Font</span>
              <small>Apply a preferred font across webpages while browsing.</small>
            </label>
            <select
              id={FORCED_FONT_SELECT_ID}
              className="font-select"
              value={forcedFont}
              onChange={(event) => {
                void onForcedFontChange(event.target.value as ForcedFontOption);
              }}
            >
              <option value="none">None</option>
              <option value="opendyslexic">OpenDyslexic</option>
              <option value="arial">Arial</option>
              <option value="helvetica">Helvetica</option>
              <option value="verdana">Verdana</option>
              <option value="comic-sans">Comic Sans</option>
            </select>
          </div>
        </section>
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
    message: 'Ready for grounded Q&A.',
    updatedAt: Date.now(),
  });
  const [session, setSession] = useState<ChatSession | null>(null);
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isColorBlindMode, setIsColorBlindMode] = useState(false);
  const [isReduceMotion, setIsReduceMotion] = useState(false);
  const [forcedFont, setForcedFontState] = useState<ForcedFontOption>('none');
  const [activePane, setActivePane] = useState<PopupTab>('chat');
  const [audioState, setAudioState] = useState<AudioState>(defaultAudioState);
  const [audioRate, setAudioRateState] = useState(1);
  const [audioFollowMode, setAudioFollowModeState] = useState(false);
  const [isAudioLoading, setIsAudioLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dictationSupported, setDictationSupported] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [profileForm, setProfileForm] = useState<AutofillProfile>(() => createEmptyAutofillProfile());
  const [savedProfile, setSavedProfile] = useState<AutofillProfile>(() => createEmptyAutofillProfile());
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [detectedFormFields, setDetectedFormFields] = useState<DetectedFormField[]>([]);
  const [autofillEnabledByField, setAutofillEnabledByField] = useState<Record<number, boolean>>({});
  const [isFieldScanLoading, setIsFieldScanLoading] = useState(false);
  const [isFillNowLoading, setIsFillNowLoading] = useState(false);
  const [isUndoLoading, setIsUndoLoading] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [fillSummary, setFillSummary] = useState<FormFillSummary | null>(null);
  const [undoSummary, setUndoSummary] = useState<FormUndoSummary | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);

  const recognitionRef = useRef<DictationRecognitionLike | null>(null);
  const dictationActiveRef = useRef(false);
  const silenceTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const hasLoadedProfileRef = useRef(false);

  const refreshTabData = useCallback(async (tabId: number) => {
    const [nextStatus, sessionResponse] = await Promise.all([
      sendMessage<ScanStatus>({ type: 'GET_SCAN_STATUS', tabId }),
      sendMessage<SessionResponse>({ type: 'GET_CHAT_SESSION', tabId }),
    ]);

    setStatus(nextStatus);
    setSession(sessionResponse.session);
  }, []);

  const showToast = useCallback((tone: ToastState['tone'], text: string) => {
    if (toastTimerRef.current != null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ tone, text });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2400);
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

        const [nextColorBlindMode, nextReduceMotion, nextAudioRate, nextAudioFollow, nextForcedFont] = await Promise.all([
          getColorBlindModeEnabled(),
          getReduceMotionEnabled(),
          getAudioRate(),
          getAudioFollowModeEnabled(),
          getForcedFont(),
        ]);
        setHasApiKey(storageHasKey || Boolean(settings.hasApiKey));
        setIsColorBlindMode(nextColorBlindMode);
        setIsReduceMotion(nextReduceMotion);
        setForcedFontState(nextForcedFont);
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
    return () => {
      if (toastTimerRef.current != null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (activeTabId == null) return;

    const timer = window.setInterval(() => {
      void refreshTabData(activeTabId).catch(() => {
        // Ignore transient wakeup failures.
      });
    }, 1700);

    return () => window.clearInterval(timer);
  }, [activeTabId, refreshTabData]);

  useEffect(() => {
    setDetectedFormFields([]);
    setAutofillEnabledByField({});
    setUndoAvailable(false);
    setFillSummary(null);
    setUndoSummary(null);
  }, [activeTabId]);

  useEffect(() => {
    const RecognitionCtor = getDictationRecognitionCtor();
    if (!RecognitionCtor) {
      setDictationSupported(false);
      return;
    }

    let recognition: DictationRecognitionLike;
    try {
      recognition = new RecognitionCtor();
    } catch {
      setDictationSupported(false);
      return;
    }

    setDictationSupported(true);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    let pendingTranscript = '';

    const clearSilenceTimer = () => {
      if (silenceTimerRef.current == null) return;
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    };

    const scheduleSilenceStop = () => {
      clearSilenceTimer();
      silenceTimerRef.current = window.setTimeout(() => {
        silenceTimerRef.current = null;
        if (!dictationActiveRef.current) return;
        try {
          recognition.stop();
        } catch {
          // Recognition can already be stopped.
        }
      }, DICTATION_SILENCE_TIMEOUT_MS);
    };

    recognition.onstart = () => {
      pendingTranscript = '';
      dictationActiveRef.current = true;
      setIsDictating(true);
      scheduleSilenceStop();
    };

    recognition.onend = () => {
      if (pendingTranscript.trim()) {
        setQuestion((previous) => {
          const input = textareaRef.current;
          const selectionStart = input?.selectionStart ?? previous.length;
          const selectionEnd = input?.selectionEnd ?? selectionStart;
          const next = insertDictationText(previous, pendingTranscript, selectionStart, selectionEnd);
          pendingCursorRef.current = next.cursor;
          return next.value;
        });
      }
      pendingTranscript = '';
      dictationActiveRef.current = false;
      setIsDictating(false);
      clearSilenceTimer();
    };

    recognition.onerror = (event) => {
      pendingTranscript = '';
      dictationActiveRef.current = false;
      setIsDictating(false);
      clearSilenceTimer();
      if (event.error && event.error !== 'aborted') {
        setError(dictationErrorMessage(event.error));
      }
    };

    recognition.onspeechstart = () => {
      clearSilenceTimer();
    };

    recognition.onspeechend = () => {
      scheduleSilenceStop();
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
        pendingTranscript = '';
        setQuestion((previous) => {
          const input = textareaRef.current;
          const selectionStart = input?.selectionStart ?? previous.length;
          const selectionEnd = input?.selectionEnd ?? selectionStart;
          const next = insertDictationText(previous, finalTranscript, selectionStart, selectionEnd);
          pendingCursorRef.current = next.cursor;
          return next.value;
        });
        scheduleSilenceStop();
        return;
      }

      pendingTranscript = interimTranscript.trim();
      if (pendingTranscript) {
        scheduleSilenceStop();
      }
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.stop();
      } catch {
        // Recognition can already be stopped.
      }
      clearSilenceTimer();
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      recognitionRef.current = null;
      dictationActiveRef.current = false;
      setIsDictating(false);
    };
  }, []);

  useEffect(() => {
    const pendingCursor = pendingCursorRef.current;
    if (pendingCursor == null) return;
    const input = textareaRef.current;
    if (!input) return;

    window.requestAnimationFrame(() => {
      const activeInput = textareaRef.current;
      if (!activeInput) return;
      const cursor = Math.max(0, Math.min(pendingCursor, activeInput.value.length));
      activeInput.focus();
      activeInput.setSelectionRange(cursor, cursor);
      pendingCursorRef.current = null;
    });
  }, [question]);

  useEffect(() => {
    if (hasApiKey && activeTabId != null && !isAsking) return;
    if (!dictationActiveRef.current) return;
    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition can already be stopped.
    }
  }, [activeTabId, hasApiKey, isAsking]);

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

    if (dictationActiveRef.current) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // Recognition can already be stopped.
      }
    }

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

  const toggleDictation = useCallback(async () => {
    const recognition = recognitionRef.current;
    if (!recognition || !dictationSupported) return;

    setError(null);
    try {
      if (dictationActiveRef.current) {
        recognition.stop();
      } else {
        // Trigger microphone permission directly from the click path.
        const permissionRequest = requestPopupMicrophoneAccess();
        setIsRequestingMic(true);
        let permissionResult: { ok: boolean; error?: string };
        try {
          permissionResult = await permissionRequest;
        } finally {
          setIsRequestingMic(false);
        }

        if (!permissionResult.ok) {
          const currentState = await getPopupMicrophonePermissionState();
          if (currentState === 'denied') {
            setError('Popup microphone is blocked. Allow mic for this extension in Chrome site settings.');
          } else {
            setError(permissionResult.error ?? 'Microphone permission is required for popup dictation.');
          }
          return;
        }

        recognition.start();
      }
    } catch (dictationError) {
      setError(dictationError instanceof Error ? dictationError.message : dictationErrorMessage());
      dictationActiveRef.current = false;
      setIsDictating(false);
    }
  }, [dictationSupported]);

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

  const loadProfileData = useCallback(async () => {
    setIsProfileLoading(true);
    try {
      const persistedProfile = await getAutofillProfile();
      setSavedProfile(persistedProfile);
      setProfileForm(persistedProfile);
      hasLoadedProfileRef.current = true;
    } catch (profileError) {
      const message = profileError instanceof Error ? profileError.message : 'Failed to load saved profile.';
      setError(message);
      showToast('error', 'Failed to load profile.');
    } finally {
      setIsProfileLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if ((activePane !== 'profile' && activePane !== 'autofill') || hasLoadedProfileRef.current) return;
    void loadProfileData();
  }, [activePane, loadProfileData]);

  const updateProfileField = useCallback((field: keyof AutofillProfile, value: string) => {
    setProfileForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  }, []);

  const saveProfileData = useCallback(async () => {
    setError(null);
    setIsProfileSaving(true);
    try {
      await saveAutofillProfile(profileForm);
      const persistedProfile = await getAutofillProfile();
      setSavedProfile(persistedProfile);
      setProfileForm(persistedProfile);
      hasLoadedProfileRef.current = true;
      showToast('success', 'Profile saved.');
    } catch (profileError) {
      const message = profileError instanceof Error ? profileError.message : 'Failed to save profile.';
      setError(message);
      showToast('error', 'Failed to save profile.');
    } finally {
      setIsProfileSaving(false);
    }
  }, [profileForm, showToast]);

  const clearProfileData = useCallback(async () => {
    setError(null);
    setIsProfileSaving(true);
    try {
      await clearAutofillProfile();
      const clearedProfile = createEmptyAutofillProfile();
      setSavedProfile(clearedProfile);
      setProfileForm(clearedProfile);
      hasLoadedProfileRef.current = true;
      showToast('success', 'Profile cleared.');
    } catch (profileError) {
      const message = profileError instanceof Error ? profileError.message : 'Failed to clear profile.';
      setError(message);
      showToast('error', 'Failed to clear profile.');
    } finally {
      setIsProfileSaving(false);
    }
  }, [showToast]);

  const scanFormFields = useCallback(async () => {
    if (activeTabId == null) {
      setError('Open an HTTP(S) tab to scan fillable fields.');
      showToast('error', 'No active tab available for field scan.');
      return;
    }

    setError(null);
    setFillSummary(null);
    setIsFieldScanLoading(true);
    try {
      const response = await sendTabMessage<FormScanResponse>(activeTabId, { type: 'FORM_SCAN_FIELDS' });
      if (!response.ok) {
        throw new Error(response.error || 'Failed to scan form fields.');
      }
      const fields = Array.isArray(response.fields) ? response.fields : [];
      const classifiedCount = fields.filter((field) => field.fieldKey != null).length;
      const nextEnabledByField = fields.reduce<Record<number, boolean>>((accumulator, field) => {
        const profileValue = getProfileValueForFieldKey(savedProfile, field.fieldKey);
        accumulator[field.index] = Boolean(field.fieldKey && profileValue.trim().length > 0);
        return accumulator;
      }, {});
      setDetectedFormFields(fields);
      setAutofillEnabledByField(nextEnabledByField);
      showToast('success', `Detected ${fields.length} fields (${classifiedCount} classified).`);
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : 'Field scan failed.';
      setError(message);
      showToast('error', 'Failed to scan fields on this page.');
    } finally {
      setIsFieldScanLoading(false);
    }
  }, [activeTabId, savedProfile, showToast]);

  const refreshUndoAvailability = useCallback(async (tabId?: number | null) => {
    const resolvedTabId = tabId ?? activeTabId;
    if (resolvedTabId == null) {
      setUndoAvailable(false);
      return;
    }

    try {
      const response = await sendTabMessage<FormUndoStatusResponse>(resolvedTabId, { type: 'FORM_GET_UNDO_STATUS' });
      setUndoAvailable(Boolean(response.ok && response.undoAvailable));
    } catch {
      setUndoAvailable(false);
    }
  }, [activeTabId]);

  useEffect(() => {
    if (activePane !== 'autofill') return;
    void refreshUndoAvailability();
  }, [activePane, activeTabId, refreshUndoAvailability]);

  const toggleAutofillField = useCallback((fieldIndex: number, enabled: boolean) => {
    setAutofillEnabledByField((previous) => ({
      ...previous,
      [fieldIndex]: enabled,
    }));
  }, []);

  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const isComposerDisabled = !hasApiKey || activeTabId == null || isAsking;
  const statusMessage =
    status.message === 'Ready to scan this tab.'
      ? 'Ready for grounded Q&A.'
      : status.message;

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

  const toggleReduceMotion = useCallback(async () => {
    const next = !isReduceMotion;
    setIsReduceMotion(next);
    try {
      await setReduceMotionEnabled(next);
    } catch (saveError) {
      setIsReduceMotion(!next);
      setError(saveError instanceof Error ? saveError.message : 'Failed to update stop motion setting.');
    }
  }, [isReduceMotion]);

  const handleForcedFontChange = useCallback(async (nextFont: ForcedFontOption) => {
    setForcedFontState(nextFont);
    try {
      await setForcedFont(nextFont);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to update forced font setting.');
    }
  }, []);

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
  const classifiedFieldCount = detectedFormFields.filter((field) => field.fieldKey != null).length;
  const autofillPreviewRows = useMemo(() => {
    return detectedFormFields.map((field) => {
      const profileValue = getProfileValueForFieldKey(savedProfile, field.fieldKey);
      const hasMissingValue = field.fieldKey != null && profileValue.trim().length === 0;
      const isUnsupported = field.fieldKey == null;
      const rowDisabled = hasMissingValue || isUnsupported;
      const rowEnabled = !rowDisabled && Boolean(autofillEnabledByField[field.index]);
      const warning = isUnsupported
        ? 'No supported fieldKey detected.'
        : hasMissingValue
          ? `Missing profile value for ${field.fieldKey}.`
          : '';
      return {
        ...field,
        displayLabel: getDetectedFieldLabel(field),
        fieldKeyLabel: getFieldKeyLabel(field.fieldKey),
        profileValue,
        rowDisabled,
        rowEnabled,
        warning,
      };
    });
  }, [autofillEnabledByField, detectedFormFields, savedProfile]);
  const enabledAutofillCount = autofillPreviewRows.filter((field) => field.rowEnabled).length;
  const matchedProfileValueCount = autofillPreviewRows.filter((field) => field.profileValue.trim().length > 0).length;
  const fillNow = useCallback(async () => {
    if (activeTabId == null) {
      setError('Open an HTTP(S) tab to fill fields.');
      showToast('error', 'No active tab available for filling.');
      return;
    }

    const selections: FormFillSelection[] = autofillPreviewRows
      .filter((field) => field.rowEnabled && field.fieldKey != null && field.profileValue.trim().length > 0)
      .map((field) => ({
        index: field.index,
        fieldKey: field.fieldKey as AutofillFieldKey,
        value: field.profileValue,
      }));

    if (selections.length === 0) {
      showToast('error', 'No enabled fields to fill.');
      return;
    }

    setError(null);
    setUndoSummary(null);
    setIsFillNowLoading(true);
    try {
      const response = await sendTabMessage<FormFillResponse>(activeTabId, {
        type: 'FORM_FILL_FIELDS',
        selections,
      });
      if (!response.ok || !response.summary) {
        throw new Error(response.error || 'Fill operation failed.');
      }
      setFillSummary(response.summary);
      setUndoAvailable(Boolean(response.undoAvailable));
      showToast('success', `Filled ${response.summary.filled} of ${response.summary.requested} fields.`);
    } catch (fillError) {
      const message = fillError instanceof Error ? fillError.message : 'Fill operation failed.';
      setError(message);
      showToast('error', 'Failed to fill fields on this page.');
    } finally {
      setIsFillNowLoading(false);
    }
  }, [activeTabId, autofillPreviewRows, showToast]);
  const undoFill = useCallback(async () => {
    if (activeTabId == null) {
      setError('Open an HTTP(S) tab to undo fill.');
      showToast('error', 'No active tab available for undo.');
      return;
    }

    setError(null);
    setIsUndoLoading(true);
    try {
      const response = await sendTabMessage<FormUndoResponse>(activeTabId, { type: 'FORM_UNDO_FILL' });
      if (!response.ok || !response.summary) {
        throw new Error(response.error || 'Undo failed.');
      }
      setUndoSummary(response.summary);
      setUndoAvailable(Boolean(response.undoAvailable));
      showToast('success', `Restored ${response.summary.restored} of ${response.summary.undoable} fields.`);
    } catch (undoError) {
      const message = undoError instanceof Error ? undoError.message : 'Undo failed.';
      setError(message);
      showToast('error', 'Failed to undo last fill.');
    } finally {
      setIsUndoLoading(false);
    }
  }, [activeTabId, showToast]);
  const audioLineLabel =
    audioState.currentLineIndex >= 0 && audioState.totalLines > 0
      ? `Line ${audioState.currentLineIndex + 1} of ${audioState.totalLines}`
      : 'No active transcript line';

  return (
    <div className={`unity-shell ${isColorBlindMode ? 'unity-shell--cbm' : ''}`.trim()}>
      <header className="unity-header">
        <div>
          <p className="kicker">Unity</p>
          <h1>{paneTitleByTab[activePane]}</h1>
        </div>
        <div className="header-actions">
          {activePane === 'audio' ? (
            <button type="button" className="icon-btn" onClick={() => void refreshAudioState()} disabled={!canUseAudio}>
              <RotateCcw size={14} className={isAudioLoading ? 'spin' : ''} />
            </button>
          ) : null}
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
        <button
          type="button"
          className={`panel-tab ${activePane === 'profile' ? 'panel-tab--active' : ''}`.trim()}
          role="tab"
          aria-selected={activePane === 'profile'}
          onClick={() => setActivePane('profile')}
        >
          Profile
        </button>
        <button
          type="button"
          className={`panel-tab ${activePane === 'autofill' ? 'panel-tab--active' : ''}`.trim()}
          role="tab"
          aria-selected={activePane === 'autofill'}
          onClick={() => setActivePane('autofill')}
        >
          Autofill
        </button>
      </section>

      {activePane === 'chat' ? (
        <>
          <section className="status-row">
            <span className={`pill pill--${status.state}`}>{status.state}</span>
            <p>{statusMessage}</p>
          </section>

          {!hasApiKey && (
            <section className="warning-card">
              <p>Add your OpenRouter API key in settings before asking questions.</p>
            </section>
          )}

          <section className="chat-feed" data-testid="chat-feed">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <p>Ask about the current tab. Context is prepared automatically on your first question.</p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble key={message.id} message={message} onJump={jumpToSource} />
              ))
            )}
          </section>

          <form className="composer" onSubmit={askQuestion}>
            <textarea
              ref={textareaRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask a question about this tab..."
              disabled={isComposerDisabled}
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
              <div className="composer-submit-actions">
                <button
                  type="button"
                  className={`icon-btn voice-btn ${isDictating ? 'voice-btn--active' : ''}`}
                  onClick={() => void toggleDictation()}
                  disabled={isComposerDisabled || !dictationSupported || isRequestingMic}
                  title={
                    !dictationSupported
                      ? 'Voice dictation is unavailable in this browser.'
                      : isDictating
                        ? 'Stop voice dictation'
                        : 'Start voice dictation'
                  }
                  aria-label={
                    !dictationSupported
                      ? 'Voice dictation unavailable'
                      : isDictating
                        ? 'Stop voice dictation'
                        : 'Start voice dictation'
                  }
                >
                  {isDictating ? <MicOff size={14} /> : <Mic size={14} />}
                </button>
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={isComposerDisabled || !question.trim()}
                >
                  {isAsking ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                  Ask
                </button>
              </div>
            </div>
          </form>
        </>
      ) : activePane === 'audio' ? (
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
      ) : activePane === 'profile' ? (
        <section className="profile-pane">
          <div className="profile-summary-card">
            <p className="profile-summary-title">Autofill Profile</p>
            <p className="profile-summary-note">Saved only in extension local storage for future autofill use.</p>
          </div>

          {isProfileLoading ? (
            <div className="profile-loading-card">
              <LoaderCircle size={14} className="spin" />
              <span>Loading saved profile...</span>
            </div>
          ) : (
            <form
              className="profile-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveProfileData();
              }}
            >
              {profileFieldConfigs.map((field) => (
                <label key={field.key} className="profile-field">
                  <span className="profile-field-label">{field.label}</span>
                  <input
                    type={field.type ?? 'text'}
                    autoComplete={field.autoComplete}
                    className="profile-input"
                    value={profileForm[field.key]}
                    onChange={(event) => updateProfileField(field.key, event.target.value)}
                    disabled={isProfileSaving}
                  />
                </label>
              ))}
              <div className="profile-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void clearProfileData()}
                  disabled={isProfileSaving}
                >
                  Clear
                </button>
                <button type="submit" className="primary-btn" disabled={isProfileSaving}>
                  {isProfileSaving ? <LoaderCircle size={14} className="spin" /> : 'Save'}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <section className="autofill-pane">
          <div className="profile-summary-card">
            <p className="profile-summary-title">Autofill Preview</p>
            <p className="profile-summary-note">
              Uses saved profile values only. Fields are filled only when you click "Fill Now".
            </p>
          </div>

          <div className="profile-detect-card">
            <div className="profile-detect-head">
              <p className="profile-summary-title">Page Field Detection</p>
              <div className="profile-detect-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void scanFormFields()}
                  disabled={isFieldScanLoading || isFillNowLoading || isUndoLoading || isProfileLoading || activeTabId == null}
                >
                  {isFieldScanLoading ? <LoaderCircle size={14} className="spin" /> : 'Scan Page'}
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void fillNow()}
                  disabled={
                    isFillNowLoading ||
                    isFieldScanLoading ||
                    isUndoLoading ||
                    isProfileLoading ||
                    activeTabId == null ||
                    enabledAutofillCount === 0
                  }
                >
                  {isFillNowLoading ? <LoaderCircle size={14} className="spin" /> : 'Fill Now'}
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void undoFill()}
                  disabled={
                    isUndoLoading ||
                    isFillNowLoading ||
                    isFieldScanLoading ||
                    isProfileLoading ||
                    activeTabId == null ||
                    !undoAvailable
                  }
                >
                  {isUndoLoading ? <LoaderCircle size={14} className="spin" /> : 'Undo'}
                </button>
              </div>
            </div>
            <p className="profile-summary-note">
              {autofillPreviewRows.length === 0
                ? 'No fields scanned yet.'
                : `Detected ${autofillPreviewRows.length} fields. ${classifiedFieldCount} classified, ${matchedProfileValueCount} with profile values, ${enabledAutofillCount} enabled.`}
            </p>
          </div>

          {fillSummary && (
            <div className="autofill-summary-card">
              <p className="profile-summary-title">Last Fill Summary</p>
              <p className="profile-summary-note">
                Filled {fillSummary.filled} of {fillSummary.requested} selected fields. Skipped {fillSummary.skipped}.
              </p>
              {Object.keys(fillSummary.skippedByReason).length > 0 && (
                <p className="autofill-summary-reasons">
                  {Object.entries(fillSummary.skippedByReason)
                    .map(([reason, count]) => `${formatSkipReason(reason)}: ${count}`)
                    .join(' | ')}
                </p>
              )}
            </div>
          )}

          {undoSummary && (
            <div className="autofill-summary-card">
              <p className="profile-summary-title">Last Undo Summary</p>
              <p className="profile-summary-note">
                Restored {undoSummary.restored} of {undoSummary.undoable} fields. Skipped {undoSummary.skipped}.
              </p>
              {Object.keys(undoSummary.skippedByReason).length > 0 && (
                <p className="autofill-summary-reasons">
                  {Object.entries(undoSummary.skippedByReason)
                    .map(([reason, count]) => `${formatSkipReason(reason)}: ${count}`)
                    .join(' | ')}
                </p>
              )}
            </div>
          )}

          {autofillPreviewRows.length === 0 ? (
            <div className="autofill-empty-card">
              <p>Run "Scan Page" to preview detected fields and mapped profile values.</p>
            </div>
          ) : (
            <div className="autofill-preview-list">
              {autofillPreviewRows.map((field) => (
                <label
                  key={`${field.index}-${field.elementType}-${field.id}-${field.name}`}
                  className={`autofill-preview-row ${field.warning ? 'autofill-preview-row--warning' : ''} ${field.rowDisabled ? 'autofill-preview-row--disabled' : ''}`.trim()}
                >
                  <input
                    type="checkbox"
                    className="autofill-preview-checkbox"
                    checked={field.rowEnabled}
                    disabled={field.rowDisabled}
                    onChange={(event) => {
                      toggleAutofillField(field.index, event.target.checked);
                    }}
                  />
                  <div className="autofill-preview-content">
                    <p className="autofill-preview-label">{field.displayLabel}</p>
                    <p className="autofill-preview-meta">fieldKey: {field.fieldKeyLabel}</p>
                    <p className="autofill-preview-meta">value: {field.profileValue || '-'}</p>
                    {field.warning && <p className="autofill-preview-warning">{field.warning}</p>}
                  </div>
                </label>
              ))}
            </div>
          )}
        </section>
      )}

      {toast && <p className={`toast toast--${toast.tone}`}>{toast.text}</p>}
      {error && <p className="error-text">{error}</p>}
      {activeTabUrl && <p className="tab-url">{activeTabUrl}</p>}

      <SettingsModal
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        hasApiKey={hasApiKey}
        isColorBlindMode={isColorBlindMode}
        isReduceMotion={isReduceMotion}
        forcedFont={forcedFont}
        onToggleColorBlindMode={toggleColorBlindMode}
        onToggleReduceMotion={toggleReduceMotion}
        onForcedFontChange={handleForcedFontChange}
        onSaved={() => {
          setHasApiKey(true);
          setIsSettingsOpen(false);
        }}
      />
    </div>
  );
}

export default App;
