import type { ChatSession, ScanReport, TabContext } from '@/lib/types';

const API_KEY_STORAGE_KEY = 'openrouter_api_key';
const LEGACY_API_KEY_STORAGE_KEY = 'gemini_api_key';

const REPORT_PREFIX = 'scan_report_';
const CONTEXT_PREFIX = 'scan_context_';
const SESSION_PREFIX = 'chat_session_';

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;

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
