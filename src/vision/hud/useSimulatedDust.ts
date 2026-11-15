// A demo control: ramps SIMULATED dust up or down over a few seconds, like a storm front arriving.
// It only produces a number from 0 to `peak`; VisionHud paints it and feeds it to the analyzer.

import { useCallback, useEffect, useRef, useState } from 'react'

const RAMP_SECONDS = 5

export function useSimulatedDust(peak = 0.9) {
  const [active, setActive] = useState(false)
  const [dust, setDust] = useState(0)
  const target = useRef(0)
  target.current = active ? peak : 0

  useEffect(() => {
    const timer = setInterval(() => {
      setDust(d => {
        const step = (peak / RAMP_SECONDS) * 0.1
        if (Math.abs(target.current - d) <= step) return target.current
        return d + Math.sign(target.current - d) * step
      })
    }, 100)
    return () => clearInterval(timer)
  }, [peak])

  const toggle = useCallback(() => setActive(a => !a), [])
  const clear = useCallback(() => {
    setActive(false)
    setDust(0)
  }, [])

  return { dust, active, toggle, clear }
}
