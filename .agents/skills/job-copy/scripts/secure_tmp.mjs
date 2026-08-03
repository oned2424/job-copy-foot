#!/usr/bin/env node

/**
 * /tmp 配下だけを安全に読み書きするための共有ヘルパー。
 *
 * 実データ（派遣先の社名・住所・電話番号・原稿本文）は /tmp にしか置かない。
 * symlink を辿ると /tmp の外へ書けてしまうので、途中のディレクトリを1段ずつ
 * lstat して symlink を拒否し、最後に O_NOFOLLOW で開く。書き込みは 0600。
 *
 * もとは read_contract.mjs の中にあった。内容確認書の読み取りが
 * Python 直読み（scripts/read_contract.py）へ移り、read_contract.mjs が
 * 無くなったため、ここへ切り出した。
 */

import { constants as fsConstants, realpathSync } from 'node:fs';
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
import { pathToFileURL } from 'node:url';

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

// macOS の /tmp は /private/tmp への symlink。どちらの書き方で渡されても同じ場所なので
// 両方受ける。Python 側（scripts/secure_tmp.py）と挙動を揃えないと、
// 同じパスが片方では通り片方では止まる、という説明のつかない差が出る。
const TMP_ALIASES = (() => {
  const roots = ['/tmp'];
  try {
    const real = realpathSync('/tmp');
    if (real !== '/tmp') roots.push(real);
  } catch { /* /tmp が無い環境では下の判定がそのまま弾く */ }
  return roots;
})();

function resolveTmpChild(candidate, kind) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${kind} path is required.`);
  }
  const resolved = path.resolve(candidate);
  for (const root of TMP_ALIASES) {
    const relative = path.relative(root, resolved);
    if (
      relative
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    ) {
      // 以降の walk は /tmp 起点に揃える。実体は同じ場所を指す。
      return { resolved: path.join('/tmp', relative), relative };
    }
  }
  throw new Error(`${kind} must be a file below /tmp: ${resolved}`);
}

function noFollowFlag() {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error('This platform does not provide O_NOFOLLOW.');
  }
  return fsConstants.O_NOFOLLOW;
}

// 出力ディレクトリの門番。secureWriteTmpFile から内部で呼ぶほか、
// 書き出す前にディレクトリだけ検査したい呼び出し側（lint_copy.mjs --output-dir）にも公開する。
// 各スクリプトが自前で同じ判定を書くと、片方だけ直したときに静かに穴が空く。
export async function ensureSecureTmpDirectory(directory) {
  const resolved = path.resolve(directory);
  // /tmp と /private/tmp のどちらで渡されても同じ場所。以降の walk は /tmp 起点に揃える。
  const relative = (() => {
    for (const root of TMP_ALIASES) {
      const rel = path.relative(root, resolved);
      if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return rel;
    }
    throw new Error(`Output directory must be under /tmp: ${resolved}`);
  })();

  const actualTmpRoot = await realpath('/tmp');
  let current = '/tmp';
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Output directory must not contain symlinks below /tmp: ${current}`);
    }
    if (!metadata.isDirectory()) throw new Error(`Output parent is not a directory: ${current}`);
    const actualCurrent = await realpath(current);
    if (!isPathInside(actualTmpRoot, actualCurrent)) {
      throw new Error(`Output directory resolves outside /tmp: ${current} -> ${actualCurrent}`);
    }
  }
  // 呼び出し側が返り値を path.join して書き出すので、/tmp 起点に揃えて返す。
  return path.join('/tmp', relative);
}

export async function secureReadTmpText(inputPath) {
  const { resolved, relative } = resolveTmpChild(inputPath, 'Input');
  const actualTmpRoot = await realpath('/tmp');
  let current = '/tmp';
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Input path must not contain symlinks below /tmp: ${current}`);
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new Error(`Input parent is not a directory: ${current}`);
    }
    if (index === parts.length - 1 && !metadata.isFile()) {
      throw new Error(`Input path is not a regular file: ${current}`);
    }
  }
  const actualInput = await realpath(resolved);
  if (!isPathInside(actualTmpRoot, actualInput)) {
    throw new Error(`Input resolves outside /tmp: ${resolved} -> ${actualInput}`);
  }

  const handle = await open(resolved, fsConstants.O_RDONLY | noFollowFlag());
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function secureWriteTmpFile(outputPath, content) {
  const { resolved } = resolveTmpChild(outputPath, 'Output');
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
  const tmpDirectory = await mkdtemp('/tmp/job-copy-secure-tmp-selftest-');
  try {
    const inputPath = path.join(tmpDirectory, 'sample.csv');
    await secureWriteTmpFile(inputPath, payload);
    assert(await secureReadTmpText(inputPath) === payload, 'secure /tmp roundtrip');

    const metadata = await lstat(inputPath);
    assert((metadata.mode & 0o777) === 0o600, 'output mode is 0600');

    // /tmp と /private/tmp のどちらの書き方でも同じ場所として通る（Python 側と同じ挙動）。
    const realTmpRoot = await realpath('/tmp');
    if (realTmpRoot !== '/tmp') {
      const aliasPath = path.join(realTmpRoot, path.relative('/tmp', inputPath));
      assert(await secureReadTmpText(aliasPath) === payload, '/private/tmp alias is accepted');
      await secureWriteTmpFile(aliasPath, payload);
    }

    const linkPath = path.join(tmpDirectory, 'sample-link.csv');
    await symlink(inputPath, linkPath);
    await expectReject(() => secureReadTmpText(linkPath), /symlink/);
    await expectReject(() => secureWriteTmpFile(linkPath, payload), /symlink/);

    await expectReject(() => secureReadTmpText('/etc/hosts'), /below \/tmp/);
    await expectReject(() => secureWriteTmpFile('/etc/job-copy-test', payload), /below \/tmp/);
    await expectReject(() => secureReadTmpText(''), /required/);
  } finally {
    await rm(tmpDirectory, { recursive: true, force: true });
  }

  return {
    ok: true,
    cases: 9,
    passedCases: 9,
    failedCases: 0,
    checks: [
      '/tmp roundtrip',
      '0600 mode',
      '/private/tmp alias accepted',
      'symlink read/write rejection',
      'outside /tmp rejection',
      'empty path rejection',
    ],
  };
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
