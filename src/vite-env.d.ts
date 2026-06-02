/// <reference types="vite/client" />

declare module './engine/engine.js'
declare module './engine/image-slot.js'

interface Window {
  MISSION?: {
    store: {
      data: Record<string, unknown>
      get(k: string, def?: unknown): unknown
      set(k: string, v: unknown): void
    }
  }
}
