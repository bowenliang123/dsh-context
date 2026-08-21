import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsup'

// Read the manifest from cwd, not import.meta.url: tsup re-bundles this config
// into a temp .mjs and runs it from there, so import.meta.url points at the
// temp file, not this source. process.cwd() is the package root under
// `npm run build`.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Client bundle wrap: the closure-factory format every `dsh.client` package's
// `./client` export must use. The browser loader answers `require` for the
// platform modules (react, primitives) from its module table and reads
// `module.exports` as the plugin surface.
const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const CLIENT_FOOTER = `
    return module.exports;
  },
});
`

export default defineConfig([
  // ---- host half: bundled TS -> ESM. zod is a peer dependency;
  // @deepseek-ai/dsh-session is the harness-provided runtime contract
  // (declared as a peer), so both stay external and resolve at runtime from
  // the installation's single instance. ----
  {
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    external: ['zod', '@deepseek-ai/dsh-session'],
    outExtension: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
    dts: false,
  },
  // ---- client half: bundled TS -> CJS, wrapped in the loader handoff -------
  // react and the primitives are peers the browser module table provides at
  // runtime; everything else is inlined by the bundler.
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    outExtension: () => ({ js: '.js' }),
    clean: false,
    sourcemap: false,
    dts: false,
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
    // The source's `module.exports = {}` is the loader contract (the wrap
    // above provides a local `var module`); silence that one warning.
    esbuildOptions: (options) => {
      options.logOverride = { 'commonjs-variable-in-esm': 'silent' }
    },
    define: {
      __DSH_CTX_VERSION__: JSON.stringify(pkg.version),
      __DSH_CTX_REPO__: JSON.stringify(
        String((pkg.repository && pkg.repository.url) || '').replace(/^git\+/, '').replace(/\.git$/, ''),
      ),
    },
  },
])
