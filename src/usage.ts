import { createHash } from "node:crypto"

export const OPENAI_PROVIDER_ID = "openai"
export const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
export const USAGE_SETTINGS_URL = "https://chatgpt.com/settings/usage"
export const WEB_ONLY_MESSAGE = `This ChatGPT sign-in does not expose quota percentages. Check ${USAGE_SETTINGS_URL} (verify the browser account). Signing in again is not required.`

export function isOpenAIProvider(providerID: string | undefined): boolean {
  return providerID === OPENAI_PROVIDER_ID
}

export interface QuotaSnapshot {
  primaryRemaining: number | null
  secondaryRemaining: number | null
  primaryResetAt?: number | null
  secondaryResetAt?: number | null
  fetchedAt: number
}

interface UsageWindow {
  used_percent?: unknown
  reset_at?: unknown
  reset_after_seconds?: unknown
}

interface UsageResponse {
  rate_limit?: {
    primary_window?: UsageWindow | null
    secondary_window?: UsageWindow | null
  } | null
}

function remainingPercent(window: UsageWindow | null | undefined): number | null {
  const used = window?.used_percent
  if (typeof used !== "number" || !Number.isFinite(used)) return null
  return Math.max(0, Math.min(100, Math.round(100 - used)))
}

function resetTimestamp(window: UsageWindow | null | undefined, fetchedAt: number): number | null {
  const absolute = window?.reset_at
  if (typeof absolute === "number" && Number.isFinite(absolute) && absolute >= 0) {
    const timestamp = Math.round(absolute * 1000)
    if (Number.isSafeInteger(timestamp)) return timestamp
  }

  const relative = window?.reset_after_seconds
  if (typeof relative === "number" && Number.isFinite(relative) && relative >= 0) {
    const timestamp = Math.round(fetchedAt + relative * 1000)
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp
  }
  return null
}

export function parseUsageResponse(payload: unknown, fetchedAt = Date.now()): QuotaSnapshot {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid usage response")
  }

  const usage = payload as UsageResponse
  const primary = remainingPercent(usage.rate_limit?.primary_window)
  const secondary = remainingPercent(usage.rate_limit?.secondary_window)

  if (primary === null && secondary === null) {
    throw new Error("Usage response has no supported quota windows")
  }

  return {
    primaryRemaining: primary,
    secondaryRemaining: secondary,
    primaryResetAt: resetTimestamp(usage.rate_limit?.primary_window, fetchedAt),
    secondaryResetAt: resetTimestamp(usage.rate_limit?.secondary_window, fetchedAt),
    fetchedAt,
  }
}

export function formatResetCountdown(resetAt: number | null | undefined, now = Date.now()): string {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt < 0) return "—"

  const remainingMs = Math.max(0, resetAt - now)
  const dayMs = 24 * 60 * 60_000
  if (remainingMs >= dayMs) return `${Math.floor(remainingMs / dayMs)}d`

  const minutes = Math.ceil(remainingMs / 60_000)
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0")
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`
}

export function formatQuota(snapshot: QuotaSnapshot, now = Date.now()): string {
  const primary = snapshot.primaryRemaining === null ? "—" : `${snapshot.primaryRemaining}%`
  const secondary = snapshot.secondaryRemaining === null ? "—" : `${snapshot.secondaryRemaining}%`
  const status = `OpenAI: ${primary}/${secondary}`
  if (snapshot.primaryResetAt == null && snapshot.secondaryResetAt == null) return status
  return `${status} ${formatResetCountdown(snapshot.primaryResetAt, now)}/${formatResetCountdown(snapshot.secondaryResetAt, now)}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined

  try {
    return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
  } catch {
    return undefined
  }
}

export function isTokenSharingCredential(accessToken: string, scopes: readonly string[] = []): boolean {
  const payload = decodeJwtPayload(accessToken)
  const scope = typeof payload?.scope === "string" ? payload.scope.split(/\s+/) : []
  const scp = Array.isArray(payload?.scp) ? payload.scp : []
  return [...scopes, ...scope, ...scp].includes("chatgpt.tokens.use.direct")
}

export function extractChatGptAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  if (!payload) return undefined

  const auth = record(payload["https://api.openai.com/auth"])
  const candidate = auth?.chatgpt_account_id ?? payload.chatgpt_account_id
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

export function extractAccountScope(accessToken: string): string | undefined {
  const accountId = extractChatGptAccountId(accessToken)
  if (accountId) return `account:${accountId}`

  const payload = decodeJwtPayload(accessToken)
  return typeof payload?.sub === "string" && payload.sub.length > 0 ? `subject:${payload.sub}` : undefined
}

export function createAccountKey(connectionId: string, accountId?: string): string {
  return createHash("sha256")
    .update(`${connectionId}:${accountId ?? "unknown-account"}`)
    .digest("hex")
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(now, timestamp) : null
}
