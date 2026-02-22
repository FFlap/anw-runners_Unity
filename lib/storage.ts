import type { AutofillProfile, ChatSession, ScanReport, TabContext } from '@/lib/types';

const API_KEY_STORAGE_KEY = 'openrouter_api_key';
const LEGACY_API_KEY_STORAGE_KEY = 'gemini_api_key';
export const COLOR_BLIND_MODE_STORAGE_KEY = 'unity_color_blind_mode';
export const COLOR_BLIND_FILTER_STORAGE_KEY = 'unity_color_blind_filter';
export const REDUCE_MOTION_STORAGE_KEY = 'unity_reduce_motion';
export const AUDIO_RATE_STORAGE_KEY = 'unity_audio_rate';
export const AUDIO_FOLLOW_MODE_STORAGE_KEY = 'unity_audio_follow_mode';
export const FORCED_FONT_STORAGE_KEY = 'unity_forced_font';
export const AUTOFILL_PROFILE_STORAGE_KEY = 'unity_autofill_profile';

export type ColorBlindFilterOption =
  | 'none'
  | 'protanopia'
  | 'deuteranopia'
  | 'tritanopia'
  | 'achromatopsia';

const COLOR_BLIND_FILTER_OPTIONS: readonly ColorBlindFilterOption[] = [
  'none',
  'protanopia',
  'deuteranopia',
  'tritanopia',
  'achromatopsia',
];

export type ForcedFontOption =
  | 'none'
  | 'opendyslexic'
  | 'arial'
  | 'helvetica'
  | 'verdana'
  | 'comic-sans';

const FORCED_FONT_OPTIONS: readonly ForcedFontOption[] = [
  'none',
  'opendyslexic',
  'arial',
  'helvetica',
  'verdana',
  'comic-sans',
];

const REPORT_PREFIX = 'scan_report_';
const CONTEXT_PREFIX = 'scan_context_';
const SESSION_PREFIX = 'chat_session_';

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

export function createEmptyAutofillProfile(): AutofillProfile {
  return {
    fullName: '',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    stateOrProvince: '',
    postalOrZip: '',
    country: '',
  };
}

function normalizeAutofillField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAutofillProfile(value: unknown): AutofillProfile {
  const emptyProfile = createEmptyAutofillProfile();
  if (!value || typeof value !== 'object') {
    return emptyProfile;
  }

  const record = value as Record<string, unknown>;
  return {
    fullName: normalizeAutofillField(record.fullName),
    firstName: normalizeAutofillField(record.firstName),
    lastName: normalizeAutofillField(record.lastName),
    email: normalizeAutofillField(record.email),
    phone: normalizeAutofillField(record.phone),
    addressLine1: normalizeAutofillField(record.addressLine1),
    addressLine2: normalizeAutofillField(record.addressLine2),
    city: normalizeAutofillField(record.city),
    stateOrProvince: normalizeAutofillField(record.stateOrProvince),
    postalOrZip: normalizeAutofillField(record.postalOrZip),
    country: normalizeAutofillField(record.country),
  };
}

export async function saveApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  await ext.storage.local.set({
    [API_KEY_STORAGE_KEY]: trimmed,
    [LEGACY_API_KEY_STORAGE_KEY]: trimmed,
  });
}

export async function getApiKey(): Promise<string | null> {
  const stored = await ext.storage.local.get([API_KEY_STORAGE_KEY, LEGACY_API_KEY_STORAGE_KEY]);
  const value = stored[API_KEY_STORAGE_KEY] ?? stored[LEGACY_API_KEY_STORAGE_KEY];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null;
}

export async function getColorBlindModeEnabled(): Promise<boolean> {
  const stored = await ext.storage.local.get(COLOR_BLIND_MODE_STORAGE_KEY);
  return Boolean(stored?.[COLOR_BLIND_MODE_STORAGE_KEY]);
}

export async function setColorBlindModeEnabled(enabled: boolean): Promise<void> {
  await ext.storage.local.set({ [COLOR_BLIND_MODE_STORAGE_KEY]: enabled });
}

export function normalizeColorBlindFilter(value: unknown): ColorBlindFilterOption {
  if (typeof value !== 'string') return 'none';
  const normalized = value.trim().toLowerCase();
  if ((COLOR_BLIND_FILTER_OPTIONS as readonly string[]).includes(normalized)) {
    return normalized as ColorBlindFilterOption;
  }
  return 'none';
}

export async function getColorBlindFilter(): Promise<ColorBlindFilterOption> {
  const stored = await ext.storage.local.get(COLOR_BLIND_FILTER_STORAGE_KEY);
  return normalizeColorBlindFilter(stored?.[COLOR_BLIND_FILTER_STORAGE_KEY]);
}

export async function setColorBlindFilter(filter: ColorBlindFilterOption): Promise<void> {
  await ext.storage.local.set({ [COLOR_BLIND_FILTER_STORAGE_KEY]: normalizeColorBlindFilter(filter) });
}

export async function getReduceMotionEnabled(): Promise<boolean> {
  const stored = await ext.storage.local.get(REDUCE_MOTION_STORAGE_KEY);
  return Boolean(stored?.[REDUCE_MOTION_STORAGE_KEY]);
}

export async function setReduceMotionEnabled(enabled: boolean): Promise<void> {
  await ext.storage.local.set({ [REDUCE_MOTION_STORAGE_KEY]: enabled });
}

function normalizeAudioRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.max(0.75, Math.min(2, rate));
}

export async function getAudioRate(): Promise<number> {
  const stored = await ext.storage.local.get(AUDIO_RATE_STORAGE_KEY);
  return normalizeAudioRate(Number(stored?.[AUDIO_RATE_STORAGE_KEY] ?? 1));
}

export async function setAudioRate(rate: number): Promise<void> {
  await ext.storage.local.set({ [AUDIO_RATE_STORAGE_KEY]: normalizeAudioRate(rate) });
}

export async function getAudioFollowModeEnabled(): Promise<boolean> {
  const stored = await ext.storage.local.get(AUDIO_FOLLOW_MODE_STORAGE_KEY);
  return Boolean(stored?.[AUDIO_FOLLOW_MODE_STORAGE_KEY]);
}

export async function setAudioFollowModeEnabled(enabled: boolean): Promise<void> {
  await ext.storage.local.set({ [AUDIO_FOLLOW_MODE_STORAGE_KEY]: enabled });
}

export function normalizeForcedFont(value: unknown): ForcedFontOption {
  if (typeof value !== 'string') return 'none';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'dyslexie') {
    // Backward compatibility with previously saved setting.
    return 'opendyslexic';
  }
  if ((FORCED_FONT_OPTIONS as readonly string[]).includes(normalized)) {
    return normalized as ForcedFontOption;
  }
  return 'none';
}

export async function getForcedFont(): Promise<ForcedFontOption> {
  const stored = await ext.storage.local.get(FORCED_FONT_STORAGE_KEY);
  return normalizeForcedFont(stored?.[FORCED_FONT_STORAGE_KEY]);
}

export async function setForcedFont(font: ForcedFontOption): Promise<void> {
  await ext.storage.local.set({ [FORCED_FONT_STORAGE_KEY]: normalizeForcedFont(font) });
}

export async function getAutofillProfile(): Promise<AutofillProfile> {
  const stored = await ext.storage.local.get(AUTOFILL_PROFILE_STORAGE_KEY);
  return normalizeAutofillProfile(stored?.[AUTOFILL_PROFILE_STORAGE_KEY]);
}

export async function saveAutofillProfile(profile: AutofillProfile): Promise<void> {
  await ext.storage.local.set({
    [AUTOFILL_PROFILE_STORAGE_KEY]: normalizeAutofillProfile(profile),
  });
}

export async function clearAutofillProfile(): Promise<void> {
  await ext.storage.local.remove(AUTOFILL_PROFILE_STORAGE_KEY);
}

function reportKey(tabId: number): string {
  return `${REPORT_PREFIX}${tabId}`;
}

function contextKey(tabId: number): string {
  return `${CONTEXT_PREFIX}${tabId}`;
}

function sessionKey(tabId: number): string {
  return `${SESSION_PREFIX}${tabId}`;
}

export async function saveReport(tabId: number, report: ScanReport): Promise<void> {
  await ext.storage.local.set({ [reportKey(tabId)]: report });
}

export async function getReport(tabId: number): Promise<ScanReport | null> {
  const key = reportKey(tabId);
  const stored = await ext.storage.local.get(key);
  const value = stored[key];
  return value && typeof value === 'object' ? (value as ScanReport) : null;
}

export async function saveContext(tabId: number, context: TabContext): Promise<void> {
  await ext.storage.local.set({ [contextKey(tabId)]: context });
}

export async function getContext(tabId: number): Promise<TabContext | null> {
  const key = contextKey(tabId);
  const stored = await ext.storage.local.get(key);
  const value = stored[key];
  return value && typeof value === 'object' ? (value as TabContext) : null;
}

export async function saveChatSession(tabId: number, session: ChatSession): Promise<void> {
  await ext.storage.local.set({ [sessionKey(tabId)]: session });
}

export async function getChatSession(tabId: number): Promise<ChatSession | null> {
  const key = sessionKey(tabId);
  const stored = await ext.storage.local.get(key);
  const value = stored[key];
  return value && typeof value === 'object' ? (value as ChatSession) : null;
}

export async function clearChatSession(tabId: number): Promise<void> {
  await ext.storage.local.remove(sessionKey(tabId));
}

export async function clearTabContext(tabId: number): Promise<void> {
  await ext.storage.local.remove([reportKey(tabId), contextKey(tabId)]);
}
