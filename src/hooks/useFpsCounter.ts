import { useEffect, useState } from 'react'

export function useFpsCounter(sampleWindowMs = 500): number {
  const [fps, setFps] = useState(0)

  useEffect(() => {
    let frameCount = 0
    let windowStart = performance.now()
    let frameId = 0

    const tick = (now: number) => {
      frameCount += 1
      const elapsed = now - windowStart

      if (elapsed >= sampleWindowMs) {
        setFps(Math.round((frameCount * 1000) / elapsed))
        frameCount = 0
        windowStart = now
      }

      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [sampleWindowMs])

  return fps
}
