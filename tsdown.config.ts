import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

// Read the manifest from cwd: the config file's own URL is not guaranteed to
// sit at the package root under every loader, and `pnpm run build` runs here.
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

// CSS channels, mirrored from packages/client/tsdown.client.ts. The virtual
// ids must NOT end in `.css` — tsdown's own css-pipeline guard matches on that
// suffix; the plugin's flat lc-* class namespace is the anti-collision rule.
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

function cssChannels(id: string) {
  return [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }, {
    name: 'dsh-css-text-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
      const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
      const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
      return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return `export default ${JSON.stringify(code.toString())};`
    },
  }, {
    name: 'dsh-css-global-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return styleInjectionModule(id, fileId, code.toString())
    },
  }]
}

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // The host half's Config/projection types are the integration contract
    // other plugins and tooling compile against; ship them next to the JS.
    dts: true,
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
      name: 'dsh-client-bundle-purity',      resolveId(source: string) {
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
    }, ...cssChannels(pkg.name)],
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
