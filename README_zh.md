![Social preview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[English](README.md)

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**适用于 Agent 上下文洞察与管理的最佳 [DeepSeek Harness 插件](https://www.deepseek.com/harness/)。**

> 获得 DeepSeek Harness 团队成员 [@tianyicui](https://github.com/tianyicui) 和 [@turtle1999](https://github.com/turtle1999) 推荐并加星——参见 [X 上的这条帖子](https://x.com/tianyi/status/2105256532657267119)。

[`dsh-context`](https://www.npmjs.com/package/dsh-context) 提供完整的上下文生命周期管理功能。
- **上下文洞察页面** — 跨会话总览，作为一级侧边栏面板（与 Plugins 和 Automation tasks 并列）：包含 7 天 Token/成本使用图表的 KPI 栏、活动热力图、汇总组成环形图，以及可筛选并可直接跳转至任一会话的会话卡片。
- **Context 标签页** — DeepSeek Harness 上下文统计、组成、趋势、事件、消息和命令执行的 UI 上下文仪表板。
- **Fleet 标签页** — Agent 家族专属页面：当前 Agent、它的父级，以及每个子 Agent 各自显示为一张实时卡片。
- **Context 面板** — 同一仪表板也可作为右侧边栏标签页：在侧边栏指南页面选择 **Context**，面板便会在聊天旁打开，并包含 Agent 网络。
- **`/context` 命令** — 斜杠命令会显示当前上下文组成模型和近期上下文演变。

## 安装 / 更新

### 在 DeepSeek Harness 网页版或桌面版中安装

在 **Add plugin** 向导的搜索框中填写 `dsh-context`，然后点击 **Install**：

![Add_plugin_wizard](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/add-plugin-wizard.png)

### 使用 `dsh` CLI 安装

从 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 安装 [`dsh-context`](https://www.npmjs.com/package/dsh-context) 插件：

```sh
dsh plugin --profile web add dsh-context
```

或更新 `dsh-context` 插件：

```sh
dsh plugin --profile web update dsh-context@latest
```

然后使用 `dsh web` 启动 Web UI。无需构建，也无需重启。

## 使用方法

五种入口，讲述同一件事——你的 Agent 正在携带什么、它如何获得这些内容，以及它如何使用这些内容：

| 入口 | 功能 |
| --- | --- |
| **上下文洞察页面** | 一览所有会话：使用量、成本、缓存命中率、每日活动以及每个会话的上下文概况；可按时间范围、日期、分组或搜索筛选，并一键跳转。 |
| **Context 标签页** | 完整仪表板：统计、组成、逐请求趋势、事件、文件活动和命令执行——适用于每个会话。 |
| **Fleet 标签页** | Agent 网络：当前 Agent、它的父级以及所有子 Agent，实时呈现。 |
| **`/context` 命令** | 居中弹窗，提供相同的组成信息和上下文浏览器，无需离开聊天。 |
| **Preferences 卡片** | 每位用户的默认设置：面板入口、洞察时间范围、趋势与排序默认值、显示货币，以及拼接在每个会话系统提示词前后的前缀/后缀。 |

## 🗂️ 上下文洞察页面

点击侧边栏面板列表中的 **Context Insights / 上下文洞察**（与 **Plugins** 和 **Automation tasks** 位于同一层级），页面便会作为完整的中央栏面板打开：

![The Context Insights page](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| 区块 | 解答的问题 |
| --- | --- |
| **KPI 栏** | 我的使用量如何——所选时间范围（7 天 / 30 天 / 全部）内活跃的会话，其计费 Token、预估成本、缓存命中率和轮次按 step 发起日归因；工具执行与活跃时长则统计这些会话及其子 Agent 的全部生命周期，与耗时统计卡片一致。 |
| **7 天使用量图表** | 每天的花费和用量如何——最近 7 天每天的计费 Token 和预估成本以成对柱状图展示，按会话自身各请求的时间汇总（而不是按会话最后活跃日期）。 |
| **活动热力图** | 我实际在什么时候工作——最近 8 周每日的计费 Token；点击某天即可筛选当天活跃的会话。 |
| **设置入口** | 热力图下方的一行快捷入口——与 Context 标签页 Plugin Info 卡片中通往此插件偏好设置的受保护跳转相同。 |
| **Context Composition** | 所选时间范围内的计费 Token 按 Context 标签页的组成分类拆分。 |
| **会话卡片** | 每个会话的概况：组成环形图、计费 Token、轮次、成本以及工作区分组 / 项目路径；可按最近活动、Token 数或上下文大小排序、搜索、按工作区分组。点击卡片即可打开会话。 |

## 📊 Context 标签页

打开任意会话并点击 **Context / 上下文** 标签页：

![Context panel overview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| 卡片 | 解答的问题 |
| --- | --- |
| **Context Stats** | 轮次、步骤、用户输入、实时工具调用——以及根据 models.dev 价格列表估算的成本（将鼠标悬停在 `?` 上可查看每百万 Token 单价；仅 DeepSeek 区分高峰 / 非高峰：其挂牌价为谷时价，高峰时段按 2 倍计费）。 |
| **Token Stats** | 计费 Token 用在了哪里——总量与输入框下方聊天统计行相同，按组成（system、tools、messages……）拆分，并以服务商精确报告的输出 Token 补足环形图，角落显示会话缓存命中率。 |
| **Timing Stats** | 活跃时间如何分布在模型调用、工具运行和开销之间。 |
| **Current Context** | 此刻窗口中的内容。 |
| **Context Trend** | 每个请求的大小及其变化过程。 |
| **Context Browser** | 任意请求实际由哪些内容组成。 |
| **Context Events** | 上下文窗口何时以及为何发生变化。 |
| **File Activity** | Agent 对你的文件做了什么。 |
| **命令执行** | Agent 执行了哪些命令、每次运行如何结束、主要用到了哪些程序。 |

标题中的占用率和组成数据读取的都是与聊天输入框上下文环形图相同的**官方 Token 计量投影**（`contextPressure` / `contextBreakdown`），因此数值始终与环形图一致——卡片中的百分比就是同一占用率，精确显示到小数点后一位。

**Context Stats** 卡片中的 Agent Network 单元格会跳转至 **Fleet** 标签页，查看整个 Agent 家族的计费 Token 和预估成本。输入输出一行的胶囊同样是跳转链接：**用户输入** 打开上下文浏览器的用户消息，**读取 / 写入 / 搜索 / 图片** 落到文件活动卡片并选中对应筛选。

### Context Stats

#### Token Stats 和 Timing Stats
![Token_Stats_and_Timing_Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Context Stats
![Context_Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)

### 🧱 当前上下文 — 此刻上下文窗口中的内容

![Current Context card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

六种颜色的堆叠条，以模型的完整窗口为基准（末尾两个带斜线的区域 = 自动压缩预留空间：先是其余量，再是请求预留的输出窗口）：系统提示词、工具定义、用户消息、注入上下文、助手回复、工具结果——每项都显示约略 Token 数和占比。当对话开始退化时，可以在这里看到*具体是哪部分*导致的。

### 📈 上下文趋势 — 按轮次或步骤查看上下文的增长与演变

![Context Trend with the step brief](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

每个模型请求对应一根堆叠柱——比按消息划分更细，因此可以逐轮观察窗口的增长：

- **✨ 步骤摘要** — 图表下方有三行通俗摘要：**User** 回顾开启该轮的消息，**In** 列出新加入的内容（通常是先前的工具结果），**Response** 显示回复和/或调用的工具。点击某行即可在 Context 浏览器中打开对应消息。
- **✂ 标记事件** — 压缩和清理事件会标记在发生时对应的柱上，因此下降的原因一目了然。
- **按你的方式阅读** — 可选择 **Step / Turn** 粒度、**Total**（累计组成）或 **Delta**（每个请求的有符号变化），并可横向滚动查看整个会话。在 Delta 模式中，增长会堆叠在基线上方，压缩则会向下延伸：

![Context Trend in Delta mode](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **总览** — 一个开关即可将整个会话（步骤或轮次）压缩到面板宽度内，形成连续的堆叠带：一眼查看每次压缩造成的下降和组成变化，无需横向滚动，也无需额外加载内容。标记显示四分位点和完整范围；悬停可浏览读数，悬停某条分类带可将该分类整条点亮，点击会固定步骤并在上下文浏览器中展开该分类（与 DNA 模式和 Adaptive 互斥）。
- **悬停和固定** — 悬停可即时查看提示信息；点击可固定完整明细，并在估算值旁显示服务商报告的 **Actual Prompt / Output / Cache**。
- **实时联动** — 将鼠标悬停在柱上，可在图表旁的 Context 浏览器中预览该步骤组装的上下文；离开图表后恢复你自己的选择。

### 🧭 上下文浏览器 — 查看任意请求的内容

选择 **Live（下一个请求）** 或任一保留的步骤，即可浏览该请求由哪些内容组成：七个可折叠类别可展开为逐项列表，每项都显示 Token 开销；每项还可再次展开，查看其**实际内容**——系统提示词、每个工具的 JSON schema、消息文本、推理内容、工具参数和工具输出。技能内容（可用技能目录、`/skill` 调用和 `skill` 工具加载）有独立的 **Skill Injections** 类别，因此隐蔽技能的上下文占用不会藏在注入上下文或工具结果类别中。

- **每种工具由谁提供** — 每行工具定义都带有尽力识别的来源标签：`tool-*` 表示一方软件包，`dsh-*` 表示功能软件包，`mcp:<server>` 表示代理，或显示由 `tools.register()` 实时监控的确切插件。可按**大小 / 名称**排序，并通过每个类别各自的可搜索字段进行筛选：

![Tool schemas with source chips, filter, and sort](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **按类型筛选助手回复** — 助手类别的搜索框包含 **Thinking / Tools / Answer** 标签，并显示所选步骤中的消息数（一次回复可包含多种类型）；点击某个标签即可只保留匹配的回复，再次点击可清除筛选：

![Assistant replies with kind filter chips](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-assistant-kinds.png)

- **展开工具结果可查看完整调用** — 工具名称、参数及其 **OK/error** 状态，以及带行数和 **Raw / Markdown** 切换的结果正文：

![A tool result expanded with Raw/Markdown toggle](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **附件按顺序显示为卡片** — 消息中的 `image` 和 `file` 区块会按消息中的顺序排列在一起，每个区块对应一张卡片：图片显示缩略图、尺寸、存储大小和 DeepSeek 官方图像 Token 估算；其他文件显示类型图标、扩展名和存储大小。点击一次即可在 dsh 自带的预览栏中打开附件（支持 Markdown、代码、PDF、Office 和图片查看器），并使用文件的真实名称：

![Image attachment cards with their dimensions, stored size, and token estimate](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **与上一轮对比** — 各类别的有符号差异徽标（`+N` 项、`±Nk` Token）让你一眼看出某轮新增或回收了什么。压缩前的旧步骤会从已移除消息存档中重建；若某步骤的组成仅为近似值，卡片会明确说明。

- **DNA 模式将上下文平铺展开** — 条形图按模型读取顺序逐项绘制色带，下方把同样的内容铺成一张平铺列表，最新的消息在最上（模型按从旧到新读取，列表即该顺序的倒排）：每行带有其在提示词中的位置（`#12`）、类别、引入步骤和 Token 开销，展开后可见同样的完整内容；工具定义与系统提示词作为两个分组行收尾。卡片与旁边的组成卡片、趋势卡片等高收尾——完整平铺的会话在卡片内滚动，而不会淹没整个页面。

### ⚡ 上下文事件 — 上下文窗口何时以及为何发生变化

![Context Events with a compaction](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

每次注入、压缩、清理、模型切换和计划模式切换都会记录，并标注其来源（指令文件、插件 ID、技能名称）、Token 净变化量（压缩事件会显示回收量）、轮次 / 步骤和时间。**Inject / Compact / Prune / Switch / Mode** 标签可按类型筛选日志，每个标签都显示整个会话的对应事件总数。

### 📁 文件活动 — Agent 对文件做了什么

![File Activity](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

每个被操作的文件显示一行——读取、写入或搜索；数据会汇总至趋势图中所选的步骤：

- **按用途统计数量**，标题栏标签也可用作筛选器（**Read / Written / Searched / Images**），并提供路径搜索框。
- **行数变化** — 每个 `edit` / `write` 操作都会计入估算的 `+新增 / −删除` 行数，可查看单个文件及汇总值。
- **所有模式均计入** — 原生工具、Minimal 预设的 `str_replace_editor`，以及 PTC `run_code` 程序中的嵌套调用，都会汇总到各工具对应的行中。
- **搜索结果对应实际文件** — 匹配的文件会有自己的操作行，并显示命中次数。
- **点击一行**可展开完整操作日志——每个操作都可直接跳转到 Context 浏览器中对应的工具结果。
- **点击文件名**可在右侧 Sidebar 中打开文件预览，与内置 Files 侧边栏的行为完全相同——使用相同的查看器和每个文件独立的标签页。如果 Harness 没有该栏，则文件名仍会像以前一样在系统中打开。

### 🖥️ 命令执行 — Agent 跑了什么

![Command Executions](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/command-executions.png)

每次 Shell 和代码执行的状态、墙钟耗时与步骤定位，附带会话摘要、值得注意的快捷入口和程序分布。程序分布始终保持全局，搜索与状态筛选只收窄右侧列表；点击程序即可下钻并高亮该行，分布不会因筛选而收缩。

## 🚢 Fleet 标签页

打开任意会话并点击 **Fleet / 编队** 标签页（位于 **Context** 右侧）——Agent 家族拥有自己的页面，为后续协作功能留出空间：

![11 个 Agent 的编队总览：摘要、Agent 网络、编队成员与任务](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-overview.png)

页面顶部的编队摘要先给出 Agent 数量与状态、实时上下文、预估成本和任务进度，再把同一个家族交给四个联动区域：**Agent 网络**、**编队成员**、**任务**与**通讯记录**。在图谱或成员板上选中某个 Agent，任务与通讯通道会一并收窄到该 Agent，整页一次只回答一个成员的情况。

### 🕸 Agent Network — 家族全景

当前 Agent、它的父级以及所有子 Agent——每个 Agent 一张卡片，显示标题、实时上下文大小和窗口占用率、组成条，以及运行时长和已执行的步骤数。连线以各自血缘关系的颜色从父级展开；悬停在卡片上可高亮其整条关系链，并在详情栏查看完整明细；点击卡片可跳转至该会话自己的 Context 标签页。运行中的 Agent 会通过入边上的绿色脉冲和标题旁 Harness 自带的滚动指示器显示活动状态；任务完成后，指示器会变成与标题子 Agent 列表相同的绿色圆点。面板较窄时，家族会折叠成整齐的行——不会出现横向滚动条。

### 👥 编队成员与任务 — 谁在做什么

每张团队成员卡显示角色（主控或队友）、运行模型、最新回复、运行时长与步数，以及进行中的任务数；其余 Agent 以同样的卡片列在下方。卡片上的按钮可把该 Agent 的聊天打开到侧边栏或整页；搜索和状态筛选同时收窄两段名单，排序菜单可让其余 Agent 保持派生顺序，或按 Token、时长、步数、最近活动排序。下方的 **任务** 板把团队任务与子 Agent 派发放在同一处：按负责人分组、可按状态筛选；聚焦某个任务时，整条阻塞前置链会一起点亮。点击任务即可原地展开完整描述（原文 / Markdown），任务板会把它滚动到最前，分组标题固定在顶部。

### 📡 通讯记录 — 谁在和谁说什么

通讯卡片会自动读取编队的会话日志，不再需要手动扫描。团队私信、邮箱投递与运行时的结算通知会合并成一条条通道：每张通道卡把主控（或当前 Agent）与一个对话方配对，写明双方身份，并显示双方各发了多少条消息。时间线同样标明双方与角色。点击任意一条消息，完整记录会在它下方内联展开——来源会话日志与序号、对运行时结算记录（而非子 Agent 直接消息）的提示、完整的完成报告（含结构化结果或诊断），以及可直接打开对方聊天（侧边栏或整页）的参与者卡片。可以按消息类型或文本搜索、切换排序；图谱和成员板上的共享选择也会收窄整个通讯区域。较早的历史与被截断的摘录会明确标注，而不是悄悄省略。

![展开一条结算记录的通讯记录](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-comms.png)

右侧 Sidebar 的 **Context** 面板会内嵌相同的卡片，因此你阅读聊天时，Agent 家族始终只需点击一次即可查看。如果不需要该标签页，可在 Preferences 卡片中关闭 **Fleet tab**——卡片仍会保留在该面板中；只要 Harness 提供 Sidebar，Context 标签页中的家族单元格也会在此处打开它。

## ⌨️ `/context` 命令

输入 `/context`（或从 `/` 菜单中选择），然后按 Enter：

![Slash menu with the context command](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

居中对话框会显示 **Current Composition** 卡片和 **Context browser**——与标签页相同的组成条、逐步选择器和 `vs previous turn` 差异徽标：

![The /context modal](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ 设置

**Context** 偏好设置卡片保存此插件的用户级设置——**上下文面板入口**（**Context** 会话标签页、右侧 Sidebar 面板、两者，或隐藏——隐藏后回复行的跳转按钮也随之隐藏）、**Fleet** 标签页自身的显示 / 隐藏开关（不受上下文面板入口影响）、**上下文洞察**页面的默认时间范围（今天 / 近 7 天 / 近 30 天 / 全部，默认近 30 天；在页面上点击时间范围预设会写回此项）、显示货币（跟随界面语言 / 人民币 / 美元）、趋势粒度（Step/Turn）、趋势模式（Total/Delta）、默认显示的趋势时长曲线、趋势自动总览阈值、Context Browser 对比基线、工具和 File Activity 排序，以及上下文洞察的显示 / 隐藏开关。该卡片位于 **Plugins** 页面：侧边栏的 **Plugins** 入口 → **dsh-context** 插件包页面 → **Configuration** 区域（卡片由该入口的实时 Config 表单提供）。

**System Prompt · Prefix / Suffix** 行用于填写自由文本，并将其拼接到每个会话系统提示词的最前面 / 最后面，对所有 Agent（包括子 Agent）生效——它们是随 Harness 自身提示词组装流程一同应用的部署级角色设定或行为规则。修改从下一轮开始生效；将某行留空即可停用对应设置。

上下文洞察的时间范围预设按钮会把选择写回为默认值；其余图表和卡片中的切换项仅对当前视图生效，不会覆盖已保存的偏好设置。

![The Context settings card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## 注意事项

- **估算值与实际值** — 各类别数值采用 dsh 自身的固定密度启发式算法（与内置 Token 计量器相同）；固定的趋势明细会在旁边显示服务商报告的实际值，而 Token 卡片则将基于约略值估算的组成占比与服务商精确报告的计费总量一并呈现。
- **兼容性** — 通过同一条由数据形状驱动的代码路径，支持 V4 会话日志格式的 `@deepseek-ai/dsh` **0.2.0-rc.2 及更高版本**（`0.2.0` 与 `0.2.1` 系列，已在各自的 rc.2 版本上验证）。各版本支持情况及验证方式见：[docs/compatibility.md](docs/compatibility.md)。
- **国际化** — UI 支持英文和简体中文。

## 喜欢它？

如果 `dsh-context` 帮你了解 Agent 正在携带哪些内容，欢迎在 [GitHub](https://github.com/bowenliang123/dsh-context) 点亮 ⭐——也欢迎提交 issue / PR！

## 许可证

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
