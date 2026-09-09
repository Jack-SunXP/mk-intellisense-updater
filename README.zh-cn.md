# C/C++ .mk IntelliSense 更新器

根据构建配置文件更新 VS Code C/C++ IntelliSense 的 include 路径。

本扩展会读取所选构建文件（`.mk` 文件）中的 include 配置，并更新你的 IntelliSense 配置。

## 功能

- 从所选构建文件（`.mk` 文件）读取 include 相关配置。
- 自动识别 include 路径变量：不依赖固定变量名，凡是取值为"一组真实存在的目录"
  的 make 变量都会被采用，并在结果提示中回报实际使用的变量名。
- 自动探测每个 `.mk` 文件的构建根目录，按相对条目真实存在的最近祖先目录解析。
- 支持 `=` / `:=` / `?=` / `+=` / `!=` 赋值、反斜杠续行、`$(VAR)` 递归展开，
  以及 `-I` / `-D` / `-L` / `-l` 编译选项。
- 识别链接库（`.a` 与 `.lib`），并可选合并其库构建文件中的 include 配置。
- 去重 include 路径并保持原顺序；只写入磁盘上确实存在的目录。
- 更新已有 IntelliSense 配置，或创建新配置。

## 命令

- `从此 .mk 文件更新 IntelliSense`
  - 在资源管理器中右键 `.mk` 文件可见。
  - Command ID: `mkintellisense.updateIntelliSense`
- `更新 IntelliSense：选择一个 .mk 文件...`
  - 手动选择构建文件（`.mk` 文件）。
  - Command ID: `mkintellisense.updateIntelliSensePick`

## 使用流程

1. 在资源管理器中右键某个项目 `.mk` 文件。
2. 选择 `从此 .mk 文件更新 IntelliSense`。
3. （可选）勾选需要解析的链接库（`.a` / `.lib`），默认全选。
4. （可选）确认要合并其 include 路径的库 `.mk` 文件（显示匹配分数）。
5. 选择要更新的 IntelliSense 配置，或新建一个。
6. 扩展写入更新后的 IntelliSense 设置，并报告条目来源变量、构建根与跳过数量。

## 输入要求

- 所选构建文件（`.mk` 文件）应包含 include 相关配置项。
- 若引用了库产物（例如 `xxx.a`、`xxx.lib`），可合并其对应库构建配置。
- 文档示例均为占位名（例如 `module_xxx.mk`、`lib_xxx.a`）。

## 注意

- 若工作区缺少 `.vscode/c_cpp_properties.json`，扩展会自动创建。
- 若未找到必需的 include 配置，扩展会提示错误。
- include 路径在写入前会校验目录是否真实存在；不存在的条目会被跳过，
  并在提示中报告"其中 N/M 条路径在本工作区不存在，已跳过"。

## 设置项

- `mkintellisense.libraryMkSearchGlobs`
  - 控制候选库 `.mk` 文件的搜索范围（可配置多条路径）。
  - 默认：`["**/*.mk"]`
  - 示例：`["libs/**/*.mk", "apps/**/*.mk"]`
- `mkintellisense.lowConfidenceThreshold`
  - 低于该分数的匹配视为低可信度。
  - 默认：`0.7`
- `mkintellisense.lowConfidenceMode`
  - 控制低可信度匹配的处理方式。
  - `discard`（默认）：直接丢弃低可信度匹配。
  - `include_with_warning`：保留并标记 LOW，同时给出提醒。
- `mkintellisense.directoryRatioThreshold`
  - 当一个 make 变量的取值中至少有该比例的条目能解析为真实存在的目录时，
    它被视为 include 路径来源。调高可避免误取仅仅是路径样式的变量。
  - 默认：`0.9`（范围 `0.5`–`1`）
- `mkintellisense.minTokensPerVariable`
  - make 变量至少包含多少个条目，才会被当作 include 路径来源来考虑。
  - 默认：`2`（范围 `1`–`10`）
- `mkintellisense.includeVariableSelection`
  - 选择哪些符合条件的变量作为 include 路径来源。头文件目录通常以
    inc/include/hdr/header 命名；源码目录与链接目录并非头文件根目录，
    把它们加入会让 C/C++ 解析器索引整棵目录树。
  - `inc-only`（默认）：仅使用名称含 inc/include/hdr/header 的变量。
  - `prefer`：优先使用 inc 命名的变量，若没有则回退到全部符合条件的变量。
  - `all`：使用所有条目能解析为真实目录的变量。

以上设置支持工作区级配置，不同项目可使用不同搜索路径。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

见 [LICENSE.md](LICENSE.md)。
