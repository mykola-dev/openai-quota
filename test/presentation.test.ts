import assert from "node:assert/strict"
import test from "node:test"
import { COLOR_KEYS, DEFAULT_SETTINGS, migratePrefix, parseTemplate, renderTemplate, validateColor, validateText } from "../src/presentation.js"

const now = 1_000_000
const snapshot = {
  primaryRemaining: 37, secondaryRemaining: 88, fetchedAt: now,
  primaryResetAt: now + 135 * 60_000, secondaryResetAt: now + 4 * 86_400_000,
}
const text = (segments: ReturnType<typeof renderTemplate>) => segments.map((segment) => segment.text).join("")

test("default template renders remaining percentages and countdowns", () => {
  assert.equal(text(renderTemplate(DEFAULT_SETTINGS, snapshot, now)), "37% 88% | 02:15 4d")
  assert.equal(DEFAULT_SETTINGS.defaultColor, "#808080")
  assert.deepEqual(DEFAULT_SETTINGS.colors, { percent5h: "#02dbf7", percent7d: "#f3f702", reset5h: "#02dbf7", reset7d: "#f3f702" })
})

test("custom order, repeated variables, and literal separators", () => {
  const settings = { ...DEFAULT_SETTINGS, template: "7d={percent7d} | {percent5h} · {percent5h}" }
  assert.equal(text(renderTemplate(settings, snapshot, now)), "7d=88% | 37% · 37%")
})

test("prefixes are ordinary literal template text", () => {
  assert.equal(text(renderTemplate({ ...DEFAULT_SETTINGS, template: "OpenAI: {percent5h} | {percent7d}" }, snapshot, now)), "OpenAI: 37% | 88%")
  assert.throws(() => parseTemplate("{prefix}"), /Unknown variable/)
})

test("legacy prefix migrates into the template without changing colors", () => {
  const legacy = { ...DEFAULT_SETTINGS, prefix: "ChatGPT:", template: "{prefix} {percent5h}/{percent7d}" }
  const migrated = migratePrefix(legacy)
  assert.equal(migrated.template, "ChatGPT: {percent5h}/{percent7d}")
  assert.equal("prefix" in migrated, false)
  assert.deepEqual(migrated.colors, legacy.colors)
  assert.equal(migrated.defaultColor, legacy.defaultColor)
  assert.equal(legacy.prefix, "ChatGPT:")
  assert.equal(migratePrefix({ ...legacy, prefix: "" }).template, "{percent5h}/{percent7d}")
  assert.equal(migratePrefix({ ...DEFAULT_SETTINGS, prefix: "unused" }).template, DEFAULT_SETTINGS.template)
})

test("all four colors follow their variables, not their positions", () => {
  const colors = { percent5h: "#123456", percent7d: "#abcdef80", reset5h: "#112233", reset7d: "#44556600" }
  const segments = renderTemplate({ ...DEFAULT_SETTINGS, colors }, snapshot, now)
  assert.deepEqual(segments.filter((segment) => segment.color !== DEFAULT_SETTINGS.defaultColor).map((segment) => segment.color), COLOR_KEYS.map((key) => colors[key]))
})

test("missing and partially missing data use dashes, zero remains a percentage", () => {
  assert.equal(text(renderTemplate(DEFAULT_SETTINGS, null, now)), "— — | — —")
  assert.equal(text(renderTemplate(DEFAULT_SETTINGS, { ...snapshot, primaryRemaining: 0, secondaryRemaining: null, primaryResetAt: null }, now)), "0% — | — 4d")
})

test("default color applies to prefix, separators, and variables without overrides", () => {
  const settings = { ...DEFAULT_SETTINGS, template: "OpenAI: {percent5h} / {percent7d} {reset5h}/{reset7d}", defaultColor: "#abcdef80", colors: { percent5h: "#123456", percent7d: "", reset5h: "", reset7d: "" } }
  const segments = renderTemplate(settings, snapshot, now)
  assert.equal(segments.find((segment) => segment.text === "37%")?.color, "#123456")
  assert.ok(segments.filter((segment) => segment.text !== "37%").every((segment) => segment.color === "#abcdef80"))
})

test("legacy settings without defaultColor retain theme fallback", () => {
  const { defaultColor, ...legacy } = DEFAULT_SETTINGS
  assert.ok(renderTemplate({ ...legacy, colors: { percent5h: "", percent7d: "", reset5h: "", reset7d: "" } }, snapshot, now).every((segment) => segment.color === undefined))
})

test("unknown variables, malformed braces, control characters, and oversized templates are rejected", () => {
  for (const input of ["{unknown}", "{}", "{prefix", "prefix}", "{{prefix}}", "{prefix}\n", "\x1b[31m", "x".repeat(501)]) {
    assert.throws(() => parseTemplate(input), input)
  }
  assert.deepEqual(parseTemplate(""), [])
  assert.deepEqual(parseTemplate("plain text"), [{ text: "plain text" }])
  assert.throws(() => validateText("x".repeat(101), 100))
})

test("hex validation supports optional alpha and theme default", () => {
  assert.equal(validateColor(" #AABBCC80 "), "#aabbcc80")
  assert.equal(validateColor("#123456"), "#123456")
  assert.equal(validateColor("  "), "")
  for (const input of ["red", "#fff", "#12345g", "#1234567", "#123456789"]) assert.throws(() => validateColor(input))
})
