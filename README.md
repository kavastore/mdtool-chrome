# mdtool.site Clipper (Chrome Extension)

Web -> clean Markdown -> AI / files / knowledge base.

## Project status

The extension includes:

- Web clipper hardening (stable extraction pipeline + fallback + detailed errors).
- Universal web export (single page, history zip, batch tabs zip with per-tab failures).
- Confluence no-auth export MVP (session-based scan/export, attachments, zip report).
- Hardening for long Confluence exports (checkpoint/resume, pause/resume, rate limit, retry).

## Core features

### Web clipper

- Extract current tab in modes: `article`, `full`, `selection`, `code`, `tables`.
- Fallback extraction chain for better reliability (`article -> full -> selection/text`).
- Clean conversion: sanitized HTML -> normalized Markdown.
- Frontmatter metadata: source URL/domain/path, timestamps, word count, reading minutes.
- Save to local history, download `.md`, export history `.zip`.
- Batch export tabs to `.zip` with detailed failure report.
- Context menu + hotkey (`Alt+Shift+S`) quick actions.

### Confluence export (no OAuth, no API key)

- Input: Space URL or Space key.
- Scan: crawl Space links in current browser session.
- Export: page-by-page Markdown + attachments + final zip report.
- Output structure:
  - `confluence/<SPACE>/.../*.md`
  - `confluence/<SPACE>/_attachments/*`
  - `confluence/<SPACE>/_report.json`
- Long-run resilience:
  - checkpoint/resume,
  - pause/resume/stop,
  - retry policy for temporary failures,
  - rate limiting and periodic pauses,
  - `ok / skipped / failed` per page.

## Session-based Confluence mode

This extension intentionally uses browser session auth only:

- user logs into Confluence in a normal browser tab;
- extension reuses that session to read/export accessible pages;
- no OAuth flow, no API tokens, no credentials entered in extension UI.

## Requirements

- Node.js 18+ (Node 20 recommended)
- npm 10+

## Local development

```bash
npm ci
npm run dev
```

Load unpacked extension from `build/chrome-mv3-dev`.

## Production build

```bash
npm run build
```

Build output: `build/chrome-mv3-prod`.

## Package release zip

```bash
npm run package
```

Archive: `build/chrome-mv3-prod.zip`.

## Install (manual)

1. Build production version:
   ```bash
   npm ci
   npm run build
   ```
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `build/chrome-mv3-prod`.

## Permissions used

- `activeTab`, `scripting`: extract page content and run clipper logic.
- `storage`: settings/history/debug/checkpoint persistence.
- `downloads`: save `.md` and export `.zip`.
- `contextMenus`: right-click quick actions.
- `sidePanel`: history + Confluence export UI.
- optional `tabs`: batch export and Confluence crawler/export workflow.

## Repository

Official repository: [kavastore/mdtool-chrome](https://github.com/kavastore/mdtool-chrome)
