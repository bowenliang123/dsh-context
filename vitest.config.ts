import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Specs exercise the BUILT artifacts (lib/), so `pnpm run build` first.
    // `*.client.spec.ts` is the browser lane (jsdom pragma per file); the
    // plain `*.spec.ts` files run in node with their own fakes.
    include: ['tests/**/*.spec.ts'],
  },
})
