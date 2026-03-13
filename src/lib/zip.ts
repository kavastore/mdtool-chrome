import JSZip from "jszip"
import type { BatchExportResult, ClipItem, ConfluenceExportResult, ExtractResult } from "./types"

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

const MAX_SEGMENT_LENGTH = 80
const MAX_PATH_LENGTH = 220

interface ZipEntryInput {
  domain: string
  title: string
  fallbackName: string
  content: string
}

export interface ZipBuildResult {
  zip: JSZip
  filesAdded: number
  collisionsResolved: number
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function normalizePathSegment(raw: string, fallback: string, maxLength = MAX_SEGMENT_LENGTH): string {
  const base = (raw || fallback)
    .normalize("NFKD")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()

  const normalized = clamp(base, maxLength) || fallback
  const withoutTrailingDots = normalized.replace(/[. ]+$/g, "")
  const safe = withoutTrailingDots || fallback

  if (WINDOWS_RESERVED_NAMES.has(safe.toLowerCase())) {
    return `${safe}-file`
  }

  return safe
}

function splitPath(path: string): { dir: string; filename: string; ext: string; stem: string } {
  const parts = path.split("/")
  const filename = parts.pop() || "file.md"
  const dir = parts.join("/")
  const dotIndex = filename.lastIndexOf(".")
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return { dir, filename, ext: "", stem: filename }
  }
  const stem = filename.slice(0, dotIndex)
  const ext = filename.slice(dotIndex)
  return { dir, filename, ext, stem }
}

function ensureUniquePath(initialPath: string, usedPaths: Set<string>): { path: string; collisionResolved: boolean } {
  if (!usedPaths.has(initialPath)) {
    usedPaths.add(initialPath)
    return { path: initialPath, collisionResolved: false }
  }

  const { dir, stem, ext } = splitPath(initialPath)
  for (let index = 2; index <= 9999; index++) {
    const suffix = `-${index}`
    const maxStemLength = Math.max(8, MAX_SEGMENT_LENGTH - suffix.length)
    const nextStem = clamp(stem, maxStemLength)
    const nextFilename = `${nextStem}${suffix}${ext}`
    const nextPath = dir ? `${dir}/${nextFilename}` : nextFilename
    if (!usedPaths.has(nextPath)) {
      usedPaths.add(nextPath)
      return { path: nextPath, collisionResolved: true }
    }
  }

  const lastResort = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || ".md"}`
  const lastPath = dir ? `${dir}/${lastResort}` : lastResort
  usedPaths.add(lastPath)
  return { path: lastPath, collisionResolved: true }
}

function toZipEntry(
  item: ZipEntryInput,
  rootFolder: string
): { basePath: string; normalizedDomain: string; normalizedTitle: string } {
  const normalizedDomain = normalizePathSegment(item.domain, "pages", 64)
  const normalizedTitle = normalizePathSegment(item.title, item.fallbackName || "page")
  const root = normalizePathSegment(rootFolder, "export", 64)
  const fileName = `${normalizedTitle}.md`
  let basePath = `${root}/${normalizedDomain}/${fileName}`

  if (basePath.length > MAX_PATH_LENGTH) {
    const overflow = basePath.length - MAX_PATH_LENGTH
    const nextTitle = normalizePathSegment(
      normalizedTitle.slice(0, Math.max(8, normalizedTitle.length - overflow)),
      item.fallbackName || "page"
    )
    basePath = `${root}/${normalizedDomain}/${nextTitle}.md`
  }

  return { basePath, normalizedDomain, normalizedTitle }
}

async function finalizeZipDownload(zip: JSZip, filename: string): Promise<void> {
  const blob = await zip.generateAsync({ type: "blob" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function safeDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname || "pages"
  } catch {
    return "pages"
  }
}

function clipsToEntries(clips: ClipItem[]): ZipEntryInput[] {
  return clips.map((clip) => ({
    domain: clip.domain || "pages",
    title: clip.title,
    fallbackName: clip.id || "clip",
    content: clip.markdown,
  }))
}

function resultsToEntries(results: ExtractResult[]): ZipEntryInput[] {
  return results.map((item, idx) => ({
    domain: safeDomainFromUrl(item.url),
    title: item.title,
    fallbackName: `page-${idx + 1}`,
    content: item.markdown,
  }))
}

function buildZip(entries: ZipEntryInput[], rootFolder: string): ZipBuildResult {
  const zip = new JSZip()
  const usedPaths = new Set<string>()
  let collisionsResolved = 0
  let filesAdded = 0

  for (const entry of entries) {
    const base = toZipEntry(entry, rootFolder)
    const resolved = ensureUniquePath(base.basePath, usedPaths)
    if (resolved.collisionResolved) collisionsResolved += 1
    zip.file(resolved.path, entry.content)
    filesAdded += 1
  }

  return { zip, filesAdded, collisionsResolved }
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function downloadHistoryZip(clips: ClipItem[]): Promise<ZipBuildResult> {
  const zipResult = buildZip(clipsToEntries(clips), "history")
  await finalizeZipDownload(zipResult.zip, `mdtool-clips-${Date.now()}.zip`)
  return zipResult
}

export async function downloadBatchZip(batch: BatchExportResult): Promise<ZipBuildResult> {
  const zipResult = buildZip(resultsToEntries(batch.items), "tabs")
  zipResult.zip.file(
    "tabs/_batch-report.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        exported: batch.exported,
        failed: batch.failed,
        failures: batch.failures.map((failure) => ({
          tab_id: failure.tabId,
          title: failure.title ?? "",
          url: failure.url ?? "",
          error_code: failure.error.code,
          error_message: failure.error.message,
        })),
      },
      null,
      2
    )
  )
  await finalizeZipDownload(zipResult.zip, `mdtool-tabs-${Date.now()}.zip`)
  return zipResult
}

export async function downloadConfluenceZip(result: ConfluenceExportResult): Promise<ZipBuildResult> {
  const rootFolder = `confluence/${normalizePathSegment(result.spaceKey, "SPACE", 64)}`
  const zip = new JSZip()
  const usedPaths = new Set<string>()
  let collisionsResolved = 0
  let filesAdded = 0

  for (const page of result.pages) {
    if (page.status !== "exported" || !page.markdown.trim()) continue
    const normalizedPath = page.path
      .split("/")
      .map((segment) => normalizePathSegment(segment, "page"))
      .join("/")
    const basePath = `${rootFolder}/${normalizedPath.endsWith(".md") ? normalizedPath : `${normalizedPath}.md`}`
    const resolved = ensureUniquePath(basePath, usedPaths)
    if (resolved.collisionResolved) collisionsResolved += 1
    zip.file(resolved.path, page.markdown)
    filesAdded += 1
  }

  for (const attachment of result.attachments) {
    if (!attachment.base64) continue
    const normalizedPath = attachment.localPath
      .split("/")
      .map((segment) => normalizePathSegment(segment, "file"))
      .join("/")
    const attachmentPath = `${rootFolder}/${normalizedPath}`
    const resolved = ensureUniquePath(attachmentPath, usedPaths)
    if (resolved.collisionResolved) collisionsResolved += 1
    zip.file(resolved.path, decodeBase64(attachment.base64), { binary: true })
    filesAdded += 1
  }

  zip.file(
    `${rootFolder}/_report.json`,
    JSON.stringify(
      {
        generated_at: result.generatedAt,
        space_key: result.spaceKey,
        space_url: result.spaceUrl,
        exported: result.exported,
        skipped: result.skipped,
        failed: result.failed,
        pages: result.pages.map((page) => ({
          page_id: page.pageId,
          title: page.title,
          url: page.url,
          path: page.path,
          status: page.status,
          attachments: page.attachments,
          error: page.error
            ? {
                code: page.error.code,
                message: page.error.message,
              }
            : null,
        })),
      },
      null,
      2
    )
  )

  const zipResult: ZipBuildResult = { zip, filesAdded, collisionsResolved }
  await finalizeZipDownload(zipResult.zip, `confluence-${result.spaceKey}-${Date.now()}.zip`)
  return zipResult
}
