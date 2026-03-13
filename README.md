# mdtool.site Clipper (Chrome Extension)

Turn web pages and Confluence spaces into clean Markdown for AI workflows, docs, and local knowledge bases.

## Why this project

Most clipper tools either lose structure or require backend auth setups for enterprise sources.  
`mdtool-chrome` is designed to stay local-first, readable, and practical:

- robust web extraction with fallbacks,
- safe Markdown export in single and batch modes,
- Confluence space export using your existing browser session (no OAuth/token setup),
- clear failure reporting instead of silent data loss.

## Feature overview

### Web clipping

- Extract current tab in modes: `article`, `full`, `selection`, `code`, `tables`.
- Fallback chain for resilience: `article -> full -> selection/text`.
- HTML sanitization and markdown normalization.
- Frontmatter metadata:
  - source URL/domain/path,
  - export timestamp,
  - word count and reading minutes,
  - extraction mode.
- Save to history, copy markdown, download `.md`.
- Export history clips and open tabs into `.zip`.
- Context-menu actions and hotkey (`Alt+Shift+S`).

### Confluence export (session-based)

- Input by Space URL or Space key.
- Crawl and export pages available to the currently logged-in browser user.
- Build markdown tree with attachment rewrite and export reports.
- Output structure:
  - `confluence/<SPACE>/.../*.md`
  - `confluence/<SPACE>/_attachments/*`
  - `confluence/<SPACE>/_report.json`
- Hardening:
  - checkpoint/resume,
  - pause/resume/stop controls,
  - retry policy for transient failures,
  - rate limiting and periodic pauses,
  - per-page status (`exported` / `skipped` / `failed`).

## Privacy and auth model

Confluence integration is intentionally **session-only**:

- no OAuth flow,
- no API tokens,
- no credentials entered in extension UI.

The extension reuses your already authenticated browser session and only accesses pages your current user can access.

## Requirements

- Node.js `>=18` (Node 20 recommended)
- npm `>=10`

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

Output folder: `build/chrome-mv3-prod`.

## Package release zip

```bash
npm run package
```

Release archive: `build/chrome-mv3-prod.zip`.

## Manual install

1. Build production version:
   ```bash
   npm ci
   npm run build
   ```
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select `build/chrome-mv3-prod`.

## Chrome permissions used

- `activeTab`, `scripting` - run extraction logic on page context.
- `storage` - persist settings, history, debug logs, Confluence checkpoint.
- `downloads` - save markdown and zip exports.
- `contextMenus` - right-click quick actions.
- `sidePanel` - history and Confluence export UI.
- optional `tabs` - batch tab export and Confluence crawling workflow.

## Documentation

- Release history: `CHANGELOG.md`
- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`

## Repository

GitHub: [kavastore/mdtool-chrome](https://github.com/kavastore/mdtool-chrome)
