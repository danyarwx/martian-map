// Voice preview with the browser's own speech synthesis: shows how a voice plugs into the navigation bus.
// The real voice (an AI TTS model) subscribes the same way: bus.subscribe('*', ...), speak `e.text`.
import type { NavBus } from '../nav/events.ts'

/** True when this browser can speak. */
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Speaks every announcement on the bus until the returned function is called. High priority interrupts. */
export function startBrowserVoice(bus: NavBus): () => void {
  if (!canSpeak()) return () => {}
  const synth = window.speechSynthesis
  const off = bus.subscribe('*', (e) => {
    if (e.type === 'state' || !e.text) return
    if (e.priority === 'high') synth.cancel()
    const u = new SpeechSynthesisUtterance(e.text)
    u.lang = 'en-US'
    u.rate = 1.05
    synth.speak(u)
  })
  return () => {
    off()
    synth.cancel()
  }
}
