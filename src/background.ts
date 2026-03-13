import type { ExtractResult, ExtractionMode, PromptTemplate, AppSettings } from "~lib/types"
import { AI_SERVICES, PROMPT_DEFS, STORAGE_KEY_SETTINGS } from "~lib/constants"
import { buildAiPayload, generateId, isValidHttpUrl, normalizeUserPrompt } from "~lib/utils"
import { saveClip, getSettings } from "~lib/storage"

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
  /Receiving end does not exist|Could not establish connection|The message port closed before a response was received/i

const DEFAULT_AI_URL = AI_SERVICES.find((svc) => svc.id !== "custom")?.url ?? "https://chat.openai.com/"

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
    const result = await injectAndExtract(tab.id, "article")
    if (result) notifyQuickSave()
    return
  }

  if (menuId === MENU_IDS.saveHistory) {
    const mode: ExtractionMode = info.selectionText ? "selection" : "article"
    const result = await injectAndExtract(tab.id, mode)
    if (result) notifyQuickSave()
    return
  }

  if (menuId === MENU_IDS.copySelection) {
    const result = await injectAndExtract(tab.id, info.selectionText ? "selection" : "article")
    if (result) {
      await clipboardWriteInTab(tab.id, result.markdown)
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
  const result = await injectAndExtract(tab.id, "article")
  if (result) notifyQuickSave()
})

// ── Message bus (from popup / side panel) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }))
  return true
})

async function handleMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case "EXTRACT_AND_PREVIEW": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { ok: false, error: "no-active-tab" }
      if (!isSupportedPageUrl(tab.url)) return { ok: false, error: "unsupported-url" }
      const mode = (msg.mode as ExtractionMode) ?? "article"
      const result = await injectAndExtract(tab.id, mode)
      if (!result) return { ok: false, error: "extract-failed" }
      return { ok: true, data: result }
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
      const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(content as string)}`
      try {
        await chrome.downloads.download({
          url: dataUrl,
          filename: filename as string,
          saveAs: false,
        })
        return { ok: true }
      } catch {
        return { ok: false, error: "download-failed" }
      }
    }

    case "BATCH_EXPORT": {
      const tabIds = (msg.tabIds as number[]) ?? []
      const results = await batchExport(tabIds)
      return { ok: true, data: results }
    }

    case "SETTINGS_UPDATED": {
      await rebuildContextMenus()
      return { ok: true }
    }

    default:
      return { ok: false, error: "unknown message type" }
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

type ExtractAttempt =
  | { ok: true; data: ExtractResult }
  | { ok: false; error?: string; noReceiver?: boolean }

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
  const result = await injectAndExtract(tabId, mode)
  if (!result) return

  const settings = await getSettings()
  const promptText = resolvePromptText(settings, promptId)
  await sendToAi(serviceId, promptText, result.markdown, false, tabId)
}

function requestExtractionFromTab(tabId: number, mode: ExtractionMode): Promise<ExtractAttempt> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: mode === "selection" ? "EXTRACT_SELECTION" : "EXTRACT_PAGE",
        options: { mode, includeFrontmatter: true, includeImages: false },
      },
      (res) => {
        const lastError = chrome.runtime.lastError
        if (lastError) {
          resolve({
            ok: false,
            error: lastError.message,
            noReceiver: NO_RECEIVER_RE.test(lastError.message || ""),
          })
          return
        }

        if (!res?.ok) {
          resolve({ ok: false, error: String(res?.error || "extract-failed") })
          return
        }

        resolve({ ok: true, data: res.data as ExtractResult })
      }
    )
  })
}

async function injectAndExtract(
  tabId: number,
  mode: ExtractionMode
): Promise<ExtractResult | null> {
  let attempt = await requestExtractionFromTab(tabId, mode)

  if (!attempt.ok && "noReceiver" in attempt && attempt.noReceiver) {
    const injected = await tryInjectClipperScript(tabId)
    if (injected) {
      await sleep(60)
      attempt = await requestExtractionFromTab(tabId, mode)
      if (!attempt.ok && "noReceiver" in attempt && attempt.noReceiver) {
        await sleep(160)
        attempt = await requestExtractionFromTab(tabId, mode)
      }
    }
  }

  if (!attempt.ok) {
    return null
  }

  const result = attempt.data
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

  return result
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

async function batchExport(tabIds: number[]): Promise<ExtractResult[]> {
  const results: ExtractResult[] = []
  for (const id of tabIds) {
    const res = await injectAndExtract(id, "article")
    if (res) results.push(res)
  }
  return results
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
