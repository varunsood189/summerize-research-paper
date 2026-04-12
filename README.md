# ResearchPulse

Chrome extension (Manifest V3) that summarizes **research articles and research-related web pages**, with optional **citations** and **follow-up Q&A**, using **Google Gemini**. The API key is **never stored in this repository**—only in your browser after you enter it in the extension settings.

## Safe to publish on GitHub

- **No API keys, tokens, or secrets** are hardcoded in the source files.
- Keys live only in **`chrome.storage.local`** on each user’s machine after they save settings in the side panel.
- Before pushing, avoid committing browser export files, screenshots of settings, or any file that contains your real key.

## Requirements

- **Google Chrome** (or another Chromium browser with side panel support).
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey) (or your Google Cloud project).

## Install (developer / unpacked)

1. Clone or download this repo.
2. Add extension icons under `icons/` (`icon16.png`, `icon48.png`, `icon128.png`) as referenced in `manifest.json`, or update `manifest.json` to match your assets.
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.

## Usage

1. Click the extension icon to open the **side panel**.
2. Open **Settings** (gear) and paste your **Gemini API key**, then save.
3. Open an article or research-related page (arXiv, PMC, MDPI, etc.) or paste a URL, then **Summarize**.
4. Use **Quick asks**, free-form chat, **Save chat** / **Download .txt**, **Resume draft**, and **Saved chats (most similar first)** from the main screen.

### Summary type: research article vs website

ResearchPulse detects whether the current context is best treated as a **single research article** (structured abstract, citation meta, arXiv/PMC, etc.) or as a **web page / portal** (search tools, thin meta, generic page text). The side panel shows a **Summary type** line (for example *Research article* or *Website / portal page*), and the model is asked to start the written summary with **`Summary type:`** so the body matches that mode.

### Citations

After each summary, the UI shows a **Citations** block when available:

- **APA** and **MLA** style lines, built from metadata the extension already knows (title, authors, URL, DOI, journal, publication date, arXiv/PMC/PMID where present). The model is instructed **not** to invent authors, journals, or DOIs that are not in that metadata.
- A **Retrieved** line with the page URL and the **current** human-readable access date (computed when you summarize, in both the Gemini prompt and client-side fallbacks).

The same **Summary type** and **Citations** sections are included when you **Save chat**, **Download .txt**, or copy from the summary view. If the API response is malformed or omits citations, the extension **fills minimal APA / MLA / Retrieved** strings from the loaded source metadata when possible.

## Permissions (why they exist)

| Permission        | Purpose |
|-------------------|--------|
| `sidePanel`       | Show the ResearchPulse UI in the side panel. |
| `storage`         | Save API key (locally), last loaded source, drafts, and saved chats. |
| `activeTab`       | Read the active tab when you use “Use current tab URL”. |
| `scripting`       | Inject a snippet to capture page text when needed. |
| `tabs`            | Resolve the active tab URL for the same flow. |
| `<all_urls>`      | Fetch article HTML for pasted publisher URLs and citation meta. |

## Project layout

```
manifest.json      # Extension manifest
service-worker.js  # Gemini (see GEMINI_MODEL), shared generateContent helper, arXiv/PMC/citation resolution, summary JSON + citation metadata
content-script.js  # Detects papers / page context on matched sites
sidepanel.html     # Side panel markup (summary type + citations strip)
sidepanel.js       # UI logic, storage, save/resume/history, citation fallbacks
sidepanel.css      # Styles
icons/             # Extension icons (add these locally)
```

## Privacy

- Summaries and questions are sent to **Google’s Generative Language API** using **your** API key.
- Saved chats and drafts are stored **locally** in the browser unless you export `.txt`.

## License

Specify your license here (e.g. MIT) if you publish the repo.
