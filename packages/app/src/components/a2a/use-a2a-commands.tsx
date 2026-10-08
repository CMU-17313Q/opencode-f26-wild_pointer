import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

// Directory-scoped A2A entry points. Registered where the session's SDK is in
// context so the hub dialog can resolve `useSDK()` from the pusher's owner.
export function useA2ACommands() {
  const command = useCommand()
  const language = useLanguage()
  const dialog = useDialog()

  const open = (initialView: "start" | "browse") => {
    void import("@/components/a2a/dialog-a2a-hub").then((module) => {
      dialog.show(() => <module.DialogA2AHub initialView={initialView} />)
    })
  }

  command.register("a2a", () => [
    {
      id: "a2a.new",
      title: language.t("command.a2a.new"),
      category: language.t("command.category.a2a"),
      onSelect: () => open("start"),
    },
    {
      id: "a2a.sessions",
      title: language.t("command.a2a.sessions"),
      category: language.t("command.category.a2a"),
      onSelect: () => open("browse"),
    },
  ])
}
