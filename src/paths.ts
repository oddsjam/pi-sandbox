/**
 * Path expansion, canonicalization, and pattern matching.
 *
 * Pure module — no extension/runtime imports — so it can be unit-tested in
 * isolation against a tmpdir HOME.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

/** Expand a leading "~" to the user's home dir, then resolve to absolute. */
export function expandPath(filePath: string, home: string = homedir()): string {
  const expanded = filePath.replace(/^~(?=$|\/)/, home);
  return resolve(expanded);
}

/**
 * Resolve symlinks. For paths that don't yet exist (e.g. a write target),
 * resolve symlinks in the nearest existing parent and append the missing tail.
 */
export function canonicalizePath(filePath: string, home: string = homedir()): string {
  const abs = expandPath(filePath, home);
  try {
    return realpathSync.native(abs);
  } catch {
    const tail: string[] = [];
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return abs;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return abs;
    }
  }
}

export function resolveToolPath(filePath: string, cwd: string, home: string = homedir()): string {
  const normalized = filePath.replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  return resolve(cwd, normalized.replace(/^~(?=$|\/)/, home));
}

// Match Pi's filename fallbacks so the gate checks the file its read tool opens.
export function resolveReadToolPath(filePath: string, cwd: string, home: string = homedir()): string {
  const resolved = resolveToolPath(filePath, cwd, home);
  const nfd = resolved.normalize("NFD");
  const candidates = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
    nfd,
    resolved.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? resolved;
}

/**
 * Match a path against a list of patterns.
 *
 * - Patterns containing "*" are converted to a regex (escape everything else,
 *   convert "*" to ".*"). Compared against the canonicalized absolute path.
 * - Plain patterns use prefix matching with a directory boundary, so "."
 *   matches the entire cwd subtree but "/etc" does NOT match "/etcd".
 */
export function matchesPattern(
  filePath: string,
  patterns: string[],
  home: string = homedir(),
): boolean {
  const abs = canonicalizePath(filePath, home);
  return patterns.some((p) => {
    const absP = p.includes("*") ? expandPath(p, home) : canonicalizePath(p, home);
    if (p.includes("*")) {
      const escaped = absP.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(abs);
    }
    const sep = absP.endsWith("/") ? "" : "/";
    return abs === absP || abs.startsWith(absP + sep);
  });
}

/**
 * Whether the given path should trigger a write-permission prompt.
 *
 * Secure default: empty allowWrite means deny-all (prompt every path).
 */
export function shouldPromptForWrite(
  path: string,
  allowWrite: string[],
  home: string = homedir(),
): boolean {
  return allowWrite.length === 0 || !matchesPattern(path, allowWrite, home);
}

export function isReadDenied(
  path: string,
  denyRead: string[],
  allowRead: string[],
  home: string = homedir(),
): boolean {
  return denyRead.some((deny) => {
    if (!matchesPattern(path, [deny], home)) return false;
    if (deny.includes("*")) return true;
    const deniedPath = canonicalizePath(deny, home);
    return !allowRead.some((allow) => {
      if (allow.includes("*")) return false;
      const allowedPath = canonicalizePath(allow, home);
      return allowedPath !== deniedPath
        && matchesPattern(allowedPath, [deniedPath], home)
        && matchesPattern(path, [allowedPath], home);
    });
  });
}

/**
 * Find the longest absolute path key in `keys` that is a prefix of `cwd`.
 * Returns null if none match. Used for project-config longest-prefix lookup.
 *
 * Both `cwd` and the keys must already be canonicalized by the caller; this
 * function only compares strings (with directory-boundary semantics).
 */
export function longestPrefixMatch(cwd: string, keys: string[]): string | null {
  let best: string | null = null;
  for (const k of keys) {
    if (cwd === k || cwd.startsWith(k.endsWith("/") ? k : k + "/")) {
      if (best === null || k.length > best.length) best = k;
    }
  }
  return best;
}
