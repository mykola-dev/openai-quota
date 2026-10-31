import assert from "node:assert/strict"
import { test } from "node:test"
import { createResetAlarm, createResetSoundClaim, type ResetAlarmEvent } from "../src/reset-alarm.js"

function fakeClock(startAt: number) {
  let now = startAt
  let nextID = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimer: (callback: () => void, delay: number) => {
      const id = ++nextID
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimer: (id: number) => { timers.delete(id) },
    async advanceTo(target: number) {
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.callback()
        await Promise.resolve()
      }
      now = target
    },
  }
}

test("reset alarm emits once at the deadline and can be cancelled or rescheduled", async () => {
  const clock = fakeClock(1_000)
  const emitted: ResetAlarmEvent[] = []
  const alarm = createResetAlarm<number>({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    emit: (event) => { emitted.push(event) },
  })

  alarm.schedule(2_000)
  alarm.schedule(3_000)
  await clock.advanceTo(2_000)
  assert.deepEqual(emitted, [])
  await clock.advanceTo(3_000)
  assert.deepEqual(emitted, [{ eventID: "openai-5h-3000", resetAt: 3_000 }])

  alarm.schedule(4_000)
  alarm.cancel()
  await clock.advanceTo(5_000)
  assert.equal(emitted.length, 1)
})

test("reset alarm ignores missing, invalid, and already-expired deadlines", async () => {
  const clock = fakeClock(1_000)
  const emitted: ResetAlarmEvent[] = []
  const alarm = createResetAlarm<number>({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    emit: (event) => { emitted.push(event) },
  })

  alarm.schedule(undefined)
  alarm.schedule(Number.NaN)
  alarm.schedule(1_000)
  await clock.advanceTo(2_000)
  assert.deepEqual(emitted, [])
})

test("only one TUI client can claim the sound for each reset event", () => {
  const claimSound = createResetSoundClaim()

  assert.equal(claimSound("openai-5h-3000"), true)
  assert.equal(claimSound("openai-5h-3000"), false)
  assert.equal(claimSound("openai-5h-4000"), true)
})
