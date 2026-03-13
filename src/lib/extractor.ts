import { Readability } from "@mozilla/readability"
import DOMPurify from "dompurify"
import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"
import type {
  ExtractionErrorCode,
  ExtractionErrorDetails,
  ExtractionOptions,
  ExtractResult,
} from "~lib/types"
import { buildFrontmatter, countWords } from "~lib/utils"

export class ExtractionError extends Error {
  code: ExtractionErrorCode

  constructor(code: ExtractionErrorCode, message: string) {
    super(message)
    this.name = "ExtractionError"
    this.code = code
  }
}

function buildTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  })
  td.use(gfm)

  td.addRule("absolute-links", {
    filter: (node) =>
      node.nodeName === "A" &&
      !!(node as HTMLAnchorElement).getAttribute("href"),
    replacement: (content, node) => {
      const el = node as HTMLAnchorElement
      const href = el.getAttribute("href") || ""
      try {
        const abs = new URL(href, location.href).href
        const text = content?.trim() || abs
        const title = el.title ? ` "${el.title}"` : ""
        return `[${text}](${abs}${title})`
      } catch {
        return content
      }
    },
  })

  td.addRule("fenced-code-lang", {
    filter: (node) =>
      node.nodeName === "PRE" && !!node.querySelector("code"),
    replacement: (_content, node) => {
      const code = (node as HTMLElement).querySelector("code")
      const lang =
        code?.className?.match(/language-(\S+)/)?.[1] ||
        (node as HTMLElement).className?.match(/language-(\S+)/)?.[1] ||
        ""
      const text = code?.textContent ?? _content
      return `\n\`\`\`${lang}\n${text.trimEnd()}\n\`\`\`\n`
    },
  })

  return td
}

function extractArticle(doc: Document): { title: string; html: string } {
  const clone = doc.cloneNode(true) as Document
  const article = new Readability(clone).parse()
  return {
    title: article?.title ?? doc.title ?? "",
    html: article?.content ?? doc.body.innerHTML,
  }
}

function extractFull(doc: Document): { title: string; html: string } {
  return { title: doc.title, html: doc.body.innerHTML }
}

function extractSelection(): { title: string; html: string } {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    throw new ExtractionError("empty-selection", "No selected content found on the page")
  }
  const container = document.createElement("div")
  for (let i = 0; i < sel.rangeCount; i++) {
    container.appendChild(sel.getRangeAt(i).cloneContents())
  }
  return { title: document.title, html: container.innerHTML }
}

function extractCodeBlocks(doc: Document): { title: string; html: string } {
  const blocks = Array.from(doc.querySelectorAll("pre, code:not(pre code)"))
  if (blocks.length === 0) {
    throw new ExtractionError("no-code-blocks", "No code blocks found on the page")
  }
  const wrapper = document.createElement("div")
  blocks.forEach((b) => wrapper.appendChild(b.cloneNode(true)))
  return { title: doc.title, html: wrapper.innerHTML }
}

function extractTables(doc: Document): { title: string; html: string } {
  const tables = Array.from(doc.querySelectorAll("table"))
  if (tables.length === 0) {
    throw new ExtractionError("no-tables", "No tables found on the page")
  }
  const wrapper = document.createElement("div")
  tables.forEach((t) => {
    wrapper.appendChild(t.cloneNode(true))
    wrapper.appendChild(document.createElement("br"))
  })
  return { title: doc.title, html: wrapper.innerHTML }
}

function sanitizeHtml(html: string): string {
  const maybeFactory = DOMPurify as unknown as
    | { sanitize?: (dirty: string, config?: Record<string, unknown>) => string }
    | ((window: Window) => { sanitize: (dirty: string, config?: Record<string, unknown>) => string })

  const purifier =
    typeof maybeFactory === "function" && typeof (maybeFactory as { sanitize?: unknown }).sanitize !== "function"
      ? maybeFactory(window)
      : (maybeFactory as { sanitize: (dirty: string, config?: Record<string, unknown>) => string })

  return purifier.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed"],
    FORBID_ATTR: ["onclick", "onerror", "onload"],
  })
}

function normalizeMarkdownLinks(markdown: string): string {
  return markdown
    .replace(/\[\s*\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(((?:javascript|data):[^)]+)\)/gi, "$1")
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return /^\|.*\|$/.test(trimmed) && trimmed.length > 2
}

function normalizeTableSpacing(markdown: string): string {
  const lines = markdown.split("\n")
  const out: string[] = []
  let inFence = false
  let previousWasTable = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      inFence = !inFence
      previousWasTable = false
      out.push(line)
      continue
    }

    if (!inFence && isTableLine(line)) {
      if (!previousWasTable && out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("")
      }
      out.push(line.replace(/[ \t]+$/g, ""))
      previousWasTable = true
      continue
    }

    if (!inFence && previousWasTable && trimmed !== "") {
      out.push("")
    }

    previousWasTable = false
    out.push(line)
  }

  return out.join("\n")
}

function normalizeCodeFenceSpacing(markdown: string): string {
  const lines = markdown.split("\n")
  const out: string[] = []
  let inFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const trimmed = line.trim()
    const isFence = /^```/.test(trimmed)
    const prevLine = out[out.length - 1] || ""

    if (!inFence && isFence && prevLine.trim() !== "") {
      out.push("")
    }

    out.push(line)

    if (isFence) {
      inFence = !inFence
      const nextLine = lines[index + 1]
      if (!inFence && nextLine && nextLine.trim() !== "") {
        out.push("")
      }
    }
  }

  return out.join("\n")
}

function postProcessMarkdown(markdown: string): string {
  const normalized = markdown
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")

  const withLinks = normalizeMarkdownLinks(normalized)
  const withTables = normalizeTableSpacing(withLinks)
  const withCodeFences = normalizeCodeFenceSpacing(withTables)

  return withCodeFences
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function extractContent(options: ExtractionOptions): ExtractResult {
  const { mode } = options
  let raw: { title: string; html: string }

  switch (mode) {
    case "article":   raw = extractArticle(document); break
    case "full":      raw = extractFull(document); break
    case "selection": raw = extractSelection(); break
    case "code":      raw = extractCodeBlocks(document); break
    case "tables":    raw = extractTables(document); break
    default:          raw = extractArticle(document)
  }

  const cleanHtml = sanitizeHtml(raw.html)
  if (!cleanHtml.trim()) {
    throw new ExtractionError("empty-content", "The extracted HTML content is empty")
  }

  const td = buildTurndown()
  let markdown = td.turndown(cleanHtml)

  markdown = postProcessMarkdown(markdown)

  if (!markdown) {
    throw new ExtractionError("empty-content", "The extracted markdown content is empty")
  }

  const wordCount = countWords(markdown)

  const frontmatter = options.includeFrontmatter
    ? buildFrontmatter({
      title: raw.title,
      url: location.href,
      wordCount,
      extractionMode: mode,
    })
    : ""

  const result = frontmatter + markdown

  return {
    title: raw.title,
    url: location.href,
    markdown: result,
    wordCount,
  }
}

export function normalizeExtractionError(error: unknown): ExtractionErrorDetails {
  if (error instanceof ExtractionError) {
    return { code: error.code, message: error.message }
  }

  if (error instanceof Error) {
    return { code: "extract-failed", message: error.message || "Extraction failed" }
  }

  return { code: "unknown-error", message: "Unknown extraction error" }
}
