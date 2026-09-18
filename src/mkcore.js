"use strict";
/**
 * Generic GNU-make include-path / library extraction.
 *
 * IMPORTANT: this module must stay project-agnostic. It contains no build-system
 * specific variable names, directory names or file names. Variable roles are
 * inferred from the *content* of their values, with generic C/C++ naming
 * conventions (`inc` / `include` / `hdr` / `header`) used only as a tie-breaker
 * and as a last-resort fallback.
 */

const path = require("path");

/** Marks a sub-expression whose value cannot be determined statically. */
const PH = "\u0000";

/**
 * Generic naming conventions for "directories that contain headers".
 * Mirrors idioms used across build systems (CMake `INCLUDE_DIRECTORIES`,
 * autotools `CPPFLAGS`, GCC `-I`), not any single project.
 */
const INC_NAME_RE = /(?:^|[^a-z0-9])(inc|include|includes|hdr|hdrs|header|headers)(?:[^a-z0-9]|$)/i;

/** Variable assignment: NAME = / := / ?= / += / !=  (with optional spaces). */
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_.$\-]*)\s*(:=|\?=|\+=|!=|=)(.*)$/;

/** Prefix keywords that may precede an assignment. */
const KEYWORD_RE = /^(export|override|unexport|define|undefine)\s+/;

const IS_WIN = process.platform === "win32";

/* ------------------------------------------------------------------ *
 * Text-level helpers
 * ------------------------------------------------------------------ */

/**
 * Merge backslash-continued physical lines into logical lines.
 * @param {string} text
 * @returns {string[]}
 */
function joinLogicalLines(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    /** @type {string[]} */
    const out = [];
    /** @type {string|null} */
    let buf = null;
    for (const raw of lines) {
        const line = buf === null ? raw : buf + " " + raw;
        const m = /(\\*)$/.exec(line);
        const backslashes = m ? m[1].length : 0;
        if (backslashes % 2 === 1) {
            buf = line.slice(0, -1); // drop the escaping backslash, keep going
        } else {
            out.push(line);
            buf = null;
        }
    }
    if (buf !== null) out.push(buf);
    return out;
}

/**
 * Remove an unescaped `#` comment, ignoring `#` inside `$( ... )`.
 * @param {string} s
 * @returns {string}
 */
function stripComment(s) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "\\") { i++; continue; }
        if (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{")) { depth++; i++; continue; }
        if (depth > 0 && (c === ")" || c === "}")) { depth--; continue; }
        if (c === "#" && depth === 0) return s.slice(0, i);
    }
    return s;
}

/**
 * Replace `$(NAME)` / `${NAME}` with the variable's value when it is a simple
 * scalar, otherwise with the opaque placeholder so the token is discarded
 * instead of being mis-parsed.
 * @param {string} s
 * @param {(name: string) => string | undefined} get
 * @returns {string}
 */
function expandRefs(s, get) {
    let out = "";
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{")) {
            const closer = s[i + 1] === "(" ? ")" : "}";
            let depth = 1;
            let j = i + 2;
            while (j < s.length && depth > 0) {
                if (s[j] === closer) depth--;
                else if (s[j] === "$" && (s[j + 1] === "(" || s[j + 1] === "{")) { j++; depth++; }
                j++;
            }
            const inner = s.slice(i + 2, Math.max(i + 2, j - 1));
            const v = inner && !/[\s,=$()]/.test(inner) ? get(inner) : undefined;
            out += v !== undefined && v !== "" && !/\s/.test(v) && !v.includes(PH) ? v : PH;
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/**
 * Normalise path separators without breaking `C:\foo`.
 * @param {string} p
 * @returns {string}
 */
function normalizeSep(p) {
    if (/^[A-Za-z]:/.test(p)) return p.replace(/\\/g, "/");
    return p.replace(/\\/g, "/");
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isAbsoluteToken(p) {
    return /^[A-Za-z]:\//.test(p) || p.startsWith("/");
}

/* ------------------------------------------------------------------ *
 * Variable parsing
 * ------------------------------------------------------------------ */

/** One parsed make variable, fully expanded. */
/**
 * @typedef {{name:string, value:string, tokens:string[], incFlags:string[],
 *   libFlags:string[], libDirs:string[], defines:string[]}} MakeVar
 */

/**
 * Parse every make variable assignment in a file.
 * @param {string} text
 * @returns {MakeVar[]}
 */
function parseMakeVars(text) {
    const logical = joinLogicalLines(text);
    /** @type {Map<string,{raw:string,seen:boolean}>} */
    const slots = new Map();
    /** @type {string[]} */
    const order = [];

    for (const line of logical) {
        if (/^\t/.test(line)) continue; // recipe line
        let s = line.replace(/^ +/, "");
        if (!s || s.startsWith("#")) continue;
        s = s.replace(KEYWORD_RE, "");
        const m = ASSIGN_RE.exec(s);
        if (!m) continue;
        const [, name, op, restRaw] = m;
        const value = stripComment(restRaw).trim();
        if (op === "!=") continue; // shell-provided, unknown statically

        if (!slots.has(name)) { slots.set(name, { raw: "", seen: false }); order.push(name); }
        const slot = slots.get(name);
        if (op === "+=") {
            slot.raw = slot.seen ? `${slot.raw} ${value}` : value;
            slot.seen = true;
        } else if (op === "?=") {
            if (!slot.seen) { slot.raw = value; slot.seen = true; }
        } else {
            slot.raw = value;
            slot.seen = true;
        }
    }

    /** @type {Map<string,string>} */
    const rawMap = new Map();
    for (const [k, v] of slots) rawMap.set(k, v.raw);

    /** @type {Map<string,string>} */
    const memo = new Map();
    /**
     * @param {string} name
     * @param {Set<string>} stack
     * @returns {string}
     */
    const resolve = (name, stack) => {
        if (memo.has(name)) return memo.get(name);
        if (stack.has(name)) return PH;
        stack.add(name);
        const r = expandRefs(rawMap.get(name) || "", (n) => resolve(n, stack));
        stack.delete(name);
        memo.set(name, r);
        return r;
    };

    return order.map((name) => {
        const value = resolve(name, new Set());
        const t = tokenizeValue(value);
        return { name, value, ...t };
    });
}

/** Split a resolved value into path-like tokens and compiler flags. */
/**
 * @typedef {{tokens:string[], incFlags:string[], libFlags:string[],
 *   libDirs:string[], defines:string[]}} VarTokens
 */

/**
 * @param {string} value
 * @returns {VarTokens}
 */
function tokenizeValue(value) {
    const parts = String(value).split(/\s+/).filter(Boolean);
    /** @type {string[]} */
    const tokens = [];
    /** @type {string[]} */
    const incFlags = [];
    /** @type {string[]} */
    const libFlags = [];
    /** @type {string[]} */
    const libDirs = [];
    /** @type {string[]} */
    const defines = [];

    for (let i = 0; i < parts.length; i++) {
        const t = parts[i];

        if (t === "-I" || t === "-L") {
            const next = parts[i + 1];
            if (next && !next.includes(PH)) (t === "-I" ? incFlags : libDirs).push(normalizeSep(next));
            i++;
            continue;
        }
        if (t.startsWith("-I") && t.length > 2) {
            if (!t.slice(2).includes(PH)) incFlags.push(normalizeSep(t.slice(2)));
            continue;
        }
        if (t.startsWith("-L") && t.length > 2) {
            if (!t.slice(2).includes(PH)) libDirs.push(normalizeSep(t.slice(2)));
            continue;
        }
        if (t.startsWith("-D")) {
            const d = t.length > 2 ? t.slice(2) : parts[++i];
            if (d && !d.includes(PH)) defines.push(d);
            continue;
        }
        if (t.startsWith("-l") && t.length > 2) {
            if (!t.slice(2).includes(PH)) libFlags.push(normalizeSep(t.slice(2)) + ".a");
            continue;
        }
        if (/^[-+@|]/.test(t)) continue;          // other flags / pipes
        if (t.includes(PH)) continue;             // unresolvable
        if (/[*?[]/.test(t)) continue;            // glob, cannot verify
        const cleaned = t.replace(/^["']/, "").replace(/["'],?$/, "");
        if (!cleaned || cleaned === "." || cleaned === "..") continue;
        tokens.push(normalizeSep(cleaned));
    }
    return { tokens, incFlags, libFlags, libDirs, defines };
}

/* ------------------------------------------------------------------ *
 * File-system abstraction (cached)
 * ------------------------------------------------------------------ */

/**
 * Raw file-system view supplied by the caller.
 * @typedef {{
 *   root?: string,
 *   isDir: (p: string) => boolean,
 *   exists: (p: string) => boolean,
 *   readFile: (p: string) => string | null
 * }} FsRaw
 */

/**
 * Cached file-system view used internally and returned by {@link createFsCache}.
 * @typedef {FsRaw & {
 *   root: string,
 *   dirHits: (tokens: string[], base: string) => number,
 *   resolveToken: (tok: string, base: string) => string
 * }} FsApi
 */

/**
 * @param {FsRaw} raw
 * @returns {FsApi}
 */
function createFsCache(raw) {
    /** @type {Map<string, boolean>} */
    const dirMemo = new Map();
    /** @type {Map<string, boolean>} */
    const existMemo = new Map();
    // Cache keys must treat `C:\a\b` and `c:/a/b` as the same directory,
    // otherwise a caller-supplied file-system view (tests, VS Code providers)
    // that normalises separators differently would never be hit.
    const canon = (/** @type {string} */ p) => {
        const s = normalizeSep(String(p));
        return IS_WIN ? s.toLowerCase() : s;
    };
    const toRaw = (/** @type {string} */ p) => normalizeSep(String(p));

    const isDir = (/** @type {string} */ p) => {
        const k = canon(p);
        if (!dirMemo.has(k)) dirMemo.set(k, !!p && safe(() => raw.isDir(toRaw(p))));
        return dirMemo.get(k);
    };
    const exists = (/** @type {string} */ p) => {
        const k = canon(p);
        if (!existMemo.has(k)) existMemo.set(k, safe(() => raw.exists(toRaw(p))));
        return existMemo.get(k);
    };
    const resolveToken = (/** @type {string} */ tok, /** @type {string} */ base) =>
        (isAbsoluteToken(normalizeSep(tok)) ? path.normalize(tok) : path.resolve(base, tok));
    /**
     * First path segment of a relative multi-segment token, or null when the
     * token has no such prefix to test. A directory cannot exist unless its
     * first segment does, so checking the handful of distinct segments instead
     * of every token discards a wrong base almost for free.
     * @param {string} tok @returns {string|null}
     */
    const firstSeg = (/** @type {string} */ tok) => {
        const s = normalizeSep(String(tok));
        if (isAbsoluteToken(s)) return null;
        const i = s.indexOf("/");
        return i > 0 ? s.slice(0, i) : null;
    };
    const dirHits = (/** @type {string[]} */ tokens, /** @type {string} */ base) => {
        let n = 0;
        /** @type {Map<string, boolean>|null} */
        let segOk = null;
        // `isDir` already memoises, so repeated tokens cost nothing extra.
        for (const tok of tokens) {
            const seg = firstSeg(tok);
            if (seg !== null) {
                if (!segOk) segOk = new Map();
                let ok = segOk.get(seg);
                if (ok === undefined) {
                    ok = isDir(resolveToken(seg, base));
                    segOk.set(seg, ok);
                }
                if (!ok) continue;
            }
            if (isDir(resolveToken(tok, base))) n++;
        }
        return n;
    };
    const readFile = (/** @type {string} */ p) => {
        try { return raw.readFile(toRaw(p)); } catch { return null; }
    };
    return { root: raw.root || process.cwd(), isDir, exists, readFile, dirHits, resolveToken };
}

function safe(/** @type {() => unknown} */ fn) {
    try { return !!fn(); } catch { return false; }
}

/* ------------------------------------------------------------------ *
 * Base-directory discovery
 * ------------------------------------------------------------------ */

function samePath(/** @type {string} */ a, /** @type {string} */ b) {
    return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Candidate roots that a makefile's relative paths may be resolved against:
 * the makefile's own directory and every ancestor up to the workspace root.
 * Purely structural - no directory names are assumed.
 * @param {string} mkPath
 * @param {string|null} wsRoot
 * @returns {string[]}
 */
function baseCandidates(mkPath, wsRoot) {
    /** @type {string[]} */
    const out = [];
    const root = wsRoot ? path.resolve(wsRoot) : null;
    let d = path.dirname(path.resolve(mkPath));
    for (let guard = 0; guard < 64; guard++) {
        out.push(d);
        if (root && samePath(d, root)) return out;
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
    }
    if (root && !out.some((x) => samePath(x, root))) out.push(root);
    return out;
}

/* ------------------------------------------------------------------ *
 * Per-file analysis
 * ------------------------------------------------------------------ */

const DEFAULT_ANALYZE_OPTS = { threshold: 0.9, minTokens: 2, selection: "inc-only" };

/**
 * Decide which of the qualifying variables actually contribute include paths.
 *
 *   "inc-only" : keep only variables whose *name* follows the generic
 *                inc/include/hdr/header convention. src/lib directories are
 *                not header roots, and including them makes the C/C++ parser
 *                index the whole tree.
 *   "all"      : keep every qualifying variable.
 *   "prefer"   : keep the inc-named ones, plus any other qualifying variable
 *                when no inc-named variable qualified.
 *
 * @param {Array<{v:MakeVar, base:string, ratio:number}>} pool
 * @param {(v:MakeVar, base:string)=>{hits:number, ratio:number}} ratioAt
 * @param {string} base
 * @param {string} mode
 * @param {number} threshold
 * @returns {MakeVar[]}
 */
function selectVars(pool, ratioAt, base, mode, threshold) {
    const onBase = pool.filter((p) => ratioAt(p.v, base).ratio >= threshold).map((p) => p.v);
    const named = onBase.filter((v) => INC_NAME_RE.test(v.name));
    if (mode === "all") return onBase;
    if (mode === "inc-only") return named;
    return named.length ? named : onBase;
}

/**
 * Extract include paths from a makefile without assuming any variable name.
 *
 * @param {string} content   makefile text
 * @param {string} mkPath    absolute path of the makefile
 * @param {string|null} wsRoot  workspace root (base-candidate ceiling)
 * @param {ReturnType<typeof createFsCache>} fs
 * @param {{threshold?:number,minTokens?:number,selection?:string}} [opts]
 */
function analyzeMk(content, mkPath, wsRoot, fs, opts) {
    const o = { ...DEFAULT_ANALYZE_OPTS, ...(opts || {}) };
    const vars = parseMakeVars(content);
    const bases = baseCandidates(mkPath, wsRoot);
    const ownBase = bases[0] || path.dirname(path.resolve(mkPath));

    /** Resolve every `-I` style entry found anywhere in the file.
     *  Compiler flags are relative to the directory `make` runs in, which is
     *  the makefile's own directory most of the time but can be an ancestor;
     *  try the same candidate roots as for path variables, deepest first. */
    /** @type {Set<string>} */
    const flagPaths = new Set();
    let incFlagTotal = 0;
    let incFlagMissing = 0;
    for (const v of vars) {
        for (const tok of v.incFlags) {
            incFlagTotal++;
            let hit = null;
            for (const b of bases) {
                const abs = fs.resolveToken(tok, b);
                if (fs.isDir(abs)) { hit = abs; break; }
            }
            if (hit) flagPaths.add(hit);
            else incFlagMissing++;
        }
    }
    /** @type {string[]} */
    const defines = [];
    for (const v of vars) for (const d of v.defines) if (!defines.includes(d)) defines.push(d);

    const empty = {
        base: ownBase,
        /** @type {string[]} */
        varNames: [], includePaths: [...flagPaths].sort(), defines,
        total: 0, missing: 0, incFlagTotal, incFlagMissing,
    };

    const dirVars = vars.filter((v) => v.tokens.length >= o.minTokens);
    if (!dirVars.length) return empty;

    /**
     * @param {MakeVar} v
     * @param {string} base
     * @returns {{hits:number, ratio:number}}
     */
    const ratioAt = (v, base) => {
        const hits = fs.dirHits(v.tokens, base);
        return { hits, ratio: hits / v.tokens.length };
    };

    // Phase A - each variable gets its own best base, so a variable is never
    // disqualified merely because a *different* variable prefers another base.
    const perVar = dirVars.map((v) => {
        /** @type {{base:string, ratio:number, hits:number}|null} */
        let best = null;
        for (const b of bases) {
            const { hits, ratio } = ratioAt(v, b);
            const better = !best
                || ratio > best.ratio + 1e-9
                || (Math.abs(ratio - best.ratio) <= 1e-9 && b.length > best.base.length);
            if (better) best = { base: b, ratio, hits };
        }
        return { v, ...best };
    });

    let pool = perVar.filter((p) => p.ratio >= o.threshold);
    if (!pool.length) pool = perVar.filter((p) => INC_NAME_RE.test(p.v.name));
    if (!pool.length) return empty;

    // Phase B - one base for the whole file (a makefile has a single build root).
    let base = pool[0].base;
    let bestScore = -1;
    for (const cand of bases) {
        let score = 0;
        for (const p of pool) score += ratioAt(p.v, cand).hits;
        const deeper = cand.length > base.length;
        if (score > bestScore || (score === bestScore && deeper && score > 0)) {
            bestScore = score;
            base = cand;
        }
    }

    let chosen = selectVars(pool, ratioAt, base, o.selection, o.threshold);
    if (!chosen.length) {
        chosen = pool.filter((p) => INC_NAME_RE.test(p.v.name) && ratioAt(p.v, base).hits > 0).map((p) => p.v);
    }
    if (!chosen.length) return { ...empty, base };

    /** @type {Set<string>} */
    const includeSet = new Set(flagPaths);
    let total = 0;
    let missing = 0;
    for (const v of chosen) {
        for (const tok of v.tokens) {
            total++;
            const abs = fs.resolveToken(tok, base);
            if (fs.isDir(abs)) includeSet.add(abs);
            else missing++;
        }
    }

    return {
        base,
        varNames: chosen.map((v) => v.name),
        includePaths: [...includeSet].sort(),
        defines,
        total,
        missing,
        incFlagTotal,
        incFlagMissing,
    };
}

/* ------------------------------------------------------------------ *
 * Library resolution
 * ------------------------------------------------------------------ */

const ARCH_EXT_RE = /\.(a|lib|o|obj)$/i;

/** @param {string} name @returns {string} */
function stripArchExt(name) {
    return String(name).replace(ARCH_EXT_RE, "");
}

/** Case/format-insensitive identity used to link a library to its source project. */
/** @param {string} s @returns {string} */
function normName(s) {
    return String(s)
        .replace(ARCH_EXT_RE, "")
        .toLowerCase()
        .replace(/^lib[_\-.]?/, "")
        .replace(/[^a-z0-9]+/g, "");
}

/** Split a name into comparable word tokens (generic identifier conventions). */
/** @param {string} s @returns {string[]} */
function nameTokens(s) {
    return stripArchExt(s)
        .toLowerCase()
        .split(/[_\-.]+/)
        .filter((t) => t.length > 1);
}

/**
 * Fraction of `prj`'s name tokens that also occur in `lib`'s name tokens.
 * @param {string} prj
 * @param {string} lib
 * @returns {number} 0..1
 */
function matchScore(prj, lib) {
    const libSet = new Set(nameTokens(lib));
    const prjToks = nameTokens(prj);
    if (!prjToks.length || !libSet.size) return 0;
    const hit = prjToks.filter((t) => libSet.has(t)).length;
    return hit / prjToks.length;
}

/**
 * Remove a leading alphabetic variant marker from a token, keeping only the
 * case where the remainder is still a code. Component identifiers are often
 * written twice with a short marker in front of an otherwise identical code
 * (`t100d` and `100d`, `x200d` and `200d`), and that marker can be the only
 * difference between a library archive and the project that builds it.
 *
 * Requiring a digit in the remainder keeps the rule structural rather than
 * name-specific, and stops it from merging real words that merely start with a
 * letter (`phev` must stay distinct from `hev`, `conv` from `onv`).
 * @param {string} t @returns {string|null}
 */
function stripLeadingLetters(t) {
    const m = /^[a-z]{1,2}(.{3,})$/.exec(t);
    if (!m || !/\d/.test(m[1])) return null;
    return m[1];
}

/**
 * Tolerant token equality: identical, or one side carries a short leading
 * variant marker that the other omits.
 * @param {string} a @param {string} b @returns {boolean}
 */
function tokenEquiv(a, b) {
    if (a === b) return true;
    return stripLeadingLetters(a) === b || stripLeadingLetters(b) === a;
}

/**
 * Inverse-document-frequency weights for the name tokens occurring in a set of
 * candidate makefiles.
 *
 * A token shared by every candidate (`<common>`, `prj`, a platform word) says
 * nothing about *which* candidate a library refers to, while a token unique to
 * one candidate is decisive evidence. Counting every token equally lets the
 * shared words dominate and produces large groups of tied scores; weighting by
 * rarity makes the distinguishing token carry the decision instead.
 *
 * @param {Array<{dir: string, base: string}>} mkIndex
 * @returns {(token: string) => number} token -> weight (0 when uninformative)
 */
function createTokenWeights(mkIndex) {
    const total = Math.max(1, mkIndex.length);
    /** @type {Map<string, number>} */
    const df = new Map();
    for (const e of mkIndex) {
        for (const t of new Set(idTokens(e.dir).concat(idTokens(e.base)))) {
            df.set(t, (df.get(t) || 0) + 1);
        }
    }
    /** @type {Map<string, number>} */
    const memo = new Map();
    return (token) => {
        let w = memo.get(token);
        if (w === undefined) {
            w = Math.log(1 + total / (df.get(token) || 1));
            memo.set(token, w);
        }
        return w;
    };
}

/**
 * Rarity-weighted version of {@link matchScore}: the fraction of `prj`'s
 * evidence carried by tokens that also occur in `lib`. Tolerant equality is
 * used so a variant marker on either side does not hide a real match.
 * @param {string} prj @param {string} lib @param {(t:string)=>number} weight
 * @returns {number} 0..1
 */
function weightedMatchScore(prj, lib, weight) {
    const libToks = idTokens(lib);
    const prjToks = [...new Set(idTokens(prj))];
    if (!prjToks.length || !libToks.length) return 0;
    let hit = 0;
    let all = 0;
    for (const t of prjToks) {
        const w = weight(t);
        all += w;
        if (libToks.some((u) => tokenEquiv(u, t))) hit += w;
    }
    return all > 0 ? hit / all : 0;
}

/**
 * Score how well a candidate project name is confirmed by the makefile that
 * *requested* the library.
 *
 * A build normally states the variant it produces in its own file or directory
 * name, and the archives it links carry the same variant word, so the requesting
 * makefile is the strongest evidence available for choosing between several
 * projects that share one component name. Tokens are compared with the same
 * rarity weights used for name matching, which stops the words common to every
 * candidate (component, platform, ...) from inflating an unrelated variant.
 *
 * @param {string[]} contextTokens tokens of the requesting makefile's name / directory
 * @param {(t:string)=>number} weight rarity weight from {@link createTokenWeights}
 * @returns {(name:string)=>number} candidate name -> 0..1 confirmation
 */
function createContextMatcher(contextTokens, weight) {
    const ctx = [...new Set(contextTokens)];
    return (/** @type {string} */ name) => {
        if (!ctx.length) return 0;
        const toks = [...new Set(idTokens(name))];
        if (!toks.length) return 0;
        let hit = 0;
        let all = 0;
        for (const t of toks) {
            const w = weight(t);
            all += w;
            if (ctx.some((u) => tokenEquiv(u, t))) hit += w;
        }
        return all > 0 ? hit / all : 0;
    };
}

/**
 * Archive tokens referenced by a makefile, minus the archives the makefile
 * *builds itself*. A target definition is recognised structurally: a variable
 * whose entire value is a single bare archive file name (no directory part),
 * which is how build systems conventionally declare a target-output variable.
 * Entries that carry a directory (`obj/libfoo.a`) are treated as dependencies.
 *
 * @param {Array<{tokens:string[],libFlags:string[]}>} vars output of {@link parseMakeVars}
 * @returns {Array<{token:string,name:string,base:string,norm:string}>}
 */
function collectLinkedArchives(vars) {
    const selfTargets = new Set();
    for (const v of vars) {
        if (v.tokens.length !== 1) continue;
        const tok = v.tokens[0];
        if (!ARCH_EXT_RE.test(tok)) continue;
        if (tok.includes("/") || tok.includes("\\")) continue;
        selfTargets.add(normName(tok));
    }

    /** @type {Array<{token:string,name:string,base:string,norm:string}>} */
    const found = [];
    const seen = new Set();
    const push = (/** @type {string} */ tok) => {
        if (!ARCH_EXT_RE.test(tok)) return;
        // Identity is the archive *file* name: `x/libfoo.a` and `y/libfoo.a`
        // are the same component referenced from two directories.
        const n = normName(path.basename(tok));
        if (!n || selfTargets.has(n) || seen.has(n)) return;
        seen.add(n);
        const stripped = stripArchExt(tok);
        found.push({ token: tok, name: stripped, base: path.basename(stripped), norm: n });
    };
    for (const v of vars) {
        for (const t of v.tokens) push(t);
        for (const l of v.libFlags) push(l);
    }
    return found;
}

/**
 * Name tokens used for identity comparison: the generic `lib` archive prefix is
 * dropped so that `libfoo.a`, `libfoo` and `foo` describe the same component.
 * @param {string} s
 * @returns {string[]}
 */
function idTokens(s) {
    const toks = nameTokens(s);
    return toks[0] === "lib" ? toks.slice(1) : toks;
}

/**
 * True when `a`'s tokens are a leading sequence of `b`'s, i.e. `b` names a
 * more specific variant of the component `a` names (`libfoo` -> `libfoo_v2`).
 * A very short component word (`ip`, `a`) is not enough evidence that two
 * names describe the same thing, so it is left to the scored fuzzy stage.
 * @param {string[]} a
 * @param {string[]} b
 */
function isTokenPrefix(a, b) {
    if (!a.length || a.length > b.length) return false;
    if (a.join("").length < 4) return false;
    return a.every((t, i) => tokenEquiv(b[i], t));
}

/**
 * Makefiles naming (or living beside) the library itself, either identically
 * or as a specific variant of it. Exported separately so callers can tell
 * whether the cheap stage succeeded before building any expensive index.
 * @param {string} id @param {string} idNorm @param {string[]} idToks
 * @param {Array<{file:string,dir:string,base:string}>} mkIndex
 * @returns {Array<{e:{file:string,dir:string,base:string}, score:number}>}
 */
function findExactMatches(id, idNorm, idToks, mkIndex) {
    /** @type {Array<{e:{file:string,dir:string,base:string}, score:number}>} */
    const exact = [];
    for (const e of mkIndex) {
        let score = 0;
        if (normName(e.dir) === idNorm || normName(e.base) === idNorm) score = 1;
        else if (sameComponent(idToks, idTokens(e.dir)) || sameComponent(idToks, idTokens(e.base))) score = 0.95;
        if (score > 0) exact.push({ e, score });
    }
    return exact;
}

/**
 * Identity between a library name and a makefile / project-directory name:
 * either side may be the more specific variant (`libfoo.a` built by project
 * `libfoo_v2`, or `libfoo_v2.a` built by project `libfoo`).
 * @param {string[]} x
 * @param {string[]} y
 */
function sameComponent(x, y) {
    return isTokenPrefix(x, y) || isTokenPrefix(y, x);
}

/**
 * Stage 1 on its own: the source project named after the library, if present.
 *
 * Candidates are analysed in order of how strongly the requesting makefile
 * confirms them, and a weaker tier is only examined when the preferred variant
 * turns out to contribute nothing. That keeps the expensive file analysis away
 * from sibling variants the build cannot be using.
 *
 * @param {{name:string,norm:string,base?:string}} lib
 * @param {Array<{file:string,dir:string,base:string}>} mkIndex
 * @param {(file:string)=>{includePaths:string[]}} analyze
 * @param {{weight?:((t:string)=>number)|null, contextTokens?:string[]|null}} [opts]
 * @returns {LibraryResolution|null} null when no candidate is named after the library
 */
function resolveLibrarySourceStage(lib, mkIndex, analyze, opts) {
    /** @type {{weight: ((t:string)=>number)|null, contextTokens: string[]|null}} */
    const o = { weight: null, contextTokens: null, ...(opts || {}) };
    const id = lib.base || lib.name;
    const exact = findExactMatches(
        id,
        lib.base ? normName(lib.base) : lib.norm,
        idTokens(id),
        mkIndex
    );
    if (!exact.length) return null;

    let tiers = [exact];
    if (o.contextTokens && exact.length > 1) {
        const ctx = createContextMatcher(o.contextTokens, o.weight || (() => 1));
        const top = Math.max(...exact.map((x) => x.score));
        const group = exact.filter((x) => x.score === top);
        const best = Math.max(...group.map((x) => ctx(x.e.dir)));
        if (best > 0) {
            const preferred = group.filter((x) => ctx(x.e.dir) >= best - 1e-9);
            tiers = [preferred, exact.filter((x) => !preferred.includes(x))];
        }
    }

    for (const tier of tiers) {
        const usable = tier.filter((x) => analyze(x.e.file).includePaths.length > 0);
        if (usable.length) {
            return {
                lib: id,
                kind: "source",
                matches: usable.map((x) => ({ file: x.e.file, score: x.score, low: false }))
            };
        }
    }
    return { lib: id, kind: "source-no-paths", matches: [] };
}

/**
 * Decide, for one library, whether its source project is present, whether only
 * a prebuilt archive is present, or whether a fuzzy match is needed.
 *
 * @typedef {{ file: string, score: number, low: boolean }} LibraryMatch
 * @typedef {{ lib: string, kind: "source"|"fuzzy"|"fuzzy-low", matches: LibraryMatch[], archives?: undefined }
 *   | { lib: string, kind: "source-no-paths"|"not-found", matches: [], archives?: undefined }
 *   | { lib: string, kind: "prebuilt", matches: [], archives: string[] }} LibraryResolution
 *
 * @param {{name:string,norm:string,base?:string}} lib
 * @param {Array<{file:string,dir:string,base:string}>} mkIndex
 * @param {{analyze:(file:string)=>{includePaths:string[]}, findArchive:(name:string)=>string[]}} api
 * @param {{lowConfidenceThreshold?:number, weight?:((t:string)=>number)|null, contextTokens?:string[]|null}} [opts]
 * @returns {LibraryResolution}
 */
function resolveLibrary(lib, mkIndex, api, opts) {
    /** @type {{lowConfidenceThreshold: number, weight: ((t:string)=>number)|null, contextTokens: string[]|null}} */
    const o = { lowConfidenceThreshold: 0.7, weight: null, contextTokens: null, ...(opts || {}) };
    // Archives are often referenced with a path (`obj/<target>/libfoo.a`);
    // only the file stem can identify a project.
    const id = lib.base || lib.name;
    const weight = o.weight || (() => 1);
    const ctx = o.contextTokens ? createContextMatcher(o.contextTokens, weight) : null;

    // 1. Source project first: a makefile (or its directory) named after the
    //    library, either identically or as a specific variant of it.
    const source = resolveLibrarySourceStage(lib, mkIndex, api.analyze, o);
    if (source) return source;

    // 2. Only a prebuilt archive exists in this workspace -> nothing to index.
    const archives = api.findArchive(id);
    if (archives.length) {
        return { lib: id, kind: "prebuilt", archives, matches: [] };
    }

    // 3. Fuzzy: keep every tied best candidate (not just the first argmax) and
    //    require the candidate to actually contribute include paths. Scoring is
    //    rarity-weighted when weights are available, so a token shared by every
    //    candidate cannot hold unrelated variants together, and is confirmed by
    //    the requesting makefile's own variant name when one is known.
    const score = (/** @type {string} */ s) => {
        const name = weightedMatchScore(s, id, weight);
        if (!ctx || !name) return name;
        return name * (0.5 + 0.5 * ctx(s));
    };
    let bestScore = 0;
    /** @type {Array<{file:string,dir:string,base:string,score:number}>} */
    let cands = [];
    for (const e of mkIndex) {
        const s = Math.max(score(e.base), score(e.dir));
        if (s > bestScore + 1e-9) { bestScore = s; cands = [{ ...e, score: s }]; }
        else if (Math.abs(s - bestScore) <= 1e-9 && s > 0) cands.push({ ...e, score: s });
    }
    const good = cands.filter((c) => api.analyze(c.file).includePaths.length > 0);
    if (!good.length) return { lib: id, kind: "not-found", matches: [] };
    return {
        lib: id,
        kind: bestScore < o.lowConfidenceThreshold ? "fuzzy-low" : "fuzzy",
        matches: good.map((c) => ({ file: c.file, score: c.score, low: c.score < o.lowConfidenceThreshold })),
    };
}

module.exports = {
    PH,
    INC_NAME_RE,
    joinLogicalLines,
    stripComment,
    expandRefs,
    normalizeSep,
    parseMakeVars,
    tokenizeValue,
    createFsCache,
    baseCandidates,
    analyzeMk,
    collectLinkedArchives,
    resolveLibrary,
    resolveLibrarySourceStage,
    findExactMatches,
    createTokenWeights,
    createContextMatcher,
    matchScore,
    weightedMatchScore,
    tokenEquiv,
    normName,
    nameTokens,
    idTokens,
    stripArchExt,
    DEFAULT_ANALYZE_OPTS,
};
