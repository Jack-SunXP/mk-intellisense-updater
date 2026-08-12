// @ts-check
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const isZhCn = vscode.env.language.toLowerCase().startsWith("zh-cn");

/** @param {string} en @param {string} zh */
function t(en, zh) {
    return isZhCn ? zh : en;
}

/** @param {string} mkContent @returns {string[]} */
function parseIncPaths(mkContent) {
    const m = mkContent.match(/MY_INC_PATHS\s*=\s*\\\n([\s\S]*?)(?=\n\s*\n|\nMY_|$)/);
    if (!m) return [];
    return m[1].split("\n")
        .map(l => l.trim().replace(/\\$/, "").trim())
        .filter(Boolean);
}

/** @param {string} mkContent @returns {string[]} unique .a basenames from entire mk content */
function parseLinkedLibs(mkContent) {
    const names = [];
    const seen = new Set();

    for (const rawLine of mkContent.split("\n")) {
        const line = rawLine.replace(/#.*/, "").replace(/\\$/, "").trim();
        if (!line) continue;

        const re = /([^\s"']+\.a)(?=\s|$)/g;
        let m;
        while ((m = re.exec(line)) !== null) {
            const base = path.basename(m[1], ".a");
            if (base && !seen.has(base)) {
                seen.add(base);
                names.push(base);
            }
        }
    }

    return names;
}

/** Normalize name into comparable tokens, stripping t-prefix before digits (e.g. t908d→908d) */
function normalizeTokens(name) {
    return name.toLowerCase()
        .split(/[_\-\.]+/)
        .filter(Boolean)
        .map(t => t.replace(/^t(\d)/, "$1"));
}

/** Score how well a prj directory name matches a .a lib basename (0–1) */
function matchScore(libBaseName, prjDirName) {
    const libSet = new Set(normalizeTokens(libBaseName));
    const prjToks = normalizeTokens(prjDirName);
    if (prjToks.length === 0) return 0;
    return prjToks.filter(t => libSet.has(t)).length / prjToks.length;
}

/** @returns {{ searchGlobs: string[], lowConfidenceThreshold: number, lowConfidenceMode: "include_with_warning"|"discard" }} */
function getMatchingSettings() {
    const cfg = vscode.workspace.getConfiguration("mkintellisense");
    const searchGlobsRaw = cfg.get("libraryMkSearchGlobs", ["**/*.mk"]);
    const thresholdRaw = cfg.get("lowConfidenceThreshold", 0.7);
    const lowConfidenceModeRaw = cfg.get("lowConfidenceMode", "include_with_warning");

    /** @type {string[]} */
    let searchGlobs = [];
    if (Array.isArray(searchGlobsRaw)) {
        searchGlobs = searchGlobsRaw
            .filter(v => typeof v === "string")
            .map(v => v.trim())
            .filter(Boolean);
    }
    if (searchGlobs.length === 0) searchGlobs = ["**/*.mk"];

    const n = Number(thresholdRaw);
    const lowConfidenceThreshold = Number.isFinite(n)
        ? Math.min(1, Math.max(0, n))
        : 0.7;

    const lowConfidenceMode = lowConfidenceModeRaw === "discard"
        ? "discard"
        : "include_with_warning";

    return { searchGlobs, lowConfidenceThreshold, lowConfidenceMode };
}

/** Find .mk files that best match each .a lib name */
async function findMatchingLibMkFiles(libBaseNames, searchGlobs, lowConfidenceThreshold, lowConfidenceMode) {
    const uriMap = new Map();
    for (const glob of searchGlobs) {
        const uris = await vscode.workspace.findFiles(glob, null, 1000);
        for (const uri of uris) uriMap.set(uri.fsPath, uri);
    }

    const allMkUris = [...uriMap.values()];
    const results = [];
    for (const libName of libBaseNames) {
        let bestUri = null, bestScore = 0;
        for (const uri of allMkUris) {
            const score = matchScore(libName, path.basename(path.dirname(uri.fsPath)));
            if (score > bestScore) { bestScore = score; bestUri = uri; }
        }
        if (bestUri && bestScore > 0) {
            const lowConfidence = bestScore < lowConfidenceThreshold;
            if (lowConfidence && lowConfidenceMode === "discard") continue;

            results.push({
                libName,
                uri: bestUri,
                score: bestScore,
                lowConfidence
            });
        }
    }
    return results;
}

/** @param {string} name @param {string[]} incPaths @returns {object} */
function buildConfig(name, incPaths) {
    // Deduplicate while preserving order
    const seen = new Set();
    const unique = incPaths.filter(p => seen.has(p) ? false : (seen.add(p), true));
    return {
        name,
        includePath: unique.map(p => "${workspaceFolder}/" + p),
        defines: ["_DEBUG", "UNICODE", "_UNICODE"],
        cStandard: "c17",
        cppStandard: "c++17",
        intelliSenseMode: "windows-gcc-x64"
    };
}

/** @param {vscode.Uri} mkUri */
async function updateFromMkFile(mkUri) {
    const raw = fs.readFileSync(mkUri.fsPath, "utf-8");
    const mkContent = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let incPaths = parseIncPaths(mkContent);
    if (incPaths.length === 0) {
        const preview = JSON.stringify(mkContent.slice(
            Math.max(0, mkContent.indexOf("MY_INC_PATHS") - 5), 60));
        vscode.window.showErrorMessage(
            t(
                `MY_INC_PATHS not found in ${path.basename(mkUri.fsPath)}. hasCRLF=${raw.includes("\r\n")} near:${preview}`,
                `在 ${path.basename(mkUri.fsPath)} 中未找到 MY_INC_PATHS。hasCRLF=${raw.includes("\r\n")} near:${preview}`
            )
        );
        return;
    }

    // --- Discover linked library .mk files from .a references in current mk ---
    const detectedLibBaseNames = parseLinkedLibs(mkContent);
    if (detectedLibBaseNames.length > 0) {
        const libPickItems = detectedLibBaseNames.map(name => ({ label: `${name}.a`, name, picked: true }));
        const selectedLibs = await vscode.window.showQuickPick(libPickItems, {
            canPickMany: true,
            title: t(
                "Select .a entries to participate in library mk matching",
                "选择参与库 .mk 匹配的 .a 条目"
            ),
            placeHolder: t(
                "Space to toggle, Enter to confirm (pre-selected = all detected)",
                "空格切换，回车确认（默认全选已识别项）"
            )
        });
        if (selectedLibs === undefined) return; // cancelled

        const libBaseNames = selectedLibs.map(i => i.name);
        const { searchGlobs, lowConfidenceThreshold, lowConfidenceMode } = getMatchingSettings();
        const matches = await findMatchingLibMkFiles(libBaseNames, searchGlobs, lowConfidenceThreshold, lowConfidenceMode);
        if (matches.length > 0) {
            const items = matches.map(m => ({
                label: path.basename(m.uri.fsPath),
                description: t(
                    `matched from ${m.libName}.a (score ${m.score.toFixed(2)}${m.lowConfidence ? ", LOW" : ""})`,
                    `来源 ${m.libName}.a（分数 ${m.score.toFixed(2)}${m.lowConfidence ? "，低可信" : ""}）`
                ),
                detail: path.relative(
                    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", m.uri.fsPath),
                uri: m.uri,
                picked: true   // pre-checked by default
            }));

            const lowCount = matches.filter(m => m.lowConfidence).length;
            if (lowCount > 0 && lowConfidenceMode === "include_with_warning") {
                vscode.window.showWarningMessage(
                    t(
                        `${lowCount} low-confidence library match(es) found (< ${lowConfidenceThreshold.toFixed(2)}). Please confirm selections carefully.`,
                        `发现 ${lowCount} 个低可信库匹配（< ${lowConfidenceThreshold.toFixed(2)}），请仔细确认选择。`
                    )
                );
            }

            const selected = await vscode.window.showQuickPick(items, {
                canPickMany: true,
                title: t(
                    "Merge include paths from linked libraries?",
                    "是否合并关联库的 include 路径？"
                ),
                placeHolder: t("Space to toggle, Enter to confirm", "空格切换，回车确认")
            });
            if (selected === undefined) return; // cancelled
            for (const item of selected) {
                const libContent = fs.readFileSync(item.uri.fsPath, "utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                incPaths = incPaths.concat(parseIncPaths(libContent));
            }
        } else if (selectedLibs.length > 0 && lowConfidenceMode === "discard") {
            vscode.window.showInformationMessage(t(
                "No candidates remain after discarding low-confidence matches.",
                "按低可信度丢弃后，没有可用候选项。"
            ));
        }
    }

    // --- Locate c_cpp_properties.json ---
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(mkUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage(t("No workspace folder open.", "未打开任何工作区文件夹。"));
        return;
    }
    const vscodeDir = path.join(workspaceFolder.uri.fsPath, ".vscode");
    const jsonPath = path.join(vscodeDir, "c_cpp_properties.json");
    /** @returns {{configurations: any[], version: number}} */
    const createInitialCppProps = () => ({
        configurations: [],
        version: 4
    });

    try {
        if (!fs.existsSync(jsonPath)) {
            fs.mkdirSync(vscodeDir, { recursive: true });
            fs.writeFileSync(jsonPath, JSON.stringify(createInitialCppProps(), null, 4) + "\n", "utf-8");
            vscode.window.showInformationMessage(t(
                "c_cpp_properties.json was not found and has been created automatically.",
                "未找到 c_cpp_properties.json，已自动创建。"
            ));
        }
    } catch (e) {
        vscode.window.showErrorMessage(t(
            "Failed to create c_cpp_properties.json: " + e.message,
            "创建 c_cpp_properties.json 失败：" + e.message
        ));
        return;
    }

    let data;
    try {
        data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } catch (e) {
        try {
            data = createInitialCppProps();
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 4) + "\n", "utf-8");
            vscode.window.showWarningMessage(t(
                "c_cpp_properties.json was invalid and has been reset automatically.",
                "c_cpp_properties.json 格式无效，已自动重置。"
            ));
        } catch (resetErr) {
            vscode.window.showErrorMessage(t(
                "Failed to parse/reset c_cpp_properties.json: " + resetErr.message,
                "解析或重置 c_cpp_properties.json 失败：" + resetErr.message
            ));
            return;
        }
    }
    if (!Array.isArray(data.configurations)) data.configurations = [];

    // --- Choose target config name ---
    const defaultName = path.basename(path.dirname(mkUri.fsPath));
    const existingNames = data.configurations.map(c => c.name).filter(n => n !== "Win32");
    const NEW_ITEM = `+ Create new: "${defaultName}"`;
    const picked = await vscode.window.showQuickPick([NEW_ITEM, ...existingNames], {
        title: t(
            `Apply include paths from ${path.basename(mkUri.fsPath)}`,
            `应用来自 ${path.basename(mkUri.fsPath)} 的 include 路径`
        ),
        placeHolder: t(
            "Select which IntelliSense configuration to update",
            "选择要更新的 IntelliSense 配置"
        )
    });
    if (!picked) return;

    const targetName = picked === NEW_ITEM ? defaultName : picked;
    const newCfg = buildConfig(targetName, incPaths);
    const idx = data.configurations.findIndex(c => c.name === targetName);
    const action = idx >= 0 ? (data.configurations[idx] = newCfg, "Updated") : (data.configurations.push(newCfg), "Added");

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 4) + "\n", "utf-8");
    vscode.window.showInformationMessage(
        t(
            `${action} IntelliSense config "${targetName}" (${newCfg.includePath.length} include paths).`,
            `${action === "Updated" ? "已更新" : "已新增"} IntelliSense 配置 "${targetName}"（${newCfg.includePath.length} 条 include 路径）。`
        )
    );
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand("mkintellisense.updateIntelliSense", (uri) => {
            if (uri instanceof vscode.Uri) updateFromMkFile(uri);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("mkintellisense.updateIntelliSensePick", async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { "Makefile": ["mk"] },
                openLabel: t("Select a .mk file", "选择 .mk 文件"),
                title: t("Select a .mk file", "选择 .mk 文件")
            });
            if (uris?.length) await updateFromMkFile(uris[0]);
        })
    );
}

function deactivate() {}
module.exports = { activate, deactivate };
