// Typing for the throwaway plain-JS fixture (the runtime module mirrors this
// exactly); keeps tsc happy without allowJs.
export function registerBlind(tools: { register(def?: unknown): () => void }): () => void
