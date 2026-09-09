"use strict";
/**
 * Unit tests for the generic make extractor. Pure in-memory fixtures only -
 * no project-specific files required.
 *
 *   node --test test/
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const mkcore = require("../src/mkcore");

/**
 * Build an FsApi over an in-memory tree.
 * @param {{dirs?:string[], files?:string[], root?:string}} tree
 */
function memFs(tree) {
    const root = tree.root || (process.platform === "win32" ? "C:/ws" : "/ws");
    const files = new Set([...(tree.files || [])].map((f) => norm(path.resolve(root, f))));
    /**
     * A directory exists only inside a directory that exists, so every entry
     * implies all of its ancestors. Callers list leaves; the parents are filled
     * in here to keep the mock faithful to a real filesystem.
     * @param {Set<string>} dirs @param {string} absPath
     */
    const withAncestors = (dirs, absPath) => {
        let cur = absPath;
        while (cur.length > 1 && !dirs.has(cur)) {
            dirs.add(cur);
            const parent = path.posix.dirname(cur);
            if (parent === cur) break;
            cur = parent;
        }
    };
    const dirs = new Set([norm(path.resolve(root, "."))]);
    for (const d of tree.dirs || []) withAncestors(dirs, norm(path.resolve(root, d)));
    for (const f of files) withAncestors(dirs, path.posix.dirname(f));
    /** @param {string} p */
    const abs = (p) => norm(path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p));
    return mkcore.createFsCache({
        root,
        isDir: (p) => dirs.has(abs(p)),
        exists: (p) => dirs.has(abs(p)) || files.has(abs(p)),
        readFile: (p) => (files.has(abs(p)) ? "" : null),
    });
}
/** @param {string} p */
const norm = (p) => (process.platform === "win32" ? p.toLowerCase().replace(/\\/g, "/") : p.replace(/\\/g, "/"));
/**
 * @param {{root:string}} fsApi
 * @param {string} rel
 */
const R = (fsApi, rel) => path.resolve(fsApi.root, rel);

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

test("joins backslash continuations", () => {
    const lines = mkcore.joinLogicalLines("A = one \\\n    two \\\n    three\nB = x\n");
    assert.deepEqual(lines.slice(0, 2), ["A = one      two      three", "B = x"]);
});

test("strips comments outside $( )", () => {
    assert.equal(mkcore.stripComment("a b  # note"), "a b  ");
    assert.equal(mkcore.stripComment("$(patsubst %,%,x) # y"), "$(patsubst %,%,x) ");
});

test("parses = := ?= += and keeps last assignment, accumulates +=", () => {
    const vars = mkcore.parseMakeVars([
        "V1 = a",
        "V2 := b",
        "V3 ?= c",
        "V4 = d",
        "V4 += e",
        "V5 = first",
        "V5 = second",
    ].join("\n"));
    const g = Object.fromEntries(vars.map((v) => [v.name, v.tokens]));
    assert.deepEqual(g.V1, ["a"]);
    assert.deepEqual(g.V4, ["d", "e"]);
    assert.deepEqual(g.V5, ["second"]);
});

test("recipe lines (tab-indented) are not assignments", () => {
    const vars = mkcore.parseMakeVars("all:\n\tCC = nope\nTOP = yes\n");
    assert.ok(!vars.some((v) => v.name === "CC"));
    assert.ok(vars.some((v) => v.name === "TOP"));
});

test("expands simple variable references", () => {
    const vars = mkcore.parseMakeVars("BASE = src\nPATHS = $(BASE)/a $(BASE)/b\n");
    const p = vars.find((v) => v.name === "PATHS");
    assert.deepEqual(p.tokens, ["src/a", "src/b"]);
});

test("unresolvable references become discarded placeholders", () => {
    const vars = mkcore.parseMakeVars("PATHS = $(UNSET_DIR)/a good\n");
    assert.deepEqual(vars.find((v) => v.name === "PATHS").tokens, ["good"]);
});

test("+= is picked up (regression: old regex required '=' exactly)", () => {
    const f = memFs({ dirs: ["inc", "inc/a", "inc/b"] });
    const content = "MY_INC_PATHS+=\\\n    inc/a \\\n    inc/b\n";
    const r = mkcore.analyzeMk(content, R(f, "prj/x_prj.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.includePaths, [R(f, "inc/a"), R(f, "inc/b")].sort());
});

/* ------------------------------------------------------------------ *
 * Variable selection - generic, no hardcoded names
 * ------------------------------------------------------------------ */

test("selects a directory-like variable whatever it is called", () => {
    const f = memFs({ dirs: ["h1", "h2", "h3"] });
    const r = mkcore.analyzeMk("MY_HEADERS = h1 h2 h3\n", R(f, "p/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.varNames, ["MY_HEADERS"]);
    assert.equal(r.includePaths.length, 3);
});

test("rejects a variable whose values are not directories", () => {
    const f = memFs({ dirs: ["h1"], files: ["h1/main.c", "h1/util.c"] });
    const r = mkcore.analyzeMk("SRCS = h1/main.c h1/util.c\n", R(f, "p/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.varNames, []);
    assert.equal(r.includePaths.length, 0);
});

test("prefers the inc-named variable over another directory-like one", () => {
    const f = memFs({ dirs: ["src/a", "src/b", "inc/a", "inc/b"] });
    const r = mkcore.analyzeMk(
        "SRC_PATHS = src/a src/b\nINC_PATHS = inc/a inc/b\n",
        R(f, "p/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.varNames, ["INC_PATHS"]);
});

test("falls back to the inc naming convention when the ratio threshold fails", () => {
    // 1 of 3 entries missing -> ratio 0.66 < 0.9, but the name says "inc".
    const f = memFs({ dirs: ["inc/a", "inc/b"] });
    const r = mkcore.analyzeMk(
        "INC_PATHS = inc/a inc/b inc/gone\nOTHER = x y\n",
        R(f, "p/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.varNames, ["INC_PATHS"]);
    assert.equal(r.includePaths.length, 2, "missing entry skipped, not emitted");
    assert.equal(r.missing, 1);
});

test("does not fall back to a non-inc variable below threshold", () => {
    const f = memFs({ dirs: ["odd/a"] });
    const r = mkcore.analyzeMk("ODD = odd/a odd/missing\n", R(f, "p/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.equal(r.includePaths.length, 0);
});

/* ------------------------------------------------------------------ *
 * Base detection
 * ------------------------------------------------------------------ */

test("resolves relative paths against an ancestor build root, not the mk dir", () => {
    // mk lives in prj/x/, paths are relative to the component root.
    const f = memFs({ dirs: ["inc", "src"] });
    const r = mkcore.analyzeMk("P = inc src\n", R(f, "deep/nested/prj/x/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2, selection: "all" });
    assert.deepEqual(r.includePaths, [R(f, "inc"), R(f, "src")].sort());
    assert.equal(r.base, R(f, "."));
});

test("prefers the deepest base that still resolves everything", () => {
    const f = memFs({ dirs: ["prj/x/inc", "prj/x/src"] });
    const r = mkcore.analyzeMk("P = inc src\n", R(f, "prj/x/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2, selection: "all" });
    assert.equal(r.base, R(f, "prj/x"));
    assert.equal(r.includePaths.length, 2);
});

test("absolute entries are honoured as-is", () => {
    const f = memFs({ dirs: ["tools/hdr"] });
    const abs = R(f, "tools/hdr");
    const r = mkcore.analyzeMk(`P = ${abs} ${abs}\n`, R(f, "prj/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2, selection: "all" });
    assert.equal(r.includePaths.length, 1);
});

/* ------------------------------------------------------------------ *
 * Compiler-flag style (generic support)
 * ------------------------------------------------------------------ */

test("collects -I paths and -D defines", () => {
    const f = memFs({ dirs: ["a", "b"] });
    const r = mkcore.analyzeMk(
        "CFLAGS = -Ia -I b -DFOO=1 -DBAR -O2\n",
        R(f, "prj/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.includePaths, [R(f, "a"), R(f, "b")].sort());
    assert.deepEqual(r.defines, ["FOO=1", "BAR"]);
});

test("-L is a library search path, not an include path or an archive", () => {
    const f = memFs({ dirs: ["libdir", "inc"] });
    const vars = mkcore.parseMakeVars("LDFLAGS = -Llibdir -lfoo\nINC = -Iinc\n");
    const ld = vars.find((v) => v.name === "LDFLAGS");
    assert.deepEqual(ld.libDirs, ["libdir"]);
    assert.deepEqual(ld.libFlags, ["foo.a"]);
    assert.deepEqual(mkcore.collectLinkedArchives(vars).map((l) => l.name), ["foo"]);

    const r = mkcore.analyzeMk("LDFLAGS = -Llibdir -lfoo\n", R(f, "p/a.mk"), f.root, f, { threshold: 0.9, minTokens: 2 });
    assert.deepEqual(r.includePaths, [], "the -L directory must not become an include path");
});

/* ------------------------------------------------------------------ *
 * Library extraction
 * ------------------------------------------------------------------ */

test("archives from both plain tokens and -l flags, excluding own target", () => {
    const vars = mkcore.parseMakeVars([
        "LINK_LIBS = libfoo.a libbar.a",
        "TARGET_LIB = libmine.a",
        "LDFLAGS = -lbaz",
    ].join("\n"));
    const libs = mkcore.collectLinkedArchives(vars).map((l) => l.name).sort();
    assert.deepEqual(libs, ["baz", "libbar", "libfoo"]);
});

test("supports .lib as well as .a (regression: only .a used to match)", () => {
    const vars = mkcore.parseMakeVars("LNKS = foo.lib bar.a\n");
    assert.deepEqual(mkcore.collectLinkedArchives(vars).map((l) => l.name).sort(), ["bar", "foo"]);
});

test("deduplicates the same archive referenced twice", () => {
    const vars = mkcore.parseMakeVars("A = x/libfoo.a\nB = y/libfoo.a\n");
    assert.equal(mkcore.collectLinkedArchives(vars).length, 1);
});

/* ------------------------------------------------------------------ *
 * Library resolution strategy
 * ------------------------------------------------------------------ */

function fakeApi(index, analyzeMap, archiveMap) {
    return {
        /** @param {string} f */
        analyze: (f) => analyzeMap[f] || { includePaths: [], defines: [], total: 0, missing: 0, varNames: [], base: "" },
        /** @param {string} n */
        findArchive: (n) => (archiveMap || {})[mkcore.normName(n)] || [],
        index,
    };
}
/** @param {string} file */
const entry = (file) => ({
    file,
    dir: path.basename(path.dirname(file)),
    base: path.basename(file, path.extname(file)),
});

test("source project wins over fuzzy matching", () => {
    const idx = [entry("/ws/prj/lib_widget_ren_x/lib_widget_ren_x_prj.mk"), entry("/ws/prj/other/other.mk")];
    const api = fakeApi(idx, { "/ws/prj/lib_widget_ren_x/lib_widget_ren_x_prj.mk": { includePaths: ["/a"] } });
    const r = mkcore.resolveLibrary({ name: "lib_widget", norm: mkcore.normName("lib_widget") }, idx, api, {});
    assert.equal(r.kind, "source");
    assert.equal(r.matches[0].file, "/ws/prj/lib_widget_ren_x/lib_widget_ren_x_prj.mk");
});

test("prebuilt-only library is reported, not fuzzy-matched", () => {
    const idx = [entry("/ws/prj/unrelated/unrelated.mk")];
    const api = fakeApi(idx, {}, { [mkcore.normName("lib_fbl")]: ["/ws/lib/lib_fbl.a"] });
    const r = mkcore.resolveLibrary({ name: "lib_fbl", norm: mkcore.normName("lib_fbl") }, idx, api, {});
    assert.equal(r.kind, "prebuilt");
    assert.equal(r.matches.length, 0);
});

test("a source makefile whose paths do not exist is not offered", () => {
    const idx = [entry("/ws/prj/lib_x/lib_x_prj.mk")];
    const api = fakeApi(idx, { "/ws/prj/lib_x/lib_x_prj.mk": { includePaths: [] } }, { [mkcore.normName("lib_x")]: ["/ws/lib/lib_x.a"] });
    const r = mkcore.resolveLibrary({ name: "lib_x", norm: mkcore.normName("lib_x") }, idx, api, {});
    assert.equal(r.kind, "source-no-paths");
});

test("fuzzy matching keeps every tied candidate (regression: argmax dropped ties)", () => {
    const idx = [entry("/ws/prj/a/libfoo_v1/libfoo_v1.mk"), entry("/ws/prj/b/libfoo_v2/libfoo_v2.mk")];
    const api = fakeApi(idx, {
        "/ws/prj/a/libfoo_v1/libfoo_v1.mk": { includePaths: ["/x"] },
        "/ws/prj/b/libfoo_v2/libfoo_v2.mk": { includePaths: ["/y"] },
    });
    const r = mkcore.resolveLibrary({ name: "libfoo", norm: "libfoo" }, idx, api, { lowConfidenceThreshold: 0.7 });
    assert.equal(r.matches.length, 2);
});

test("fuzzy candidates without include paths are filtered out", () => {
    const idx = [entry("/ws/toolchain/Mcu/Mcu.mk"), entry("/ws/prj/libfoo/libfoo.mk")];
    const api = fakeApi(idx, { "/ws/prj/libfoo/libfoo.mk": { includePaths: ["/z"] } });
    const r = mkcore.resolveLibrary({ name: "libfoo", norm: "libfoo" }, idx, api, {});
    assert.ok(r.matches.every((m) => !m.file.endsWith("Mcu.mk")));
});

test("matchScore: prj tokens must be covered by the lib name", () => {
    // matchScore(project, library)
    assert.equal(mkcore.matchScore("lib_foo_bar", "lib_foo_bar"), 1);
    assert.ok(mkcore.matchScore("lib_foo_bar_prj", "lib_foo") < 1);
    assert.equal(mkcore.matchScore("aaa", "zzz"), 0);
});

test("normName ignores lib prefix, separators and archive extension", () => {
    assert.equal(mkcore.normName("lib_foo_bar_baz.a"), mkcore.normName("foo-bar_baz"));
    assert.equal(mkcore.normName("foo.lib"), mkcore.normName("foo"));
});

/* ------------------------------------------------------------------ *
 * Variant disambiguation
 * ------------------------------------------------------------------ */

test("tokenEquiv tolerates a leading marker on a code, not on a word", () => {
    assert.ok(mkcore.tokenEquiv("t100d", "100d"), "marker before a code is the same component");
    assert.ok(mkcore.tokenEquiv("100d", "t100d"));
    assert.ok(!mkcore.tokenEquiv("phev", "hev"), "words that merely share a suffix stay distinct");
    assert.ok(!mkcore.tokenEquiv("conv", "onv"));
    assert.ok(!mkcore.tokenEquiv("t12", "12"), "remainder must stay long enough to be a code");
});

test("token weights rank a shared word below a unique one", () => {
    const idx = [
        { file: "/ws/a/comp_x_1d/a.mk", dir: "comp_x_1d", base: "comp_x_1d_prj" },
        { file: "/ws/a/comp_x_2d/a.mk", dir: "comp_x_2d", base: "comp_x_2d_prj" },
        { file: "/ws/a/comp_x_3d/a.mk", dir: "comp_x_3d", base: "comp_x_3d_prj" },
    ];
    const w = mkcore.createTokenWeights(idx);
    assert.ok(w("comp") < w("1d"), "a word in every candidate carries no evidence");
    assert.ok(w("1d") > 0 && w("zzz") > w("comp"));
});

test("a variant family is narrowed by the requesting makefile's name", () => {
    // The archive names only the component, so every variant of that component
    // is an exact match; the requesting makefile states which variant this
    // build actually produces, and that is the only evidence available.
    const idx = [
        entry("/ws/prj/lib_comp_ren_100d_conv/lib_comp_ren_100d_conv_prj.mk"),
        entry("/ws/prj/lib_comp_ren_200d_conv/lib_comp_ren_200d_conv_prj.mk"),
        entry("/ws/prj/lib_comp_ren_900d_conv/lib_comp_ren_900d_conv_prj.mk"),
    ];
    const usable = {};
    for (const e of idx) usable[e.file] = { includePaths: ["/x"] };
    const api = fakeApi(idx, usable);
    const weight = mkcore.createTokenWeights(idx);
    const lib = { name: "lib_comp_ren", base: "lib_comp_ren", norm: mkcore.normName("lib_comp_ren") };

    // Without context every variant is offered.
    const blind = mkcore.resolveLibrary(lib, idx, api, { weight });
    assert.equal(blind.matches.length, 3);

    // The requesting makefile is named after the 900d build.
    const ctx = [...mkcore.idTokens("prj_t900d_met_conv"), ...mkcore.idTokens("T900D_MET_CONV_va1")];
    const seen = mkcore.resolveLibrary(lib, idx, api, { weight, contextTokens: ctx });
    assert.equal(seen.matches.length, 1);
    assert.equal(path.basename(path.dirname(seen.matches[0].file)), "lib_comp_ren_900d_conv");
});

test("context does not invent a match when the requester says nothing", () => {
    const idx = [
        entry("/ws/prj/lib_comp_ren_100d/lib_comp_ren_100d_prj.mk"),
        entry("/ws/prj/lib_comp_ren_200d/lib_comp_ren_200d_prj.mk"),
    ];
    const usable = {};
    for (const e of idx) usable[e.file] = { includePaths: ["/x"] };
    const api = fakeApi(idx, usable);
    const weight = mkcore.createTokenWeights(idx);
    const lib = { name: "lib_comp_ren", base: "lib_comp_ren", norm: mkcore.normName("lib_comp_ren") };
    // Requester shares no variant word with either candidate -> keep both.
    const r = mkcore.resolveLibrary(lib, idx, api, { weight, contextTokens: mkcore.idTokens("unrelated_owner") });
    assert.equal(r.matches.length, 2);
});

test("fuzzy stage prefers the candidate confirmed by the requester", () => {
    // Neither candidate is named after the library, and both cover it equally
    // well, so only the requesting makefile's variant word can separate them.
    const idx = [
        entry("/ws/prj/comp_ren_100d_prj/comp_ren_100d_prj.mk"),
        entry("/ws/prj/comp_ren_900d_prj/comp_ren_900d_prj.mk"),
    ];
    const usable = {};
    for (const e of idx) usable[e.file] = { includePaths: ["/x"] };
    const api = fakeApi(idx, usable, {});
    const weight = mkcore.createTokenWeights(idx);
    const lib = { name: "lib_comp_ren_v1", base: "lib_comp_ren_v1", norm: mkcore.normName("lib_comp_ren_v1") };

    const blind = mkcore.resolveLibrary(lib, idx, api, { weight });
    assert.equal(blind.matches.length, 2, "name evidence alone cannot separate them");

    const r = mkcore.resolveLibrary(lib, idx, api, { weight, contextTokens: mkcore.idTokens("build_t900d") });
    assert.equal(r.matches.length, 1);
    assert.equal(path.basename(path.dirname(r.matches[0].file)), "comp_ren_900d_prj");
});
