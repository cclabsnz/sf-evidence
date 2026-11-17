import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** PATH lookup without a shell: the first executable file named `cmd` on any PATH entry. */
export async function which(cmd: string): Promise<string | null> {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, cmd + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** `git config --get`: null when unset, throws when git could not look. execFile, never a shell, in the archive root so repo-level config counts. */
export async function gitConfig(root: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', root, 'config', '--get', key]);
    return stdout.trim() || null;
  } catch (err) {
    // `git config --get` exits 1 when the key is simply unset. Any other failure (no such
    // directory, git unusable) means git never looked, which is not the same as "not set".
    if ((err as { code?: unknown }).code === 1) return null;
    throw err;
  }
}

const ENGINE = '@cclabsnz/sf-evidence-engine';

async function versionOf(pkgPath: string): Promise<string> {
  const parsed = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') throw new Error(`${pkgPath} has no version`);
  return parsed.version;
}

/** The nearest package.json at or above `from` whose name is `name`. */
async function findPackageJson(from: string, name: string): Promise<string> {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'package.json');
    try {
      if ((JSON.parse(await readFile(candidate, 'utf8')) as { name?: string }).name === name) return candidate;
    } catch {
      // keep climbing
    }
    if (dirname(dir) === dir) throw new Error(`no package.json named ${name} above ${from}`);
  }
}

/**
 * Plugin and engine versions, or the reason they could not be read. Never throws: doctor
 * reports an unreadable version as a warning, it does not crash on it.
 */
export async function readVersions(
  pluginEntry: string = fileURLToPath(import.meta.url),
  engineEntry?: string,
): Promise<{ plugin: string; engine: string } | { error: string }> {
  try {
    const entry = engineEntry ?? createRequire(import.meta.url).resolve(ENGINE);
    return {
      plugin: await versionOf(await findPackageJson(pluginEntry, '@cclabsnz/sf-evidence')),
      engine: await versionOf(await findPackageJson(entry, ENGINE)),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
