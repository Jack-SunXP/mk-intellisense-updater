# Changelog

All notable changes to this extension are documented here.
本扩展的所有重要变更记录于此。

The format follows [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.0]

### Added

- **Generic make-variable parsing.** Include paths are no longer read from one
  hard-coded variable name. Any make variable whose value is a list of
  directories that actually exist on disk qualifies, and the variable names
  actually used are reported back in the result message.
  **通用 make 变量解析。** include 路径不再来自某个写死的变量名，任何取值
  为"一组真实存在的目录"的 make 变量都会被识别，并在结果提示中回报实际使用的变量名。
- **Per-file build-root detection.** Relative entries inside a makefile are
  resolved against the nearest ancestor directory that makes them exist, so a
  library makefile and an application makefile in the same workspace no longer
  need the same base. Unresolvable entries are counted and reported as
  `N/M path entries ... were skipped` instead of being written out as broken
  paths.
  **逐文件构建根探测。** mk 文件中的相对条目按"能使其真实存在的最近祖先目录"
  解析，因此同一工作区里的库 mk 与应用 mk 不再需要共用同一个基准目录；无法解析的条目
  会被统计并在提示中报告 `其中 N/M 条路径…已跳过`，而不再写成无效路径。
- **`.lib` support.** Library discovery matched `*.a` only; `*.lib` archives are
  now collected and resolved identically.
  **支持 `.lib`。** 库发现原先只匹配 `*.a`，现在同样收集并解析 `*.lib`。
- **Three-tier library resolution.** For each archive the extension now tries,
  in order: (1) the source project whose makefile/directory is named after the
  library and whose own paths resolve; (2) a prebuilt archive present in the
  workspace with no usable source makefile; (3) scored fuzzy name matching that
  keeps every tied candidate. Each outcome is reported with its own message
  (`source` / `prebuilt` / `source-no-paths` / `not-found` / low-confidence).
  **三级库解析。** 依次尝试：(1) 以库名命名且自身路径可解析的源码工程；
  (2) 工作区中只有预编译产物、没有可用源码 mk；(3) 带分数的模糊匹配，并保留所有
  同分候选。每种结果都有独立提示。
- **Compiler flag parsing.** `-I<dir>` is merged into the include paths,
  `-D<macro>` into `defines`, `-l<name>` into the linked-archive list, and
  `-L<dir>` is recognised as a library search path (it is deliberately *not*
  treated as an include path).
  **编译选项解析。** `-I<dir>` 并入 include 路径，`-D<宏>` 并入 defines，
  `-l<名>` 并入链接库列表，`-L<目录>` 识别为库搜索路径（有意**不**当作 include 路径）。
- **New settings.** / **新增设置项。**
  - `mkintellisense.directoryRatioThreshold` (default `0.9`, range `0.5`–`1`) —
    the fraction of a variable's entries that must resolve to existing
    directories before the variable counts as an include-path source.
    当一个 make 变量的取值中至少有该比例的条目能解析为真实存在的目录时，它被视为
    include 路径来源。默认 `0.9`（范围 `0.5`–`1`）。
  - `mkintellisense.minTokensPerVariable` (default `2`, range `1`–`10`) — the
    minimum number of entries a variable must have to be considered.
    make 变量至少包含多少个条目，才会被当作 include 路径来源来考虑。
    默认 `2`（范围 `1`–`10`）。
  - `mkintellisense.includeVariableSelection` (default `"inc-only"`) — which
    qualifying variables are used: `inc-only` (only names containing
    inc/include/hdr/header), `prefer` (inc-named first, others as fallback),
    or `all` (every qualifying variable).
    选择哪些符合条件的变量作为 include 路径来源：`inc-only`（仅名称含
    inc/include/hdr/header 的变量，默认）、`prefer`（优先 inc 命名，没有时
    回退到全部）、`all`（所有条目能解析为真实目录的变量）。
- **Self-contained core module** `src/mkcore.js` holding all parsing and
  matching logic, independent of the VS Code API.
  **独立核心模块** `src/mkcore.js`：全部解析与匹配逻辑与 VS Code API 解耦。

### Changed

- **Makefile parsing rewritten.** Supports `=`, `:=`, `?=`, `+=` and `!=`
  assignments, backslash line continuations, tab-indented recipe lines, `#`
  comments outside `$( )` references, and recursive `$(VAR)` expansion with a
  cycle guard. The previous implementation recognised only a single
  `NAME = \` block terminated by a blank line.
  **mk 解析重写。** 支持 `=`/`:=`/`?=`/`+=`/`!=`、反斜杠续行、Tab 开头的 recipe 行、
  `$( )` 引用之外的 `#` 注释，以及带循环保护的 `$(VAR)` 递归展开；旧实现只认
  "以 `NAME = \` 开头、以空行结束"的单一块。
- **Include paths are existence-checked before writing.** Every directory is
  verified on disk and emitted as `${workspaceFolder}/…`; paths outside the
  workspace folder fall back to an absolute path. Previously every token was
  written unconditionally as `${workspaceFolder}/<token>`.
  **写入前校验存在性。** 每条目录都先在磁盘上确认存在，再输出为
  `${workspaceFolder}/…`，工作区之外的条目回退为绝对路径；旧实现无条件拼接。
- **Archive identity normalised.** `libfoo.a`, `libfoo` and `foo` are treated as
  the same component; a makefile's own build target (a variable whose entire
  value is a single bare archive name) is excluded from the dependency list; and
  the same archive reached from two directories is counted once.
  **库名归一。** `libfoo.a`/`libfoo`/`foo` 视为同一组件；mk 自身的构建目标
  （整个取值只是一个不带目录的归档名）不再被当成依赖；同一归档出现在两个目录时只计一次。
- **Path comparison is case- and separator-insensitive on Windows**, so `\` and
  `/` spellings of one directory share a single cache entry.
  **Windows 下路径比较忽略大小写与分隔符差异**，同一目录的 `\` 与 `/` 写法共用一个缓存项。
- `mkintellisense.lowConfidenceMode` default changed from
  `include_with_warning` to `discard` (committed before this release).
  `lowConfidenceMode` 的默认值由 `include_with_warning` 改为 `discard`。
- Type annotations (`@ts-check` JSDoc) completed across `extension.js` and
  `src/mkcore.js`; no implicit-`any` parameters remain.
  补全 `extension.js` 与 `src/mkcore.js` 的 `@ts-check` JSDoc 类型标注，已无隐式 `any` 参数。

### Fixed

- **Generated include paths did not resolve.** 0.1.0 wrote every entry as
  `${workspaceFolder}/<token>`, but the entries in a makefile are relative to
  *that makefile's* build root, so almost none of them pointed at a real
  directory. Measured on a 726-makefile workspace: 34104 tokens produced 0
  resolvable paths under 0.1.0, versus 95.7% under 0.2.0.
  **生成的 include 路径无法解析。** 0.1.0 把每条条目都拼成
  `${workspaceFolder}/<token>`，而 mk 中的条目是相对该 mk 的构建根的，因此几乎全部指向
  不存在的目录。在 726 个 mk 的工作区实测：0.1.0 的 34104 条 token 中可解析 0 条，
  0.2.0 为 95.7%。
- **`+=` and `:=` include variables were ignored.** 0.1.0 matched only a block
  that starts with `NAME = \` and ends at a blank line, so variables built up with
  `+=`, or assigned with `:=`, produced nothing.
  **`+=` 与 `:=` 赋值的 include 变量被完全忽略。** 0.1.0 只匹配"以 `NAME = \` 开头、
  以空行结束"的块。
- **A makefile's own build output was treated as a dependency.** The archive the
  makefile produces (a target variable, e.g. `$(OBJ)/libfoo.a`) was collected as a
  linked library, so the tool tried to resolve a library from the very makefile
  being analysed.
  **mk 自身的构建产物被当成依赖库。** 该 mk 产出的归档会被收集为链接库，导致工具去
  解析"正在分析的这个 mk 自己"。
- **Only one library candidate survived.** 0.1.0 kept just the single
  highest-scoring makefile per library, silently dropping equally good candidates
  (for example a second makefile that builds a variant of the same library). All
  tied candidates are now offered.
  **每个库只保留一个候选。** 0.1.0 只取分数最高的单个 mk，同分候选（例如构建同一库
  另一个变体的 mk）被静默丢弃；现在会一并列出。
- **`defines` were unrelated to the makefile.** 0.1.0 always wrote
  `_DEBUG`, `UNICODE`, `_UNICODE`. They now come from the `-D` flags found in the
  makefile(s), with `_DEBUG` only as a fallback when nothing was declared.
  **`defines` 与 mk 内容无关。** 0.1.0 固定写入 `_DEBUG`/`UNICODE`/`_UNICODE`；
  现在取自 mk 中的 `-D`，仅在没有任何声明时回退为 `_DEBUG`。
- **Failure messages leaked raw file content.** The "no include variable found"
  error embedded a 60-character excerpt of the makefile plus a `hasCRLF=` marker
  in the popup. The message is now a plain explanation.
  **失败提示泄漏文件原文。** 旧错误提示把 mk 的 60 字符片段与 `hasCRLF=` 一起弹了出来，
  现在只保留正常说明。
- Non-`Error` throwables from file access are reported safely instead of
  dereferencing `.message` on an unknown value.
  文件访问抛出非 `Error` 对象时也能安全报告，不再直接取 `.message`。
- **Selecting one library variant no longer pulls in the others.** When several
  projects are variants of the same component (they differ only in a code such
  as a device or configuration suffix), the source-project stage compared name
  tokens exactly, so a marker letter in front of a code made the intended
  project invisible; resolution then fell through to fuzzy matching, where the
  shared tokens outweighed the one distinguishing token and every variant tied
  as the best match. Token comparison now tolerates a one- or two-letter marker
  in front of a code (a word such as a configuration name is still compared
  literally), matching is weighted by how rare each token is across the
  candidates, and the name of the requesting makefile and its directory
  disambiguate the remaining ties.
  **选择一个库变体时不再连带引入其他变体。** 当同一组件存在多个变体工程（仅设备
  或配置后缀不同）时，源码工程阶段按严格相等比较名称 token，代号前的一个标记字母
  就会让目标工程匹配不上；随后进入模糊匹配，共享 token 的权重压过唯一有区分度的
  token，于是所有变体同分并列最优。现在 token 比较允许代号前的一到两个标记字母
  （纯字母的配置名仍按字面比较），匹配分数按 token 在候选中的稀有度加权，并用发起
  请求的 mk 文件名及其所在目录名来消除剩余的同分。
- **A library with only a prebuilt archive is no longer fuzzy-matched to an
  unrelated project.** The archive check ran after the source stage had already
  given up, so such a library could be resolved to a project it does not belong
  to. The stages now run in the documented order.
  **只有预编译产物的库不再被模糊匹配到无关工程。** 此前归档检查发生在源码阶段
  放弃之后，这类库可能被解析到并不属于它的工程；现在三个阶段按文档顺序执行。
- **Resolution is markedly faster.** The archive sweep is skipped entirely when
  every library has a usable source makefile, the sweeps run concurrently,
  candidate makefiles are analysed only within the tier the requesting file
  points at, and path existence checks test each directory prefix once instead
  of every entry. On a workspace with ~700 makefiles and 14 linked libraries this
  reduces the work from a few seconds per library to about one second for all of
  them.
  **解析速度显著提升。** 当所有库都有可用源码 mk 时完全跳过归档扫描，多路文件
  扫描并发执行，候选 mk 只在发起文件指向的那一档内分析，路径存在性检查按目录前缀
  去重。在约 700 个 mk、14 个链接库的工作区上，从"每个库数秒"降到"全部约一秒"。

### Notes on behaviour change

Because include paths are now validated against the file system, a makefile that
references a tree which is not checked out yields *fewer* entries than 0.1.0 did
— those entries were previously written out and simply did not resolve. The
result message reports how many entries were skipped.
由于 include 路径现在会经过磁盘校验，引用了未签出目录树的 mk 产生的条目数可能比
0.1.0 *更少*——那些条目此前也会被写入，只是无法解析。结果提示会报告被跳过的条目数。

After installing the `.vsix`, run `Developer: Reload Window`. Context-menu labels
are resolved when the window loads, so without a reload the menu can still appear
in English even when the VS Code display language is Chinese.
安装 `.vsix` 后请执行一次 `Developer: Reload Window`。右键菜单文字在窗口加载时解析，
未重新加载时即使 VS Code 显示语言为中文，菜单也可能仍显示英文。

---

## [0.1.0]

Initial release. / 首个版本。

- Read include settings from a selected `.mk` file and update
  `.vscode/c_cpp_properties.json` (created automatically when missing).
  从所选 `.mk` 文件读取 include 配置并更新 `.vscode/c_cpp_properties.json`
  （缺失时自动创建）。
- Detect related library build files through `.a` entries and optionally merge
  their include paths.
  通过 `.a` 条目识别关联库构建文件，并可选合并其 include 路径。
- De-duplicate include paths while preserving order; update an existing
  IntelliSense configuration or create a new one.
  去重 include 路径并保持原顺序；更新已有 IntelliSense 配置或新建一个。
- Explorer context-menu command `mkintellisense.updateIntelliSense` and
  palette command `mkintellisense.updateIntelliSensePick`.
  提供资源管理器右键命令 `mkintellisense.updateIntelliSense` 与命令面板命令
  `mkintellisense.updateIntelliSensePick`。
- Settings: `mkintellisense.libraryMkSearchGlobs`,
  `mkintellisense.lowConfidenceThreshold`, `mkintellisense.lowConfidenceMode`.
  设置项：`libraryMkSearchGlobs`、`lowConfidenceThreshold`、`lowConfidenceMode`。
- Bilingual UI (English / 简体中文) driven by `vscode.env.language`;
  manifest strings localised through `package.nls*.json`.
  界面文案（英文 / 简体中文）由 `vscode.env.language` 切换；清单文案通过
  `package.nls*.json` 本地化。

[0.2.0]: https://github.com/Jack-SunXP/mk-intellisense-updater/compare/0.1.0.d...HEAD
[0.1.0]: https://github.com/Jack-SunXP/mk-intellisense-updater/releases/tag/0.1.0.d
