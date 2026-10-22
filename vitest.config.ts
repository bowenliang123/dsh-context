import { defineConfig } from 'vitest/config'

// Specs import src/ directly, never the built lib/, so the suite needs no build step and coverage reflects what ships.
export default defineConfig({
  test: {
    reporters: ['dot'],
    projects: [
      {
        test: {
          name: 'host',
          include: ['tests/host/**/*.spec.ts', 'tests/shared/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        // The inlined primitives dist references a sourcemap it does not ship; vite's warning is noise.
        logLevel: 'error',
        test: {
          name: 'client',
          include: ['tests/client/**/*.spec.ts'],
          environment: 'jsdom',
          // One jsdom environment per worker instead of one per file: ~30% off the coverage suite's runtime. Client-only — the host project fails under this pool.
          pool: 'vmThreads',
          setupFiles: ['tests/client/setup.ts'],
          server: {
            deps: {
              // The primitives dist imports .module.css; inlining lets vite transform it (externalized Node ESM would reject the .css).
              inline: ['@deepseek-ai/dsh-client-ui-primitives'],
            },
          },
        },
      },
      {
        // The view models run in plain node; component specs opt into jsdom per file.
        test: {
          name: 'tui',
          include: ['tests/tui/**/*.spec.ts'],
          environment: 'node',
          setupFiles: ['tests/tui/setup.ts'],
        },
      },
      {
        // Exercises the BUILT plugin and skips cleanly when lib/ is absent. The matrix also needs a dsh checkout (env DSH_REPO), and its first run per baseline installs the tag's vendored cordis into .tmp/compat — hence the timeout.
        test: {
          name: 'compat',
          include: ['tests/compat/**/*.spec.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        // Pure type declarations: no runtime surface to instrument.
        'src/shared/types.ts',
        'src/host/projection.ts',
        'src/tui/hostTypes.ts',
      ],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
      reporter: ['text', 'html'],
      // The text table lists only files below 100%; an empty table means full coverage.
      skipFull: true,
      reportsDirectory: './coverage',
    },
  },
})
