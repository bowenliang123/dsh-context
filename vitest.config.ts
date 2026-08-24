import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Specs exercise the built lib/ artifacts — `pnpm run build` first; *.client.spec.ts is the jsdom browser lane.
    include: ['tests/**/*.spec.ts'],
  },
})
