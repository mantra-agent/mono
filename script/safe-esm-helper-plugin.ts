import type { Plugin } from "esbuild";
import { readFile, writeFile } from "fs/promises";

/**
 * esbuild's lazy ESM helper memoises itself BEFORE the init body runs:
 *
 *   // minified:
 *   var X = (a, b) => () => (a && (b = a(a = 0)), b);
 *
 *   // unminified:
 *   var __esm = (fn, res) => function __init() {
 *     return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
 *   };
 *
 * The expression `a(a = 0)` evaluates `a = 0` (the argument) before the call
 * actually returns. If the init body throws, `a` is already 0, so every
 * subsequent invocation skips the init and silently returns the (undefined or
 * partially-populated) cache. The exported namespace object remains populated
 * (it holds getters that close over module-level vars), but those vars are
 * still in their TDZ-replacement `undefined` state. Functions look callable
 * but reference uninitialised state — a footgun across every dynamic import
 * in `dist/index.mjs`.
 *
 * This plugin replaces the helper with a version that:
 *   - Caches the thrown error on first failure.
 *   - Re-throws the cached error on every subsequent call.
 *
 * Net effect: a dynamic import whose init throws will reject the SAME way
 * every time (matching dev/tsx semantics) instead of producing zombie modules.
 */

const MARKER = "/*safe-esm-helper-applied*/";

// Minified form: `var X=(a,b)=>()=>(a&&(b=a(a=0)),b);`
//
// Group 1: helper name (e.g. `i`, `__esm`)
// Group 2: first param name (init function)
// Group 3: second param name (cache)
//
// We require the params to match between declaration and use so we don't
// accidentally rewrite unrelated user code.
const MINIFIED_PATTERN =
  /var\s+([A-Za-z_$][\w$]*)\s*=\s*\(([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\)\s*=>\s*\(\)\s*=>\s*\(\2\s*&&\s*\(\3\s*=\s*\2\(\2\s*=\s*0\)\)\s*,\s*\3\)\s*;?/g;

// Unminified form (used by tests and the un-minified helper bundle):
//   var __esm = (fn, res) => function __init() {
//     return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
//   };
//
// Group 1: helper name
// Group 2: first param (init wrapper object)
// Group 3: second param (cache)
// Group 4: optional inner function name
// Group 5: name of __getOwnPropNames helper
const UNMINIFIED_PATTERN =
  /var\s+([A-Za-z_$][\w$]*)\s*=\s*\(([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\)\s*=>\s*function(?:\s+([A-Za-z_$][\w$]*))?\s*\(\)\s*\{\s*return\s+\2\s*&&\s*\(\3\s*=\s*\(\s*0\s*,\s*\2\s*\[\s*([A-Za-z_$][\w$]*)\s*\(\s*\2\s*\)\s*\[\s*0\s*\]\s*\]\s*\)\s*\(\s*\2\s*=\s*0\s*\)\)\s*,\s*\3\s*;?\s*\}\s*;?/g;

function buildMinifiedReplacement(name: string, fnParam: string, resParam: string): string {
  // Keep the same external shape `(fn, res) => () => ...` and identical local
  // var names so downstream behaviour is byte-compatible apart from the
  // failure-handling additions. `__e` carries the captured error.
  return (
    `var ${name}=(${fnParam},${resParam})=>{var __e;return ()=>{if(__e)throw __e;` +
    `if(${fnParam}){var __i=${fnParam};${fnParam}=0;try{${resParam}=` +
    // Handle both the minified shape (init is the function itself) and the
    // unminified shape (init is a one-key object whose value is the function).
    `typeof __i==="function"?__i():(0,__i[Object.getOwnPropertyNames(__i)[0]])()` +
    `}catch(__x){__e=__x;throw __x}}return ${resParam}};};`
  );
}

function buildUnminifiedReplacement(
  name: string,
  fnParam: string,
  resParam: string,
  getOwnPropNames: string,
): string {
  return (
    `var ${name} = (${fnParam}, ${resParam}) => {\n` +
    `  var __e;\n` +
    `  return function __init() {\n` +
    `    if (__e) throw __e;\n` +
    `    if (${fnParam}) {\n` +
    `      var __i = ${fnParam}; ${fnParam} = 0;\n` +
    `      try { ${resParam} = (0, __i[${getOwnPropNames}(__i)[0]])(); }\n` +
    `      catch (__x) { __e = __x; throw __x; }\n` +
    `    }\n` +
    `    return ${resParam};\n` +
    `  };\n` +
    `};`
  );
}

export interface SafeEsmHelperOptions {
  /** When true, throw if the helper isn't found in an output file. */
  required?: boolean;
}

export function safeEsmHelperPlugin(opts: SafeEsmHelperOptions = {}): Plugin {
  return {
    name: "safe-esm-helper",
    setup(build) {
      build.initialOptions.metafile = true;
      build.onEnd(async (result) => {
        if (!result.metafile) return;

        const outputs = Object.keys(result.metafile.outputs).filter((p) =>
          /\.(m?js|cjs)$/.test(p),
        );

        for (const outPath of outputs) {
          let source: string;
          try {
            source = await readFile(outPath, "utf-8");
          } catch {
            continue;
          }
          if (source.includes(MARKER)) continue;

          let patched = source;
          let minHits = 0;
          let unminHits = 0;

          patched = patched.replace(MINIFIED_PATTERN, (_m, name, fn, res) => {
            minHits++;
            return buildMinifiedReplacement(name, fn, res);
          });

          patched = patched.replace(
            UNMINIFIED_PATTERN,
            (_m, name, fn, res, _innerName, getOwnPropNames) => {
              unminHits++;
              return buildUnminifiedReplacement(name, fn, res, getOwnPropNames);
            },
          );

          if (minHits + unminHits === 0) {
            if (opts.required) {
              throw new Error(
                `safe-esm-helper: helper not found in ${outPath} — esbuild output shape may have changed`,
              );
            }
            continue;
          }
          if (minHits + unminHits > 1) {
            throw new Error(
              `safe-esm-helper: matched ${minHits + unminHits} helpers in ${outPath} — refusing to patch (regex too loose)`,
            );
          }

          patched = `${MARKER}\n${patched}`;
          await writeFile(outPath, patched, "utf-8");
          // eslint-disable-next-line no-console
          console.log(
            `safe-esm-helper: patched __esm in ${outPath} (min=${minHits}, unmin=${unminHits})`,
          );
        }
      });
    },
  };
}
