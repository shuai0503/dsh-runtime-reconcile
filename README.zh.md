# dsh-runtime-reconcile

> 一个**只读**的 Agent 工具：把「DeepSeek Harness profile 声明了什么」与「活体运行时里真正注册了什么」做对账。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](README.md) · 中文

静态扫描器看到的是一份语法合法的配置。这个工具看到的是**正在运行的进程**。它能回答那些扫描器回答不了的问题：

- 为什么 `web_search` 报 *`configured web provider "modsearch" is not registered`*，可配置明明看着没问题？
- 哪个已安装的 bundle 被禁用了，却仍被某条生效的配置行引用？
- 此刻活体工具注册表里有哪些工具名被遮蔽、哪些工具缺 output renderer？
- 这个 profile 有哪些核心服务没挂载上？

**只读**：不写文件、不联网、不改配置、不导入任何运行时包。

---

## 问题，具体地说

DeepSeek Harness 是「一切皆插件」。一个 profile 由数十个 bundle 按顺序叠加的补丁层组合而成。某行可以被插入、禁用、或被更高层覆盖；某个 provider 可以在配置里被点名，而负责注册它的 bundle 却处于 disabled。组合出来的配置**语法依然完全合法**，启动时不会有任何抱怨——直到某次工具调用走到 provider 选择才炸：

```
configured web provider "modsearch" is not registered
```

`ctx.web` 里 `config.searchProvider = 'modsearch'`，但它的活体 `searchProviders` Map 里只有那些 bundle 真正挂载后才注册的 provider。源码级检查（`dsh-trust-check`、`dsh-plugin-preflight`、`dsh-conflict-doctor`、`dsh-doctor`、`dsh-plugin-ops`）看的是**安装前/进程外**的包、清单和补丁文件，看不到这种漂移——因为漂移只在 Loader 把所有层应用完之后才存在。

`dsh-runtime-reconcile` 就跑在那个组合完成的进程内部，通过 `ctx.get()` 读活体服务。

### 与同类工具的差别

| 工具 | 检查对象 | 能看到活体 provider 表 / Loader 行吗 |
|---|---|---|
| `dsh-trust-check`、`dsh-plugin-preflight` | 包源码 / manifest | 否（装前静态） |
| `dsh-conflict-doctor`、`dsh-plugin-conflict-guard` | 声明的能力 | 否（静态 / 安装时） |
| `dsh-doctor`、`dsh-plugin-ops` | profile 文件、启动日志 | 否（启动前 / 事后） |
| `dsh-harbor` | 声明 vs 检出的 ledger | 部分（静态对账） |
| `dsh-vitals`、`dsh-system-vitals` | CPU / 内存 / GPU | 否（硬件，不是插件图） |
| **dsh-runtime-reconcile** | **活体 `ctx.web` / `ctx.tools` / `ctx.pluginManager`** | **是** |

问题规模有量化依据：[deepseek-harness 讨论 #4253](https://github.com/deepseek-ai/deepseek-harness/discussions/4253) 扫描 9,873 个真实插件，发现 553 起工具名冲突、452 起 entry id 撞车、89 个孤儿补丁静默失效。本工具**不修**这些（真正该修的在核心里），但它让**当前 profile 的状态**对用户和 Agent 都可见。

---

## 检查项

| 组 | 活体数据源 | 检出 |
|---|---|---|
| `providers` | `ctx.web.config`、`searchProviders`/`fetchProviders` Map、`DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` | 配置指向但未注册、已注册但不可用、无 provider、多 provider 歧义 |
| `bundles` | `pluginManager.listBundles()` | 已装但禁用的 bundle，**自动关联为 provider 错误的可能根因** |
| `rows` | `pluginManager.listPlugins()` | **enabled 但未进入 active 阶段**的 Loader 行、禁用行、active/total |
| `tools` | `tools.definitions()` | 可见工具数、缺 `output` renderer 的工具、列表上限 |
| `services` | `ctx.get()` 核心 seam | 缺失的可选服务 |

每条 finding 带 `severity`、`code`、`title`、`detail`、结构化 `evidence`，以及可执行的 **`remedy`**。它们是**观察结论，不是安全背书**。

某个检查组跑不起来（服务缺失、枚举抛错）会记进 `completeness.unavailable`，并强制 `ok: false` / `complete: false`——读不到注册表绝不会被报成「一切正常」。非法的 `focus` 会被拒绝，而不是静默产出一份空的 OK 报告。

---

## 安装

GitHub 源（推荐，固定到 tag 或 commit）：

```bash
dsh plugin --profile web add github:shuai0503/dsh-runtime-reconcile#v0.2.0
```

npm：

```bash
dsh plugin --profile web add dsh-runtime-reconcile
```

本地开发：

```bash
dsh plugin --profile web add file:/绝对路径/dsh-runtime-reconcile
```

也可以在 Harness 插件管理器 / Web GUI 里安装 bundle 目录。GitHub 源安装有时会要求允许构建脚本——**本包无构建脚本、无依赖**，没什么需要允许的。

然后**新开一个会话**，让新注册的工具进入模型的工具集。

---

## 用法

直接让 Agent 调，或显式调用：

```
reconcile_runtime {}
reconcile_runtime { "focus": "providers" }
reconcile_runtime { "focus": "all", "maxTools": 200 }
```

`focus` 只收窄输出，不跳过任何与安全性相关的检查；`maxTools` 限制列出的工具名数量（默认 40，上限 200），不限制检查本身。

### 输出示例

```
Runtime reconcile — 1 error(s), 1 warning(s), 4 info
focus=all  complete=true  generatedAt=2026-11-14T09:35:06.996Z

web.search: configured=modsearch registered=[deepseek-official, web-search-free]
web.fetch : configured=fs-quality-fetch registered=[fs-quality-fetch, http]
bundles: 3/4 enabled; disabled=[@liustack/modsearch]
loader rows: 200/202 active; 2 disabled; 0 enabled-but-not-active
tools: 5 visible

[ERROR] WEB_SEARCH_PROVIDER_MISSING — Configured search provider "modsearch" is not registered
  ctx.web.searchProvider 指向 "modsearch"，但活体 searchProviders 注册表里是
  [deepseek-official, web-search-free]。每次搜索调用都会在 provider 选择处失败。
  bundle "@liustack/modsearch" 已安装但被禁用——这很可能就是原因。
  evidence: {"configuredFrom":"web.searchProvider","configured":"modsearch",
             "registered":["deepseek-official","web-search-free"],
             "disabledBundle":"@liustack/modsearch"}
  remedy: 启用 bundle "@liustack/modsearch"（或把 web.searchProvider 改成
          deepseek-official / web-search-free 之一）。
[WARNING] BUNDLE_DISABLED — Bundle "@liustack/modsearch" 已安装但被禁用
  这个被禁用的 bundle 很可能是上面 provider 错误的原因。
  evidence: {"bundle":"@liustack/modsearch","linkedToProviderError":true}
[INFO] WEB_FETCH_PROVIDER_OK — fetch provider "fs-quality-fetch" 已配置且存活
[INFO] ROWS_DISABLED — 202 行里有 2 行禁用
[INFO] TOOL_REGISTRY_OK — 全局作用域可见 5 个工具
[INFO] SERVICES_OK — 7 个核心服务均存活
```

错误 + bundle 这两条就是完整诊断，`remedy` 那行就是下一步动作。工具**故意不**去改你的 `cordis.patch.yml`。

---

## 设计约束（为什么长这样）

- **零运行时导入。** 不 import 任何 `@deepseek-ai/*` 模块。profile 用 hoisted pnpm 布局：第三方 bundle 引入运行时包可能把第二份副本提升到 profile 顶层、遮蔽宿主的副本。`Symbol` 身份是 per-module-instance 的，宿主随后读到 `undefined`，整个 profile 的每次工具调用都会失败——见[讨论 #1697](https://github.com/deepseek-ai/deepseek-harness/discussions/1697)。全部改用 `ctx.get()` / `ctx.inject()`。
- **row 层不写 `inject`。** 声明式注入一旦不可用会让整行不激活——插件会在最该说话的时候失声。插件始终挂载，只在 `tools` seam 存在时注册工具。
- **命名空间化的 row id / 工具名。** `dsh-runtime-reconcile` / `reconcile_runtime` 避开 #4253 测到的 452 起 entry id 撞车与 553 起工具名撞车。
- **Host-only，无 Client 半。** 报告在会话里渲染，无需 slot 注册、主题 token，也无需重建 Web 产物。
- **纯对象 `ToolDefinition`。** 不用 `defineTool()`，用 `ctx.tools.register()` 配普通 JSON Schema。
- **`core.js` 是纯逻辑。** 所有检查逻辑不依赖运行时，`collect()` 接受一个 context-like 对象，因此可用 mock 做单元测试。

---

## 兼容性

| | |
|---|---|
| DeepSeek Harness | `>=0.2.1-rc.2 <0.4.0-0`（通过 `engines.dsh` 声明） |
| 实测环境 | 0.2.2-rc.1 / 0.2.2-rc.2（Web profile，Windows） |
| Node | 发布代码不直接用 Node API |
| Profile | web / desktop / 任何挂载了 `tools` seam 的 profile |
| 依赖 | **无** |
| 构建脚本 | **无** |
| 网络请求 | **无** |
| 写操作 | **无** |

若 `tools` seam 缺失，插件仍会挂载，`services` 检查会把它报出来，只是工具不会注册。

---

## 开发

```
npm test          # 14 项纯 core 检查，不需要 Harness 运行时
```

（本机 node 不在 PATH 时，先把 node 所在目录加进 PATH——这是本机环境事实，不是项目要求。）

`core.js` 承载全部检查逻辑、零依赖；`index.js` 只负责接线。这样诊断逻辑不用启动 profile 就能测试。

---

## 隐私与信任

工具只读取 Harness 进程里本就存在的服务对象。不读你的文件、不翻个人浏览器 profile、不读凭据、不联系任何主机、不往外发任何东西。全部输出就是一份渲染进当前会话的 JSON 报告。唯一会查的环境变量是 `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER`（一个 provider id，不是密钥），因为 web seam 本身认这两个覆盖。

---

## 局限

- **只诊断，不修复。** 改配置或启用 bundle 是用户决定。
- 检查是尽力而为、防御式的：内部服务结构变了会降级成 warning 而不是崩溃。若未来 DSH 改名 `searchProviders`，provider 检查会报「seam 不可用」而不是瞎猜。
- **故意不检测重复的可见工具名**：`tools.definitions()` 是已解析的可见集合（按名字索引的 Map），重复不可能出现；scope 遮蔽由注册表自己解决。硬说能检测，就是一个永远不会触发的检查。
- 禁用 bundle 的关联是启发式字符串匹配（包名 ↔ provider id），是强提示，不是所有权证明。
- finding 描述的是调用时刻的状态。启用/禁用 bundle 或改配置后请重跑。

---

## 仓库

源码：[github.com/shuai0503/dsh-runtime-reconcile](https://github.com/shuai0503/dsh-runtime-reconcile)，欢迎 issue 与 PR。`v0.2.0` tag 让上面的 GitHub 安装命令可解析。本包同时也发布在 npm 上，所以 `dsh plugin --profile web add dsh-runtime-reconcile` 无需任何构建步骤即可使用。0.1.0 → 0.2.0 的变化见 [CHANGELOG.md](CHANGELOG.md)。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。

独立社区插件，与 DeepSeek 无隶属、无背书、非官方发布。
