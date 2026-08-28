import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

async function isExecutable(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a Python executable for the current OS without relying on the
 * Microsoft Store execution alias. JOB_COPY_PYTHON can override it for a
 * managed installation.
 */
export async function resolvePythonCommand() {
  if (process.env.JOB_COPY_PYTHON) return process.env.JOB_COPY_PYTHON;
  if (process.platform !== 'win32') return 'python3';

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const base = path.join(localAppData, 'Python');
    try {
      const directories = (await readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^pythoncore-/i.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const directory of directories) {
        const candidate = path.join(base, directory, 'python.exe');
        if (await isExecutable(candidate)) return candidate;
      }
    } catch {
      // Fall through to the standard command below.
    }
  }
  return 'python';
}
