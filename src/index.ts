import { Plugin } from "@opencode/plugin"
import { QuotaRpc } from "./rpc.js"
import { createResetAlarm, createResetSoundClaim } from "./reset-alarm.js"
import { createQuotaService } from "./service.js"

export default Plugin.define({
  id: "openai-quota.server",
  async setup(context) {
    const service = createQuotaService({
      getCredential: async () => {
        const connection = await context.integration.connection.active("openai")
        if (!connection || connection.type !== "credential") return undefined

        const credential = await context.integration.connection.resolve(connection)
        if (!credential || credential.type !== "oauth" || !credential.access) return undefined

        return {
          connectionId: connection.id,
          accessToken: credential.access,
          accountId: typeof credential.metadata?.accountID === "string" ? credential.metadata.accountID : undefined,
          scopes: Array.isArray(credential.metadata?.scopes)
            ? credential.metadata.scopes.filter((scope): scope is string => typeof scope === "string")
            : [],
        }
      },
      get: async (key) => context.storage.get(key),
      set: async (key, value) => context.storage.set(key, value),
    })

    let emitReset: (event: { eventID: string; resetAt: number }) => Promise<void> = async () => {}
    const resetAlarm = createResetAlarm({
      emit: (event) => emitReset(event),
      onError: (error) => console.error("[openai-quota] Could not emit reset notification", error),
    })
    const startup = await service.cached()

    const claimResetSound = createResetSoundClaim()
    const registration = await context.rpc.register(QuotaRpc, {
      cached: async () => {
        const result = await service.cached()
        resetAlarm.schedule(result.snapshot?.primaryResetAt)
        return result
      },
      refresh: async (input, rpcContext) => {
        const result = await service.refresh(input as { force: boolean }, rpcContext.signal)
        resetAlarm.schedule(result.snapshot?.primaryResetAt)
        return result
      },
      claimSound: async (input) => {
        const { eventID } = input as { eventID: string }
        return { claimed: claimResetSound(eventID) }
      },
    })
    emitReset = (event) => registration.events.emit("primary_reset", event)
    resetAlarm.schedule(startup.snapshot?.primaryResetAt)

    return () => {
      resetAlarm.cancel()
      return registration.dispose()
    }
  },
})
