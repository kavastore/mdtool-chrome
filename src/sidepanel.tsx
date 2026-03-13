import { h, render } from "preact"
import { useState, useEffect } from "preact/hooks"
import { t } from "~lib/i18n"
import { getAllClips, deleteClip, clearAllClips } from "~lib/storage"
import { downloadBatchZip, downloadConfluenceZip, downloadHistoryZip } from "~lib/zip"
import type {
  BatchExportResult,
  ClipItem,
  ConfluenceCheckpoint,
  ConfluenceExportResult,
  ConfluenceScanResult,
  ExtractionErrorDetails,
} from "~lib/types"
import "./style.css"

type RuntimeErrorPayload = string | ExtractionErrorDetails | undefined
type SidepanelMode = "history" | "confluence"

function getErrorCode(error: RuntimeErrorPayload): string {
  if (!error) return ""
  if (typeof error === "string") return error
  return error.code || ""
}

function resolveExtractionToast(error: RuntimeErrorPayload): string {
  if (!error) return t("toastError")
  if (typeof error === "string") return error

  const code = getErrorCode(error)
  switch (code) {
    case "empty-selection":
      return t("toastNoSelection")
    case "empty-content":
      return t("toastNoContent")
    case "no-code-blocks":
      return t("toastNoCodeBlocks")
    case "no-tables":
      return t("toastNoTables")
    case "confluence-invalid-input":
      return "Enter a valid Confluence Space URL or key"
    case "confluence-no-pages":
      return "No pages found in this Confluence Space"
    case "confluence-no-access":
      return "No access to some Confluence pages"
    case "confluence-cancelled":
      return "Operation cancelled"
    case "confluence-scan-failed":
      return error.message || "Confluence operation failed"
    default:
      return error.message || t("toastError")
  }
}

function SidePanel() {
  const [clips, setClips] = useState<ClipItem[]>([])
  const [query, setQuery] = useState("")
  const [toast, setToast] = useState("")
  const [historyExporting, setHistoryExporting] = useState(false)
  const [mode, setMode] = useState<SidepanelMode>("history")

  const [confluenceInput, setConfluenceInput] = useState("")
  const [scanLoading, setScanLoading] = useState(false)
  const [confluenceExporting, setConfluenceExporting] = useState(false)
  const [confluencePaused, setConfluencePaused] = useState(false)
  const [scanResult, setScanResult] = useState<ConfluenceScanResult | null>(null)
  const [exportResult, setExportResult] = useState<ConfluenceExportResult | null>(null)
  const [checkpoint, setCheckpoint] = useState<ConfluenceCheckpoint | null>(null)

  useEffect(() => {
    reload()
  }, [])

  useEffect(() => {
    if (mode !== "confluence") return
    void refreshConfluenceCheckpoint()
  }, [mode])

  async function sendMessage<T>(message: Record<string, unknown>): Promise<T | null> {
    try {
      return (await chrome.runtime.sendMessage(message)) as T
    } catch {
      return null
    }
  }

  async function reload() {
    setClips(await getAllClips())
  }

  async function refreshConfluenceCheckpoint() {
    const res = await sendMessage<{ ok?: boolean; data?: ConfluenceCheckpoint | null }>({
      type: "CONFLUENCE_CHECKPOINT_GET",
    })
    if (res?.ok) {
      setCheckpoint(res.data ?? null)
      if (!scanResult && res.data?.scan) {
        setScanResult(res.data.scan)
      }
    }
  }

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(""), 3000)
  }

  const filtered = clips.filter(
    (c) =>
      c.title.toLowerCase().includes(query.toLowerCase()) ||
      c.domain.toLowerCase().includes(query.toLowerCase())
  )

  async function handleDelete(id: string) {
    await deleteClip(id)
    reload()
  }

  async function handleClear() {
    await clearAllClips()
    reload()
  }

  async function handleExportAll() {
    if (filtered.length === 0) return
    setHistoryExporting(true)
    try {
      await downloadHistoryZip(filtered)
      showToast(t("toastExportDone"))
    } catch {
      showToast(t("toastError"))
    } finally {
      setHistoryExporting(false)
    }
  }

  async function ensureTabsPermission(): Promise<boolean> {
    try {
      const hasPermission = await chrome.permissions.contains({ permissions: ["tabs"] })
      if (hasPermission) return true
      return await chrome.permissions.request({ permissions: ["tabs"] })
    } catch {
      return false
    }
  }

  async function handleExportAllTabs() {
    const hasPermission = await ensureTabsPermission()
    if (!hasPermission) {
      showToast("Grant tabs permission to export tabs")
      return
    }

    let tabs: chrome.tabs.Tab[] = []
    try {
      tabs = await chrome.tabs.query({ currentWindow: true })
    } catch {
      showToast(t("toastError"))
      return
    }
    const tabIds = tabs.filter((t) => t.id && t.url?.startsWith("http")).map((t) => t.id!)
    if (tabIds.length === 0) {
      showToast(t("toastError"))
      return
    }

    setHistoryExporting(true)
    try {
      const res = await sendMessage<{
        ok?: boolean
        data?: BatchExportResult
        error?: RuntimeErrorPayload
      }>({ type: "BATCH_EXPORT", tabIds })

      if (!res?.ok || !res.data) {
        showToast(resolveExtractionToast(res?.error))
        return
      }

      if (res.data.items.length === 0) {
        showToast(resolveExtractionToast(res.data.failures[0]?.error))
        return
      }

      await downloadBatchZip(res.data)

      reload()
      if (res.data.failed > 0) {
        showToast(t("toastBatchPartial"))
      } else {
        showToast(t("toastExportDone"))
      }
    } catch {
      showToast(t("toastError"))
    } finally {
      setHistoryExporting(false)
    }
  }

  async function handleConfluenceScan() {
    const input = confluenceInput.trim()
    if (!input) {
      showToast("Enter Confluence Space URL or key")
      return
    }

    const hasPermission = await ensureTabsPermission()
    if (!hasPermission) {
      showToast("Grant tabs permission to scan Confluence pages")
      return
    }

    setScanLoading(true)
    setConfluencePaused(false)
    setExportResult(null)
    try {
      const res = await sendMessage<{
        ok?: boolean
        data?: ConfluenceScanResult
        error?: RuntimeErrorPayload
      }>({
        type: "CONFLUENCE_SCAN",
        input,
      })

      if (!res?.ok || !res.data) {
        showToast(resolveExtractionToast(res?.error))
        setScanResult(null)
        return
      }

      setScanResult(res.data)
      await refreshConfluenceCheckpoint()
      if (res.data.pages.length === 0) {
        showToast("Scan finished: no pages found")
      } else if (res.data.failed > 0) {
        showToast(`Scan done: ${res.data.pages.length} pages, ${res.data.failed} failed`)
      } else {
        showToast(`Scan done: ${res.data.pages.length} pages`)
      }
    } catch {
      showToast(t("toastError"))
      setScanResult(null)
    } finally {
      setScanLoading(false)
    }
  }

  async function handleConfluenceExport() {
    const sourceScan = scanResult ?? checkpoint?.scan ?? null
    if (!sourceScan || sourceScan.pages.length === 0) {
      showToast("Run scan first")
      return
    }

    setConfluenceExporting(true)
    setConfluencePaused(false)
    try {
      const res = await sendMessage<{
        ok?: boolean
        data?: ConfluenceExportResult
        error?: RuntimeErrorPayload
      }>({
        type: "CONFLUENCE_EXPORT",
        scan: sourceScan,
        resume: true,
      })

      if (!res?.ok || !res.data) {
        showToast(resolveExtractionToast(res?.error))
        return
      }

      setExportResult(res.data)
      await downloadConfluenceZip(res.data)
      await refreshConfluenceCheckpoint()

      if (res.data.failed > 0 || res.data.skipped > 0) {
        showToast(`Export done: ${res.data.exported} ok, ${res.data.failed} failed`)
      } else {
        showToast("Confluence export complete")
      }
    } catch {
      showToast(t("toastError"))
    } finally {
      setConfluenceExporting(false)
    }
  }

  async function handleConfluenceCancel() {
    try {
      await sendMessage({ type: "CONFLUENCE_CANCEL" })
      setConfluencePaused(false)
      showToast("Stopping...")
    } catch {
      showToast(t("toastError"))
    }
  }

  async function handleConfluencePauseResume() {
    try {
      if (confluencePaused) {
        await sendMessage({ type: "CONFLUENCE_RESUME" })
        setConfluencePaused(false)
        showToast("Resumed")
      } else {
        await sendMessage({ type: "CONFLUENCE_PAUSE" })
        setConfluencePaused(true)
        showToast("Paused")
      }
    } catch {
      showToast(t("toastError"))
    }
  }

  async function handleConfluenceUseCheckpoint() {
    if (!checkpoint?.scan) return
    setScanResult(checkpoint.scan)
    setConfluenceInput(checkpoint.spaceUrl)
    showToast("Loaded last checkpoint")
  }

  async function handleConfluenceClearCheckpoint() {
    try {
      await sendMessage({ type: "CONFLUENCE_CHECKPOINT_CLEAR" })
      setCheckpoint(null)
      showToast("Checkpoint cleared")
    } catch {
      showToast(t("toastError"))
    }
  }

  async function handleDownloadClip(clip: ClipItem) {
    const filename = `${sanitizeFilename(clip.title) || clip.id}.md`
    const res = await sendMessage<{ ok?: boolean }>({
      type: "DOWNLOAD_MD",
      filename,
      content: clip.markdown,
    })
    if (!res?.ok) showToast(t("toastError"))
  }

  async function handleCopyClip(clip: ClipItem) {
    try {
      await navigator.clipboard.writeText(clip.markdown)
      showToast(t("btnCopied"))
    } catch {
      showToast(t("toastError"))
    }
  }

  return (
    <div class="min-h-screen bg-zinc-950 text-zinc-100 font-sans text-sm flex flex-col">
      <header class="px-4 py-3 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-zinc-950 z-10">
        <span class="font-bold text-emerald-400 text-base">md</span>
        <div class="flex gap-1">
          <button
            onClick={() => setMode("history")}
            class={`text-xs px-2 py-1 rounded border transition-colors ${
              mode === "history"
                ? "bg-zinc-800 border-zinc-600 text-zinc-200"
                : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t("labelHistory")}
          </button>
          <button
            onClick={() => setMode("confluence")}
            class={`text-xs px-2 py-1 rounded border transition-colors ${
              mode === "confluence"
                ? "bg-zinc-800 border-zinc-600 text-zinc-200"
                : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Confluence
          </button>
        </div>
      </header>

      {mode === "history" ? (
        <>
          <div class="px-4 py-2 border-b border-zinc-800 flex gap-2">
            <button
              onClick={handleExportAllTabs}
              disabled={historyExporting}
              class="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
              title={t("btnExportAll")}
            >
              ⬇ tabs
            </button>
            <button
              onClick={handleExportAll}
              disabled={historyExporting || filtered.length === 0}
              class="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
            >
              📦 .zip
            </button>
          </div>

          <div class="px-4 py-2 border-b border-zinc-800">
            <input
              type="text"
              placeholder={t("searchPlaceholder")}
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              class="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>

          <div class="flex-1 overflow-y-auto divide-y divide-zinc-800/50">
            {filtered.length === 0 ? (
              <div class="flex items-center justify-center h-32 text-zinc-600 text-xs">
                {t("noHistory")}
              </div>
            ) : (
              filtered.map((clip) => (
                <div key={clip.id} class="px-4 py-3 hover:bg-zinc-900/50 transition-colors">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                      <div class="text-xs font-medium text-zinc-200 truncate">{clip.title}</div>
                      <div class="text-xs text-zinc-600 truncate">{clip.domain}</div>
                      <div class="text-xs text-zinc-700 mt-0.5">
                        {new Date(clip.exportedAt).toLocaleDateString()} · {t("labelWordCount", String(clip.wordCount))}
                      </div>
                    </div>
                    <div class="flex gap-1 shrink-0">
                      <IconBtn title={t("btnCopy")} onClick={() => handleCopyClip(clip)}>📋</IconBtn>
                      <IconBtn title={t("btnSaveMd")} onClick={() => handleDownloadClip(clip)}>⬇</IconBtn>
                      <IconBtn title="✕" onClick={() => handleDelete(clip.id)}>✕</IconBtn>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {clips.length > 0 && (
            <div class="px-4 py-2 border-t border-zinc-800 flex justify-between items-center">
              <span class="text-xs text-zinc-600">{clips.length} clips</span>
              <button
                onClick={handleClear}
                class="text-xs text-zinc-600 hover:text-red-400 transition-colors"
              >
                {t("btnClearHistory")}
              </button>
            </div>
          )}
        </>
      ) : (
        <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          <div class="text-xs text-zinc-400">
            Enter Confluence Space URL or key, then scan pages and export zip.
          </div>
          <div class="flex gap-2">
            <input
              type="text"
              value={confluenceInput}
              onInput={(event) => setConfluenceInput((event.target as HTMLInputElement).value)}
              placeholder="https://your-domain.atlassian.net/wiki/spaces/SPACE"
              class="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
            />
          </div>
          <div class="flex gap-2">
            <button
              onClick={handleConfluenceScan}
              disabled={scanLoading || confluenceExporting}
              class="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 transition-colors disabled:opacity-40"
            >
              {scanLoading ? "Scanning..." : "Scan"}
            </button>
            <button
              onClick={handleConfluenceExport}
              disabled={
                scanLoading ||
                confluenceExporting ||
                !(scanResult?.pages?.length || checkpoint?.scan?.pages?.length)
              }
              class="text-xs px-3 py-1.5 rounded bg-emerald-600 text-black font-medium hover:bg-emerald-500 transition-colors disabled:opacity-40"
            >
              {confluenceExporting ? "Exporting..." : "Export"}
            </button>
            <button
              onClick={handleConfluencePauseResume}
              disabled={!scanLoading && !confluenceExporting}
              class="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
            >
              {confluencePaused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={handleConfluenceCancel}
              disabled={!scanLoading && !confluenceExporting}
              class="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
            >
              Stop
            </button>
          </div>

          {checkpoint && (
            <div class="rounded border border-zinc-800 bg-zinc-900 p-3 flex items-center justify-between gap-2">
              <div class="text-[11px] text-zinc-500">
                checkpoint: {checkpoint.spaceKey} · {checkpoint.nextPageIndex}/{checkpoint.totalPages}
                {checkpoint.completed ? " · complete" : " · resumable"}
              </div>
              <div class="flex gap-1">
                <button
                  onClick={handleConfluenceUseCheckpoint}
                  class="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                >
                  Load
                </button>
                <button
                  onClick={handleConfluenceClearCheckpoint}
                  class="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {scanResult && (
            <div class="rounded border border-zinc-800 bg-zinc-900 p-3">
              <div class="text-xs text-zinc-300 mb-2">
                Space: <span class="text-zinc-100">{scanResult.spaceKey}</span>
              </div>
              <div class="text-xs text-zinc-500">
                scanned {scanResult.scanned} · skipped {scanResult.skipped} · failed {scanResult.failed}
              </div>
            </div>
          )}

          {scanResult?.pages?.length ? (
            <div class="rounded border border-zinc-800 divide-y divide-zinc-800/60 max-h-[340px] overflow-y-auto">
              {scanResult.pages.map((page) => (
                <div key={page.id} class="px-3 py-2">
                  <div class="text-xs text-zinc-200 truncate">{page.title}</div>
                  <div class="text-[11px] text-zinc-600 truncate">{page.url}</div>
                </div>
              ))}
            </div>
          ) : (
            <div class="text-xs text-zinc-600">No scanned pages yet.</div>
          )}

          {exportResult && (
            <div class="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-400">
              exported {exportResult.exported} · skipped {exportResult.skipped} · failed {exportResult.failed} ·
              attachments {exportResult.attachments.length}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div class="fixed bottom-4 left-1/2 -translate-x-1/2 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-lg px-4 py-2 shadow-xl z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

function IconBtn({ children, title, onClick }: { children: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      class="w-6 h-6 flex items-center justify-center rounded text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors text-xs"
    >
      {children}
    </button>
  )
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80)
}

const sidepanelRoot = document.getElementById("__plasmo") || document.getElementById("root")
if (!sidepanelRoot) {
  throw new Error("Side panel mount root not found")
}

render(<SidePanel />, sidepanelRoot)
