import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { QuotaRpc, type QuotaResult, type QuotaSnapshot } from "./rpc.js"
import { formatQuota, isOpenAIProvider, OPENAI_PROVIDER_ID } from "./usage.js"
import { COLOR_KEYS, DEFAULT_SETTINGS, migratePrefix, parseTemplate, renderTemplate, validateColor, type DisplaySettings } from "./presentation.js"

interface FooterState {
  snapshot: QuotaSnapshot | null
  refreshing: boolean
  webOnly?: boolean
}

export default Plugin.define({
  id: "openai-quota.tui",
  async setup(context) {
    const [settings, updateSettings] = context.storage.store<DisplaySettings & { prefix?: string }>("settings", {
      initial: structuredClone(DEFAULT_SETTINGS),
    })
    if (typeof settings.prefix === "string") {
      await updateSettings((draft) => {
        const migrated = migratePrefix({ ...draft, prefix: draft.prefix! })
        delete draft.prefix
        Object.assign(draft, migrated)
      })
    }

    function Display(props: { snapshot: QuotaSnapshot | null; now: number }) {
      const segments = createMemo(() => renderTemplate(settings, props.snapshot, props.now))
      return <text>{segments().map((segment) => <span style={{ fg: segment.color }}>{segment.text}</span>)}</text>
    }

    function showPreview() {
      const now = Date.now()
      const sample: QuotaSnapshot = {
        primaryRemaining: 37, secondaryRemaining: 88, fetchedAt: now,
        primaryResetAt: now + 135 * 60_000, secondaryResetAt: now + 4 * 86_400_000,
      }
      context.ui.dialog.show(() => (
        <box flexDirection="column" padding={1} gap={1}>
          <text>OpenAI quota preview (sample values)</text>
          <Display snapshot={sample} now={now} />
          <text>Escape to close</text>
        </box>
      ))
    }

    async function openSettings(): Promise<void> {
      try {
        while (true) {
          const choice = await context.ui.dialog.select({
            title: "OpenAI quota settings",
            options: [
              { title: "Template", value: "template", description: settings.template || "Hidden" },
              { title: "Default color", value: "defaultColor", description: settings.defaultColor || "Theme default" },
              ...COLOR_KEYS.map((key) => ({ title: `Color: ${key}`, value: key, description: settings.colors[key] || "Default color" })),
              { title: "Preview", value: "preview" },
              { title: "Reset to defaults", value: "reset" },
            ],
          })
          if (choice === undefined) return
          if (choice === "preview") { showPreview(); return }
          if (choice === "reset") {
            if (await context.ui.dialog.confirm({ title: "Reset quota settings?", message: "Restore the default template and colors?" })) {
              await updateSettings((draft) => { Object.assign(draft, structuredClone(DEFAULT_SETTINGS)) })
            }
            continue
          }
          const colorKey = COLOR_KEYS.find((key) => key === choice)
          const isColor = !!colorKey || choice === "defaultColor"
          const current = colorKey ? settings.colors[colorKey] : choice === "defaultColor" ? settings.defaultColor ?? "" : settings.template
          const value = await context.ui.dialog.prompt({
            title: isColor ? `${choice}: #RRGGBB / #RRGGBBAA (empty = ${colorKey ? "default color" : "theme"})` : "Template: {percent5h} {percent7d} {reset5h} {reset7d}",
            value: current,
          })
          if (value === undefined) continue
          try {
            const normalized = isColor ? validateColor(value) : value
            if (choice === "template") parseTemplate(value)
            await updateSettings((draft) => {
              if (colorKey) draft.colors[colorKey] = normalized
              else if (choice === "defaultColor") draft.defaultColor = normalized
              else draft.template = value
            })
          } catch (error) {
            context.ui.toast.show({ message: error instanceof Error ? error.message : "Invalid setting", variant: "warning" })
          }
        }
      } catch {
        context.ui.toast.show({ message: "Could not save quota settings", variant: "warning" })
      }
    }

    const [state, updateState] = context.storage.memory<FooterState>("footer", {
      initial: { snapshot: null, refreshing: false },
    })
    const rawQuota = context.client.rpc(QuotaRpc)
    const quota = {
      cached: async () => (await rawQuota.cached({})) as QuotaResult,
      refresh: async (force: boolean, signal: AbortSignal) =>
        (await rawQuota.refresh({ force }, { signal })) as QuotaResult,
    }

    let selectionGeneration = 0
    let activeRequest:
      | {
          generation: number
          controller: AbortController
          promise: Promise<QuotaResult | undefined>
        }
      | undefined
    let scheduledRefresh: ReturnType<typeof setTimeout> | undefined

    function isOpenAISelected(): boolean {
      return isOpenAIProvider(context.ui.model.current()?.providerID)
    }

    function cancelScheduledRefresh(): void {
      if (!scheduledRefresh) return
      clearTimeout(scheduledRefresh)
      scheduledRefresh = undefined
    }

    function scheduleRefresh(retryInMs: number): void {
      cancelScheduledRefresh()
      const delay = Math.max(1_000, Math.min(2_147_000_000, retryInMs))
      scheduledRefresh = setTimeout(() => {
        scheduledRefresh = undefined
        if (isOpenAISelected()) void refreshQuota(false)
      }, delay)
    }

    function cancelActiveRequest(): void {
      selectionGeneration++
      activeRequest?.controller.abort()
      activeRequest = undefined
      updateState((draft) => {
        draft.refreshing = false
        draft.snapshot = null
        draft.webOnly = false
      })
    }

    function reloadCacheForCurrentConnection(): void {
      cancelScheduledRefresh()
      cancelActiveRequest()
      if (!isOpenAISelected()) return

      const generation = ++selectionGeneration
      void (async () => {
        await loadCached(generation)
        if (generation === selectionGeneration && isOpenAISelected()) await refreshQuota(false)
      })()
    }

    async function loadCached(generation: number): Promise<void> {
      try {
        const cached = await quota.cached()
        if (generation !== selectionGeneration || !isOpenAISelected()) return

        updateState((draft) => {
          draft.webOnly = cached.status === "web_only"
          if (
            cached.snapshot &&
            (!draft.snapshot || cached.snapshot.fetchedAt >= draft.snapshot.fetchedAt)
          ) {
            draft.snapshot = cached.snapshot
          }
        })
      } catch {
        // Keep the footer usable when the server-side plugin is temporarily unavailable.
      }
    }

    async function refreshQuota(force: boolean): Promise<QuotaResult | undefined> {
      if (!isOpenAISelected()) return undefined
      if (force) cancelScheduledRefresh()

      if (activeRequest?.generation === selectionGeneration) {
        return activeRequest.promise
      }

      const generation = selectionGeneration
      const controller = new AbortController()
      updateState((draft) => {
        draft.refreshing = true
      })

      const promise = (async (): Promise<QuotaResult | undefined> => {
        try {
          const refreshed = await quota.refresh(force, controller.signal)
          if (generation !== selectionGeneration || !isOpenAISelected()) return undefined

          updateState((draft) => {
            draft.refreshing = false
            draft.snapshot = refreshed.snapshot
            draft.webOnly = refreshed.status === "web_only"
          })

          if (
            !force &&
            refreshed.retryInMs !== null &&
            ["throttled", "cooldown", "failed"].includes(refreshed.status)
          ) {
            scheduleRefresh(refreshed.retryInMs)
          } else if (refreshed.status === "ok") {
            cancelScheduledRefresh()
          }

          return refreshed
        } catch {
          if (generation !== selectionGeneration || !isOpenAISelected()) return undefined
          updateState((draft) => {
            draft.refreshing = false
          })
          return undefined
        } finally {
          if (activeRequest?.controller === controller) activeRequest = undefined
        }
      })()

      activeRequest = { generation, controller, promise }
      return promise
    }

    function reportManualRefresh(result: QuotaResult | undefined): void {
      if (!isOpenAISelected()) return

      if (result?.status === "ok" && result.snapshot) {
        context.ui.toast.show({
          message: `Updated ${formatQuota(result.snapshot)}`,
          variant: "success",
          duration: 2_500,
        })
        return
      }

      const message = result?.message ?? "Could not update the OpenAI quota"
      context.ui.toast.show({ message, variant: result?.status === "web_only" ? "info" : "warning", duration: result?.status === "web_only" ? 12_000 : 4_000 })
    }

    const stopExecutionListener = context.data.on("session.execution.succeeded", () => {
      if (isOpenAISelected()) void refreshQuota(false)
    })
    const stopCredentialListener = context.data.on("credential.updated", () => {
      if (isOpenAISelected()) reloadCacheForCurrentConnection()
    })
    const stopConnectionListener = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID === "openai" && isOpenAISelected()) {
        reloadCacheForCurrentConnection()
      }
    })

    function ModelSelectionWatcher() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "openai-quota.settings",
            title: "Settings",
            group: "OpenAI quota",
            palette: true,
            run: openSettings,
          },
          {
            id: "openai-quota.refresh",
            title: "Refresh OpenAI quota",
            description: "Force a fresh OpenAI subscription quota check",
            group: "OpenAI quota",
            slash: { name: "quota" },
            run: async () => {
              if (!isOpenAISelected()) {
                context.ui.toast.show({
                  message: "Select an OpenAI model to check its quota",
                  variant: "info",
                })
                return
              }
              reportManualRefresh(await refreshQuota(true))
            },
          },
        ],
        bindings: ["openai-quota.refresh"],
      }))

      const providerID = createMemo(() => context.ui.model.current()?.providerID)

      createEffect(() => {
        if (!isOpenAIProvider(providerID())) {
          cancelScheduledRefresh()
          cancelActiveRequest()
          return
        }

        const generation = ++selectionGeneration
        updateState((draft) => {
          draft.snapshot = null
          draft.webOnly = false
        })
        void loadCached(generation)
      })

      return null
    }

    function FooterStatus() {
      const selected = createMemo(() => context.ui.model.current()?.providerID === OPENAI_PROVIDER_ID)
      const [now, setNow] = createSignal(Date.now())

      createEffect(() => {
        if (!selected() || !state.snapshot) return
        if (state.snapshot.primaryResetAt == null && state.snapshot.secondaryResetAt == null) return
        setNow(Date.now())
        // Only redraw the countdown; this timer must never request quota or resolve credentials.
        const timer = setInterval(() => setNow(Date.now()), 30_000)
        onCleanup(() => clearInterval(timer))
      })

      return (
        <Show when={selected()}>
          <Display snapshot={state.webOnly ? null : state.snapshot} now={now()} />
        </Show>
      )
    }

    const removeWatcher = context.ui.slot({
      append: "app",
      render: () => <ModelSelectionWatcher />,
    })
    const removePromptFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <FooterStatus />,
    })

    return () => {
      stopExecutionListener()
      stopCredentialListener()
      stopConnectionListener()
      removeWatcher()
      removePromptFooter()
      cancelScheduledRefresh()
      selectionGeneration++
      activeRequest?.controller.abort()
    }
  },
})
