import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Specs exercise the BUILT artifacts (lib/), so `pnpm run build` first.
    // `*.client.spec.mjs` is the browser lane (jsdom pragma per file); the
    // plain `*.spec.mjs` files run in node with their own fakes.
    include: ['tests/**/*.spec.mjs'],
  },
})
