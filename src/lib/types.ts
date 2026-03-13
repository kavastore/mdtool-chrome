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
export type ResolvedExtractionMode = ExtractionMode | "text"
export type ExtractionPhase = "queued" | "extracting" | "converting" | "saved" | "error"
export type ExtractionErrorCode =
  | "no-active-tab"
  | "unsupported-url"
  | "content-script-missing"
  | "extract-failed"
  | "empty-selection"
  | "empty-content"
  | "no-code-blocks"
  | "no-tables"
  | "download-failed"
  | "save-failed"
  | "confluence-invalid-input"
  | "confluence-scan-failed"
  | "confluence-no-pages"
  | "confluence-no-access"
  | "confluence-cancelled"
  | "unknown-error"

export interface ExtractionErrorDetails {
  code: ExtractionErrorCode
  message: string
  mode?: ExtractionMode
  phase?: ExtractionPhase
}

export interface ExtractionAttemptReport {
  mode: ResolvedExtractionMode
  ok: boolean
  error?: ExtractionErrorDetails
}

export interface ExtractionOperationReport {
  requestedMode: ExtractionMode
  usedMode?: ResolvedExtractionMode
  statuses: ExtractionPhase[]
  attempts: ExtractionAttemptReport[]
  historySaved: boolean
  fallbackUsed: boolean
}

export interface DebugLogEntry {
  id: string
  createdAt: string
  kind: "extract" | "batch"
  tabId?: number
  tabUrl?: string
  report: ExtractionOperationReport
}

export interface BatchExportFailure {
  tabId: number
  title?: string
  url?: string
  error: ExtractionErrorDetails
}

export interface BatchExportResult {
  items: ExtractResult[]
  failures: BatchExportFailure[]
  exported: number
  failed: number
  generatedAt: string
}

export interface ConfluencePageNode {
  id: string
  url: string
  title: string
  breadcrumbs: string[]
  depth: number
}

export interface ConfluenceScanFailure {
  url: string
  error: ExtractionErrorDetails
}

export interface ConfluenceScanResult {
  spaceKey: string
  spaceUrl: string
  pages: ConfluencePageNode[]
  scanned: number
  skipped: number
  failed: number
  failures: ConfluenceScanFailure[]
  generatedAt: string
}

export interface ConfluenceAttachmentFile {
  id: string
  pageId: string
  sourceUrl: string
  fileName: string
  localPath: string
  contentType: string
  base64: string
  size: number
}

export interface ConfluenceExportPageResult {
  pageId: string
  title: string
  url: string
  breadcrumbs: string[]
  path: string
  markdown: string
  attachments: number
  status: "exported" | "skipped" | "failed"
  skipReason?: "duplicate" | "no-access" | "already-exported"
  error?: ExtractionErrorDetails
}

export interface ConfluenceExportResult {
  spaceKey: string
  spaceUrl: string
  pages: ConfluenceExportPageResult[]
  attachments: ConfluenceAttachmentFile[]
  exported: number
  skipped: number
  failed: number
  generatedAt: string
}

export interface ConfluenceCheckpoint {
  id: string
  spaceKey: string
  spaceUrl: string
  scan: ConfluenceScanResult
  pages: ConfluenceExportPageResult[]
  attachments: ConfluenceAttachmentFile[]
  nextPageIndex: number
  totalPages: number
  completed: boolean
  createdAt: string
  updatedAt: string
}

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

export interface ExtractResponsePayload {
  ok: boolean
  data?: ExtractResult
  error?: ExtractionErrorDetails
  report?: ExtractionOperationReport
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
