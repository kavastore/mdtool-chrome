import type { PlasmoCSConfig } from "plasmo"
import type { ExtractRequest } from "~lib/types"
import { extractContent } from "~lib/extractor"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle",
}

chrome.runtime.onMessage.addListener((msg: ExtractRequest, _sender, sendResponse) => {
  if (msg.type !== "EXTRACT_PAGE" && msg.type !== "EXTRACT_SELECTION") {
    return false
  }

  try {
    const result = extractContent(msg.options)
    sendResponse({ ok: true, data: result })
  } catch (err) {
    sendResponse({ ok: false, error: String(err) })
  }

  return true
})
