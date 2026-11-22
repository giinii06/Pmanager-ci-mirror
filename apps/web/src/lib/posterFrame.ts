/** Capture the current frame without seeking the video player or showing a modal. */
export function posterPositionMs(currentSeconds: number, durationSeconds: number): number | null {
  if (!Number.isFinite(currentSeconds) || currentSeconds < 0 ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  const lastFrameMs = Math.max(0, Math.round(durationSeconds * 1000) - 500)
  return Math.min(Math.round(currentSeconds * 1000), lastFrameMs)
}
