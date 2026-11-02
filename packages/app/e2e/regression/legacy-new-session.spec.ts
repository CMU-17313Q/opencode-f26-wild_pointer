import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_legacy_new_session"
const directory = "C:/OpenCode/LegacyNewSession"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

// The old interface was retired on 2026-09-14 (`oldInterfaceSunset` in
// src/context/settings.tsx), so a persisted `newLayoutDesigns: false` is no
// longer honored — `resolveNewLayoutDesigns` returns true once retired.
//
// `/new-session?draftId=…` is still the URL older clients wrote to their tab
// storage, so what is worth guarding is that such a URL keeps resolving to a
// usable draft instead of dead-ending.
test("opens a draft from a legacy new-session URL", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_legacy_new_session",
      worktree: directory,
      vcs: "git",
      name: "legacy-new-session",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)

  // The draft resolves in place rather than redirecting to the retired
  // `/:dir/session` route.
  await expect(page).toHaveURL(new RegExp(`/new-session\\?draftId=${draftID}$`))
  await expect(page.locator("header[data-tauri-drag-region]")).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})
