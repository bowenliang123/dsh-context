# DeepSeek Harness 源码调研：插件打包、模块布局、样式与组件划分

> 调研对象：DSH monorepo 一手源码（`/Users/bw/dev/deepseek-harness`，main 分支，2026-08-21 前后快照）。
> 对照对象：本仓库 dsh-context（cordis 插件，`src/{client,host,shared}`）。
> 所有结论均附 `路径:行号` 证据；路径相对 DSH 仓库根，dsh-context 内部文件用 `dsh-context/` 前缀。
> 标注「未证实」的条目表示在一手源码中未找到直接证据。

## 目录

1. [插件打包与加载机制](#1-插件打包与加载机制)
2. [源码与模块布局](#2-源码与模块布局)
3. [样式与组件划分](#3-样式与组件划分)
4. [其他划分（i18n / 测试 / 文档组织）](#4-其他划分)
5. [对照 dsh-context 的差距清单与对齐建议](#5-对照-dsh-context)

---

## 1. 插件打包与加载机制

### 1.1 插件的本质：vendored cordis

DSH 的插件体系建立在 **vendored cordis** 之上（fork 自 cordisjs，重新 scope 为 `@deepseek-ai/cordis`）：

- `vendor/cordis/README.md:3-7` — "a TypeScript plugin framework ... explicit dependency injection, scoped services, lifecycle-managed cleanup, and optional configuration-driven loading"；`:45-58` 给出函数插件 + `inject` 声明 + `root.plugin()` 返回 Fiber 的范式。
- `vendor/cordis/package.json:2` — name 为 `@deepseek-ai/cordis`；`scripts/rescope-vendor.ts:54` 记录 upstream→scoped 映射（如 `@cordisjs/plugin-hmr` → `@deepseek-ai/cordis-plugin-hmr`）。
- 插件两种形态的规则：`packages/AGENTS.md:5` — "service packages default-export their service class; function plugins named-export `name` / `inject` / `Config` / `apply` and have no default export. Mixing the forms makes the Loader discard the function plugin's namespace."
- 函数插件例：`packages/client/ui-trajectory/src/client/index.ts:22-31`（`export const inject = [...]`、`export function apply(ctx: Context)`）。

### 1.2 cordis.yml 与 cordis.patch.yml

**cordis.yml**：顶层 YAML 数组，每行一个 entry：`id`（树内稳定 id）+ `name`（模块 specifier）+ 可选 `config`/`group`/`disabled`/`inject`，支持 `!!js` 表达式：

- entry 字段定义：`vendor/loader/src/config/entry.ts:9-22`（`EntryOptions`）。
- 实例：`examples/headless-agent/cordis.yml:9-11`（`- id: settings / name: '@deepseek-ai/dsh-settings-file'`）、`:54`（`cwd: !!js process.cwd()`）。
- `!!js` 方言：`vendor/include/src/index.ts:9-23`（YAML schema 定义为 `{__jsExpr}`），entry 激活时经 `new Function('ctx','expr',...)` 求值（`vendor/loader/src/config/utils.ts:5-14`、`vendor/loader/src/index.ts:92-101`）。

**cordis.patch.yml**：不是树而是**补丁层（patch list）**，叠加在已有 entry list 上：

- patch 语义唯一实现于 `applyEntryPatches`：`vendor/include/src/index.ts:58-128`（`insert` 追加行、按 `id` 整行覆盖 `config`、插入行即刻可被查补丁命中、打不中则 warn+跳过）；`PatchOptions` 类型在同文件 :145-156。
- 消费方是 profile 系统：`packages/boot/app-boot/src/profile.ts:1-13` — profile = `$DSH_HOME/profiles/<name>` 目录，含 `package.json`（`dsh.profile.bundles` 有序 bundle 列表）+ `cordis.patch.yml`（用户补丁层，最后应用）；bundle 包以 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明自己导出的补丁层（`profile.ts:39,42-51`，消费点 :391-396）。
- 官方实例：`packages/bundle/base/cordis.patch.yml:1-13`（dsh-base 在空 root 上 insert 全部基础行）；`packages/bundle/web-app/cordis.patch.yml:16-24`（按 id 覆盖 `system-prompt` 的 config、`disabled: true` 关掉 `hmr` 行）。
- 叠加顺序（先→后）：各 bundle patch（按 `dsh.profile.bundles` 序）→ profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层 → 遥测开关（`apps/cli/src/profile-boot.ts:122-129,142-170`）。profile 根 cordis.yml 永远是空数组、每次启动重写（`profile-boot.ts:59-64,101`："Edit cordis.patch.yml, not this file"）。
- 用户层经 HMR watch：`packages/boot/app-boot/src/index.ts:226-241`。
- 该约定有 spec 钉住：`packages/bundle/base/tests/base.spec.ts:23`（`expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')`）。

### 1.3 host 侧插件的解析与加载

- 启动管线：`dsh web` 是 `--profile web` 的硬编码别名（`apps/cli/src/args.ts:13,66`）→ `bin.ts:30-39` 走 `runProfile`（`apps/cli/src/profile-boot.ts:207`）→ `boot(NAME, rootConfig, patches, ...)`（`profile-boot.ts:248`）→ `mountRootInclude` 创建 root Include entry（`packages/boot/app-boot/src/index.ts:487-525`：注册 `cordis:include`、`cordis:group` builtins，patches 作为 include 的 `config.patches`）。
- 模块导入在 `EntryTree.import`：`vendor/loader/src/config/tree.ts:144-162` — 优先用 Node 内部 ESM loader `internal.import(name, ctx.baseUrl)`（`baseUrl` 即 profile/cordis.yml 所在目录）；裸名直接 `import(name)`。**结论：走 Node 原生 ESM 解析，即 package `exports` → `lib/index.js`**。内部 loader 获取：`vendor/loader/src/internal.ts:120-131`（区分 Node 22/23 与 24+）。
- 解析锚点：bundle 名先从 dsh 安装目录、再从 profile 目录解析（`packages/boot/app-boot/src/profile.ts:344-355`）；另维护 `$DSH_HOME/profiles/node_modules` 扁平 symlink 回退目录（`profile.ts:204-255`）。
- ESM/CJS/default 形态归一：`vendor/loader/src/index.ts:192-199`（`unwrapExports`）；entry 生命周期（导入→`registry.plugin`→fiber）：`vendor/loader/src/config/entry.ts:277-302`。
- plain-node（`:lib`）boot 同样走 `exports`→`lib`：`pnpm-workspace.yaml` 注释说明 examples 成员仅为依赖解析存在。
- Node 侧模块 HMR：vendored `@deepseek-ai/cordis-plugin-hmr`（`vendor/hmr/src/index.ts:1-13`，chokidar 监听 + ModuleJob 依赖图）；但 web profile 里该行被禁用（`packages/bundle/web-app/cordis.patch.yml:23-24`），launcher 补挂 `root: []` 的 watch-only 实例仅支撑 cordis.patch.yml 热重载（`apps/cli/src/profile-boot.ts:272-284`）。

### 1.4 client 侧插件的发现、注入与加载

这是 DSH 插件体系最核心的部分。

**(a) 发现（node 半）。** `ClientModuleRegistry`（`packages/client/modules/src/index.ts`）扫描宿主 Loader 的 entry 树，凡 entry 的 `name` 能解析到带 `dsh.client.platform === 'web'` 的包即成为一行：

- `packages/client/modules/src/index.ts:429-463`（`resolveMeta`：`require.resolve('<pkg>/package.json')` 锚定 `ctx.baseUrl`，读 `dsh.client` 与 `exports["./client"]`）；`:148-159,451-453` 强制校验「declares dsh.client but exports no "./client" bundle」。
- `:316-331` 监听 cordis `internal/plugin` 事件做增量扫描，首扫同步。
- 图行 `{ id, url: '/plugins/<id>/client.js?rev=<sha1前12位>', rev, inject?, immediately?, external? }`：`:161-176`；按 `external` 拓扑排序：`:188-220`。

**(b) `window.__DSH_BOOT__` 是什么、在哪注入。** 它是 `WebBootGraph`（`{rev, entries[]}`）的 JSON：

- 由 `bootInjections()` 生成一行 `{ kind: 'global', name: '__DSH_BOOT__', value: graph }`：`packages/client/modules/src/index.ts:241-273`（同函数还注入 `__ModuleLoader__` 注册队列内联脚本与 modules/runtime 两行的 parser-blocking 预载 `<script src>`，`:229,265-267`）。
- 经 `webserver/index-inject` 事件进入注入表（`:343-345`）；webserver 每次响应 index.html 时收集渲染：`packages/host/webserver/src/index.ts:286-300`；渲染为 `<script>globalThis["__DSH_BOOT__"] = {...}</script>`，`<` 转义防逃逸：`packages/host/webserver/src/injections.ts:44-66,82-104`。
- 只有 `dsh web` 注入它：`apps/web/vite.config.ts:8-10,30-37` 明确拒绝裸 `vite serve`；`packages/bundle/web-app/src/index.ts:151` 同样说明。dist 经前端包 exports 解析（`packages/bundle/web-app/src/index.ts:163-171`）。
- wire 类型与解析器：`packages/client/modules/src/client/manifest.ts:66-76`（`WebBootGraph`）、`:147-188`（`parseBootManifest`）、`:233-238`（`DshWindow`）。

**(c) 浏览器侧加载。** `apps/web/src/main.ts:6,10` 调 `AppWebEntry.run()`（`packages/client/web/src/boot.ts:46-78`）：读 `__ModuleLoader__`/`__DSH_BOOT__` → 创建 client module system（`loader.internal = modules`，`:116`）→ **在浏览器里再起一个 vendored cordis Loader**，为每个图行 `loader.create({name})`（`:124-135`）。模块系统是 lazy CJS table：执行 bundle 只注册 factory（`window.__ModuleLoader__.load({id, factory})`），首次 import 才物化，CSS 注入等副作用随之运行（`packages/client/modules/src/client/manifest.ts:1-30`；`packages/client/modules/README.md:7-9`——「`<id>/client` 与裸 id 解析到同一 exports：a plugin bundle IS its package's client half」）。平台共享模块由壳静态种子进模块表：`packages/client/web/src/seed.ts:21-32` + `packages/client/web/src/platform.ts:8-17`。

**(d) bundle 分发与 client-plugin HMR receiver。**

- bundle 端点 `/plugins/<id>/client.js?rev=<sha1:12>`（`packages/client/modules/src/index.ts:170,540-547`；路由处理 scope 斜杠 `:537-539`）；graph row 必须能解析出 client bundle 路径否则 fail：`packages/client/modules/src/invariant.ts:32`。
- **HMR receiver = `packages/client/hmr`**（`@deepseek-ai/dsh-client-hmr`）：
  - 浏览器半 `packages/client/hmr/src/client/index.ts`：cordis 插件 `client-hmr`，`inject = ['loader','modules']`（`:73-76`）；经 `EventSource('/plugins/events')` 收 SSE `rebuilt` 帧（`:166-180`），随后 invalidate → prefetch（旧 fiber 仍在服务时注册新 bundle）→ registry-first 拆除旧 fiber（`registry.delete` 防 Loader 把 entry 标 disabled）→ 移除自有 `<style data-plugin>` → `entry.refresh()` 重新物化（`:104-140`，头部注释 `:38-52` 解释为何不能 naive dispose）。
  - node 半 `packages/client/hmr/src/index.ts`：500ms stat 轮询每行的 `lib/client.js`（`:32-38,99-114`），调 `clientModules.rebuilt(id)` 重哈希，经 `/plugins/events` SSE 广播（`:148-190`）。
  - 生效条件：该行被 web bundle 无条件挂载（`packages/bundle/web-app/cordis.patch.yml:147-151`，注释 "idle until a rebuild watcher (pnpm run dev:web) actually rewrites client bundles"）——即必须同时跑 `pnpm run dev:web`（`scripts/dev-web.ts:1-16`：tsc -b → tsdown watch 重写 `lib/client.js` → vite build 重写 dist）。`apps/web/vite.config.ts:10`：「For client-plugin HMR, run `pnpm dsh web` together with `pnpm run dev:web`.」该契约也写进 web surface prompt：`packages/bundle/web-app/src/index.ts:143-145`。

**(e) externals / module table。** 浏览器共享的平台模块固定为：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`（`packages/client/web/src/platform.ts:8-12`）；parser 预载 `@deepseek-ai/dsh-client-runtime/client`（:15-17）。client bundle 必须把这些标为 external，由注入的 require 提供；其余 `@deepseek-ai/*` 值导入被 purity gate 直接报错，普通三方库内联（`packages/client/tsdown.client.ts:415-425,454-461,479-497`；规则文档 `packages/client/AGENTS.md:73-97`）。

### 1.5 package.json 的插件相关字段

- `main`/`exports` → `lib/`：host 入口固定 `exports["."].default = ./lib/index.js`（`packages/client/hmr/package.json:13-19`）；client 插件必须额外有 `exports["./client"]` → `./lib/client.js`（同文件 :24-27）。bundle 包还导出 `./cordis.patch.yml`、`./src/*`、`./package.json`（`packages/bundle/base/package.json:15-28`）。
- `dsh.bundle.patch`：bundle 补丁层路径（`packages/bundle/base/package.json:37-41`；类型 `packages/boot/app-boot/src/profile.ts:41-45`）。
- `dsh.profile.bundles`：profile 的有序 bundle 层列表（`profile.ts:47-51,114-117`；内置模板 `web: [dsh-base, dsh-web-app]`）。
- `dsh.client`：`{ platform, inject?, external?, immediately? }`（类型 `packages/client/modules/src/index.ts:49-63` `DshClientDeclaration`；实例 `packages/client/hmr/package.json:33-39` 带 `immediately: true`；`packages/client/ui-layout/package.json:33-40` 带 `inject` 列表）。
- `files` 精确列出产物（`lib/index.js`、`lib/invariant.js`、`lib/client.js`、`lib/types/**/*.d.ts`；规则 `packages/client/AGENTS.md:67`）。
- 依赖纪律：cordis 永远 peer+dev；包间动态关系 peer+dev；纯库进 `dependencies` 会被内联进 bundle（`packages/client/AGENTS.md:59-67`）。

### 1.6 构建工具链与 client 产物约定

- **构建工具是 tsdown（rolldown 系），不是 tsup**。根 `tsdown.config.ts:16-30` 是 workspace 构建（`vendor/*`、`packages/*/*`、`apps/cli`），以 `--env.DSH_BUILD_FACE host|client` 分两遍（根 `package.json` scripts `build:lib:host`/`build:lib:client`）。
- client 包各自的 `tsdown.config.ts` 只有一行预设调用：`packages/client/ui-trajectory/tsdown.config.ts:1-3`（`clientBundle('@deepseek-ai/dsh-client-ui-trajectory', ['lib/types/index.js', 'lib/types/invariant.js'])`）。预设 `clientBundle()` 同时声明 node 半 lib 构建与浏览器 client 构建（`packages/client/tsdown.client.ts:106-123`；注释警告包级 config 会替换根 workspace 布局、必须重申 lib 半 `:91-97`）。
- 库类包（无 `dsh.client`）用 `staticLinked()` 预设进入静态装配通道（由 apps/web Vite 壳静态链接，`tsdown.client.ts:125-161`）。
- 包级 scripts 只有 `"bundle": "tsdown"` / `"watch": "tsdown --watch"`（`packages/client/ui-layout/package.json:41-44`）。
- 新插件包权威 checklist：`packages/client/AGENTS.md:132-141`——package.json（exports `.`/`./invariant`/`./client`/`./src/*` + `dsh.client` + files）、tsconfig 注册进 `tsconfig.client.json`、在 `packages/bundle/web-app/cordis.patch.yml` 加一行、并在 `packages/bundle/web-app/package.json` 加依赖。
- **产物格式：closure-factory CJS**（`format: 'cjs'`, `platform: 'browser'`），头尾被包成：

  ```
  window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  ...bundle body...
  return module.exports; } });
  ```

  证据：`packages/client/tsdown.client.ts:437-566`（banner/footer/intro 在 :562-565）。
- **命名约定**：固定 `lib/client.js`（`entryFileNames: 'client.js'`，`:556`），`id` = npm 包名（含 scope）；无 global 变量名约定，不用 import map。
- **CSS 随行**：全部经 lightningcss 编译后内联进 bundle——`x.module.css` → 虚拟模块导出哈希 class map（`[hash]_[local]`）并在 factory 执行时注入 `<style data-plugin="<id>" data-plugin-css="<id>/<file>">`；`x.css?inline` → 导出编译文本；普通 `.css` → 全局注入（`tsdown.client.ts:33-53,498-553`，三个虚拟 loader 均 `addWatchFile`）。样式标签归插件所有，HMR 时整组移除再注入（`packages/client/hmr/src/client/index.ts:86-91,130-132`）。
- sourcemap 随行（`/plugins/<id>/client.js.map`，sources 重基到镜像仓库目录）：`tsdown.client.ts:82-88,557-561`。
- `process.env.NODE_ENV` / `import.meta.env` 构建期 define 替换（CJS 产物无法携带 import.meta）：`tsdown.client.ts:463-478`。
- **examples/ 下的 web-cordis / web-schedule 不是插件包**：只有 `cordis.yml` + README（已核实目录内容，无 package.json / 构建配置）；它们是组合示例（patch overlay），引用的插件在 `packages/` 下（`examples/package.json:3`）。**对外插件作者最贴近的官方参照物是 `packages/client/ui-*` 包本身**；GitHub topic `dsh-plugin` 的外部示例不在本仓库（未核实）。

---

## 2. 源码与模块布局

### 2.1 monorepo 分层

`pnpm-workspace.yaml:1-24` 定义 workspace 成员与职责注释：

| 层 | 成员 glob | 职责 |
|---|---|---|
| `vendor/` | `vendor/*` | vendored cordis 框架层：上游 semver 保留但本地解析钉到 workspace 源（`linkWorkspacePackages: true` + overrides，:23-29）；不可随意改，所有分叉记录在 `vendor/README.md` "Local modifications"（`vendor/AGENTS.md:5`） |
| `packages/` | `packages/*/*` | 两级分组的能力包（`<group>/<pkg>`，约 35 个 group；职责表带 Release expectation 列见 `packages/README.md:11-60`），harness tier |
| `native/` | `native/landlock-run`、`native/landlock-run/packages/*` | Landlock launcher 的原生构建与发布脚本（:6-7） |
| `apps/` | `apps/*` | "Product assemblies over the package tier; apps/cli owns the `dsh` bin"（:8）；`apps/web` 是 web shell |
| `website` | `website` | 文档站（VitePress 投影，:10） |
| `examples` | `examples`（单个成员） | 可运行 demo 的依赖解析伞，**不是构建目标**（tsdown globs 排除；:15-16） |
| `python/sdk-runtime` | — | single-exe 构建的部署根（:19-21） |

根 `AGENTS.md:9-56` 的 Repository layout 块逐目录定义职责。依赖方向：apps 单向依赖 packages（`apps/cli/package.json` 列约 80 个 dsh-* 包）→ packages → vendor；`@deepseek-ai/cordis` 是每个 harness 包的 peer+dev 依赖（`AGENTS.md:101`）；"Extension plugins depend on Service Definitions, never concrete providers"，只有 composition bundles 可依赖 spine 插件（`packages/README.md:68`）；util 组是 zero-dependency、harness-dep-free（`packages/README.md:60`）；examples 只声明依赖不被构建（`examples/AGENTS.md:3-8`）。

### 2.2 单包内部布局

**纯 host 包**（`packages/todo/tool-todo`）：`src/` = `index.ts` + `invariant.ts` + `client.ts` + `types.ts`（`src/types.ts` 只许类型，`packages/AGENTS.md:23`）；测试在包级 `tests/`（规则 `packages/AGENTS.md:24`）；tsconfig extends `../../../tsconfig.base.json`，`rootDir: src`、`outDir: lib/types`、references 列每个 workspace 依赖（`packages/todo/tool-todo/tsconfig.json:1-6`；规则 `packages/AGENTS.md:22`）。

**带 client 的包**（`packages/client/ui-plan`、`packages/client/ui-trajectory`）：

```
src/index.ts            # host 半身入口（Node；纯 UI 包为空 apply）
src/invariant.ts        # 纯函数 invariant（可独立 import）
src/client/index.ts     # client 半身入口（浏览器，cordis 插件）
src/client/*.tsx        # React 组件（与同名 *.module.css 配对）
src/client/locales.ts   # zh/en 词典
src/css-modules.d.ts    # CSS Modules 类型声明
tests/                  # 测试（与 src 平级）
tsconfig.json           # extends ../../../tsconfig.base.client.json
tsdown.config.ts        # 复用 ../tsdown.client.ts 预设
package.json / README.md / README.zh.md / README.i18n.yaml
```

- host 与 client 代码以 **`src/client/` 子目录 + `./client` 子路径 exports + `dsh.client` 自描述清单**分离（`packages/client/ui-plan/package.json:25-40`）。
- 双流包（如 `packages/client/connection`）同时有 `tsconfig.client.json`/`tsconfig.host.json`，测试按 `*.client.spec.ts` / `*.host.spec.ts` 分属两聚合（根 `tsconfig.client.json:34-39`）。

### 2.3 两套 tsconfig 基准

- `tsconfig.base.json:1-30` — 宿主侧基准：target es2024、module esnext、moduleResolution bundler、composite/incremental（project references，:12-13）、`types: ["node"]`（:26）、`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（:16-17，源码直接写 `.ts` 后缀导入）、严格全家桶（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等）、:30-290 的巨大 `paths` 表把每个 `@deepseek-ai/*` 映射到对应 `src`（源码级解析门面，vite-tsconfig-paths 也挂这里）。注释明确禁止加 `include/files`。
- `tsconfig.base.client.json:1-12` — extends base，覆盖为浏览器形态：`jsx: react-jsx`、`lib: ["ES2024","DOM","DOM.Iterable"]`、无 node ambient types、`types: ["client-build-environment"]`。`packages/client/*` 的 tsconfig extends 它（例：`packages/client/ui-trajectory/tsconfig.json:2`）。
- 根 `tsconfig.json:10-14` 是 `files: []` 的 solution，只 references `tsconfig.host.json` / `tsconfig.client.json` 两个聚合——因为 host/client 在相同 cordis Context key 下 merge 不同 service、不能同程序（`tsconfig.host.json:2-4`）。

### 2.4 产物、exports 与构建工具链

- 产物在 `lib/`：**tsc 先 emit `lib/types`（声明 + JS 中间产物），tsdown 再把运行时 bundle 写 `lib/` 根**（根 `tsdown.config.ts:20-21`，`dts: false`——类型全由 tsc 发）。
- 典型 exports（`packages/todo/tool-todo/package.json:14-31`）：`main`/`types` 指向 `lib/index.js` 与 `lib/types/index.d.ts`；`"."` / `"./invariant"` / `"./client"` 子路径 + `"./src/*": "./src/*"` + `"./package.json"`。`files` 精确白名单：tool-todo 为 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*.js+d.ts`（:32-37）；ui-plan 为 `lib/{index,invariant,client}.js` + `lib/types/**/*.d.ts`（:70-75）；`vendor/cordis` 额外发 bin.js 与整个 src（原因 `vendor/README.md:48`）。
- 构建：**tsdown（rolldown 系）**。根 `tsdown.config.ts:19` workspace globs 为 `vendor/*`、`packages/*/*`、`apps/cli`（排除 examples/website/apps/web）；`--env.DSH_BUILD_FACE` 分 host/client 两 face（:4-8,17）；host face entry = `lib/types/{index,invariant,startup}.js`、ESM、platform node（:20-28）。约 75 个包有包级 tsdown.config.ts 覆盖；client 共享预设在 `packages/client/tsdown.client.ts`。
- 其他工具：apps/web 用 Vite（`apps/web/package.json:23-25`）；website 用 VitePress；native/landlock-run 只用 `tsc -b` + 自研脚本；python 用 pyproject/uv/hatch（细节未证实）。
- 全仓 scripts（根 `package.json`）：`build` → `tsx scripts/build.ts` → `build:lib`（`tsc -b` 两聚合 + tsdown 两 face）+ `build:web`；`test` = `vitest run`；`lint` = 先 `build:lib:host` 再 oxlint；`check:all`/`check:ci*` 走 `scripts/run-gates.ts` 门禁编排；`hygiene` = knip + publint + constraints。

### 2.5 包间依赖与 vendored 包角色

- workspace 内一律 `workspace:^`（`workspace:*` 仅 examples 用，`examples/AGENTS.md:3`）；包 manifest 中无 `link:`。
- `pnpm-workspace.yaml:23-25` `linkWorkspacePackages: true` — vendored 包保留上游 semver 区间但解析到本地 pinned 源码；`vendor/README.md:5` 补充 `verify-vendored-links` 门禁断言 lockfile 中无 registry 副本。overrides（:27-29）把 `@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery` 强制 `link:` 到 vendor 目录。
- vendored 角色（manifest 表 `vendor/README.md:13-23`）：`cordis` = 插件框架本体（DI/scoped services/生命周期）；`cosmokit` = 通用工具库；`schemastery` = 类型驱动 schema 校验器；`loader` = 运行时插件加载器（EntryTree）；`include` = 文件 backed loader 树（cordis.yml 载体，YAML↔entries 双向）；`group` = 条目嵌套；`timer` = disposal-aware 定时器；`hmr` = loader 管理的插件热替换；`logger-console` = 内置 logger 的 console 导出器。

### 2.6 命名与版本

- 命名：`AGENTS.md:101` "Every npm package is @deepseek-ai/dsh-<name>"，目录名 = 包名去 scope，故 `tsconfig.base.json:240-289` 用一条 `@deepseek-ai/dsh-*` 通配映射；例外：client/host 组带组前缀（`dsh-client-*`/`dsh-host-*`，:153-157）、sdk 组带 `sdk` 前缀（:233-237）、experimental 带 `experimental-` 中缀；vendor rescope 为 `@deepseek-ai/cordis[-plugin-*]` 等（`vendor/README.md:5`）；`apps/cli` 发布名 `@deepseek-ai/dsh`。
- 版本：**dsh 家族统一版本**——227 个 packages/apps 包全为 `0.1.1-rc.2`（= 根版本），规则 `scripts/release/bump.ts:6-9`；**vendor 家族逐包独立版本**但每次发布推进整族（`bump.ts:9-11`；实证 4.0.1 / 1.8.2 / 3.18.1 / 1.0.x 各不相同）。三个独立发布序列：packages+apps / vendor / native（`scripts/release/families.ts:1-6`）。无 changesets；发布为自研脚本 `release:dsh|vendor|verify|pack|publish`（根 `package.json:135-140`），"CI never writes to the repository"（`bump.ts:12-13`）。

---

## 3. 样式与组件划分

### 3.1 apps/web 结构与 CSS 方案

- **apps/web 只是极薄的 Vite 入口壳**，真正的 UI 全部在 `packages/client/` 的 workspace 库里。`apps/web/src/main.ts:1-10` 仅 10 行：找到 `#root` 后交给 shell 库（"thin bootstrap over the shell library. Everything … lives in @deepseek-ai/dsh-client-web"），`apps/web/package.json:2-3` 自述 "vite build over the @deepseek-ai/dsh-client-web shell library; dist/ served by apps/cli's dsh web"。
- **UI 框架是 React 18**：`apps/web/package.json:37-42`（`react ^18.2.0`、`react-dom`、`@vitejs/plugin-react`）；`apps/web/vite.config.ts:4,111` `plugins: [..., react()]`。无 Vue；vite/tsdown 配置与依赖清单中**无任何 Tailwind/SCSS/styled-components 迹象**（未证实有任何使用）。
- **CSS 方案 = CSS Modules（`.module.css`）+ CSS 变量 design token**：
  - 组件与样式成对：`packages/client/ui-primitives/src/Button.tsx:6` `import css from './Button.module.css'`，`:26` `className={clsx(css.button, css[variant], css[size], className)}`；同目录 `Button.module.css`。
  - 组件 CSS 直接消费 token：`packages/client/ui-primitives/src/Button.module.css:14` `color: var(--dsw-alias-label-primary);`、`:41` `background: var(--dsw-alias-button-primary-fill);`。
  - 每个包带 `src/css-modules.d.ts` 声明（如 `packages/client/ui-goal/src/css-modules.d.ts`）。
  - 构建管线：`packages/client/tsdown.client.ts:6-11` — CSS 由 lightningcss 在 bundle 内编译；`x.module.css` 产出 hashed class map 并在 factory 执行时注入带标记的 `<style>`；`x.css?inline` 导出编译文本供插件自有生命周期 effect 使用。style 注入器带 `data-plugin` / `data-plugin-css` 去重标记（`packages/client/tsdown.client.ts:34-50` `styleInjectionModule`）。
- **三层 CSS 变量 token 体系**（`packages/client/ui-theme/src/styles/`：`base.css`、`design-platform.css`、`scrollbar.css` 等）：
  - `--dsw-static-*` 静态色板（`design-platform.css:5-40` 起）→ `--dsw-alias-*` 别名层（同文件 :180-235，如 `:191 --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary)`）→ `--dsw-specific-*` 组件专用（:228-238）。
  - 暗色主题靠 `body[data-ds-dark-theme]` 属性选择器重定义整套 alias（`design-platform.css:242` 起）；切换逻辑在 `packages/client/ui-theme/src/boot-theme.ts:17-20`（`prefers-color-scheme` + `toggleAttribute`）。
  - 全局样式挂载：`packages/client/ui-theme/src/client/styles.ts:3-7` 用 `import base from '../styles/base.css?inline'`，`:23-36` `installThemeStyles()` 插入 `<style data-plugin-css=...>` 并随插件 dispose 移除。

### 3.2 共享 UI / design token 与挂载点

- **共享组件库：`packages/client/ui-primitives`**（`@deepseek-ai/dsh-client-ui-primitives`）：Button、Input、Menu、Modal、Pill、Toast、Tooltip、HoverCard、JsonTree、TerminalBlock、DiffBlock、icons/、markdown/ 等（`packages/client/ui-primitives/src/`）。它是 platform module（`packages/client/web/src/platform.ts:11`），经 module table 与插件共享单例。
- **运行时模块表**：`packages/client/web/src/seed.ts:21-32` `getStaticModules()` 把 `react`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives` 冻结进 module table；fetch 来的插件 bundle 通过注入的 require 解析到同一份实例。
- **UI 挂载点 = slot 注册表（不是路由）**，核心包 `packages/client/ui-slots`：
  - `packages/client/ui-slots/src/index.ts:24` `export interface SlotMap {}` —— 各包用 `declare module` 声明合并扩展；`:88` slot 种类 `kind: 'single' | 'list' | 'keyed' | 'chain'`；`:91` 作用域 `scope: 'root' | 'session-maybe' | 'session'`。
  - 注册 API：`ctx.slots.register({ name, id/key, order, store, locale, inject }, Component)`（例：`packages/client/locale/src/client/index.ts:426-433` 注册 `'settings.general.item'`）。
  - 顶层 slot 树由 `ui-layout` 声明：`packages/client/ui-layout/src/client/index.ts:33-80`（`'sidebar'`、`'conversation'`、`'details'` 等 single slot 与 frame-wide floating layer）。
  - conversation 内部 slot：`packages/client/ui-conversation/src/client/contract/slots.ts:61-96`（`'conversation.session'`、`'conversation.session.header'`、`'conversation.session.header.actions'` 等）。
- **插件声明**：package.json 的 `dsh.client` 字段（例：`packages/client/ui-goal/package.json:32-42`）；浏览器端 `WebBootEntry { id, url: '/plugins/<id>/client.js?rev=<rev>', rev, inject?, ... }`（`packages/client/modules/src/client/manifest.ts:44-58`）。
- 动态 UI 渲染器：`ctx.uiRenderer.mount(el)`（`packages/client/web/README.md:5`），`packages/client/ui-renderer` 包。

### 3.3 代表性 UI 包的 client 侧组织范式

`packages/client/ui-goal`（`@deepseek-ai/dsh-client-ui-goal`，"Session goal surface: GoalBar docked above the composer"）完整布局：

```
package.json            # dsh.client 声明（:32-42）
tsdown.config.ts        # 1 行：clientBundle('@deepseek-ai/dsh-client-ui-goal', [...])
src/index.ts            # node 半侧入口：空 apply()（注释 :1-5：浏览器半身经 exports['./client'] + dsh.client 声明被发现）
src/invariant.ts
src/css-modules.d.ts    # '*.module.css' 类型声明
src/client/index.ts     # 浏览器半侧入口：apply(ctx) 注册一切
src/client/GoalBar.tsx  + GoalBar.module.css    # 组件/样式配对
src/client/GoalCommandInputView.tsx + .module.css
src/client/locales.ts   # zh/en 词典，zh 为 key 集源头
src/client/slots.ts     # 契约类型
tests/*.client.spec.tsx # 包级 tests/ 目录
```

注册方式（`packages/client/ui-goal/src/client/index.ts`）：

- `:41` `export const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale', 'conversationEvents']`。
- `:49` 词典：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-goal: dictionaries')`。
- `:51-55` keyed slot：`ctx.slots.register({ name: 'conversation.chat.node', key: 'command-input', locale: NS }, GoalCommandInputView)`。
- `:72-99` list slot：`ctx.slots.register({ name: 'conversation.input.dock', id: 'goal', order: 10, locale: NS, inject: (sessionId) => ({...}) }, GoalDock)` —— `locale: NS` 声明后组件 props 自动获得类型化 `t` 席位。
- 组件消费：`GoalBar.tsx:31` `GoalBar({ ..., t }: GoalBarProps & PropsLocale<'goal'>)`；图标与 Tooltip 来自 ui-primitives（`:11-15`）。
- 类型层面声明合并：`client/index.ts:30-35` `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { goal: GoalKey } }`。

（另一例 `packages/client/ui-trajectory` 见 §2.2；纯消费者范式：注册进 conversation ViewMap，不定义 service。）

---

## 4. 其他划分

### 4.1 i18n：两套互不相干的机制

**1) 文档级双语配对（`*.i18n.yaml`）**——与运行时 UI 无关：

- `README.i18n.yaml:1-7` 自述：双语配对一致性记录，内容是两侧文件的 git blob hash（`README.md: <sha1>` / `README.zh.md: <sha1>`），改动一侧后需同步另一侧并重录（`pnpm run verify-translation-pairing --write README.md`）。
- 消费工具是仓库自带 scripts：`scripts/translation-pairing.ts:1-8,67-77`（纯解析/helper + `blobHash()`）、CLI 门禁 `scripts/verify-translation-pairing.ts`、合并工具 `scripts/translation-pairing-merge.ts`、翻译简报 `scripts/gen-translation-brief.ts`；根 `package.json` scripts: `verify-translation-pairing`、`verify-translation-prompt`、`resolve-translation-pairing-conflicts`、`gen-translation-brief`。

**2) 运行时 UI i18n = 自研 locale 插件**（不用 react-i18next 等库）：

- 核心包 `packages/client/locale`（`@deepseek-ai/dsh-client-locale`）。词典是 TS 源码对象，**zh 为 key 集源头、en 缺/多 key 是编译错误**：`packages/client/locale/src/locales/index.ts:1-7` 注释；各 UI 包自带词典文件（如 `ui-goal/src/client/locales.ts`）。
- 插件惯例：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), '<pkg>: dictionaries')` + `const t = ctx.locale.bind(NS)`（证据遍布 `packages/client/ui-*/src/client/index.ts`，如 `ui-trajectory/src/client/index.ts:31,35`、`ui-goal/src/client/index.ts:49`）。
- 命名空间表是声明合并：`packages/client/ui-slots/src/index.ts:34` `export interface LocaleNamespaceMap {}`；slot 注册带 `locale: NS` 后组件 props 获得类型化 `t`（`PropsLocale`，`:60-66,80-85`）。
- 运行时：`LocaleRuntime`（`packages/client/locale/src/client/index.ts:144`）；查找链 `:312-324`（活动 locale → en fallback → common 命名空间 → key 本身，`{name}` 插值 `:317-318`）；`register()` `:244-283`（重复 (ns, locale) 抛错）；`bind(ns)` `:294-310` 返回稳定引用。
- 仅支持 zh/en：`:107-110`；fallback 为 en（`:98`）；初始语言取 `navigator.languages` 主子标签（`:369-381`）；`<html lang>` 同步（`:120-132`）；偏好持久化经 Host settings（`setLocale` `:212-217`）；语言切换 UI 本身也是 slot 贡献（`:426-433` 注册进 `'settings.general.item'`）。

### 4.2 测试布局

- runner：**vitest**（根 `package.json` devDep `vitest ^4.1.8`；`@testing-library/react` 用于 client 组件测试）。
- 位置：包级 **`tests/` 目录**（与 `src/` 平级，不放 src 旁）。根 `vitest.config.ts:90-95` include：`packages/*/*/tests/**/*.spec.{ts,tsx}`、`apps/*/tests/**`、`examples/*/tests/**`、`scripts/**`。命名约定：`*.spec.ts`（node）、`*.client.spec.tsx`（jsdom 客户端组件测试，per-file `@vitest-environment` pragma，`vitest.config.ts:132` 注释）、`*.e2e.ts` / `*.snapshot.ts`（web 车道）。
- 多配置多车道：`vitest.config.ts`（单测主车道，thread-safe / process-bound 两 project，**per-file 100% 覆盖率门槛** `:284-292`，GUI 豁免清单 `:192-274`）；`vitest.web.config.ts:26-35`（浏览器快照车道，串行，黄金快照在 `apps/web/tests/snapshots/`）；`vitest.e2e.config.ts`（真实 API 车道，无凭证自跳过）；`vitest.snapshot.config.ts`、`vitest.web.perf/stress.config.ts`。共享件 `vitest.shared.ts`（标准装饰器预转译插件 `:15-41`）；所有配置经 `vite-tsconfig-paths` 挂 `tsconfig.base.json` paths 门面，测试直接解析 workspace 源码而非 lib 产物（`vitest.config.ts:16-20` 注释）。
- HMR 安全是普遍测试要求：大量 spec 断言「fiber dispose 时注册被移除」（如 `packages/session/session-projection/tests/registry.spec.ts:7,191`、`packages/client/ui-skill/tests/browser-plugin.client.spec.ts:145`）。

### 4.3 AGENTS.md / docs 组织

- **层级式 AGENTS.md**：根 `AGENTS.md`（10 个章节：定位段 → Pre-release stance → Repository layout → Commands → Secrets/.env → Conventions（约 30 条）→ Defensive patterns → Type safety and documentation → Editing these instructions → Vendoring policy，`AGENTS.md:1-151`）→ `packages/AGENTS.md`（"supplement the repo-wide conventions"，:3）→ group/目录级（client/、docs/、scripts/、website/、native/landlock-run/ 等），每层只写增量并回链上层。
- **`CLAUDE.md` 是指向 `AGENTS.md` 的 symlink**：根、`packages/`、`vendor/`、`examples/` 四处均为 `CLAUDE.md -> AGENTS.md`（ls -la 实证；`AGENTS.md:147` 确认约定）。
- `docs/` 按主题单篇 + cookbook/postmortem/subsystems/user 等子目录；每篇三件套 `<topic>.md` / `.zh.md` / `.i18n.yaml`，由 `verify-translation-*` 门禁保同步（根 `package.json:87-90`）；`docs/AGENTS.md:1-73` 是文档标准（结构/tier taxonomy/写作规则/slop checklist/机器可校验交叉引用）；另有 `.agents/notes/` Agent Notes 制度（`AGENTS.md:123`）；大量 catalog 文档由 `scripts/gen-*-catalog.ts` 生成并以对应 `verify-*` 钉住同步。
- 值得插件仓库借鉴：CLAUDE.md symlink 单一事实来源；分层增量 AGENTS.md；`"./src/*"` export + `.ts` 导入重写；host/client 双 face（`./client` 子路径 + `dsh.client` 清单 + 双 tsconfig base）；每包 `./invariant` 子路径；精确 `files` + publint；文档双语配对；「注释只写非显然决策」的文档纪律（`examples/AGENTS.md:18`）。

---

## 5. 对照 dsh-context：差距清单与对齐建议

dsh-context 现状（一手核实）：

- `dsh-context/package.json:14-26` — `type: module`，`main: lib/index.js`，exports: `.` → `lib/index.js`、`./client` → `lib/client.js`、`./package.json`；files: `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`。
- `dsh-context/package.json:38-51` — `dsh.bundle.patch: ./cordis.patch.yml`、`dsh.client.inject`（4 个平台包）、`platform: web`。
- `dsh-context/cordis.patch.yml:8-10` — `insert: [{ id: dsh-context, name: dsh-context }]`。
- `dsh-context/tsup.config.ts:32-73` — host: ESM、`platform: node`、external `zod`/`@deepseek-ai/dsh-session`；client: CJS、`platform: browser`、external `react`/`@deepseek-ai/dsh-client-ui-primitives`，手写 banner/footer 包装成 `window.__ModuleLoader__.load({id, factory})`。
- `dsh-context/src/host/index.ts:24-38` — cordis 插件形态（`name`、`inject = ['sessionProjections']`、`Config`、`apply`）。
- `dsh-context/src/client/index.ts:36-50` — `ctx.locale.register(NS, {zh, en})` + `ctx.locale.bind` + 插件自有 `<style data-plugin>` 注入，与官方范式一致。
- 测试：`tests/*.test.mjs`，用裸 `node` 运行（`package.json:32`），非 vitest。

### 已一致 ✅

1. **cordis.patch.yml + `dsh.bundle.patch` 声明**：与官方 bundle 包约定逐字一致（`packages/boot/app-boot/src/profile.ts:10`、`packages/bundle/base/tests/base.spec.ts:23`）。
2. **`dsh.client.inject` + `platform: web`**：与官方 client 包同构（`packages/client/ui-trajectory/package.json` 的 `dsh.client`）。
3. **client bundle 为 closure-factory CJS、id 用包名**：banner/footer 与 `packages/client/tsdown.client.ts:562-565` 等价（dsh-context 把 `var module` 放进 banner，官方用 `intro`，语义相同）。
4. **externals 选择**：`react`、`@deepseek-ai/dsh-client-ui-primitives` 恰在 platform module 表内（`packages/client/web/src/platform.ts:8-12`）。
5. **exports 双半身** `.` / `./client`、产物命名 `lib/index.js` + `lib/client.js`、`files` 含 `cordis.patch.yml`：与官方一致。
6. **host 插件形态**（`name`/`inject`/`Config`/`apply`、effect-scoped 注册、projection 数据面）：与官方 host 包一致。
7. **i18n 范式**（`locale.register` + `bind`、zh/en 词典）与**样式注入**（`<style data-plugin>`、CSS 变量主题）：与官方一致。

### 有差距 ⚠️ 与建议改动（按优先级排序）

> P0 = 影响正确性/契约；P1 = 影响可维护性与官方演进对齐；P2 = 锦上添花。

**P1-1. 构建工具：tsup → tsdown（或至少精确镜像官方包装三段式）**

- *差距*：官方全部 client 包用 tsdown + 共享预设 `clientBundle()`（`packages/client/tsdown.client.ts`），dsh-context 用 tsup 手写 banner/footer（`dsh-context/tsup.config.ts:15-25`）。
- *为什么*：官方预设的包装是**三段式**——`banner`（`window.__ModuleLoader__.load({id, factory: (require) => {`）+ `intro`（`var module = ...; var exports = ...;`）+ `footer`（`return module.exports; } });`）（`tsdown.client.ts:562-565`）。dsh-context 把 `var module` 塞进了 banner，语义等价但分叉了；且官方预设附带 purity gate（`@deepseek-ai/*` 值导入报错）、CSS 虚拟 loader、`import.meta.env` define 等护栏（`tsdown.client.ts:415-497`），tsup 配置全都没有。
- *怎么做*：迁到 tsdown，standalone 配置照抄 `tsdown.client.ts:437-566` 的 outputOptions（banner/intro/footer、`entryFileNames: 'client.js'`）与 external 规则（baseline external 列表见 `packages/client/AGENTS.md:73-97`）；预设本体 import 了 monorepo 内部模块，不能直接复用，需复制等价逻辑。改动 `tsup.config.ts`（重命名 `tsdown.config.ts`）、`package.json` 的 `scripts.build/watch` 与 devDependencies（`tsup` → `tsdown`）。

**P1-2. 发布类型（d.ts）**

- *差距*：`dts: false`（`tsup.config.ts:43,59`），exports 各条目无 `types` 条件，无 `lib/types/**`；官方 client 包发 `lib/types/**/*.d.ts` 且 exports 每条目带 `types`（`packages/client/ui-trajectory/package.json` exports/files）。
- *为什么*：host 半身的 `Config` 等类型是其他插件/工具集成的契约；官方依赖 tsc project references 产类型，外部仓库至少应为 host 半身产 d.ts。
- *怎么做*：tsup host 配置开 `dts: true`（或独立 `tsc --emitDeclarationOnly --outDir lib/types`），exports 改为 `"."：{ "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }` 形态，`files` 加 `lib/types`。改动 `tsup.config.ts`（或迁移后的 tsdown 配置）、`package.json`。

**P1-3. 测试：裸 node .mjs → vitest**

- *差距*：`node tests/host.test.mjs && node tests/client.test.mjs`（`package.json:32`），无 runner；官方唯一 runner 是 vitest，测试集中放包级 `tests/`，分 `*.spec.ts` / `*.client.spec.tsx`（jsdom pragma）车道（`vitest.config.ts:90-95,132`）。
- *为什么*：官方有 `@deepseek-ai/dsh-client-test-runtime` 等测试基建（`packages/client/ui-trajectory/package.json` devDeps）与 jsdom client spec 约定；裸 node 测试无法覆盖 React 组件与 slot 注册。
- *怎么做*：引入 vitest + jsdom，host 测试迁 `tests/*.spec.ts`，client 组件测试用 `*.client.spec.tsx`（`// @vitest-environment jsdom`）；补「fiber dispose 时注册被移除（HMR 安全）」断言（官方普遍要求，如 `packages/session/session-projection/tests/registry.spec.ts:7`）。改动 `tests/`、`package.json` scripts、新增 `vitest.config.ts`。

**P2-4. 样式：手写字符串 CSS → `*.module.css`**

- *差距*：`src/client/styles.ts` 是手写字符串数组、全局 `lc-*` 类名；官方组件/样式成对（`X.tsx` + `X.module.css`），lightningcss 产出 `[hash]_[local]` hashed class map 防冲突（`packages/client/tsdown.client.ts:33-53`）。
- *为什么*：全局类名有与其他插件/壳冲突的风险；CSS Modules 是官方防冲突机制，且随 factory 物化注入、HMR 时按 `data-plugin` 整组移除（`packages/client/hmr/src/client/index.ts:86-91`）。
- *怎么做*：迁到 tsdown（P1-1）后把 `styles.ts` 拆成各组件同名 `.module.css`，`import css from './x.module.css'`；继续只消费 `--dsw-alias-*` token（已一致，无需改）。若不迁 tsdown，维持现状可接受（`data-plugin` 标记已正确），但需保持 `lc-` 前缀纪律。
- *备注*：官方 slot 注册的 `locale: NS` 声明可让组件 props 自动获得类型化 `t`（`packages/client/ui-slots/src/index.ts:60-85`），dsh-context 手动 `ctx.locale.bind` 等价可用；若未来迁移到 slot 注册 API 可顺带获得类型化 t。

**P2-5. 文档组织**

- *差距*：无 `CLAUDE.md`、无 `README.zh.md`；官方 `CLAUDE.md` 是指向 `AGENTS.md` 的 symlink，README 双语配对（`README.i18n.yaml` 记录 blob hash）。
- *怎么做*：加 `CLAUDE.md -> AGENTS.md` symlink；手工维护 `README.zh.md`（外部仓库无需引入官方 i18n.yaml 哈希工具链——那是 monorepo 内 gate，见 `scripts/verify-translation-pairing.ts`）。改动：新增 `CLAUDE.md`、`README.zh.md`。

**P2-6. exports 透传 `./src/*`**

- *差距*：官方包暴露 `"./src/*": "./src/*"` 便于源码级调试（`packages/client/ui-trajectory/package.json` exports）；dsh-context 没有。
- *怎么做*：可选，在 `package.json` exports 加 `"./src/*": "./src/*"`，`files` 相应加 `src`（若不发布 src 则跳过，官方 `files` 不含 src 也能透传是因为 npm 总是带上 exports 指向的文件——未证实，需实测）。

**P2-7. peerDependencies 的 optional 标记复核**

- *差距*：`zod` 被标 `optional: true`（`package.json:77-79`），但 host 半身 `import { z } from 'zod'` 且构建时 external（`tsup.config.ts:39`）——运行时必需。`react` 标 optional 是合理的（仅 client 半身用，由浏览器 module table 提供）。
- *怎么做*：把 `zod` 从 `peerDependenciesMeta.optional` 移除（或改入 `dependencies` 内联——但官方纪律是 cordis/运行时契约永远 peer，见 `packages/client/AGENTS.md:59-67`，故保持 peer、去掉 optional 更对齐）。改动 `package.json`。

### 外部插件与仓内包的本质差异（不可对齐项）

以下为仓内机制，外部插件**不适用**，列出以免误对齐：

- `packages/client/AGENTS.md:132-141` 的新包 checklist（注册进 `tsconfig.client.json`、`packages/bundle/web-app/cordis.patch.yml` 加行、web-app `package.json` 加依赖）只对仓内包有意义；外部插件走 `dsh plugin --profile <name> add <pkg>` + 自带 `cordis.patch.yml`（dsh-context 现状正确，`scripts/register.sh` 即是）。
- 仓内统一版本 `0.1.1-rc.2` 与 `workspace:^` 依赖是 monorepo 内部策略；外部插件独立 semver（dsh-context `0.22.0`）+ 对 `@deepseek-ai/*` 用 semver peer range（现状 `^0.1.0-rc.7`，合理）。
- 官方 `clientBundle()` 预设 import monorepo 内部模块（`./modules/src/...`、`../../scripts/client-build-environment.ts`），外部仓库无法直接复用，只能镜像其输出契约。
