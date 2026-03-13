import type {
  AppSettings,
  BatchExportResult,
  ConfluenceAttachmentFile,
  ConfluenceCheckpoint,
  ConfluenceExportPageResult,
  ConfluenceExportResult,
  ConfluencePageNode,
  ConfluenceProgressPayload,
  ConfluenceScanResult,
  ConfluenceScanDebugReport,
  DebugLogEntry,
  ExtractResult,
  ExtractionAttemptReport,
  ExtractionErrorCode,
  ExtractionErrorDetails,
  ExtractionMode,
  ExtractionOperationReport,
  ExtractionPhase,
  PromptTemplate,
  ResolvedExtractionMode,
} from "~lib/types"
import { AI_SERVICES, PROMPT_DEFS, STORAGE_KEY_SETTINGS } from "~lib/constants"
import {
  buildAiPayload,
  buildFrontmatter,
  countWords,
  generateId,
  isValidHttpUrl,
  normalizeUserPrompt,
  slugify,
} from "~lib/utils"
import { appendDebugLog, saveClip, getSettings } from "~lib/storage"

// ── Context Menus ─────────────────────────────────────────────────────────────

const MENU_IDS = {
  savePage: "mdtool-save-page",
  saveHistory: "mdtool-save-history",
  copySelection: "mdtool-copy-selection",
  sendAiRoot: "mdtool-send-ai",
  sendAiServicePrefix: "mdtool-ai-service",
  sendAiPromptPrefix: "mdtool-ai-prompt",
} as const

const NO_RECEIVER_RE =
  /Receiving end does not exist|Could not establish connection|The message port closed before a response was received|Не удалось установить соединение|Принимающая сторона отсутствует|порт сообщения закрыт/i

const DEFAULT_AI_URL = AI_SERVICES.find((svc) => svc.id !== "custom")?.url ?? "https://chat.openai.com/"
const EXTRACTION_REQUEST_TIMEOUT_MS = 15_000
const CONFLUENCE_SCAN_DEFAULT_MAX_PAGES = 200
const CONFLUENCE_SCAN_DEFAULT_MAX_DEPTH = 6
const CONFLUENCE_ATTACHMENTS_PER_PAGE = 8
const CONFLUENCE_ATTACHMENT_MAX_BYTES = 1_500_000
const CONFLUENCE_API_PAGE_LIMIT = 100
const CONFLUENCE_API_V1_PAGE_LIMIT = 50
const CONFLUENCE_RATE_DELAY_MS = 350
const CONFLUENCE_RATE_PAUSE_EVERY = 15
const CONFLUENCE_RATE_PAUSE_MS = 1200
const CONFLUENCE_RETRY_ATTEMPTS = 3
const CONFLUENCE_RETRY_DELAY_MS = 400
const CONFLUENCE_CHECKPOINT_KEY = "mdtool_confluence_checkpoint"
const CONFLUENCE_UI_PREFILL_KEY = "mdtool_confluence_ui_prefill"
const CONFLUENCE_CANCELLED = "CONFLUENCE_CANCELLED"

const confluenceJobState = {
  cancelRequested: false,
  paused: false,
  stage: null as ConfluenceProgressPayload["stage"] | null,
}

let confluenceProgressSnapshot: ConfluenceProgressPayload | null = null

chrome.runtime.onInstalled.addListener(() => {
  void rebuildContextMenus()
})

chrome.runtime.onStartup.addListener(() => {
  void rebuildContextMenus()
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return
  if (!(STORAGE_KEY_SETTINGS in changes)) return
  void rebuildContextMenus()
})

// Ensure menus exist even if install/startup events were skipped.
void rebuildContextMenus()

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return

  const menuId = String(info.menuItemId)

  if (menuId === MENU_IDS.savePage) {
    const extraction = await injectAndExtract(tab.id, "article", { saveToHistory: false, allowFallback: true })
    if (!extraction.ok) {
      notifyActionError()
      return
    }
    const filename = `${slugify(extraction.data.title) || "page"}.md`
    const downloaded = await downloadMarkdown(filename, extraction.data.markdown)
    if (downloaded) notifyQuickSave()
    else notifyActionError()
    return
  }

  if (menuId === MENU_IDS.saveHistory) {
    const mode: ExtractionMode = info.selectionText ? "selection" : "article"
    const extraction = await injectAndExtract(tab.id, mode, { saveToHistory: true, allowFallback: true })
    if (extraction.ok) notifyQuickSave()
    else notifyActionError()
    return
  }

  if (menuId === MENU_IDS.copySelection) {
    const extraction = await injectAndExtract(tab.id, info.selectionText ? "selection" : "article", {
      saveToHistory: false,
      allowFallback: true,
    })
    if (extraction.ok) {
      await clipboardWriteInTab(tab.id, extraction.data.markdown)
    } else {
      notifyActionError()
    }
    return
  }

  const aiPrompt = parseAiPromptMenuId(menuId)
  if (aiPrompt) {
    try {
      await handleAiContextAction(tab.id, info.selectionText, aiPrompt.serviceId, aiPrompt.promptId)
    } catch {
      notifyActionError()
    }
    return
  }

  const aiService = parseAiServiceMenuId(menuId)
  if (aiService) {
    try {
      await handleAiContextAction(tab.id, info.selectionText, aiService.serviceId)
    } catch {
      notifyActionError()
    }
    return
  }

  // Backward compatibility with old static ids
  const legacyService = menuId.match(/^mdtool-ai-(.+)$/)?.[1]
  if (legacyService) {
    try {
      await handleAiContextAction(tab.id, info.selectionText, legacyService)
    } catch {
      notifyActionError()
    }
  }
})

// ── Hot-key command ───────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "quick-save") return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !isSupportedPageUrl(tab.url)) return
  const extraction = await injectAndExtract(tab.id, "article", { saveToHistory: true, allowFallback: true })
  if (extraction.ok) notifyQuickSave()
  else notifyActionError()
})

// ── Message bus (from popup / side panel) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({
        ok: false,
        error: toError("unknown-error", error instanceof Error ? error.message : "Unhandled runtime message error"),
      })
    )
  return true
})

async function handleMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case "EXTRACT_AND_PREVIEW": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { ok: false, error: toError("no-active-tab", "Active tab not found") }
      if (!isSupportedPageUrl(tab.url)) {
        return { ok: false, error: toError("unsupported-url", "Open a regular page (http/https) first") }
      }
      const mode = (msg.mode as ExtractionMode) ?? "article"
      const extraction = await injectAndExtract(tab.id, mode, { saveToHistory: false, allowFallback: true })
      if ("error" in extraction) {
        return { ok: false, error: extraction.error, report: extraction.report }
      }
      return { ok: true, data: extraction.data, report: extraction.report }
    }

    case "SAVE_TO_HISTORY": {
      const result = (msg.result as ExtractResult | undefined) ?? null
      if (!result) {
        return { ok: false, error: toError("save-failed", "No clip payload provided") }
      }
      try {
        await persistClip(result)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          error: toError("save-failed", error instanceof Error ? error.message : "Failed to save clip"),
        }
      }
    }

    case "SEND_TO_AI": {
      const { serviceId, promptText, content, skipClipboard } = msg as {
        serviceId: string
        promptText: string
        content: string
        skipClipboard?: boolean
      }
      try {
        const sendResult = await sendToAi(serviceId, promptText, content, !!skipClipboard)
        return { ok: true, data: sendResult }
      } catch (error) {
        const message = error instanceof Error ? error.message : "send-ai-failed"
        return { ok: false, error: message }
      }
    }

    case "DOWNLOAD_MD": {
      const { filename, content } = msg as { filename: string; content: string }
      const downloaded = await downloadMarkdown(filename as string, content as string)
      if (downloaded) return { ok: true }
      return { ok: false, error: toError("download-failed", "Markdown download failed") }
    }

    case "BATCH_EXPORT": {
      const tabIds = (msg.tabIds as number[]) ?? []
      const report = await batchExport(tabIds)
      return { ok: true, data: report }
    }

    case "CONFLUENCE_SCAN": {
      const input = String(msg.input ?? "").trim()
      const maxPagesRaw = Number(msg.maxPages ?? CONFLUENCE_SCAN_DEFAULT_MAX_PAGES)
      const maxDepthRaw = Number(msg.maxDepth ?? CONFLUENCE_SCAN_DEFAULT_MAX_DEPTH)
      const maxPages = Number.isFinite(maxPagesRaw)
        ? Math.max(10, Math.min(CONFLUENCE_SCAN_DEFAULT_MAX_PAGES, Math.floor(maxPagesRaw)))
        : CONFLUENCE_SCAN_DEFAULT_MAX_PAGES
      const maxDepth = Number.isFinite(maxDepthRaw)
        ? Math.max(1, Math.min(12, Math.floor(maxDepthRaw)))
        : CONFLUENCE_SCAN_DEFAULT_MAX_DEPTH

      confluenceJobState.cancelRequested = false
      confluenceJobState.paused = false
      confluenceJobState.stage = "scan"
      updateConfluenceProgress({
        stage: "scan",
        status: "started",
        spaceKey: normalizeSpaceKey(extractConfluenceSpaceKey(input) || input || "SPACE"),
        spaceUrl: input || "",
        processed: 0,
        total: maxPages,
        queued: 1,
        scanned: 0,
        exported: 0,
        skipped: 0,
        failed: 0,
      })
      try {
        const scan = await scanConfluenceSpace(input, { maxPages, maxDepth })
        updateConfluenceProgress({
          stage: "scan",
          status: "completed",
          spaceKey: scan.spaceKey,
          spaceUrl: scan.spaceUrl,
          processed: scan.scanned + scan.failed,
          total: scan.scanned + scan.failed,
          queued: 0,
          scanned: scan.scanned,
          exported: 0,
          skipped: scan.skipped,
          failed: scan.failed,
        })
        return { ok: true, data: scan }
      } catch (error) {
        const isCancelled = error instanceof Error && error.message === CONFLUENCE_CANCELLED
        const snapshot = confluenceProgressSnapshot
        if (snapshot?.stage === "scan") {
          updateConfluenceProgress({
            ...snapshot,
            status: isCancelled ? "cancelled" : "failed",
            message: error instanceof Error ? error.message : "Confluence scan failed",
          })
        }
        return {
          ok: false,
          error: toError(
            isCancelled ? "confluence-cancelled" : "confluence-scan-failed",
            isCancelled
              ? "Confluence scan cancelled"
              : error instanceof Error
                ? error.message
                : "Confluence scan failed"
          ),
        }
      } finally {
        confluenceJobState.stage = null
      }
    }

    case "CONFLUENCE_EXPORT": {
      const scan = msg.scan as ConfluenceScanResult | undefined
      if (!scan || !Array.isArray(scan.pages) || scan.pages.length === 0) {
        return {
          ok: false,
          error: toError("confluence-no-pages", "Scan pages list is empty"),
        }
      }

      const resume = msg.resume !== false
      const selectedPageIds = Array.isArray(msg.selectedPageIds)
        ? msg.selectedPageIds
            .map((value: unknown) => String(value))
            .filter((value: string) => !!value)
        : null
      const selectedPageIdSet = selectedPageIds ? new Set(selectedPageIds) : null
      const pagesToExport = selectedPageIdSet
        ? scan.pages.filter((page) => selectedPageIdSet.has(page.id))
        : scan.pages
      if (pagesToExport.length === 0) {
        return {
          ok: false,
          error: toError("confluence-no-pages", "No pages selected for export"),
        }
      }

      confluenceJobState.cancelRequested = false
      confluenceJobState.paused = false
      confluenceJobState.stage = "export"
      updateConfluenceProgress({
        stage: "export",
        status: "started",
        spaceKey: scan.spaceKey,
        spaceUrl: scan.spaceUrl,
        processed: 0,
        total: pagesToExport.length,
        queued: pagesToExport.length,
        scanned: scan.scanned,
        exported: 0,
        skipped: 0,
        failed: 0,
      })
      try {
        const exported = await exportConfluenceSpace(scan, {
          resume,
          selectedPageIds: selectedPageIdSet || undefined,
        })
        updateConfluenceProgress({
          stage: "export",
          status: "completed",
          spaceKey: exported.spaceKey,
          spaceUrl: exported.spaceUrl,
          processed: exported.pages.length,
          total: exported.pages.length,
          queued: 0,
          scanned: scan.scanned,
          exported: exported.exported,
          skipped: exported.skipped,
          failed: exported.failed,
        })
        return { ok: true, data: exported }
      } catch (error) {
        const isCancelled = error instanceof Error && error.message === CONFLUENCE_CANCELLED
        const snapshot = confluenceProgressSnapshot
        if (snapshot?.stage === "export") {
          updateConfluenceProgress({
            ...snapshot,
            status: isCancelled ? "cancelled" : "failed",
            message: error instanceof Error ? error.message : "Confluence export failed",
          })
        }
        return {
          ok: false,
          error: toError(
            isCancelled ? "confluence-cancelled" : "confluence-export-failed",
            isCancelled
              ? "Confluence export cancelled"
              : error instanceof Error
                ? error.message
                : "Confluence export failed"
          ),
        }
      } finally {
        confluenceJobState.stage = null
      }
    }

    case "CONFLUENCE_CANCEL": {
      confluenceJobState.cancelRequested = true
      confluenceJobState.paused = false
      if (confluenceProgressSnapshot && confluenceJobState.stage) {
        updateConfluenceProgress({
          ...confluenceProgressSnapshot,
          status: "cancelled",
          message: "Cancellation requested",
        })
      }
      return { ok: true }
    }

    case "CONFLUENCE_PAUSE": {
      confluenceJobState.paused = true
      if (confluenceProgressSnapshot && confluenceJobState.stage) {
        updateConfluenceProgress({
          ...confluenceProgressSnapshot,
          status: "paused",
        })
      }
      return { ok: true }
    }

    case "CONFLUENCE_RESUME": {
      confluenceJobState.paused = false
      if (confluenceProgressSnapshot && confluenceJobState.stage) {
        updateConfluenceProgress({
          ...confluenceProgressSnapshot,
          status: "running",
        })
      }
      return { ok: true }
    }

    case "CONFLUENCE_CHECKPOINT_GET": {
      const checkpoint = await getConfluenceCheckpoint()
      return { ok: true, data: checkpoint }
    }

    case "CONFLUENCE_CHECKPOINT_CLEAR": {
      await clearConfluenceCheckpoint()
      return { ok: true }
    }

    case "SETTINGS_UPDATED": {
      await rebuildContextMenus()
      return { ok: true }
    }

    case "CONFLUENCE_PROGRESS_GET": {
      return { ok: true, data: confluenceProgressSnapshot }
    }

    case "CONFLUENCE_UI_PREFILL_CONSUME": {
      const prefill = await consumeConfluenceUiPrefill()
      return { ok: true, data: prefill }
    }

    case "GET_ACTIVE_TAB_CONTEXT": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const url = tab?.url || ""
      const confluenceSpaceUrl = url ? resolveConfluenceSpaceUrlFromPageUrl(url) : null
      return {
        ok: true,
        data: {
          tabId: tab?.id ?? null,
          windowId: tab?.windowId ?? null,
          url,
          title: tab?.title || "",
          isConfluence: !!confluenceSpaceUrl,
          confluenceSpaceUrl,
        },
      }
    }

    case "OPEN_CONFLUENCE_EXPORT": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const seedInput = String(msg.input ?? "").trim()
      const fallbackInput = tab?.url ? resolveConfluenceSpaceUrlFromPageUrl(tab.url) || tab.url : ""
      const input = seedInput || fallbackInput
      if (!input) {
        return { ok: false, error: toError("confluence-invalid-input", "Confluence page URL not found") }
      }

      await saveConfluenceUiPrefill(input)

      const sidePanelApi = chrome.sidePanel as
        | {
            setOptions?: (options: { tabId: number; path: string; enabled: boolean }) => Promise<void>
            open?: (options: { tabId?: number; windowId?: number }) => Promise<void>
          }
        | undefined

      let opened = false
      let openErrorMessage = ""

      if (tab?.id && sidePanelApi && typeof sidePanelApi.open === "function") {
        try {
          if (typeof sidePanelApi.setOptions === "function") {
            await sidePanelApi.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true })
          }
        } catch {
          // Ignore setOptions failures, open attempt can still work.
        }

        try {
          await sidePanelApi.open({ tabId: tab.id })
          opened = true
        } catch (error) {
          if (typeof tab.windowId === "number") {
            try {
              await sidePanelApi.open({ windowId: tab.windowId })
              opened = true
            } catch (windowError) {
              openErrorMessage = windowError instanceof Error ? windowError.message : "Failed to open side panel"
            }
          } else {
            openErrorMessage = error instanceof Error ? error.message : "Failed to open side panel"
          }
        }
      }

      if (!opened) {
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") })
          opened = true
        } catch (error) {
          const fallbackError = error instanceof Error ? error.message : "Could not open Confluence export UI"
          return { ok: false, error: toError("confluence-scan-failed", fallbackError) }
        }
      }

      return { ok: true, data: { input, opened, openErrorMessage } }
    }

    case "CONFLUENCE_PROGRESS": {
      return { ok: true }
    }

    default:
      return { ok: false, error: toError("unknown-error", "Unknown message type") }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSupportedPageUrl(url?: string): boolean {
  return !!url && /^(https?|file):/i.test(url)
}

function getClipperScriptCandidates(): string[] {
  const manifest = chrome.runtime.getManifest()
  const fromManifest =
    manifest.content_scripts
      ?.flatMap((entry) => entry.js ?? [])
      .filter((file) => file.includes("clipper")) ?? []

  return Array.from(new Set([...fromManifest, "contents/clipper.js", "clipper.js"]))
}

async function tryInjectClipperScript(tabId: number): Promise<boolean> {
  const candidates = getClipperScriptCandidates()
  for (const file of candidates) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [file],
      })
      return true
    } catch {
      // Keep trying the next candidate
    }
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emitConfluenceProgress(payload: ConfluenceProgressPayload): void {
  confluenceProgressSnapshot = payload
  chrome.runtime.sendMessage({ type: "CONFLUENCE_PROGRESS", data: payload }, () => {
    void chrome.runtime.lastError
  })
}

function updateConfluenceProgress(next: Omit<ConfluenceProgressPayload, "updatedAt">): void {
  emitConfluenceProgress({
    ...next,
    updatedAt: new Date().toISOString(),
  })
}

async function saveConfluenceUiPrefill(input: string): Promise<void> {
  const payload = {
    input,
    createdAt: new Date().toISOString(),
  }
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [CONFLUENCE_UI_PREFILL_KEY]: payload }, () => resolve())
  })
}

async function consumeConfluenceUiPrefill(): Promise<{ input: string; createdAt: string } | null> {
  const payload = await new Promise<{ input?: string; createdAt?: string } | null>((resolve) => {
    chrome.storage.local.get([CONFLUENCE_UI_PREFILL_KEY], (data) => {
      resolve((data?.[CONFLUENCE_UI_PREFILL_KEY] as { input?: string; createdAt?: string } | undefined) ?? null)
    })
  })

  await new Promise<void>((resolve) => {
    chrome.storage.local.remove([CONFLUENCE_UI_PREFILL_KEY], () => resolve())
  })

  if (!payload?.input) return null
  return {
    input: String(payload.input),
    createdAt: payload.createdAt ? String(payload.createdAt) : new Date().toISOString(),
  }
}

function resolveConfluenceSpaceUrlFromPageUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.includes("/wiki/") && !parsed.pathname.includes("/display/")) return null

    const key = extractConfluenceSpaceKey(url)
    if (!key) return null
    const normalized = normalizeSpaceKey(key)

    if (parsed.pathname.includes("/display/")) {
      return `${parsed.origin}/display/${encodeURIComponent(normalized)}`
    }
    return `${parsed.origin}/wiki/spaces/${encodeURIComponent(normalized)}`
  } catch {
    return null
  }
}

type ExtractAttempt =
  | { ok: true; mode: ResolvedExtractionMode; data: ExtractResult }
  | { ok: false; mode: ResolvedExtractionMode; error: ExtractionErrorDetails; noReceiver?: boolean }

interface InjectOptions {
  saveToHistory: boolean
  allowFallback: boolean
}

type ExtractionExecutionResult =
  | { ok: true; data: ExtractResult; report: ExtractionOperationReport }
  | { ok: false; error: ExtractionErrorDetails; report: ExtractionOperationReport }

function toAiServiceMenuId(serviceId: string): string {
  return `${MENU_IDS.sendAiServicePrefix}::${serviceId}`
}

function toAiPromptMenuId(serviceId: string, promptId: string): string {
  return `${MENU_IDS.sendAiPromptPrefix}::${serviceId}::${encodeURIComponent(promptId)}`
}

function parseAiServiceMenuId(menuId: string): { serviceId: string } | null {
  if (!menuId.startsWith(`${MENU_IDS.sendAiServicePrefix}::`)) return null
  const [, serviceId] = menuId.split("::")
  return serviceId ? { serviceId } : null
}

function parseAiPromptMenuId(menuId: string): { serviceId: string; promptId: string } | null {
  if (!menuId.startsWith(`${MENU_IDS.sendAiPromptPrefix}::`)) return null
  const parts = menuId.split("::")
  if (parts.length < 3) return null
  const serviceId = parts[1]
  const encodedPromptId = parts.slice(2).join("::")
  try {
    return { serviceId, promptId: decodeURIComponent(encodedPromptId) }
  } catch {
    return null
  }
}

function removeAllContextMenus(): Promise<void> {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve())
  })
}

function safeCreateContextMenu(createProperties: chrome.contextMenus.CreateProperties): void {
  chrome.contextMenus.create(createProperties, () => {
    void chrome.runtime.lastError
  })
}

function getBuiltInPromptTemplates(): PromptTemplate[] {
  return PROMPT_DEFS.map((prompt) => ({
    id: prompt.id,
    label: chrome.i18n.getMessage(prompt.labelKey) || prompt.id,
    prompt: prompt.prompt,
  }))
}

function getPromptTemplates(settings: AppSettings): PromptTemplate[] {
  const builtIn = getBuiltInPromptTemplates()
  const custom = settings.customPrompts
    .filter((prompt) => prompt.id && prompt.label?.trim() && prompt.prompt?.trim())
    .map((prompt) => ({ ...prompt, isCustom: true }))
    .filter((prompt) => !builtIn.some((item) => item.id === prompt.id))

  return [...builtIn, ...custom]
}

function resolvePromptText(settings: AppSettings, promptId?: string): string {
  const selectedPromptId = promptId ?? settings.defaultPromptTemplate
  const builtIn = PROMPT_DEFS.find((prompt) => prompt.id === selectedPromptId)
  if (builtIn) return builtIn.prompt

  const custom = settings.customPrompts.find((prompt) => prompt.id === selectedPromptId)
  if (custom?.prompt?.trim()) return normalizeUserPrompt(custom.prompt)

  const fallbackBuiltIn = PROMPT_DEFS[0]
  return fallbackBuiltIn?.prompt ?? ""
}

async function rebuildContextMenus(): Promise<void> {
  await removeAllContextMenus()

  safeCreateContextMenu({
    id: MENU_IDS.savePage,
    title: chrome.i18n.getMessage("ctxSavePage"),
    contexts: ["page"],
  })

  safeCreateContextMenu({
    id: MENU_IDS.saveHistory,
    title: chrome.i18n.getMessage("ctxSaveToHistory"),
    contexts: ["page", "selection"],
  })

  safeCreateContextMenu({
    id: MENU_IDS.copySelection,
    title: chrome.i18n.getMessage("ctxCopyMd"),
    contexts: ["selection"],
  })

  safeCreateContextMenu({
    id: MENU_IDS.sendAiRoot,
    title: chrome.i18n.getMessage("ctxSendAi"),
    contexts: ["page", "selection"],
  })

  const settings = await getSettings()
  const promptTemplates = getPromptTemplates(settings)

  for (const service of AI_SERVICES) {
    const serviceMenuId = toAiServiceMenuId(service.id)
    safeCreateContextMenu({
      id: serviceMenuId,
      parentId: MENU_IDS.sendAiRoot,
      title: `${service.icon} ${service.label}`,
      contexts: ["page", "selection"],
    })

    for (const prompt of promptTemplates) {
      safeCreateContextMenu({
        id: toAiPromptMenuId(service.id, prompt.id),
        parentId: serviceMenuId,
        title: prompt.label,
        contexts: ["page", "selection"],
      })
    }
  }
}

async function handleAiContextAction(
  tabId: number,
  selectionText: string | undefined,
  serviceId: string,
  promptId?: string
): Promise<void> {
  const mode: ExtractionMode = selectionText ? "selection" : "article"
  const extraction = await injectAndExtract(tabId, mode, { saveToHistory: false, allowFallback: true })
  if (!extraction.ok) return

  const settings = await getSettings()
  const promptText = resolvePromptText(settings, promptId)
  await sendToAi(serviceId, promptText, extraction.data.markdown, false, tabId)
}

function requestExtractionFromTab(tabId: number, mode: ExtractionMode): Promise<ExtractAttempt> {
  return new Promise((resolve) => {
    let settled = false
    const finalize = (result: ExtractAttempt) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      finalize({
        ok: false,
        mode,
        error: toError(
          "extract-failed",
          `Content extraction timeout after ${Math.floor(EXTRACTION_REQUEST_TIMEOUT_MS / 1000)}s`,
          mode,
          "extracting"
        ),
      })
    }, EXTRACTION_REQUEST_TIMEOUT_MS)

    try {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: mode === "selection" ? "EXTRACT_SELECTION" : "EXTRACT_PAGE",
          options: { mode, includeFrontmatter: true, includeImages: false },
        },
        (res) => {
          const lastError = chrome.runtime.lastError
          if (lastError) {
            finalize({
              ok: false,
              mode,
              error: toError(
                "content-script-missing",
                lastError.message || "Content script is not available for this page",
                mode,
                "extracting"
              ),
              noReceiver: NO_RECEIVER_RE.test(lastError.message || ""),
            })
            return
          }

          if (!res?.ok) {
            finalize({
              ok: false,
              mode,
              error: normalizeResponseError(res?.error, mode),
            })
            return
          }

          finalize({ ok: true, mode, data: res.data as ExtractResult })
        }
      )
    } catch (error) {
      finalize({
        ok: false,
        mode,
        error: toError(
          "extract-failed",
          error instanceof Error ? error.message : "Failed to send extraction request",
          mode,
          "extracting"
        ),
      })
    }
  })
}

async function injectAndExtract(
  tabId: number,
  mode: ExtractionMode,
  options: InjectOptions
): Promise<ExtractionExecutionResult> {
  const report = createInitialReport(mode)
  pushPhase(report, "queued")

  const tabUrl = await resolveTabUrl(tabId)
  const hasSelection = options.allowFallback ? await tabHasSelection(tabId) : false
  const modePlan = buildModePlan(mode, hasSelection, options.allowFallback)
  let lastError = toError("extract-failed", "Extraction failed", mode, "extracting")
  const hasStructuredPlan = modePlan.some((plannedMode) => plannedMode !== "text")
  let clipperInjected = false

  // Pre-inject once so extraction works even when content script did not attach automatically.
  if (hasStructuredPlan) {
    clipperInjected = await tryInjectClipperScript(tabId)
    if (clipperInjected) {
      await sleep(60)
    }
  }

  for (const plannedMode of modePlan) {
    pushPhase(report, "extracting")

    let attempt: ExtractAttempt =
      plannedMode === "text"
        ? await extractPlainTextFromTab(tabId)
        : await requestExtractionFromTab(tabId, plannedMode)

    // Retry after explicit reinjection whenever content script is unavailable.
    if (
      !attempt.ok &&
      plannedMode !== "text" &&
      "error" in attempt &&
      attempt.error.code === "content-script-missing"
    ) {
      const injected = await tryInjectClipperScript(tabId)
      clipperInjected = clipperInjected || injected
      if (injected) {
        await sleep(60)
        attempt = await requestExtractionFromTab(tabId, plannedMode)
        if (!attempt.ok && "error" in attempt && attempt.error.code === "content-script-missing") {
          await sleep(160)
          attempt = await requestExtractionFromTab(tabId, plannedMode)
        }
      }
    }

    pushPhase(report, "converting")
    if (attempt.ok && !attempt.data.markdown.trim()) {
      attempt = {
        ok: false,
        mode: attempt.mode,
        error: toError("empty-content", "Extracted markdown is empty", mode, "converting"),
      }
    }

    report.attempts.push(toAttemptReport(attempt))
    if (!attempt.ok) {
      lastError = "error" in attempt ? attempt.error : toError("extract-failed", "Extraction failed", mode, "error")
      continue
    }

    if (options.saveToHistory) {
      try {
        await persistClip(attempt.data)
        report.historySaved = true
      } catch (error) {
        const saveError = toError(
          "save-failed",
          error instanceof Error ? error.message : "Failed to save clip",
          mode,
          "saved"
        )
        report.attempts.push({ mode: attempt.mode, ok: false, error: saveError })
        pushPhase(report, "error")
        await writeDebugLog({
          kind: "extract",
          tabId,
          tabUrl,
          report,
        })
        return { ok: false, error: saveError, report }
      }
    }

    report.usedMode = attempt.mode
    report.fallbackUsed = attempt.mode !== mode
    pushPhase(report, "saved")

    await writeDebugLog({
      kind: "extract",
      tabId,
      tabUrl,
      report,
    })

    return { ok: true, data: attempt.data, report }
  }

  pushPhase(report, "error")
  await writeDebugLog({
    kind: "extract",
    tabId,
    tabUrl,
    report,
  })
  return { ok: false, error: lastError, report }
}

async function extractPlainTextFromTab(tabId: number): Promise<ExtractAttempt> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        title: document.title || "Untitled page",
        url: location.href,
        text: document.body?.innerText ?? "",
      }),
    })

    const payload = result as { title?: string; url?: string; text?: string } | undefined
    const text = payload?.text?.trim() ?? ""
    if (!text) {
      return {
        ok: false,
        mode: "text",
        error: toError("empty-content", "No readable text found on this page", "article", "extracting"),
      }
    }

    const markdown = text
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "")
      .trim()

    const title = payload?.title?.trim() || "Untitled page"
    const url = payload?.url || ""
    const wordCount = countWords(markdown)
    const markdownWithFrontmatter =
      buildFrontmatter({
        title,
        url,
        wordCount,
        extractionMode: "text",
      }) + markdown

    return {
      ok: true,
      mode: "text",
      data: {
        title,
        url,
        markdown: markdownWithFrontmatter,
        wordCount,
      },
    }
  } catch (error) {
    return {
      ok: false,
      mode: "text",
      error: toError(
        "extract-failed",
        error instanceof Error ? error.message : "Text fallback extraction failed",
        "article",
        "extracting"
      ),
    }
  }
}

async function tabHasSelection(tabId: number): Promise<boolean> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selection = window.getSelection()
        return !!selection && selection.rangeCount > 0 && !selection.isCollapsed
      },
    })
    return Boolean(result)
  } catch {
    return false
  }
}

function buildModePlan(
  requestedMode: ExtractionMode,
  hasSelection: boolean,
  allowFallback: boolean
): ResolvedExtractionMode[] {
  if (!allowFallback) return [requestedMode]

  let basePlan: ResolvedExtractionMode[]
  switch (requestedMode) {
    case "article":
      basePlan = hasSelection
        ? ["article", "full", "selection", "text"]
        : ["article", "full", "text"]
      break
    case "selection":
      basePlan = ["selection", "article", "full", "text"]
      break
    case "code":
      basePlan = ["code", "article", "full", "text"]
      break
    case "tables":
      basePlan = ["tables", "article", "full", "text"]
      break
    case "full":
      basePlan = ["full", "text"]
      break
    default:
      basePlan = [requestedMode, "text"]
      break
  }

  return Array.from(new Set(basePlan))
}

function createInitialReport(requestedMode: ExtractionMode): ExtractionOperationReport {
  return {
    requestedMode,
    statuses: [],
    attempts: [],
    historySaved: false,
    fallbackUsed: false,
  }
}

function pushPhase(report: ExtractionOperationReport, phase: ExtractionPhase): void {
  const prev = report.statuses[report.statuses.length - 1]
  if (prev !== phase) {
    report.statuses.push(phase)
  }
}

function toAttemptReport(attempt: ExtractAttempt): ExtractionAttemptReport {
  if (attempt.ok) {
    return { mode: attempt.mode, ok: true }
  }
  return {
    mode: attempt.mode,
    ok: false,
    error: "error" in attempt ? attempt.error : toError("extract-failed", "Extraction failed"),
  }
}

function toError(
  code: ExtractionErrorCode,
  message: string,
  mode?: ExtractionMode,
  phase?: ExtractionPhase
): ExtractionErrorDetails {
  return { code, message, mode, phase }
}

function normalizeResponseError(error: unknown, mode: ExtractionMode): ExtractionErrorDetails {
  if (typeof error === "object" && error !== null) {
    const maybeError = error as Partial<ExtractionErrorDetails>
    if (maybeError.code) {
      return {
        code: maybeError.code,
        message: maybeError.message || "Extraction failed",
        mode: maybeError.mode || mode,
        phase: maybeError.phase,
      }
    }
  }

  if (typeof error === "string" && error.trim()) {
    return toError("extract-failed", error.trim(), mode, "extracting")
  }

  return toError("extract-failed", "Extraction failed", mode, "extracting")
}

async function persistClip(result: ExtractResult): Promise<void> {
  await saveClip({
    id: generateId(),
    title: result.title,
    url: result.url,
    domain: (() => {
      try {
        return new URL(result.url).hostname
      } catch {
        return result.url
      }
    })(),
    markdown: result.markdown,
    wordCount: result.wordCount,
    exportedAt: new Date().toISOString(),
  })
}

async function resolveTabUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab.url
  } catch {
    return undefined
  }
}

async function resolveTabSummary(tabId: number): Promise<{ title?: string; url?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return { title: tab.title, url: tab.url }
  } catch {
    return {}
  }
}

async function writeDebugLog(entry: {
  kind: DebugLogEntry["kind"]
  tabId?: number
  tabUrl?: string
  report: ExtractionOperationReport | ConfluenceScanDebugReport
}): Promise<void> {
  try {
    await appendDebugLog({
      id: generateId(),
      createdAt: new Date().toISOString(),
      kind: entry.kind,
      tabId: entry.tabId,
      tabUrl: entry.tabUrl,
      report: entry.report,
    })
  } catch {
    // Debug logging should never break user flows.
  }
}

async function writeConfluenceScanDebugLog(
  mode: ConfluenceScanDebugReport["mode"],
  seed: { spaceKey: string; spaceUrl: string },
  payload: { scanned: number; skipped: number; failures: ConfluenceScanResult["failures"] }
): Promise<void> {
  await writeDebugLog({
    kind: "confluence-scan",
    tabUrl: seed.spaceUrl,
    report: {
      mode,
      spaceKey: seed.spaceKey,
      spaceUrl: seed.spaceUrl,
      scanned: payload.scanned,
      skipped: payload.skipped,
      failed: payload.failures.length,
      failureSamples: payload.failures.slice(0, 10).map((failure) => ({
        url: failure.url,
        code: failure.error.code,
        message: failure.error.message,
      })),
    },
  })
}

async function downloadMarkdown(filename: string, content: string): Promise<boolean> {
  const safeName = filename.endsWith(".md") ? filename : `${filename}.md`
  const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: safeName,
      saveAs: false,
    })
    return true
  } catch {
    return false
  }
}

async function sendToAi(
  serviceId: string,
  promptText: string,
  content: string,
  skipClipboard = false,
  sourceTabId?: number
): Promise<{ clipboardWritten: boolean; serviceUrl: string }> {
  const serviceUrl = await resolveAiServiceUrl(serviceId)
  const payload = buildAiPayload(promptText, content)
  let clipboardWritten = false

  if (!skipClipboard) {
    let tabId = sourceTabId
    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      tabId = tab?.id
    }

    if (tabId) {
      clipboardWritten = await clipboardWriteInTab(tabId, payload)
    }
  }

  await chrome.tabs.create({ url: serviceUrl })
  return { clipboardWritten, serviceUrl }
}

async function resolveAiServiceUrl(serviceId: string): Promise<string> {
  if (serviceId === "custom") {
    const settings = await getSettings()
    const customUrl = settings.customAiUrl.trim()
    if (!isValidHttpUrl(customUrl)) {
      throw new Error("custom-url-missing")
    }
    return customUrl
  }

  const service = AI_SERVICES.find((item) => item.id === serviceId)
  return service?.url || DEFAULT_AI_URL
}

async function clipboardWriteInTab(tabId: number, text: string): Promise<boolean> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (t: string) => {
        try {
          await navigator.clipboard.writeText(t)
          return true
        } catch {
          return false
        }
      },
      args: [text],
    })
    return !!result
  } catch {
    return false
  }
}

async function batchExport(tabIds: number[]): Promise<BatchExportResult> {
  const items: ExtractResult[] = []
  const failures: BatchExportResult["failures"] = []

  for (const tabId of tabIds) {
    const extraction = await injectAndExtract(tabId, "article", {
      saveToHistory: true,
      allowFallback: true,
    })
    if (extraction.ok) {
      items.push(extraction.data)
    } else if ("error" in extraction) {
      const tabSummary = await resolveTabSummary(tabId)
      failures.push({
        tabId,
        title: tabSummary.title,
        url: tabSummary.url,
        error: extraction.error,
      })
    }
  }

  const report: BatchExportResult = {
    items,
    failures,
    exported: items.length,
    failed: failures.length,
    generatedAt: new Date().toISOString(),
  }

  await writeDebugLog({
    kind: "batch",
    report: {
      requestedMode: "article",
      usedMode: items.length > 0 ? "article" : undefined,
      statuses: failures.length > 0 ? ["queued", "extracting", "error"] : ["queued", "saved"],
      attempts: failures.map((failure) => ({
        mode: "article",
        ok: false,
        error: failure.error,
      })),
      historySaved: items.length > 0,
      fallbackUsed: false,
    },
  })

  return report
}

function throwIfConfluenceCancelled(): void {
  if (confluenceJobState.cancelRequested) {
    throw new Error(CONFLUENCE_CANCELLED)
  }
}

async function waitIfConfluencePaused(): Promise<void> {
  while (confluenceJobState.paused && !confluenceJobState.cancelRequested) {
    await sleep(250)
  }
  throwIfConfluenceCancelled()
}

async function applyConfluenceRateLimit(iteration: number): Promise<void> {
  if (iteration <= 0) return
  await sleep(CONFLUENCE_RATE_DELAY_MS)
  if (iteration % CONFLUENCE_RATE_PAUSE_EVERY === 0) {
    await sleep(CONFLUENCE_RATE_PAUSE_MS)
  }
}

function isTransientConfluenceError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes("timeout") ||
    message.includes("temporar") ||
    message.includes("network") ||
    message.includes("failed to fetch") ||
    message.includes("net::err") ||
    message.includes("message port closed") ||
    message.includes("receiving end does not exist") ||
    message.includes("could not establish connection")
  )
}

async function withConfluenceRetry<T>(
  operation: () => Promise<T>,
  attempts = CONFLUENCE_RETRY_ATTEMPTS
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfConfluenceCancelled()
    await waitIfConfluencePaused()
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransientConfluenceError(error)) {
        throw error
      }
      await sleep(CONFLUENCE_RETRY_DELAY_MS * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Confluence retry failed")
}

async function getConfluenceCheckpoint(): Promise<ConfluenceCheckpoint | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([CONFLUENCE_CHECKPOINT_KEY], (payload) => {
      const checkpoint = payload?.[CONFLUENCE_CHECKPOINT_KEY] as ConfluenceCheckpoint | undefined
      resolve(checkpoint || null)
    })
  })
}

async function saveConfluenceCheckpoint(checkpoint: ConfluenceCheckpoint): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [CONFLUENCE_CHECKPOINT_KEY]: checkpoint }, () => resolve())
  })
}

async function clearConfluenceCheckpoint(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove([CONFLUENCE_CHECKPOINT_KEY], () => resolve())
  })
}

function isSameConfluenceSpace(checkpoint: ConfluenceCheckpoint, scan: ConfluenceScanResult): boolean {
  return checkpoint.spaceKey === scan.spaceKey && checkpoint.spaceUrl === scan.spaceUrl
}

function createConfluenceCheckpoint(scan: ConfluenceScanResult): ConfluenceCheckpoint {
  const now = new Date().toISOString()
  return {
    id: generateId(),
    spaceKey: scan.spaceKey,
    spaceUrl: scan.spaceUrl,
    scan,
    pages: [],
    attachments: [],
    nextPageIndex: 0,
    totalPages: scan.pages.length,
    completed: false,
    createdAt: now,
    updatedAt: now,
  }
}

function withCheckpointPageOrder(
  scan: ConfluenceScanResult,
  pagesById: Map<string, ConfluenceExportPageResult>
): ConfluenceExportPageResult[] {
  const ordered: ConfluenceExportPageResult[] = []
  for (const page of scan.pages) {
    const hit = pagesById.get(page.id)
    if (hit) ordered.push(hit)
  }
  return ordered
}

function mergeAttachment(
  existing: ConfluenceAttachmentFile[],
  incoming: ConfluenceAttachmentFile[]
): ConfluenceAttachmentFile[] {
  const byKey = new Map<string, ConfluenceAttachmentFile>()
  for (const item of existing) {
    byKey.set(`${item.pageId}::${item.sourceUrl}::${item.localPath}`, item)
  }
  for (const item of incoming) {
    byKey.set(`${item.pageId}::${item.sourceUrl}::${item.localPath}`, item)
  }
  return Array.from(byKey.values())
}

async function prepareConfluenceCheckpoint(
  scan: ConfluenceScanResult,
  resume: boolean
): Promise<ConfluenceCheckpoint> {
  const existing = resume ? await getConfluenceCheckpoint() : null
  if (existing && !existing.completed && isSameConfluenceSpace(existing, scan)) {
    const updated: ConfluenceCheckpoint = {
      ...existing,
      scan,
      totalPages: scan.pages.length,
      updatedAt: new Date().toISOString(),
    }
    await saveConfluenceCheckpoint(updated)
    return updated
  }

  const created = createConfluenceCheckpoint(scan)
  await saveConfluenceCheckpoint(created)
  return created
}

function cleanConfluenceUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ""
  ;["utm_source", "utm_medium", "utm_campaign", "atlOrigin", "focusedCommentId"].forEach((key) =>
    parsed.searchParams.delete(key)
  )
  return parsed.toString()
}

function extractConfluenceSpaceKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    const fromSpacesPath = parsed.pathname.match(/\/wiki\/spaces\/([^/]+)/i)?.[1]
    if (fromSpacesPath) return decodeURIComponent(fromSpacesPath)
    const fromDisplayPath = parsed.pathname.match(/\/display\/([^/]+)/i)?.[1]
    if (fromDisplayPath) return decodeURIComponent(fromDisplayPath)
    const fromQuery = parsed.searchParams.get("spaceKey")
    if (fromQuery) return fromQuery
    return null
  } catch {
    return null
  }
}

function normalizeSpaceKey(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, "")
  if (!cleaned) return "SPACE"
  if (cleaned.startsWith("~")) return cleaned
  return cleaned.toUpperCase()
}

function buildPageNodeId(url: string): string {
  // Two independent 32-bit FNV-1a–style hashes to reduce collision probability.
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x811c9dc5)
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0")
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0")
  return `cf-${hex1}${hex2}`
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()

  const safe = cleaned || fallback
  return safe.length > 80 ? safe.slice(0, 80) : safe
}

function isConfluenceCandidateUrl(url: string, origin: string, spaceKey: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== origin) return false
    if (!parsed.pathname.includes("/wiki/") && !parsed.pathname.includes("/display/")) return false

    const linkSpace = extractConfluenceSpaceKey(parsed.toString())
    if (linkSpace && normalizeSpaceKey(linkSpace) !== normalizeSpaceKey(spaceKey)) {
      return false
    }

    return true
  } catch {
    return false
  }
}

async function waitForTabComplete(tabId: number, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(onUpdated)
      clearTimeout(timeout)
      resolve()
    }

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId) return
      if (changeInfo.status === "complete") {
        finish()
      }
    }

    const timeout = setTimeout(() => finish(), timeoutMs)
    chrome.tabs.onUpdated.addListener(onUpdated)
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        finish()
      }
    }).catch(() => finish())
  })
}

async function openHiddenTab(url: string): Promise<number> {
  const tab = await chrome.tabs.create({ url, active: false })
  if (!tab.id) {
    throw new Error(`Could not open tab for: ${url}`)
  }
  await waitForTabComplete(tab.id)
  // Confluence pages are SPAs that continue rendering after the load event.
  // A short extra wait lets the framework hydrate before we attempt extraction.
  await sleep(400)
  return tab.id
}

async function closeTabSafe(tabId: number | undefined): Promise<void> {
  if (!tabId) return
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // Tab may already be gone.
  }
}

async function resolveConfluenceOriginFromTabs(): Promise<string | null> {
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab.url) continue
      try {
        const parsed = new URL(tab.url)
        if (parsed.pathname.includes("/wiki/") || parsed.pathname.includes("/display/")) {
          return parsed.origin
        }
      } catch {
        // Ignore bad tab URLs.
      }
    }
  } catch {
    // Optional tabs permission may be missing.
  }
  return null
}

async function resolveConfluenceSeed(input: string): Promise<{ spaceUrl: string; origin: string; spaceKey: string }> {
  if (!input.trim()) {
    throw new Error("Enter Confluence Space URL or key")
  }

  if (isValidHttpUrl(input)) {
    const clean = cleanConfluenceUrl(input.trim())
    const parsed = new URL(clean)
    const spaceKey = normalizeSpaceKey(extractConfluenceSpaceKey(clean) || parsed.hostname.split(".")[0] || "SPACE")
    return { spaceUrl: clean, origin: parsed.origin, spaceKey }
  }

  const key = input.trim().replace(/\s+/g, "")
  if (!/^[~a-z0-9._-]{1,128}$/i.test(key)) {
    throw new Error("Use full Space URL or a valid Space key")
  }

  const origin = await resolveConfluenceOriginFromTabs()
  if (!origin) {
    throw new Error("Open any Confluence tab first, or enter full Space URL")
  }

  const spaceKey = normalizeSpaceKey(key)
  return {
    origin,
    spaceKey,
    spaceUrl: `${origin}/wiki/spaces/${encodeURIComponent(spaceKey)}`,
  }
}

interface ConfluenceApiPageRecord {
  sourceId: string
  title: string
  url: string
  parentSourceId?: string
}

function buildConfluenceNodeIdFromSourceId(sourceId: string): string {
  return `cf-page-${sourceId}`
}

function resolveConfluenceApiUrl(pathOrUrl: string, origin: string, baseHint?: string): string | null {
  if (!pathOrUrl) return null
  try {
    const trimmed = pathOrUrl.trim()
    if (!trimmed) return null
    if (/^https?:\/\//i.test(trimmed)) {
      return cleanConfluenceUrl(new URL(trimmed).toString())
    }

    if (baseHint) {
      try {
        if (trimmed.startsWith("/")) {
          // Absolute path: concatenate with baseHint so the base path (e.g. /wiki)
          // is preserved. new URL("/path", "https://host/wiki/") would strip /wiki,
          // so we string-concat instead: "https://host/wiki" + "/spaces/..." → correct.
          const base = baseHint.endsWith("/") ? baseHint.slice(0, -1) : baseHint
          return cleanConfluenceUrl(new URL(base + trimmed).toString())
        }
        // Relative path: resolve normally against the base.
        const baseForRelative = baseHint.endsWith("/") ? baseHint : `${baseHint}/`
        return cleanConfluenceUrl(new URL(trimmed, baseForRelative).toString())
      } catch {
        // Fallback to manual path handling below.
      }
    }

    const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
    if (normalized.startsWith("/wiki/")) {
      return cleanConfluenceUrl(new URL(normalized, origin).toString())
    }
    if (
      normalized.startsWith("/rest/") ||
      normalized.startsWith("/api/") ||
      normalized.startsWith("/spaces/") ||
      normalized.startsWith("/display/")
    ) {
      return cleanConfluenceUrl(new URL(`/wiki${normalized}`, origin).toString())
    }
    return cleanConfluenceUrl(new URL(normalized, `${origin}/wiki`).toString())
  } catch {
    return null
  }
}

async function confluenceApiFetchJsonInTab(
  tabId: number,
  requestUrl: string
): Promise<{ ok: boolean; status: number; json: unknown; errorMessage?: string }> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (url: string) => {
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: { Accept: "application/json" },
        })
        const text = await response.text()
        let parsed: unknown = null
        if (text) {
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          json: parsed,
          errorMessage: response.ok
            ? ""
            : typeof (parsed as { message?: unknown } | null)?.message === "string"
              ? String((parsed as { message: string }).message)
              : text.slice(0, 240),
        }
      } catch (error) {
        return {
          ok: false,
          status: 0,
          json: null,
          errorMessage: error instanceof Error ? error.message : String(error),
        }
      }
    },
    args: [requestUrl],
  })

  const payload = result as { ok?: boolean; status?: number; json?: unknown; errorMessage?: string } | undefined
  return {
    ok: !!payload?.ok,
    status: Number(payload?.status ?? 0),
    json: payload?.json ?? null,
    errorMessage: payload?.errorMessage || undefined,
  }
}

function buildConfluenceNodesFromApiRecords(
  records: Map<string, ConfluenceApiPageRecord>,
  maxDepth: number
): { pages: ConfluencePageNode[]; skipped: number } {
  const depthCache = new Map<string, number>()
  const titleBreadcrumbCache = new Map<string, string[]>()

  const resolveDepth = (sourceId: string, stack = new Set<string>()): number => {
    const cached = depthCache.get(sourceId)
    if (typeof cached === "number") return cached

    const node = records.get(sourceId)
    if (!node?.parentSourceId || !records.has(node.parentSourceId)) {
      depthCache.set(sourceId, 0)
      return 0
    }
    if (stack.has(sourceId)) {
      depthCache.set(sourceId, 0)
      return 0
    }

    stack.add(sourceId)
    const depth = resolveDepth(node.parentSourceId, stack) + 1
    stack.delete(sourceId)
    depthCache.set(sourceId, depth)
    return depth
  }

  const resolveBreadcrumbs = (sourceId: string): string[] => {
    const cached = titleBreadcrumbCache.get(sourceId)
    if (cached) return cached

    const chain: string[] = []
    let current = records.get(sourceId)
    const seen = new Set<string>()

    while (current?.parentSourceId) {
      const parent = records.get(current.parentSourceId)
      if (!parent || seen.has(parent.sourceId)) break
      chain.unshift(parent.title)
      seen.add(parent.sourceId)
      current = parent
    }

    titleBreadcrumbCache.set(sourceId, chain)
    return chain
  }

  const pages: ConfluencePageNode[] = []
  let skipped = 0

  const ordered = Array.from(records.values()).sort((a, b) => {
    const depthA = resolveDepth(a.sourceId)
    const depthB = resolveDepth(b.sourceId)
    if (depthA !== depthB) return depthA - depthB
    return a.title.localeCompare(b.title)
  })

  for (const item of ordered) {
    const depth = resolveDepth(item.sourceId)
    if (depth > maxDepth) {
      skipped += 1
      continue
    }

    const parentId = item.parentSourceId && records.has(item.parentSourceId)
      ? buildConfluenceNodeIdFromSourceId(item.parentSourceId)
      : undefined

    pages.push({
      id: buildConfluenceNodeIdFromSourceId(item.sourceId),
      url: item.url,
      title: item.title,
      breadcrumbs: resolveBreadcrumbs(item.sourceId),
      depth,
      parentId,
    })
  }

  return { pages, skipped }
}

async function scanConfluenceSpaceViaApiV2(
  tabId: number,
  seed: { spaceUrl: string; origin: string; spaceKey: string },
  options: { maxPages: number; maxDepth: number }
): Promise<{ pages: ConfluencePageNode[]; skipped: number }> {
  const spacesUrl = `${seed.origin}/wiki/api/v2/spaces?keys=${encodeURIComponent(seed.spaceKey)}&limit=10`
  const spacesResponse = await confluenceApiFetchJsonInTab(tabId, spacesUrl)
  if (!spacesResponse.ok) {
    throw new Error(
      `Confluence API v2 spaces request failed (${spacesResponse.status}): ${spacesResponse.errorMessage || "unknown error"}`
    )
  }

  const spacesPayload = spacesResponse.json as
    | { results?: Array<{ id?: unknown; key?: unknown }>; _links?: { base?: string } }
    | null
    | undefined
  const spaces = Array.isArray(spacesPayload?.results) ? spacesPayload.results : []
  const space = spaces.find(
    (item) => normalizeSpaceKey(String(item?.key ?? "")) === normalizeSpaceKey(seed.spaceKey)
  ) || spaces[0]

  const spaceId = String(space?.id ?? "").trim()
  if (!spaceId) {
    throw new Error(`Confluence API v2 cannot resolve space id for key "${seed.spaceKey}"`)
  }

  const records = new Map<string, ConfluenceApiPageRecord>()
  let skipped = 0
  let nextUrl: string | null =
    `${seed.origin}/wiki/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&status=current&limit=${CONFLUENCE_API_PAGE_LIMIT}`

  while (nextUrl && records.size < options.maxPages) {
    throwIfConfluenceCancelled()
    await waitIfConfluencePaused()

    const response = await confluenceApiFetchJsonInTab(tabId, nextUrl)
    if (!response.ok) {
      throw new Error(
        `Confluence API v2 pages request failed (${response.status}): ${response.errorMessage || "unknown error"}`
      )
    }

    const payload = response.json as
      | {
          results?: Array<{
            id?: unknown
            title?: unknown
            parentId?: unknown
            _links?: { webui?: unknown }
          }>
          _links?: { next?: unknown; base?: string }
        }
      | null
      | undefined
    const items = Array.isArray(payload?.results) ? payload.results : []

    for (const item of items) {
      const sourceId = String(item?.id ?? "").trim()
      if (!sourceId) {
        skipped += 1
        continue
      }

      if (records.has(sourceId)) {
        skipped += 1
        continue
      }
      if (records.size >= options.maxPages) {
        skipped += 1
        continue
      }

      const webui = typeof item?._links?.webui === "string" ? item._links.webui : ""
      const fallbackUrl = `${seed.origin}/wiki/spaces/${encodeURIComponent(seed.spaceKey)}/pages/${encodeURIComponent(sourceId)}`
      const pageUrl = resolveConfluenceApiUrl(webui, seed.origin, payload?._links?.base) || fallbackUrl

      records.set(sourceId, {
        sourceId,
        title: String(item?.title ?? sourceId).trim() || sourceId,
        url: pageUrl,
        parentSourceId: item?.parentId ? String(item.parentId) : undefined,
      })
    }

    nextUrl = resolveConfluenceApiUrl(
      typeof payload?._links?.next === "string" ? payload._links.next : "",
      seed.origin,
      payload?._links?.base
    )

    updateConfluenceProgress({
      stage: "scan",
      status: confluenceJobState.paused ? "paused" : "running",
      spaceKey: seed.spaceKey,
      spaceUrl: seed.spaceUrl,
      processed: records.size,
      total: Math.min(options.maxPages, records.size + (nextUrl ? CONFLUENCE_API_PAGE_LIMIT : 0)),
      queued: nextUrl ? 1 : 0,
      scanned: records.size,
      exported: 0,
      skipped,
      failed: 0,
      currentUrl: nextUrl || undefined,
    })
  }

  const built = buildConfluenceNodesFromApiRecords(records, options.maxDepth)
  return { pages: built.pages, skipped: skipped + built.skipped }
}

async function scanConfluenceSpaceViaApiV1(
  tabId: number,
  seed: { spaceUrl: string; origin: string; spaceKey: string },
  options: { maxPages: number; maxDepth: number }
): Promise<{ pages: ConfluencePageNode[]; skipped: number }> {
  const cql = `space="${seed.spaceKey}" and type=page and status=current`
  let nextUrl: string | null =
    `${seed.origin}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${CONFLUENCE_API_V1_PAGE_LIMIT}&expand=ancestors`

  const records = new Map<string, ConfluenceApiPageRecord>()
  let skipped = 0

  while (nextUrl && records.size < options.maxPages) {
    throwIfConfluenceCancelled()
    await waitIfConfluencePaused()

    const response = await confluenceApiFetchJsonInTab(tabId, nextUrl)
    if (!response.ok) {
      throw new Error(
        `Confluence API v1 content search failed (${response.status}): ${response.errorMessage || "unknown error"}`
      )
    }

    const payload = response.json as
      | {
          results?: Array<{
            id?: unknown
            title?: unknown
            ancestors?: Array<{ id?: unknown; title?: unknown }>
            _links?: { webui?: unknown }
            content?: {
              id?: unknown
              title?: unknown
              ancestors?: Array<{ id?: unknown; title?: unknown }>
              _links?: { webui?: unknown }
            }
          }>
          _links?: { next?: unknown; base?: string }
        }
      | null
      | undefined
    const items = Array.isArray(payload?.results) ? payload.results : []

    for (const item of items) {
      const content = item?.content && typeof item.content === "object" ? item.content : item
      const sourceId = String(content?.id ?? "").trim()
      if (!sourceId) {
        skipped += 1
        continue
      }
      if (records.has(sourceId)) {
        skipped += 1
        continue
      }
      if (records.size >= options.maxPages) {
        skipped += 1
        continue
      }

      const ancestors = Array.isArray(content?.ancestors) ? content.ancestors : []
      const parentSourceId = ancestors.length > 0 ? String(ancestors[ancestors.length - 1]?.id ?? "").trim() : ""

      const webui = typeof content?._links?.webui === "string" ? content._links.webui : ""
      const fallbackUrl = `${seed.origin}/wiki/spaces/${encodeURIComponent(seed.spaceKey)}/pages/${encodeURIComponent(sourceId)}`
      const pageUrl = resolveConfluenceApiUrl(webui, seed.origin, payload?._links?.base) || fallbackUrl

      records.set(sourceId, {
        sourceId,
        title: String(content?.title ?? sourceId).trim() || sourceId,
        url: pageUrl,
        parentSourceId: parentSourceId || undefined,
      })
    }

    nextUrl = resolveConfluenceApiUrl(
      typeof payload?._links?.next === "string" ? payload._links.next : "",
      seed.origin,
      payload?._links?.base
    )

    updateConfluenceProgress({
      stage: "scan",
      status: confluenceJobState.paused ? "paused" : "running",
      spaceKey: seed.spaceKey,
      spaceUrl: seed.spaceUrl,
      processed: records.size,
      total: Math.min(options.maxPages, records.size + (nextUrl ? CONFLUENCE_API_V1_PAGE_LIMIT : 0)),
      queued: nextUrl ? 1 : 0,
      scanned: records.size,
      exported: 0,
      skipped,
      failed: 0,
      currentUrl: nextUrl || undefined,
    })
  }

  const built = buildConfluenceNodesFromApiRecords(records, options.maxDepth)
  return { pages: built.pages, skipped: skipped + built.skipped }
}

async function scanConfluenceSpaceViaApi(
  seed: { spaceUrl: string; origin: string; spaceKey: string },
  options: { maxPages: number; maxDepth: number }
): Promise<{
  pages: ConfluencePageNode[]
  skipped: number
  failures: ConfluenceScanResult["failures"]
  mode: "api-v2" | "api-v1" | "none"
}> {
  const failures: ConfluenceScanResult["failures"] = []
  let tabId: number | undefined

  try {
    tabId = await openHiddenTab(seed.spaceUrl)

    try {
      const v2 = await withConfluenceRetry(() => scanConfluenceSpaceViaApiV2(tabId!, seed, options))
      if (v2.pages.length > 0) {
        return { pages: v2.pages, skipped: v2.skipped, failures, mode: "api-v2" }
      }
      failures.push({
        url: seed.spaceUrl,
        error: toError("confluence-scan-failed", "Confluence API v2 returned no pages"),
      })
    } catch (error) {
      failures.push({
        url: seed.spaceUrl,
        error: toError(
          "confluence-scan-failed",
          error instanceof Error ? `[API v2] ${error.message}` : "[API v2] Confluence scan failed"
        ),
      })
    }

    try {
      const v1 = await withConfluenceRetry(() => scanConfluenceSpaceViaApiV1(tabId!, seed, options))
      if (v1.pages.length > 0) {
        return { pages: v1.pages, skipped: v1.skipped, failures, mode: "api-v1" }
      }
      failures.push({
        url: seed.spaceUrl,
        error: toError("confluence-scan-failed", "Confluence API v1 returned no pages"),
      })
    } catch (error) {
      failures.push({
        url: seed.spaceUrl,
        error: toError(
          "confluence-scan-failed",
          error instanceof Error ? `[API v1] ${error.message}` : "[API v1] Confluence scan failed"
        ),
      })
    }

    return { pages: [], skipped: 0, failures, mode: "none" }
  } finally {
    await closeTabSafe(tabId)
  }
}

async function scanConfluencePage(tabId: number): Promise<{
  title: string
  url: string
  links: string[]
  breadcrumbs: string[]
}> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const toAbs = (value: string) => {
        try {
          return new URL(value, location.href).href
        } catch {
          return ""
        }
      }

      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        document.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
        document.title ||
        "Untitled Confluence page"

      const breadcrumbSelectors = [
        "nav[aria-label*='breadcrumb'] a",
        "[data-testid*='breadcrumb'] a",
        ".aui-nav-breadcrumbs a",
      ]
      const breadcrumbSet = new Set<string>()
      for (const selector of breadcrumbSelectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          const value = node.textContent?.trim()
          if (value) breadcrumbSet.add(value)
        }
      }

      const linkSet = new Set<string>()
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (anchor as HTMLAnchorElement).getAttribute("href") || ""
        const abs = toAbs(href)
        if (!abs) continue
        if (abs.startsWith("http://") || abs.startsWith("https://")) {
          if (abs.includes("/wiki/") || abs.includes("/display/")) {
            linkSet.add(abs)
          }
        }
      }

      const canonical =
        document.querySelector("meta[property='og:url']")?.getAttribute("content") ||
        document.querySelector("link[rel='canonical']")?.getAttribute("href") ||
        location.href

      return {
        title,
        url: toAbs(canonical) || location.href,
        links: Array.from(linkSet).slice(0, 400),
        breadcrumbs: Array.from(breadcrumbSet),
      }
    },
  })

  const payload = result as {
    title?: string
    url?: string
    links?: string[]
    breadcrumbs?: string[]
  } | undefined

  return {
    title: payload?.title?.trim() || "Untitled Confluence page",
    url: payload?.url || "",
    links: Array.isArray(payload?.links) ? payload.links : [],
    breadcrumbs: Array.isArray(payload?.breadcrumbs) ? payload.breadcrumbs : [],
  }
}

async function scanConfluencePageByUrl(url: string): Promise<{
  title: string
  url: string
  links: string[]
  breadcrumbs: string[]
}> {
  let tabId: number | undefined
  try {
    tabId = await openHiddenTab(url)
    return await scanConfluencePage(tabId)
  } finally {
    await closeTabSafe(tabId)
  }
}

async function scanConfluenceSpace(
  input: string,
  options: { maxPages: number; maxDepth: number }
): Promise<ConfluenceScanResult> {
  const seed = await resolveConfluenceSeed(input)
  const apiScan = await scanConfluenceSpaceViaApi(seed, options)
  if (apiScan.pages.length > 0) {
    const result: ConfluenceScanResult = {
      spaceKey: seed.spaceKey,
      spaceUrl: seed.spaceUrl,
      pages: apiScan.pages,
      scanned: apiScan.pages.length,
      skipped: apiScan.skipped,
      failed: 0,
      failures: [],
      generatedAt: new Date().toISOString(),
    }
    await writeConfluenceScanDebugLog(apiScan.mode === "api-v1" ? "api-v1" : "api-v2", seed, {
      scanned: result.scanned,
      skipped: result.skipped,
      failures: [],
    })
    return result
  }

  const apiFailures = apiScan.failures
  const queue: Array<{ url: string; depth: number; parentUrl?: string }> = [{ url: seed.spaceUrl, depth: 0 }]
  const queued = new Set([seed.spaceUrl])
  const visited = new Set<string>()
  const pages = new Map<string, ConfluencePageNode>()
  const failures: ConfluenceScanResult["failures"] = []
  let skipped = 0
  let iteration = 0

  while (queue.length > 0 && pages.size < options.maxPages) {
    throwIfConfluenceCancelled()
    await waitIfConfluencePaused()
    await applyConfluenceRateLimit(iteration)

    const current = queue.shift()
    iteration += 1
    if (!current) break
    queued.delete(current.url)

    updateConfluenceProgress({
      stage: "scan",
      status: confluenceJobState.paused ? "paused" : "running",
      spaceKey: seed.spaceKey,
      spaceUrl: seed.spaceUrl,
      processed: pages.size + failures.length,
      total: Math.min(options.maxPages, pages.size + failures.length + queue.length + 1),
      queued: queue.length + 1,
      scanned: pages.size,
      exported: 0,
      skipped,
      failed: failures.length,
      currentUrl: current.url,
    })

    const normalizedCurrent = cleanConfluenceUrl(current.url)
    if (visited.has(normalizedCurrent)) {
      skipped += 1
      updateConfluenceProgress({
        stage: "scan",
        status: "running",
        spaceKey: seed.spaceKey,
        spaceUrl: seed.spaceUrl,
        processed: pages.size + failures.length,
        total: Math.min(options.maxPages, pages.size + failures.length + queue.length),
        queued: queue.length,
        scanned: pages.size,
        exported: 0,
        skipped,
        failed: failures.length,
      })
      continue
    }
    visited.add(normalizedCurrent)

    try {
      const snapshot = await withConfluenceRetry(() => scanConfluencePageByUrl(normalizedCurrent))
      const pageUrl = cleanConfluenceUrl(snapshot.url || normalizedCurrent)
      const parentId = current.parentUrl ? buildPageNodeId(cleanConfluenceUrl(current.parentUrl)) : undefined

      if (!pages.has(pageUrl)) {
        pages.set(pageUrl, {
          id: buildPageNodeId(pageUrl),
          url: pageUrl,
          title: snapshot.title || pageUrl,
          breadcrumbs: snapshot.breadcrumbs,
          depth: current.depth,
          parentId,
        })
      } else {
        const existingNode = pages.get(pageUrl)
        if (existingNode && !existingNode.parentId && parentId) {
          pages.set(pageUrl, { ...existingNode, parentId })
        }
        skipped += 1
      }

      if (current.depth >= options.maxDepth) {
        continue
      }

      for (const rawLink of snapshot.links) {
        if (!rawLink) continue
        let nextUrl: string
        try {
          nextUrl = cleanConfluenceUrl(rawLink)
        } catch {
          skipped += 1
          continue
        }

        if (!isConfluenceCandidateUrl(nextUrl, seed.origin, seed.spaceKey)) {
          skipped += 1
          continue
        }
        if (visited.has(nextUrl) || queued.has(nextUrl)) {
          skipped += 1
          continue
        }
        queue.push({ url: nextUrl, depth: current.depth + 1, parentUrl: pageUrl })
        queued.add(nextUrl)
      }

      updateConfluenceProgress({
        stage: "scan",
        status: "running",
        spaceKey: seed.spaceKey,
        spaceUrl: seed.spaceUrl,
        processed: pages.size + failures.length,
        total: Math.min(options.maxPages, pages.size + failures.length + queue.length),
        queued: queue.length,
        scanned: pages.size,
        exported: 0,
        skipped,
        failed: failures.length,
        currentUrl: pageUrl,
        currentTitle: snapshot.title || pageUrl,
      })
    } catch (error) {
      failures.push({
        url: normalizedCurrent,
        error: toError(
          "confluence-scan-failed",
          error instanceof Error ? error.message : "Failed to scan page"
        ),
      })

      updateConfluenceProgress({
        stage: "scan",
        status: "running",
        spaceKey: seed.spaceKey,
        spaceUrl: seed.spaceUrl,
        processed: pages.size + failures.length,
        total: Math.min(options.maxPages, pages.size + failures.length + queue.length),
        queued: queue.length,
        scanned: pages.size,
        exported: 0,
        skipped,
        failed: failures.length,
        currentUrl: normalizedCurrent,
        message: error instanceof Error ? error.message : "Failed to scan page",
      })
    }
  }

  const finalFailures = pages.size > 0 ? failures : [...apiFailures, ...failures]
  const result: ConfluenceScanResult = {
    spaceKey: seed.spaceKey,
    spaceUrl: seed.spaceUrl,
    pages: Array.from(pages.values()),
    scanned: pages.size,
    skipped,
    failed: finalFailures.length,
    failures: finalFailures,
    generatedAt: new Date().toISOString(),
  }
  await writeConfluenceScanDebugLog("dom-fallback", seed, {
    scanned: result.scanned,
    skipped: result.skipped,
    failures: result.failures,
  })
  return result
}

function ensureUniqueConfluenceMarkdownPath(initialPath: string, usedPaths: Set<string>): string {
  if (!usedPaths.has(initialPath)) {
    usedPaths.add(initialPath)
    return initialPath
  }

  const parts = initialPath.split("/")
  const fileName = parts.pop() || "page.md"
  const dotIndex = fileName.lastIndexOf(".")
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName
  const ext = dotIndex > 0 ? fileName.slice(dotIndex) : ".md"

  for (let index = 2; index < 1000; index++) {
    const nextName = `${stem}-${index}${ext}`
    const nextPath = parts.length > 0 ? `${parts.join("/")}/${nextName}` : nextName
    if (!usedPaths.has(nextPath)) {
      usedPaths.add(nextPath)
      return nextPath
    }
  }

  const fallbackName = `${stem}-${Date.now()}${ext}`
  const fallbackPath = parts.length > 0 ? `${parts.join("/")}/${fallbackName}` : fallbackName
  usedPaths.add(fallbackPath)
  return fallbackPath
}

function buildConfluencePagePathMap(pages: ConfluencePageNode[]): Map<string, string> {
  const pagesById = new Map(pages.map((page) => [page.id, page]))
  const folderCache = new Map<string, string[]>()

  const resolveParentFolders = (pageId: string, stack = new Set<string>()): string[] => {
    const cached = folderCache.get(pageId)
    if (cached) return cached

    const page = pagesById.get(pageId)
    if (!page || !page.parentId) {
      folderCache.set(pageId, [])
      return []
    }
    if (stack.has(pageId)) {
      folderCache.set(pageId, [])
      return []
    }

    const parent = pagesById.get(page.parentId)
    if (!parent) {
      folderCache.set(pageId, [])
      return []
    }

    stack.add(pageId)
    const parentFolders = resolveParentFolders(parent.id, stack)
    stack.delete(pageId)

    const currentFolders = [...parentFolders, sanitizePathSegment(parent.title, parent.id)]
    folderCache.set(pageId, currentFolders)
    return currentFolders
  }

  const pathByPageId = new Map<string, string>()
  const usedPaths = new Set<string>()
  const orderedPages = pages
    .slice()
    .sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))

  for (const page of orderedPages) {
    const folderParts = resolveParentFolders(page.id)
    const titlePart = sanitizePathSegment(page.title, page.id)
    const basePath = [...folderParts, `${titlePart}.md`].join("/")
    const uniquePath = ensureUniqueConfluenceMarkdownPath(basePath || `${page.id}.md`, usedPaths)
    pathByPageId.set(page.id, uniquePath)
  }

  return pathByPageId
}

function resolveConfluencePagePath(page: ConfluencePageNode, pagePathById: Map<string, string>): string {
  return pagePathById.get(page.id) || `${sanitizePathSegment(page.title, page.id)}.md`
}

async function collectConfluenceAttachmentUrls(tabId: number): Promise<string[]> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const toAbs = (value: string) => {
        try {
          return new URL(value, location.href).href
        } catch {
          return ""
        }
      }

      const links = new Set<string>()
      for (const node of Array.from(document.querySelectorAll("img[src]"))) {
        const src = (node as HTMLImageElement).getAttribute("src") || ""
        const abs = toAbs(src)
        if (abs) links.add(abs)
      }

      for (const node of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (node as HTMLAnchorElement).getAttribute("href") || ""
        if (!href) continue
        if (!/download\/attachments|attachment|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.svg$|\.pdf$|\.docx?$|\.xlsx?$|\.pptx?$/i.test(href)) {
          continue
        }
        const abs = toAbs(href)
        if (abs) links.add(abs)
      }

      return Array.from(links)
    },
  })

  const links = (Array.isArray(result) ? result : []) as string[]
  return links.filter((value) => !!value).slice(0, CONFLUENCE_ATTACHMENTS_PER_PAGE)
}

async function fetchAttachmentsInTab(
  tabId: number,
  urls: string[]
): Promise<Array<{ sourceUrl: string; fileName: string; contentType: string; base64: string; size: number }>> {
  if (urls.length === 0) return []

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (targets: string[], maxBytes: number) => {
      const toName = (urlValue: string) => {
        try {
          const parsed = new URL(urlValue)
          const filename = decodeURIComponent(parsed.pathname.split("/").pop() || "file.bin")
          return filename || "file.bin"
        } catch {
          return "file.bin"
        }
      }

      const readAsBase64 = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const value = String(reader.result || "")
            const base64 = value.includes(",") ? value.split(",")[1] : ""
            resolve(base64)
          }
          reader.onerror = () => reject(new Error("Failed to read blob"))
          reader.readAsDataURL(blob)
        })

      const out: Array<{ sourceUrl: string; fileName: string; contentType: string; base64: string; size: number }> = []
      for (const target of targets) {
        try {
          const response = await fetch(target, { credentials: "include" })
          if (!response.ok) continue
          const blob = await response.blob()
          if (blob.size <= 0 || blob.size > maxBytes) continue
          const base64 = await readAsBase64(blob)
          if (!base64) continue
          out.push({
            sourceUrl: target,
            fileName: toName(target),
            contentType: response.headers.get("content-type") || "application/octet-stream",
            base64,
            size: blob.size,
          })
        } catch {
          // Ignore individual attachment fetch failures.
        }
      }
      return out
    },
    args: [urls, CONFLUENCE_ATTACHMENT_MAX_BYTES],
  })

  return (Array.isArray(result) ? result : []) as Array<{
    sourceUrl: string
    fileName: string
    contentType: string
    base64: string
    size: number
  }>
}

function normalizeComparableAttachmentUrl(value: string): string {
  try {
    return cleanConfluenceUrl(new URL(value).toString())
  } catch {
    return value.trim()
  }
}

function splitMarkdownLinkTarget(target: string): { urlPart: string; suffix: string; wrapped: boolean } | null {
  const body = target.trim()
  if (!body) return null

  if (body.startsWith("<")) {
    const closeIndex = body.indexOf(">")
    if (closeIndex > 1) {
      return {
        urlPart: body.slice(1, closeIndex),
        suffix: body.slice(closeIndex + 1),
        wrapped: true,
      }
    }
  }

  const match = body.match(/^(\S+)([\s\S]*)$/)
  if (!match) return null
  return {
    urlPart: match[1],
    suffix: match[2],
    wrapped: false,
  }
}

function resolveAttachmentRewriteUrl(urlPart: string, rewriteMap: Map<string, string>): string | null {
  const direct = rewriteMap.get(urlPart) || rewriteMap.get(normalizeComparableAttachmentUrl(urlPart))
  if (direct) return direct
  try {
    const decoded = decodeURIComponent(urlPart)
    if (decoded !== urlPart) {
      return rewriteMap.get(decoded) || rewriteMap.get(normalizeComparableAttachmentUrl(decoded)) || null
    }
  } catch {
    // Ignore malformed uri components.
  }
  return null
}

function rewriteAttachmentUrls(markdown: string, rewrites: Array<{ sourceUrl: string; localUrl: string }>): string {
  if (!markdown || rewrites.length === 0) return markdown

  const rewriteMap = new Map<string, string>()
  for (const rule of rewrites) {
    rewriteMap.set(rule.sourceUrl, rule.localUrl)
    rewriteMap.set(normalizeComparableAttachmentUrl(rule.sourceUrl), rule.localUrl)
  }

  let updated = markdown.replace(/(!?\[[^\]]*]\()([^)]+)(\))/g, (full, prefix, target, suffix) => {
    const parts = splitMarkdownLinkTarget(String(target))
    if (!parts) return full
    const replacement = resolveAttachmentRewriteUrl(parts.urlPart, rewriteMap)
    if (!replacement) return full

    const nextTarget = parts.wrapped
      ? `<${replacement}>${parts.suffix}`
      : `${replacement}${parts.suffix}`
    return `${prefix}${nextTarget}${suffix}`
  })

  // Also rewrite markdown reference-style targets: [id]: https://...
  updated = updated.replace(/^(\[[^\]]+]:\s*)(\S+)(.*)$/gm, (full, prefix, target, suffix) => {
    const replacement = resolveAttachmentRewriteUrl(String(target), rewriteMap)
    if (!replacement) return full
    return `${prefix}${replacement}${suffix}`
  })

  return updated
}

type ConfluencePageBlockReason = "no-access" | "not-found"

async function detectConfluencePageBlock(tabId: number): Promise<ConfluencePageBlockReason | null> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (): "no-access" | "not-found" | null => {
        const text = (document.body?.innerText || "").toLowerCase()
        const title = (document.title || "").toLowerCase()

        // 404 / page-not-found errors (Atlassian Cloud "Page Unavailable" notification)
        if (
          title.includes("page unavailable") ||
          title.includes("page not found") ||
          text.includes("page not found") ||
          text.includes("page unavailable") ||
          (text.includes("404") && (text.includes("request id") || text.includes("not found")))
        ) {
          return "not-found"
        }

        // Permission / access errors
        if (
          text.includes("you don't have access") ||
          text.includes("you do not have access") ||
          text.includes("you don't have permission") ||
          text.includes("you do not have permission") ||
          text.includes("request access") ||
          text.includes("access denied") ||
          text.includes("insufficient permissions")
        ) {
          return "no-access"
        }

        return null
      },
    })
    return (result as ConfluencePageBlockReason | null | undefined) ?? null
  } catch {
    return null
  }
}

function buildFailedPageResult(
  page: ConfluencePageNode,
  error: ExtractionErrorDetails,
  pagePath: string
): ConfluenceExportPageResult {
  return {
    pageId: page.id,
    title: page.title,
    url: page.url,
    breadcrumbs: page.breadcrumbs,
    path: pagePath,
    markdown: "",
    attachments: 0,
    status: "failed",
    error,
  }
}

function buildSkippedPageResult(
  page: ConfluencePageNode,
  reason: ConfluenceExportPageResult["skipReason"],
  error?: ExtractionErrorDetails,
  pagePath?: string
): ConfluenceExportPageResult {
  return {
    pageId: page.id,
    title: page.title,
    url: page.url,
    breadcrumbs: page.breadcrumbs,
    path: pagePath || `${sanitizePathSegment(page.title, page.id)}.md`,
    markdown: "",
    attachments: 0,
    status: "skipped",
    skipReason: reason,
    error,
  }
}

function ensureUniqueAttachmentFileName(fileName: string, usedNames: Set<string>, fallback: string): string {
  const safeBase = sanitizePathSegment(fileName, fallback)
  if (!usedNames.has(safeBase)) {
    usedNames.add(safeBase)
    return safeBase
  }

  const dotIndex = safeBase.lastIndexOf(".")
  const stem = dotIndex > 0 ? safeBase.slice(0, dotIndex) : safeBase
  const ext = dotIndex > 0 ? safeBase.slice(dotIndex) : ""
  for (let index = 2; index < 1000; index++) {
    const nextName = `${stem}-${index}${ext}`
    if (!usedNames.has(nextName)) {
      usedNames.add(nextName)
      return nextName
    }
  }

  const fallbackName = `${stem}-${Date.now()}${ext}`
  usedNames.add(fallbackName)
  return fallbackName
}

async function exportConfluencePageOnce(page: ConfluencePageNode, pagePath: string): Promise<{
  pageResult: ConfluenceExportPageResult
  attachments: ConfluenceAttachmentFile[]
}> {
  let tabId: number | undefined
  try {
    tabId = await openHiddenTab(page.url)

    const blockReason = await detectConfluencePageBlock(tabId)
    if (blockReason === "no-access") {
      return {
        pageResult: buildSkippedPageResult(
          page,
          "no-access",
          toError("confluence-no-access", "No access to this Confluence page"),
          pagePath
        ),
        attachments: [],
      }
    }
    if (blockReason === "not-found") {
      return {
        pageResult: buildSkippedPageResult(
          page,
          "not-found",
          toError("confluence-no-access", "Page not found or unavailable (404)"),
          pagePath
        ),
        attachments: [],
      }
    }

    const extraction = await injectAndExtract(tabId, "article", {
      saveToHistory: false,
      allowFallback: true,
    })
    if ("error" in extraction) {
      return {
        pageResult: buildFailedPageResult(page, extraction.error, pagePath),
        attachments: [],
      }
    }

    let markdown = extraction.data.markdown
    const pageDir = pagePath.includes("/") ? pagePath.split("/").slice(0, -1).join("/") : ""

    const attachmentUrls = await withConfluenceRetry(() => collectConfluenceAttachmentUrls(tabId!))
    const fetchedAttachments = await withConfluenceRetry(() => fetchAttachmentsInTab(tabId!, attachmentUrls))
    const rewrites: Array<{ sourceUrl: string; localUrl: string }> = []
    const pageAttachments: ConfluenceAttachmentFile[] = []
    const usedAttachmentNames = new Set<string>()

    for (let index = 0; index < fetchedAttachments.length; index++) {
      const file = fetchedAttachments[index]
      const fileName = ensureUniqueAttachmentFileName(file.fileName, usedAttachmentNames, `attachment-${index + 1}.bin`)
      const attachmentDir = pageDir ? `${pageDir}/_attachments` : "_attachments"
      const localPath = `${attachmentDir}/${fileName}`
      const localUrl = `./_attachments/${fileName}`

      pageAttachments.push({
        id: generateId(),
        pageId: page.id,
        sourceUrl: file.sourceUrl,
        fileName,
        localPath,
        contentType: file.contentType,
        base64: file.base64,
        size: file.size,
      })

      rewrites.push({ sourceUrl: file.sourceUrl, localUrl })
    }

    markdown = rewriteAttachmentUrls(markdown, rewrites)

    return {
      pageResult: {
        pageId: page.id,
        title: extraction.data.title || page.title,
        url: extraction.data.url || page.url,
        breadcrumbs: page.breadcrumbs,
        path: pagePath,
        markdown,
        attachments: rewrites.length,
        status: "exported",
      },
      attachments: pageAttachments,
    }
  } finally {
    await closeTabSafe(tabId)
  }
}

async function exportConfluenceSpace(
  scan: ConfluenceScanResult,
  options: { resume: boolean; selectedPageIds?: Set<string> }
): Promise<ConfluenceExportResult> {
  const selectedIds = options.selectedPageIds
  const targetPages = selectedIds ? scan.pages.filter((page) => selectedIds.has(page.id)) : scan.pages
  if (targetPages.length === 0) {
    throw new Error("No pages selected for export")
  }

  const exportScan: ConfluenceScanResult =
    targetPages.length === scan.pages.length
      ? scan
      : {
          ...scan,
          pages: targetPages,
          scanned: targetPages.length,
          skipped: 0,
          failed: 0,
          failures: [],
        }

  const checkpoint = await prepareConfluenceCheckpoint(exportScan, options.resume)
  const targetPageIdSet = new Set(targetPages.map((page) => page.id))
  const pagesById = new Map<string, ConfluenceExportPageResult>(
    checkpoint.pages
      .filter((page) => targetPageIdSet.has(page.pageId))
      .map((page) => [page.pageId, page])
  )
  let attachments = checkpoint.attachments.filter((item) => targetPageIdSet.has(item.pageId))
  const seenPageUrls = new Set<string>()
  const pagePathById = buildConfluencePagePathMap(scan.pages)

  for (const page of targetPages) {
    const existing = pagesById.get(page.id)
    if (existing) {
      existing.path = resolveConfluencePagePath(page, pagePathById)
    }
  }

  for (const existingPage of pagesById.values()) {
    if (existingPage.status === "exported" || existingPage.status === "skipped") {
      try {
        seenPageUrls.add(cleanConfluenceUrl(existingPage.url))
      } catch {
        // Keep going.
      }
    }
  }

  for (let index = 0; index < targetPages.length; index++) {
    const page = targetPages[index]
    const pagePath = resolveConfluencePagePath(page, pagePathById)

    updateConfluenceProgress({
      stage: "export",
      status: confluenceJobState.paused ? "paused" : "running",
      spaceKey: scan.spaceKey,
      spaceUrl: scan.spaceUrl,
      processed: index,
      total: targetPages.length,
      queued: Math.max(0, targetPages.length - index),
      scanned: scan.scanned,
      exported: pagesById.size > 0 ? Array.from(pagesById.values()).filter((item) => item.status === "exported").length : 0,
      skipped: pagesById.size > 0 ? Array.from(pagesById.values()).filter((item) => item.status === "skipped").length : 0,
      failed: pagesById.size > 0 ? Array.from(pagesById.values()).filter((item) => item.status === "failed").length : 0,
      currentUrl: page.url,
      currentTitle: page.title,
    })

    throwIfConfluenceCancelled()
    await waitIfConfluencePaused()
    await applyConfluenceRateLimit(index)

    const existing = pagesById.get(page.id)
    if (existing && (existing.status === "exported" || existing.status === "skipped")) {
      continue
    }

    const normalizedPageUrl = cleanConfluenceUrl(page.url)
    if (seenPageUrls.has(normalizedPageUrl)) {
      pagesById.set(page.id, buildSkippedPageResult(page, "duplicate", undefined, pagePath))
      checkpoint.pages = withCheckpointPageOrder(exportScan, pagesById)
      checkpoint.nextPageIndex = index + 1
      checkpoint.updatedAt = new Date().toISOString()
      await saveConfluenceCheckpoint(checkpoint)
      updateConfluenceProgress({
        stage: "export",
        status: "running",
        spaceKey: scan.spaceKey,
        spaceUrl: scan.spaceUrl,
        processed: index + 1,
        total: targetPages.length,
        queued: Math.max(0, targetPages.length - (index + 1)),
        scanned: scan.scanned,
        exported: Array.from(pagesById.values()).filter((item) => item.status === "exported").length,
        skipped: Array.from(pagesById.values()).filter((item) => item.status === "skipped").length,
        failed: Array.from(pagesById.values()).filter((item) => item.status === "failed").length,
        currentUrl: page.url,
        currentTitle: page.title,
      })
      continue
    }
    seenPageUrls.add(normalizedPageUrl)

    try {
      const pageAttempt = await withConfluenceRetry(() => exportConfluencePageOnce(page, pagePath))
      pagesById.set(page.id, pageAttempt.pageResult)
      attachments = mergeAttachment(attachments, pageAttempt.attachments)
    } catch (error) {
      pagesById.set(
        page.id,
        buildFailedPageResult(
          page,
          toError(
            "confluence-export-failed",
            error instanceof Error ? error.message : "Confluence export failed for page"
          ),
          pagePath
        )
      )
    }

    checkpoint.pages = withCheckpointPageOrder(exportScan, pagesById)
    checkpoint.attachments = attachments
    checkpoint.nextPageIndex = index + 1
    checkpoint.updatedAt = new Date().toISOString()
    await saveConfluenceCheckpoint(checkpoint)

    updateConfluenceProgress({
      stage: "export",
      status: "running",
      spaceKey: scan.spaceKey,
      spaceUrl: scan.spaceUrl,
      processed: index + 1,
      total: targetPages.length,
      queued: Math.max(0, targetPages.length - (index + 1)),
      scanned: scan.scanned,
      exported: Array.from(pagesById.values()).filter((item) => item.status === "exported").length,
      skipped: Array.from(pagesById.values()).filter((item) => item.status === "skipped").length,
      failed: Array.from(pagesById.values()).filter((item) => item.status === "failed").length,
      currentUrl: page.url,
      currentTitle: page.title,
    })
  }

  const finalPages = withCheckpointPageOrder(exportScan, pagesById)
  const finalResult: ConfluenceExportResult = {
    spaceKey: scan.spaceKey,
    spaceUrl: scan.spaceUrl,
    pages: finalPages,
    attachments,
    exported: finalPages.filter((page) => page.status === "exported").length,
    skipped: finalPages.filter((page) => page.status === "skipped").length,
    failed: finalPages.filter((page) => page.status === "failed").length,
    generatedAt: new Date().toISOString(),
  }

  checkpoint.scan = exportScan
  checkpoint.pages = finalPages
  checkpoint.attachments = attachments
  checkpoint.completed = true
  checkpoint.nextPageIndex = targetPages.length
  checkpoint.totalPages = targetPages.length
  checkpoint.updatedAt = new Date().toISOString()
  await saveConfluenceCheckpoint(checkpoint)

  return finalResult
}

function notifyQuickSave(): void {
  chrome.action.setBadgeText({ text: "✓" })
  chrome.action.setBadgeBackgroundColor({ color: "#10b981" })
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000)
}

function notifyActionError(): void {
  chrome.action.setBadgeText({ text: "!" })
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" })
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000)
}
