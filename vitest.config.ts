import { defineConfig } from 'vitest/config'

// Specs import src/ directly (never the built lib/ artifacts), so the suite
// runs with no build step and coverage reflects exactly what ships. Three
// projects split by runtime and preconditions: host/shared run in plain
// node, client specs in jsdom (React 18 + the real
// @deepseek-ai/dsh-client-ui-primitives, inlined so vite resolves its
// CSS-module imports), and the compat matrix drives the BUILT plugin against
// real harness sources per baseline tag. Files are small, single-module,
// and stateless — vitest forks them across workers in parallel.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          include: ['tests/host/**/*.spec.ts', 'tests/shared/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        // The inlined primitives dist references a sourcemap it does not
        // ship; vite's warning is noise, so the client lane logs errors only.
        logLevel: 'error',
        test: {
          name: 'client',
          include: ['tests/client/**/*.spec.ts'],
          environment: 'jsdom',
          setupFiles: ['tests/client/setup.ts'],
          server: {
            deps: {
              // The primitives dist imports .module.css; inlining lets vite
              // transform it (externalized Node ESM would reject the .css).
              inline: ['@deepseek-ai/dsh-client-ui-primitives'],
            },
          },
        },
      },
      {
        // The built-artifact lane (tests/compat/): the bundle smoke over
        // lib/client.js, plus the real-code compat matrix against the
        // ACTUAL harness sources at every baseline tag (tests/baselines.ts).
        // Both exercise the BUILT plugin and skip cleanly when lib/ is
        // absent; the matrix also needs a dsh checkout (env DSH_REPO) — the
        // release workflow builds and fetches the tags before `pnpm test`.
        // The first matrix run per baseline installs the tag's vendored
        // cordis into the staging dir (.tmp/compat, npm-cached) — hence the
        // timeout.
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
        'src/host/compat.ts',
      ],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
})
