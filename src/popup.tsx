import { h, render } from "preact"
import { useState, useEffect, useMemo } from "preact/hooks"
import { t } from "~lib/i18n"
import { AI_SERVICES, PROMPT_DEFS, EXTRACTION_MODES, MDTOOL_URL, MDTOOL_UTM } from "~lib/constants"
import { getSettings, saveSettings } from "~lib/storage"
import { slugify, buildAiPayload, normalizeUserPrompt, isValidHttpUrl, generateId } from "~lib/utils"
import type { ExtractResult, ExtractionErrorDetails, ExtractionMode, PromptTemplate } from "~lib/types"
import "./style.css"

type View = "preview" | "settings" | "onboarding"

interface PromptOption {
  id: string
  label: string
  prompt: string
  isCustom?: boolean
}

type RuntimeErrorPayload = string | ExtractionErrorDetails | undefined

function getErrorCode(error: RuntimeErrorPayload): string {
  if (!error) return ""
  if (typeof error === "string") return error
  return error.code || ""
}

function resolveExtractionToast(error: RuntimeErrorPayload): string {
  if (typeof error === "object" && error?.message) {
    const code = getErrorCode(error)
    switch (code) {
      case "unsupported-url":
        return t("toastUnsupportedPage")
      case "empty-selection":
        return t("toastNoSelection")
      case "empty-content":
        return t("toastNoContent")
      case "no-code-blocks":
        return t("toastNoCodeBlocks")
      case "no-tables":
        return t("toastNoTables")
      case "confluence-invalid-input":
        return t("toastConfluenceInvalidInput")
      case "confluence-cancelled":
        return t("toastConfluenceCancelled")
      case "confluence-scan-failed":
      case "confluence-export-failed":
        return error.message || t("toastConfluenceFailed")
      case "content-script-missing":
      case "extract-failed":
        return error.message || t("toastError")
      default:
        return error.message || t("toastError")
    }
  }

  const code = getErrorCode(error)
  switch (code) {
    case "unsupported-url":
      return t("toastUnsupportedPage")
    case "empty-selection":
      return t("toastNoSelection")
    case "empty-content":
      return t("toastNoContent")
    case "no-code-blocks":
      return t("toastNoCodeBlocks")
    case "no-tables":
      return t("toastNoTables")
    case "confluence-invalid-input":
      return t("toastConfluenceInvalidInput")
    case "confluence-cancelled":
      return t("toastConfluenceCancelled")
    default:
      return t("toastError")
  }
}

function toPromptOptions(customPrompts: PromptTemplate[]): PromptOption[] {
  const builtIn = PROMPT_DEFS.map((prompt) => ({
    id: prompt.id,
    label: t(prompt.labelKey),
    prompt: prompt.prompt,
  }))

  const custom = customPrompts
    .filter((prompt) => prompt.id && prompt.label?.trim() && prompt.prompt?.trim())
    .map((prompt) => ({
      id: prompt.id,
      label: prompt.label.trim(),
      prompt: prompt.prompt,
      isCustom: true,
    }))
    .filter((prompt) => !builtIn.some((item) => item.id === prompt.id))

  return [...builtIn, ...custom]
}

function App() {
  const [view, setView] = useState<View>("preview")
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<ExtractResult | null>(null)
  const [mode, setMode] = useState<ExtractionMode>("article")
  const [aiServiceId, setAiServiceId] = useState("chatgpt")
  const [promptId, setPromptId] = useState("summarize")
  const [customPrompts, setCustomPrompts] = useState<PromptTemplate[]>([])
  const [customAiUrl, setCustomAiUrl] = useState("")
  const [customPrompt, setCustomPrompt] = useState("")
  const [toast, setToast] = useState("")
  const [copied, setCopied] = useState(false)
  const [isConfluencePage, setIsConfluencePage] = useState(false)
  const [confluenceSpaceUrl, setConfluenceSpaceUrl] = useState("")
  const promptOptions = useMemo(() => toPromptOptions(customPrompts), [customPrompts])

  useEffect(() => {
    void loadActiveTabContext()

    getSettings().then((s) => {
      const canUseCustomAi = s.defaultAiService !== "custom" || isValidHttpUrl(s.customAiUrl)
      setAiServiceId(canUseCustomAi ? s.defaultAiService : "chatgpt")
      setCustomPrompts(s.customPrompts)
      setCustomAiUrl(s.customAiUrl)
      const loadedPromptOptions = toPromptOptions(s.customPrompts)
      const canUseDefaultPrompt = loadedPromptOptions.some((prompt) => prompt.id === s.defaultPromptTemplate)
      setPromptId(canUseDefaultPrompt ? s.defaultPromptTemplate : "summarize")
      if (!s.onboardingDone) setView("onboarding")
    })
  }, [])

  useEffect(() => {
    if (view !== "preview") return
    extractPage()
  }, [mode, view])

  async function sendMessage<T>(message: Record<string, unknown>): Promise<T | null> {
    try {
      return (await chrome.runtime.sendMessage(message)) as T
    } catch {
      return null
    }
  }

  async function loadActiveTabContext() {
    const res = await sendMessage<{
      ok?: boolean
      data?: { isConfluence?: boolean; confluenceSpaceUrl?: string | null }
    }>({ type: "GET_ACTIVE_TAB_CONTEXT" })

    const detected = !!res?.ok && !!res?.data?.isConfluence
    setIsConfluencePage(detected)
    setConfluenceSpaceUrl(detected ? String(res?.data?.confluenceSpaceUrl || "") : "")
  }

  async function extractPage() {
    setLoading(true)
    const res = await sendMessage<{ ok?: boolean; data?: ExtractResult; error?: RuntimeErrorPayload }>({
      type: "EXTRACT_AND_PREVIEW",
      mode,
    })

    if (res?.ok && res.data) {
      setResult(res.data)
      setLoading(false)
      return
    }

    setResult(null)
    setLoading(false)

    showToast(resolveExtractionToast(res?.error))
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(""), 3000)
  }

  async function handleCopy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast(t("toastError"))
    }
  }

  async function handleDownload() {
    if (!result) return
    const filename = `${slugify(result.title) || "page"}.md`
    const res = await sendMessage<{ ok?: boolean }>({
      type: "DOWNLOAD_MD",
      filename,
      content: result.markdown,
    })
    showToast(res?.ok ? t("toastExportDone") : t("toastError"))
  }

  async function handleSaveToHistory() {
    if (!result) return
    const res = await sendMessage<{ ok?: boolean; error?: RuntimeErrorPayload }>({
      type: "SAVE_TO_HISTORY",
      result,
    })
    showToast(res?.ok ? t("toastSaved") : t("toastError"))
  }

  async function handleOpenMdtool() {
    if (!result) return
    let copied = false
    try {
      await navigator.clipboard.writeText(result.markdown)
      copied = true
    } catch {
      copied = false
    }

    const uiLang = chrome.i18n.getUILanguage().toLowerCase()
    const localePath = uiLang.startsWith("ru") ? "/ru" : ""
    await chrome.tabs.create({ url: `${MDTOOL_URL}${localePath}${MDTOOL_UTM}` })
    showToast(copied ? t("toastContentCopied") : t("toastMdtoolOpenedNoClipboard"))
  }

  async function handleOpenConfluenceExport() {
    const res = await sendMessage<{ ok?: boolean; error?: RuntimeErrorPayload }>({
      type: "OPEN_CONFLUENCE_EXPORT",
      input: confluenceSpaceUrl,
    })
    showToast(res?.ok ? t("toastConfluencePanelOpened") : resolveExtractionToast(res?.error))
  }

  async function handleSendAi() {
    if (!result) return
    const selectedPrompt = promptOptions.find((prompt) => prompt.id === promptId)
    const promptText =
      promptId === "custom"
        ? normalizeUserPrompt(customPrompt)
        : selectedPrompt?.isCustom
          ? normalizeUserPrompt(selectedPrompt.prompt)
          : selectedPrompt?.prompt ?? ""

    if (!promptText) {
      showToast(t("toastError"))
      return
    }

    const payload = buildAiPayload(promptText, result.markdown)
    let copiedInPopup = false

    try {
      await navigator.clipboard.writeText(payload)
      copiedInPopup = true
    } catch {
      copiedInPopup = false
    }

    const res = await sendMessage<{
      ok?: boolean
      data?: { clipboardWritten?: boolean }
      error?: string
    }>({
      type: "SEND_TO_AI",
      serviceId: aiServiceId,
      promptText,
      content: result.markdown,
      skipClipboard: copiedInPopup,
    })

    if (!res?.ok) {
      if (res?.error === "custom-url-missing") {
        showToast(t("toastCustomAiMissing"))
        setView("settings")
        return
      }
      showToast(t("toastError"))
      return
    }

    if (copiedInPopup || res.data?.clipboardWritten) {
      showToast(t("toastContentCopied"))
      return
    }

    showToast(t("toastAiOpenedNoClipboard"))
  }

  if (view === "onboarding") {
    return <Onboarding onDone={() => {
      saveSettings({ onboardingDone: true })
      setView("preview")
    }} />
  }

  return (
    <div class="w-[380px] min-h-[480px] bg-zinc-950 text-zinc-100 flex flex-col font-sans text-sm">
      {/* Header */}
      <header class="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div class="flex items-center gap-2">
          <span class="text-base font-bold text-emerald-400">md</span>
          <span class="text-xs text-zinc-500">clipper</span>
        </div>
        <div class="flex gap-1">
          <TabBtn active={view === "preview"} onClick={() => setView("preview")}>{t("labelPreview")}</TabBtn>
          <TabBtn active={view === "settings"} onClick={() => setView("settings")}>{t("labelSettings")}</TabBtn>
        </div>
      </header>

      {view === "preview" && (
        <div class="flex flex-col gap-3 p-4 flex-1">
          {/* Mode selector */}
          <div class="flex gap-1 flex-wrap">
            {EXTRACTION_MODES.map((m) => (
              <button
                key={m.mode}
                onClick={() => setMode(m.mode)}
                class={`px-2 py-0.5 rounded text-xs border transition-colors ${
                  mode === m.mode
                    ? "bg-emerald-500 border-emerald-500 text-black font-medium"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {t(m.labelKey)}
              </button>
            ))}
          </div>

          {isConfluencePage && (
            <div class="rounded-lg border border-emerald-700/60 bg-emerald-950/30 px-3 py-2 flex items-center justify-between gap-2">
              <div class="text-xs text-emerald-200">{t("popupConfluenceDetected")}</div>
              <button
                onClick={handleOpenConfluenceExport}
                class="px-2 py-1 rounded text-xs border border-emerald-600 text-emerald-200 hover:bg-emerald-900/40 transition-colors"
              >
                {t("btnOpenConfluenceExport")}
              </button>
            </div>
          )}

          {/* Preview area */}
          <div class="relative flex-1 rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden">
            {loading ? (
              <div class="flex items-center justify-center h-32 text-zinc-500 text-xs">
                <span class="animate-pulse">{t("stateExtracting")}</span>
              </div>
            ) : result ? (
              <div class="flex flex-col h-full">
                <div class="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
                  <span class="text-xs text-zinc-400 truncate max-w-[240px]">{result.title}</span>
                  <span class="text-xs text-zinc-600">{t("labelWordCount", String(result.wordCount))}</span>
                </div>
                <pre class="p-3 text-xs text-zinc-300 overflow-auto flex-1 leading-relaxed whitespace-pre-wrap font-mono max-h-48">
                  {result.markdown.slice(0, 2000)}{result.markdown.length > 2000 ? "\n…" : ""}
                </pre>
              </div>
            ) : (
              <div class="flex items-center justify-center h-32 text-zinc-500 text-xs">
                {t("stateNothingExtracted")}
              </div>
            )}
          </div>

          {/* Export actions */}
          <div class="grid grid-cols-4 gap-2">
            <ActionBtn icon="💾" onClick={handleSaveToHistory} disabled={!result}>{t("btnSaveHistory")}</ActionBtn>
            <ActionBtn icon="⬇" onClick={handleDownload} disabled={!result}>{t("btnSaveMd")}</ActionBtn>
            <ActionBtn icon="📋" onClick={handleCopy} disabled={!result}>
              {copied ? t("btnCopied") : t("btnCopy")}
            </ActionBtn>
            <ActionBtn icon="🌐" onClick={handleOpenMdtool} disabled={!result} accent>{t("btnOpenMdtool")}</ActionBtn>
          </div>

          {/* Send to AI */}
          <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-3 flex flex-col gap-2">
            <div class="flex gap-2 flex-wrap">
              {AI_SERVICES.map((svc) => (
                <button
                  key={svc.id}
                  onClick={() => setAiServiceId(svc.id)}
                  title={svc.label}
                  disabled={svc.id === "custom" && !isValidHttpUrl(customAiUrl)}
                  class={`px-2 py-1 rounded text-xs border transition-colors ${
                    aiServiceId === svc.id
                      ? "bg-violet-600 border-violet-500 text-white"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {svc.icon} {svc.label}
                </button>
              ))}
            </div>
            <div class="flex gap-2 flex-wrap">
              {promptOptions.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPromptId(p.id)}
                  class={`px-2 py-0.5 rounded text-xs border transition-colors ${
                    promptId === p.id
                      ? "bg-violet-600 border-violet-500 text-white"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => setPromptId("custom")}
                class={`px-2 py-0.5 rounded text-xs border transition-colors ${
                  promptId === "custom"
                    ? "bg-violet-600 border-violet-500 text-white"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {t("promptCustom")}
              </button>
            </div>
            {promptId === "custom" && (
              <textarea
                placeholder={t("customPromptPlaceholder")}
                value={customPrompt}
                onInput={(e) => setCustomPrompt((e.target as HTMLTextAreaElement).value)}
                class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 resize-none h-16 focus:outline-none focus:border-violet-500"
              />
            )}
            <button
              onClick={handleSendAi}
              disabled={!result}
              class="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded px-3 py-2 text-xs transition-colors"
            >
              {t("btnSendAi")} →
            </button>
          </div>

          {/* mdtool.site banner */}
          <div class="flex items-center gap-1 text-xs text-zinc-500 justify-center">
            <span>{t("bannerMdtool")}</span>
            <a
              href={`${MDTOOL_URL}/?utm_source=chrome_extension&utm_medium=clipper`}
              target="_blank"
              class="text-emerald-400 hover:text-emerald-300 transition-colors"
              onClick={(e) => { e.preventDefault(); chrome.tabs.create({ url: `${MDTOOL_URL}/?utm_source=chrome_extension&utm_medium=clipper` }) }}
            >
              {t("bannerMdtoolLink")}
            </a>
          </div>
        </div>
      )}

      {view === "settings" && (
        <SettingsPanel
          aiServiceId={aiServiceId}
          promptId={promptId}
          customAiUrl={customAiUrl}
          customPrompts={customPrompts}
          onChange={async (next) => {
            const canUseCustomAi = next.aiServiceId !== "custom" || isValidHttpUrl(next.customAiUrl)
            const resolvedAiService = canUseCustomAi ? next.aiServiceId : "chatgpt"
            const optionsAfterSave = toPromptOptions(next.customPrompts)
            const canUsePrompt = optionsAfterSave.some((prompt) => prompt.id === next.promptId)
            const resolvedPromptId = canUsePrompt ? next.promptId : "summarize"

            setAiServiceId(resolvedAiService)
            setPromptId(resolvedPromptId)
            setCustomAiUrl(next.customAiUrl)
            setCustomPrompts(next.customPrompts)

            await saveSettings({
              defaultAiService: resolvedAiService,
              defaultPromptTemplate: resolvedPromptId,
              customAiUrl: next.customAiUrl,
              customPrompts: next.customPrompts,
            })

            await sendMessage({ type: "SETTINGS_UPDATED" })
            showToast(canUseCustomAi ? t("toastSettingsSaved") : t("toastCustomAiMissing"))
          }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div class="fixed bottom-3 left-1/2 -translate-x-1/2 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-4 py-2 shadow-xl z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TabBtn({ children, active, onClick }: { children: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      class={`px-3 py-1 rounded text-xs transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  )
}

function ActionBtn({ children, icon, onClick, disabled, accent }: {
  children: string; icon: string; onClick: () => void; disabled?: boolean; accent?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      class={`flex flex-col items-center gap-0.5 px-2 py-2 rounded-lg border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        accent
          ? "border-emerald-600 text-emerald-400 hover:bg-emerald-900/30"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      }`}
    >
      <span class="text-base">{icon}</span>
      <span>{children}</span>
    </button>
  )
}

function SettingsPanel({
  aiServiceId,
  promptId,
  customAiUrl,
  customPrompts,
  onChange,
}: {
  aiServiceId: string
  promptId: string
  customAiUrl: string
  customPrompts: PromptTemplate[]
  onChange: (next: {
    aiServiceId: string
    promptId: string
    customAiUrl: string
    customPrompts: PromptTemplate[]
  }) => void
}) {
  const [ai, setAi] = useState(aiServiceId)
  const [prompt, setPrompt] = useState(promptId)
  const [aiUrl, setAiUrl] = useState(customAiUrl)
  const [prompts, setPrompts] = useState(customPrompts)
  const [newPromptLabel, setNewPromptLabel] = useState("")
  const [newPromptText, setNewPromptText] = useState("")
  const promptOptions = useMemo(() => toPromptOptions(prompts), [prompts])

  function addCustomPrompt() {
    const label = newPromptLabel.trim()
    const text = newPromptText.trim()
    if (!label || !text) return

    setPrompts((prev) => [
      ...prev,
      { id: `custom-${generateId()}`, label, prompt: text, isCustom: true },
    ])
    setNewPromptLabel("")
    setNewPromptText("")
  }

  function removeCustomPrompt(id: string) {
    setPrompts((prev) => prev.filter((promptItem) => promptItem.id !== id))
    if (prompt === id) setPrompt("summarize")
  }

  return (
    <div class="p-4 flex flex-col gap-4">
      <div>
        <label class="block text-xs text-zinc-400 mb-1.5">{t("settingsDefaultAi")}</label>
        <div class="flex flex-wrap gap-1.5">
          {AI_SERVICES.map((svc) => (
            <button
              key={svc.id}
              onClick={() => setAi(svc.id)}
              class={`px-2.5 py-1 rounded text-xs border transition-colors ${
                ai === svc.id ? "bg-violet-600 border-violet-500 text-white" : "border-zinc-700 text-zinc-400"
              }`}
            >
              {svc.icon} {svc.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label class="block text-xs text-zinc-400 mb-1.5">{t("settingsDefaultPrompt")}</label>
        <div class="flex flex-wrap gap-1.5">
          {promptOptions.map((option) => (
            <button
              key={option.id}
              onClick={() => setPrompt(option.id)}
              class={`px-2.5 py-1 rounded text-xs border transition-colors ${
                prompt === option.id ? "bg-violet-600 border-violet-500 text-white" : "border-zinc-700 text-zinc-400"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label class="block text-xs text-zinc-400 mb-1.5">{t("settingsCustomAiUrl")}</label>
        <input
          type="url"
          value={aiUrl}
          onInput={(e) => setAiUrl((e.target as HTMLInputElement).value)}
          placeholder={t("customAiUrlPlaceholder")}
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
        />
      </div>

      <div class="rounded-lg border border-zinc-800 bg-zinc-900 p-3 flex flex-col gap-2">
        <label class="block text-xs text-zinc-400">{t("settingsManagePrompts")}</label>

        {prompts.length === 0 ? (
          <div class="text-xs text-zinc-600">{t("settingsNoCustomPrompts")}</div>
        ) : (
          <div class="flex flex-col gap-1.5">
            {prompts.map((promptItem) => (
              <div key={promptItem.id} class="flex items-center justify-between gap-2">
                <div class="text-xs text-zinc-300 truncate">{promptItem.label}</div>
                <button
                  onClick={() => removeCustomPrompt(promptItem.id)}
                  class="text-[11px] text-zinc-500 hover:text-red-400 transition-colors"
                >
                  {t("settingsDeletePrompt")}
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          type="text"
          value={newPromptLabel}
          onInput={(e) => setNewPromptLabel((e.target as HTMLInputElement).value)}
          placeholder={t("settingsPromptLabel")}
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-violet-500"
        />
        <textarea
          value={newPromptText}
          onInput={(e) => setNewPromptText((e.target as HTMLTextAreaElement).value)}
          placeholder={t("settingsPromptText")}
          class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 resize-none h-16 focus:outline-none focus:border-violet-500"
        />
        <button
          onClick={addCustomPrompt}
          class="self-start px-3 py-1 rounded text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 transition-colors"
        >
          {t("settingsAddPrompt")}
        </button>
      </div>

      <button
        onClick={() =>
          onChange({
            aiServiceId: ai,
            promptId: prompt,
            customAiUrl: aiUrl.trim(),
            customPrompts: prompts
              .map((promptItem) => ({
                ...promptItem,
                label: promptItem.label.trim(),
                prompt: promptItem.prompt.trim(),
              }))
              .filter((promptItem) => promptItem.label && promptItem.prompt),
          })}
        class="bg-emerald-600 hover:bg-emerald-500 text-black font-medium rounded px-4 py-2 text-xs transition-colors"
      >
        {t("settingsSave")}
      </button>
    </div>
  )
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const steps = [
    { title: t("onboardStep1Title"), body: t("onboardStep1Body") },
    { title: t("onboardStep2Title"), body: t("onboardStep2Body") },
    { title: t("onboardStep3Title"), body: t("onboardStep3Body") },
  ]
  const current = steps[step]

  return (
    <div class="w-[380px] min-h-[480px] bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-8 gap-6">
      <div class="text-4xl">
        {step === 0 ? "👋" : step === 1 ? "📄" : "🤖"}
      </div>
      <div class="text-center">
        <h2 class="text-base font-bold text-emerald-400 mb-2">{current.title}</h2>
        <p class="text-sm text-zinc-400 leading-relaxed">{current.body}</p>
      </div>
      <div class="flex gap-2">
        {steps.map((_, i) => (
          <div key={i} class={`w-2 h-2 rounded-full ${i === step ? "bg-emerald-400" : "bg-zinc-700"}`} />
        ))}
      </div>
      <div class="flex gap-2">
        <button
          onClick={onDone}
          class="px-4 py-2 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {t("onboardSkip")}
        </button>
        <button
          onClick={() => step < steps.length - 1 ? setStep(step + 1) : onDone()}
          class="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-medium rounded text-xs transition-colors"
        >
          {step < steps.length - 1 ? t("onboardNext") : t("onboardDone")}
        </button>
      </div>
    </div>
  )
}

const popupRoot = document.getElementById("__plasmo") || document.getElementById("root")
if (!popupRoot) {
  throw new Error("Popup mount root not found")
}

render(<App />, popupRoot)
