import { h, render } from "preact"
import { useState, useEffect } from "preact/hooks"
import JSZip from "jszip"
import { t } from "~lib/i18n"
import { getAllClips, deleteClip, clearAllClips } from "~lib/storage"
import type { ClipItem, ExtractResult } from "~lib/types"
import "./style.css"

function SidePanel() {
  const [clips, setClips] = useState<ClipItem[]>([])
  const [query, setQuery] = useState("")
  const [toast, setToast] = useState("")
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    reload()
  }, [])

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
    setExporting(true)
    try {
      const zip = new JSZip()
      for (const clip of filtered) {
        const filename = `${clip.domain}/${sanitizeFilename(clip.title) || clip.id}.md`
        zip.file(filename, clip.markdown)
      }
      const blob = await zip.generateAsync({ type: "blob" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `mdtool-clips-${Date.now()}.zip`
      a.click()
      URL.revokeObjectURL(url)
      showToast(t("toastExportDone"))
    } catch {
      showToast(t("toastError"))
    } finally {
      setExporting(false)
    }
  }

  async function handleExportAllTabs() {
    let tabs: chrome.tabs.Tab[] = []
    try {
      tabs = await chrome.tabs.query({ currentWindow: true })
    } catch {
      // 'tabs' permission not yet granted — request it
      const granted = await chrome.permissions.request({ permissions: ["tabs"] })
      if (!granted) return
      tabs = await chrome.tabs.query({ currentWindow: true })
    }
    const tabIds = tabs.filter((t) => t.id && t.url?.startsWith("http")).map((t) => t.id!)
    if (tabIds.length === 0) {
      showToast(t("toastError"))
      return
    }

    setExporting(true)
    try {
      const res = await sendMessage<{ ok?: boolean; data?: ExtractResult[] }>({ type: "BATCH_EXPORT", tabIds })
      if (!res?.ok || !res.data || res.data.length === 0) {
        showToast(t("toastError"))
        return
      }

      const zip = new JSZip()
      for (const clip of res.data) {
        const domain = (() => {
          try {
            return new URL(clip.url).hostname
          } catch {
            return "pages"
          }
        })()
        zip.file(`${domain}/${sanitizeFilename(clip.title) || "page"}.md`, clip.markdown)
      }

      const blob = await zip.generateAsync({ type: "blob" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `mdtool-tabs-${Date.now()}.zip`
      a.click()
      URL.revokeObjectURL(url)

      reload()
      showToast(t("toastExportDone"))
    } catch {
      showToast(t("toastError"))
    } finally {
      setExporting(false)
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
      {/* Header */}
      <header class="px-4 py-3 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-zinc-950 z-10">
        <span class="font-bold text-emerald-400 text-base">md</span>
        <span class="text-xs text-zinc-500">{t("labelHistory")}</span>
        <div class="flex gap-2">
          <button
            onClick={handleExportAllTabs}
            disabled={exporting}
            class="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
            title={t("btnExportAll")}
          >
            ⬇ tabs
          </button>
          <button
            onClick={handleExportAll}
            disabled={exporting || filtered.length === 0}
            class="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
          >
            📦 .zip
          </button>
        </div>
      </header>

      {/* Search */}
      <div class="px-4 py-2 border-b border-zinc-800">
        <input
          type="text"
          placeholder={t("searchPlaceholder")}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          class="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
        />
      </div>

      {/* Clip list */}
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

      {/* Footer */}
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

      {/* Toast */}
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
