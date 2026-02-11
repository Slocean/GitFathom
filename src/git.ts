import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { ChangeSnapshot, ExtensionConfig } from "./types";

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: GitRepository[];
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: {
    value: string;
  };
}

const MAX_UNTRACKED_FILES = 12;
const MAX_UNTRACKED_FILE_PREVIEW_BYTES = 4096;

export async function getGitApi(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) {
    return undefined;
  }

  const gitExtension = extension.isActive ? extension.exports : await extension.activate();
  if (!gitExtension.enabled) {
    return undefined;
  }

  return gitExtension.getAPI(1);
}

export function pickRepository(repositories: readonly GitRepository[], scmContext?: unknown): GitRepository | undefined {
  if (repositories.length === 0) {
    return undefined;
  }

  const fromContext = extractContextRoot(scmContext);
  if (fromContext) {
    const found = repositories.find((repo) => sameFsPath(repo.rootUri.fsPath, fromContext.fsPath));
    if (found) {
      return found;
    }
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === "file") {
    const sorted = [...repositories].sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    const found = sorted.find((repo) => isPathInside(activeUri.fsPath, repo.rootUri.fsPath));
    if (found) {
      return found;
    }
  }

  return repositories[0];
}

export async function collectRepositoryChanges(
  repositoryPath: string,
  config: ExtensionConfig
): Promise<ChangeSnapshot> {
  const status = await runGit(["status", "--short"], repositoryPath, config.commandTimeoutMs);

  const diffParts: string[] = [];
  const staged = await runGit(["diff", "--staged", "--no-color", "--no-ext-diff"], repositoryPath, config.commandTimeoutMs);
  if (staged.trim()) {
    diffParts.push("# Staged changes", staged);
  }

  if (!config.includeOnlyStaged) {
    const unstaged = await runGit(["diff", "--no-color", "--no-ext-diff"], repositoryPath, config.commandTimeoutMs);
    if (unstaged.trim()) {
      diffParts.push("# Unstaged changes", unstaged);
    }

    const untrackedRaw = await runGit(
      ["ls-files", "--others", "--exclude-standard"],
      repositoryPath,
      config.commandTimeoutMs
    );
    const untrackedFiles = parseLines(untrackedRaw);
    if (untrackedFiles.length > 0) {
      const untrackedPreview = await buildUntrackedFilePreview(untrackedFiles, repositoryPath);
      if (untrackedPreview.trim()) {
        diffParts.push("# Untracked file previews", untrackedPreview);
      }
    }
  }

  const merged = diffParts.join("\n\n");
  const trimmed = trimUtf8(merged, config.maxDiffBytes);

  return {
    status,
    diff: trimmed.text,
    wasTruncated: trimmed.truncated
  };
}

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = stderr?.trim() || error.message;
          reject(new Error(`git ${args.join(" ")} failed: ${details}`));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function buildUntrackedFilePreview(filePaths: string[], repositoryPath: string): Promise<string> {
  const sections: string[] = [];
  const limited = filePaths.slice(0, MAX_UNTRACKED_FILES);

  for (const relativePath of limited) {
    const absolutePath = join(repositoryPath, relativePath);

    try {
      const preview = await readTextPreview(absolutePath);
      sections.push(`## ${relativePath}\n${preview}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      sections.push(`## ${relativePath}\n[Preview unavailable: ${reason}]`);
    }
  }

  if (filePaths.length > limited.length) {
    sections.push(
      `[Only first ${limited.length} untracked files are included out of ${filePaths.length} total untracked files]`
    );
  }

  return sections.join("\n\n");
}

async function readTextPreview(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    return "[Skipped non-regular file]";
  }

  const bytesToRead = Math.min(Number(stat.size), MAX_UNTRACKED_FILE_PREVIEW_BYTES);
  const fileHandle = await fs.open(filePath, "r");
  const buffer = Buffer.alloc(bytesToRead);

  try {
    if (bytesToRead > 0) {
      await fileHandle.read(buffer, 0, bytesToRead, 0);
    }
  } finally {
    await fileHandle.close();
  }

  if (looksBinary(buffer)) {
    return "[Skipped binary file]";
  }

  const text = buffer.toString("utf8").trim();
  if (!text) {
    return "[Empty text file]";
  }

  if (Number(stat.size) > bytesToRead) {
    return `${text}\n[File preview truncated]`;
  }

  return text;
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  if (buffer.includes(0)) {
    return true;
  }

  const sampleSize = Math.min(buffer.length, 1024);
  let nonTextCount = 0;

  for (let i = 0; i < sampleSize; i += 1) {
    const byte = buffer[i];
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControl) {
      nonTextCount += 1;
    }
  }

  return nonTextCount / sampleSize > 0.1;
}

function trimUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, truncated: false };
  }

  const buffer = Buffer.from(text, "utf8");
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return {
    text: `${sliced}\n\n[Diff truncated due to maxDiffBytes limit]`,
    truncated: true
  };
}

function extractContextRoot(value: unknown): vscode.Uri | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const maybeRoot = (value as { rootUri?: unknown }).rootUri;
  if (maybeRoot instanceof vscode.Uri) {
    return maybeRoot;
  }

  return undefined;
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = normalizePath(targetPath);
  const normalizedRoot = normalizePath(rootPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function sameFsPath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}
