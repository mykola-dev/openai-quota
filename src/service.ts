import {
  createAccountKey,
  extractAccountScope,
  extractChatGptAccountId,
  parseRetryAfter,
  parseUsageResponse,
  USAGE_ENDPOINT,
  isTokenSharingCredential,
  WEB_ONLY_MESSAGE,
  type QuotaSnapshot,
} from "./usage.js"
import type { QuotaResult } from "./rpc.js"

const CACHE_PREFIX = "cache:"
const DEBUG_KEY = "debug:stats"
const MIN_INTERVAL_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_AUTOMATIC_BACKOFF_MS = 15 * 60_000

function isRemainingPercent(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
}

export interface OAuthCredential {
  connectionId: string
  accessToken: string
  scopes?: readonly string[]
  accountId?: string
}

export interface QuotaServiceDependencies {
  getCredential(): Promise<OAuthCredential | undefined>
  get(key: string): Promise<unknown>
  set(key: string, value: string): Promise<void>
  fetch?: typeof fetch
  now?: () => number
}

interface DebugStats {
  attempts: number
  successes: number
  failures: number
  cancelled: number
  consecutiveFailures: number
  lastAttemptAt: number | null
  lastStatus: string | null
  automaticBlockedUntil: number | null
  retryAfterUntil: number | null
  authBlocked: boolean
  authTokenKey?: string
}

const EMPTY_STATS: DebugStats = {
  attempts: 0,
  successes: 0,
  failures: 0,
  cancelled: 0,
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastStatus: null,
  automaticBlockedUntil: null,
  retryAfterUntil: null,
  authBlocked: false,
}

function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as Partial<QuotaSnapshot>
  return (
    isRemainingPercent(snapshot.primaryRemaining) &&
    isRemainingPercent(snapshot.secondaryRemaining) &&
    (snapshot.primaryResetAt == null || (Number.isSafeInteger(snapshot.primaryResetAt) && snapshot.primaryResetAt >= 0)) &&
    (snapshot.secondaryResetAt == null || (Number.isSafeInteger(snapshot.secondaryResetAt) && snapshot.secondaryResetAt >= 0)) &&
    typeof snapshot.fetchedAt === "number" &&
    Number.isSafeInteger(snapshot.fetchedAt) && snapshot.fetchedAt >= 0
  )
}

function parseStored<T>(value: unknown, validate: (candidate: unknown) => candidate is T): T | undefined {
  if (typeof value !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return validate(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isDebugStats(value: unknown): value is DebugStats {
  if (!value || typeof value !== "object") return false
  const stats = value as Partial<DebugStats>
  return (
    typeof stats.attempts === "number" &&
    typeof stats.successes === "number" &&
    typeof stats.failures === "number" &&
    typeof stats.cancelled === "number" &&
    typeof stats.consecutiveFailures === "number" &&
    (typeof stats.lastAttemptAt === "number" || stats.lastAttemptAt === null) &&
    (typeof stats.lastStatus === "string" || stats.lastStatus === null) &&
    (typeof stats.automaticBlockedUntil === "number" || stats.automaticBlockedUntil === null) &&
    (typeof stats.retryAfterUntil === "number" || stats.retryAfterUntil === null) &&
    typeof stats.authBlocked === "boolean"
  )
}

function result(
  status: QuotaResult["status"],
  snapshot: QuotaSnapshot | null,
  retryInMs: number | null = null,
  message: string | null = null,
): QuotaResult {
  return { status, snapshot, retryInMs, message }
}

function messageForHttpStatus(status: number): string {
  if (status === 401) return "OpenAI quota endpoint rejected this sign-in (HTTP 401); inference may still work"
  if (status === 403) return "OpenAI quota access is forbidden (HTTP 403); check account permissions or restrictions"
  return `Usage endpoint returned HTTP ${status}`
}

export function createQuotaService(dependencies: QuotaServiceDependencies) {
  const fetchImpl = dependencies.fetch ?? fetch
  const now = dependencies.now ?? Date.now
  let inFlight: { accountKey: string; promise: Promise<QuotaResult> } | undefined

  async function readStats(accountKey: string): Promise<DebugStats> {
    try {
      return parseStored(await dependencies.get(`${DEBUG_KEY}:${accountKey}`), isDebugStats) ?? { ...EMPTY_STATS }
    } catch {
      return { ...EMPTY_STATS }
    }
  }

  async function writeStats(accountKey: string, stats: DebugStats): Promise<void> {
    try {
      await dependencies.set(`${DEBUG_KEY}:${accountKey}`, JSON.stringify(stats))
      await dependencies.set(DEBUG_KEY, JSON.stringify(stats))
    } catch {
      // Debug counters must never prevent a quota read or refresh.
    }
  }

  async function cacheFor(accountKey: string): Promise<QuotaSnapshot | null> {
    try {
      return parseStored(await dependencies.get(`${CACHE_PREFIX}${accountKey}`), isQuotaSnapshot) ?? null
    } catch {
      return null
    }
  }

  async function writeCache(accountKey: string, snapshot: QuotaSnapshot): Promise<void> {
    try {
      await dependencies.set(`${CACHE_PREFIX}${accountKey}`, JSON.stringify(snapshot))
    } catch {
      // The response is still useful for this run if durable storage is unavailable.
    }
  }

  async function currentCredential(): Promise<
    | { credential: OAuthCredential; accountKey: string; accountId?: string }
    | undefined
  > {
    const credential = await dependencies.getCredential()
    if (!credential?.accessToken || !credential.connectionId) return undefined
    const accountId = credential.accountId || extractChatGptAccountId(credential.accessToken)
    const accountScope = accountId ? `account:${accountId}` : extractAccountScope(credential.accessToken)
    return {
      credential,
      accountId,
      accountKey: createAccountKey(
        credential.connectionId,
        accountScope ?? `token:${credential.accessToken}`,
      ),
    }
  }

  async function cached(): Promise<QuotaResult> {
    try {
      const active = await currentCredential()
      if (!active) return result("unavailable", null, null, "OpenAI ChatGPT OAuth is not connected")
      if (isTokenSharingCredential(active.credential.accessToken, active.credential.scopes)) {
        return result("web_only", null, null, WEB_ONLY_MESSAGE)
      }
      return result("ok", await cacheFor(active.accountKey))
    } catch {
      return result("unavailable", null, null, "OpenAI ChatGPT OAuth is not connected")
    }
  }

  async function refresh(input: { force: boolean }, signal?: AbortSignal): Promise<QuotaResult> {
    let active: Awaited<ReturnType<typeof currentCredential>>
    try {
      active = await currentCredential()
    } catch {
      return result("unavailable", null, null, "Could not read the active OpenAI connection")
    }

    if (!active) return result("unavailable", null, null, "OpenAI ChatGPT OAuth is not connected")
    if (isTokenSharingCredential(active.credential.accessToken, active.credential.scopes)) {
      return result("web_only", null, null, WEB_ONLY_MESSAGE)
    }

    const snapshot = await cacheFor(active.accountKey)
    if (signal?.aborted) return result("failed", snapshot, null, "Refresh was cancelled")

    if (inFlight) {
      if (inFlight.accountKey === active.accountKey) {
        return checkCurrentCredential(active, await inFlight.promise)
      }
      const stats = await readStats(active.accountKey)
      return result("throttled", snapshot, Math.max(0, (stats.lastAttemptAt ?? now()) + MIN_INTERVAL_MS - now()))
    }

    const promise = performRefresh(active, snapshot, input.force, signal)
    inFlight = { accountKey: active.accountKey, promise }
    try {
      const refreshed = await promise
      return await checkCurrentCredential(active, refreshed)
    } finally {
      if (inFlight?.promise === promise) inFlight = undefined
    }
  }

  async function checkCurrentCredential(
    active: NonNullable<Awaited<ReturnType<typeof currentCredential>>>,
    refreshed: QuotaResult,
  ): Promise<QuotaResult> {
    let latest: Awaited<ReturnType<typeof currentCredential>>
    try {
      latest = await currentCredential()
    } catch {
      return result("unavailable", null, null, "Could not read the active OpenAI connection")
    }
    if (!latest || latest.accountKey !== active.accountKey || latest.credential.accessToken !== active.credential.accessToken) {
      return result("failed", null, 1_000, "OpenAI connection changed during the quota request")
    }
    return refreshed
  }

  async function performRefresh(
    active: NonNullable<Awaited<ReturnType<typeof currentCredential>>>,
    previousSnapshot: QuotaSnapshot | null,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<QuotaResult> {
    const currentTime = now()
    const stats = await readStats(active.accountKey)
    const authTokenKey = createAccountKey(active.accountKey, active.credential.accessToken)
    if (stats.authTokenKey !== authTokenKey) stats.authBlocked = false
    stats.authTokenKey = authTokenKey

    // Preserve server-requested cooldowns across account switches and plugin upgrades.
    const globalStats = parseStored(await dependencies.get(DEBUG_KEY).catch(() => undefined), isDebugStats)
    if (globalStats?.retryAfterUntil != null && globalStats.retryAfterUntil > currentTime) {
      return result("cooldown", previousSnapshot, globalStats.retryAfterUntil - currentTime, "OpenAI asked the client to wait")
    }

    if (stats.retryAfterUntil !== null && stats.retryAfterUntil > currentTime) {
      return result("cooldown", previousSnapshot, stats.retryAfterUntil - currentTime, "OpenAI asked the client to wait")
    }

    if (!force && stats.authBlocked) {
      return result("auth_required", previousSnapshot, null, "Use /quota after reconnecting OpenAI")
    }

    if (!force && stats.automaticBlockedUntil !== null && stats.automaticBlockedUntil > currentTime) {
      return result("cooldown", previousSnapshot, stats.automaticBlockedUntil - currentTime, "Automatic retry is paused")
    }

    const minimumIntervalEnds = (stats.lastAttemptAt ?? 0) + MIN_INTERVAL_MS
    if (!force && stats.lastAttemptAt !== null && minimumIntervalEnds > currentTime) {
      return result("throttled", previousSnapshot, minimumIntervalEnds - currentTime)
    }

    stats.attempts++
    stats.lastAttemptAt = currentTime
    stats.lastStatus = "pending"
    await writeStats(active.accountKey, stats)

    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    const abortFromCaller = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abortFromCaller, { once: true })
    if (signal?.aborted) abortFromCaller()

    try {
      controller.signal.throwIfAborted()
      const headers: Record<string, string> = {
        Authorization: `Bearer ${active.credential.accessToken}`,
        Accept: "application/json",
      }
      if (active.accountId) headers["ChatGPT-Account-Id"] = active.accountId

      const response = await fetchImpl(USAGE_ENDPOINT, {
        method: "GET",
        headers,
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      })

      if (!response.ok) {
        stats.failures++
        stats.lastStatus = `http_${response.status}`
        stats.consecutiveFailures++

        if (response.status === 401 || response.status === 403) {
          stats.authBlocked = true
          stats.automaticBlockedUntil = null
          await writeStats(active.accountKey, stats)
          return result("auth_required", previousSnapshot, null, messageForHttpStatus(response.status))
        }

        if (response.status === 429) {
          stats.retryAfterUntil =
            parseRetryAfter(response.headers.get("retry-after"), now()) ?? now() + MIN_INTERVAL_MS
          stats.automaticBlockedUntil = null
          await writeStats(active.accountKey, stats)
          return result("cooldown", previousSnapshot, stats.retryAfterUntil - now(), messageForHttpStatus(response.status))
        }

        const backoff = Math.min(
          MAX_AUTOMATIC_BACKOFF_MS,
          MIN_INTERVAL_MS * 2 ** Math.min(stats.consecutiveFailures - 1, 4),
        )
        stats.automaticBlockedUntil = now() + backoff
        await writeStats(active.accountKey, stats)
        return result("failed", previousSnapshot, stats.automaticBlockedUntil - now(), messageForHttpStatus(response.status))
      }

      const body: unknown = await response.json()
      const updated = parseUsageResponse(body, now())
      await writeCache(active.accountKey, updated)

      stats.successes++
      stats.consecutiveFailures = 0
      stats.lastStatus = `http_${response.status}`
      stats.automaticBlockedUntil = null
      stats.retryAfterUntil = null
      stats.authBlocked = false
      await writeStats(active.accountKey, stats)

      return result("ok", updated)
    } catch {
      if (signal?.aborted && !timedOut) {
        stats.cancelled++
        stats.lastStatus = "cancelled"
        await writeStats(active.accountKey, stats)
        return result("failed", previousSnapshot, null, "Refresh was cancelled")
      }

      stats.failures++
      stats.consecutiveFailures++
      stats.lastStatus = timedOut ? "timeout" : "network_or_invalid_response"

      const backoff = Math.min(
        MAX_AUTOMATIC_BACKOFF_MS,
        MIN_INTERVAL_MS * 2 ** Math.min(stats.consecutiveFailures - 1, 4),
      )
      stats.automaticBlockedUntil = now() + backoff
      await writeStats(active.accountKey, stats)

      const message = timedOut ? "Quota request timed out" : signal?.aborted ? "Refresh was cancelled" : "Quota request failed"
      return result("failed", previousSnapshot, stats.automaticBlockedUntil - now(), message)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abortFromCaller)
    }
  }

  return { cached, refresh }
}
