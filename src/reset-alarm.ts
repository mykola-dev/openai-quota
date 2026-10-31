const MAX_TIMEOUT_MS = 2_147_000_000

export interface ResetAlarmEvent {
  eventID: string
  resetAt: number
}

export interface ResetAlarmOptions<Timer> {
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => Timer
  clearTimer?: (timer: Timer) => void
  emit: (event: ResetAlarmEvent) => void | Promise<void>
  onError?: (error: unknown) => void
}

export function createResetSoundClaim() {
  const claimedEvents = new Set<string>()
  return (eventID: string): boolean => {
    if (claimedEvents.has(eventID)) return false
    claimedEvents.add(eventID)
    return true
  }
}

export function createResetAlarm<Timer = ReturnType<typeof setTimeout>>(options: ResetAlarmOptions<Timer>) {
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay) as unknown as Timer)
  const clearTimer = options.clearTimer ?? ((timer: Timer) => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>))
  let timer: Timer | undefined
  let generation = 0

  function cancel(): void {
    generation++
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }

  function schedule(resetAt: number | null | undefined): void {
    cancel()
    if (typeof resetAt !== "number" || !Number.isSafeInteger(resetAt) || resetAt <= now()) return

    const scheduledResetAt = resetAt
    const scheduledGeneration = generation
    const event = { eventID: `openai-5h-${scheduledResetAt}`, resetAt: scheduledResetAt }

    function checkDeadline(): void {
      if (scheduledGeneration !== generation) return
      const remaining = scheduledResetAt - now()
      if (remaining > 0) {
        timer = setTimer(checkDeadline, Math.min(MAX_TIMEOUT_MS, remaining))
        return
      }

      timer = undefined
      void Promise.resolve().then(() => options.emit(event)).catch((error) => options.onError?.(error))
    }

    timer = setTimer(checkDeadline, Math.min(MAX_TIMEOUT_MS, scheduledResetAt - now()))
  }

  return { schedule, cancel }
}
