// ResearchPulse Service Worker

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

const GEMINI_MODEL = 'gemini-2.5-flash';

/** Human-readable date for citation "Retrieved …" lines (matches browser locale in side panel fallbacks). */
function citationRetrievedDateForPrompts() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

async function callGeminiGenerateContent(apiKey, promptText, generationConfig) {
  const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
  };
  if (generationConfig && typeof generationConfig === 'object') {
    body.generationConfig = generationConfig;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || 'Failed to call Gemini API');
  }
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(result.error?.message || 'Empty response from Gemini');
  }
  return text;
}

function buildSourceMetadataBlock(p, asSite, retrievedDateStr) {
  return [
    'SOURCE_METADATA (use only these facts for bibliography strings; do not invent authors, journals, or DOIs):',
    `SUMMARY_MODE_REQUESTED: ${asSite ? 'website_or_portal' : 'research_article'}`,
    `Source: ${p.source || 'unknown'}`,
    `Page kind: ${p.pageKind || 'unknown'}`,
    `Title: ${p.title || 'N/A'}`,
    `URL: ${p.url || 'N/A'}`,
    `Authors: ${p.authors || 'N/A'}`,
    `DOI: ${p.doi || 'N/A'}`,
    `Journal: ${p.citationJournal || 'N/A'}`,
    `Publication date: ${p.citationDate || 'N/A'}`,
    `arXiv ID: ${p.arxivId || 'N/A'}`,
    `PMC ID: ${p.pmcId || 'N/A'}`,
    `PMID: ${p.pmid || 'N/A'}`,
    `For "retrieved" wording use exactly: Retrieved ${retrievedDateStr}, from <the URL line above>.`,
  ].join('\n');
}

function extractJsonFromGeminiText(textContent) {
  let t = String(textContent).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw e;
  }
}

function normalizeGeminiSummary(raw, asSite) {
  const main = typeof raw?.main === 'string' ? raw.main.trim() : '';
  const insights = Array.isArray(raw?.insights)
    ? raw.insights.map(String).filter((s) => s.trim())
    : [];
  // Pipeline mode wins — the model sometimes mislabels blogs/recipes as research_article.
  const summaryType = asSite ? 'website_or_portal' : 'research_article';
  const defaultLabel =
    summaryType === 'website_or_portal' ? 'Website / portal page' : 'Research article';
  let summaryTypeLabel =
    typeof raw?.summaryTypeLabel === 'string' && raw.summaryTypeLabel.trim()
      ? raw.summaryTypeLabel.trim()
      : defaultLabel;
  const modelType = raw?.summaryType;
  const modelMismatch =
    (asSite && modelType === 'research_article') || (!asSite && modelType === 'website_or_portal');
  if (modelMismatch) {
    summaryTypeLabel = defaultLabel;
  }
  const cit = raw?.citations && typeof raw.citations === 'object' ? raw.citations : {};
  const citations = {
    apa: typeof cit.apa === 'string' ? cit.apa.trim() : '',
    mla: typeof cit.mla === 'string' ? cit.mla.trim() : '',
    retrievedNote:
      typeof cit.retrievedNote === 'string' ? cit.retrievedNote.trim() : '',
  };
  return { main, insights, summaryType, summaryTypeLabel, citations };
}

function extractArxivIdFromPlainString(s) {
  const abs = s.match(/arxiv\.org\/abs\/([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?/i);
  if (abs) return abs[1];
  const pdf = s.match(/arxiv\.org\/pdf\/([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?(?:\.pdf)?/i);
  if (pdf) return pdf[1];
  const old = s.match(/arxiv\.org\/(?:abs|pdf)\/([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(?:v[0-9]+)?(?:\.pdf)?/i);
  if (old) return old[1];
  return null;
}

/** Unwrap browser PDF viewers (?url=...) and find embedded https://arxiv.org/... strings. */
function expandUrlStrings(raw) {
  const list = [];
  if (!raw || typeof raw !== 'string') return list;
  list.push(raw);
  try {
    const u = new URL(raw);
    for (const key of ['url', 'originalUrl', 'target', 'link', 'path']) {
      const v = u.searchParams.get(key);
      if (v) {
        try {
          list.push(decodeURIComponent(v));
        } catch {
          list.push(v);
        }
      }
    }
  } catch (_) {}

  const reNew =
    /https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/[0-9]{4}\.[0-9]{4,5}(?:v\d+)?(?:\.pdf)?/gi;
  let m;
  while ((m = reNew.exec(raw)) !== null) list.push(m[0]);

  const reOld =
    /https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?(?:\.pdf)?/gi;
  while ((m = reOld.exec(raw)) !== null) list.push(m[0]);

  return [...new Set(list)];
}

function extractArxivIdFromUrl(url) {
  for (const s of expandUrlStrings(url)) {
    const id = extractArxivIdFromPlainString(s);
    if (id) return id;
  }
  return null;
}

/** Removes #fragments (including #:~:text=…) so pasted share links resolve. */
function stripUrlHash(url) {
  if (!url || typeof url !== 'string') return url;
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url.replace(/#.*$/, '');
  }
}

function extractPmcIdFromPlainString(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)/i);
  return m ? m[1] : null;
}

function extractPmcIdFromUrl(url) {
  const cleaned = stripUrlHash(url);
  for (const s of expandUrlStrings(cleaned)) {
    const id = extractPmcIdFromPlainString(s);
    if (id) return id;
  }
  return null;
}

function decodeHtmlMetaContent(s) {
  return decodeXmlEntities(s).replace(/\s+/g, ' ').trim();
}

function parsePmcArticleHtml(html) {
  const titleMatch = html.match(/<meta\s+name="citation_title"\s+content="([^"]*)"/i);
  const title = titleMatch ? decodeHtmlMetaContent(titleMatch[1]) : '';

  const authors = [];
  const authorRe = /<meta\s+name="citation_author"\s+content="([^"]*)"/gi;
  let am;
  while ((am = authorRe.exec(html)) !== null) {
    authors.push(decodeHtmlMetaContent(am[1]));
  }

  let abstract = '';
  const abstractMatch = html.match(
    /<section\s+class="abstract"[^>]*>([\s\S]*?)<\/section>\s*<hr\s+class="headless"/i
  );
  if (abstractMatch) {
    abstract = decodeHtmlMetaContent(stripInnerXmlTags(abstractMatch[1]));
  }

  const doiMatch = html.match(/<meta\s+name="citation_doi"\s+content="([^"]*)"/i);
  const doi = doiMatch ? decodeHtmlMetaContent(doiMatch[1]) : '';
  const jm = html.match(/<meta\s+name="citation_journal_title"\s+content="([^"]*)"/i);
  const journal = jm ? decodeHtmlMetaContent(jm[1]) : '';
  const dm = html.match(/<meta\s+name="citation_publication_date"\s+content="([^"]*)"/i);
  const pubDate = dm ? decodeHtmlMetaContent(dm[1]) : '';
  const pm = html.match(/<meta\s+name="citation_pmid"\s+content="([^"]*)"/i);
  const pmid = pm ? decodeHtmlMetaContent(pm[1]) : '';

  return {
    title,
    authors: authors.filter(Boolean).join(', '),
    abstract,
    doi: doi || undefined,
    citationJournal: journal || undefined,
    citationDate: pubDate || undefined,
    pmid: pmid || undefined,
  };
}

async function fetchPmcMeta(pmcId) {
  const url = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcId}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PMC page fetch failed (${res.status})`);
  const html = await res.text();
  const parsed = parsePmcArticleHtml(html);
  if (!parsed.title) throw new Error('Could not parse PMC article (missing title).');
  return {
    source: 'PMC',
    pmcId,
    title: parsed.title,
    authors: parsed.authors,
    abstract: parsed.abstract,
    url,
    doi: parsed.doi,
    citationJournal: parsed.citationJournal,
    citationDate: parsed.citationDate,
    pmid: parsed.pmid,
  };
}

/** Parse Highwire / Google Scholar style citation meta from raw HTML (regex; no DOM in SW). */
function parseCitationMetaFromHtml(html) {
  const titleMatch = html.match(/<meta\s+name="citation_title"\s+content="([^"]*)"/i);
  let title = titleMatch ? decodeHtmlMetaContent(titleMatch[1]) : '';
  if (!title) {
    const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
    if (og) title = decodeHtmlMetaContent(og[1]);
  }
  if (!title) {
    const tw = html.match(/<meta\s+name="twitter:title"\s+content="([^"]*)"/i);
    if (tw) title = decodeHtmlMetaContent(tw[1]);
  }

  const authors = [];
  const authorRe = /<meta\s+name="citation_author"\s+content="([^"]*)"/gi;
  let am;
  while ((am = authorRe.exec(html)) !== null) {
    authors.push(decodeHtmlMetaContent(am[1]));
  }

  let abstract = '';
  const absPatterns = [
    /<meta\s+name="citation_abstract"\s+content="([^"]*)"/i,
    /<meta\s+property="og:description"\s+content="([^"]*)"/i,
    /<meta\s+name="dc\.description"\s+content="([^"]*)"/i,
    /<meta\s+name="dcterms\.abstract"\s+content="([^"]*)"/i,
    /<meta\s+name="description"\s+content="([^"]*)"/i,
  ];
  for (const re of absPatterns) {
    const m = html.match(re);
    if (m && m[1]) {
      abstract = decodeHtmlMetaContent(m[1]);
      break;
    }
  }

  const doiMatch = html.match(/<meta\s+name="citation_doi"\s+content="([^"]*)"/i);
  const doi = doiMatch ? decodeHtmlMetaContent(doiMatch[1]) : '';
  const jm = html.match(/<meta\s+name="citation_journal_title"\s+content="([^"]*)"/i);
  const journal = jm ? decodeHtmlMetaContent(jm[1]) : '';
  const dm = html.match(/<meta\s+name="citation_publication_date"\s+content="([^"]*)"/i);
  const pubDate = dm ? decodeHtmlMetaContent(dm[1]) : '';

  return {
    title,
    authors: authors.filter(Boolean).join(', '),
    abstract,
    doi: doi || undefined,
    citationJournal: journal || undefined,
    citationDate: pubDate || undefined,
  };
}

function looksLikeBinaryOrPdfUrl(url) {
  if (!url) return false;
  const u = url.split('?')[0].toLowerCase();
  return u.endsWith('.pdf') || u.endsWith('.zip');
}

function isUnsupportedResolveScheme(url) {
  try {
    const u = new URL(url);
    const s = u.protocol.toLowerCase();
    return s !== 'http:' && s !== 'https:';
  } catch {
    return true;
  }
}

async function fetchCitationArticleMeta(url) {
  const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!res.ok) throw new Error(`Page fetch failed (${res.status})`);
  const html = await res.text();
  const parsed = parseCitationMetaFromHtml(html);
  if (!parsed.title) {
    throw new Error('No citation metadata found on this page (not a typical article HTML).');
  }
  return {
    source: 'WebArticle',
    pageKind: 'article',
    title: parsed.title,
    authors: parsed.authors,
    abstract: parsed.abstract,
    url: stripUrlHash(url),
    doi: parsed.doi,
    citationJournal: parsed.citationJournal,
    citationDate: parsed.citationDate,
  };
}

async function resolvePaperFromUrl(url) {
  const cleaned = stripUrlHash(url.trim());
  if (!cleaned || isUnsupportedResolveScheme(cleaned)) {
    throw new Error('Only http(s) article URLs are supported.');
  }
  const arxivId = extractArxivIdFromUrl(cleaned);
  if (arxivId) return fetchArxivMeta(arxivId);
  const pmcId = extractPmcIdFromUrl(cleaned);
  if (pmcId) return fetchPmcMeta(pmcId);
  if (looksLikeBinaryOrPdfUrl(cleaned)) {
    throw new Error(
      'Direct PDF/binary links are not fetched as HTML. Use an arXiv abstract URL, PMC article URL, or publisher HTML page (e.g. MDPI). arXiv PDF links still work because we resolve via the arXiv API.'
    );
  }
  return fetchCitationArticleMeta(cleaned);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function extractPageContextViaScript(tabId) {
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const max = 14000;
        function gc(sel) {
          const n = document.querySelector(sel);
          return n?.getAttribute('content')?.trim() || '';
        }
        const title =
          gc('meta[name="citation_title"]') ||
          gc('meta[property="og:title"]') ||
          document.title ||
          '';
        const description =
          gc('meta[name="citation_abstract"]') ||
          gc('meta[name="description"]') ||
          gc('meta[property="og:description"]') ||
          '';
        const root =
          document.querySelector('article, main, [role="main"], #content, #main-content') ||
          document.body;
        const textSnippet = (root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, max);
        return {
          title,
          description,
          textSnippet,
          url: location.href,
        };
      },
    });
    return inj?.result || { title: '', description: '', textSnippet: '', url: '' };
  } catch {
    return { title: '', description: '', textSnippet: '', url: '' };
  }
}

async function resolveActiveTabToPaper() {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) {
    throw new Error('No active tab.');
  }
  if (!/^https?:\/\//i.test(tab.url)) {
    throw new Error('Active tab must be an http(s) page.');
  }
  const tabUrl = stripUrlHash(tab.url);
  try {
    return await resolvePaperFromUrl(tabUrl);
  } catch (firstErr) {
    try {
      const ctx = await extractPageContextViaScript(tab.id);
      const hasText =
        (ctx.textSnippet || '').trim().length > 20 ||
        (ctx.description || '').trim().length > 15 ||
        (ctx.title || '').trim().length > 3;
      if (!hasText) {
        throw firstErr;
      }
      return {
        source: 'WebPage',
        pageKind: 'webpage',
        title: ctx.title || 'Current page',
        authors: undefined,
        abstract: ctx.description || undefined,
        content: ctx.textSnippet || ctx.description || '',
        url: stripUrlHash(ctx.url || tabUrl),
      };
    } catch {
      throw firstErr;
    }
  }
}

/** arXiv Atom XML — regex only (DOMParser is unavailable in extension service workers). */
function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripInnerXmlTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

function parseArxivAtomEntryXml(xml) {
  const entryMatch = xml.match(/<entry[^>]*>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) {
    const feedTitleMatch = xml.match(/<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i);
    const feedTitle = feedTitleMatch ? stripInnerXmlTags(feedTitleMatch[1]) : '';
    if (/error/i.test(feedTitle)) throw new Error('arXiv: entry not found');
    throw new Error('No arXiv entry for this id');
  }
  const entry = entryMatch[1];

  function pick(tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = entry.match(re);
    if (!m) return '';
    return decodeXmlEntities(stripInnerXmlTags(m[1])).replace(/\s+/g, ' ').trim();
  }

  const title = pick('title');
  const summary = pick('summary');
  const idHref = pick('id');
  const authors = [];
  const authorBlocks = entry.match(/<author[^>]*>[\s\S]*?<\/author>/gi) || [];
  for (const block of authorBlocks) {
    const nm = block.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
    if (nm) authors.push(decodeXmlEntities(stripInnerXmlTags(nm[1])).trim());
  }

  return {
    title,
    summary,
    idHref,
    authors: authors.filter(Boolean).join(', '),
  };
}

async function fetchArxivMeta(id) {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`arXiv API failed (${res.status})`);
  const xml = await res.text();
  const { title, summary, idHref, authors } = parseArxivAtomEntryXml(xml);
  const canonicalUrl = idHref || `https://arxiv.org/abs/${id}`;
  const absMatch = canonicalUrl.match(/arxiv\.org\/abs\/(.+)$/i);
  const bareId = absMatch ? absMatch[1].replace(/v\d+$/i, '') : id.replace(/v\d+$/i, '');
  return {
    source: 'arXiv',
    arxivId: bareId,
    title,
    authors,
    abstract: summary,
    url: `https://arxiv.org/abs/${bareId}`,
    pdfUrl: `https://arxiv.org/pdf/${bareId}.pdf`,
    citationDate: undefined,
  };
}

async function enrichPaperFromArxiv(paper) {
  const abstractOk = paper.abstract && String(paper.abstract).trim().length >= 80;
  if (abstractOk) return paper;
  const id = paper.arxivId || extractArxivIdFromUrl(paper.url) || extractArxivIdFromUrl(paper.pdfUrl);
  if (!id) return paper;
  try {
    const meta = await fetchArxivMeta(id);
    return { ...paper, ...meta };
  } catch (e) {
    console.warn('ResearchPulse: arXiv enrich failed', e);
    return { ...paper, arxivId: id };
  }
}

async function enrichPaperMeta(paper) {
  if (paper.source === 'PMC' || paper.pmcId || extractPmcIdFromUrl(paper.url || '')) {
    const abstractOk = paper.abstract && String(paper.abstract).trim().length >= 80;
    if (abstractOk) return paper;
    const pmcId = paper.pmcId || extractPmcIdFromUrl(paper.url || '');
    if (!pmcId) return paper;
    try {
      return await fetchPmcMeta(pmcId);
    } catch (e) {
      console.warn('ResearchPulse: PMC enrich failed', e);
      return paper;
    }
  }
  if (
    (paper.source === 'WebArticle' || paper.source === 'Generic Research') &&
    paper.url &&
    /^https?:\/\//i.test(paper.url) &&
    !looksLikeBinaryOrPdfUrl(paper.url)
  ) {
    const abstractOk = paper.abstract && String(paper.abstract).trim().length >= 80;
    if (!abstractOk) {
      try {
        const m = await fetchCitationArticleMeta(stripUrlHash(paper.url));
        return { ...paper, ...m, source: paper.source };
      } catch (e) {
        console.warn('ResearchPulse: citation enrich failed', e);
      }
    }
  }
  return enrichPaperFromArxiv(paper);
}

function hasScholarlyMetadataSignals(p) {
  if (!p) return false;
  if (p.arxivId || p.pmcId || p.pmid) return true;
  if (p.source === 'arXiv' || p.source === 'PMC' || p.source === 'Nature') return true;
  if ((p.doi || '').trim()) return true;
  if ((p.citationJournal || '').trim()) return true;
  return false;
}

function shouldSummarizeAsWebsitePage(p) {
  if (!p) return true;
  if (p.pageKind === 'webpage' || p.source === 'WebPage') return true;
  if (p.source === 'Generic PDF' || p.pageKind === 'pdf') return true;
  // Blogs/recipes often expose citation_title without DOI, journal, or venue — not a research paper.
  if (p.pageKind === 'article' && p.source === 'WebArticle' && !hasScholarlyMetadataSignals(p)) {
    return true;
  }
  if (p.pageKind === 'article') return false;
  const absLen = (p.abstract || '').trim().length;
  if (absLen < 80 && (p.content || '').trim().length > 400) return true;
  return false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SUMMARIZE_PAPER') {
    handleSummarization(request.paper, request.apiKey)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'RESOLVE_ARXIV_URL') {
    resolvePaperFromUrl(request.url)
      .then((paper) => sendResponse({ paper }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (request.type === 'RESOLVE_FROM_ACTIVE_TAB') {
    (async () => {
      try {
        const paper = await resolveActiveTabToPaper();
        sendResponse({ paper });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }
  
  if (request.type === 'ASK_QUESTION') {
    handleQuestion(request.paper, request.question, request.apiKey)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleQuestion(paper, question, apiKey) {
  const p = await enrichPaperMeta(paper);
  const asSite = shouldSummarizeAsWebsitePage(p);
  const retrievedDateStr = citationRetrievedDateForPrompts();
  const metaBlock = buildSourceMetadataBlock(p, asSite, retrievedDateStr);
  const ctxBlock = `
    ${metaBlock}

    ABSTRACT_OR_DESCRIPTION: ${p.abstract || 'N/A'}
    PAGE_TEXT_EXCERPT: ${(p.content || '').slice(0, 12000) || 'N/A'}
  `;
  const prompt = `
    You are an expert research assistant. The user's question: "${question}"

    Context:
    ${ctxBlock}

    Answer concisely using this context. If you state specific claims about the source (article or page), tie them to the excerpt or abstract.
    When citing this source in prose, use the title and URL from SOURCE_METADATA. Do not invent DOI, authors, or journal names not listed there.
    This is a ${asSite ? 'web page / portal' : 'research-article-style'} context (${asSite ? 'website_or_portal' : 'research_article'}).
  `;

  const answer = await callGeminiGenerateContent(apiKey, prompt);
  return { answer };
}

async function handleSummarization(paper, apiKey) {
  const p = await enrichPaperMeta(paper);
  const asSite = shouldSummarizeAsWebsitePage(p);
  const retrievedDateStr = citationRetrievedDateForPrompts();
  const metaBlock = buildSourceMetadataBlock(p, asSite, retrievedDateStr);

  const jsonInstructions = `
    Respond with a single JSON object only (no markdown, no code fences, no text before or after).
    All string values must be valid JSON: escape internal double quotes as \\" and use \\n for newlines inside "main" if needed.
    Shape:
    {
      "summaryType": "research_article" | "website_or_portal",
      "summaryTypeLabel": "Short label for the user, e.g. Research article or Website overview",
      "main": "First line must be exactly: **Summary type:** <summaryTypeLabel>  Then a blank line, then 3-4 paragraphs in markdown (bold key terms where helpful).",
      "insights": ["…", "…", "…", "…"],
      "citations": {
        "apa": "One APA-style reference line using ONLY SOURCE_METADATA; use n.d. if year missing; for arXiv-only use preprint form.",
        "mla": "One MLA-style reference line using ONLY SOURCE_METADATA.",
        "retrievedNote": "Retrieved ${retrievedDateStr}, from <exact URL from SOURCE_METADATA>"
      }
    }

    Set summaryType and summaryTypeLabel to match SUMMARY_MODE_REQUESTED: use "website_or_portal" when the mode is website_or_portal, else "research_article".
    Do not invent authors, journals, or DOIs not present in SOURCE_METADATA.
  `;

  const prompt = asSite
    ? `
    You help researchers understand web pages (search portals, databases, publishers, or pages without a clear single-paper abstract).

    ${metaBlock}

    META_DESCRIPTION_OR_ABSTRACT: ${p.abstract || 'Not provided'}
    VISIBLE_TEXT_EXCERPT: ${(p.content || '').slice(0, 16000) || 'Not provided'}

    If this is an aggregator or search tool (e.g. Google Scholar, Semantic Scholar, BASE, CORE, Scopus, Web of Science, ResearchGate search): explain what the service is, who it is for, and how researchers typically use it—not a single paper summary.
    If it is a publisher/journal landing or article without enough structure: summarize the page’s purpose and the most important on-screen information.
    Always set summaryType to "website_or_portal" and match summaryTypeLabel to a website/page overview (this request is in website mode).

    ${jsonInstructions}
  `
    : `
    You are an expert research assistant. Analyze the following research source and provide a concise summary.

    ${metaBlock}

    ABSTRACT: ${p.abstract || 'Not provided'}
    EXTRA_TEXT: ${(p.content || '').slice(0, 12000) || 'None'}

    Always set summaryType to "research_article" and match summaryTypeLabel to a research-article summary (this request is in research-article mode).

    ${jsonInstructions}
  `;

  const textContent = await callGeminiGenerateContent(apiKey, prompt, {
    responseMimeType: 'application/json',
  });

  try {
    const raw = extractJsonFromGeminiText(textContent);
    const summary = normalizeGeminiSummary(raw, asSite);
    if (!summary.main) summary.main = '(No summary text returned.)';
    if (!summary.insights.length) summary.insights = ['See main summary for details.'];
    return { summary };
  } catch (e) {
    console.error('Failed to parse JSON summary:', e, textContent);
    const summary = normalizeGeminiSummary(
      {
        main: textContent,
        insights: ['Model returned non-JSON; see main text above.'],
      },
      asSite
    );
    return { summary };
  }
}
