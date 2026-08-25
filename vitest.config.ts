import { defineConfig } from 'vitest/config'

// Specs import src/ directly (never the built lib/ artifacts), so the suite
// runs with no build step and coverage reflects exactly what ships. Two
// projects split by runtime: host/shared run in plain node, client specs in
// jsdom (React 18 + the real @deepseek-ai/dsh-client-ui-primitives, inlined
// so vite resolves its CSS-module imports). Files are small, single-module,
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
