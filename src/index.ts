import { Plugin } from "@opencode/plugin"
import { QuotaRpc } from "./rpc.js"
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

    const registration = await context.rpc.register(QuotaRpc, {
      cached: async () => service.cached(),
      refresh: async (input, rpcContext) =>
        service.refresh(input as { force: boolean }, rpcContext.signal),
    })

    return () => registration.dispose()
  },
})
