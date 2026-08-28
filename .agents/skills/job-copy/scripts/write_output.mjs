#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TMP_ROOT, secureReadTmpText, secureWriteTmpFile } from './secure_tmp.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LINT_RESULTS = Object.freeze(['OK', 'WARN', 'HIGH_RISK']);

export const VARIANT_TSV_HEADERS = Object.freeze([
  '求人番号',
  '職種名（現行・参照用）',
  '対象列',
  '現行値',
  'A案',
  'B案',
  'A案の根拠訴求軸ID',
  'B案の根拠訴求軸ID',
  'A案とB案の差分変数',
  '情報状態タグ',
  'lint結果',
  'lint検出理由',
  '文字数（A案）',
  '文字数（B案）',
  '上限',
  '人間の採否',
]);

export const TAG_TSV_HEADERS = Object.freeze([
  '求人番号',
  '現行タグ（カテゴリ別）',
  '削除推奨タグ＋理由',
  '追加推奨タグ＋理由',
  'リスク判定',
]);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function pick(object, keys, fallback = undefined) {
  for (const key of keys) {
    if (object && own(object, key) && object[key] != null) return object[key];
  }
  return fallback;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }
}

function scalarText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => structuredText(entry)).filter(Boolean).join('; ');
  if (typeof value === 'object') return structuredText(value);
  return String(value);
}

function structuredText(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map((entry) => structuredText(entry)).filter(Boolean).join('; ');

  let tagId = pick(value, ['tagId', 'id', 'code'], '');
  let tagName = pick(value, ['tagName', 'tagLabel', 'name', 'label', 'tag'], '');
  if (!tagId && !tagName && value.matched != null) {
    if (value.matched && typeof value.matched === 'object' && !Array.isArray(value.matched)) {
      tagId = pick(value.matched, ['tagId', 'id', 'code'], '');
      tagName = pick(value.matched, ['tagName', 'tagLabel', 'name', 'label'], '');
    } else {
      tagName = value.matched;
    }
  }
  const reason = pick(value, ['reason', 'detail', 'message', 'description'], '');
  const evidence = pick(value, ['evidenceStatus', 'status', 'informationStatus', 'risk'], '');
  const location = !tagId && value.column ? scalarText(value.column) : '';
  const head = [location, scalarText(tagId), scalarText(tagName)].filter(Boolean).join(' ');
  if (head || reason || evidence) {
    const status = evidence ? ` [${scalarText(evidence)}]` : '';
    const body = reason ? `${head || '項目'}${status}: ${scalarText(reason)}` : `${head}${status}`;
    return body.trim();
  }
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${scalarText(entry)}`)
    .join(', ');
}

function listText(value) {
  if (value == null || value === '') return '';
  return Array.isArray(value)
    ? value.map((entry) => structuredText(entry)).filter(Boolean).join('; ')
    : structuredText(value);
}

function formatTagsByCategory(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value) || typeof value !== 'object') return listText(value);
  return Object.entries(value).map(([categoryId, payload]) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const label = scalarText(payload.label ?? categoryId);
      const tags = Array.isArray(payload.tags) ? payload.tags : [];
      const renderedTags = tags.map((tag) => {
        if (!tag || typeof tag !== 'object') return scalarText(tag);
        const id = scalarText(tag.id ?? tag.tagId ?? '');
        const name = scalarText(tag.name ?? tag.tagName ?? tag.label ?? '');
        const evidence = scalarText(tag.evidenceStatus ?? '');
        return `${[id, name].filter(Boolean).join(' ')}${evidence ? ` [${evidence}]` : ''}`.trim();
      }).filter(Boolean);
      return `${label}: ${renderedTags.join(', ') || 'なし'}`;
    }
    return `${categoryId}: ${scalarText(payload)}`;
  }).join('; ');
}

function codePointLength(value) {
  return Array.from(String(value ?? '').normalize('NFKC')).length;
}

function normalizedLength(provided, text, label) {
  const actual = codePointLength(text);
  if (provided == null || provided === '') return actual;
  const number = typeof provided === 'number' ? provided : Number(provided);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
  if (number !== actual) {
    throw new Error(`${label} does not match the NFKC Unicode code-point length: ${number} != ${actual}.`);
  }
  return number;
}

function normalizeAxisIds(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map((entry) => scalarText(entry)).filter(Boolean).join(', ');
  return scalarText(value);
}

function normalizeLintResult(row) {
  let result = scalarText(pick(row, ['lintResult', 'lint_result', 'lintStatus', 'lint'], ''));
  if (row?.lint && typeof row.lint === 'object' && !Array.isArray(row.lint)) {
    result = scalarText(pick(row.lint, ['result', 'status', 'risk'], result));
  }
  if (!result) result = 'OK';
  if (!LINT_RESULTS.includes(result)) throw new Error(`Unknown lintResult: ${result}`);
  return result;
}

function normalizeLintReasons(row) {
  let reasons = pick(row, ['lintReasons', 'lintReason', 'lint_reasons', 'lintIssues'], '');
  if (row?.lint && typeof row.lint === 'object' && !Array.isArray(row.lint)) {
    reasons = pick(row.lint, ['reasons', 'reason', 'issues'], reasons);
  }
  return listText(reasons);
}

function ensureRequiredText(value, label, rowIndex) {
  const text = scalarText(value);
  if (!text) throw new Error(`${label} is required at row ${rowIndex + 1}.`);
  return text;
}

function extractRows(raw, aliases) {
  for (const key of aliases) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  throw new Error(`Input JSON must contain one of these arrays: ${aliases.join(', ')}.`);
}

export function normalizeVariants(rawInput, clientId) {
  const raw = requireObject(rawInput, 'Variants input');
  assertClientId(clientId);
  if (raw.clientId !== clientId) {
    throw new Error(`Client mismatch: input is ${raw.clientId}, requested client is ${clientId}.`);
  }
  const inputRows = extractRows(raw, ['rows', 'variants', 'appealVariants', 'items']);
  const rows = inputRows.map((inputRow, rowIndex) => {
    const row = requireObject(inputRow, `Variant row ${rowIndex + 1}`);
    const variantA = scalarText(pick(row, ['variantA', 'aVariant', 'proposalA', 'a', 'A案'], ''));
    const variantB = scalarText(pick(row, ['variantB', 'bVariant', 'proposalB', 'b', 'B案'], ''));
    return {
      jobNumber: ensureRequiredText(pick(row, ['jobNumber', 'job_number', '求人番号']), 'jobNumber', rowIndex),
      currentJobTitle: scalarText(pick(row, ['currentJobTitle', 'jobTitle', 'currentTitle', '職種名（現行・参照用）', '職種名'], '')),
      targetColumn: ensureRequiredText(pick(row, ['targetColumn', 'column', '対象列']), 'targetColumn', rowIndex),
      currentValue: scalarText(pick(row, ['currentValue', 'originalValue', '現行値'], '')),
      variantA,
      variantB,
      axisIdsA: normalizeAxisIds(pick(row, ['axisIdsA', 'appealAxisIdsA', 'groundsA', 'A案の根拠訴求軸ID'], '')),
      axisIdsB: normalizeAxisIds(pick(row, ['axisIdsB', 'appealAxisIdsB', 'groundsB', 'B案の根拠訴求軸ID'], '')),
      differenceVariable: scalarText(pick(row, ['differenceVariable', 'diffVariable', 'abDifference', 'A案とB案の差分変数'], '')),
      evidenceStatus: scalarText(pick(row, ['evidenceStatus', 'informationStatus', '情報状態タグ'], '')),
      lintResult: normalizeLintResult(row),
      lintReasons: normalizeLintReasons(row),
      lengthA: normalizedLength(pick(row, ['lengthA', 'variantALength', '文字数（A案）']), variantA, 'lengthA'),
      lengthB: normalizedLength(pick(row, ['lengthB', 'variantBLength', '文字数（B案）']), variantB, 'lengthB'),
      limit: scalarText(pick(row, ['limit', 'maxLength', '上限'], '')),
      humanDecision: '',
    };
  });
  return {
    version: 1,
    schemaVersion: raw.schemaVersion ?? raw.version ?? 1,
    clientId,
    generatedAt: scalarText(raw.generatedAt) || new Date().toISOString(),
    scope: raw.scope ?? null,
    summary: raw.summary ?? null,
    notes: raw.notes ?? raw.policyNotes ?? [],
    suppressedRows: raw.suppressedRows ?? raw.suppressed ?? [],
    rows,
  };
}

export function normalizeTagAudit(rawInput, clientId) {
  const raw = requireObject(rawInput, 'Tag-audit input');
  assertClientId(clientId);
  if (raw.clientId !== clientId) {
    throw new Error(`Client mismatch: input is ${raw.clientId}, requested client is ${clientId}.`);
  }
  const inputRows = extractRows(raw, ['rows', 'audits', 'tagAudits', 'results', 'items']);
  const rows = inputRows.map((inputRow, rowIndex) => {
    const row = requireObject(inputRow, `Tag-audit row ${rowIndex + 1}`);
    const currentTagsRaw = pick(row, ['currentTagsByCategory', 'currentTags', 'tags', '現行タグ（カテゴリ別）'], '');
    const removalsRaw = pick(row, ['removals', 'removalRecommendations', 'removeRecommendations', '削除推奨タグ＋理由'], []);
    const additionsRaw = pick(row, ['additions', 'additionRecommendations', 'addRecommendations', '追加推奨タグ＋理由'], []);
    return {
      jobNumber: ensureRequiredText(pick(row, ['jobNumber', 'job_number', '求人番号']), 'jobNumber', rowIndex),
      currentTags: formatTagsByCategory(currentTagsRaw),
      removalRecommendations: listText(removalsRaw),
      additionRecommendations: listText(additionsRaw),
      risk: scalarText(pick(row, ['risk', 'riskDecision', 'riskLevel', 'リスク判定'], 'OK')),
    };
  });
  return {
    version: 1,
    schemaVersion: raw.schemaVersion ?? raw.version ?? 1,
    clientId,
    generatedAt: scalarText(raw.generatedAt) || new Date().toISOString(),
    scope: raw.scope ?? null,
    summary: raw.summary ?? null,
    notes: raw.notes ?? [],
    duplicateCandidates: raw.duplicateCandidates ?? raw.duplicateFindings ?? [],
    rows,
  };
}

export function safeTsvCell(value) {
  return scalarText(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r\n?|\n/g, '\\n');
}

function markdownCell(value) {
  return scalarText(value)
    .replace(/\r\n?|\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

function variantCells(row) {
  return [
    row.jobNumber,
    row.currentJobTitle,
    row.targetColumn,
    row.currentValue,
    row.variantA,
    row.variantB,
    row.axisIdsA,
    row.axisIdsB,
    row.differenceVariable,
    row.evidenceStatus,
    row.lintResult,
    row.lintReasons,
    row.lengthA,
    row.lengthB,
    row.limit,
    '',
  ];
}

function tagCells(row) {
  return [
    row.jobNumber,
    row.currentTags,
    row.removalRecommendations,
    row.additionRecommendations,
    row.risk,
  ];
}

export function buildTsv(kind, rows) {
  const headers = kind === 'variants' ? VARIANT_TSV_HEADERS : TAG_TSV_HEADERS;
  const cells = kind === 'variants' ? variantCells : tagCells;
  const lines = [headers.join('\t')];
  for (const row of rows) {
    const values = cells(row);
    if (values.length !== headers.length) {
      throw new Error(`${kind} TSV row width drift: ${values.length} != ${headers.length}.`);
    }
    lines.push(values.map(safeTsvCell).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function summaryText(summary, rowCount) {
  if (summary == null || summary === '') return `出力 ${rowCount}行`;
  if (typeof summary !== 'object') return scalarText(summary);
  return Object.entries(summary).map(([key, value]) => `${key}=${scalarText(value)}`).join(' / ');
}

function scopeText(document) {
  if (document.scope != null && document.scope !== '') return scalarText(document.scope);
  const summary = document.summary;
  if (summary && typeof summary === 'object') {
    const published = summary.publishedJobCount ?? summary.publishedCount;
    const total = summary.jobCount ?? summary.totalJobCount;
    if (published != null && total != null) return `掲載中 ${published}件 / 全${total}件`;
    if (published != null && summary.rowCount != null) {
      return `掲載中 ${published}件 / 出力${summary.rowCount}行`;
    }
  }
  return `${document.clientId} / ${document.rows.length}行`;
}

function noteText(notes) {
  const rendered = listText(notes);
  return rendered || 'なし';
}

function bulletList(value, emptyText = 'なし') {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return emptyText;
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => `- ${markdownCell(structuredText(entry))}`).join('\n');
}

function replaceTemplate(template, replacements) {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{{${key}}}`).join(String(value));
  }
  const unresolved = [...rendered.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g)].map((match) => match[1]);
  if (unresolved.length) throw new Error(`Unresolved template placeholders: ${[...new Set(unresolved)].join(', ')}`);
  return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

export function renderMarkdown(kind, document, template) {
  if (kind === 'variants') {
    const variantRows = document.rows.length
      ? document.rows.map((row) => `| ${variantCells(row).map(markdownCell).join(' | ')} |`).join('\n')
      : '| — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |';
    return replaceTemplate(template, {
      generatedAt: markdownCell(document.generatedAt),
      scope: markdownCell(scopeText(document)),
      summary: markdownCell(summaryText(document.summary, document.rows.length)),
      notes: markdownCell(noteText(document.notes)),
      variantRows,
      suppressedRows: bulletList(document.suppressedRows),
    });
  }

  const auditRows = document.rows.length
    ? document.rows.map((row) => `| ${tagCells(row).map(markdownCell).join(' | ')} |`).join('\n')
    : '| — | — | — | — | — |';
  return replaceTemplate(template, {
    generatedAt: markdownCell(document.generatedAt),
    scope: markdownCell(scopeText(document)),
    summary: markdownCell(summaryText(document.summary, document.rows.length)),
    auditRows,
    duplicateFindings: bulletList(document.duplicateCandidates),
  });
}

function parseDate(dateText) {
  if (typeof dateText !== 'string' || !/^\d{8}$/.test(dateText)) {
    throw new Error(`--date must be YYYYMMDD: ${String(dateText)}`);
  }
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`--date is not a calendar date: ${dateText}`);
  }
  return dateText;
}

async function readJson(jsonPath) {
  try {
    return JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON ${jsonPath}: ${error.message}`, { cause: error });
  }
}

export async function loadWriteReferences(clientId, { skillRoot = SKILL_ROOT } = {}) {
  assertClientId(clientId);
  const clientDirectory = path.join(skillRoot, 'references', 'clients', clientId);
  const [config, variantsTemplate, tagAuditTemplate] = await Promise.all([
    readJson(path.join(clientDirectory, 'config.json')),
    readFile(path.join(skillRoot, 'assets', 'variants-template.md'), 'utf8'),
    readFile(path.join(skillRoot, 'assets', 'tag-audit-template.md'), 'utf8'),
  ]);
  if (config?.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${config?.clientId}, requested client is ${clientId}.`);
  }
  return { config, variantsTemplate, tagAuditTemplate };
}

export async function writeOutputs({
  kind,
  rawInput,
  clientId,
  date,
  outputDir = TMP_ROOT,
  variantsTemplate,
  tagAuditTemplate,
} = {}) {
  if (!['variants', 'tag-audit'].includes(kind)) throw new Error(`Unknown output kind: ${kind}`);
  parseDate(date);
  const document = kind === 'variants'
    ? normalizeVariants(rawInput, clientId)
    : normalizeTagAudit(rawInput, clientId);
  const template = kind === 'variants' ? variantsTemplate : tagAuditTemplate;
  if (typeof template !== 'string' || template.length === 0) throw new Error(`${kind} template is required.`);

  const prefix = kind === 'variants' ? 'appeal_variants' : 'tag_audit';
  const basePath = path.join(path.resolve(outputDir), `${prefix}_${date}`);
  const outputs = {
    json: `${basePath}.json`,
    tsv: `${basePath}.tsv`,
    md: `${basePath}.md`,
  };
  const json = `${JSON.stringify(document, null, 2)}\n`;
  const tsv = buildTsv(kind, document.rows);
  const markdown = renderMarkdown(kind, document, template);

  await secureWriteTmpFile(outputs.json, json);
  await secureWriteTmpFile(outputs.tsv, tsv);
  await secureWriteTmpFile(outputs.md, markdown);
  return { document, outputs };
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
    if (!['--tag-audit', '--variants', '--client', '--date', '--output-dir'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    index += 1;
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  return options;
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

function assertTsvShape(tsv, expectedColumns, expectedRows) {
  const lines = tsv.endsWith('\n') ? tsv.slice(0, -1).split('\n') : tsv.split('\n');
  assert(lines.length === expectedRows + 1, `TSV physical rows ${lines.length}`);
  for (const [index, line] of lines.entries()) {
    assert(line.split('\t').length === expectedColumns, `TSV row ${index + 1} column count`);
  }
}

export async function runSelfTest() {
  const variantsTemplate = [
    '# {{scope}}',
    '{{generatedAt}}',
    '{{summary}}',
    '{{notes}}',
    '{{variantRows}}',
    '{{suppressedRows}}',
    '',
  ].join('\n');
  const tagAuditTemplate = [
    '# {{scope}}',
    '{{generatedAt}}',
    '{{summary}}',
    '{{auditRows}}',
    '{{duplicateFindings}}',
    '',
  ].join('\n');
  const rawVariants = {
    clientId: 'foot',
    generatedAt: '2099-01-01T00:00:00.000Z',
    notes: ['改行\n保持', 'タブ\t保持'],
    rows: [{
      jobNumber: '1',
      currentJobTitle: '検査\t作業',
      targetColumn: 'BF',
      currentValue: '現行\n値',
      variantA: 'A\n案',
      variantB: 'B案',
      axisIdsA: ['V084', 'R047'],
      axisIdsB: 'V098',
      differenceVariable: '将来性 vs 即時性',
      evidenceStatus: 'CONFIRMED_INTERNAL',
      lintResult: 'OK',
      lintReasons: [],
      lengthA: 3,
      lengthB: 2,
      limit: '100（暫定）',
      humanDecision: '採用と入力されても破棄',
    }],
  };
  const rawTagAudit = {
    clientId: 'foot',
    generatedAt: '2099-01-01T00:00:00.000Z',
    rows: [{
      jobNumber: '1',
      currentTagsByCategory: {
        work: { label: '仕事内容', tags: [{ id: 'X1', name: '未経験歓迎' }] },
      },
      removals: [{ tagId: '65U83', tagName: '60代も応募可', reason: '露出の向き先を調整' }],
      additions: [{ tagName: '20代が多い相当', evidenceStatus: 'CANDIDATE', reason: '裏取り前' }],
      risk: 'WARN',
    }],
    duplicateCandidates: [],
  };

  const normalizedVariants = normalizeVariants(rawVariants, 'foot');
  const normalizedTags = normalizeTagAudit(rawTagAudit, 'foot');
  assert(normalizedVariants.rows[0].humanDecision === '', 'human decision forced blank');
  const variantTsv = buildTsv('variants', normalizedVariants.rows);
  const tagTsv = buildTsv('tag-audit', normalizedTags.rows);
  assertTsvShape(variantTsv, 16, 1);
  assertTsvShape(tagTsv, 5, 1);
  assert(variantTsv.includes('検査\\t作業'), 'tab escaped in TSV cell');
  assert(variantTsv.includes('A\\n案'), 'newline escaped in TSV cell');
  assert(variantTsv.slice(0, -1).split('\n')[1].endsWith('\t'), 'P column empty');

  const tmpDirectory = await mkdtemp(path.join(TMP_ROOT, 'job-copy-write-output-selftest-'));
  try {
    const variants = await writeOutputs({
      kind: 'variants',
      rawInput: rawVariants,
      clientId: 'foot',
      date: '20990101',
      outputDir: tmpDirectory,
      variantsTemplate,
      tagAuditTemplate,
    });
    const tags = await writeOutputs({
      kind: 'tag-audit',
      rawInput: rawTagAudit,
      clientId: 'foot',
      date: '20990101',
      outputDir: tmpDirectory,
      variantsTemplate,
      tagAuditTemplate,
    });
    for (const outputPath of [...Object.values(variants.outputs), ...Object.values(tags.outputs)]) {
      const metadata = await lstat(outputPath);
      assert((metadata.mode & 0o777) === 0o600, `${path.basename(outputPath)} mode is 0600`);
    }

    const symlinkTarget = path.join(tmpDirectory, 'symlink-target.txt');
    const targetHandle = await open(
      symlinkTarget,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await targetHandle.close();
    const symlinkPath = path.join(tmpDirectory, 'unsafe-output.json');
    await symlink(symlinkTarget, symlinkPath);
    await expectReject(() => secureWriteTmpFile(symlinkPath, '{}\n'), /symlink/);
  } finally {
    await rm(tmpDirectory, { recursive: true, force: true });
  }

  return {
    ok: true,
    checks: 17,
    variantColumns: VARIANT_TSV_HEADERS.length,
    tagColumns: TAG_TSV_HEADERS.length,
    safety: ['one physical TSV line per record', 'P column forced blank', 'O_NOFOLLOW', '0600'],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node write_output.mjs (--tag-audit <private-temp>/raw.json | --variants /tmp/raw.json) '
      + '--client <id> --date YYYYMMDD [--output-dir <private-temp>]\n'
      + '       node write_output.mjs --self-test\n',
    );
    return;
  }
  if (options.selfTest) {
    const disallowed = ['tagAudit', 'variants', 'client', 'date', 'outputDir'].some((key) => options[key]);
    if (disallowed) throw new Error('--self-test cannot be combined with other options.');
    process.stdout.write(`${JSON.stringify(await runSelfTest(), null, 2)}\n`);
    return;
  }

  const inputCount = Number(Boolean(options.tagAudit)) + Number(Boolean(options.variants));
  if (inputCount !== 1) throw new Error('Exactly one of --tag-audit or --variants is required.');
  if (!options.client || !options.date) throw new Error('--client and --date are required.');
  parseDate(options.date);
  const kind = options.variants ? 'variants' : 'tag-audit';
  const inputPath = options.variants ?? options.tagAudit;
  let rawInput;
  try {
    rawInput = JSON.parse(await secureReadTmpText(inputPath));
  } catch (error) {
    throw new Error(`Failed to read input JSON ${inputPath}: ${error.message}`, { cause: error });
  }
  const references = await loadWriteReferences(options.client);
  const result = await writeOutputs({
    kind,
    rawInput,
    clientId: options.client,
    date: options.date,
    outputDir: options.outputDir ?? TMP_ROOT,
    variantsTemplate: references.variantsTemplate,
    tagAuditTemplate: references.tagAuditTemplate,
  });
  process.stdout.write(`${JSON.stringify({
    kind,
    clientId: result.document.clientId,
    rows: result.document.rows.length,
    outputs: result.outputs,
  })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`write_output: ${error.message}\n`);
    process.exitCode = 1;
  });
}
