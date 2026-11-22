import { stripTypeScriptTypes } from "node:module";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, dirname, extname } from "node:path";

/**
 * Turn the owner's original JUUNIBI TypeScript Disk sources into ordinary JS.
 * Node 22.16+/24 has a built-in TypeScript transform: NO npm installation,
 * transpiler package, or runtime network access is required.
 * The outputs are disposable and live under .runtime (never in version control).
 */
export async function prepareDisk(root) {
  if (typeof stripTypeScriptTypes !== "function")
    throw new Error("Модулю «Диск» требуется Node.js 22.16+ (рекомендуется 24).");
  const sourceRoot = join(root, "disk-src");
  const outputRoot = join(root, ".runtime", "disk-built");
  let converted = 0;
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const source = join(directory, item.name);
      if (item.isDirectory()) { await visit(source); continue; }
      if (!item.isFile() || extname(item.name) !== ".ts") continue;
      const dest = join(outputRoot, relative(sourceRoot, source).replace(/\.ts$/, ".js"));
      await mkdir(dirname(dest), { recursive: true });
      const typescript = await readFile(source, "utf8");
      let code = stripTypeScriptTypes(typescript, { mode: "transform", sourceUrl: source });
      // CSS is served as a real stylesheet, not as a JS module.
      code = code.replace(/^\s*import\s*["']\.\/disk\.css["'];?\s*$/gm, "");
      // Neither native Node nor browsers resolve extensionless JS ESM imports.
      code = code.replace(/(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
        (all, prefix, specifier, end) => prefix + specifier + (/\.[mc]?js$/.test(specifier) ? "" : ".js") + end);
      code = code.replace(/(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
        (all, prefix, specifier, end) => prefix + specifier + (/\.[mc]?js$/.test(specifier) ? "" : ".js") + end);
      await writeFile(dest, code, { encoding: "utf8", mode: 0o600 });
      converted++;
    }
  }
  await visit(sourceRoot);
  return { outputRoot, converted };
}
