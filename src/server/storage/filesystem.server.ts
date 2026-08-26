import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

export function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function pathFingerprint(value: string): string {
  return hash(normalizePath(value));
}

export function shortId(prefix: string, bytes = 12, entropy: string = randomUUID()): string {
  return `${prefix}_${createHash("sha256").update(entropy).digest("hex").slice(0, bytes * 2)}`;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function preview(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function compactTimestamp(value: string): string {
  return value.replace(/[-:.TZ+]/g, "").slice(0, 17);
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isWithinPath(boundary: string, candidate: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ESRCH") return false;
    return true;
  }
}

export async function assertSafePath(boundaryPath: string, targetPath: string): Promise<void> {
  const boundary = path.resolve(boundaryPath);
  const target = path.resolve(targetPath);
  if (!isWithinPath(boundary, target)) throw new Error(`Path escapes its plaintext boundary: ${target}`);

  const boundaryInfo = await lstat(boundary);
  if (boundaryInfo.isSymbolicLink()) {
    throw new Error(`Symbolic-link or junction boundary is not supported: ${boundary}`);
  }
  const canonicalBoundary = await realpath(boundary);
  const relativeParts = path.relative(boundary, target).split(path.sep).filter(Boolean);
  let cursor = boundary;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error(`Symbolic-link or junction path is not supported: ${cursor}`);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") break;
      throw error;
    }
  }

  let nearestExisting = target;
  while (!(await exists(nearestExisting))) {
    const parent = path.dirname(nearestExisting);
    if (parent === nearestExisting) throw new Error(`Unable to resolve safe parent for ${target}`);
    nearestExisting = parent;
  }
  const canonicalExisting = await realpath(nearestExisting);
  if (!isWithinPath(canonicalBoundary, canonicalExisting)) {
    throw new Error(`Resolved path escapes its plaintext boundary: ${target}`);
  }
}

export async function atomicWrite(filePath: string, content: string, boundaryPath: string): Promise<void> {
  await assertSafePath(boundaryPath, filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await assertSafePath(boundaryPath, filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Node does not expose a portable compare-and-swap replacement for directory
 * entries. A check followed by rename can still overwrite an editor's atomic
 * save, so a differing replacement is deliberately refused.
 */
export async function atomicWriteIfUnchanged(
  filePath: string,
  expectedContent: string,
  content: string,
  boundaryPath: string,
): Promise<void> {
  await assertSafePath(boundaryPath, filePath);
  const [observedContent, observedInfo] = await Promise.all([
    readFile(filePath, "utf8"),
    lstat(filePath),
  ]);
  if (observedInfo.isSymbolicLink() || !observedInfo.isFile()) {
    throw new Error(`Conditional atomic write requires a regular file: ${filePath}`);
  }
  if (observedContent !== expectedContent) {
    throw new Error(`File changed before conditional atomic write: ${filePath}`);
  }
  if (content === expectedContent) return;
  throw new Error(
    `Atomic compare-and-swap replacement is unavailable for ${filePath}; file was left unchanged`,
  );
}

export interface ConditionalAppendOptions {
  /** Used by recovery tests to inject an editor save at the commit boundary. */
  beforeAppend?: () => void | Promise<void>;
}

/**
 * Appends to the exact regular-file inode that was observed. O_APPEND never
 * overwrites existing bytes. If an editor atomically replaces the pathname,
 * the append lands on the old open inode and the editor's replacement remains
 * untouched; the identity check then reports the conflict.
 */
export async function appendTextIfUnchanged(
  filePath: string,
  expectedContent: string,
  appendedContent: string,
  boundaryPath: string,
  options: ConditionalAppendOptions = {},
): Promise<void> {
  await assertSafePath(boundaryPath, filePath);
  const initialInfo = await lstat(filePath);
  if (initialInfo.isSymbolicLink() || !initialInfo.isFile()) {
    throw new Error(`Conditional append requires a regular file: ${filePath}`);
  }

  const handle = await open(filePath, "a+");
  try {
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile()
      || openedInfo.dev !== initialInfo.dev
      || openedInfo.ino !== initialInfo.ino
    ) {
      throw new Error(`File changed before conditional append: ${filePath}`);
    }
    const openedContent = await handle.readFile({ encoding: "utf8" });
    if (openedContent !== expectedContent) {
      throw new Error(`File changed before conditional append: ${filePath}`);
    }
    await options.beforeAppend?.();
    await handle.appendFile(appendedContent, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  await assertSafePath(boundaryPath, filePath);
  const [confirmedContent, confirmedInfo] = await Promise.all([
    readFile(filePath, "utf8"),
    lstat(filePath),
  ]);
  if (
    confirmedInfo.isSymbolicLink()
    || !confirmedInfo.isFile()
    || confirmedInfo.dev !== initialInfo.dev
    || confirmedInfo.ino !== initialInfo.ino
    || confirmedContent !== `${expectedContent}${appendedContent}`
  ) {
    throw new Error(`File changed during conditional append: ${filePath}`);
  }
}

export async function writeJson(filePath: string, value: unknown, boundaryPath: string): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, boundaryPath);
}

export async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeIfMissing(filePath: string, content: string, boundaryPath: string): Promise<boolean> {
  await assertSafePath(boundaryPath, filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await assertSafePath(boundaryPath, filePath);
  try {
    await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "EEXIST") return false;
    throw error;
  }
}

export async function collectFiles(
  rootPath: string,
  matcher: (name: string) => boolean,
  depth: number,
): Promise<string[]> {
  if (depth < 0 || !(await exists(rootPath))) return [];
  await assertSafePath(path.dirname(rootPath), rootPath);
  const result: string[] = [];
  for (const entry of await readdir(rootPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isFile() && matcher(entry.name)) result.push(entryPath);
    if (entry.isDirectory()) result.push(...(await collectFiles(entryPath, matcher, depth - 1)));
  }
  return result;
}

export async function assertTreeSafe(boundaryPath: string, treeRoot: string, depth = 8): Promise<void> {
  await assertSafePath(boundaryPath, treeRoot);
  const info = await lstat(treeRoot);
  if (info.isSymbolicLink()) throw new Error(`Symbolic-link or junction path is not supported: ${treeRoot}`);
  if (!info.isDirectory() || depth <= 0) return;
  for (const entry of await readdir(treeRoot, { withFileTypes: true })) {
    const entryPath = path.join(treeRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic-link or junction path is not supported: ${entryPath}`);
    if (entry.isDirectory()) await assertTreeSafe(boundaryPath, entryPath, depth - 1);
    else await assertSafePath(boundaryPath, entryPath);
  }
}
