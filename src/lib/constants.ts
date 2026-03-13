import type { AiService, PromptTemplate, ExtractionMode } from "./types"
import type { MessageKey } from "./i18n"

export const AI_SERVICES: AiService[] = [
  { id: "chatgpt", label: "ChatGPT", url: "https://chat.openai.com/", icon: "🤖" },
  { id: "claude", label: "Claude", url: "https://claude.ai/new", icon: "🟠" },
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/app", icon: "✨" },
  { id: "grok", label: "Grok", url: "https://grok.com/", icon: "𝕏" },
  { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", icon: "🔵" },
  { id: "perplexity", label: "Perplexity", url: "https://www.perplexity.ai/", icon: "🔍" },
  { id: "custom", label: "Custom AI", url: "", icon: "🧩" },
]

/**
 * Prompts are stored with a i18n label key so the UI always shows
 * the localized label, while the prompt text itself is intentionally
 * written in the target language (universal — user types their own language
 * into the AI chat box).
 */
export interface PromptDef {
  id: string
  labelKey: MessageKey
  prompt: string
}

export const PROMPT_DEFS: PromptDef[] = [
  { id: "summarize",       labelKey: "promptSummarize",      prompt: "Summarize the key ideas of this document:\n\n---\n\n" },
  { id: "translate_en_ru", labelKey: "promptTranslateEnRu",  prompt: "Переведи на русский язык, сохраняя форматирование:\n\n---\n\n" },
  { id: "translate_ru_en", labelKey: "promptTranslateRuEn",  prompt: "Translate to English, preserving formatting:\n\n---\n\n" },
  { id: "key_points",      labelKey: "promptKeyPoints",      prompt: "Extract the key points as a bullet list:\n\n---\n\n" },
  { id: "eli5",            labelKey: "promptEli5",           prompt: "Explain this in simple terms:\n\n---\n\n" },
  { id: "rewrite_docs",    labelKey: "promptRewriteDocs",    prompt: "Rewrite this as technical documentation:\n\n---\n\n" },
  { id: "code_review",     labelKey: "promptCodeReview",     prompt: "Review the code and provide recommendations:\n\n---\n\n" },
]

export interface ExtractionModeDef {
  mode: ExtractionMode
  labelKey: MessageKey
}

export const EXTRACTION_MODES: ExtractionModeDef[] = [
  { mode: "article",   labelKey: "modeArticle" },
  { mode: "full",      labelKey: "modeFull" },
  { mode: "selection", labelKey: "modeSelection" },
  { mode: "code",      labelKey: "modeCode" },
  { mode: "tables",    labelKey: "modeTables" },
]

export const MDTOOL_URL = "https://mdtool.site"
export const MDTOOL_UTM = "?utm_source=chrome_extension&utm_medium=clipper"

export const MAX_HISTORY_ITEMS = 100
export const STORAGE_KEY_SETTINGS = "mdtool_settings"
