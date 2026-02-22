const UNITY_SERP_STYLE_ID = 'unity-serp-intel-style';
const UNITY_SERP_PANEL_ID = 'unity-serp-intel-panel';
const UNITY_SERP_CANDIDATE_BADGE_ATTR = 'data-unity-serp-candidate-badge';
const UNITY_SERP_RECOMMENDATIONS_ID = 'unity-serp-recommendations';
const UNITY_SERP_TARGET_HIGHLIGHT_CLASS = 'unity-serp-target-highlight';

const INPUT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'by', 'for', 'from', 'how', 'i', 'if',
  'in', 'is', 'it', 'latest', 'me', 'my', 'news', 'of', 'on', 'or', 'please', 'results', 'show',
  'tell', 'that', 'the', 'this', 'to', 'us', 'want', 'what', 'with', 'you', 'your',
]);

const MAJOR_NEWS_DOMAINS = [
  'reuters.com',
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'theguardian.com',
  'bloomberg.com',
  'cnn.com',
  'npr.org',
] as const;

const AFFILIATE_TERMS = ['best', 'top', 'review', 'deal', 'buy', 'coupon', 'sponsored'] as const;

type SerpResult = {
  title: string;
  url: string;
  snippet: string;
};

type SerpResultWithNode = SerpResult & {
  titleNode: HTMLHeadingElement;
};

type RankedSerpResult = SerpResultWithNode & {
  domain: string;
  score: number;
  matchedKeywords: string[];
  affiliateHits: string[];
  reputable: boolean;
  why: string;
};

type PagePreviewResponse = {
  ok: boolean;
  url: string;
  finalUrl?: string;
  title?: string;
  metaDescription?: string;
  about?: string;
  error?: string;
};

type SerpAiRankResponse = {
  ok: boolean;
  rankedResults?: Array<{ url?: string; reason?: string }>;
  flags?: {
    commercial_intent?: string;
    depth?: string;
    neutrality?: string;
  };
  error?: string;
};

const ext = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof browser;
let activeHighlightHost: HTMLElement | null = null;
let activeHighlightWrapper: HTMLSpanElement | null = null;
let highlightResetTimer: number | null = null;

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function tokenizeKeywords(value: string): string[] {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalized.split(/\s+/)) {
    if (token.length < 3) continue;
    if (INPUT_STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function domainIsReputable(domain: string): boolean {
  if (!domain) return false;
  if (domain.endsWith('.edu') || domain.endsWith('.gov')) return true;
  return MAJOR_NEWS_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

function containsWord(haystack: string, word: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
  return pattern.test(haystack);
}

function scoreResult(result: SerpResultWithNode, keywords: string[]): RankedSerpResult {
  const titleTokens = new Set(tokenizeKeywords(result.title));
  const snippetTokens = new Set(tokenizeKeywords(result.snippet));
  const domain = extractDomain(result.url);
  const reputable = domainIsReputable(domain);
  const snippetLower = result.snippet.toLowerCase();

  const matchedInTitle = keywords.filter((keyword) => titleTokens.has(keyword));
  const matchedInSnippet = keywords.filter((keyword) => snippetTokens.has(keyword) && !matchedInTitle.includes(keyword));
  const affiliateHits = AFFILIATE_TERMS.filter((term) => containsWord(snippetLower, term));

  let score = 0;
  score += matchedInTitle.length * 3;
  score += matchedInSnippet.length * 1.6;
  if (reputable) {
    score += domain.endsWith('.edu') || domain.endsWith('.gov') ? 2.6 : 1.8;
  }
  score -= affiliateHits.length * 1.6;

  const whyParts: string[] = [];
  const matched = [...matchedInTitle, ...matchedInSnippet];
  if (matched.length > 0) {
    whyParts.push(`Matched: ${matched.slice(0, 3).join(', ')}`);
  }
  if (reputable) {
    whyParts.push(domain.endsWith('.edu') || domain.endsWith('.gov') ? 'Reputable domain (.edu/.gov)' : 'Major news source');
  }
  if (affiliateHits.length > 0) {
    whyParts.push(`Affiliate-like terms: ${affiliateHits.slice(0, 2).join(', ')}`);
  }
  if (whyParts.length === 0) {
    whyParts.push('Basic title/snippet relevance');
  }

  return {
    ...result,
    domain,
    score,
    matchedKeywords: matched,
    affiliateHits: [...affiliateHits],
    reputable,
    why: whyParts.join(' • '),
  };
}

function rankResults(results: SerpResultWithNode[], userInput: string): RankedSerpResult[] {
  const keywords = tokenizeKeywords(userInput);
  return results
    .map((result, index) => ({ rankSeed: index, scored: scoreResult(result, keywords) }))
    .sort((left, right) => {
      if (right.scored.score !== left.scored.score) return right.scored.score - left.scored.score;
      return left.rankSeed - right.rankSeed;
    })
    .map((entry) => entry.scored)
    .slice(0, 10);
}

function applyAiRanking(
  heuristicRanked: RankedSerpResult[],
  aiRanked: Array<{ url?: string; reason?: string }> | undefined,
): RankedSerpResult[] {
  if (!Array.isArray(aiRanked) || aiRanked.length === 0) {
    return heuristicRanked;
  }

  const byUrl = new Map<string, RankedSerpResult[]>();
  for (const item of heuristicRanked) {
    const group = byUrl.get(item.url) ?? [];
    group.push(item);
    byUrl.set(item.url, group);
  }

  const used = new Set<RankedSerpResult>();
  const merged: RankedSerpResult[] = [];

  for (const candidate of aiRanked) {
    const url = normalizeText(candidate?.url);
    if (!url) continue;
    const group = byUrl.get(url);
    if (!group || group.length === 0) continue;

    const chosen = group.find((entry) => !used.has(entry));
    if (!chosen) continue;

    used.add(chosen);
    merged.push({
      ...chosen,
      why: normalizeText(candidate?.reason) || chosen.why,
    });
  }

  for (const item of heuristicRanked) {
    if (used.has(item)) continue;
    merged.push(item);
  }

  return merged.slice(0, 10);
}

function isGoogleSearchPage(url: string = location.href): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return /(^|\.)google\./.test(host) && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

function extractOrganicResults(): SerpResultWithNode[] {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('#search .MjjYud, #search .g'));
  const seen = new Set<string>();
  const results: SerpResultWithNode[] = [];

  for (const row of rows) {
    const titleNode = row.querySelector<HTMLHeadingElement>('h3');
    if (!titleNode) continue;

    const title = normalizeText(titleNode.textContent);
    if (!title) continue;

    let link = titleNode.closest('a[href]') as HTMLAnchorElement | null;
    if (!link) {
      const candidates = Array.from(row.querySelectorAll<HTMLAnchorElement>('a[href]'));
      link = candidates.find((candidate) => candidate.contains(titleNode)) ?? null;
    }
    if (!link) continue;

    const url = normalizeText(link.href);
    if (!/^https?:\/\//i.test(url)) continue;

    const dedupeKey = url.split('#')[0];
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const snippetNode = row.querySelector<HTMLElement>('.VwiC3b, .IsZvec, [data-sncf="1"], .lyLwlc');
    const snippet = normalizeText(snippetNode?.textContent);

    results.push({ title, url, snippet, titleNode });
  }

  return results;
}

function clearCandidateBadges() {
  const badges = Array.from(document.querySelectorAll<HTMLElement>(`[${UNITY_SERP_CANDIDATE_BADGE_ATTR}="true"]`));
  for (const badge of badges) {
    badge.remove();
  }
}

function tagTopCandidateResults(results: RankedSerpResult[], topN = 5) {
  clearCandidateBadges();
  for (const [index, result] of results.slice(0, topN).entries()) {
    const badge = document.createElement('span');
    badge.setAttribute(UNITY_SERP_CANDIDATE_BADGE_ATTR, 'true');
    if (index === 0) {
      badge.textContent = 'Best match';
      badge.className = 'unity-serp-candidate unity-serp-candidate--best';
    } else if (index <= 2) {
      badge.textContent = 'Good match';
      badge.className = 'unity-serp-candidate unity-serp-candidate--good';
    } else {
      badge.textContent = 'Less relevant';
      badge.className = 'unity-serp-candidate unity-serp-candidate--less';
    }
    result.titleNode.append(' ', badge);
  }
}

function clearActiveHighlight() {
  if (highlightResetTimer !== null) {
    window.clearTimeout(highlightResetTimer);
    highlightResetTimer = null;
  }

  if (activeHighlightHost && activeHighlightWrapper && activeHighlightWrapper.parentElement === activeHighlightHost) {
    while (activeHighlightWrapper.firstChild) {
      activeHighlightHost.insertBefore(activeHighlightWrapper.firstChild, activeHighlightWrapper);
    }
    activeHighlightWrapper.remove();
  }

  activeHighlightHost = null;
  activeHighlightWrapper = null;
}

function applyFlashingTextHighlight(titleNode: HTMLHeadingElement) {
  clearActiveHighlight();
  if (!titleNode.isConnected) return;

  const wrapper = document.createElement('span');
  wrapper.className = UNITY_SERP_TARGET_HIGHLIGHT_CLASS;

  while (titleNode.firstChild) {
    wrapper.appendChild(titleNode.firstChild);
  }
  titleNode.appendChild(wrapper);

  activeHighlightHost = titleNode;
  activeHighlightWrapper = wrapper;

  highlightResetTimer = window.setTimeout(() => {
    clearActiveHighlight();
  }, 2800);
}

function focusResultOnPage(result: RankedSerpResult) {
  const target = result.titleNode.closest<HTMLElement>('.MjjYud, .g') ?? result.titleNode;
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  applyFlashingTextHighlight(result.titleNode);
}

function createRedirectButton(result: RankedSerpResult): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'unity-serp-reco-action';
  button.textContent = 'Redirect to article';
  button.addEventListener('click', () => {
    focusResultOnPage(result);
  });
  return button;
}

function renderTopRecommendations(container: HTMLElement, ranked: RankedSerpResult[]) {
  container.replaceChildren();
  const topThree = ranked.slice(0, 3);
  if (topThree.length === 0) return;

  const list = document.createElement('ol');
  list.className = 'unity-serp-reco-list';

  for (const result of topThree) {
    const item = document.createElement('li');
    item.className = 'unity-serp-reco-item';

    const title = document.createElement('p');
    title.className = 'unity-serp-reco-title';
    title.textContent = result.title;

    const action = createRedirectButton(result);

    const domain = document.createElement('p');
    domain.className = 'unity-serp-reco-domain';
    domain.textContent = result.domain || 'unknown source';

    const why = document.createElement('p');
    why.className = 'unity-serp-reco-why';
    why.textContent = result.why;

    item.append(title, action, domain, why);
    list.appendChild(item);
  }

  container.appendChild(list);
}

function renderTopRecommendationsWithPreviews(
  container: HTMLElement,
  ranked: RankedSerpResult[],
  previewsByUrl: Map<string, PagePreviewResponse>,
) {
  container.replaceChildren();
  const topThree = ranked.slice(0, 3);
  if (topThree.length === 0) return;

  const list = document.createElement('ol');
  list.className = 'unity-serp-reco-list';

  for (const result of topThree) {
    const item = document.createElement('li');
    item.className = 'unity-serp-reco-item';

    const title = document.createElement('p');
    title.className = 'unity-serp-reco-title';
    title.textContent = result.title;

    const action = createRedirectButton(result);

    const domain = document.createElement('p');
    domain.className = 'unity-serp-reco-domain';
    domain.textContent = result.domain || 'unknown source';

    const why = document.createElement('p');
    why.className = 'unity-serp-reco-why';
    why.textContent = result.why;

    const previewTitle = document.createElement('p');
    previewTitle.className = 'unity-serp-preview-title';
    previewTitle.textContent = 'What this page is about';

    const previewBody = document.createElement('p');
    previewBody.className = 'unity-serp-preview-body';
    const preview = previewsByUrl.get(result.url);
    previewBody.textContent =
      normalizeText(preview?.about) ||
      normalizeText(preview?.metaDescription) ||
      'Preview unavailable for this page.';

    item.append(title, action, domain, why, previewTitle, previewBody);
    list.appendChild(item);
  }

  container.appendChild(list);
}

async function fetchPreviewsForTopResults(ranked: RankedSerpResult[]): Promise<Map<string, PagePreviewResponse>> {
  const topThree = ranked.slice(0, 3);
  const uniqueUrls = Array.from(new Set(topThree.map((item) => item.url)));
  const resultMap = new Map<string, PagePreviewResponse>();

  await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const response = (await ext.runtime.sendMessage({
          type: 'SERP_FETCH_PAGE_PREVIEW',
          url,
        })) as PagePreviewResponse | undefined;
        if (response && response.url) {
          resultMap.set(url, response);
          return;
        }
      } catch {
        // Ignore preview failures per URL.
      }
      resultMap.set(url, { ok: false, url, error: 'Preview request failed.' });
    }),
  );

  return resultMap;
}

async function requestAiRanking(input: {
  userIntent: string;
  ranked: RankedSerpResult[];
  previewsByUrl?: Map<string, PagePreviewResponse>;
}): Promise<SerpAiRankResponse> {
  const payloadResults = input.ranked.map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    domain: item.domain,
    ...(input.previewsByUrl?.get(item.url)?.about
      ? { preview: normalizeText(input.previewsByUrl?.get(item.url)?.about).slice(0, 320) }
      : {}),
  }));

  const response = (await ext.runtime.sendMessage({
    type: 'SERP_AI_RANK_RESULTS',
    userIntent: input.userIntent,
    results: payloadResults,
  })) as SerpAiRankResponse | undefined;

  if (!response) {
    return { ok: false, error: 'Empty AI response.' };
  }
  return response;
}

function installStyles() {
  if (document.getElementById(UNITY_SERP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = UNITY_SERP_STYLE_ID;
  style.textContent = `
    #${UNITY_SERP_PANEL_ID} {
      position: fixed;
      top: 110px;
      right: 16px;
      width: 320px;
      z-index: 2147483646;
      border: 2px solid #111;
      border-radius: 14px;
      background: #fff;
      color: #111;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.14);
      font-family: 'Plus Jakarta Sans', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      line-height: 1.4;
      padding: 12px;
    }

    #${UNITY_SERP_PANEL_ID} * {
      box-sizing: border-box;
      font-family: inherit;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-title {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-copy {
      margin: 6px 0 10px;
      font-size: 12px;
      color: #333;
    }

    #${UNITY_SERP_PANEL_ID} textarea {
      width: 100%;
      min-height: 68px;
      resize: vertical;
      border: 2px solid #111;
      border-radius: 10px;
      background: #fff;
      color: #111;
      padding: 8px 10px;
      outline: none;
    }

    #${UNITY_SERP_PANEL_ID} textarea:focus {
      box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.14);
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 10px;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-btn {
      border: 2px solid #111;
      border-radius: 999px;
      background: #111;
      color: #fff;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-btn:hover {
      background: #222;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-status {
      margin: 0;
      font-size: 11px;
      color: #444;
      min-height: 16px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 700;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-toggle {
      margin-top: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: #333;
      font-weight: 600;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-toggle input {
      width: 14px;
      height: 14px;
      accent-color: #111;
      margin: 0;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-list {
      margin: 10px 0 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-item {
      border: 1px solid #d0d0d0;
      border-radius: 10px;
      padding: 7px 8px;
      background: #fff;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-title {
      display: block;
      color: #111;
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      margin: 0 0 4px;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-action {
      border: 1px solid #111;
      border-radius: 999px;
      background: #fff;
      color: #111;
      padding: 4px 9px;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      margin: 0 0 6px;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-action:hover {
      background: #111;
      color: #fff;
    }

    #search .${UNITY_SERP_TARGET_HIGHLIGHT_CLASS} {
      color: inherit;
      background: transparent;
      padding: 0 4px;
      border-radius: 2px;
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      animation: unity-serp-text-highlight-flash 2400ms linear 1 forwards;
    }

    @keyframes unity-serp-text-highlight-flash {
      0%,
      8%,
      40%,
      52%,
      84%,
      100% {
        background: transparent;
      }

      18%,
      30%,
      62%,
      74% {
        background: rgba(17, 17, 17, 0.22);
      }
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-domain {
      margin: 0 0 2px;
      font-size: 10px;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 700;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-reco-why {
      margin: 0;
      font-size: 11px;
      color: #333;
      line-height: 1.35;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-preview-title {
      margin: 6px 0 2px;
      font-size: 10px;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 700;
    }

    #${UNITY_SERP_PANEL_ID} .unity-serp-preview-body {
      margin: 0;
      font-size: 11px;
      color: #222;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    #search [${UNITY_SERP_CANDIDATE_BADGE_ATTR}="true"] {
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
      padding: 2px 8px;
      border: 1px solid #777;
      border-radius: 999px;
      background: #fff;
      color: #444;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.3;
      vertical-align: middle;
      white-space: nowrap;
    }

    #search .unity-serp-candidate--best {
      background: #111;
      color: #fff;
      border-color: #111;
    }

    #search .unity-serp-candidate--good {
      border-color: #444;
      color: #222;
    }

    #search .unity-serp-candidate--less {
      border-color: #9a9a9a;
      color: #666;
    }

    @media (max-width: 1180px) {
      #${UNITY_SERP_PANEL_ID} {
        top: auto;
        right: 12px;
        bottom: 12px;
        width: min(340px, calc(100vw - 24px));
      }
    }
  `;

  document.documentElement.appendChild(style);
}

function ensurePanel() {
  if (!isGoogleSearchPage()) return;
  if (!document.body) return;
  if (document.getElementById(UNITY_SERP_PANEL_ID)) return;

  const panel = document.createElement('aside');
  panel.id = UNITY_SERP_PANEL_ID;
  panel.setAttribute('aria-label', 'Unity Search panel');
  panel.innerHTML = `
    <h2 class="unity-serp-title">Unity Search</h2>
    <p class="unity-serp-copy">Tell us what you care about, we'll recommend the best result.</p>
    <textarea placeholder="Example: Fan perspective, rumors, and tactical analysis"></textarea>
    <label class="unity-serp-toggle">
      <input type="checkbox" class="unity-serp-preview-toggle" />
      <span>Enable page previews (slower)</span>
    </label>
    <div class="unity-serp-actions">
      <button type="button" class="unity-serp-btn">Analyze results</button>
      <p class="unity-serp-status">Ready</p>
    </div>
    <div id="${UNITY_SERP_RECOMMENDATIONS_ID}" aria-live="polite"></div>
  `;

  const textarea = panel.querySelector('textarea');
  const button = panel.querySelector<HTMLButtonElement>('.unity-serp-btn');
  const status = panel.querySelector<HTMLElement>('.unity-serp-status');
  const recommendations = panel.querySelector<HTMLElement>(`#${UNITY_SERP_RECOMMENDATIONS_ID}`);
  const previewToggle = panel.querySelector<HTMLInputElement>('.unity-serp-preview-toggle');

  if (button && status && recommendations) {
    button.addEventListener('click', async () => {
      const userInput = normalizeText(textarea?.value ?? '');
      status.textContent = 'Analyzing...';

      const results = extractOrganicResults();
      const heuristicRanked = rankResults(results, userInput);
      const previewsEnabled = Boolean(previewToggle?.checked);
      const previewMap = previewsEnabled ? await fetchPreviewsForTopResults(heuristicRanked) : new Map<string, PagePreviewResponse>();

      let finalRanked = heuristicRanked;
      let aiFlags: SerpAiRankResponse['flags'] | undefined;
      try {
        const aiResponse = await requestAiRanking({
          userIntent: userInput || 'General relevance',
          ranked: heuristicRanked,
          previewsByUrl: previewsEnabled ? previewMap : undefined,
        });
        if (aiResponse.ok) {
          finalRanked = applyAiRanking(heuristicRanked, aiResponse.rankedResults);
          aiFlags = aiResponse.flags;
        } else {
          console.warn('[Unity Search v1] AI ranking unavailable; falling back to heuristics.', aiResponse.error ?? '');
        }
      } catch (error) {
        console.warn('[Unity Search v1] AI ranking failed; falling back to heuristics.', error);
      }

      if (previewsEnabled) {
        const finalTopThreeUrls = new Set(finalRanked.slice(0, 3).map((item) => item.url));
        const missingUrls = Array.from(finalTopThreeUrls).filter((url) => !previewMap.has(url));
        if (missingUrls.length > 0) {
          const additionalPreviewMap = await fetchPreviewsForTopResults(
            finalRanked.filter((item) => missingUrls.includes(item.url)),
          );
          for (const [url, preview] of additionalPreviewMap) {
            previewMap.set(url, preview);
          }
        }
      }

      const plainResults: SerpResult[] = finalRanked.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
      }));

      tagTopCandidateResults(finalRanked, 5);
      renderTopRecommendations(recommendations, finalRanked);

      if (previewsEnabled) {
        renderTopRecommendationsWithPreviews(recommendations, finalRanked, previewMap);
      }

      console.log('[Unity Search v1] Preference:', userInput || '(empty)');
      console.log(`[Unity Search v1] Detected ${results.length} organic results.`);
      console.table(
        finalRanked.map((item) => ({
          title: item.title,
          url: item.url,
          domain: item.domain,
          score: Number(item.score.toFixed(2)),
          why: item.why,
        })),
      );
      console.log('[Unity Search v1] Top ranked (up to 10):', plainResults);
      if (aiFlags) {
        console.log('[Unity Search v1] AI flags:', aiFlags);
      }

      status.textContent = `Found ${results.length} results. Tagged top 5.`;
    });
  }

  document.body.appendChild(panel);
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main() {
    if (window.top !== window) return;
    if (!isGoogleSearchPage()) return;

    installStyles();
    ensurePanel();
  },
});
