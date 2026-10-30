import { Rpc } from "@opencode/plugin/rpc"
import type { QuotaSnapshot } from "./usage.js"
export type { QuotaSnapshot } from "./usage.js"

const snapshotSchema = {
  type: "object",
  properties: {
    primaryRemaining: { type: ["number", "null"] },
    secondaryRemaining: { type: ["number", "null"] },
    primaryResetAt: { type: ["integer", "null"], minimum: 0 },
    secondaryResetAt: { type: ["integer", "null"], minimum: 0 },
    fetchedAt: { type: "integer", minimum: 0 },
  },
  required: ["primaryRemaining", "secondaryRemaining", "fetchedAt"],
  additionalProperties: false,
} as const

const resultSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ok", "web_only", "throttled", "cooldown", "auth_required", "unavailable", "failed"],
    },
    snapshot: {
      anyOf: [snapshotSchema, { type: "null" }],
    },
    retryInMs: { type: ["integer", "null"] },
    message: { type: ["string", "null"] },
  },
  required: ["status", "snapshot", "retryInMs", "message"],
  additionalProperties: false,
} as const

export const QuotaRpc = Rpc.define({
  id: "openai-quota",
  events: {},
  methods: {
    cached: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: resultSchema,
    },
    refresh: {
      input: {
        type: "object",
        properties: {
          force: { type: "boolean" },
        },
        required: ["force"],
        additionalProperties: false,
      },
      output: resultSchema,
    },
  },
})

export type QuotaResultStatus =
  | "ok"
  | "web_only"
  | "throttled"
  | "cooldown"
  | "auth_required"
  | "unavailable"
  | "failed"

export interface QuotaResult {
  status: QuotaResultStatus
  snapshot: QuotaSnapshot | null
  retryInMs: number | null
  message: string | null
}
