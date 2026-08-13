# C/C++ .mk IntelliSense 更新器 / Updater

## 中文说明

根据构建配置文件更新 VS Code C/C++ IntelliSense 的 include 路径。

本扩展会读取所选构建文件（`.mk` 文件）中的 include 配置，并更新你的 IntelliSense 配置。

### 功能

- 从所选构建文件（`.mk` 文件）读取 include 相关配置。
- 识别并可选合并关联库构建文件中的 include 配置（例如与 `.a` 相关的条目）。
- 去重 include 路径并保持原顺序。
- 更新已有 IntelliSense 配置，或创建新配置。

### 命令

- `从此 .mk 文件更新 IntelliSense`
  - 在资源管理器中右键 `.mk` 文件可见。
  - Command ID: `mkintellisense.updateIntelliSense`
- `更新 IntelliSense：选择一个 .mk 文件...`
  - 手动选择构建文件（`.mk` 文件）。
  - Command ID: `mkintellisense.updateIntelliSensePick`

### 使用流程

1. 在资源管理器中右键某个项目 `.mk` 文件。
2. 选择 `从此 .mk 文件更新 IntelliSense`。
3. （可选）确认需要参与合并的关联库文件。
4. 选择要更新的 IntelliSense 配置，或新建一个。
5. 扩展写入更新后的 IntelliSense 设置。

### 输入要求

- 所选构建文件（`.mk` 文件）应包含 include 相关配置项。
- 若引用了库产物（例如 `xxx.a`），可合并其对应库构建配置。
- 文档示例均为占位名（例如 `module_xxx.mk`、`lib_xxx.a`）。

### 注意

- 若工作区缺少 `.vscode/c_cpp_properties.json`，扩展会自动创建。
- 若未找到必需的 include 配置，扩展会提示错误。

### 设置项

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

以上设置支持工作区级配置，不同项目可使用不同搜索路径。

---

## English

Update VS Code C/C++ IntelliSense include paths from build configuration files.

This extension reads include settings from a selected build file (`.mk` file) and updates your IntelliSense configuration.

### What It Does

- Reads include-related settings from the selected build file (`.mk` file).
- Detects and optionally merges include settings from related library build files (for example, entries related to `.a` libraries).
- Removes duplicate include paths while preserving order.
- Updates an existing IntelliSense configuration or creates a new one.

### Commands

- `Update IntelliSense from this .mk file`
  - Available in Explorer context menu when right-clicking a `.mk` file.
  - Command ID: `mkintellisense.updateIntelliSense`
- `Update IntelliSense: Pick a .mk file...`
  - Lets you choose a build file (`.mk` file) manually.
  - Command ID: `mkintellisense.updateIntelliSensePick`

### Workflow

1. Right-click a project `.mk` file in Explorer.
2. Select `Update IntelliSense from this .mk file`.
3. (Optional) Confirm related library files to merge.
4. Pick the IntelliSense configuration to update, or create a new one.
5. The extension writes the updated IntelliSense settings.

### Input Requirements

- The selected build file (`.mk` file) should contain include-related configuration entries.
- If related library artifacts (such as `xxx.a`) are referenced, corresponding library build settings can be merged during update.
- Documentation examples use placeholder names only (for example, `module_xxx.mk`, `lib_xxx.a`).

### Notes

- If `.vscode/c_cpp_properties.json` is missing, the extension creates it automatically.
- If required include settings are not found, the extension reports an error message.

### Settings

- `mkintellisense.libraryMkSearchGlobs`
  - Controls where candidate library `.mk` files are searched (multiple paths).
  - Default: `["**/*.mk"]`
  - Example: `["libs/**/*.mk", "apps/**/*.mk"]`
- `mkintellisense.lowConfidenceThreshold`
  - Match score below this value is treated as low confidence.
  - Default: `0.7`
- `mkintellisense.lowConfidenceMode`
  - Controls how low-confidence matches are handled.
  - `discard` (default): drop low-confidence matches directly.
  - `include_with_warning`: keep and mark LOW with warning.

These settings support workspace-level configuration, so different projects can use different search paths.

## License

See [LICENSE.md](LICENSE.md).
