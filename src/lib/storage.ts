import { Storage } from "@plasmohq/storage"
import type { ClipItem, AppSettings, DebugLogEntry } from "./types"
import { STORAGE_KEY_SETTINGS, MAX_HISTORY_ITEMS } from "./constants"

const storage = new Storage()
const CLIPS_KEY = "mdtool_clips"
const DEBUG_LOG_KEY = "mdtool_debug_log"
const MAX_DEBUG_LOG_ITEMS = 80

export const defaultSettings: AppSettings = {
  defaultAiService: "chatgpt",
  defaultPromptTemplate: "summarize",
  customPrompts: [],
  customAiUrl: "",
  onboardingDone: false,
}

export async function getSettings(): Promise<AppSettings> {
  const saved = await storage.get<AppSettings>(STORAGE_KEY_SETTINGS)
  return { ...defaultSettings, ...saved }
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
  const current = await getSettings()
  await storage.set(STORAGE_KEY_SETTINGS, { ...current, ...settings })
}

export async function saveClip(item: ClipItem): Promise<void> {
  const all = await getAllClips()
  const updated = [item, ...all.filter((c) => c.id !== item.id)].slice(0, MAX_HISTORY_ITEMS)
  await storage.set(CLIPS_KEY, updated)
}

export async function getAllClips(): Promise<ClipItem[]> {
  return (await storage.get<ClipItem[]>(CLIPS_KEY)) ?? []
}

export async function deleteClip(id: string): Promise<void> {
  const all = await getAllClips()
  await storage.set(CLIPS_KEY, all.filter((c) => c.id !== id))
}

export async function clearAllClips(): Promise<void> {
  await storage.set(CLIPS_KEY, [])
}

export async function appendDebugLog(entry: DebugLogEntry): Promise<void> {
  const existing = (await storage.get<DebugLogEntry[]>(DEBUG_LOG_KEY)) ?? []
  const next = [entry, ...existing].slice(0, MAX_DEBUG_LOG_ITEMS)
  await storage.set(DEBUG_LOG_KEY, next)
}
