import assert from "node:assert/strict"
import { test } from "node:test"
import { createQuotaService, type OAuthCredential } from "../src/service.js"
import { isTokenSharingCredential, USAGE_SETTINGS_URL } from "../src/usage.js"

const token = (claims: Record<string, unknown>) => `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`
const legacy = (id: string, version = 1): OAuthCredential => ({
  connectionId: id,
  accessToken: token({ sub: id, version, "https://api.openai.com/auth": { chatgpt_account_id: id } }),
})
const usage = () => Response.json({ rate_limit: { primary_window: { used_percent: 25 }, secondary_window: { used_percent: 10 } } })

function fixture() {
  const store = new Map<string, string>()
  let credential: OAuthCredential | undefined = legacy("a")
  let now = 1_000_000
  let calls = 0
  let respond: (init?: RequestInit) => Promise<Response> = async () => usage()
  const service = createQuotaService({
    getCredential: async () => credential,
    get: async (key) => store.get(key),
    set: async (key, value) => { store.set(key, value) },
    now: () => now,
    fetch: (async (_url, init) => { calls++; return respond(init) }) as typeof fetch,
  })
  return { service, store, setCredential: (value: OAuthCredential | undefined) => { credential = value },
    advance: () => { now += 61_000 }, calls: () => calls,
    respond: (value: typeof respond) => { respond = value } }
}

test("detects native scopes in JWT string, array, and OAuth metadata", () => {
  assert.equal(isTokenSharingCredential(token({ scope: "openid chatgpt.tokens.use.direct" })), true)
  assert.equal(isTokenSharingCredential(token({ scp: ["chatgpt.tokens.use.direct"] })), true)
  assert.equal(isTokenSharingCredential("opaque", ["chatgpt.tokens.use.direct"]), true)
  assert.equal(isTokenSharingCredential(legacy("a").accessToken), false)
  assert.equal(isTokenSharingCredential("malformed"), false)
})

test("native sign-in exposes web-only status without any usage HTTP request, even forced", async () => {
  const f = fixture()
  f.setCredential({ connectionId: "native", accessToken: token({ scope: "chatgpt.tokens.use.direct" }) })
  for (const result of [await f.service.cached(), await f.service.refresh({ force: false }), await f.service.refresh({ force: true })]) {
    assert.equal(result.status, "web_only")
    assert.equal(result.snapshot, null)
    assert.ok(result.message?.includes(USAGE_SETTINGS_URL))
    assert.equal(result.retryInMs, null)
  }
  assert.equal(f.calls(), 0)
})

test("legacy OAuth still fetches percentages, caches per account, and sends its account header", async () => {
  const f = fixture()
  f.respond(async (init) => { assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "a"); return usage() })
  const result = await f.service.refresh({ force: false })
  assert.equal(result.snapshot?.primaryRemaining, 75)
  assert.equal((await f.service.cached()).snapshot?.secondaryRemaining, 90)
  f.setCredential(legacy("b"))
  assert.equal((await f.service.cached()).snapshot, null)
})

test("401 for A does not auth-block or throttle B", async () => {
  const f = fixture()
  f.respond(async () => new Response(null, { status: 401 }))
  assert.equal((await f.service.refresh({ force: false })).status, "auth_required")
  f.setCredential(legacy("b"))
  f.respond(async () => usage())
  assert.equal((await f.service.refresh({ force: false })).status, "ok")
  assert.equal(f.calls(), 2)
})

test("old global auth block does not poison upgraded account-specific state", async () => {
  const f = fixture()
  await f.service.refresh({ force: false })
  const old = JSON.parse(f.store.get("debug:stats")!)
  f.store.clear()
  f.store.set("debug:stats", JSON.stringify({ ...old, authBlocked: true, lastStatus: "http_401" }))
  assert.equal((await f.service.refresh({ force: false })).status, "ok")
})

test("same rejected token remains blocked but rotated token can retry automatically", async () => {
  const f = fixture()
  f.respond(async () => new Response(null, { status: 401 }))
  await f.service.refresh({ force: false })
  f.advance()
  assert.equal((await f.service.refresh({ force: false })).status, "auth_required")
  assert.equal(f.calls(), 1)
  f.setCredential(legacy("a", 2))
  f.respond(async () => usage())
  assert.equal((await f.service.refresh({ force: false })).status, "ok")
})

test("403 message describes forbidden access instead of requiring relogin", async () => {
  const f = fixture()
  f.respond(async () => new Response(null, { status: 403 }))
  const result = await f.service.refresh({ force: true })
  assert.match(result.message!, /HTTP 403/)
  assert.doesNotMatch(result.message!, /sign.in.*refresh/i)
})

test("429 Retry-After survives account switching and forced refresh", async () => {
  const f = fixture()
  f.respond(async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }))
  assert.equal((await f.service.refresh({ force: false })).status, "cooldown")
  f.setCredential(legacy("b"))
  assert.equal((await f.service.refresh({ force: true })).status, "cooldown")
  assert.equal(f.calls(), 1)
})

test("late response from A cannot become B's displayed snapshot", async () => {
  const f = fixture()
  let complete!: (response: Response) => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  f.respond(async () => { started(); return new Promise<Response>((resolve) => { complete = resolve }) })
  const pending = f.service.refresh({ force: true })
  await ready
  f.setCredential(legacy("b"))
  complete(usage())
  const result = await pending
  assert.equal(result.snapshot, null)
  assert.equal(result.status, "failed")
  assert.equal((await f.service.cached()).snapshot, null)
})

test("normal interval throttles but manual refresh bypasses it", async () => {
  const f = fixture()
  await f.service.refresh({ force: false })
  assert.equal((await f.service.refresh({ force: false })).status, "throttled")
  assert.equal((await f.service.refresh({ force: true })).status, "ok")
  assert.equal(f.calls(), 2)
})

test("all callers sharing a request reject a snapshot after the account changes", async () => {
  const f = fixture()
  let complete!: (response: Response) => void
  let started!: () => void
  let joined!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  const secondJoined = new Promise<void>((resolve) => { joined = resolve })
  f.respond(async () => { started(); return new Promise<Response>((resolve) => { complete = resolve }) })
  const first = f.service.refresh({ force: true })
  await ready
  // The join path reads no stats; wait one event-loop turn for its cache read to finish.
  const second = f.service.refresh({ force: true })
  setImmediate(joined)
  await secondJoined
  f.setCredential(legacy("b"))
  complete(usage())
  for (const value of await Promise.all([first, second])) {
    assert.equal(value.snapshot, null)
    assert.equal(value.status, "failed")
  }
  assert.equal(f.calls(), 1)
})

test("usage requests reject redirects and never persist raw credentials", async () => {
  const f = fixture()
  f.respond(async (init) => {
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${legacy("a").accessToken}`)
    return usage()
  })
  assert.equal((await f.service.refresh({ force: true })).status, "ok")
  const persisted = JSON.stringify([...f.store])
  assert.ok(!persisted.includes(legacy("a").accessToken))
  assert.ok(!persisted.includes("chatgpt_account_id"))
})

test("cached percentages outside the supported range are discarded", async () => {
  const f = fixture()
  await f.service.refresh({ force: false })
  const key = [...f.store.keys()].find((key) => key.startsWith("cache:"))!
  for (const invalid of [-1, 101, "75", 1e300]) {
    f.store.set(key, JSON.stringify({ primaryRemaining: invalid, secondaryRemaining: 90, fetchedAt: 1_000_000 }))
    assert.equal((await f.service.cached()).snapshot, null)
  }
})

test("cancellation while writing stats prevents the HTTP request", async () => {
  const controller = new AbortController()
  let calls = 0
  const service = createQuotaService({
    getCredential: async () => legacy("a"),
    get: async () => undefined,
    set: async () => { controller.abort() },
    fetch: (async () => { calls++; return usage() }) as typeof fetch,
  })
  const value = await service.refresh({ force: true }, controller.signal)
  assert.equal(value.status, "failed")
  assert.equal(value.message, "Refresh was cancelled")
  assert.equal(calls, 0)
})
