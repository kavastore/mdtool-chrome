# mdtool.site Clipper (Chrome Extension)

Web -> Clean Content -> AI / Export / Knowledge Base

## Features

- Extract current tab in modes: article, full page, selection, code, tables.
- Sanitize and convert HTML to clean Markdown.
- Add frontmatter metadata automatically.
- Save clips to local history.
- Export to `.md` and `.zip` (history / batch tabs).
- Send content to AI services (ChatGPT, Claude, Gemini, Grok, DeepSeek, Perplexity, Custom AI URL).
- Context menu + hotkey (`Alt+Shift+S`) for quick actions.

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

## Repository

Official repository: [kavastore/mdtool-chrome](https://github.com/kavastore/mdtool-chrome)
