#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const NORMALIZED_CATEGORIES = Object.freeze(['copy', 'tags', 'immutable']);
const COLUMN_MAP_CATEGORIES = Object.freeze([...NORMALIZED_CATEGORIES, 'unused']);
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * RFC 4180 のダブルクォート・カンマ・ CRLF を扱う CSV パーサ。
 * 引用フィールド内の改行と `""` エスケープも保持する。
 */
export function parseCsv(csvText) {
  if (typeof csvText !== 'string') {
    throw new TypeError('CSV input must be a string.');
  }

  const input = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  if (input.length === 0) return [];

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let justClosedQuote = false;

  const finishField = () => {
    row.push(field);
    field = '';
    justClosedQuote = false;
  };

  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (justClosedQuote && char !== ',' && char !== '\r' && char !== '\n') {
      throw new Error(`RFC4180 CSV parse error at character ${index + 1}: unexpected data after closing quote.`);
    }

    if (char === '"') {
      if (field.length !== 0) {
        throw new Error(`RFC4180 CSV parse error at character ${index + 1}: quote in an unquoted field.`);
      }
      inQuotes = true;
    } else if (char === ',') {
      finishField();
    } else if (char === '\r' || char === '\n') {
      finishRow();
      if (char === '\r' && input[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new Error('RFC4180 CSV parse error: unterminated quoted field.');
  }

  if (!input.endsWith('\n') && !input.endsWith('\r')) {
    finishRow();
  }

  return rows;
}

export function columnToIndex(column) {
  if (typeof column !== 'string' || !/^[A-Za-z]+$/.test(column)) {
    throw new Error(`Invalid spreadsheet column: ${String(column)}`);
  }

  let value = 0;
  for (const char of column.toUpperCase()) {
    value = value * 26 + char.charCodeAt(0) - 64;
  }
  return value - 1;
}

export function indexToColumn(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid zero-based column index: ${String(index)}`);
  }

  let value = index + 1;
  let column = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }
  return column;
}

function normalizeColumn(column) {
  const normalized = String(column).trim().toUpperCase();
  columnToIndex(normalized);
  return normalized;
}

function expandRange(range) {
  let start;
  let end;

  if (typeof range === 'string') {
    const match = range.trim().match(/^([A-Za-z]+)\s*:\s*([A-Za-z]+)$/);
    if (!match) throw new Error(`Invalid column range: ${range}`);
    [, start, end] = match;
  } else if (range && typeof range === 'object') {
    start = range.start ?? range.from;
    end = range.end ?? range.to;
  }

  if (!start || !end) throw new Error(`Invalid column range: ${JSON.stringify(range)}`);
  const startIndex = columnToIndex(normalizeColumn(start));
  const endIndex = columnToIndex(normalizeColumn(end));
  if (startIndex > endIndex) throw new Error(`Column range is reversed: ${start}:${end}`);

  return Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => indexToColumn(startIndex + offset));
}

function expandExcept(except) {
  if (except == null) return [];
  const entries = Array.isArray(except) ? except : [except];
  return entries.flatMap((entry) => expandSelector(entry));
}

export function expandSelector(selector) {
  if (typeof selector === 'string') {
    return selector.includes(':') ? expandRange(selector) : [normalizeColumn(selector)];
  }
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
    throw new Error(`Invalid column selector: ${JSON.stringify(selector)}`);
  }

  let selected;
  if (selector.column != null) {
    selected = [normalizeColumn(selector.column)];
  } else if (selector.columns != null) {
    if (!Array.isArray(selector.columns)) throw new Error('selector.columns must be an array.');
    selected = selector.columns.flatMap((entry) => expandSelector(entry));
  } else if (selector.range != null) {
    selected = expandRange(selector.range);
  } else {
    throw new Error(`Selector must contain column, columns, or range: ${JSON.stringify(selector)}`);
  }

  const excluded = new Set(expandExcept(selector.except));
  return [...new Set(selected)].filter((column) => !excluded.has(column));
}

export function expandSelectors(selectors) {
  const entries = Array.isArray(selectors) ? selectors : [selectors];
  return [...new Set(entries.flatMap((selector) => expandSelector(selector)))];
}

function categorySelectors(category) {
  if (Array.isArray(category)) return category;
  if (category && typeof category === 'object' && 'selectors' in category) return category.selectors;
  throw new Error('Each column-map category must contain selectors.');
}

function selectorHeaders(selectors) {
  const headers = new Map();
  const entries = Array.isArray(selectors) ? selectors : [selectors];
  for (const selector of entries) {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector) || !selector.headers) continue;
    for (const [column, header] of Object.entries(selector.headers)) {
      headers.set(normalizeColumn(column), String(header));
    }
  }
  return headers;
}

export function compileColumnMap(columnMap) {
  if (!columnMap || typeof columnMap !== 'object') throw new Error('column-map.json must contain an object.');
  if (!Number.isInteger(columnMap.expectedColumnCount) || columnMap.expectedColumnCount <= 0) {
    throw new Error('column-map.json expectedColumnCount must be a positive integer.');
  }
  if (!columnMap.categories || typeof columnMap.categories !== 'object' || Array.isArray(columnMap.categories)) {
    throw new Error('column-map.json categories is required.');
  }
  if (columnMap.defaultCategory !== 'unused') {
    throw new Error('column-map.json defaultCategory must be "unused".');
  }

  const categoryNames = Object.keys(columnMap.categories);
  const unknownCategories = categoryNames.filter((name) => !COLUMN_MAP_CATEGORIES.includes(name));
  const missingCategories = COLUMN_MAP_CATEGORIES.filter((name) => !categoryNames.includes(name));
  if (unknownCategories.length || missingCategories.length) {
    throw new Error(
      `column-map.json must define exactly copy/tags/immutable/unused `
      + `(missing: ${missingCategories.join(', ') || '-'}; unknown: ${unknownCategories.join(', ') || '-'}).`,
    );
  }

  const sourceRange = columnMap.sourceRange ?? columnMap.columnRange;
  let declaredRange;
  if (sourceRange != null) {
    declaredRange = expandRange(sourceRange);
    if (declaredRange.length !== columnMap.expectedColumnCount) {
      throw new Error(
        `column-map.json drift: sourceRange has ${declaredRange.length} columns, expectedColumnCount is ${columnMap.expectedColumnCount}.`,
      );
    }
  } else {
    declaredRange = Array.from(
      { length: columnMap.expectedColumnCount },
      (_, index) => indexToColumn(index),
    );
  }

  const categories = {};
  const expectedHeaders = new Map();
  const owners = new Map();
  for (const categoryName of COLUMN_MAP_CATEGORIES) {
    const category = columnMap.categories[categoryName];
    const selectors = categorySelectors(category);
    const columns = expandSelectors(selectors);
    for (const [column, header] of selectorHeaders(selectors)) {
      if (expectedHeaders.has(column) && expectedHeaders.get(column) !== header) {
        throw new Error(`column-map.json has conflicting expected headers for ${column}.`);
      }
      expectedHeaders.set(column, header);
    }
    for (const column of columns) {
      const index = columnToIndex(column);
      if (index >= columnMap.expectedColumnCount) {
        throw new Error(`column-map.json drift: ${column} is outside the expected schema.`);
      }
      if (owners.has(column)) {
        throw new Error(`column-map.json overlap: ${column} belongs to both ${owners.get(column)} and ${categoryName}.`);
      }
      owners.set(column, categoryName);
    }
    categories[categoryName] = columns;
  }

  for (const column of declaredRange) {
    if (owners.has(column)) continue;
    owners.set(column, 'unused');
    categories.unused.push(column);
  }

  return {
    expectedColumnCount: columnMap.expectedColumnCount,
    defaultCategory: columnMap.defaultCategory,
    categories,
    expectedHeaders,
  };
}

async function readJson(jsonPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON ${jsonPath}: ${error.message}`, { cause: error });
  }
  return parsed;
}

export async function loadClientReferences(clientId, { skillRoot = SKILL_ROOT } = {}) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }

  const clientDirectory = path.join(skillRoot, 'references', 'clients', clientId);
  const [config, columnMap] = await Promise.all([
    readJson(path.join(clientDirectory, 'config.json')),
    readJson(path.join(clientDirectory, 'column-map.json')),
  ]);
  if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new Error('config.json clientId is required.');
  }
  if (config.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${config.clientId}, requested client is ${clientId}.`);
  }
  return { config, columnMap, clientDirectory };
}

function assertIdentityConfig(config) {
  const identity = config?.identity;
  const required = ['jobNumberColumn', 'approvalStatusColumn', 'publicationStatusColumn'];
  for (const key of required) {
    if (!identity?.[key]) throw new Error(`config.json identity.${key} is required.`);
    normalizeColumn(identity[key]);
  }
  if (!Array.isArray(config.publishedStatusValues)) {
    throw new Error('config.json publishedStatusValues must be an array.');
  }
}

function fieldFromRow(column, headers, row, evidenceStatus) {
  const index = columnToIndex(column);
  return {
    column,
    header: headers[index],
    value: row[index],
    evidenceStatus,
  };
}

function isBlankRecord(row) {
  return row.every((value) => value === '');
}

/**
 * UIダウンロード版にだけ付く末尾の空行・空列を、Python版と同じ239列へ揃える。
 * 列の途中の差異や、期待範囲外の非空セルは吸収せずスキーマ不一致として止める。
 */
export function canonicalizeJoblistRows(rows, { columnMap } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('CSV has no header row.');
  const compiledMap = compileColumnMap(columnMap);
  const expectedColumnCount = compiledMap.expectedColumnCount;
  const canonicalRows = rows.slice();

  let ignoredTrailingEmptyRows = 0;
  while (canonicalRows.length > 1 && isBlankRecord(canonicalRows.at(-1))) {
    canonicalRows.pop();
    ignoredTrailingEmptyRows += 1;
  }

  const requiredColumns = [
    ...compiledMap.categories.copy,
    ...compiledMap.categories.tags,
    ...compiledMap.categories.immutable,
    ...compiledMap.expectedHeaders.keys(),
  ];
  const requiredColumnCount = Math.max(
    0,
    ...requiredColumns.map((column) => columnToIndex(column) + 1),
  );
  const actualHeaderColumnCount = canonicalRows[0].length;
  if (actualHeaderColumnCount < requiredColumnCount) {
    const firstMissingColumn = requiredColumns
      .map((column) => ({ column, index: columnToIndex(column) }))
      .filter(({ index }) => index >= actualHeaderColumnCount)
      .sort((left, right) => left.index - right.index)[0];
    throw new Error(
      `Joblist schema drift: header has ${actualHeaderColumnCount} columns; expected ${expectedColumnCount}. `
      + `First required missing column is ${firstMissingColumn?.column ?? indexToColumn(actualHeaderColumnCount)}.`,
    );
  }

  let ignoredTrailingEmptyColumns = 0;
  const normalizedRows = canonicalRows.map((sourceRow, recordIndex) => {
    const row = sourceRow.slice();
    if (row.length > expectedColumnCount) {
      const firstUnexpectedIndex = row.findIndex((value, index) => (
        index >= expectedColumnCount && value !== ''
      ));
      if (firstUnexpectedIndex >= 0) {
        throw new Error(
          `Joblist schema drift at CSV record ${recordIndex + 1}: `
          + `unexpected non-empty column ${indexToColumn(firstUnexpectedIndex)} `
          + `outside expected ${expectedColumnCount} columns.`,
        );
      }
      ignoredTrailingEmptyColumns = Math.max(
        ignoredTrailingEmptyColumns,
        row.length - expectedColumnCount,
      );
      row.length = expectedColumnCount;
    }
    while (row.length < expectedColumnCount) row.push('');
    return row;
  });

  return {
    rows: normalizedRows,
    diagnostics: {
      expectedColumnCount,
      actualHeaderColumnCount,
      ignoredTrailingEmptyRows,
      ignoredTrailingEmptyColumns,
      paddedTrailingEmptyColumns: Math.max(0, expectedColumnCount - actualHeaderColumnCount),
    },
  };
}

export function normalizeJoblistRows(rows, {
  clientId,
  csvPath,
  config,
  columnMap,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('CSV has no header row.');
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }
  assertIdentityConfig(config);
  if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new Error('config.json clientId is required.');
  }
  if (config.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${config.clientId}, requested client is ${clientId}.`);
  }

  const compiledMap = compileColumnMap(columnMap);
  const { rows: canonicalRows } = canonicalizeJoblistRows(rows, { columnMap });
  const headers = canonicalRows[0];
  if (headers.length !== compiledMap.expectedColumnCount) {
    throw new Error(
      `Joblist schema drift: header has ${headers.length} columns; expected ${compiledMap.expectedColumnCount}.`,
    );
  }
  for (const [column, expectedHeader] of compiledMap.expectedHeaders) {
    const actualHeader = headers[columnToIndex(column)];
    if (actualHeader !== expectedHeader) {
      throw new Error(
        `Joblist schema drift at ${column}: header is ${JSON.stringify(actualHeader)}; expected ${JSON.stringify(expectedHeader)}.`,
      );
    }
  }

  const evidenceStatus = config?.evidenceStatuses?.extracted;
  if (typeof evidenceStatus !== 'string' || evidenceStatus.length === 0) {
    throw new Error('config.json evidenceStatuses.extracted is required.');
  }

  const dataRows = [];
  for (let recordIndex = 1; recordIndex < canonicalRows.length; recordIndex += 1) {
    const row = canonicalRows[recordIndex];
    if (row.length === 1 && row[0] === '') continue;
    if (row.length !== compiledMap.expectedColumnCount) {
      throw new Error(
        `Joblist schema drift at CSV record ${recordIndex + 1}: row has ${row.length} columns; expected ${compiledMap.expectedColumnCount}.`,
      );
    }
    if (!isBlankRecord(row)) dataRows.push({ row, recordNumber: recordIndex + 1 });
  }

  const identity = config.identity;
  const publishedValues = new Set(config.publishedStatusValues.map(String));
  const jobs = dataRows.map(({ row, recordNumber }) => {
    const valueAt = (column) => row[columnToIndex(normalizeColumn(column))];
    const jobNumber = valueAt(identity.jobNumberColumn);
    const approvalStatus = valueAt(identity.approvalStatusColumn);
    const publicationStatus = valueAt(identity.publicationStatusColumn);
    const normalized = {
      jobNumber,
      approvalStatus,
      publicationStatus,
      isPublished: publishedValues.has(publicationStatus),
      source: {
        type: 'JOBLIST_CSV',
        clientId,
        rowNumber: recordNumber,
      },
    };

    for (const category of NORMALIZED_CATEGORIES) {
      normalized[category] = compiledMap.categories[category].map((column) => (
        fieldFromRow(column, headers, row, evidenceStatus)
      ));
    }
    return normalized;
  });

  return {
    version: 1,
    clientId,
    source: {
      type: 'JOBLIST_CSV',
      path: path.resolve(csvPath),
      spreadsheet: config.spreadsheet ?? null,
      expectedColumnCount: compiledMap.expectedColumnCount,
      actualColumnCount: headers.length,
      dataRowCount: jobs.length,
    },
    jobs,
  };
}

export async function normalizeJoblistCsv({
  csvPath,
  clientId,
  skillRoot = SKILL_ROOT,
} = {}) {
  if (!csvPath) throw new Error('csvPath is required.');
  if (!clientId) throw new Error('clientId is required.');
  const [{ config, columnMap }, csvText] = await Promise.all([
    loadClientReferences(clientId, { skillRoot }),
    readFile(csvPath, 'utf8'),
  ]);
  return normalizeJoblistRows(parseCsv(csvText), {
    clientId,
    csvPath,
    config,
    columnMap,
  });
}

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
    if (!['--csv', '--client', '--output'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    index += 1;
    options[argument.slice(2)] = value;
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}

export function runSelfTest() {
  const config = {
    clientId: 'foot',
    identity: {
      jobNumberColumn: 'A',
      approvalStatusColumn: 'B',
      publicationStatusColumn: 'C',
    },
    publishedStatusValues: ['02'],
    evidenceStatuses: { extracted: 'EXTRACTED_JOBLIST' },
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
  const pythonCsv = '求人番号,承認,掲載,原稿,タグ\r\n1,承認,02,"本文1\n本文2",未経験歓迎\r\n';
  const uiCsv = '\uFEFF求人番号,承認,掲載,原稿,タグ,,\r\n'
    + '1,承認,02,"本文1\n本文2",未経験歓迎,,\r\n'
    + ',,,,,,\r\n';
  const context = {
    clientId: 'foot',
    csvPath: '/tmp/self-test.csv',
    config,
    columnMap,
  };
  const pythonNormalized = normalizeJoblistRows(parseCsv(pythonCsv), context);
  const uiNormalized = normalizeJoblistRows(parseCsv(uiCsv), context);
  assert(
    JSON.stringify(uiNormalized) === JSON.stringify(pythonNormalized),
    'Python版とUI版の正規化結果が一致する',
  );
  assert(uiNormalized.jobs[0].copy[0].value === '本文1\n本文2', '引用セル内の改行を保持する');

  let rejected = false;
  try {
    normalizeJoblistRows(parseCsv('求人番号,承認,掲載,原稿\r\n1,承認,02,本文\r\n'), context);
  } catch (error) {
    rejected = /missing column is E/.test(error.message);
  }
  assert(rejected, '必要列不足を最初の列名つきで拒否する');

  return {
    ok: true,
    passedCases: 3,
    failedCases: 0,
    checks: [
      'Python版とUI版の同一正規化',
      'BOM・末尾空行・末尾空列・RFC4180改行セル',
      '必要列不足の拒否',
    ],
  };
}

function resolveTmpOutput(outputPath) {
  const resolved = path.resolve(outputPath);
  const relative = path.relative('/tmp', resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Output must be under /tmp: ${resolved}`);
  }
  return resolved;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function ensureSecureTmpDirectory(directory) {
  const resolved = path.resolve(directory);
  const relative = path.relative('/tmp', resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Output directory must be under /tmp: ${resolved}`);
  }

  const actualTmpRoot = await realpath('/tmp');
  let current = '/tmp';
  const parts = relative === '' ? [] : relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
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
  return resolved;
}

async function secureWriteTmpFile(outputPath, content) {
  const resolved = resolveTmpOutput(outputPath);
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
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved, flags, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return resolved;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node read_joblist.mjs --csv <path> --client <id> [--output /tmp/file.json]\n'
      + '       node read_joblist.mjs --self-test\n',
    );
    return;
  }
  if (options.selfTest) {
    if (options.csv || options.client || options.output) {
      throw new Error('--self-test cannot be combined with --csv, --client, or --output.');
    }
    process.stdout.write(`${JSON.stringify(runSelfTest(), null, 2)}\n`);
    return;
  }
  if (!options.csv || !options.client) {
    throw new Error('--csv and --client are required.');
  }

  const normalized = await normalizeJoblistCsv({ csvPath: options.csv, clientId: options.client });
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (options.output) {
    await secureWriteTmpFile(options.output, serialized);
  } else {
    process.stdout.write(serialized);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`read_joblist: ${error.message}\n`);
    process.exitCode = 1;
  });
}
