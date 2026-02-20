import { callOpenRouterJson } from '@/lib/openrouter';
import type { ChatAnswer, ContextSnippet, SourceSnippet, TabContext, TranscriptSegment } from '@/lib/types';

const MAX_WEB_SNIPPETS = 240;
const MAX_SNIPPET_LENGTH = 280;
const MAX_CONTEXT_CHARS = 90_000;
const TIMESTAMP_GROUP_GAP_SECONDS = 5;

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'to', 'of', 'in', 'on', 'at', 'for', 'from', 'by', 'with', 'without', 'about', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'as', 'it', 'its', 'they', 'them', 'their', 'he', 'she',
  'his', 'her', 'you', 'your', 'we', 'our', 'i', 'me', 'my', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'just', 'not', 'no', 'yes', 'into', 'out', 'over', 'under', 'up',
  'down', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'also', 'there', 'here',
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateForSnippet(value: string): string {
  if (value.length <= MAX_SNIPPET_LENGTH) return value;
  return `${value.slice(0, MAX_SNIPPET_LENGTH - 1).trimEnd()}…`;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function buildWebSnippets(text: string): ContextSnippet[] {
  const lines = text
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length >= 30);

  const snippets: ContextSnippet[] = [];
  let pending = '';

  const flush = () => {
    const cleaned = normalizeWhitespace(pending);
    if (!cleaned) return;
    snippets.push({
      id: `w-${snippets.length + 1}`,
      text: truncateForSnippet(cleaned),
    });
    pending = '';
  };

  for (const line of lines) {
    if (!pending) {
      pending = line;
      continue;
    }

    const candidate = `${pending} ${line}`;
    if (candidate.length > MAX_SNIPPET_LENGTH + 50) {
      flush();
      pending = line;
      continue;
    }

    pending = candidate;
  }

  flush();

  if (snippets.length === 0) {
    const fallback = normalizeWhitespace(text).slice(0, 1400);
    if (fallback) {
      snippets.push({ id: 'w-1', text: truncateForSnippet(fallback) });
    }
  }

  return snippets.slice(0, MAX_WEB_SNIPPETS);
}

function buildTranscriptSnippets(segments: TranscriptSegment[]): ContextSnippet[] {
  return segments
    .filter((segment) => Number.isFinite(segment.startSec) && segment.text.trim().length > 0)
    .map((segment, index) => ({
      id: `t-${index + 1}`,
      text: truncateForSnippet(normalizeWhitespace(segment.text)),
      timestampSec: segment.startSec,
      timestampLabel: segment.startLabel,
    }))
    .filter((snippet) => snippet.text.length >= 8);
}

export function buildContextSnippets(input: {
  text: string;
  transcriptSegments?: TranscriptSegment[];
}): ContextSnippet[] {
  const transcriptSegments = input.transcriptSegments ?? [];
  if (transcriptSegments.length > 0) {
    return buildTranscriptSnippets(transcriptSegments);
  }
  return buildWebSnippets(input.text);
}

function scoreSnippet(questionTokens: string[], snippet: ContextSnippet): number {
  if (questionTokens.length === 0) return 0;

  const snippetTokens = new Set(tokenize(snippet.text));
  if (snippetTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of questionTokens) {
    if (snippetTokens.has(token)) overlap += 1;
  }

  const overlapScore = overlap / questionTokens.length;
  const phraseBonus = normalizeWhitespace(snippet.text)
    .toLowerCase()
    .includes(normalizeWhitespace(questionTokens.slice(0, 4).join(' ')).toLowerCase())
    ? 0.1
    : 0;

  return Math.min(1, overlapScore + phraseBonus);
}

function rankRelevantSnippets(question: string, snippets: ContextSnippet[]): SourceSnippet[] {
  const questionTokens = tokenize(question);

  const scored = snippets
    .map((snippet) => {
      const score = scoreSnippet(questionTokens, snippet);
      return {
        ...snippet,
        score,
      } satisfies SourceSnippet;
    })
    .sort((left, right) => right.score - left.score);

  const positive = scored.filter((snippet) => snippet.score > 0);
  if (positive.length > 0) {
    return positive.slice(0, 10);
  }

  return scored.slice(0, Math.min(5, scored.length)).map((snippet, index) => ({
    ...snippet,
    score: Math.max(0.05, 0.1 - index * 0.01),
  }));
}

interface ModelResponse {
  answer?: unknown;
  sources?: Array<{
    id?: unknown;
    quote?: unknown;
    score?: unknown;
  }>;
}

function buildGroundedPrompt(input: {
  url: string;
  title: string;
  question: string;
  snippets: SourceSnippet[];
}): string {
  const hasTimestampedSnippets = input.snippets.some((snippet) => Boolean(snippet.timestampLabel));
  return [
    'You are Unity, a grounded assistant for webpage and YouTube content.',
    'Answer only from the provided snippets.',
    'If the snippets do not support a reliable answer, say that the page/video does not contain enough evidence.',
    'Do not invent facts, sources, or citations.',
    'Return strict JSON with this shape only:',
    '{"answer":"string","sources":[{"id":"snippet id","quote":"short supporting quote","score":0.0}]}',
    'Rules:',
    '- Keep answer concise and directly responsive to the question.',
    '- Use 1 to 5 sources when evidence exists.',
    '- source.id must match a snippet id from the provided list.',
    '- source.quote should be a short extract from that snippet.',
    ...(hasTimestampedSnippets
      ? ['- Prefer citing snippets that include timestampLabel when available.']
      : []),
    `URL: ${input.url}`,
    `TITLE: ${input.title}`,
    `QUESTION: ${input.question}`,
    `SNIPPETS_JSON: ${JSON.stringify(input.snippets)}`,
  ].join('\n');
}

function coerceModelAnswer(value: unknown): string {
  if (typeof value !== 'string') return '';
  return normalizeWhitespace(value);
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

function timestampOf(snippet: SourceSnippet): number | null {
  const candidate = snippet.timestampSec;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) return null;
  return candidate;
}

function collapseNearbyTimestampSources(sources: SourceSnippet[]): SourceSnippet[] {
  if (sources.length <= 1) return sources.slice(0, 5);

  const timestamped = sources
    .map((snippet) => {
      const timestamp = timestampOf(snippet);
      if (timestamp == null) return null;
      return { snippet, timestamp };
    })
    .filter((item): item is { snippet: SourceSnippet; timestamp: number } => item != null)
    .sort((left, right) => left.timestamp - right.timestamp);

  if (timestamped.length === 0) {
    return sources.slice(0, 5);
  }

  const groups: Array<Array<{ snippet: SourceSnippet; timestamp: number }>> = [];
  let current: Array<{ snippet: SourceSnippet; timestamp: number }> = [];

  for (const item of timestamped) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }

    const previous = current[current.length - 1];
    if (item.timestamp - previous.timestamp <= TIMESTAMP_GROUP_GAP_SECONDS) {
      current.push(item);
      continue;
    }

    groups.push(current);
    current = [item];
  }

  if (current.length > 0) {
    groups.push(current);
  }

  const collapsed = groups.map((group) => {
    if (group.length === 1) {
      return group[0].snippet;
    }

    const first = group[0];
    const last = group[group.length - 1];
    const strongest = [...group].sort((left, right) => right.snippet.score - left.snippet.score)[0]?.snippet ?? first.snippet;

    const startLabel = first.snippet.timestampLabel ?? formatSecondsLabel(first.timestamp);
    const endLabel = last.snippet.timestampLabel ?? formatSecondsLabel(last.timestamp);
    const mergedLabel = startLabel === endLabel ? startLabel : `${startLabel}-${endLabel}`;
    const mergedScore = Math.max(...group.map((item) => item.snippet.score));
    const mergedText = group
      .map((item) => normalizeWhitespace(item.snippet.text))
      .filter((text, index, list) => text.length > 0 && list.indexOf(text) === index)
      .slice(0, 3)
      .join(' ... ');

    return {
      ...strongest,
      id: first.snippet.id,
      timestampSec: first.timestamp,
      timestampLabel: mergedLabel,
      text: mergedText || strongest.text,
      score: mergedScore,
    };
  });

  return collapsed.slice(0, 5);
}

function coerceSources(inputSources: ModelResponse['sources'], ranked: SourceSnippet[]): SourceSnippet[] {
  if (!Array.isArray(inputSources) || ranked.length === 0) {
    const timestamped = ranked.filter((snippet) => snippet.timestampLabel);
    if (timestamped.length > 0) {
      return collapseNearbyTimestampSources(timestamped.slice(0, Math.min(5, timestamped.length)));
    }
    return ranked.slice(0, Math.min(3, ranked.length));
  }

  const byId = new Map(ranked.map((snippet) => [snippet.id, snippet]));
  const picked: SourceSnippet[] = [];

  for (const candidate of inputSources) {
    const id = typeof candidate?.id === 'string' ? candidate.id : '';
    const base = byId.get(id);
    if (!base) continue;

    const scoreRaw = Number(candidate?.score);
    const score = Number.isFinite(scoreRaw)
      ? Math.max(0, Math.min(1, scoreRaw))
      : base.score;

    if (picked.some((item) => item.id === base.id)) continue;

    picked.push({
      ...base,
      // Keep original extracted snippet text for reliable in-page/source matching.
      text: base.text,
      score,
    });
  }

  if (picked.length > 0) {
    const hasTimestampedPool = ranked.some((snippet) => Boolean(snippet.timestampLabel));
    if (hasTimestampedPool) {
      const timestampedPicked = picked.filter((snippet) => snippet.timestampLabel);
      if (timestampedPicked.length > 0) {
        return collapseNearbyTimestampSources(timestampedPicked.slice(0, 5));
      }

      const fallbackTimestamped = ranked.filter((snippet) => snippet.timestampLabel);
      if (fallbackTimestamped.length > 0) {
        return collapseNearbyTimestampSources(fallbackTimestamped.slice(0, Math.min(5, fallbackTimestamped.length)));
      }
    }

    return collapseNearbyTimestampSources(picked.slice(0, 5));
  }

  const timestamped = ranked.filter((snippet) => snippet.timestampLabel);
  if (timestamped.length > 0) {
    return collapseNearbyTimestampSources(timestamped.slice(0, Math.min(5, timestamped.length)));
  }

  return collapseNearbyTimestampSources(ranked.slice(0, Math.min(5, ranked.length)));
}

export async function answerQuestionFromContext(input: {
  apiKey: string;
  question: string;
  context: TabContext;
}): Promise<ChatAnswer> {
  const question = normalizeWhitespace(input.question);
  if (!question) {
    throw new Error('Question cannot be empty.');
  }

  const contextText = input.context.text.slice(0, MAX_CONTEXT_CHARS);
  const snippets = input.context.snippets.length > 0
    ? input.context.snippets
    : buildContextSnippets({
      text: contextText,
      transcriptSegments: input.context.transcript?.segments,
    });

  if (snippets.length === 0) {
    return {
      answer: 'I could not find enough readable text on this page/video to answer that question.',
      sources: [],
    };
  }

  const ranked = rankRelevantSnippets(question, snippets);
  const prompt = buildGroundedPrompt({
    url: input.context.url,
    title: input.context.title,
    question,
    snippets: ranked,
  });

  const response = await callOpenRouterJson<ModelResponse>({
    apiKey: input.apiKey,
    prompt,
  });

  const answer = coerceModelAnswer(response.answer);
  const sources = coerceSources(response.sources, ranked);

  if (!answer) {
    return {
      answer: 'I could not produce a reliable grounded answer from the current page/video context.',
      sources,
    };
  }

  return { answer, sources };
}
