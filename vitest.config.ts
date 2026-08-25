import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Specs exercise the built lib/ artifacts — `pnpm run build` first; *.client.spec.ts is the jsdom browser lane.
    include: ['tests/**/*.spec.ts'],
    // Scope: src only — `lib/` is the tsdown build artifact and never carries its own executable surface to cover.
    // Exclusions are pure type declarations with no runtime to instrument (v8 reports 0% and skews the summary).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/shared/types.ts',
        'src/host/compat.ts',
      ],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
})
