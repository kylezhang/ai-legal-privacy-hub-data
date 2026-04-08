import { readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Parser from 'rss-parser';
import { translate } from '@vitalets/google-translate-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(REPO_ROOT, 'news.json');

const CACHE_VERSION = 1;
const MAX_CACHE_ITEMS = 200;
const FEED_ITEM_LIMIT = 8;
const TRANSLATION_BACKFILL_LIMIT = 40;
const TRANSLATION_CONCURRENCY = 6;
const GOOGLE_TRANSLATE_TIMEOUT_MS = 1200;
const FALLBACK_TRANSLATE_TIMEOUT_MS = 4000;
const TRANSLATION_SPLIT_TOKEN = '[[AI_LEGAL_HUB_SPLIT]]';
const TAVILY_API_URL = 'https://api.tavily.com/search';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TAVILY_RESULTS_PER_SEARCH = 3;
const TAVILY_FETCH_TIMEOUT_MS = 8000;

const FEEDS = [
  {
    url: 'https://artificialintelligenceact.eu/feed/',
    source: 'EU AI Act',
    region: 'EU',
  },
  {
    url: 'https://edpb.europa.eu/feed/news_en',
    source: 'EDPB',
    region: 'EU',
  },
  {
    url: 'https://www.ftc.gov/feeds/blog-business.xml',
    source: 'FTC Business Blog',
    region: 'USA',
  },
];

const TAVILY_SEARCHES = [
  {
    region: 'UK',
    query: 'UK AI regulation privacy enforcement guidance official updates',
    includeDomains: ['ico.org.uk', 'gov.uk'],
  },
  {
    region: 'Canada',
    query: 'Canada artificial intelligence privacy law enforcement official updates',
    includeDomains: ['priv.gc.ca', 'canada.ca'],
  },
  {
    region: 'Singapore',
    query: 'Singapore AI governance privacy regulation official updates',
    includeDomains: ['pdpc.gov.sg', 'imda.gov.sg', 'aiverifyfoundation.sg'],
  },
  {
    region: 'Australia',
    query: 'Australia AI privacy regulation enforcement official updates',
    includeDomains: ['oaic.gov.au', 'industry.gov.au', 'esafety.gov.au'],
  },
  {
    region: 'Global',
    query: 'Global AI governance policy regulation official updates',
    includeDomains: ['oecd.ai', 'unesco.org', 'coe.int', 'cdep.coe.int'],
  },
];

const DOMAIN_SOURCE_LABELS = {
  'ico.org.uk': 'ICO',
  'gov.uk': 'GOV.UK',
  'priv.gc.ca': 'OPC Canada',
  'canada.ca': 'Government of Canada',
  'pdpc.gov.sg': 'PDPC',
  'imda.gov.sg': 'IMDA',
  'aiverifyfoundation.sg': 'AI Verify Foundation',
  'oaic.gov.au': 'OAIC',
  'industry.gov.au': 'Australian Government',
  'esafety.gov.au': 'eSafety Commissioner',
  'oecd.ai': 'OECD AI',
  'unesco.org': 'UNESCO',
  'coe.int': 'Council of Europe',
  'cdep.coe.int': 'Council of Europe',
};

const AI_PATTERNS = [
  /\bai\b/i,
  /artificial intelligence/i,
  /algorithm/i,
  /automated decision/i,
  /foundation model/i,
  /general-purpose ai/i,
  /machine learning/i,
  /biometric/i,
];

const LEGAL_PATTERNS = [
  /\bact\b/i,
  /\blaw\b/i,
  /\blegal\b/i,
  /privacy/i,
  /data protection/i,
  /gdpr/i,
  /regulation/i,
  /regulatory/i,
  /compliance/i,
  /guidance/i,
  /guideline/i,
  /authority/i,
  /board/i,
  /office/i,
  /enforcement/i,
  /investigation/i,
  /lawsuit/i,
  /court/i,
  /sanction/i,
  /\bfine\b/i,
  /transparency/i,
];

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  timeout: 15000,
});

function createEmptyCache() {
  return {
    version: CACHE_VERSION,
    lastSyncedAt: null,
    items: [],
  };
}

function normalizeNewsCache(cache) {
  return {
    version: CACHE_VERSION,
    lastSyncedAt: cache?.lastSyncedAt || null,
    items: Array.isArray(cache?.items) ? cache.items.filter(isNewsItem) : [],
  };
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]*>?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTranslation(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function buildSummary(content, fallback = 'No summary available.') {
  const cleanContent = normalizeText(content);
  if (!cleanContent) {
    return fallback;
  }

  return cleanContent.length > 220
    ? `${cleanContent.substring(0, 220)}...`
    : cleanContent;
}

function isLegallyRelevant(title, summary) {
  const content = `${title} ${summary}`.toLowerCase();
  return (
    AI_PATTERNS.some((pattern) => pattern.test(content)) &&
    LEGAL_PATTERNS.some((pattern) => pattern.test(content))
  );
}

function determineCategory(title, summary) {
  const content = `${title} ${summary}`.toLowerCase();
  if (/(enforcement|investigation|lawsuit|court|fine|sanction|complaint|penalty|order)/.test(content)) {
    return 'Case & Enforcement';
  }
  if (/(privacy|data protection|gdpr|personal data|biometric|surveillance|data breach)/.test(content)) {
    return 'Privacy / Data Protection';
  }
  if (/(guidance|guideline|playbook|toolkit|framework|checklist|compliance)/.test(content)) {
    return 'Compliance Guidance';
  }
  return 'Policy / Regulation';
}

function isNewsItem(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.url === 'string' &&
    typeof value.source === 'string' &&
    typeof value.publishedAt === 'string' &&
    typeof value.category === 'string' &&
    typeof value.region === 'string'
  );
}

function getNewsKey(item) {
  if (item.url && item.url !== '#') {
    return item.url;
  }

  return `${item.source}:${item.id}`;
}

function sortByPublishedAtDesc(items) {
  return [...items].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );
}

function mergeNewsItemFields(primary, secondary) {
  return {
    ...secondary,
    ...primary,
    title: primary.title || secondary.title,
    summary: primary.summary || secondary.summary,
    title_zh: primary.title_zh || secondary.title_zh,
    summary_zh: primary.summary_zh || secondary.summary_zh,
    url: primary.url && primary.url !== '#' ? primary.url : secondary.url,
  };
}

function mergeNewsItems(existingItems, incomingItems) {
  const merged = new Map();

  for (const item of [...incomingItems, ...existingItems]) {
    const key = getNewsKey(item);
    const current = merged.get(key);

    if (!current) {
      merged.set(key, item);
      continue;
    }

    const currentTime = new Date(current.publishedAt).getTime();
    const itemTime = new Date(item.publishedAt).getTime();
    const preferred = itemTime >= currentTime ? item : current;
    const fallback = itemTime >= currentTime ? current : item;
    merged.set(key, mergeNewsItemFields(preferred, fallback));
  }

  return sortByPublishedAtDesc(Array.from(merged.values()));
}

function createKnownNewsIndex(items) {
  return new Map(items.map((item) => [getNewsKey(item), item]));
}

async function readNewsCache() {
  try {
    const raw = await readFile(OUTPUT_FILE, 'utf8');
    return normalizeNewsCache(JSON.parse(raw));
  } catch {
    return createEmptyCache();
  }
}

async function writeNewsCache(items, lastSyncedAt = new Date().toISOString()) {
  const payload = {
    version: CACHE_VERSION,
    lastSyncedAt,
    items: sortByPublishedAtDesc(items).slice(0, MAX_CACHE_ITEMS),
  };

  const tempFile = `${OUTPUT_FILE}.tmp`;
  await writeFile(tempFile, JSON.stringify(payload, null, 2), 'utf8');
  await rename(tempFile, OUTPUT_FILE);
  return payload;
}

function buildNewsItem(item, feed) {
  const cleanSummary = normalizeText(item.contentSnippet || item.content || '');
  const summary = buildSummary(item.contentSnippet || item.content || '');

  return {
    id: item.guid || item.link || `${feed.source}-${item.pubDate || Date.now()}`,
    title: item.title || 'Untitled',
    summary,
    url: item.link || '#',
    source: feed.source,
    publishedAt: item.pubDate || new Date().toISOString(),
    category: determineCategory(item.title || '', cleanSummary),
    region: feed.region,
  };
}

function hasGlobalCoverage(items) {
  const visibleRegions = new Set(items.slice(0, 24).map((item) => item.region));
  const supplementalRegions = ['UK', 'Canada', 'Singapore', 'Australia', 'Global'];
  return supplementalRegions.some((region) => visibleRegions.has(region));
}

function shouldFetchTavily(items, lastSyncedAt) {
  if (!TAVILY_API_KEY) {
    return false;
  }

  if (!lastSyncedAt) {
    return true;
  }

  if (!hasGlobalCoverage(items)) {
    return true;
  }

  const lastSyncedMs = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(lastSyncedMs)) {
    return true;
  }

  return Date.now() - lastSyncedMs >= TAVILY_REFRESH_INTERVAL_MS;
}

function normalizePublishedAt(publishedAt, fallback) {
  if (!publishedAt) {
    return fallback;
  }

  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toISOString();
}

function getSourceLabelFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return DOMAIN_SOURCE_LABELS[hostname] || hostname;
  } catch {
    return 'Global Source';
  }
}

function buildTavilyNewsItem(result, config, knownItems, fallbackPublishedAt) {
  const title = normalizeText(result.title || '');
  const url = result.url || '';
  const content = normalizeText(result.content || '');

  if (!title || !url || !content) {
    return null;
  }

  if (!isLegallyRelevant(title, content)) {
    return null;
  }

  const current = knownItems.get(url);
  return {
    id: url,
    title,
    summary: buildSummary(content),
    url,
    source: current?.source || getSourceLabelFromUrl(url),
    publishedAt: current?.publishedAt || normalizePublishedAt(result.published_date, fallbackPublishedAt),
    category: determineCategory(title, content),
    region: current?.region || config.region,
    title_zh: current?.title_zh,
    summary_zh: current?.summary_zh,
  };
}

async function fetchTavilyResults(config) {
  if (!TAVILY_API_KEY) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAVILY_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_API_URL, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: config.query,
        topic: 'general',
        search_depth: 'basic',
        time_range: 'month',
        max_results: TAVILY_RESULTS_PER_SEARCH,
        include_domains: config.includeDomains,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });

    if (!response.ok) {
      console.error('Tavily search failed:', response.status, response.statusText, config.region);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Tavily search failed:', error?.message || error, config.region);
    }

    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    })
  );

  return results;
}

async function fetchTavilyNewsItems(existingItems, fallbackPublishedAt) {
  const knownItems = createKnownNewsIndex(existingItems);
  const seenKeys = new Set(existingItems.map((item) => getNewsKey(item)));
  const tavilyResults = await mapWithConcurrency(TAVILY_SEARCHES, 2, fetchTavilyResults);
  const items = [];

  for (let index = 0; index < tavilyResults.length; index += 1) {
    const config = TAVILY_SEARCHES[index];
    const results = tavilyResults[index];

    for (const result of results) {
      const item = buildTavilyNewsItem(result, config, knownItems, fallbackPublishedAt);
      if (!item) {
        continue;
      }

      const key = getNewsKey(item);
      if (seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      items.push(item);
    }
  }

  return items;
}

async function tryTranslate(text) {
  if (!text) {
    return '';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TRANSLATE_TIMEOUT_MS);

  try {
    const response = await translate(text, {
      to: 'zh-CN',
      fetchOptions: { signal: controller.signal },
    });
    return response.text;
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Google translation failed:', error?.message || error);
    }

    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function translateWithFallback(text) {
  if (!text) {
    return '';
  }

  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', 'en|zh-CN');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FALLBACK_TRANSLATE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI Legal & Privacy Hub Data/1.0',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      console.error('Fallback translation failed:', response.status, response.statusText);
      return '';
    }

    const data = await response.json();

    if (data.responseStatus && data.responseStatus !== 200) {
      console.error(
        'Fallback translation failed:',
        data.responseStatus,
        data.responseDetails || 'Unknown error'
      );
      return '';
    }

    return typeof data.responseData?.translatedText === 'string'
      ? data.responseData.translatedText
      : '';
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('Fallback translation failed:', error?.message || error);
    }

    return '';
  } finally {
    clearTimeout(timer);
  }
}

function needsChineseTranslation(source, translated) {
  const normalizedSource = normalizeTranslation(source);
  const normalizedTranslated = normalizeTranslation(translated || '');

  if (!normalizedSource) {
    return false;
  }

  if (!normalizedTranslated) {
    return true;
  }

  return normalizedTranslated === normalizedSource && /[A-Za-z]{3}/.test(normalizedSource);
}

async function translateToChinese(text) {
  const normalized = normalizeTranslation(text);
  if (!normalized) {
    return '';
  }

  const fallbackResult = normalizeTranslation(await translateWithFallback(normalized));
  if (fallbackResult && !needsChineseTranslation(normalized, fallbackResult)) {
    return fallbackResult;
  }

  const googleResult = normalizeTranslation(await tryTranslate(normalized));
  if (googleResult && !needsChineseTranslation(normalized, googleResult)) {
    return googleResult;
  }

  return '';
}

function splitTranslatedFields(text) {
  const directParts = text
    .split(TRANSLATION_SPLIT_TOKEN)
    .map((part) => normalizeTranslation(part));

  if (directParts.length === 2) {
    return directParts;
  }

  const looseParts = text
    .split(/\[\[\s*AI_LEGAL_HUB_SPLIT\s*\]\]/i)
    .map((part) => normalizeTranslation(part));

  if (looseParts.length === 2) {
    return looseParts;
  }

  return null;
}

function applyTranslatedField(source, translated, current) {
  if (!translated || needsChineseTranslation(source, translated)) {
    return current;
  }

  return translated;
}

async function translateNewsItem(item) {
  const needsTitle = needsChineseTranslation(item.title, item.title_zh);
  const needsSummary = needsChineseTranslation(item.summary, item.summary_zh);

  if (!needsTitle && !needsSummary) {
    return item;
  }

  const combinedText = [
    needsTitle ? item.title : item.title_zh || item.title,
    needsSummary ? item.summary : item.summary_zh || item.summary,
  ].join(`\n${TRANSLATION_SPLIT_TOKEN}\n`);

  const translatedText = await translateToChinese(combinedText);
  const translatedFields = splitTranslatedFields(translatedText);

  if (!translatedFields) {
    return item;
  }

  const [translatedTitle, translatedSummary] = translatedFields;
  return {
    ...item,
    title_zh: needsTitle
      ? applyTranslatedField(item.title, translatedTitle, item.title_zh)
      : item.title_zh,
    summary_zh: needsSummary
      ? applyTranslatedField(item.summary, translatedSummary, item.summary_zh)
      : item.summary_zh,
  };
}

async function backfillChineseTranslations(items) {
  const visibleItems = items.slice(0, TRANSLATION_BACKFILL_LIMIT);
  const translatedVisibleItems = await mapWithConcurrency(
    visibleItems,
    TRANSLATION_CONCURRENCY,
    translateNewsItem
  );

  return [...translatedVisibleItems, ...items.slice(TRANSLATION_BACKFILL_LIMIT)];
}

async function fetchFeedItems(feed, knownItems) {
  try {
    const feedData = await parser.parseURL(feed.url);
    return feedData.items
      .filter((item) =>
        isLegallyRelevant(item.title || '', item.contentSnippet || item.content || '')
      )
      .map((item) => buildNewsItem(item, feed))
      .filter((item) => {
        const current = knownItems.get(getNewsKey(item));
        if (!current) {
          return true;
        }

        return new Date(item.publishedAt).getTime() > new Date(current.publishedAt).getTime();
      })
      .slice(0, FEED_ITEM_LIMIT);
  } catch (error) {
    console.error(`Failed to fetch feed ${feed.url}:`, error?.message || error);
    return [];
  }
}

async function buildSnapshot() {
  const cache = await readNewsCache();
  const knownItems = createKnownNewsIndex(cache.items);
  console.log(`Loaded ${cache.items.length} cached items.`);

  const feedItems = await Promise.all(FEEDS.map((feed) => fetchFeedItems(feed, knownItems)));
  const mergedItems = mergeNewsItems(cache.items, feedItems.flat());
  console.log(`After RSS merge: ${mergedItems.length} items.`);

  const tavilyItems = shouldFetchTavily(mergedItems, cache.lastSyncedAt)
    ? await fetchTavilyNewsItems(mergedItems, new Date().toISOString())
    : [];

  if (tavilyItems.length > 0) {
    console.log(`Fetched ${tavilyItems.length} Tavily items.`);
  } else if (TAVILY_API_KEY) {
    console.log('No new Tavily items this run.');
  } else {
    console.log('Tavily API key not configured; skipping supplemental search.');
  }

  const globallyMergedItems = mergeNewsItems(mergedItems, tavilyItems);
  const translatedItems = await backfillChineseTranslations(globallyMergedItems);
  const payload = await writeNewsCache(translatedItems);
  console.log(
    `Snapshot updated: ${payload.items.length} items, lastSyncedAt=${payload.lastSyncedAt}`
  );
}

buildSnapshot().catch((error) => {
  console.error('Failed to build news snapshot:', error?.message || error);
  process.exitCode = 1;
});
