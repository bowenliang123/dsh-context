import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { compile as compileTailwind } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

// Read from cwd: the config file's own URL is not guaranteed to sit at the package root under every loader.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Prepended to every built JS artifact, and read per build so `tsdown --watch` rebuilds pick up new commits; each line degrades to omission when git is unavailable.
interface GitState { commit: string; branch: string; date: string; dirty: boolean }

function readGitState(): GitState | undefined {
  try {
    const run = (...args: string[]): string =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return {
      commit: run('rev-parse', '--short=12', 'HEAD'),
      branch: run('branch', '--show-current'),
      date: run('show', '-s', '--format=%cI', 'HEAD'),
      dirty: run('status', '--porcelain') !== '',
    }
  } catch {
    return undefined
  }
}

function localIsoNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`
}

function artifactBanner(): string {
  const git = readGitState()
  const lines = [
    ` * ${pkg.name} v${pkg.version}`,
    ` * ${pkg.description}`,
    ` * @author ${pkg.author}`,
    ` * @license ${pkg.license}`,
    ` * @homepage ${pkg.homepage}`,
    ` * @built ${localIsoNow()}`,
  ]
  if (git !== undefined) {
    lines.push(` * @commit ${git.commit}${git.dirty ? ' (dirty working tree)' : ''}${git.branch === '' ? '' : ` on ${git.branch}`}`)
    lines.push(` * @commit-date ${git.date}`)
  }
  return ['/**', ...lines, ' */', ''].join('\n')
}

// The platform-module subset this plugin requires: the shell seeds these specifiers into the frozen browser module table, so the bundle
// must leave them to the injected `require`. Anything else is a build error (the purity gate below).
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// The purity-gate allowances this plugin uses, from packages/client/tsdown.client.ts: wire/type layers with no shared runtime identity may inline, every other `@deepseek-ai/*` value import is a build error, and cross-plugin collaboration goes through cordis services.
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand|util-workspace-path)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const requested = new Set([
  ...PLATFORM_MODULES,
  ...(pkg.dsh?.client?.external ?? []),
])
const isRequested = (specifier: string): boolean => requested.has(specifier)

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

// The watch build feeds the local dsh web server, which loads the emitted JavaScript alone; skipping the declaration
// file and the source maps keeps the watcher's rebuild churn and resident set low. `pnpm run build` keeps every artifact.
const WATCH = process.env.DSH_CTX_WATCH === '1'

// Rolldown wraps each rebuild's artifacts in napi objects that a pressure-free V8 never finalizes, so a watcher's resident set
// climbs with every rebuild; the watch script exposes gc and every successful build collects.
const collectGarbage = (): void => {
  const maybeGc = globalThis as typeof globalThis & { gc?: () => void }
  maybeGc.gc?.()
}

// CSS channels, mirrored from packages/client/tsdown.client.ts. The virtual ids must NOT end in `.css`: tsdown's css-pipeline guard matches on that suffix.
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

const TAILWIND_ENTRY = 'tailwind.css'

interface WatchCapable {
  addWatchFile(file: string): void
}

async function compileTailwindSheet(loader: WatchCapable, fileId: string, source: string): Promise<string> {
  const compiler = await compileTailwind(source, {
    base: dirname(fileId),
    onDependency: (file) => { loader.addWatchFile(file) },
  })
  const scanner = new Scanner({ sources: compiler.sources })
  const candidates = scanner.scan()
  // A component's class list changes the scanned candidates, so it must fire a watch rebuild too.
  for (const file of scanner.files) loader.addWatchFile(file)
  return compiler.build(candidates)
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
      const raw = await readFile(fileId)
      // The Tailwind entry compiles to a CSS string first; every other sheet hands its Buffer straight to lightningcss, whose binding reads a TypedArray.
      const code = basename(fileId) === TAILWIND_ENTRY
        ? Buffer.from(await compileTailwindSheet(this, fileId, raw.toString()))
        : raw
      const { code: css } = transform({ filename: fileId, code, minify: true })
      return styleInjectionModule(id, fileId, css.toString())
    },
  }]
}

// JSDoc belongs to index.d.ts, and annotation/coverage hints are build-time input whose only remaining effect in the output is bytes. Legal comments stay for licenses.
const OUTPUT_COMMENTS = { legal: true, annotation: false, jsdoc: false } as const

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    minify: !WATCH,
    sourcemap: false,
    // The host half's Config/projection types are the integration contract other plugins compile against.
    dts: !WATCH,
    clean: true,
    banner: () => ({ js: artifactBanner(), dts: artifactBanner() }),
    onSuccess: collectGarbage,
    outputOptions: { comments: OUTPUT_COMMENTS },
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
    // A classic script the shell loads into its module table, never a Node module: without this, tsdown falls back to engines.node and trips its legacy-CJS warning.
    target: 'es2024',
    // A .d.cts would wrap the banner/footer and break parsing; profiling consumes the bundle's own sourcemap instead.
    dts: false,
    sourcemap: false,
    clean: false,
    minify: !WATCH,
    deps: {
      // A require() the module table cannot answer is a guaranteed runtime throw.
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
      // Keeps "everything else inlines" auditable: a dependency that starts being bundled fails the build instead of silently growing the artifact.
      onlyBundle: ['@opencode-ai/models', '@deepseek-ai/dsh-util-workspace-path', 'simple-icons'],
    },
    // Inlined node-idiom deps read process.env.NODE_ENV or probe import.meta.env(.MODE); without these substitutions the factory throws ReferenceError at boot.
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
    // Top-level `banner` routes to rolldown's postBanner, which lands after minification, so the header comment keeps its formatting.
    banner: () => ({ js: artifactBanner() }),
    onSuccess: collectGarbage,
    plugins: [{
      name: 'dsh-svg-raw',
      // The emblem (icon.svg) is the package's single graphic source, shared with the Host's package-meta reader through package.json `icon`.
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.svg?raw')) return null
        const target = source.slice(0, -'?raw'.length)
        return importer === undefined ? target : resolvePath(dirname(importer), target) + '?raw'
      },
      load(id: string) {
        if (!id.endsWith('.svg?raw')) return null
        const markup = readFileSync(id.slice(0, -'?raw'.length), 'utf8').trim().replace(/>\s+</g, '><')
        return `export default ${JSON.stringify(markup)}`
      },
    }, {
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
    }, ...cssChannels(pkg.name)],
    outputOptions: {
      comments: OUTPUT_COMMENTS,
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client export must use; mirrors tsdown.client.ts.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
