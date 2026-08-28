#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalizeJoblistRows,
  columnToIndex,
  compileColumnMap,
  normalizeJoblistRows,
  parseCsv,
} from './read_joblist.mjs';
import { parseCompetitorSections } from './generate_variants.mjs';
import { TMP_ROOT } from './secure_tmp.mjs';
import { resolvePythonCommand } from './python_runtime.mjs';

// 内容確認書はCSVを経由しない。scripts/read_contract.py がスプレッドシートを直読みする。
// contract-map.json を解釈する責任もそちらに一本化してあるので、ここでは子プロセスで呼ぶ。
const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const MINIMUM_NODE_MAJOR = 20;
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LINT_START_MARKER = '<!-- JOB_COPY_LINT_RULES_START -->';
const LINT_END_MARKER = '<!-- JOB_COPY_LINT_RULES_END -->';

const REQUIRED_SKILL_FILES = Object.freeze([
  'SKILL.md',
  'SETUP.md',
  'scripts/read_joblist.mjs',
  'scripts/lint_copy.mjs',
  'scripts/read_contract.py',
  'scripts/audit_tags.mjs',
  'scripts/generate_variants.mjs',
  'scripts/write_output.mjs',
  'scripts/preflight.mjs',
  'scripts/make_request_sheet.mjs',
  'references/airwork-ng.md',
  'references/airwork-tags.md',
  'references/appeal-formula.md',
  'references/value-axes.md',
  'references/recruit-axes.md',
  'references/expression-frames.md',
  'references/personas/_schema.md',
  'references/personas/driver-aichi.md',
  'references/personas/factory-inspect-aichi.md',
  'assets/output-template.md',
  'assets/variants-template.md',
  'assets/tag-audit-template.md',
  'assets/ab-result-template.md',
]);

const CLIENT_JSON_NAMES = Object.freeze([
  'config.json',
  'column-map.json',
  'contract-map.json',
  'limits.json',
]);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--self-test') {
      options.selfTest = true;
      continue;
    }
    if (!['--client', '--joblist'].includes(argument)) {
      throw new Error(`不明な引数です: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} には値が必要です。`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function isUnderTmp(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(TMP_ROOT, resolved);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export async function runReadContract(mode, clientId, skillRoot = SKILL_ROOT) {
  const pythonCommand = await resolvePythonCommand();
  const { stdout } = await execFileAsync(
    pythonCommand,
    [path.join(skillRoot, 'scripts', 'read_contract.py'), '--client', clientId, mode],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

export function decodeUtf8(buffer, label = 'CSV') {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\u0000') || text.includes('\uFFFD')) {
      throw new Error('NULまたは置換文字が含まれています。');
    }
    return text;
  } catch (error) {
    throw new Error(
      `${label}はUTF-8として読めません: ${error.message}。`
      + 'スプレッドシートで対象タブを開き、ファイル → ダウンロード → '
      + 'カンマ区切り形式(.csv)から再ダウンロードしてください。',
      { cause: error },
    );
  }
}

function lineNumberAt(text, index) {
  if (index < 0) return -1;
  return text.slice(0, index).split('\n').length;
}

export function parseLintRulesDocument(markdown) {
  const startIndex = markdown.indexOf(LINT_START_MARKER);
  const endIndex = markdown.indexOf(LINT_END_MARKER);
  const positions = {
    startIndex,
    endIndex,
    startLine: lineNumberAt(markdown, startIndex),
    endLine: lineNumberAt(markdown, endIndex),
  };
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(
      `ルールJSONマーカーが不正です。開始位置=${startIndex}、終了位置=${endIndex}。`,
    );
  }
  const section = markdown.slice(startIndex + LINT_START_MARKER.length, endIndex);
  const fence = section.match(/```json\s*([\s\S]*?)\s*```/);
  if (!fence) {
    throw new Error(
      `ルールJSONのコードブロックがありません。開始行=${positions.startLine}、終了行=${positions.endLine}。`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (error) {
    throw new Error(
      `ルールJSONが壊れています。開始行=${positions.startLine}、終了行=${positions.endLine}: ${error.message}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed.rules)) throw new Error('ルールJSONにrules[]がありません。');
  return { parsed, positions };
}

function result(number, name, status, detail, fix = '') {
  return { number, name, status, detail, fix };
}

function isSupportedNodeVersion(nodeVersion) {
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

function firstHeaderMismatch(rows, columnMap) {
  const compiled = compileColumnMap(columnMap);
  const canonical = canonicalizeJoblistRows(rows, { columnMap });
  const header = canonical.rows[0];
  const expectedHeaders = [...compiled.expectedHeaders.entries()]
    .sort((left, right) => columnToIndex(left[0]) - columnToIndex(right[0]));
  for (const [column, expected] of expectedHeaders) {
    const actual = header[columnToIndex(column)];
    if (actual !== expected) return { column, expected, actual };
  }
  return null;
}

async function readJsonSettings(clientId, skillRoot) {
  const directory = path.join(skillRoot, 'references', 'clients', clientId);
  const values = {};
  const errors = [];
  for (const name of CLIENT_JSON_NAMES) {
    const filePath = path.join(directory, name);
    try {
      values[name] = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join(' / '));
  if (values['config.json']?.clientId !== clientId) {
    throw new Error(`config.json clientId=${values['config.json']?.clientId} / --client=${clientId}`);
  }
  compileColumnMap(values['column-map.json']);
  // contract-map.json の中身は read_contract.py --check-map（検査8）が見る。ここでは読み込みだけ。
  if (!values['limits.json']?.columns || typeof values['limits.json'].columns !== 'object') {
    throw new Error('limits.json columnsがありません。');
  }
  return {
    config: values['config.json'],
    columnMap: values['column-map.json'],
    contractMap: values['contract-map.json'],
    limits: values['limits.json'],
  };
}

async function inspectRequiredFiles(skillRoot, clientId) {
  const missing = [];
  const requiredFiles = [
    ...REQUIRED_SKILL_FILES,
    `references/clients/${clientId}/ab-log.schema.json`,
  ];
  for (const relativePath of requiredFiles) {
    const candidate = path.join(skillRoot, relativePath);
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile()) missing.push(`${relativePath}（通常ファイルではありません）`);
    } catch (error) {
      missing.push(`${relativePath}（${error.code ?? error.message}）`);
    }
  }
  return { missing, requiredCount: requiredFiles.length };
}

async function verifyTmpWritable() {
  const directory = await mkdtemp(path.join(TMP_ROOT, 'job-copy-preflight-'));
  try {
    const probe = path.join(directory, 'write-test');
    await writeFile(probe, 'ok', { mode: 0o600, flag: 'wx' });
    await access(probe, fsConstants.R_OK | fsConstants.W_OK);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runPreflight({
  clientId,
  joblistPath,
  skillRoot = SKILL_ROOT,
  nodeVersion = process.versions.node,
} = {}) {
  if (!CLIENT_ID_PATTERN.test(clientId ?? '')) throw new Error(`不正なクライアントIDです: ${clientId}`);
  const resolvedJoblist = path.resolve(joblistPath ?? '');
  const checks = [];

  checks.push(isSupportedNodeVersion(nodeVersion)
    ? result(1, 'Node.jsバージョン', 'OK', `現在 ${nodeVersion} / 必要 ${MINIMUM_NODE_MAJOR}.0.0以上`)
    : result(
      1,
      'Node.jsバージョン',
      'NG',
      `現在 ${nodeVersion} / 必要 ${MINIMUM_NODE_MAJOR}.0.0以上`,
      `Node.js ${MINIMUM_NODE_MAJOR}以上をインストールし、node --versionで再確認してください。`,
    ));

  const requiredFiles = await inspectRequiredFiles(skillRoot, clientId);
  checks.push(requiredFiles.missing.length === 0
    ? result(2, '必須ファイル', 'OK', `${requiredFiles.requiredCount}ファイルを確認`)
    : result(2, '必須ファイル', 'NG', `不足: ${requiredFiles.missing.join(', ')}`, '配布物を展開し直してください。'));

  let references = null;
  try {
    references = await readJsonSettings(clientId, skillRoot);
    checks.push(result(3, 'クライアント設定4点', 'OK', CLIENT_JSON_NAMES.join(', ')));
  } catch (error) {
    checks.push(result(3, 'クライアント設定4点', 'NG', error.message, '壊れたJSON名を市野へ連絡してください。'));
  }

  try {
    const markdown = await readFile(path.join(skillRoot, 'references', 'airwork-ng.md'), 'utf8');
    const { parsed, positions } = parseLintRulesDocument(markdown);
    checks.push(result(
      4,
      '規約ルールJSON',
      'OK',
      `開始行 ${positions.startLine} / 終了行 ${positions.endLine} / ${parsed.rules.length}ルール`,
    ));
  } catch (error) {
    checks.push(result(4, '規約ルールJSON', 'NG', error.message, 'airwork-ng.mdを配布元から戻してください。'));
  }

  // 内容確認書はCSVを経由しない（検査8・9でスプレッドシートを直読みする）。
  // ここで見るのはJoblist CSVだけ。
  let joblistBuffer = null;
  const inputErrors = [];
  if (!isUnderTmp(resolvedJoblist)) inputErrors.push(`Joblistは一時領域配下へ置いてください: ${resolvedJoblist}`);
  if (inputErrors.length === 0) {
    try {
      joblistBuffer = await readFile(resolvedJoblist);
    } catch (error) {
      inputErrors.push(`${error.message}（Joblist: ${resolvedJoblist}）`);
    }
  }
  checks.push(inputErrors.length === 0
    ? result(5, '入力CSV（Joblist）', 'OK', resolvedJoblist)
    : result(5, '入力CSV（Joblist）', 'NG', inputErrors.join(' / '), 'JoblistタブをCSVで再ダウンロードし、ユーザー専用の一時領域へ置いてください。'));

  let joblistText = null;
  if (joblistBuffer) {
    try {
      joblistText = decodeUtf8(joblistBuffer, 'Joblist CSV');
      const hasBom = joblistBuffer.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]));
      checks.push(result(6, 'UTF-8文字コード（Joblist）', 'OK', hasBom ? 'BOMあり（吸収可）' : 'UTF-8'));
    } catch (error) {
      checks.push(result(6, 'UTF-8文字コード（Joblist）', 'NG', error.message, 'JoblistタブからCSVを再ダウンロードしてください。'));
    }
  } else {
    checks.push(result(6, 'UTF-8文字コード（Joblist）', 'SKIP', 'Joblist CSVを読めないため未検査'));
  }

  let joblistRows = null;
  if (joblistText && references) {
    try {
      joblistRows = parseCsv(joblistText);
      const mismatch = firstHeaderMismatch(joblistRows, references.columnMap);
      if (mismatch) {
        throw new Error(
          `期待 ${references.columnMap.expectedColumnCount}列 / 実際 ${joblistRows[0].length}列。`
          + `最初の不一致は${mismatch.column}列です。`
          + `実際=${JSON.stringify(mismatch.actual)} / 期待=${JSON.stringify(mismatch.expected)}`,
        );
      }
      const { diagnostics } = canonicalizeJoblistRows(joblistRows, { columnMap: references.columnMap });
      normalizeJoblistRows(joblistRows, {
        clientId,
        csvPath: resolvedJoblist,
        config: references.config,
        columnMap: references.columnMap,
      });
      const absorbed = diagnostics.ignoredTrailingEmptyRows
        + diagnostics.ignoredTrailingEmptyColumns
        + diagnostics.paddedTrailingEmptyColumns;
      checks.push(result(
        7,
        'Joblistヘッダー',
        'OK',
        `期待 ${diagnostics.expectedColumnCount}列 / 実際 ${diagnostics.actualHeaderColumnCount}列。`
        + (absorbed ? '末尾の空行・空列だけの差なので、そのまま進めて問題ありません。' : '列順も一致しています。'),
      ));
    } catch (error) {
      checks.push(result(
        7,
        'Joblistヘッダー',
        'NG',
        error.message,
        'Sheet1タブを選び直してCSVを再ダウンロードしてください。列の追加・並べ替えはしないでください。',
      ));
    }
  } else {
    checks.push(result(7, 'Joblistヘッダー', 'SKIP', '文字コードまたは設定が不正なため未検査'));
  }

  // 検査8: contract-map.json の構造検査。通信しない。
  // contract-map を解釈する責任は read_contract.py だけが持つ（二重実装を作らない）ので、
  // ここでは --check-map を子プロセスで呼んで結果を受け取る。
  let mapOk = false;
  try {
    const map = await runReadContract('--check-map', clientId, skillRoot);
    if (map.contractMapClientId !== clientId || map.configClientId !== clientId) {
      throw new Error(`client_id不一致: config=${map.configClientId} / contract-map=${map.contractMapClientId} / --client=${clientId}`);
    }
    mapOk = true;
    checks.push(result(
      8,
      '内容確認書マップ・行35',
      'OK',
      `${map.fieldCount}項目 / ${map.rangeCount}レンジ / 参照行 ${map.requestedRows.join(',')}`
      + ` / 構造的に読まない行 ${map.structurallyExcludedRows.join(',')}（タブ: ${map.sheetName}）`,
    ));
  } catch (error) {
    checks.push(result(
      8,
      '内容確認書マップ・行35',
      'NG',
      (error.stderr || error.message || '').trim(),
      'contract-map.json に行35（年齢・性別・国籍）を含む範囲が入っていないか確認してください。',
    ));
  }

  // 検査9: 内容確認書スプレッドシートへの疎通。値は1つも読まない。
  // 認証やネットワークが無い環境でも preflight 全体は通したいので、失敗はWARNに留める。
  if (mapOk) {
    try {
      const probe = await runReadContract('--probe', clientId, skillRoot);
      checks.push(result(
        9,
        '内容確認書 疎通',
        'OK',
        `${probe.title} / タブ ${probe.sheetName} / ${probe.spreadsheetId}`,
      ));
    } catch (error) {
      checks.push(result(
        9,
        '内容確認書 疎通',
        'WARN',
        (error.stderr || error.message || '').trim(),
        'gcloud auth application-default login で認証し直すか、config.json の contract.spreadsheet.id と共有設定を確認してください。',
      ));
    }
  } else {
    checks.push(result(9, '内容確認書 疎通', 'SKIP', '検査8がNGのため未実施'));
  }

  try {
    await verifyTmpWritable();
    checks.push(result(10, '一時領域書き込み', 'OK', '一時ファイルを作成・削除できました'));
  } catch (error) {
    checks.push(result(10, '一時領域書き込み', 'NG', error.message, '一時領域のアクセス権と空き容量を確認してください。'));
  }

  // 競合分析は任意。無ければ競合変数を使わずに生成する（generate_variants と同じ扱い）。
  // 置いてあるのに壊れている場合だけ止める。
  const competitorRelative = path.join('references', 'clients', clientId, 'competitors', '_merged.md');
  try {
    const competitor = parseCompetitorSections(await readFile(path.join(skillRoot, competitorRelative), 'utf8'));
    checks.push(result(11, '競合分析（任意）', 'OK', `${competitorRelative} / 変数${competitor.variables.size}個・セクション${competitor.sectionsRead.join('・')}`));
  } catch (error) {
    checks.push(error.code === 'ENOENT'
      ? result(11, '競合分析（任意）', 'SKIP', `${competitorRelative} は未配置。競合変数なしで生成します。`)
      : result(11, '競合分析（任意）', 'NG', error.message, 'セクション1の変数は9個ちょうどです。セクション4・8の必須語を消していないか確認してください。'));
  }

  return {
    ok: !checks.some((check) => check.status === 'NG'),
    clientId,
    joblistPath: resolvedJoblist,
    checks,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectReject(callback, pattern) {
  let error = null;
  try {
    await callback();
  } catch (caught) {
    error = caught;
  }
  assert(error && pattern.test(error.message), `期待したエラー ${pattern} / 実際 ${error?.message ?? 'なし'}`);
}

export async function runSelfTest() {
  const cases = [];
  const check = async (name, callback) => {
    try {
      await callback();
      cases.push({ name, passed: true });
    } catch (error) {
      cases.push({ name, passed: false, detail: error.message });
    }
  };

  await check('Node 20以上', () => assert(isSupportedNodeVersion('20.0.0'), 'Node要件'));
  await check('Node 20未満', () => assert(!isSupportedNodeVersion('18.20.0'), '旧Nodeの拒否'));
  await check('UTF-8正常', () => assert(decodeUtf8(Buffer.from('\uFEFF日本語')) === '日本語', 'UTF-8'));
  await check('UTF-8異常', async () => {
    await expectReject(async () => decodeUtf8(Buffer.from([0xFF, 0xFE, 0x00])), /再ダウンロード/);
  });
  await check('ルールJSON正常', () => {
    const doc = `${LINT_START_MARKER}\n\`\`\`json\n{"rules":[]}\n\`\`\`\n${LINT_END_MARKER}`;
    assert(parseLintRulesDocument(doc).parsed.rules.length === 0, 'ルールJSON');
  });
  await check('ルールJSON異常', async () => {
    await expectReject(async () => parseLintRulesDocument('markerなし'), /開始位置=-1/);
  });
  // 内容確認書の検査は read_contract.py が持つ。ここで同じ検証を書くと二重実装になるので、
  // 「子プロセス連携が生きているか」と「向こうの自己診断が通るか」だけを見る。
  await check('read_contract.py 自己診断', async () => {
    const { stdout } = await execFileAsync(
      await resolvePythonCommand(),
      [path.join(SKILL_ROOT, 'scripts', 'read_contract.py'), '--self-test'],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    assert(report.ok === true, `read_contract.py self-test 失敗: ${stdout}`);
  });
  await check('runReadContract 不正クライアント拒否', async () => {
    await expectReject(async () => runReadContract('--check-map', 'no-such-client'), /./);
  });

  const config = {
    clientId: 'foot',
    contract: { spreadsheet: { id: 'test', sheetName: '作成用' } },
    identity: { jobNumberColumn: 'A', approvalStatusColumn: 'B', publicationStatusColumn: 'C' },
    publishedStatusValues: ['02'],
    evidenceStatuses: {
      extracted: 'EXTRACTED_JOBLIST',
      confirmedInternal: 'CONFIRMED_INTERNAL',
      missing: 'MISSING',
      conflict: 'CONFLICT',
    },
  };
  const columnMap = {
    expectedColumnCount: 5,
    sourceRange: 'A:E',
    defaultCategory: 'unused',
    categories: {
      copy: { selectors: [{ column: 'D', headers: { D: '原稿' } }] },
      tags: { selectors: [{ column: 'E', headers: { E: 'タグ' } }] },
      immutable: { selectors: [{ columns: ['A', 'B', 'C'] }] },
      unused: { selectors: [] },
    },
  };
  await check('Joblist UI差異吸収', () => {
    const pythonRows = parseCsv('番号,承認,掲載,原稿,タグ\r\n1,承認,02,"二行\n原稿",未経験\r\n');
    const uiRows = parseCsv('\uFEFF番号,承認,掲載,原稿,タグ,,\r\n1,承認,02,"二行\n原稿",未経験,,\r\n,,,,,,,\r\n');
    const context = { clientId: 'foot', csvPath: path.join(TMP_ROOT, 'same.csv'), config, columnMap };
    assert(
      JSON.stringify(normalizeJoblistRows(pythonRows, context))
      === JSON.stringify(normalizeJoblistRows(uiRows, context)),
      'UI版とPython版が不一致',
    );
  });
  await check('Joblist必要列不足', async () => {
    await expectReject(
      async () => canonicalizeJoblistRows(parseCsv('番号,承認,掲載,原稿\n'), { columnMap }),
      /missing column is E/,
    );
  });

  await check('一時領域書き込み', verifyTmpWritable);

  const failedCases = cases.filter((entry) => !entry.passed).length;
  return {
    ok: failedCases === 0,
    passedCases: cases.length - failedCases,
    failedCases,
    cases,
  };
}

function printReport(report) {
  for (const check of report.checks) {
    process.stdout.write(`[${check.status}] ${check.number}. ${check.name}: ${check.detail}\n`);
    if (check.fix) process.stdout.write(`  対処: ${check.fix}\n`);
  }
  process.stdout.write(report.ok ? '判定: 実行できます。\n' : '判定: 修正後にもう一度preflightを実行してください。\n');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/preflight.mjs --client <id> --joblist <private-temp>/file.csv\n'
      + '       node scripts/preflight.mjs --self-test\n',
    );
    return;
  }
  if (options.selfTest) {
    if (options.client || options.joblist) {
      throw new Error('--self-testは他のオプションと併用できません。');
    }
    const report = await runSelfTest();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (!options.client || !options.joblist) throw new Error('--clientと--joblistが必要です。');
  const report = await runPreflight({
    clientId: options.client,
    joblistPath: options.joblist,
  });
  printReport(report);
  if (!report.ok) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`preflight: ${error.message}\n`);
    process.exitCode = 1;
  });
}
