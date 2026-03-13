import { Storage } from "@plasmohq/storage"
import type { ClipItem, AppSettings } from "./types"
import { STORAGE_KEY_SETTINGS, MAX_HISTORY_ITEMS } from "./constants"

const storage = new Storage()
const CLIPS_KEY = "mdtool_clips"

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
