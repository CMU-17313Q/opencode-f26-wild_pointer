import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createMemo, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { ADMIN_PORT_PATH, A2AControlError, createA2AControl, pluginIdentityFromConfig, type A2APeer, type A2ASelf } from "@/a2a/control"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// Peers dashboard: the settings-side companion to the hub dialog. It talks to
// the same loopback control API, but resolves its directory SDK from the server
// SDK so it also works when settings is opened outside a session (home).
export const SettingsA2AV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()

  const dir = createMemo(() => {
    if (!props.directory) return undefined
    return serverSDK().ensureDirSdkContext(props.directory)
  })

  const control = createMemo(() => {
    const sdk = dir()
    if (!sdk) return undefined
    return createA2AControl({
      directory: sdk.directory,
      readPort: () =>
        sdk.client.file
          .read({ path: ADMIN_PORT_PATH })
          .then((result) => result.data?.content)
          .catch(() => undefined),
    })
  })

  const [store, setStore] = createStore({
    loading: true,
    running: false,
    peers: [] as A2APeer[],
    form: { name: "", url: "" },
    adding: false,
    removing: "",
    busy: "",
    testNames: {} as Record<string, string>,
    testDescriptions: {} as Record<string, string>,
    testErrors: {} as Record<string, boolean>,
    identity: undefined as string | undefined,
    identityRead: false,
    self: undefined as A2ASelf | undefined,
  })

  const errorText = (error: unknown) => {
    if (error instanceof A2AControlError) {
      if (error.kind === "port") return language.t("a2a.error.port")
      if (error.kind === "network") return language.t("a2a.error.network")
      return error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  const load = async () => {
    const client = control()
    if (!client) {
      setStore({ loading: false, running: false, identityRead: true })
      return
    }
    setStore("loading", true)
    try {
      const [peers, self] = await Promise.all([client.listPeers(), client.self().catch(() => undefined)])
      setStore({ peers, self, running: true, loading: false })
    } catch {
      setStore({ peers: [], self: undefined, running: false, loading: false })
    }
  }

  const loadIdentity = async () => {
    const sdk = dir()
    if (!sdk) {
      setStore("identityRead", true)
      return
    }
    const text = await sdk.client.file
      .read({ path: "opencode.json" })
      .then((result) => result.data?.content)
      .catch(() => undefined)
    if (text === undefined) return
    setStore({ identity: pluginIdentityFromConfig(text), identityRead: true })
  }

  onMount(() => {
    void load()
    void loadIdentity()
  })

  const addPeer = async () => {
    const name = store.form.name.trim()
    const url = store.form.url.trim()
    if (name === "" || url === "") {
      showToast({ title: language.t("a2a.settings.peers.invalid") })
      return
    }
    const client = control()
    if (!client) return
    setStore("adding", true)
    try {
      const peers = await client.addPeer(name, url)
      setStore({ peers, form: { name: "", url: "" } })
    } catch (error) {
      showToast({ title: language.t("a2a.settings.peers.add.error"), description: errorText(error) })
    } finally {
      setStore("adding", false)
    }
  }

  const removePeer = async (name: string) => {
    const client = control()
    if (!client) return
    setStore("busy", name)
    try {
      const peers = await client.removePeer(name)
      setStore({ peers, removing: "" })
    } catch (error) {
      showToast({ title: language.t("a2a.settings.peers.remove.error"), description: errorText(error) })
    } finally {
      setStore("busy", "")
    }
  }

  const testPeer = async (name: string) => {
    const client = control()
    if (!client) return
    setStore("busy", name)
    setStore("testErrors", name, false)
    try {
      const result = await client.testPeer(name)
      setStore("testNames", name, result.name)
      setStore("testDescriptions", name, result.description)
    } catch (error) {
      setStore("testErrors", name, true)
      showToast({ title: language.t("a2a.settings.peers.test.error"), description: errorText(error) })
    } finally {
      setStore("busy", "")
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("a2a.settings.title")}</h2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={props.directory} fallback={<span class="text-12-regular text-text-weak">{language.t("a2a.settings.noDirectory")}</span>}>
          <Show when={!store.loading && !store.running}>
            <div class="text-12-regular text-text-weak">{language.t("a2a.settings.disabled")}</div>
          </Show>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("a2a.settings.status.title")}</h3>
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("a2a.settings.status.label")}
                description={language.t("a2a.settings.status.description")}
              >
                <span class="text-12-regular text-text-strong">
                  {store.loading
                    ? language.t("a2a.settings.status.checking")
                    : store.running
                      ? language.t("a2a.settings.status.running")
                      : language.t("a2a.settings.status.offline")}
                </span>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("a2a.settings.peers.title")}
                description={language.t("a2a.settings.peers.description")}
              >
                <span class="text-12-regular text-text-strong">{store.peers.length}</span>
              </SettingsRowV2>
              <Show when={store.self?.url}>
                <SettingsRowV2
                  title={language.t("a2a.settings.self.label")}
                  description={language.t("a2a.settings.self.description")}
                >
                  <span class="break-all font-mono text-11-regular text-text-strong">
                    {store.self?.name ? `"${store.self.name}": "${store.self.url}"` : store.self?.url}
                  </span>
                </SettingsRowV2>
              </Show>
              <SettingsRowV2
                title={language.t("a2a.settings.identity.title")}
                description={language.t("a2a.settings.identity.description")}
              >
                <span class="text-12-regular text-text-strong">
                  {store.identity !== undefined
                    ? store.identity
                    : store.identityRead
                      ? language.t("a2a.settings.identity.unknown")
                      : language.t("a2a.settings.identity.hint")}
                </span>
              </SettingsRowV2>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("a2a.settings.peers.title")}</h3>
            <SettingsListV2>
              <Show
                when={store.peers.length > 0}
                fallback={<div class="px-3 py-2 text-12-regular text-text-weak">{language.t("a2a.settings.peers.empty")}</div>}
              >
                <For each={store.peers}>
                  {(peer) => (
                    <div class="flex flex-col gap-1 px-3 py-2">
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 flex-col">
                          <span class="truncate text-12-medium text-text-strong">{peer.name}</span>
                          <span class="truncate text-11-regular text-text-weak">{peer.url}</span>
                        </div>
                        <div class="flex shrink-0 items-center gap-1">
                          <ButtonV2
                            size="small"
                            variant="ghost"
                            disabled={store.busy === peer.name}
                            onClick={() => void testPeer(peer.name)}
                          >
                            {language.t("a2a.settings.peers.test")}
                          </ButtonV2>
                          <Show
                            when={store.removing === peer.name}
                            fallback={
                              <ButtonV2 size="small" variant="ghost" onClick={() => setStore("removing", peer.name)}>
                                {language.t("a2a.settings.peers.remove")}
                              </ButtonV2>
                            }
                          >
                            <span class="text-11-regular text-text-weak">
                              {language.t("a2a.settings.peers.remove.confirm", { name: peer.name })}
                            </span>
                            <ButtonV2
                              size="small"
                              variant="danger"
                              disabled={store.busy === peer.name}
                              onClick={() => void removePeer(peer.name)}
                            >
                              {language.t("a2a.settings.peers.remove")}
                            </ButtonV2>
                            <ButtonV2 size="small" variant="ghost" onClick={() => setStore("removing", "")}>
                              {language.t("common.cancel")}
                            </ButtonV2>
                          </Show>
                        </div>
                      </div>
                      <Show when={store.testErrors[peer.name]}>
                        <span class="text-11-regular text-icon-warning-base">
                          {language.t("a2a.settings.peers.test.error")}
                        </span>
                      </Show>
                      <Show when={store.testNames[peer.name]}>
                        <span class="text-11-regular text-text-weak">
                          {store.testNames[peer.name]}
                          {store.testDescriptions[peer.name] ? ` — ${store.testDescriptions[peer.name]}` : ""}
                        </span>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </SettingsListV2>
          </div>

          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("a2a.settings.peers.add")}</h3>
            <div class="flex flex-wrap items-end gap-2">
              <TextInputV2
                appearance="base"
                value={store.form.name}
                placeholder={language.t("a2a.settings.peers.name.placeholder")}
                aria-label={language.t("a2a.settings.peers.name")}
                onInput={(event) => setStore("form", "name", event.currentTarget.value)}
              />
              <TextInputV2
                appearance="base"
                value={store.form.url}
                placeholder={language.t("a2a.settings.peers.url.placeholder")}
                aria-label={language.t("a2a.settings.peers.url")}
                onInput={(event) => setStore("form", "url", event.currentTarget.value)}
              />
              <ButtonV2
                size="small"
                variant="contrast"
                disabled={store.adding || store.form.name.trim() === "" || store.form.url.trim() === ""}
                onClick={() => void addPeer()}
              >
                {language.t("a2a.settings.peers.add")}
              </ButtonV2>
            </div>
          </div>
        </Show>
      </div>
    </>
  )
}
