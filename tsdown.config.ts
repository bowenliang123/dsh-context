import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

// Read the manifest from cwd: the config file's own URL is not guaranteed to
// sit at the package root under every loader, and `npm run build` runs here.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell
// seeds these specifiers into the frozen browser module table, so client
// bundles leave them to the injected `require` instead of inlining.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const PRELOADED_CLIENT_EXTERNALS = ['@deepseek-ai/dsh-client-runtime/client']

// Mirrors the purity-gate allowances in packages/client/tsdown.client.ts:
// wire/type layers with no shared runtime identity may inline; every other
// @deepseek-ai/* value import is a build error (cross-plugin collaboration
// goes through cordis services).
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const requested = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...(pkg.dsh?.client?.external ?? []),
])
const isRequested = (specifier: string): boolean => requested.has(specifier)

// Host half: a production dependency is on disk in a real install and stays
// an import; everything else inlines. Both halves are stated so moving a
// dependency between npm sections never silently re-bundles it.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some(pattern => pattern.test(specifier))

const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // dts would wrap the banner/footer into a .d.cts and break parsing;
    // browser profiling consumes the bundle's own sourcemap instead.
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // A require() the module table cannot answer is a guaranteed runtime
      // throw: requested specifiers stay imports, everything else inlines.
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // Browser bundles inline node-idiom deps that read process.env.NODE_ENV
    // or probe import.meta.env(.MODE); without these substitutions the
    // factory throws ReferenceError at boot.
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
      __DSH_CTX_VERSION__: JSON.stringify(pkg.version),
      __DSH_CTX_REPO__: JSON.stringify(
        String((pkg.repository && pkg.repository.url) || '').replace(/^git\+/, '').replace(/\.git$/, ''),
      ),
    },
    plugins: [{
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${pkg.name}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client
      // export must use; mirrors tsdown.client.ts banner/intro/footer.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
