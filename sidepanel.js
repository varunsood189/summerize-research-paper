// ResearchPulse Side Panel Logic

const state = {
  currentPaper: null,
  isSummarizing: false,
  apiKey: null,
  lastSummaryPlain: '',
  lastSummary: null,
  chatTurns: [],
  chatRequestInProgress: false,
};

const QUICK_PROMPTS = [
  'What is the main contribution of this work?',
  'Summarize the methodology in plain language.',
  'What are the main limitations or caveats?',
  'What future work or open questions does this source suggest?',
];

const MAX_SAVED_CHATS = 80;
const MAX_SIMILAR_HISTORY = 15;
const DRAFT_KEY = 'draftSession';

let draftPersistTimer = null;
function scheduleDraftPersist() {
  clearTimeout(draftPersistTimer);
  draftPersistTimer = setTimeout(() => {
    if (state.lastSummary && state.currentPaper) persistDraftSession();
  }, 1200);
}

// UI Elements
const paperTitle = document.getElementById('paper-title');
const paperAuthors = document.getElementById('paper-authors');
const summarizeBtn = document.getElementById('summarize-btn');
const summaryContainer = document.getElementById('summary-container');
const summaryContent = document.getElementById('summary-content');
const insightsList = document.getElementById('insights-list');
const loadingState = document.getElementById('loading-state');
const statusCard = document.getElementById('status-card');
const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const closeSettings = document.getElementById('close-settings');
const saveSettings = document.getElementById('save-settings');
const apiKeyInput = document.getElementById('api-key');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const arxivUrlInput = document.getElementById('arxiv-url-input');
const loadArxivBtn = document.getElementById('load-arxiv-btn');
const loadFromTabBtn = document.getElementById('load-from-tab-btn');
const copyOutputBtn = document.getElementById('copy-output-btn');
const backToSearchBtn = document.getElementById('back-to-search-btn');
const saveChatBtn = document.getElementById('save-chat-btn');
const summaryFollowups = document.getElementById('summary-followups');
const draftBanner = document.getElementById('draft-banner');
const resumeDraftBtn = document.getElementById('resume-draft-btn');
const discardDraftBtn = document.getElementById('discard-draft-btn');
const downloadTxtBtn = document.getElementById('download-txt-btn');
const quickAsksChips = document.getElementById('quick-asks-chips');
const similarHistoryCard = document.getElementById('similar-history-card');
const similarHistoryList = document.getElementById('similar-history-list');
const similarHistoryEmpty = document.getElementById('similar-history-empty');
const similarHistoryRefreshBtn = document.getElementById('similar-history-refresh-btn');
const summaryMetaStrip = document.getElementById('summary-meta-strip');
const summaryTypeLine = document.getElementById('summary-type-line');
const summaryCitationsDl = document.getElementById('summary-citations-dl');

/** Same format as service-worker.js citationRetrievedDateForPrompts() for fallback citations. */
function formatCitationRetrievedDate() {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// Initialize
async function init() {
  const data = await chrome.storage.local.get(['apiKey', 'lastPaper']);
  if (data.apiKey) {
    state.apiKey = data.apiKey;
    apiKeyInput.value = data.apiKey;
  }

  const resolved = await tryResolveActiveTabArxiv();
  if (!resolved && data.lastPaper) {
    updatePaperUI(data.lastPaper);
  }

  await refreshDraftBanner();
  await renderSimilarHistory();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.lastSummary && state.currentPaper) {
      persistDraftSession();
    }
  });
}

async function tryResolveActiveTabArxiv() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'RESOLVE_FROM_ACTIVE_TAB' });
    if (res?.paper) {
      updatePaperUI(res.paper);
      await chrome.storage.local.set({ lastPaper: res.paper });
      if (arxivUrlInput) arxivUrlInput.value = res.paper.url;
      return true;
    }
  } catch (e) {
    console.warn('ResearchPulse: active tab resolve', e);
  }
  return false;
}

async function loadPaperFromArxivUrl(url) {
  const res = await chrome.runtime.sendMessage({ type: 'RESOLVE_ARXIV_URL', url: url.trim() });
  if (res.error) throw new Error(res.error);
  updatePaperUI(res.paper);
  await chrome.storage.local.set({ lastPaper: res.paper });
  summaryContainer.classList.add('hidden');
  statusCard.classList.remove('hidden');
}

function applyPaperHeader(paper) {
  state.currentPaper = paper;
  paperTitle.textContent = paper.title || 'Untitled source';
  const authorLine =
    paper.authors ||
    (paper.source === 'WebPage' ? 'Page / portal (not a single article)' : 'Authors unknown');
  paperAuthors.textContent = authorLine;
  summarizeBtn.disabled = false;
}

function updatePaperUI(paper) {
  applyPaperHeader(paper);
  statusCard.classList.remove('hidden');
  renderSimilarHistory();
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'PAPER_DETECTED') return;
  (async () => {
    let paper = message.data;
    const abstractShort =
      !paper.abstract || String(paper.abstract).trim().length < 80;
    const needsFetchedMeta =
      abstractShort &&
      (paper.source === 'arXiv' ||
        paper.source === 'PMC' ||
        paper.source === 'WebArticle' ||
        paper.source === 'Generic Research') &&
      (paper.url || paper.pdfUrl);
    if (needsFetchedMeta) {
      const res = await chrome.runtime.sendMessage({
        type: 'RESOLVE_ARXIV_URL',
        url: paper.url || paper.pdfUrl || '',
      });
      if (res?.paper) paper = res.paper;
    }
    updatePaperUI(paper);
    await chrome.storage.local.set({ lastPaper: paper });
    if (arxivUrlInput && paper.url) arxivUrlInput.value = paper.url;
  })();
});

// Event Listeners
settingsBtn.onclick = () => settingsOverlay.classList.remove('hidden');
closeSettings.onclick = () => settingsOverlay.classList.add('hidden');

saveSettings.onclick = async () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    await chrome.storage.local.set({ apiKey: key });
    state.apiKey = key;
    settingsOverlay.classList.add('hidden');
    alert('Settings saved!');
  }
};

loadArxivBtn.onclick = async () => {
  const url = arxivUrlInput.value.trim();
  if (!url) {
    alert('Paste an article or page URL first.');
    return;
  }
  try {
    summarizeBtn.disabled = true;
    await loadPaperFromArxivUrl(url);
  } catch (err) {
    alert(err.message);
  } finally {
    summarizeBtn.disabled = !state.currentPaper;
  }
};

loadFromTabBtn.onclick = async () => {
  try {
    summarizeBtn.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'RESOLVE_FROM_ACTIVE_TAB' });
    if (res?.paper) {
      updatePaperUI(res.paper);
      await chrome.storage.local.set({ lastPaper: res.paper });
      if (arxivUrlInput) arxivUrlInput.value = res.paper.url;
    } else {
      alert(res?.error || 'Could not read the current tab. Open an http(s) research page and try again.');
    }
  } finally {
    summarizeBtn.disabled = !state.currentPaper;
  }
};

summarizeBtn.onclick = async () => {
  if (!state.apiKey) {
    alert('Please enter your Gemini API key in settings first!');
    settingsOverlay.classList.remove('hidden');
    return;
  }

  if (state.isSummarizing) return;

  try {
    startLoading();
    
    // Request summary from service worker
    const response = await chrome.runtime.sendMessage({
      type: 'SUMMARIZE_PAPER',
      paper: state.currentPaper,
      apiKey: state.apiKey
    });

    if (response.error) {
      throw new Error(response.error);
    }

    displaySummary(response.summary);
  } catch (err) {
    console.error(err);
    alert('Error: ' + err.message);
  } finally {
    stopLoading();
  }
};

function startLoading() {
  state.isSummarizing = true;
  loadingState.classList.remove('hidden');
  summaryContainer.classList.add('hidden');
  summarizeBtn.disabled = true;
}

function stopLoading() {
  state.isSummarizing = false;
  loadingState.classList.add('hidden');
  summarizeBtn.disabled = false;
}

function mergeFallbackCitations(summary, paper) {
  if (!summary) return summary;
  summary.citations = summary.citations || { apa: '', mla: '', retrievedNote: '' };
  const c = summary.citations;
  const has =
    (c.apa && String(c.apa).trim()) ||
    (c.mla && String(c.mla).trim()) ||
    (c.retrievedNote && String(c.retrievedNote).trim());
  if (has) return summary;
  if (!paper || (!paper.url && !paper.title)) return summary;

  const url = paper.url || '';
  const title = paper.title || 'Untitled';
  const authors = paper.authors || '';
  const year = String(paper.citationDate || '')
    .trim()
    .slice(0, 4);
  const doi = paper.doi || '';
  const journal = paper.citationJournal || '';
  const isWeb =
    summary.summaryType === 'website_or_portal' ||
    paper.source === 'WebPage' ||
    paper.pageKind === 'webpage';

  const retrieved = formatCitationRetrievedDate();
  if (isWeb) {
    summary.citations = {
      apa: `${title}. Retrieved ${retrieved}, from ${url}`,
      mla: `"${title}." Web page. Accessed ${retrieved}. ${url}`,
      retrievedNote: `Retrieved ${retrieved}, from ${url}`,
    };
  } else {
    const apa =
      (authors ? `${authors} (${year || 'n.d.'}). ` : '') +
      `${title}.` +
      (journal ? ` ${journal}.` : '') +
      (doi ? ` https://doi.org/${doi}` : url ? ` ${url}` : '');
    const mla = authors
      ? `${authors}. "${title}."${journal ? ` ${journal}` : ''}${year ? `, ${year}` : ''}${url ? `. ${url}` : '.'}`
      : `"${title}."${url ? ` ${url}` : ''}`;
    summary.citations = {
      apa: apa.trim(),
      mla,
      retrievedNote: url ? `Retrieved ${retrieved}, from ${url}` : '',
    };
  }
  return summary;
}

function ensureSummaryKindLabels(summary, paper) {
  if (!summary) return;
  if (!summary.summaryType) {
    const isWeb =
      paper && (paper.source === 'WebPage' || paper.pageKind === 'webpage');
    summary.summaryType = isWeb ? 'website_or_portal' : 'research_article';
  }
  if (!summary.summaryTypeLabel || !String(summary.summaryTypeLabel).trim()) {
    summary.summaryTypeLabel =
      summary.summaryType === 'website_or_portal'
        ? 'Website / portal page'
        : 'Research article';
  }
}

function renderSummaryMetaStrip(summary) {
  if (!summaryMetaStrip || !summaryTypeLine || !summaryCitationsDl) return;
  const label = (summary && summary.summaryTypeLabel) || '';
  const c = (summary && summary.citations) || {};
  const rows = [
    ['APA', c.apa],
    ['MLA', c.mla],
    ['Retrieved', c.retrievedNote],
  ].filter(([, v]) => v && String(v).trim());
  if (!label && !rows.length) {
    summaryMetaStrip.classList.add('hidden');
    summaryTypeLine.textContent = '';
    summaryCitationsDl.classList.add('hidden');
    summaryCitationsDl.innerHTML = '';
    return;
  }
  summaryMetaStrip.classList.remove('hidden');
  summaryTypeLine.textContent = label ? 'Summary type: ' + label : '';
  summaryCitationsDl.innerHTML = '';
  if (!rows.length) {
    summaryCitationsDl.classList.add('hidden');
    return;
  }
  summaryCitationsDl.classList.remove('hidden');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    summaryCitationsDl.appendChild(dt);
    summaryCitationsDl.appendChild(dd);
  }
}

function clearSummaryMetaStrip() {
  renderSummaryMetaStrip(null);
}

function buildLastSummaryPlain(summary) {
  const lines = [];
  if (summary.summaryTypeLabel) {
    lines.push('Summary type: ' + summary.summaryTypeLabel, '');
  }
  lines.push(summary.main, '', 'Key insights:');
  (summary.insights || []).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  const c = summary.citations || {};
  if (c.apa || c.mla || c.retrievedNote) {
    lines.push('', '--- Citations ---');
    if (c.apa) lines.push('APA: ' + stripMarkdownLite(c.apa));
    if (c.mla) lines.push('MLA: ' + stripMarkdownLite(c.mla));
    if (c.retrievedNote) lines.push(stripMarkdownLite(c.retrievedNote));
  }
  return lines.join('\n');
}

function displaySummary(summary) {
  chrome.storage.local.remove(DRAFT_KEY).catch(() => {});
  if (summaryFollowups) summaryFollowups.innerHTML = '';
  state.chatTurns = [];
  mergeFallbackCitations(summary, state.currentPaper);
  ensureSummaryKindLabels(summary, state.currentPaper);
  state.lastSummary = {
    main: summary.main,
    insights: [...(summary.insights || [])],
    summaryType: summary.summaryType,
    summaryTypeLabel: summary.summaryTypeLabel,
    citations: { ...(summary.citations || {}) },
  };

  renderSummaryMetaStrip(state.lastSummary);
  summaryContent.innerHTML = formatMarkdown(summary.main);

  insightsList.innerHTML = '';
  summary.insights.forEach((insight) => {
    const li = document.createElement('li');
    li.textContent = insight;
    insightsList.appendChild(li);
  });

  state.lastSummaryPlain = buildLastSummaryPlain(state.lastSummary);

  summaryContainer.classList.remove('hidden');
  statusCard.classList.add('hidden'); // Optional: hide status after summary
  refreshDraftBanner();
  scheduleDraftPersist();
  renderQuickAsks();
}

function stripMarkdownLite(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1');
}

function formatSessionAsPlainText({ paper, lastSummary, chatTurns, label }) {
  const lines = [];
  if (label) lines.push('ResearchPulse saved chat', 'Label: ' + label, '');
  lines.push(
    'Title: ' + (paper?.title || 'Unknown'),
    'URL: ' + (paper?.url || ''),
    'Authors: ' + (paper?.authors || ''),
    'Detected source: ' + (paper?.source || ''),
    '',
  );
  if (lastSummary?.summaryTypeLabel) {
    lines.push('Summary type: ' + lastSummary.summaryTypeLabel, '');
  }
  lines.push('--- Summary ---', stripMarkdownLite(lastSummary?.main), '');
  const cit = lastSummary?.citations || {};
  if (cit.apa || cit.mla || cit.retrievedNote) {
    lines.push('--- Citations ---');
    if (cit.apa) lines.push('APA: ' + stripMarkdownLite(cit.apa));
    if (cit.mla) lines.push('MLA: ' + stripMarkdownLite(cit.mla));
    if (cit.retrievedNote) lines.push(stripMarkdownLite(cit.retrievedNote));
    lines.push('');
  }
  lines.push('--- Key insights ---');
  (lastSummary?.insights || []).forEach((x, i) => lines.push(`${i + 1}. ${stripMarkdownLite(x)}`));
  lines.push('');
  if (chatTurns?.length) {
    lines.push('--- Q & A ---');
    chatTurns.forEach((m, i) => {
      lines.push('', `Q${i + 1}: ${m.question}`, `A${i + 1}:`, stripMarkdownLite(m.answer), '');
    });
  }
  lines.push('', '---', 'Saved: ' + new Date().toISOString());
  return lines.join('\n');
}

function sanitizeFilenameBase(name) {
  const base = String(name || 'researchpulse-chat')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base || 'researchpulse-chat';
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.txt') ? filename : filename + '.txt';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function refreshDraftBanner() {
  if (!draftBanner) return;
  const { [DRAFT_KEY]: draft } = await chrome.storage.local.get(DRAFT_KEY);
  const ok = draft && draft.lastSummary && draft.paper;
  draftBanner.classList.toggle('hidden', !ok);
}

async function persistDraftSession() {
  if (!state.lastSummary || !state.currentPaper) return;
  await chrome.storage.local.set({
    [DRAFT_KEY]: {
      savedAt: new Date().toISOString(),
      paper: { ...state.currentPaper },
      lastSummary: {
        main: state.lastSummary.main,
        insights: [...(state.lastSummary.insights || [])],
        summaryType: state.lastSummary.summaryType,
        summaryTypeLabel: state.lastSummary.summaryTypeLabel,
        citations: { ...(state.lastSummary.citations || {}) },
      },
      chatTurns: state.chatTurns.map((m) => ({ question: m.question, answer: m.answer })),
      urlInput: arxivUrlInput?.value?.trim() || '',
    },
  });
  await refreshDraftBanner();
}

function restoreSummaryUIFromState() {
  if (!state.lastSummary) return;
  if (summaryFollowups) summaryFollowups.innerHTML = '';
  mergeFallbackCitations(state.lastSummary, state.currentPaper);
  ensureSummaryKindLabels(state.lastSummary, state.currentPaper);
  renderSummaryMetaStrip(state.lastSummary);
  summaryContent.innerHTML = formatMarkdown(state.lastSummary.main);
  insightsList.innerHTML = '';
  (state.lastSummary.insights || []).forEach((insight) => {
    const li = document.createElement('li');
    li.textContent = insight;
    insightsList.appendChild(li);
  });
  state.lastSummaryPlain = buildLastSummaryPlain(state.lastSummary);
  state.chatTurns.forEach((m) => appendFollowupQuestionBlock(m.question, m.answer));
  summaryContainer.classList.remove('hidden');
  statusCard.classList.add('hidden');
  renderQuickAsks();
}

async function resumeDraftSession() {
  const { [DRAFT_KEY]: draft } = await chrome.storage.local.get(DRAFT_KEY);
  if (!draft?.paper || !draft?.lastSummary) {
    alert('No draft to resume.');
    await refreshDraftBanner();
    return;
  }
  state.currentPaper = draft.paper;
  state.lastSummary = {
    main: draft.lastSummary.main,
    insights: [...(draft.lastSummary.insights || [])],
    summaryType: draft.lastSummary.summaryType,
    summaryTypeLabel: draft.lastSummary.summaryTypeLabel,
    citations: { ...(draft.lastSummary.citations || {}) },
  };
  state.chatTurns = Array.isArray(draft.chatTurns)
    ? draft.chatTurns.map((m) => ({ question: m.question, answer: m.answer }))
    : [];
  if (arxivUrlInput && draft.urlInput) arxivUrlInput.value = draft.urlInput;
  updatePaperUI(draft.paper);
  await chrome.storage.local.set({ lastPaper: draft.paper });
  restoreSummaryUIFromState();
  summarizeBtn.disabled = false;
}

async function discardDraftSession() {
  await chrome.storage.local.remove(DRAFT_KEY);
  await refreshDraftBanner();
}

async function goBackToPaperView() {
  if (state.lastSummary && state.currentPaper) {
    await persistDraftSession();
  }
  summaryContainer.classList.add('hidden');
  statusCard.classList.remove('hidden');
  clearSummaryMetaStrip();
  if (summaryFollowups) summaryFollowups.innerHTML = '';
  state.chatTurns = [];
  state.lastSummary = null;
  state.lastSummaryPlain = '';
  summarizeBtn.disabled = !state.currentPaper;
  renderSimilarHistory();
}

function normalizeComparableUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    let path = u.pathname.replace(/\/$/, '') || '/';
    u.pathname = path;
    return u.href.toLowerCase();
  } catch {
    return String(href || '')
      .trim()
      .toLowerCase();
  }
}

function extractArxivBareId(url) {
  const m = String(url || '').match(/arxiv\.org\/(?:abs|pdf)\/([^/?#]+)/i);
  if (!m) return null;
  return m[1].replace(/\.pdf$/i, '').replace(/v\d+$/i, '').toLowerCase();
}

function extractPmcIdFromUrl(url) {
  const m = String(url || '').match(/\/articles\/(PMC\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

function titleWordSet(title) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

function jaccardWordSets(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function similarityScoreForEntry(paper, entry) {
  const ep = entry.paper || {};
  let score = 0;
  const u1 = paper.url || '';
  const u2 = ep.url || '';
  const n1 = normalizeComparableUrl(u1);
  const n2 = normalizeComparableUrl(u2);
  if (n1 && n2 && n1 === n2) score += 100000;

  const ax1 = extractArxivBareId(u1);
  const ax2 = extractArxivBareId(u2);
  if (ax1 && ax2 && ax1 === ax2) score += 95000;

  const pm1 = extractPmcIdFromUrl(u1);
  const pm2 = extractPmcIdFromUrl(u2);
  if (pm1 && pm2 && pm1 === pm2) score += 95000;

  try {
    if (u1 && u2) {
      const a = new URL(u1);
      const b = new URL(u2);
      if (a.hostname.toLowerCase() === b.hostname.toLowerCase()) score += 3500;
    }
  } catch (_) {}

  const jac = jaccardWordSets(titleWordSet(paper.title), titleWordSet(ep.title));
  score += jac * 8500;

  if (paper.source && ep.source && paper.source === ep.source) score += 120;

  return score;
}

function matchTierLabel(score) {
  if (score >= 90000) return 'Same article';
  if (score >= 5000) return 'Same site + title';
  if (score >= 3500) return 'Same site';
  if (score >= 800) return 'Similar title';
  return 'Looser match';
}

async function renderSimilarHistory() {
  if (!similarHistoryCard || !similarHistoryList || !similarHistoryEmpty) return;

  if (!state.currentPaper) {
    similarHistoryCard.classList.add('hidden');
    return;
  }

  const data = await chrome.storage.local.get(['savedChats']);
  const raw = Array.isArray(data.savedChats) ? data.savedChats : [];

  similarHistoryCard.classList.remove('hidden');

  if (!raw.length) {
    similarHistoryList.innerHTML = '';
    similarHistoryEmpty.classList.remove('hidden');
    return;
  }

  similarHistoryEmpty.classList.add('hidden');

  const scored = raw
    .map((entry) => ({
      entry,
      score: similarityScoreForEntry(state.currentPaper, entry),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.entry.savedAt || 0) - new Date(a.entry.savedAt || 0);
    })
    .slice(0, MAX_SIMILAR_HISTORY);

  similarHistoryList.innerHTML = '';
  scored.forEach(({ entry, score }) => {
    const li = document.createElement('li');
    li.className = 'similar-history-item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'similar-history-btn';
    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = entry.label || entry.paper?.title || 'Saved chat';
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const when = entry.savedAt
      ? new Date(entry.savedAt).toLocaleString()
      : '';
    meta.textContent = matchTierLabel(score) + (when ? ' · ' + when : '');
    btn.appendChild(label);
    btn.appendChild(meta);
    btn.onclick = () => openSavedChatEntry(entry);
    li.appendChild(btn);
    similarHistoryList.appendChild(li);
  });
}

async function openSavedChatEntry(entry) {
  if (!entry?.summaryMain) {
    alert('This saved entry has no summary to restore.');
    return;
  }
  await chrome.storage.local.remove(DRAFT_KEY).catch(() => {});

  applyPaperHeader({
    ...(entry.paper || {}),
  });

  state.lastSummary = {
    main: entry.summaryMain,
    insights: Array.isArray(entry.insights) ? [...entry.insights] : [],
    summaryType: entry.summaryType,
    summaryTypeLabel: entry.summaryTypeLabel,
    citations: { ...(entry.citations || {}) },
  };
  mergeFallbackCitations(state.lastSummary, state.currentPaper);
  ensureSummaryKindLabels(state.lastSummary, state.currentPaper);
  state.chatTurns = (entry.messages || []).map((m) => ({
    question: m.question,
    answer: m.answer,
  }));

  await chrome.storage.local.set({ lastPaper: state.currentPaper });
  if (arxivUrlInput && entry.paper?.url) arxivUrlInput.value = entry.paper.url;

  restoreSummaryUIFromState();
  await refreshDraftBanner();
}

function downloadCurrentSessionTxt(suggestedName) {
  if (!state.lastSummary || !state.currentPaper) {
    alert('Nothing to export yet. Run a summary first.');
    return;
  }
  const text = formatSessionAsPlainText({
    paper: state.currentPaper,
    lastSummary: state.lastSummary,
    chatTurns: state.chatTurns,
    label: suggestedName,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = suggestedName || state.currentPaper.title || 'researchpulse';
  downloadTextFile(`${sanitizeFilenameBase(base)}-${stamp}.txt`, text);
}

function appendFollowupQuestionBlock(question, answerMarkdown) {
  if (!summaryFollowups) return;
  const wrap = document.createElement('div');
  wrap.className = 'card glass slide-up';
  const qEl = document.createElement('p');
  qEl.style.color = 'var(--accent-color)';
  qEl.style.fontWeight = '600';
  qEl.textContent = 'Q: ' + question;
  const aEl = document.createElement('div');
  aEl.style.marginTop = '0.5rem';
  aEl.innerHTML = formatMarkdown(answerMarkdown);
  wrap.appendChild(qEl);
  wrap.appendChild(aEl);
  summaryFollowups.appendChild(wrap);
}

async function saveCurrentChat() {
  if (!state.lastSummary || !state.currentPaper) {
    alert('Nothing to save yet. Run a summary first.');
    return;
  }
  const labelDefault =
    (state.currentPaper.title || 'Source').slice(0, 80) +
    ' — ' +
    new Date().toLocaleString();
  const label = window.prompt('Name this saved chat (optional):', labelDefault);
  if (label === null) return;

  const entry = {
    id: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    label: label.trim() || labelDefault,
    paper: {
      title: state.currentPaper.title,
      url: state.currentPaper.url,
      authors: state.currentPaper.authors,
      source: state.currentPaper.source,
    },
    summaryMain: state.lastSummary.main,
    insights: state.lastSummary.insights,
    summaryType: state.lastSummary.summaryType,
    summaryTypeLabel: state.lastSummary.summaryTypeLabel,
    citations: state.lastSummary.citations || {},
    messages: state.chatTurns.map((m) => ({ question: m.question, answer: m.answer })),
  };

  const data = await chrome.storage.local.get(['savedChats']);
  const list = Array.isArray(data.savedChats) ? data.savedChats : [];
  list.unshift(entry);
  await chrome.storage.local.set({ savedChats: list.slice(0, MAX_SAVED_CHATS) });

  const plain = formatSessionAsPlainText({
    paper: state.currentPaper,
    lastSummary: state.lastSummary,
    chatTurns: state.chatTurns,
    label: entry.label,
  });
  downloadTextFile(`${sanitizeFilenameBase(entry.label)}.txt`, plain);

  alert(
    'Chat saved in this browser (' +
      list.length +
      ' in list) and a .txt file was downloaded so you can keep a copy on disk.'
  );
  await renderSimilarHistory();
}

// Simple markdown formatter (very basic)
function formatMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

const SEND_BTN_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`;

function setChatUiBusy(busy) {
  state.chatRequestInProgress = busy;
  if (sendBtn) {
    sendBtn.disabled = busy;
    sendBtn.innerHTML = busy ? '…' : SEND_BTN_SVG;
  }
  document.querySelectorAll('.quick-ask-chip').forEach((b) => {
    b.disabled = busy;
  });
}

function renderQuickAsks() {
  if (!quickAsksChips) return;
  quickAsksChips.innerHTML = '';
  QUICK_PROMPTS.forEach((text) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-ask-chip';
    btn.textContent = text;
    btn.title = text;
    btn.onclick = () => askQuestionInChat(text);
    quickAsksChips.appendChild(btn);
  });
}

async function askQuestionInChat(questionText) {
  const question = String(questionText || '').trim();
  if (!question || !state.currentPaper) return;

  if (!state.apiKey) {
    alert('Please enter your Gemini API key in settings first!');
    settingsOverlay.classList.remove('hidden');
    return;
  }

  if (state.chatRequestInProgress) return;

  setChatUiBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'ASK_QUESTION',
      paper: state.currentPaper,
      question,
      apiKey: state.apiKey,
    });

    if (response.error) throw new Error(response.error);

    state.chatTurns.push({ question, answer: response.answer });
    appendFollowupQuestionBlock(question, response.answer);
    scheduleDraftPersist();

    chatInput.value = '';
    const last = summaryFollowups?.lastElementChild;
    if (last) last.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    setChatUiBusy(false);
  }
}

sendBtn.onclick = async () => {
  await askQuestionInChat(chatInput.value);
};

// Allow Enter key to send
chatInput.onkeydown = (e) => {
  if (e.key === 'Enter') sendBtn.click();
};

if (backToSearchBtn) {
  backToSearchBtn.onclick = () => goBackToPaperView();
}

if (saveChatBtn) {
  saveChatBtn.onclick = () => saveCurrentChat();
}

if (downloadTxtBtn) {
  downloadTxtBtn.onclick = () => downloadCurrentSessionTxt();
}

if (resumeDraftBtn) {
  resumeDraftBtn.onclick = () => resumeDraftSession();
}

if (discardDraftBtn) {
  discardDraftBtn.onclick = async () => {
    if (!window.confirm('Discard the saved draft? This only removes the in-browser draft, not .txt files you already downloaded.')) return;
    await discardDraftSession();
  };
}

if (similarHistoryRefreshBtn) {
  similarHistoryRefreshBtn.onclick = async () => {
    similarHistoryRefreshBtn.disabled = true;
    try {
      await renderSimilarHistory();
    } finally {
      similarHistoryRefreshBtn.disabled = false;
    }
  };
}

if (copyOutputBtn) {
  copyOutputBtn.onclick = async () => {
    const block =
      summaryContainer.innerText?.trim() ||
      state.lastSummaryPlain ||
      '';
    if (!block) {
      alert('Nothing to copy yet.');
      return;
    }
    try {
      await navigator.clipboard.writeText(block);
      const prev = copyOutputBtn.textContent;
      copyOutputBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyOutputBtn.textContent = prev;
      }, 2000);
    } catch (e) {
      alert('Could not copy: ' + (e.message || 'clipboard blocked'));
    }
  };
}

init();
