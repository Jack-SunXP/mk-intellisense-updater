// @ts-check
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const mkcore = require("./src/mkcore");

const isZhCn = vscode.env.language.toLowerCase().startsWith("zh-cn");

/** @param {string} en @param {string} zh */
function t(en, zh) {
    return isZhCn ? zh : en;
}

/** @returns {mkcore.FsApi} cached view over the real file system */
function createDiskFs() {
    return mkcore.createFsCache({
        isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
        exists: (p) => fs.existsSync(p),
        readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }
    });
}

/**
 * Read a makefile and return its logical (continuation-joined) text.
 * @param {string} file
 * @param {mkcore.FsApi} fsApi
 */
function readMk(file, fsApi) {
    const raw = fsApi.readFile(file);
    return raw === null || raw === undefined ? "" : raw.replace(/\r\n?/g, "\n");
}

/**
 * Analyse makefiles with a per-invocation memo so the same file is parsed only
 * once even when it is both the target and a library candidate.
 * @param {string} wsRoot
 * @param {mkcore.FsApi} fsApi
 * @param {{threshold:number,minTokens:number,selection?:string}} opts
 */
function createAnalyzer(wsRoot, fsApi, opts) {
    /** @type {Map<string, ReturnType<typeof mkcore.analyzeMk>>} */
    const memo = new Map();
    return function analyze(/** @type {string} */ f) {
        const hit = memo.get(f);
        if (hit) return hit;
        const r = mkcore.analyzeMk(readMk(f, fsApi), f, wsRoot, fsApi, opts);
        memo.set(f, r);
        return r;
    };
}

/**
 * @returns {{ searchGlobs: string[], lowConfidenceThreshold: number,
 *   lowConfidenceMode: "include_with_warning"|"discard",
 *   dirRatioThreshold: number, minTokens: number, selection: string }}
 */
function getMatchingSettings() {
    const cfg = vscode.workspace.getConfiguration("mkintellisense");
    const searchGlobsRaw = cfg.get("libraryMkSearchGlobs", ["**/*.mk"]);
    const thresholdRaw = cfg.get("lowConfidenceThreshold", 0.7);
    const lowConfidenceModeRaw = cfg.get("lowConfidenceMode", "discard");
    const ratioRaw = cfg.get("directoryRatioThreshold", 0.9);
    const minTokensRaw = cfg.get("minTokensPerVariable", 2);
    const selectionRaw = cfg.get("includeVariableSelection", "inc-only");

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

    const r = Number(ratioRaw);
    const dirRatioThreshold = Number.isFinite(r) ? Math.min(1, Math.max(0.5, r)) : 0.9;

    const k = Number(minTokensRaw);
    const minTokens = Number.isFinite(k) ? Math.max(1, Math.min(10, Math.round(k))) : 2;

    const selection = ["inc-only", "all", "prefer"].includes(String(selectionRaw))
        ? String(selectionRaw)
        : "inc-only";

    return { searchGlobs, lowConfidenceThreshold, lowConfidenceMode, dirRatioThreshold, minTokens, selection };
}

/**
 * Build an index of candidate makefiles and resolve each library to the
 * makefile(s) that can supply its include paths.
 *
 * Resolution order per library (see mkcore.resolveLibrary):
 *   1. a makefile named after the library whose own paths resolve  -> source project
 *   2. the archive exists on disk but no usable source makefile    -> prebuilt only
 *   3. otherwise rarity-weighted fuzzy name matching, keeping every tied candidate
 *
 * Both directory sweeps are started together; the archive sweep is only awaited
 * for a library that has no usable source makefile, so the common case where
 * every archive is built from source in this workspace pays for one walk.
 *
 * @param {Array<{name:string,norm:string}>} libs
 * @param {{ searchGlobs: string[], lowConfidenceThreshold: number, lowConfidenceMode: string, dirRatioThreshold: number, minTokens: number, selection: string }} settings
 * @param {string} wsRoot
 * @param {mkcore.FsApi} fsApi
 * @param {(f:string)=>ReturnType<typeof mkcore.analyzeMk>} analyze
 * @param {string[]} [contextTokens] name tokens of the requesting makefile, used
 *   to pick between projects that are variants of the same component
 */
async function resolveLibraries(libs, settings, wsRoot, fsApi, analyze, contextTokens) {
    const sweep = (/** @type {string} */ glob) => vscode.workspace.findFiles(glob, null, 5000);

    const mkSweeps = await Promise.all(settings.searchGlobs.map(sweep));
    /** @type {Set<string>} */
    const mkFiles = new Set();
    for (const uris of mkSweeps) for (const uri of uris) mkFiles.add(uri.fsPath);

    const mkIndex = [...mkFiles].map((file) => ({
        file,
        dir: path.basename(path.dirname(file)),
        base: path.basename(file, path.extname(file))
    }));

    /** @type {Map<string, string[]>} archive basename (normalised) -> files */
    const archiveIndex = new Map();
    const archiveSweep = Promise.all([sweep("**/*.a"), sweep("**/*.lib")])
        .then((found) => {
            for (const uris of found) {
                for (const uri of uris) {
                    const key = mkcore.normName(path.basename(uri.fsPath));
                    const list = archiveIndex.get(key);
                    if (list) list.push(uri.fsPath);
                    else archiveIndex.set(key, [uri.fsPath]);
                }
            }
        })
        .catch(() => { /* an unreadable archive sweep only weakens stage 2 */ });

    const weight = mkcore.createTokenWeights(mkIndex);
    const ctxTokens = contextTokens && contextTokens.length ? contextTokens : null;
    const opts = { lowConfidenceThreshold: settings.lowConfidenceThreshold, weight, contextTokens: ctxTokens };
    /** @param {string} name */
    const findArchive = (name) => archiveIndex.get(mkcore.normName(name)) || [];

    /** @type {Array<ReturnType<typeof mkcore.resolveLibrary>|null>} */
    const out = new Array(libs.length).fill(null);
    /** @type {number[]} indexes into `libs` that still need the archive index */
    const pending = [];

    libs.forEach((lib, i) => {
        // Stage 1 only: a library whose source project is present never needs
        // the archive sweep, so it is resolved without waiting for it.
        const r = mkcore.resolveLibrarySourceStage(lib, mkIndex, analyze, { weight, contextTokens: ctxTokens });
        if (r) out[i] = r;
        else pending.push(i);
    });

    if (pending.length) {
        await archiveSweep;
        for (const i of pending) {
            out[i] = mkcore.resolveLibrary(libs[i], mkIndex, { analyze, findArchive }, opts);
        }
    }
    return /** @type {Array<ReturnType<typeof mkcore.resolveLibrary>>} */ (out);
}

/**
 * Turn resolved absolute include directories into `${workspaceFolder}/...`
 * tokens, falling back to `${default}`-free absolute paths when a directory
 * lives outside the workspace folder.
 * @param {string[]} absPaths
 * @param {string} wsRoot
 */
function toWorkspaceRelative(absPaths, wsRoot) {
    const out = [];
    for (const p of absPaths) {
        const rel = path.relative(wsRoot, p);
        const inside = rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        out.push(inside ? "${workspaceFolder}/" + rel.replace(/\\/g, "/") : p.replace(/\\/g, "/"));
    }
    return out;
}

/**
 * Shape of a single entry in `c_cpp_properties.json`.
 * @typedef {{
 *   name: string,
 *   includePath: string[],
 *   defines: string[],
 *   cStandard: string,
 *   cppStandard: string,
 *   intelliSenseMode: string
 * }} CppConfig
 */

/**
 * @param {string} name
 * @param {string[]} includePathTokens
 * @param {string[]} defines
 * @returns {CppConfig}
 */
function buildConfig(name, includePathTokens, defines) {
    // Deduplicate while preserving order
    const seen = new Set();
    const unique = includePathTokens.filter(p => seen.has(p) ? false : (seen.add(p), true));
    return {
        name,
        includePath: unique,
        defines: [...new Set(defines)],
        cStandard: "c17",
        cppStandard: "c++17",
        intelliSenseMode: "windows-gcc-x64"
    };
}

/** @param {vscode.Uri} mkUri */
async function updateFromMkFile(mkUri) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(mkUri)
        ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage(t("No workspace folder open.", "未打开任何工作区文件夹。"));
        return;
    }
    const wsRoot = workspaceFolder.uri.fsPath;
    const fsApi = createDiskFs();
    const settings = getMatchingSettings();
    const analyze = createAnalyzer(wsRoot, fsApi, {
        threshold: settings.dirRatioThreshold,
        minTokens: settings.minTokens,
        selection: settings.selection
    });

    const own = analyze(mkUri.fsPath);
    if (own.includePaths.length === 0) {
        vscode.window.showErrorMessage(
            t(
                `No include-path variable could be detected in ${path.basename(mkUri.fsPath)} (no make variable whose value is a list of existing directories).`,
                `在 ${path.basename(mkUri.fsPath)} 中未检测到 include 路径变量（没有任何 make 变量的取值是"一组真实存在的目录"）。`
            )
        );
        return;
    }

    /** @type {string[]} */
    let includeAbs = own.includePaths.slice();
    /** @type {string[]} */
    const defines = own.defines.slice();
    let totalTokens = own.total;
    let missingTokens = own.missing;

    // --- Discover linked libraries (.a / .lib) referenced by this makefile ---
    /** @type {Array<{token:string,name:string,base:string,norm:string}>} */
    const libs = mkcore.collectLinkedArchives(mkcore.parseMakeVars(readMk(mkUri.fsPath, fsApi)));
    if (libs.length > 0) {
        /** @type {Array<{label:string,name:string,picked:boolean}>} */
        const libPickItems = libs.map((l) => ({ label: l.name, name: l.name, picked: true }));
        const selectedLibs = await vscode.window.showQuickPick(libPickItems, {
            canPickMany: true,
            title: t(
                "Select library archives to resolve into include paths",
                "选择需要解析 include 路径的库（.a / .lib）"
            ),
            placeHolder: t(
                "Space to toggle, Enter to confirm (pre-selected = all detected)",
                "空格切换，回车确认（默认全选已识别项）"
            )
        });
        if (selectedLibs === undefined) return; // cancelled

        /** @param {{label:string,name:string,picked:boolean}} i */
        const pickName = (i) => i.name;
        const chosen = selectedLibs
            .map((/** @type {{label:string,name:string,picked:boolean}} */ i) => libs.find(l => l.name === pickName(i)))
            .filter((l) => l !== undefined);
        // The requesting makefile names the variant it builds, so its own file
        // and directory tokens disambiguate libraries that share a component name.
        const contextTokens = [
            ...mkcore.idTokens(path.basename(mkUri.fsPath, path.extname(mkUri.fsPath))),
            ...mkcore.idTokens(path.basename(path.dirname(mkUri.fsPath))),
        ];
        const resolved = await resolveLibraries(chosen, settings, wsRoot, fsApi, analyze, contextTokens);

        /** @type {Array<{lib:string,file:string,score:number,low:boolean}>} */
        const matches = [];
        const notes = [];
        for (const r of resolved) {
            if (r.kind === "prebuilt") {
                notes.push(t(
                    `${r.lib}: only a prebuilt archive in this workspace, no source makefile`,
                    `${r.lib}：本工作区只有预编译产物，没有源码 mk`
                ));
                continue;
            }
            if (r.kind === "source-no-paths") {
                notes.push(t(
                    `${r.lib}: source makefile found but its paths do not exist here`,
                    `${r.lib}：找到源码 mk，但其路径在本工作区不存在`
                ));
                continue;
            }
            if (r.kind === "not-found") {
                notes.push(t(`${r.lib}: no makefile found`, `${r.lib}：未找到对应 mk`));
                continue;
            }
            if (settings.lowConfidenceMode === "discard" && r.kind === "fuzzy-low") continue;
            for (const m of r.matches) matches.push({ lib: r.lib, ...m });
        }

        if (notes.length) {
            vscode.window.showInformationMessage(notes.slice(0, 6).join(" · ")
                + (notes.length > 6 ? t(` (+${notes.length - 6} more)`, ` 等 ${notes.length} 项`) : ""));
        }

        if (matches.length > 0) {
            const items = matches.map(m => ({
                label: path.basename(m.file),
                description: t(
                    `from ${m.lib} (score ${m.score.toFixed(2)}${m.low ? ", LOW" : ""})`,
                    `来源 ${m.lib}（分数 ${m.score.toFixed(2)}${m.low ? "，低可信" : ""}）`
                ),
                detail: path.relative(wsRoot, m.file),
                file: m.file,
                picked: true
            }));

            const lowCount = matches.filter(m => m.low).length;
            if (lowCount > 0 && settings.lowConfidenceMode === "include_with_warning") {
                vscode.window.showWarningMessage(
                    t(
                        `${lowCount} low-confidence library match(es) found (< ${settings.lowConfidenceThreshold.toFixed(2)}). Please confirm selections carefully.`,
                        `发现 ${lowCount} 个低可信库匹配（< ${settings.lowConfidenceThreshold.toFixed(2)}），请仔细确认选择。`
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
                const r = analyze(item.file);
                includeAbs = includeAbs.concat(r.includePaths);
                for (const d of r.defines) if (!defines.includes(d)) defines.push(d);
                totalTokens += r.total;
                missingTokens += r.missing;
            }
        } else if (resolved.length > 0) {
            vscode.window.showInformationMessage(t(
                "No usable library makefile was found for the selected archives.",
                "所选库在本工作区没有可用的 mk 来源。"
            ));
        }
    }

    // --- Locate c_cpp_properties.json ---
    const vscodeDir = path.join(wsRoot, ".vscode");
    const jsonPath = path.join(vscodeDir, "c_cpp_properties.json");
    /** @returns {{ configurations: CppConfig[], version: number }} */
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
            "Failed to create c_cpp_properties.json: " + (e instanceof Error ? e.message : String(e)),
            "创建 c_cpp_properties.json 失败：" + (e instanceof Error ? e.message : String(e))
        ));
        return;
    }

    /** @type {{ configurations: CppConfig[], version?: number }} */
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
                "Failed to parse/reset c_cpp_properties.json: " + (resetErr instanceof Error ? resetErr.message : String(resetErr)),
                "解析或重置 c_cpp_properties.json 失败：" + (resetErr instanceof Error ? resetErr.message : String(resetErr))
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
    const tokens = toWorkspaceRelative([...new Set(includeAbs)], wsRoot);
    const newCfg = buildConfig(targetName, tokens, defines.length ? defines : ["_DEBUG"]);
    const idx = data.configurations.findIndex(c => c.name === targetName);
    const action = idx >= 0 ? (data.configurations[idx] = newCfg, "Updated") : (data.configurations.push(newCfg), "Added");

    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 4) + "\n", "utf-8");

    const skipped = totalTokens > 0 && missingTokens > 0
        ? t(
            ` ${missingTokens}/${totalTokens} path entries do not exist in this workspace and were skipped.`,
            ` 其中 ${missingTokens}/${totalTokens} 条路径在本工作区不存在，已跳过。`
        )
        : "";
    vscode.window.showInformationMessage(
        t(
            `${action} IntelliSense config "${targetName}" (${newCfg.includePath.length} include paths).${skipped}`,
            `${action === "Updated" ? "已更新" : "已新增"} IntelliSense 配置 "${targetName}"（${newCfg.includePath.length} 条 include 路径）。${skipped}`
        )
    );
    if (own.varNames.length) {
        vscode.window.showInformationMessage(
            t(
                `Include paths taken from variable(s): ${own.varNames.join(", ")}; build root: ${path.relative(wsRoot, own.base) || "."}.`,
                `include 路径取自变量：${own.varNames.join(", ")}；构建根：${path.relative(wsRoot, own.base) || "."}。`
            )
        );
    }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand("mkintellisense.updateIntelliSense",
            /** @param {unknown} uri */
            (uri) => {
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
