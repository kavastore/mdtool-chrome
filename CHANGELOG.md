# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- Chrome Web Store listing assets and store metadata polish.
- Additional Confluence compatibility testing on custom/self-hosted instances.

## [0.1.0] - 2026-03-13

### Added
- Stable extraction pipeline with explicit states and detailed error propagation.
- Web extraction fallbacks (`article -> full -> selection/text`) and local debug logs.
- Separate UX actions for saving to history and downloading Markdown.
- Batch tabs export with per-tab failure reporting.
- Robust zip builder with path sanitization and collision handling.
- Improved frontmatter metadata and markdown post-processing.
- Session-based Confluence scan/export MVP (no OAuth/API keys).
- Confluence attachment collection and local path rewriting.
- Confluence export zip reports (`_batch-report.json`, `_report.json`).
- Confluence hardening: checkpoint/resume, pause/resume/stop, retry policy, rate limiting.
- Public-facing repository docs and release metadata.
