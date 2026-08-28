#!/usr/bin/env node

/**
 * Shared secure temporary-file helper.
 *
 * macOS/Linux use /tmp. Windows uses %LOCALAPPDATA%\JobCopy\tmp so job data
 * never lands in Desktop, Documents, or a cloud-synchronised folder. The
 * Windows directory is ACL-restricted to the signed-in user, SYSTEM, and
 * administrators before it is used.
 */

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

function windowsTempRoot() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('LOCALAPPDATA が見つかりません。Windows のユーザープロファイルを確認してください。');
  return path.join(localAppData, 'JobCopy', 'tmp');
}

export const TMP_ROOT = path.resolve(isWindows ? windowsTempRoot() : '/tmp');
let rootReady = null;

function isPathInside(root, candidate) {
  const normalizedRoot = isWindows ? root.toLowerCase() : root;
  const normalizedCandidate = isWindows ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function restrictWindowsAcl(directory) {
  if (!isWindows) return;
  const user = process.env.USERNAME;
  if (!user) throw new Error('USERNAME が見つかりません。Windows のユーザー名を確認してください。');
  try {
    await execFileAsync('icacls', [
      directory,
      '/inheritance:r',
      '/grant:r', `${user}:(OI)(CI)F`,
      '/grant:r', '*S-1-5-18:(OI)(CI)F',
      '/grant:r', '*S-1-5-32-544:(OI)(CI)F',
    ], { windowsHide: true, timeout: 20_000 });
  } catch (error) {
    throw new Error(`一時領域のアクセス権を設定できませんでした: ${error.stderr || error.message}`);
  }
}

async function ensureRoot() {
  if (!rootReady) {
    rootReady = (async () => {
      await mkdir(TMP_ROOT, { recursive: true, mode: 0o700 });
      const metadata = await lstat(TMP_ROOT);
      if (metadata.isSymbolicLink()) throw new Error(`一時領域がリンクです: ${TMP_ROOT}`);
      if (!metadata.isDirectory()) throw new Error(`一時領域がディレクトリではありません: ${TMP_ROOT}`);
      await restrictWindowsAcl(TMP_ROOT);
      return realpath(TMP_ROOT);
    })();
  }
  return rootReady;
}

function resolveTmpChild(candidate, kind, { allowRoot = false } = {}) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${kind} path is required.`);
  }
  const resolved = path.resolve(candidate);
  if (!isPathInside(TMP_ROOT, resolved) || (!allowRoot && resolved === TMP_ROOT)) {
    throw new Error(`${kind} must be ${allowRoot ? 'inside or equal to' : 'a file below'} ${TMP_ROOT}: ${resolved}`);
  }
  return resolved;
}

async function assertNoLinks(root, candidate, { requireFile = false } = {}) {
  const relative = path.relative(root, candidate);
  let current = root;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Path must not contain symlinks below ${TMP_ROOT}: ${current}`);
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new Error(`Input parent is not a directory: ${current}`);
    }
    if (index === parts.length - 1 && requireFile && !metadata.isFile()) {
      throw new Error(`Input path is not a regular file: ${current}`);
    }
  }
}

function noFollowFlag() {
  return Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
}

export async function ensureSecureTmpDirectory(directory = TMP_ROOT) {
  const actualRoot = await ensureRoot();
  const resolved = resolveTmpChild(directory, 'Output directory', { allowRoot: true });
  const relative = path.relative(TMP_ROOT, resolved);
  let current = TMP_ROOT;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Output directory must not contain symlinks below ${TMP_ROOT}: ${current}`);
    }
    if (!metadata.isDirectory()) throw new Error(`Output parent is not a directory: ${current}`);
    const actualCurrent = await realpath(current);
    if (!isPathInside(actualRoot, actualCurrent)) {
      throw new Error(`Output directory resolves outside ${TMP_ROOT}: ${current} -> ${actualCurrent}`);
    }
  }
  return resolved;
}

export async function secureReadTmpText(inputPath) {
  const resolved = resolveTmpChild(inputPath, 'Input');
  const actualRoot = await ensureRoot();
  await assertNoLinks(TMP_ROOT, resolved, { requireFile: true });
  const actualInput = await realpath(resolved);
  if (!isPathInside(actualRoot, actualInput)) {
    throw new Error(`Input resolves outside ${TMP_ROOT}: ${resolved} -> ${actualInput}`);
  }

  const handle = await open(resolved, fsConstants.O_RDONLY | noFollowFlag());
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function secureWriteTmpFile(outputPath, content) {
  const resolved = resolveTmpChild(outputPath, 'Output');
  await ensureSecureTmpDirectory(path.dirname(resolved));
  try {
    const metadata = await lstat(resolved);
    if (metadata.isSymbolicLink()) throw new Error(`Output file must not be a symlink: ${resolved}`);
    if (!metadata.isFile()) throw new Error(`Output path is not a regular file: ${resolved}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_TRUNC
    | noFollowFlag();
  const handle = await open(resolved, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return resolved;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}

async function expectReject(callback, pattern) {
  let thrown = null;
  try {
    await callback();
  } catch (error) {
    thrown = error;
  }
  assert(thrown && pattern.test(thrown.message), `expected rejection ${pattern}, got ${thrown?.message ?? 'none'}`);
}

export async function runSelfTest() {
  const payload = 'a,b\n1,2\n';
  await ensureRoot();
  const tmpDirectory = await mkdtemp(path.join(TMP_ROOT, 'job-copy-secure-tmp-selftest-'));
  try {
    const inputPath = path.join(tmpDirectory, 'sample.csv');
    await secureWriteTmpFile(inputPath, payload);
    assert(await secureReadTmpText(inputPath) === payload, 'secure temporary roundtrip');

    const metadata = await lstat(inputPath);
    assert((metadata.mode & 0o777) === 0o600, 'output mode is 0600');

    const linkPath = path.join(tmpDirectory, 'sample-link.csv');
    try {
      await symlink(inputPath, linkPath);
    } catch (error) {
      if (!isWindows) throw error;
    }
    try {
      await expectReject(() => secureReadTmpText(linkPath), /symlink/);
    } catch (error) {
      if (!isWindows) throw error;
    }

    await expectReject(() => secureReadTmpText(path.join(path.dirname(TMP_ROOT), 'outside.csv')), /below|inside/);
    await expectReject(() => secureWriteTmpFile('', payload), /required/);
  } finally {
    await rm(tmpDirectory, { recursive: true, force: true });
  }

  return { ok: true, tmpRoot: TMP_ROOT };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write('Usage: node secure_tmp.mjs --self-test\n');
    return;
  }
  if (!argv.includes('--self-test')) {
    throw new Error('secure_tmp.mjs is a library. Only --self-test is runnable.');
  }
  process.stdout.write(`${JSON.stringify(await runSelfTest(), null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`secure_tmp: ${error.message}\n`);
    process.exitCode = 1;
  });
}
