interface FrontmatterInput {
  title: string
  url: string
  wordCount: number
  extractionMode?: string
}

function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
}

function toDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return "unknown"
  }
}

function toPathname(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname || "/"}${parsed.search || ""}`
  } catch {
    return "/"
  }
}

export function buildFrontmatter(result: FrontmatterInput): string {
  const date = new Date().toISOString()
  const domain = toDomain(result.url)
  const sourcePath = toPathname(result.url)
  const readingMinutes = Math.max(1, Math.ceil(result.wordCount / 200))
  const title = result.title?.trim() || "Untitled page"
  const lines = [
    "---",
    `title: "${escapeYamlString(title)}"`,
    `source_url: "${escapeYamlString(result.url)}"`,
    `source_domain: "${escapeYamlString(domain)}"`,
    `source_path: "${escapeYamlString(sourcePath)}"`,
    `exported_at: "${date}"`,
    `word_count: ${result.wordCount}`,
    `reading_minutes: ${readingMinutes}`,
  ]

  if (result.extractionMode) {
    lines.push(`extraction_mode: "${escapeYamlString(result.extractionMode)}"`)
  }

  lines.push("---\n")

  return `${lines.join("\n")}\n`
}

export function buildAiPayload(prompt: string, content: string): string {
  return `${prompt}${content}`
}

export function normalizeUserPrompt(prompt: string): string {
  const trimmed = prompt.trim()
  if (!trimmed) return ""
  if (trimmed.includes("\n\n---\n\n")) return trimmed
  return `${trimmed}\n\n---\n\n`
}

export function generateId(): string {
  return crypto.randomUUID()
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename.endsWith(".md") ? filename : `${filename}.md`
  a.click()
  URL.revokeObjectURL(url)
}

// Transliteration map for Cyrillic → Latin so Russian/Ukrainian titles
// produce readable filenames instead of falling back to "page.md".
const CYRILLIC_TRANSLIT: Record<string, string> = {
  а: "a",  б: "b",  в: "v",  г: "g",  д: "d",  е: "e",  ё: "yo", ж: "zh",
  з: "z",  и: "i",  й: "y",  к: "k",  л: "l",  м: "m",  н: "n",  о: "o",
  п: "p",  р: "r",  с: "s",  т: "t",  у: "u",  ф: "f",  х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch",ъ: "",   ы: "y",  ь: "",   э: "e",  ю: "yu",
  я: "ya",
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    // Transliterate Cyrillic characters
    .replace(/[а-яёА-ЯЁ]/g, (ch) => CYRILLIC_TRANSLIT[ch] ?? CYRILLIC_TRANSLIT[ch.toLowerCase()] ?? "")
    // Try to convert other Unicode letters to their ASCII base via NFKD
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}
