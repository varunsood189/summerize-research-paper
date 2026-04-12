// ResearchPulse Content Script

const WEB_TEXT_EXCERPT_MAX = 14000;

/** Hosts from common research portals / databases (search pages + OA publishers). */
const RESEARCH_HOSTS = new Set([
  'scholar.google.com',
  'www.semanticscholar.org',
  'semanticscholar.org',
  'www.base-search.net',
  'base-search.net',
  'core.ac.uk',
  'www.core.ac.uk',
  'www.doaj.org',
  'doaj.org',
  'plos.org',
  'journals.plos.org',
  'www.researchgate.net',
  'researchgate.net',
  'www.academia.edu',
  'academia.edu',
  'www.mendeley.com',
  'mendeley.com',
  'www.jstor.org',
  'jstor.org',
  'www.sciencedirect.com',
  'sciencedirect.com',
  'link.springer.com',
  'www.springer.com',
  'www.scopus.com',
  'scopus.com',
  'www.webofscience.com',
  'webofscience.com',
  'www.science.gov',
  'science.gov',
  'www.loc.gov',
  'loc.gov',
  'www.worldcat.org',
  'worldcat.org',
  'eric.ed.gov',
  'www.mdpi.com',
  'mdpi.com',
  'arxiv.org',
  'export.arxiv.org',
  'pmc.ncbi.nlm.nih.gov',
  'www.ncbi.nlm.nih.gov',
  'pubmed.ncbi.nlm.nih.gov',
  'www.nature.com',
]);

function isResearchRelatedHost() {
  const h = window.location.hostname.toLowerCase();
  if (h === 'www.google.com' && window.location.pathname.startsWith('/scholar')) return true;
  if (RESEARCH_HOSTS.has(h)) return true;
  if (h.endsWith('.semanticscholar.org')) return true;
  if (h.endsWith('.nature.com')) return true;
  if (h.endsWith('.ieee.org') || h.includes('.ieee.org')) return true;
  if (h.endsWith('.ncbi.nlm.nih.gov')) return true;
  if (h.includes('semanticscholar')) return true;
  if (h.includes('ieee.org')) return true;
  if (h.includes('springer')) return true;
  if (h.includes('elsevier')) return true;
  if (h.includes('wiley.com')) return true;
  if (h.includes('tandfonline.com')) return true;
  if (h.includes('frontiersin.org')) return true;
  return false;
}

function shouldRunOnThisPage() {
  const p = window.location.protocol;
  return p === 'http:' || p === 'https:';
}

/** Strip fragments (e.g. #:~:text=…) and normalize PMC article URLs. */
function canonicalPmcArticleUrl(href) {
  try {
    const u = new URL(href);
    if (!/pmc\.ncbi\.nlm\.nih\.gov$/i.test(u.hostname)) return href;
    const m = u.pathname.match(/\/articles\/(PMC\d+)/i);
    if (!m) return href;
    u.hash = '';
    u.search = '';
    return `${u.origin}/articles/${m[1]}/`;
  } catch {
    return href;
  }
}

function metaContent(name) {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim();
}

function metaProperty(property) {
  return document.querySelector(`meta[property="${property}"]`)?.getAttribute('content')?.trim();
}

function citationAuthorsFromDom() {
  const nodes = document.querySelectorAll('meta[name="citation_author"]');
  return Array.from(nodes)
    .map((n) => n.getAttribute('content')?.trim())
    .filter(Boolean)
    .join(', ');
}

function citationAbstractFromDom() {
  const a =
    metaContent('citation_abstract') ||
    metaProperty('og:description') ||
    metaContent('dc.description') ||
    metaContent('dcterms.abstract') ||
    metaContent('abstract');
  return a || '';
}

function visibleTextExcerpt() {
  const root =
    document.querySelector('article, main, [role="main"], #content, #main-content, .main-content') ||
    document.body;
  if (!root) return '';
  const t = root.innerText || '';
  return t.replace(/\s+/g, ' ').trim().slice(0, WEB_TEXT_EXCERPT_MAX);
}

function buildWebPageFallback(url, pageKind) {
  const title =
    metaContent('citation_title') ||
    metaProperty('og:title') ||
    document.title ||
    'Untitled page';
  const description =
    citationAbstractFromDom() ||
    metaContent('description') ||
    metaProperty('og:description') ||
    '';
  const content = visibleTextExcerpt();
  return {
    source: 'WebPage',
    pageKind: pageKind || 'webpage',
    title,
    authors: citationAuthorsFromDom() || undefined,
    abstract: description || undefined,
    content: content || description || undefined,
    url,
  };
}

function detectPaper() {
  if (!shouldRunOnThisPage()) return;

  const url = window.location.href;
  let paperData = null;

  // arXiv abstract page
  if (url.includes('arxiv.org/abs/')) {
    const title = document.querySelector('h1.title')?.innerText.replace('Title:', '').trim();
    const authors = document.querySelector('.authors')?.innerText.replace('Authors:', '').trim();
    const abstract = document.querySelector('blockquote.abstract')?.innerText.replace('Abstract:', '').trim();
    const idMatch = url.match(/arxiv\.org\/abs\/([^/?#]+)/i);
    const slug = idMatch ? idMatch[1] : '';
    const bareId = slug.replace(/v\d+$/i, '');

    paperData = {
      source: 'arXiv',
      arxivId: bareId || undefined,
      pageKind: 'article',
      title,
      authors,
      abstract,
      url: bareId ? `https://arxiv.org/abs/${bareId}` : url,
      pdfUrl: bareId ? `https://arxiv.org/pdf/${bareId}.pdf` : `${url.replace('/abs/', '/pdf/')}.pdf`,
    };
  }
  // arXiv PDF viewer (DOM often empty; side panel resolves via tab URL + API)
  else if (url.includes('arxiv.org/pdf/')) {
    const m = url.match(/arxiv\.org\/pdf\/([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?(?:\.pdf)?/i);
    const oldM = url.match(/arxiv\.org\/pdf\/([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(?:v[0-9]+)?(?:\.pdf)?/i);
    const rawId = m ? m[1] : oldM ? oldM[1] : null;
    if (rawId) {
      const bare = rawId.replace(/v\d+$/i, '');
      paperData = {
        source: 'arXiv',
        arxivId: bare,
        pageKind: 'article',
        title: `arXiv ${bare}`,
        url: `https://arxiv.org/abs/${bare}`,
        pdfUrl: `https://arxiv.org/pdf/${bare}.pdf`,
      };
    }
  }
  // PubMed Central (PMC)
  else if (/pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC\d+/i.test(url)) {
    const canonical = canonicalPmcArticleUrl(url);
    const title =
      metaContent('citation_title') ||
      document.querySelector('h1')?.innerText?.replace(/\s+/g, ' ').trim();
    const authors = citationAuthorsFromDom();
    const abstractEl = document.querySelector('section.abstract') || document.querySelector('#abstract1');
    const abstract = abstractEl?.innerText?.replace(/\s+/g, ' ').trim() || citationAbstractFromDom();
    const pmcMatch = canonical.match(/\/articles\/(PMC\d+)/i);
    const pmcId = pmcMatch ? pmcMatch[1] : '';

    paperData = {
      source: 'PMC',
      pmcId: pmcId || undefined,
      pageKind: 'article',
      title,
      authors,
      abstract,
      url: canonical,
    };
  }
  // Nature
  else if (url.includes('nature.com/articles/')) {
    const title = document.querySelector('h1.c-article-title')?.innerText.trim();
    const authors = Array.from(document.querySelectorAll('.c-article-author-list__item'))
      .map((a) => a.innerText.trim())
      .join(', ');
    const abstract =
      document.querySelector('#Abs1-content')?.innerText.trim() ||
      document.querySelector('.c-article-section__content')?.innerText.trim();

    paperData = {
      source: 'Nature',
      pageKind: 'article',
      title,
      authors,
      abstract,
      url,
    };
  }
  // Highwire / Google Scholar style article metadata (many journals: MDPI, Springer, IEEE HTML, PLOS, etc.)
  else if (metaContent('citation_title')) {
    const title = metaContent('citation_title');
    const authors = citationAuthorsFromDom();
    let abstract = citationAbstractFromDom();
    if (!abstract) {
      const abstractEl = document.querySelector('section.abstract, div.abstract, #abstract');
      abstract = abstractEl?.innerText?.replace(/\s+/g, ' ').trim() || '';
    }
    paperData = {
      source: 'WebArticle',
      pageKind: 'article',
      title,
      authors,
      abstract,
      content: abstract ? undefined : visibleTextExcerpt().slice(0, 6000),
      url: stripHashFromUrl(url),
    };
  }
  // PDF tab
  else if (url.toLowerCase().includes('.pdf') || document.contentType === 'application/pdf') {
    const title = metaProperty('og:title') || document.title;
    paperData = {
      source: 'Generic PDF',
      pageKind: 'pdf',
      title: title || 'PDF document',
      url,
    };
  }
  // Research-related sites: always offer page context (portals, search, or thin meta)
  else if (isResearchRelatedHost()) {
    paperData = buildWebPageFallback(url, 'webpage');
  }
  // Generic: strong description / abstract-like meta
  else {
    const title = metaProperty('og:title') || document.title;
    const abstract = metaContent('description') || metaProperty('og:description');
    if (abstract && (abstract.toLowerCase().includes('abstract') || abstract.length > 200)) {
      paperData = {
        source: 'Generic Research',
        pageKind: 'article',
        title,
        abstract,
        url: stripHashFromUrl(url),
      };
    }
  }

  if (paperData) {
    chrome.runtime.sendMessage({
      type: 'PAPER_DETECTED',
      data: paperData,
    });
  }
}

function stripHashFromUrl(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return u.href;
  } catch {
    return href;
  }
}

// Run on load
detectPaper();

// Also observe for dynamic changes (SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    detectPaper();
  }
}).observe(document, { subtree: true, childList: true });
