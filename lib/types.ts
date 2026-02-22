export type ScanState =
  | 'idle'
  | 'extracting'
  | 'analyzing'
  | 'highlighting'
  | 'done'
  | 'error';

export interface ScanStatus {
  tabId?: number;
  state: ScanState;
  progress: number;
  message: string;
  updatedAt: number;
  errorCode?: string;
}

export interface TranscriptSegment {
  id: string;
  startSec: number;
  startLabel: string;
  text: string;
}

export interface TranscriptPayload {
  source: 'youtube_api';
  segments: TranscriptSegment[];
  unavailableReason?: string;
}

export type ScanKind = 'webpage' | 'youtube_video';

export interface ContextSnippet {
  id: string;
  text: string;
  timestampSec?: number;
  timestampLabel?: string;
}

export type MainArticleBlockType = 'heading' | 'paragraph' | 'list_item' | 'quote';

export interface MainArticleBlock {
  id: string;
  type: MainArticleBlockType;
  text: string;
  level?: number;
}

export interface MainArticleContent {
  source: 'readability';
  articleTitle: string;
  byline?: string;
  text: string;
  blocks: MainArticleBlock[];
  charCount: number;
  extractedAt: string;
}

export interface TabContext {
  tabId: number;
  url: string;
  title: string;
  scanKind: ScanKind;
  videoId?: string;
  scannedAt: string;
  text: string;
  snippets: ContextSnippet[];
  transcript?: TranscriptPayload;
  mainArticle?: MainArticleContent;
  truncated: boolean;
  contextChars: number;
}

export interface ScanReport {
  tabId: number;
  url: string;
  title: string;
  scanKind: ScanKind;
  videoId?: string;
  transcript?: TranscriptPayload;
  scannedAt: string;
  truncated: boolean;
  contextChars: number;
  snippetCount: number;
}

export interface SourceSnippet extends ContextSnippet {
  score: number;
  quote?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  sources?: SourceSnippet[];
}

export interface ChatSession {
  tabId: number;
  url: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
}

export interface AutofillProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateOrProvince: string;
  postalOrZip: string;
  country: string;
}

export type AutofillFieldKey =
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'phone'
  | 'addressLine1'
  | 'addressLine2'
  | 'city'
  | 'stateProvince'
  | 'postalZip'
  | 'country';

export interface DetectedFormField {
  index: number;
  elementType: 'input' | 'textarea' | 'select';
  inputType: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  labelText: string;
  fieldKey: AutofillFieldKey | null;
}

export interface EmbeddedPanelUpdate {
  type: 'EMBEDDED_PANEL_UPDATE';
  tabId: number;
  status: ScanStatus;
  report: ScanReport | null;
  session: ChatSession | null;
}

export type RewriteLevel = 1 | 2 | 3;

export type RuntimeRequest =
  | { type: 'SAVE_API_KEY'; apiKey: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SIMPLIFY_TEXT'; text: string; level?: RewriteLevel }
  | { type: 'SUMMARIZE_TEXT'; text: string; level?: RewriteLevel }
  | { type: 'SERP_FETCH_PAGE_PREVIEW'; url: string }
  | {
      type: 'SERP_AI_RANK_RESULTS';
      userIntent: string;
      results: Array<{
        title: string;
        url: string;
        snippet: string;
        domain: string;
        preview?: string;
      }>;
    }
  | { type: 'START_SCAN'; tabId?: number }
  | { type: 'GET_EMBEDDED_PANEL_STATE' }
  | { type: 'GET_SCAN_STATUS'; tabId?: number }
  | { type: 'GET_REPORT'; tabId: number }
  | { type: 'GET_MAIN_ARTICLE'; tabId?: number }
  | { type: 'GET_TRANSCRIPT'; videoId: string; tabId?: number }
  | { type: 'GET_CHAT_SESSION'; tabId: number }
  | { type: 'CLEAR_CHAT_SESSION'; tabId: number }
  | { type: 'ASK_CHAT_QUESTION'; question: string; tabId?: number }
  | { type: 'JUMP_TO_SOURCE_SNIPPET'; tabId: number; source: SourceSnippet };

export interface ExtractionResult {
  url: string;
  title: string;
  lang: string;
  text: string;
  charCount: number;
}

export interface YouTubeTranscriptExtractionResult {
  ok: boolean;
  source?: 'youtube_api';
  segments?: TranscriptSegment[];
  reason?: string;
}

export interface ChatAnswer {
  answer: string;
  sources: SourceSnippet[];
}
