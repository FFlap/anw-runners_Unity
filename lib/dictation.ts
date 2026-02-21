export type DictationResultLike = {
  isFinal: boolean;
  0?: {
    transcript?: string;
  };
};

export type DictationResultEventLike = {
  resultIndex: number;
  results: ArrayLike<DictationResultLike>;
};

export type DictationErrorEventLike = {
  error?: string;
};

export type DictationRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: DictationResultEventLike) => void) | null;
  onerror: ((event: DictationErrorEventLike) => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export const DICTATION_SILENCE_TIMEOUT_MS = 3000;

export type DictationRecognitionCtor = new () => DictationRecognitionLike;

export function getDictationRecognitionCtor(
  scope: Window & typeof globalThis = window,
): DictationRecognitionCtor | null {
  const maybeCtor = (scope as any).SpeechRecognition ?? (scope as any).webkitSpeechRecognition;
  return typeof maybeCtor === 'function' ? (maybeCtor as DictationRecognitionCtor) : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function insertDictationText(
  currentValue: string,
  dictatedText: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursor: number } {
  const normalized = dictatedText.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    const cursor = clamp(selectionStart, 0, currentValue.length);
    return { value: currentValue, cursor };
  }

  const start = clamp(selectionStart, 0, currentValue.length);
  const end = clamp(selectionEnd, start, currentValue.length);
  const before = currentValue.slice(0, start);
  const after = currentValue.slice(end);

  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const insertedText = `${needsLeadingSpace ? ' ' : ''}${normalized}${needsTrailingSpace ? ' ' : ''}`;

  const value = `${before}${insertedText}${after}`;
  const cursor = (before + insertedText).length - (needsTrailingSpace ? 1 : 0);
  return { value, cursor };
}

export function dictationErrorMessage(code?: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission was denied.';
    case 'audio-capture':
      return 'No microphone was found for voice dictation.';
    case 'network':
      return 'Voice dictation network error. Try again.';
    case 'no-speech':
      return 'No speech detected. Try again.';
    case 'aborted':
      return 'Voice dictation stopped.';
    default:
      return 'Voice dictation failed. Try again.';
  }
}
