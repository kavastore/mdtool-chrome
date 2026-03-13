export interface ClipItem {
  id: string
  title: string
  url: string
  domain: string
  markdown: string
  wordCount: number
  exportedAt: string
}

export interface PromptTemplate {
  id: string
  label: string
  prompt: string
  isCustom?: boolean
}

export interface AiService {
  id: string
  label: string
  url: string
  icon: string
}

export type ExtractionMode = "article" | "full" | "selection" | "code" | "tables"

export interface ExtractionOptions {
  mode: ExtractionMode
  includeFrontmatter: boolean
  includeImages: boolean
}

export interface ExtractRequest {
  type: "EXTRACT_PAGE" | "EXTRACT_SELECTION"
  options: ExtractionOptions
}

export interface ExtractResult {
  title: string
  url: string
  markdown: string
  wordCount: number
}

export interface SendToAiPayload {
  serviceId: string
  templateId: string
  customPrompt?: string
  content: string
}

export interface AppSettings {
  defaultAiService: string
  defaultPromptTemplate: string
  customPrompts: PromptTemplate[]
  customAiUrl: string
  onboardingDone: boolean
}
