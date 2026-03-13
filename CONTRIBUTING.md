# Contributing

Thanks for your interest in improving `mdtool-chrome`.

## Development setup

1. Install dependencies:
   ```bash
   npm ci
   ```
2. Run development build:
   ```bash
   npm run dev
   ```
3. Load unpacked extension from `build/chrome-mv3-dev`.

## Pull request guidelines

- Keep changes focused and easy to review.
- Update docs (`README.md`, `CHANGELOG.md`, `SECURITY.md`) when behavior changes.
- Keep user-facing text clear and actionable.
- Ensure the project builds successfully before opening a PR:
  ```bash
  npm run build
  npm run package
  ```

## Reporting bugs

When filing an issue, include:

- browser version,
- extension version/commit,
- reproducible steps,
- expected vs actual result,
- sample URL (if shareable),
- relevant console errors.
