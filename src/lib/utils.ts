import type { ExtractResult } from "./types"

export function buildFrontmatter(result: ExtractResult): string {
  const date = new Date().toISOString()
  const domain = new URL(result.url).hostname
  return `---
title: "${result.title.replace(/"/g, '\\"')}"
source_url: "${result.url}"
domain: "${domain}"
exported_at: "${date}"
word_count: ${result.wordCount}
---\n\n`
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
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
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

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
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
