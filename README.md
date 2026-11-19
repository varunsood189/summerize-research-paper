# ResearchPulse

> Chrome (Manifest V3) GenAI side-panel that summarizes research articles and research-related pages with Gemini — plus citations and follow-up Q&A.

**What a recruiter should notice:** a shipped product-shaped Chrome extension (side panel + content scripts + service worker) that classifies page context, calls Gemini safely with a user-held API key, and returns structured summaries with APA/MLA citations.

> **Repo note:** the GitHub repository is still named `summerize-research-paper` (historical typo). The product and extension are **ResearchPulse** — that is the name to use in pins, portfolio, and conversation.

## Demo

[Watch the walkthrough on YouTube](https://youtu.be/BeKeGpQCgl4)

## Problem → product

Reading arXiv, PMC, publisher sites, and research portals is slow when you only need the gist, citations, and a few clarifying questions. ResearchPulse keeps that loop inside Chrome:

1. Open a paper or research-related page (or paste a URL).
2. Summarize with **Google Gemini** from the side panel.
3. Get a typed summary (**research article** vs **website / portal**), citation lines, and optional Q&A — without leaving the tab.

## Stack

| Layer | Role |
|-------|------|
| Manifest V3 Chrome extension | Side panel UI, permissions, icons |
| Service worker | Gemini `generateContent`, arXiv/PMC/citation enrichment |
| Content script | Detects papers / page context on matched research sites |
| `chrome.storage.local` | API key, drafts, saved chats (never committed to git) |

```text
┌─────────────────────────────────────────────────────────────┐
│  Chrome side panel (sidepanel.html / .js / .css)            │
│  Summarize · Quick asks · Chat · Save / download / resume   │
└────────────────────────────┬────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐
│ Content script  │ │ Service worker  │ │ chrome.storage.local │
│ Page / paper    │ │ Gemini + meta   │ │ Key, drafts, chats  │
│ context detect  │ │ arXiv / PMC     │ │                     │
└─────────────────┘ └────────┬────────┘ └─────────────────────┘
                             │
                             ▼
                  Google Generative Language API
                  (user’s Gemini API key)
```

## Highlights

- **Context-aware summaries** — treats a single research article differently from a portal / search page; UI and model both label **Summary type**.
- **Citations** — APA and MLA lines from known metadata (title, authors, DOI, journal, arXiv/PMC/PMID); model instructed not to invent missing fields; **Retrieved** date filled client-side.
- **Follow-up Q&A** — quick asks, free-form chat, save / download `.txt`, resume drafts, and “saved chats (most similar first)”.
- **Key hygiene** — Gemini API key lives only in the browser after you paste it in Settings; nothing secret is hardcoded in this repo.

## Requirements

- Google Chrome (or Chromium with side panel support)
- A [Gemini API key](https://aistudio.google.com/apikey)

## Quick start (unpacked)

1. Clone this repo (folder name may still be `summerize-research-paper`).
2. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
3. Click the extension icon to open the **ResearchPulse** side panel.
4. Open **Settings**, paste your Gemini API key, save.
5. Open an article (arXiv, PMC, MDPI, etc.) or paste a URL → **Summarize**.

Optional: replace placeholder icons under `icons/` (`icon16.png`, `icon48.png`, `icon128.png`) or update `manifest.json` filenames.

## Permissions (why they exist)

| Permission | Purpose |
|------------|---------|
| `sidePanel` | ResearchPulse UI in the side panel |
| `storage` | Local API key, last source, drafts, saved chats |
| `activeTab` | Read the active tab for “Use current tab URL” |
| `scripting` | Capture page text when needed |
| `tabs` | Resolve the active tab URL |
| `<all_urls>` | Fetch article HTML for pasted publisher URLs and citation meta |

## Project layout

```text
manifest.json      # Extension manifest (name: ResearchPulse)
service-worker.js  # Gemini helper, arXiv/PMC/citation resolution, summary JSON
content-script.js  # Paper / page context on matched sites
sidepanel.html     # Side panel markup
sidepanel.js       # UI, storage, save/resume/history, citation fallbacks
sidepanel.css      # Styles
icons/             # Extension icons
```

## Privacy

- Summaries and questions go to **Google’s Generative Language API** with **your** API key.
- Saved chats and drafts stay **local** in the browser unless you export `.txt`.
- Do not commit browser exports, settings screenshots, or any file that contains a real key.

## License

[MIT](LICENSE)
