import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { QuotaRpc, type QuotaResult, type QuotaSnapshot } from "./rpc.js"
import { formatQuota, isOpenAIProvider, OPENAI_PROVIDER_ID } from "./usage.js"

interface FooterState {
  snapshot: QuotaSnapshot | null
  refreshing: boolean
  webOnly?: boolean
}

export default Plugin.define({
  id: "openai-quota.tui",
  setup(context) {
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
            id: "openai-quota.refresh",
            title: "Refresh OpenAI quota",
            description: "Force a fresh OpenAI subscription quota check",
            group: "OpenAI quota",
            palette: true,
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
          <text>
            {!state.webOnly && state.snapshot ? formatQuota(state.snapshot, now()) : "OpenAI: —/—"}
          </text>
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
