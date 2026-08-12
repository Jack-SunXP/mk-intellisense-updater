# C/C++ .mk IntelliSense 更新器

根据构建配置文件更新 VS Code C/C++ IntelliSense 的 include 路径。

本扩展会读取所选构建文件（`.mk` 文件）中的 include 配置，并更新你的 IntelliSense 配置。

## 功能

- 从所选构建文件（`.mk` 文件）读取 include 相关配置。
- 识别并可选合并关联库构建文件中的 include 配置（例如与 `.a` 相关的条目）。
- 去重 include 路径并保持原顺序。
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
3. （可选）确认需要参与合并的关联库文件。
4. 选择要更新的 IntelliSense 配置，或新建一个。
5. 扩展写入更新后的 IntelliSense 设置。

## 输入要求

- 所选构建文件（`.mk` 文件）应包含 include 相关配置项。
- 若引用了库产物（例如 `xxx.a`），可合并其对应库构建配置。
- 文档示例均为占位名（例如 `module_xxx.mk`、`lib_xxx.a`）。

## 注意

- 若工作区缺少 `.vscode/c_cpp_properties.json`，扩展会自动创建。
- 若未找到必需的 include 配置，扩展会提示错误。

## 设置项

- `mkintellisense.libraryMkSearchGlobs`
  - 控制候选库 `.mk` 文件的搜索范围（可配置多条路径）。
  - 默认：`[
    "**/*.mk"
  ]`
  - 示例：`[
    "libs/**/*.mk",
    "apps/**/*.mk"
  ]`
- `mkintellisense.lowConfidenceThreshold`
  - 低于该分数的匹配视为低可信度。
  - 默认：`0.7`
- `mkintellisense.lowConfidenceMode`
  - 控制低可信度匹配的处理方式。
  - `include_with_warning`（默认）：保留并标记 LOW，同时给出提醒。
  - `discard`：直接丢弃低可信度匹配。

以上设置支持工作区级配置，不同项目可使用不同搜索路径。

## 许可证

见 [LICENSE.md](LICENSE.md)。
