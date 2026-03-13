# mdtool-chrome — консолидированный аудит

Дата: 2026-03-13  
Источник: объединение вашего анализа + дополнительная верификация по коду проекта (`src/background.ts`, `src/sidepanel.tsx`, `src/popup.tsx`, `src/lib/types.ts`, `src/lib/zip.ts`, `src/lib/storage.ts`, `package.json`, `_locales/*`).

## 1) Краткий итог

Проект реализует сильный MVP для web clipping и session-based экспорта Confluence: хорошая архитектурная декомпозиция, строгая типизация и полезные механики long-run задач (checkpoint/pause/resume/retry/rate-limit).

Главные текущие риски:

1. Некорректная иерархия путей Confluence (фундаментальная проблема модели данных и path-builder).
2. Диагностика ошибок Confluence (scan/export смешаны в один код ошибки).
3. UX и наблюдаемость долгих операций (нет live-прогресса, частичная i18n, дебаг-логи без UI).
4. Надежность отдельных edge-case сценариев (таймаут extraction, наивный rewrite URL вложений).

---

## 2) Что подтверждено по коду

## P0 (критично/сразу)

### 2.1 Confluence иерархия папок строится неверно
- `ConfluencePageNode` не содержит `parentId` (только `id/url/title/breadcrumbs/depth`).
- `depth` отражает BFS-уровень обхода, а не истинную иерархию страницы.
- `buildConfluencePagePath` строит путь из breadcrumbs и жестко ограничивает вложенность до 3 уровней (`slice(..., 3)`).
- Breadcrumbs собираются DOM-скрейпом (не всегда полные/стабильные между разными темами/шаблонами Confluence).

Вывод: при глубокой иерархии путь в ZIP системно искажается.

### 2.2 Ошибки экспорта Confluence маркируются как scan-failed
- В обработчике `CONFLUENCE_EXPORT` при ошибке используется `confluence-scan-failed`.
- В `exportConfluenceSpace` ошибки экспорта отдельных страниц тоже маркируются `confluence-scan-failed`.

Вывод: теряется разделение scan vs export в UI, логах и аналитике.

### 2.3 Частичная i18n в sidepanel
- В `src/sidepanel.tsx` много hardcoded-строк на английском (toast, CTA, статусы, подписи, placeholders).
- В `_locales/*` нет соответствующего покрытия для Confluence-блока.
- Тип `MessageKey` в `src/lib/i18n.ts` не включает Confluence-ключи.

Вывод: при RU/ZH интерфейс смешанный.

---

## P1 (высокий/ближайший спринт)

### 2.4 Нет live-прогресса scan/export
- `CONFLUENCE_SCAN` и `CONFLUENCE_EXPORT` возвращают ответ только после завершения.
- Нет промежуточных runtime events или long-lived port-событий.

### 2.5 `requestExtractionFromTab` без явного timeout-wrapper
- `chrome.tabs.sendMessage` используется напрямую без `Promise.race`/таймаута.
- Потенциальный эффект: зависание ожидания в проблемных сценариях content script.

### 2.6 Наивная подмена URL вложений
- `rewriteAttachmentUrls` делает `split/join` по подстроке URL.
- Возможны ложные срабатывания в код-блоках/тексте и при альтернативном markdown-энкодинге ссылок.

### 2.7 Глобальное состояние Confluence-задачи без изоляции
- Используются общие `confluenceJobState.cancelRequested/paused` для всех операций.
- При конкурентных вызовах scan/export возможны конфликты управления.

---

## P2 (средний/низкий)

### 2.8 Ограничения и edge-cases
- Первый шаг rate-limit пропускается (`iteration <= 0`).
- Ошибки при `waitForTabComplete`/`tabs.get(...).catch(() => finish())` проглатываются без логирования причины.
- Total memory pressure: ZIP собирается целиком в memory (`JSZip.generateAsync({ type: "blob" })`).
- Вложения Confluence лимитируются только per-file/per-page, глобального budget на весь экспорт нет.
- `detectConfluenceNoAccess` завязан на англоязычные фразы (хрупко для локализованных инстансов).

### 2.9 DX/качество
- В `package.json` нет `lint`/`typecheck`/`test` скриптов.
- Автотесты отсутствуют (нет `*.test.*` / `*.spec.*`).

### 2.10 UX-нюансы
- В popup возможен partial-success сценарий Send to AI (вкладка открыта, но clipboard не записался -> пользователь видит error toast).
- Валидация custom AI URL мягкая: невалидный URL может сохраниться в настройках (использование потом блокируется, но значение хранится).

---

## 3) Рекомендованный план внедрения

## Этап A (P0)

1. **Исправить модель иерархии Confluence**
   - добавить `parentId?: string` в `ConfluencePageNode`;
   - при BFS сохранять связь родитель -> ребенок;
   - строить path по реальному дереву, а не по breadcrumbs;
   - убрать лимит глубины 3 в `buildConfluencePagePath`.

2. **Развести коды ошибок**
   - добавить `confluence-export-failed` (и при необходимости `confluence-page-export-failed`);
   - использовать эти коды в ветках `CONFLUENCE_EXPORT` и page-level export failures.

3. **Закрыть i18n-долг в sidepanel Confluence**
   - добавить ключи в `_locales/en|ru|zh_CN/messages.json`;
   - расширить `MessageKey` в `src/lib/i18n.ts`;
   - убрать hardcoded английские строки в `src/sidepanel.tsx`.

## Этап B (P1)

4. **Добавить live-прогресс**
   - runtime events/port канал с статусами `queued/scanning/exporting/failed/done`;
   - вывод текущей страницы, счетчиков и ETA.

5. **Timeout на extraction**
   - обернуть `requestExtractionFromTab` в timeout (например, 15s) с нормализованной ошибкой.

6. **Безопасный rewrite вложений**
   - переписывать только markdown image/link tokens, а не глобальным string replace.

7. **Сериализация Confluence задач**
   - mutex/очередь активной операции, запрет параллельных scan/export.

## Этап C (P2)

8. **Наблюдаемость**
   - UI для debug logs: просмотр и экспорт debug bundle.

9. **Инженерная гигиена**
   - добавить npm scripts: `typecheck`, `lint`, `test`;
   - включить их в CI.

10. **Масштабируемость больших Space**
   - глобальный budget для вложений;
   - UX предупреждений по памяти;
   - опционально инкрементальный export (only changed pages).

---

## 4) Финальная оценка

- Архитектура и базовый продукт: сильный MVP.
- Наиболее критичный долг: достоверная иерархия Confluence (текущий подход структурно недостаточен).
- Второй слой рисков: операционная надежность и UX long-run операций (коды ошибок, прогресс, i18n, наблюдаемость).
- После закрытия P0/P1 проект перейдет из “функционально работает” в “стабильно и предсказуемо работает в production-сценариях”.

---

## 5) Базовая интеграция с Obsidian (добавлено)

Цель: минимальная интеграция без backend и без плагина, чтобы сразу давать value пользователям vault-first workflow.

### MVP scope

1. **Export profile: `obsidian-basic`**
   - именование файлов и frontmatter в формате, дружелюбном к Obsidian;
   - дефолтные поля: `source_url`, `captured_at`, `domain`, `tags`.

2. **Структура папок под vault**
   - web clipper: `inbox/` (быстрые заметки);
   - Confluence export: `confluence/<SPACE>/...` (с сохранением иерархии страниц).

3. **Wiki-link режим (опционально)**
   - внутренние ссылки Confluence преобразовывать в `[[Page Title]]`;
   - внешние оставлять обычными markdown links.

4. **Attachment policy**
   - режимы `links-only` / `images-only` / `all`;
   - единая папка `assets/` или `_attachments/` внутри раздела.

5. **MOC файл для навигации**
   - генерация `index.md` по экспортированному Space с ссылками на страницы.

### Почему это выгодно

- сразу закрывает сценарий “Confluence -> локальная база знаний в Obsidian”;
- не требует API-токенов и серверной инфраструктуры;
- хорошо сочетается с текущей архитектурой zip-export и frontmatter.
