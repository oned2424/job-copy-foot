#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { lintNormalizedData, loadLintReferences } from './lint_copy.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_EVIDENCE = new Set(['CONFIRMED_INTERNAL', 'EXTRACTED_JOBLIST', 'PUBLIC_OFFICIAL']);
const BLOCKED_EVIDENCE = new Set(['CANDIDATE', 'MISSING', 'CONFLICT']);
// AirWorkの文章欄15個。column-map.jsonに全部そろっていることを起動時に確かめる。
// このスクリプトが文面を書くのはsubtitle/personal/welfare/selection_flowの4欄だけで、
// 残り11欄は fieldGaps として「いま何字あって目標に何字足りないか」を出す。
// 文面はAIが手順3で書く（SKILL.md）。ここで推測文を作らない。
const REQUIRED_COPY_ROLES = [
  'title', 'subtitle', 'description', 'personal',
  'salary_supplement', 'salary_example', 'working_time_supplement', 'holiday',
  'work_environment', 'probationary_period_supplement', 'welfare', 'selection_flow',
  'contract_renewal_period', 'smoking_section_supplement', 'no_social_insurance_reason',
];

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function codePointLength(value) {
  return Array.from(normalize(value)).length;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function assertSecureTmpInput(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!isInside('/tmp', resolved) || resolved === '/tmp') {
    throw new Error(`Input must be a regular file under /tmp: ${resolved}`);
  }
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Input must be a non-symlink regular file: ${resolved}`);
  }
  const actualTmp = await realpath('/tmp');
  const actual = await realpath(resolved);
  if (!isInside(actualTmp, actual)) throw new Error(`Input resolves outside /tmp: ${resolved}`);
  return resolved;
}

async function readSecureTmpJson(inputPath) {
  const resolved = await assertSecureTmpInput(inputPath);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved, flags);
  try {
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON ${resolved}: ${error.message}`, { cause: error });
  } finally {
    await handle.close();
  }
}

async function secureWriteTmpJson(outputPath, value) {
  const resolved = path.resolve(outputPath);
  if (!isInside('/tmp', resolved) || resolved === '/tmp') {
    throw new Error(`Output must be a file under /tmp: ${resolved}`);
  }
  const parent = path.dirname(resolved);
  const parentMetadata = await lstat(parent);
  if ((parent !== '/tmp' && parentMetadata.isSymbolicLink()) || (!parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink())) {
    throw new Error(`Output parent must be a non-symlink directory: ${parent}`);
  }
  const actualTmp = await realpath('/tmp');
  const actualParent = await realpath(parent);
  if (!isInside(actualTmp, actualParent)) throw new Error(`Output parent resolves outside /tmp: ${parent}`);
  try {
    const metadata = await lstat(resolved);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Output must be a non-symlink regular file: ${resolved}`);
    }
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
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return resolved;
}

function parseMarkedJson(markdown, startMarker, endMarker) {
  const start = markdown.indexOf(`<!-- ${startMarker} -->`);
  const end = markdown.indexOf(`<!-- ${endMarker} -->`);
  if (start === -1 || end === -1 || start >= end) {
    throw new Error(`${startMarker}/${endMarker} markers were not found.`);
  }
  const marked = markdown.slice(start, end);
  const first = marked.indexOf('{');
  const last = marked.lastIndexOf('}');
  if (first === -1 || last < first) throw new Error(`${startMarker} has no JSON object.`);
  return JSON.parse(marked.slice(first, last + 1));
}

function parseAxisMarkdown(markdown, prefix) {
  const rows = new Map();
  const pattern = new RegExp(`^\\|\\s*(${prefix}\\d{3})\\s*\\|`, 'u');
  let headers = null;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (/^\|\s*ID\s*\|/u.test(line)) {
      headers = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
      continue;
    }
    const match = line.match(pattern);
    if (!match) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
    if (!headers || headers.length !== cells.length) throw new Error(`Axis table header mismatch for ${match[1]}.`);
    if (rows.has(match[1])) throw new Error(`Duplicate appeal axis: ${match[1]}`);
    rows.set(match[1], {
      id: match[1],
      fields: Object.fromEntries(headers.map((header, index) => [header, cells[index]])),
      raw: line,
    });
  }
  return rows;
}

function parseColumnRoles(columnMap) {
  const roles = new Map();
  for (const [category, definition] of Object.entries(columnMap?.categories ?? {})) {
    for (const selector of definition?.selectors ?? []) {
      for (const [column, header] of Object.entries(selector?.headers ?? {})) {
        const match = String(header).match(/\(([^()]+)\)\s*$/u);
        if (!match) continue;
        if (roles.has(match[1])) throw new Error(`Duplicate semantic column role in column-map.json: ${match[1]}`);
        roles.set(match[1], { category, column: String(column).toUpperCase() });
      }
    }
  }
  for (const required of REQUIRED_COPY_ROLES) {
    if (!roles.has(required)) throw new Error(`column-map.json is missing semantic role: ${required}`);
  }
  return roles;
}

function parsePersonaStatus(markdown, relativePath) {
  const match = String(markdown).match(/^status:\s*([^\s]+)\s*$/mu);
  if (!match) throw new Error(`Persona status is missing: ${relativePath}`);
  return normalize(match[1]).toLowerCase();
}

async function loadPersonaState(rules) {
  const files = rules.personaPolicy?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('appeal-formula.md personaPolicy.files is required.');
  const entries = await Promise.all(files.map(async (relativePath) => {
    const resolved = path.resolve(path.join(SKILL_ROOT, 'references'), relativePath);
    const personasRoot = path.resolve(path.join(SKILL_ROOT, 'references', 'personas'));
    if (!isInside(personasRoot, resolved)) throw new Error(`Persona path must stay under references/personas: ${relativePath}`);
    const markdown = await readFile(resolved, 'utf8');
    return { path: relativePath, status: parsePersonaStatus(markdown, relativePath) };
  }));
  const skeletonStatus = normalize(rules.personaPolicy.skeletonStatus ?? 'skeleton').toLowerCase();
  return {
    status: entries.some((entry) => entry.status === skeletonStatus) ? skeletonStatus : 'ready',
    files: entries,
  };
}

function section(markdown, number) {
  const pattern = new RegExp(`^##\\s+${number}\\.\\s+`, 'mu');
  const match = pattern.exec(markdown);
  if (!match) throw new Error(`competitor file section ${number} was not found.`);
  const rest = markdown.slice(match.index + match[0].length);
  const next = /^##\s+\d+\.\s+/mu.exec(rest);
  return markdown.slice(match.index, next ? match.index + match[0].length + next.index : markdown.length);
}

export function parseCompetitorSections(markdown) {
  const section1 = section(markdown, 1);
  const section4 = section(markdown, 4);
  const section8 = section(markdown, 8);
  const variables = new Map();
  for (const line of section1.split(/\r?\n/)) {
    const match = line.match(/^\|\s*(\d)\s*\|/u);
    if (!match) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
    variables.set(match[1], {
      id: match[1],
      label: cells[1]?.replace(/\*\*/g, '') ?? '',
      rAxisIds: cells[3]?.match(/R\d{3}/g) ?? [],
      sAxisIds: cells[4]?.match(/S\d{3}/g) ?? [],
    });
  }
  if (variables.size !== 9) throw new Error(`competitor section 1 must contain 9 variables; found ${variables.size}.`);
  for (const required of ['正社員', '20-30代', '住居系', '0063131_']) {
    if (!section8.includes(required)) throw new Error(`competitor section 8 is missing required prohibition: ${required}`);
  }
  for (const direction of ['金額の位置', '装飾記号', '職種名', '応募障壁', '緊急性', '年齢']) {
    if (!section4.includes(direction)) throw new Error(`competitor section 4 is missing generation direction: ${direction}`);
  }
  return { variables, sectionsRead: [1, 4, 8] };
}

async function loadReferences(clientId, competitorPath) {
  if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error(`Invalid client id: ${clientId}`);
  const clientRoot = path.join(SKILL_ROOT, 'references', 'clients', clientId);
  const [configText, columnMapText, limitsText, appealMarkdown, valueMarkdown, recruitMarkdown, expressionMarkdown] = await Promise.all([
    readFile(path.join(clientRoot, 'config.json'), 'utf8'),
    readFile(path.join(clientRoot, 'column-map.json'), 'utf8'),
    readFile(path.join(clientRoot, 'limits.json'), 'utf8'),
    readFile(path.join(SKILL_ROOT, 'references', 'appeal-formula.md'), 'utf8'),
    readFile(path.join(SKILL_ROOT, 'references', 'value-axes.md'), 'utf8'),
    readFile(path.join(SKILL_ROOT, 'references', 'recruit-axes.md'), 'utf8'),
    readFile(path.join(SKILL_ROOT, 'references', 'expression-frames.md'), 'utf8'),
  ]);
  const config = JSON.parse(configText);
  const columnMap = JSON.parse(columnMapText);
  const limits = JSON.parse(limitsText);
  if (config.clientId !== clientId) throw new Error(`Client mismatch: config is ${config.clientId}, requested ${clientId}.`);
  const rules = parseMarkedJson(
    appealMarkdown,
    'JOB_COPY_APPEAL_RULES_START',
    'JOB_COPY_APPEAL_RULES_END',
  );
  const axes = {
    V: parseAxisMarkdown(valueMarkdown, 'V'),
    R: parseAxisMarkdown(recruitMarkdown, 'R'),
    S: parseAxisMarkdown(expressionMarkdown, 'S'),
  };
  for (const [prefix, count] of Object.entries(rules.axisDictionaryCounts ?? {})) {
    if (axes[prefix].size !== count) {
      throw new Error(`${prefix} axis count mismatch: expected ${count}, found ${axes[prefix].size}.`);
    }
  }
  const columnRoles = parseColumnRoles(columnMap);
  const personas = await loadPersonaState(rules);

  const resolvedCompetitorPath = competitorPath
    ? path.resolve(competitorPath)
    : path.join(clientRoot, 'competitors', '_merged.md');
  let competitor = null;
  try {
    competitor = parseCompetitorSections(await readFile(resolvedCompetitorPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (competitor) {
    for (const variable of competitor.variables.values()) {
      for (const id of [...variable.rAxisIds, ...variable.sAxisIds]) resolveAxis(id, axes);
    }
  }
  return {
    config,
    columnMap,
    columnRoles,
    limits,
    rules,
    axes,
    personas,
    competitor,
    competitorPath: resolvedCompetitorPath,
  };
}

function resolveAxis(id, axes) {
  const prefix = String(id).slice(0, 1);
  const axis = axes[prefix]?.get(String(id));
  if (!axis) throw new Error(`Appeal axis ${id} was not found in its canonical dictionary.`);
  return axis;
}

function forbiddenAxisIds(rules) {
  return new Set((rules.competitorVariables?.forbidden ?? [])
    .flatMap((entry) => entry.blockedAxisIds ?? [])
    .map(String));
}

function assertAxisSelection(axisIds, axes, rules, { allowR043 = false } = {}) {
  if (!Array.isArray(axisIds) || axisIds.length < 1 || axisIds.length > 3) {
    throw new Error('Each variant must have one primary axis and at most two secondary axes.');
  }
  for (const id of axisIds) resolveAxis(id, axes);
  for (const blocked of forbiddenAxisIds(rules)) {
    if (!axisIds.includes(blocked)) continue;
    if (blocked === 'R043' && allowR043) continue;
    throw new Error(`${blocked} is structurally prohibited.`);
  }
}

function field(job, category, column) {
  return (job?.[category] ?? []).find((item) => item?.column === column) ?? null;
}

function fieldValue(job, category, column) {
  return String(field(job, category, column)?.value ?? '');
}

function semanticField(job, category, semanticRole, columnRoles) {
  const configured = columnRoles.get(semanticRole);
  if (configured) {
    if (configured.category !== category) {
      throw new Error(`Semantic role ${semanticRole} belongs to ${configured.category}, not ${category}.`);
    }
    const item = field(job, category, configured.column);
    if (!item) throw new Error(`Job ${job?.jobNumber} is missing mapped role ${semanticRole}.`);
    return item;
  }
  const suffix = `(${semanticRole})`;
  const matches = (job?.[category] ?? []).filter((item) => String(item?.header ?? '').endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Job ${job?.jobNumber} must contain exactly one ${category} field for role ${semanticRole}; found ${matches.length}.`);
  }
  return matches[0];
}

function sourceRoleValue(job, category, semanticRole, columnRoles) {
  return String(assertSourceEvidence(semanticField(job, category, semanticRole, columnRoles)).value ?? '');
}

function allJobText(job) {
  return ['copy', 'tags', 'immutable']
    .flatMap((category) => job?.[category] ?? [])
    .filter((item) => ALLOWED_EVIDENCE.has(item?.evidenceStatus))
    .map((item) => String(item?.value ?? ''))
    .join('\n');
}

function hasApprovedText(job, pattern) {
  return ['copy', 'tags', 'immutable']
    .flatMap((category) => job?.[category] ?? [])
    .some((item) => ALLOWED_EVIDENCE.has(item?.evidenceStatus) && pattern.test(String(item?.value ?? '')));
}

function assertSourceEvidence(item) {
  const status = item?.evidenceStatus;
  if (BLOCKED_EVIDENCE.has(status)) throw new Error(`Blocked evidence status cannot generate copy: ${status}`);
  if (!ALLOWED_EVIDENCE.has(status)) throw new Error(`Unknown or unapproved evidence status: ${String(status)}`);
  return item;
}

function recordFields(record) {
  if (Array.isArray(record?.fields)) {
    return new Map(record.fields.map((item) => [item?.key, item]));
  }
  if (record?.fields && typeof record.fields === 'object') {
    return new Map(Object.entries(record.fields).map(([key, value]) => [
      key,
      value && typeof value === 'object' ? { key, ...value } : { key, value },
    ]));
  }
  return new Map();
}

function contractIdentityValues(contract) {
  return [
    contract?.contractId,
    contract?.id,
    contract?.source?.contractId,
    contract?.source?.id,
    contract?.source?.sheetId,
    contract?.source?.spreadsheetId,
    contract?.source?.spreadsheet?.id,
  ].filter((value) => value != null && String(value).length > 0).map(String);
}

function bindingIdentity(binding) {
  if (typeof binding === 'string' || typeof binding === 'number') return String(binding);
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const value = binding.contractId ?? binding.id ?? binding.contractKey ?? binding.key;
  return value == null || String(value).length === 0 ? null : String(value);
}

function boundContractForJob(contract, jobNumber, config) {
  if (!contract || !Array.isArray(contract.fields)) return null;
  const binding = config?.contract?.jobBindings?.[String(jobNumber)];
  const expectedIdentity = bindingIdentity(binding);
  if (!expectedIdentity || !contractIdentityValues(contract).includes(expectedIdentity)) return null;
  return contract;
}

export function confirmedR043Evidence(contract, jobNumber, config, rules) {
  const record = boundContractForJob(contract, jobNumber, config);
  if (!record) return null;
  const fields = recordFields(record);
  const requiredEvidence = rules?.axisMapping?.V101?.requiredEvidence;
  const requiredKeys = requiredEvidence?.fields ?? [];
  if (requiredKeys.length !== 3) throw new Error('V101.requiredEvidence.fields must contain three row-27 keys.');
  const yes = fields.get(requiredKeys[0]) ?? fields.get('employeeConversionAvailability');
  const period = fields.get(requiredKeys[1]);
  const income = fields.get(requiredKeys[2]) ?? fields.get('directEmploymentAnnualIncomeRange');
  const allowedStatuses = new Set(requiredEvidence.allowedStatuses ?? []);
  const confirmed = (item) => allowedStatuses.has(item?.evidenceStatus) && normalize(item.value).length > 0;
  const requiredRow = Number(requiredEvidence.row);
  const isRequiredRow = (item) => Number(item?.sourceRow) === requiredRow;
  const yesPatterns = requiredEvidence.allowedYesPatterns;
  if (!Array.isArray(yesPatterns) || yesPatterns.length === 0) {
    throw new Error('V101.requiredEvidence.allowedYesPatterns is required.');
  }
  const hasYes = yesPatterns.some((source) => new RegExp(source, 'u').test(normalize(yes?.value)));
  if (!confirmed(yes) || !hasYes) return null;
  if (![yes, period, income].every(isRequiredRow)) return null;
  if (!confirmed(period) || !confirmed(income)) return null;
  return {
    sourceRow: requiredRow,
    availability: normalize(yes.value),
    period: normalize(period.value),
    annualIncomeRange: normalize(income.value),
    evidenceStatus: 'CONFIRMED_INTERNAL',
  };
}

function stripDecoration(value) {
  return normalize(value)
    .replace(/[\u2605\u2606\u266a\u2669\u2728]/gu, '')
    .replace(/[＼／]/gu, '')
    .replace(/\\?\([^\n]{0,16}ω[^\n]{0,16}\)\/?/gu, '')
    .replace(/[!！]{2,}/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function hasForbiddenText(value, rules) {
  const text = normalize(value);
  const matches = [];
  for (const configured of rules.forbiddenOutputPatterns ?? []) {
    const regex = new RegExp(configured.source, configured.flags ?? 'u');
    const match = regex.exec(text);
    if (match) matches.push({ id: configured.id, matched: match[0], risk: configured.risk ?? 'HIGH_RISK' });
  }
  return matches;
}

function demotedLead(value, rules) {
  const firstLine = normalize(value).split('\n')[0];
  return (rules.demotedLeadPatterns ?? []).filter((configured) => (
    new RegExp(configured.source, configured.flags ?? 'u').test(firstLine)
  ));
}

function formattedYen(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits ? Number(digits).toLocaleString('ja-JP') : '';
}

function salaryLead(job, columnRoles) {
  const copy = [
    sourceRoleValue(job, 'copy', 'subtitle', columnRoles),
    sourceRoleValue(job, 'copy', 'salary_supplement', columnRoles),
    sourceRoleValue(job, 'copy', 'salary_example', columnRoles),
  ].join('\n');
  const lower = sourceRoleValue(job, 'immutable', 'minimum_salary', columnRoles);
  const lowerYen = formattedYen(lower);
  if (!lowerYen) throw new Error(`Job ${job.jobNumber} has no confirmed salary lower bound.`);
  const afterThird = copy.match(/3\s*(?:か|カ|ヶ)月目以降[^0-9]{0,12}時給\s*([0-9,]+)\s*円/u);
  if (afterThird) {
    const later = formattedYen(afterThird[1]);
    if (/期間限定/u.test(copy)) return `期間限定時給${lowerYen}円（3か月目以降は時給${later}円）`;
    return `1・2か月目は時給${lowerYen}円（3か月目以降は時給${later}円）`;
  }
  return `時給${lowerYen}円`;
}

function oralJobLabel(job, columnRoles) {
  const title = sourceRoleValue(job, 'copy', 'title', columnRoles);
  const description = sourceRoleValue(job, 'copy', 'description', columnRoles);
  const text = normalize(`${title}\n${description}`);
  if (/4\s*[tｔＴ].*中子|中子.*4\s*[tｔＴ]/iu.test(text)) return '4tトラックで中子を運ぶ仕事';
  if (/4\s*[tｔＴ].*電源箱|電源箱.*4\s*[tｔＴ]/iu.test(text)) return '4tトラックで電源箱を運ぶ仕事';
  if (/大型トラック/u.test(text) && /定期|決まった工場/u.test(text)) return '大型トラックの定期配送';
  if (/電子部品/u.test(text) && /組付|検査/u.test(text)) return '電子部品の取付け・目視チェック';
  if (/サンルーフ/u.test(text) && /目視検査/u.test(text)) return 'サンルーフ部品の目視チェック';
  if (/手のひらサイズ/u.test(text) && /目視検査|品質チェック/u.test(text)) return '手のひらサイズ部品の目視チェック・選別';
  if (/メンテナンス補助|部品交換/u.test(text)) return '機械設備の部品交換サポート';
  return stripDecoration(title)
    .replace(/スタッフ募集/gu, '仕事')
    .replace(/目視検査/gu, '目で見てチェック')
    .replace(/輸送/gu, '運ぶ仕事')
    .replace(/ドライバー/gu, '配送');
}

function workQualityLabel(job, columnRoles) {
  const description = sourceRoleValue(job, 'copy', 'description', columnRoles);
  const text = normalize(description);
  if (/手積み・手降ろしはありません|手積み・手降ろしなし/u.test(text)) {
    return `手積み・手降ろしなしの${oralJobLabel(job, columnRoles)}`;
  }
  if (/手のひらサイズ/u.test(text) && /目視|検査|チェック/u.test(text)) {
    return '手のひらサイズ部品を目で見てチェック';
  }
  if (/軽量部品/u.test(text) && /専用の作業テーブル/u.test(text)) {
    return '軽量部品を専用テーブルで目視チェック';
  }
  if (/部品交換/u.test(text) && /チーム/u.test(text)) {
    return '機械設備の部品交換をチームでサポート';
  }
  if (/(?:フォーク)?リフト/u.test(text) && /積み(?:降ろし|下ろし|込み|下ろし)/u.test(text)) {
    return `フォークリフトで積み降ろす${oralJobLabel(job, columnRoles)}`;
  }
  if (/定期配送|決まった工場/u.test(text)) return '決まった工場への定期配送';
  return oralJobLabel(job, columnRoles);
}

function safeRequirementLines(job, rules, columnRoles) {
  const current = sourceRoleValue(job, 'copy', 'personal', columnRoles);
  const lines = normalize(current).split('\n')
    .map((line) => stripDecoration(line).replace(/^[・◎◆▽■●〇○→\s]+/u, '').trim())
    .filter(Boolean)
    .filter((line) => line !== '応募資格' && !/[、,]$/u.test(line))
    .filter((line) => /免許|資格|技能講習|必須|未経験|経験不問|学歴|ブランク|製造や検査の経験/u.test(line))
    .filter((line) => hasForbiddenText(line, rules).length === 0);
  return [...new Set(lines)].slice(0, 4);
}

function buildBfVariants(job, columnRoles) {
  const salary = salaryLead(job, columnRoles);
  const role = oralJobLabel(job, columnRoles);
  const resumeFreeConfirmed = hasApprovedText(job, /履歴書不要/u);
  return {
    variantA: `${salary}／${workQualityLabel(job, columnRoles)}`,
    variantB: resumeFreeConfirmed
      ? `${salary}／履歴書不要で応募できる${role}`
      : `${salary}／${role}の流れを一つずつ覚える`,
    axisIdsA: ['R099', 'R047', 'R001'],
    axisIdsB: resumeFreeConfirmed ? ['R122', 'R047', 'R001'] : ['V098', 'R047', 'R001'],
    differenceVariable: resumeFreeConfirmed ? '作業の質 vs 応募障壁' : '作業の質 vs 学習',
    competitorVariablesA: ['1', '2', '8'],
    competitorVariablesB: resumeFreeConfirmed ? ['1', '2', '4'] : ['1', '2'],
  };
}

function buildFallbackBfVariants(job, columnRoles) {
  const salary = salaryLead(job, columnRoles);
  const role = oralJobLabel(job, columnRoles);
  return {
    variantA: `${salary}／${role}に挑戦`,
    variantB: `${salary}／${role}の流れを一つずつ覚える`,
    axisIdsA: ['V084', 'R001', 'R047'],
    axisIdsB: ['V098', 'R001', 'R047'],
    differenceVariable: '挑戦・前進 vs 学習',
    competitorVariablesA: [],
    competitorVariablesB: [],
  };
}

function buildAxVariants(job, rules, columnRoles, r043Evidence = null) {
  const source = sourceRoleValue(job, 'copy', 'personal', columnRoles);
  const requirements = safeRequirementLines(job, rules, columnRoles);
  const hasQualification = /免許|資格|技能講習/u.test(source);
  const hasUnexperienced = /未経験|経験\s*不問/u.test(source);
  const leadA = hasQualification
    ? 'お持ちの資格を活かし、次の仕事に挑戦したい方'
    : '新しい仕事に挑戦し、できることを増やしたい方';
  const defaultLeadB = hasUnexperienced
    ? '未経験から、仕事内容と作業の流れを一つずつ覚えたい方'
    : '仕事内容と作業の流れを一つずつ着実に覚えたい方';
  const common = requirements.length
    ? `\n\n【応募条件・歓迎要件】\n${requirements.map((line) => `・${line}`).join('\n')}`
    : '';
  if (r043Evidence) {
    const leadB = `登用制度を活用し、${r043Evidence.period}を目安に次の働き方を目指したい方`;
    const confirmedDetails = `\n\n【登用後の待遇目安】\n・年収レンジ: ${r043Evidence.annualIncomeRange}`;
    return {
      variantA: `${leadA}${common}`,
      variantB: `${leadB}${common}${confirmedDetails}`,
      axisIdsA: ['V084', 'R047'],
      axisIdsB: ['V101', 'R043'],
      differenceVariable: '挑戦・前進 vs 登用制度',
      competitorVariablesA: [],
      competitorVariablesB: [],
      confirmedEvidenceB: r043Evidence,
    };
  }
  return {
    variantA: `${leadA}${common}`,
    variantB: `${defaultLeadB}${common}`,
    axisIdsA: ['V084', 'R047'],
    axisIdsB: ['V098', 'R047'],
    differenceVariable: '挑戦・前進 vs 学習',
    competitorVariablesA: [],
    competitorVariablesB: [],
  };
}

function commonCurrentValue(jobs, column, fallback) {
  const values = [...new Set(jobs.map((job) => fieldValue(job, 'copy', column)))];
  return values.length === 1 ? values[0] : fallback;
}

function requireCommonEvidence(jobs, predicate, label) {
  const missing = jobs.filter((job) => !predicate(job)).map((job) => String(job.jobNumber));
  if (missing.length > 0) throw new Error(`Common variant evidence '${label}' is missing for jobs: ${missing.join(', ')}`);
}

function buildCommonRows(jobs, { competitorAvailable = true, columnRoles } = {}) {
  const first = jobs[0];
  const welfareColumn = semanticField(first, 'copy', 'welfare', columnRoles).column;
  const selectionColumn = semanticField(first, 'copy', 'selection_flow', columnRoles).column;
  for (const job of jobs) {
    if (semanticField(job, 'copy', 'welfare', columnRoles).column !== welfareColumn) {
      throw new Error(`Welfare column mapping differs for job ${job.jobNumber}.`);
    }
    if (semanticField(job, 'copy', 'selection_flow', columnRoles).column !== selectionColumn) {
      throw new Error(`Selection-flow column mapping differs for job ${job.jobNumber}.`);
    }
  }
  requireCommonEvidence(jobs, (job) => {
    const value = sourceRoleValue(job, 'copy', 'welfare', columnRoles);
    return /日払い/u.test(value) && /週払い/u.test(value);
  }, '日払い・週払い');
  requireCommonEvidence(
    jobs,
    (job) => /昇給実績/u.test(sourceRoleValue(job, 'copy', 'welfare', columnRoles)),
    '昇給実績',
  );
  requireCommonEvidence(jobs, (job) => hasApprovedText(job, /職場見学/u), '職場見学');
  requireCommonEvidence(jobs, (job) => hasApprovedText(job, /履歴書不要/u), '履歴書不要');
  return [
    {
      jobNumber: `共通（掲載中${jobs.length}件）`,
      currentJobTitle: '掲載中求人の共通版',
      targetColumn: welfareColumn,
      currentValue: commonCurrentValue(
        jobs,
        welfareColumn,
        `掲載中${jobs.length}件の現行ESで共通確認：日払い・週払い可能／昇給実績あり`,
      ),
      variantA: '日払い・週払い可能。適用条件は規定に従います。',
      variantB: '昇給実績があります。詳細条件は応募時に確認できます。',
      axisIdsA: ['V023', 'S063'],
      axisIdsB: ['R004', 'S001'],
      differenceVariable: '収入時期 vs 評価実績',
      competitorVariablesA: [],
      competitorVariablesB: [],
      sourceJob: jobs[0],
    },
    {
      jobNumber: `共通（掲載中${jobs.length}件）`,
      currentJobTitle: '掲載中求人の共通版',
      targetColumn: selectionColumn,
      currentValue: commonCurrentValue(jobs, selectionColumn, '掲載中求人の現行HVは求人別差異あり'),
      variantA: '応募後に職場見学を行い、仕事内容や雰囲気を確認してから就業を判断できます。',
      variantB: '履歴書不要。応募後に仕事内容の説明を受け、職場見学の日程を決めます。',
      axisIdsA: ['R125', 'S039'],
      axisIdsB: ['R122', 'S035'],
      differenceVariable: '職場見学での判断 vs 応募手間',
      competitorVariablesA: [],
      competitorVariablesB: competitorAvailable ? ['4'] : [],
      sourceJob: jobs[0],
    },
  ];
}

function canonicalFactToken(value) {
  return normalize(value).replace(/[\s,，]/gu, '').toLocaleLowerCase('ja-JP');
}

function protectedFactTokens(text, rules) {
  const tokens = [];
  for (const category of rules.factPatterns?.categories ?? []) {
    for (const pattern of category.patterns ?? []) {
      const flags = pattern.flags?.includes('g') ? pattern.flags : `${pattern.flags ?? 'u'}g`;
      const regex = new RegExp(pattern.source, flags);
      for (const match of String(text).matchAll(regex)) {
        tokens.push({ category: category.id, raw: match[0], canonical: canonicalFactToken(match[0]) });
      }
    }
  }
  return tokens;
}

function sourceFactTokens(job, rules, columnRoles, additionalConfirmedText = '') {
  const text = `${allJobText(job)}\n${additionalConfirmedText}`;
  const tokens = protectedFactTokens(text, rules);
  const salaryType = sourceRoleValue(job, 'immutable', 'salary_form_jp', columnRoles);
  for (const role of ['minimum_salary', 'maximum_salary']) {
    const amount = sourceRoleValue(job, 'immutable', role, columnRoles);
    if (salaryType && amount) {
      const raw = `${salaryType}${amount}円`;
      tokens.push({ category: 'salary', raw, canonical: canonicalFactToken(raw) });
    }
  }
  return tokens;
}

function factIntegrityIssues(proposal, job, rules, columnRoles, additionalConfirmedText = '') {
  const sourceTokens = sourceFactTokens(job, rules, columnRoles, additionalConfirmedText);
  const sourceSet = new Set(sourceTokens.map((token) => token.canonical));
  return protectedFactTokens(proposal, rules)
    .filter((token) => !sourceSet.has(token.canonical))
    .map((token) => ({
      id: 'FACT_CHANGED_OR_ADDED',
      risk: 'HIGH_RISK',
      matched: token.raw,
      reason: `${token.category}の事実トークンが現行の確認済み入力に存在しません`,
    }));
}

function monthlyConversionIssues(proposal, hasConfirmedBasis = false) {
  if (hasConfirmedBasis) return [];
  const match = normalize(proposal).match(/(?:月収|月\s*[0-9,]+\s*万|年収)\s*[0-9,]*/u);
  return match ? [{
    id: 'MONTHLY_CONVERSION_WITHOUT_BASIS',
    risk: 'HIGH_RISK',
    matched: match[0],
    reason: '内容確認書33・39〜43・45行の換算根拠がないため月額・年額換算を生成できません',
  }] : [];
}

function lintProposal({
  proposal,
  targetColumn,
  job,
  clientId,
  rules,
  columnRoles,
  lintReferences,
  additionalConfirmedText = '',
  hasConfirmedMoneyBasis = false,
}) {
  const customIssues = [
    ...hasForbiddenText(proposal, rules).map((issue) => ({
      ...issue,
      reason: `生成禁止表現を検出: ${issue.id}`,
    })),
    ...factIntegrityIssues(proposal, job, rules, columnRoles, additionalConfirmedText),
    ...monthlyConversionIssues(proposal, hasConfirmedMoneyBasis),
    ...demotedLead(proposal, rules).map((issue) => ({
      id: `DEMOTED_LEAD_${issue.id}`,
      risk: 'HIGH_RISK',
      matched: normalize(proposal).split('\n')[0],
      reason: '20-30代向けの主訴求から降ろす表現が冒頭にあります',
    })),
  ];
  const synthetic = {
    version: 1,
    clientId,
    source: { type: 'GENERATED_VARIANT' },
    jobs: [{
      jobNumber: String(job.jobNumber ?? 'COMMON'),
      approvalStatus: job.approvalStatus ?? '',
      publicationStatus: job.publicationStatus ?? '',
      isPublished: true,
      source: { type: 'GENERATED_VARIANT', rowNumber: job.source?.rowNumber ?? 2 },
      evidence: [],
      copy: [{
        column: targetColumn,
        header: field(job, 'copy', targetColumn)?.header ?? targetColumn,
        value: proposal,
        evidenceStatus: 'EXTRACTED_JOBLIST',
      }],
      tags: job.tags ?? [],
      immutable: job.immutable ?? [],
    }],
  };
  const lint = lintNormalizedData(synthetic, { clientId, ...lintReferences });
  const lintIssues = lint.issues.map((issue) => ({
    id: issue.ruleId,
    risk: issue.risk,
    matched: issue.matched,
    reason: issue.detail,
  }));
  const issues = [...customIssues, ...lintIssues];
  return {
    issues,
    risk: issues.some((issue) => issue.risk === 'HIGH_RISK')
      ? 'HIGH_RISK'
      : issues.length > 0 ? 'WARN' : 'OK',
  };
}

function competitorVariableSets(rules) {
  const allowed = new Set();
  for (const item of rules.competitorVariables?.allowed ?? []) {
    const id = String(item.id);
    allowed.add(id === '9' ? '9_transport' : id);
  }
  const blocked = new Set((rules.competitorVariables?.forbidden ?? []).map((item) => String(item.id)));
  return { allowed, blocked };
}

function assertCompetitorVariables(variableIds, rules) {
  const { allowed, blocked } = competitorVariableSets(rules);
  for (const raw of variableIds) {
    const id = String(raw);
    if (blocked.has(id)) throw new Error(`Competitor variable ${id} is prohibited.`);
    if (!allowed.has(id)) throw new Error(`Unknown competitor variable: ${id}`);
  }
}

function assertCompetitorAxisMapping(variableIds, axisIds, competitor) {
  if (!competitor) {
    if (variableIds.length > 0) throw new Error('Competitor variables cannot be used when the competitor file is unavailable.');
    return;
  }
  for (const raw of variableIds) {
    const normalizedId = String(raw);
    const sourceId = normalizedId === '9_transport' ? '9' : normalizedId;
    const variable = competitor.variables.get(sourceId);
    if (!variable) throw new Error(`Competitor variable ${sourceId} was not found in section 1.`);
    const mapped = new Set([...variable.rAxisIds, ...variable.sAxisIds]);
    if (!axisIds.some((id) => mapped.has(id))) {
      throw new Error(`Variant claims competitor variable ${normalizedId} without a mapped axis ID.`);
    }
  }
}

// 15欄の充填状況だけを返す。値の生成は一切しない。
// semanticField と違い、欄が無くても例外にせず missing として記録する
// （Joblistの列構成が変わっても停止させないため）。
function inspectRole(job, role, columnRoles, limits) {
  const configured = columnRoles.get(role);
  if (!configured) return { state: 'unmapped', length: 0, column: null, limit: null };
  const item = field(job, configured.category, configured.column);
  const base = { column: configured.column, limit: limits?.columns?.[configured.column]?.max ?? null };
  if (!item) return { ...base, state: 'missing_column', length: 0 };
  if (BLOCKED_EVIDENCE.has(item.evidenceStatus)) {
    return { ...base, state: 'blocked_evidence', length: 0, evidenceStatus: item.evidenceStatus };
  }
  return { ...base, state: 'present', length: codePointLength(item.value) };
}

function buildFieldGaps(jobs, { rules, columnRoles, limits }) {
  const targets = rules?.fieldTargets?.roles;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('appeal-formula.md fieldTargets.roles is required.');
  }
  for (const role of REQUIRED_COPY_ROLES) {
    if (!targets.some((target) => target.role === role)) {
      throw new Error(`appeal-formula.md fieldTargets.roles is missing: ${role}`);
    }
  }
  return jobs.map((job) => ({
    jobNumber: String(job.jobNumber),
    fields: targets.map((target) => {
      const found = inspectRole(job, target.role, columnRoles, limits);
      const targetMin = Number.isInteger(target.targetMin) ? target.targetMin : 0;
      const shortfall = found.state === 'present' ? Math.max(0, targetMin - found.length) : targetMin;
      return {
        itemNo: target.itemNo,
        label: target.label,
        role: target.role,
        owner: target.owner,
        column: found.column,
        state: found.state,
        length: found.length,
        targetMin,
        limit: found.limit,
        shortfall,
        // 目標に届いていない欄は、推測で埋めずに手順0のヒアリングへ回す
        askInHearing: target.askIfEmpty === true && shortfall > 0,
      };
    }),
  }));
}

function limitFor(column, limits) {
  const configured = limits?.columns?.[column];
  if (!configured || !Number.isInteger(configured.max)) throw new Error(`No configured limit for ${column}.`);
  return `${configured.max}${configured.status === 'provisional' ? '（暫定）' : ''}`;
}

function informationStatus({ competitorAvailable, personaStatus, confirmedEvidence = null }) {
  const notes = ['EXTRACTED_JOBLIST'];
  notes.push(personaStatus === 'skeleton'
    ? 'ペルソナ未確定のためデフォルト軸で生成'
    : `ペルソナ状態: ${personaStatus}`);
  notes.push(competitorAvailable
    ? '競合パターン セクション1・4・8読了'
    : '競合パターン未読のため訴求軸辞書のみで生成');
  notes.push(confirmedEvidence
    ? `CONFIRMED_INTERNAL: 内容確認書行27（期間=${confirmedEvidence.period}／年収レンジ=${confirmedEvidence.annualIncomeRange}）`
    : 'MISSING: 内容確認書行27の求人別紐付け・確定値なし');
  notes.push('月額換算なし');
  return notes.join(' | ');
}

function axisReference(id, axes) {
  const axis = resolveAxis(id, axes);
  const fields = axis.fields ?? {};
  const name = fields['訴求軸'] ?? fields['求人訴求軸'] ?? fields['手法・軸'];
  const definition = fields['定義'];
  const direction = fields['求人への翻訳例'] ?? fields['タイトル・本文の方向'] ?? fields['求人での例'];
  if (!name || !definition || !direction) throw new Error(`Axis dictionary entry ${id} lacks name, definition, or job direction.`);
  return { id, name, definition, direction };
}

function finalizeRow(base, context) {
  assertAxisSelection(base.axisIdsA, context.axes, context.rules, { allowR043: Boolean(base.confirmedEvidenceA) });
  assertAxisSelection(base.axisIdsB, context.axes, context.rules, { allowR043: Boolean(base.confirmedEvidenceB) });
  assertCompetitorVariables(
    [...(base.competitorVariablesA ?? []), ...(base.competitorVariablesB ?? [])],
    context.rules,
  );
  assertCompetitorAxisMapping(base.competitorVariablesA ?? [], base.axisIdsA, context.competitor);
  assertCompetitorAxisMapping(base.competitorVariablesB ?? [], base.axisIdsB, context.competitor);
  if (base.axisIdsA[0] === base.axisIdsB[0]) {
    throw new Error(`A/B primary axes must differ: ${base.axisIdsA[0]}`);
  }
  const differenceParts = normalize(base.differenceVariable).split(/\s+vs\s+/u);
  if (
    differenceParts.length !== 2
    || differenceParts.some((part) => part.length === 0)
    || /[,、;；]/u.test(base.differenceVariable)
  ) {
    throw new Error(`A/B difference must be exactly one named variable: ${base.differenceVariable}`);
  }
  const resultA = lintProposal({
    proposal: base.variantA,
    targetColumn: base.targetColumn,
    job: base.sourceJob,
    clientId: context.clientId,
    rules: context.rules,
    columnRoles: context.columnRoles,
    lintReferences: context.lintReferences,
    additionalConfirmedText: base.confirmedEvidenceA ? JSON.stringify(base.confirmedEvidenceA) : '',
    hasConfirmedMoneyBasis: Boolean(base.confirmedEvidenceA),
  });
  const resultB = lintProposal({
    proposal: base.variantB,
    targetColumn: base.targetColumn,
    job: base.sourceJob,
    clientId: context.clientId,
    rules: context.rules,
    columnRoles: context.columnRoles,
    lintReferences: context.lintReferences,
    additionalConfirmedText: base.confirmedEvidenceB ? JSON.stringify(base.confirmedEvidenceB) : '',
    hasConfirmedMoneyBasis: Boolean(base.confirmedEvidenceB),
  });
  const suppressA = resultA.risk === 'HIGH_RISK';
  const suppressB = resultB.risk === 'HIGH_RISK';
  const combinedIssues = [
    ...resultA.issues.map((issue) => `A:${issue.id} ${issue.reason}`),
    ...resultB.issues.map((issue) => `B:${issue.id} ${issue.reason}`),
  ];
  const lintResult = suppressA || suppressB
    ? 'HIGH_RISK'
    : (resultA.risk === 'WARN' || resultB.risk === 'WARN' ? 'WARN' : 'OK');
  return {
    jobNumber: base.jobNumber,
    currentJobTitle: base.currentJobTitle,
    targetColumn: base.targetColumn,
    currentValue: base.currentValue,
    variantA: suppressA ? '' : base.variantA,
    variantB: suppressB ? '' : base.variantB,
    axisIdsA: base.axisIdsA,
    axisIdsB: base.axisIdsB,
    differenceVariable: base.differenceVariable,
    evidenceStatus: informationStatus({
      competitorAvailable: context.competitorAvailable,
      personaStatus: context.personaStatus,
      confirmedEvidence: base.confirmedEvidenceA ?? base.confirmedEvidenceB ?? null,
    }),
    lintResult,
    lintReasons: combinedIssues.length ? combinedIssues : ['検出なし'],
    lengthA: suppressA ? 0 : codePointLength(base.variantA),
    lengthB: suppressB ? 0 : codePointLength(base.variantB),
    limit: limitFor(base.targetColumn, context.limits),
    humanDecision: '',
    primaryAxisA: base.axisIdsA[0],
    primaryAxisB: base.axisIdsB[0],
    axisReferencesA: base.axisIdsA.map((id) => axisReference(id, context.axes)),
    axisReferencesB: base.axisIdsB.map((id) => axisReference(id, context.axes)),
    competitorVariablesA: base.competitorVariablesA ?? [],
    competitorVariablesB: base.competitorVariablesB ?? [],
    suppressed: { A: suppressA, B: suppressB },
  };
}

export async function generateVariants(normalized, {
  contract = null,
  clientId,
  references,
  lintReferences,
} = {}) {
  if (!normalized || !Array.isArray(normalized.jobs)) throw new Error('Normalized input must contain jobs[].');
  if (normalized.clientId !== clientId || references.config.clientId !== clientId) {
    throw new Error('Client id mismatch among input, config, and CLI.');
  }
  if (contract && contract.clientId !== clientId) throw new Error('Contract client id mismatch.');
  const published = normalized.jobs.filter((job) => job.isPublished === true);
  if (published.length === 0) throw new Error('No published jobs were found.');
  const context = {
    clientId,
    rules: references.rules,
    axes: references.axes,
    columnRoles: references.columnRoles,
    limits: references.limits,
    lintReferences,
    competitorAvailable: references.competitor !== null,
    competitor: references.competitor,
    personaStatus: references.personas.status,
  };
  const rawRows = [];
  for (const job of published) {
    const currentJobTitle = sourceRoleValue(job, 'copy', 'title', references.columnRoles);
    const bfColumn = semanticField(job, 'copy', 'subtitle', references.columnRoles).column;
    const axColumn = semanticField(job, 'copy', 'personal', references.columnRoles).column;
    const bf = references.competitor
      ? buildBfVariants(job, references.columnRoles)
      : buildFallbackBfVariants(job, references.columnRoles);
    rawRows.push({
      jobNumber: String(job.jobNumber),
      currentJobTitle,
      targetColumn: bfColumn,
      currentValue: sourceRoleValue(job, 'copy', 'subtitle', references.columnRoles),
      sourceJob: job,
      ...bf,
    });
    const r043Evidence = confirmedR043Evidence(contract, job.jobNumber, references.config, references.rules);
    const ax = buildAxVariants(job, references.rules, references.columnRoles, r043Evidence);
    rawRows.push({
      jobNumber: String(job.jobNumber),
      currentJobTitle,
      targetColumn: axColumn,
      currentValue: sourceRoleValue(job, 'copy', 'personal', references.columnRoles),
      sourceJob: job,
      ...ax,
    });
  }
  rawRows.push(...buildCommonRows(published, {
    competitorAvailable: references.competitor !== null,
    columnRoles: references.columnRoles,
  }));
  const rows = rawRows.map((row) => finalizeRow(row, context));
  const r043EligibleJobs = published
    .filter((job) => confirmedR043Evidence(contract, job.jobNumber, references.config, references.rules) !== null)
    .map((job) => String(job.jobNumber));
  const suppressed = rows.flatMap((row) => [
    ...(row.suppressed.A ? [{ jobNumber: row.jobNumber, column: row.targetColumn, variant: 'A' }] : []),
    ...(row.suppressed.B ? [{ jobNumber: row.jobNumber, column: row.targetColumn, variant: 'B' }] : []),
  ]);
  return {
    version: 1,
    clientId,
    generatedAt: new Date().toISOString(),
    source: normalized.source ?? null,
    summary: {
      publishedJobCount: published.length,
      rowCount: rows.length,
      expectedRowCount: published.length * 2 + 2,
      suppressedCount: suppressed.length,
      lint: rows.reduce((counts, row) => {
        counts[row.lintResult] = (counts[row.lintResult] ?? 0) + 1;
        return counts;
      }, {}),
      axisDictionaryCounts: Object.fromEntries(Object.entries(references.axes).map(([key, value]) => [key, value.size])),
      competitorAvailable: references.competitor !== null,
      competitorSectionsRead: references.competitor?.sectionsRead ?? [],
      personaStatus: references.personas.status,
      personaFiles: references.personas.files,
      contractBoundJobCount: Object.keys(references.config.contract?.jobBindings ?? {}).length,
      r043EligibleJobs,
      monthlyConversions: 0,
    },
    policyNotes: [
      'A/Bは同一求人で同時掲載せず、A案2週間の後にB案2週間を実施する。',
      '競合の同一求人3本同時出稿は、掲載枠コスト・Airワーク§5-3・応募管理の観点から真似しない。',
      'タグ棚卸しと文面変更は同時に行わない。',
      'CANDIDATE・MISSING・CONFLICTは生成根拠に使わない。',
      r043EligibleJobs.length > 0
        ? `内容確認書行27を求人別に確認できた${r043EligibleJobs.length}件だけV101/R043経路を使用した。`
        : '内容確認書行27が求人別に確認できないためV101/R043は使用していない。',
      references.competitor
        ? '競合分析（competitors/_merged.md）のセクション1・4・8を読み、文字列ではなく変数と軸IDだけを利用した。'
        : references.rules.competitorFallback.note,
      references.personas.status === 'skeleton'
        ? (references.rules.personaPolicy?.fallbackNote ?? references.rules.personaFallback.note)
        : `ペルソナ状態: ${references.personas.status}`,
    ],
    skippedVariables: [
      { id: 3, reason: '属性訴求は禁止' },
      { id: 5, reason: '募集残数・期限のCONFIRMED_INTERNAL根拠がないため未使用' },
      { id: 6, reason: '雇用安定の競合型は禁止' },
      { id: '9_housing', reason: '住居支援の事実がないため禁止' },
      { id: '9_transport', reason: '内容確認書行33に送迎無料の確定事実がないため未使用' },
    ],
    suppressed,
    rows,
    fieldGaps: buildFieldGaps(published, {
      rules: references.rules,
      columnRoles: references.columnRoles,
      limits: references.limits,
    }),
  };
}

function runSelfTests({ rules, axes, columnRoles, limits, lintReferences, clientId }) {
  const subtitleColumn = columnRoles.get('subtitle').column;
  const personalColumn = columnRoles.get('personal').column;
  const baseJob = {
    jobNumber: 'SELF_TEST',
    approvalStatus: '',
    publicationStatus: '02',
    isPublished: true,
    source: { rowNumber: 2 },
    copy: [
      { column: subtitleColumn, header: '求人キャッチコピー(subtitle)', value: '時給1,500円の検査', evidenceStatus: 'EXTRACTED_JOBLIST' },
      { column: personalColumn, header: '求める人材(personal)', value: '・未経験者歓迎', evidenceStatus: 'EXTRACTED_JOBLIST' },
    ],
    tags: [],
    immutable: [
      { column: 'BJ', header: '給与形態(salary_form_jp)', value: '時給', evidenceStatus: 'EXTRACTED_JOBLIST' },
      { column: 'BO', header: '給与額下限(minimum_salary)', value: '1500', evidenceStatus: 'EXTRACTED_JOBLIST' },
      { column: 'BP', header: '給与額上限(maximum_salary)', value: '1875', evidenceStatus: 'EXTRACTED_JOBLIST' },
    ],
  };
  const forbiddenInputs = [
    '20代歓迎', '30代歓迎', '男性歓迎', '女性歓迎', '男女活躍中',
    '正社員採用', '直接雇用', '寮費無料', '家賃0円', '奨励金あり',
    '0063131_40587-01', '0063131_ABC',
  ];
  const forbiddenResults = forbiddenInputs.map((input) => {
    const result = lintProposal({
      proposal: input,
      targetColumn: subtitleColumn,
      job: baseJob,
      clientId,
      rules,
      columnRoles,
      lintReferences,
    });
    return { input, result: result.risk, suppressed: result.risk === 'HIGH_RISK' };
  });
  const candidateInput = { value: '未確認の若年向け表現', evidenceStatus: 'CANDIDATE' };
  let candidateRejected = false;
  try {
    assertSourceEvidence(candidateInput);
  } catch {
    candidateRejected = true;
  }
  const variableResults = ['3', '6', '9_housing'].map((input) => {
    let rejected = false;
    try {
      assertCompetitorVariables([input], rules);
    } catch {
      rejected = true;
    }
    return { input, rejected };
  });
  const monthly = monthlyConversionIssues('月収30万円', false);
  const boundConfig = { contract: { jobBindings: { SELF_TEST: 'contract-self' } } };
  const missingR043 = confirmedR043Evidence({
    source: { spreadsheet: { id: 'contract-self' } },
    fields: [],
  }, 'SELF_TEST', boundConfig, rules);
  const confirmedR043 = confirmedR043Evidence({
    source: { spreadsheet: { id: 'contract-self' } },
    fields: [
      { key: 'employeeConversionYesMarker', sourceRow: 27, value: '有', evidenceStatus: 'CONFIRMED_INTERNAL' },
      { key: 'employeeConversionPeriod', sourceRow: 27, value: '1年', evidenceStatus: 'CONFIRMED_INTERNAL' },
      { key: 'directEmploymentSalaryRange', sourceRow: 27, value: '300万円〜400万円', evidenceStatus: 'CONFIRMED_INTERNAL' },
    ],
  }, 'SELF_TEST', boundConfig, rules);
  const unboundR043 = confirmedR043Evidence({
    source: { spreadsheet: { id: 'contract-self' } },
    fields: [
      { key: 'employeeConversionYesMarker', sourceRow: 27, value: '有', evidenceStatus: 'CONFIRMED_INTERNAL' },
      { key: 'employeeConversionPeriod', sourceRow: 27, value: '1年', evidenceStatus: 'CONFIRMED_INTERNAL' },
      { key: 'directEmploymentSalaryRange', sourceRow: 27, value: '300万円〜400万円', evidenceStatus: 'CONFIRMED_INTERNAL' },
    ],
  }, 'SELF_TEST', { contract: { jobBindings: {} } }, rules);
  const acceptedYesMarkers = ['有', 'TRUE', '1', '○', '〇', '☑'].map((value) => ({
    value,
    accepted: confirmedR043Evidence({
      source: { spreadsheet: { id: 'contract-self' } },
      fields: [
        { key: 'employeeConversionYesMarker', sourceRow: 27, value, evidenceStatus: 'CONFIRMED_INTERNAL' },
        { key: 'employeeConversionPeriod', sourceRow: 27, value: '1年', evidenceStatus: 'CONFIRMED_INTERNAL' },
        { key: 'directEmploymentSalaryRange', sourceRow: 27, value: '300万円〜400万円', evidenceStatus: 'CONFIRMED_INTERNAL' },
      ],
    }, 'SELF_TEST', boundConfig, rules) !== null,
  }));
  const safe = lintProposal({
    proposal: '時給1,500円／履歴書不要で応募できる部品の目視チェック',
    targetColumn: subtitleColumn,
    job: baseJob,
    clientId,
    rules,
    columnRoles,
    lintReferences,
  });
  const r043Variant = buildAxVariants(baseJob, rules, columnRoles, confirmedR043);
  const r043Lint = lintProposal({
    proposal: r043Variant.variantB,
    targetColumn: personalColumn,
    job: baseJob,
    clientId,
    rules,
    columnRoles,
    lintReferences,
    additionalConfirmedText: JSON.stringify(confirmedR043),
    hasConfirmedMoneyBasis: true,
  });
  for (const ids of [['V084', 'R047'], ['V098', 'R047'], ['V023', 'S063']]) {
    assertAxisSelection(ids, axes, rules);
  }
  assertAxisSelection(['R043'], axes, rules, { allowR043: confirmedR043 !== null });
  // 15欄の充填レポートが、値の無い欄でも例外にならず shortfall を返すことを確かめる。
  const gapReport = buildFieldGaps([baseJob], { rules, columnRoles, limits })[0];
  const descriptionGap = gapReport.fields.find((entry) => entry.role === 'description');
  const fieldGapsCheck = {
    roleCount: gapReport.fields.length,
    expectedRoleCount: REQUIRED_COPY_ROLES.length,
    // baseJob は subtitle と personal しか持たないので description は missing_column になる
    missingColumnHandled: descriptionGap?.state === 'missing_column' && descriptionGap.shortfall > 0,
    hearingFlagged: gapReport.fields.some((entry) => entry.askInHearing === true),
  };
  const results = {
    fieldGaps: fieldGapsCheck,
    candidate: { input: candidateInput, rejected: candidateRejected },
    forbiddenOutputs: forbiddenResults,
    forbiddenCompetitorVariables: variableResults,
    monthlyConversionWithoutBasis: { input: '月収30万円', rejected: monthly.length > 0 },
    r043Gate: {
      missingInputRejected: missingR043 === null,
      unboundContractRejected: unboundR043 === null,
      confirmedRow27Accepted: confirmedR043 !== null,
      generatedWithV101AndR043: r043Variant.axisIdsB[0] === 'V101' && r043Variant.axisIdsB.includes('R043'),
      generatedCopyLint: r043Lint.risk,
      prohibitedEmploymentWordsAbsent: !/(?:正社員|直接雇用)/u.test(r043Variant.variantB),
      acceptedYesMarkers,
    },
    safeProposal: { result: safe.risk, suppressed: safe.risk === 'HIGH_RISK' },
  };
  const ok = candidateRejected
    && fieldGapsCheck.roleCount === fieldGapsCheck.expectedRoleCount
    && fieldGapsCheck.missingColumnHandled
    && fieldGapsCheck.hearingFlagged
    && forbiddenResults.every((item) => item.suppressed)
    && variableResults.every((item) => item.rejected)
    && monthly.length > 0
    && missingR043 === null
    && confirmedR043 !== null
    && unboundR043 === null
    && acceptedYesMarkers.every((item) => item.accepted)
    && r043Variant.axisIdsB[0] === 'V101'
    && r043Variant.axisIdsB.includes('R043')
    && r043Lint.risk !== 'HIGH_RISK'
    && !/(?:正社員|直接雇用)/u.test(r043Variant.variantB)
    && safe.risk !== 'HIGH_RISK';
  return { ok, ...results };
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
    if (!['--input', '--contract', '--client', '--output', '--competitor'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write([
      'Usage:',
      '  node generate_variants.mjs --input /tmp/normalized.json [--contract /tmp/contract.json] --client <id> --output /tmp/variants.json',
      '  node generate_variants.mjs --client <id> --self-test',
      '',
    ].join('\n'));
    return;
  }
  if (!options.client) throw new Error('--client is required.');
  const references = await loadReferences(options.client, options.competitor);
  const lintReferences = await loadLintReferences(options.client);
  if (options.selfTest) {
    if (options.input || options.contract || options.output) throw new Error('--self-test does not accept input/output arguments.');
    const result = runSelfTests({
      rules: references.rules,
      axes: references.axes,
      columnRoles: references.columnRoles,
      limits: references.limits,
      lintReferences,
      clientId: options.client,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (!options.input || !options.output) throw new Error('--input and --output are required.');
  const normalized = await readSecureTmpJson(options.input);
  const contract = options.contract ? await readSecureTmpJson(options.contract) : null;
  const report = await generateVariants(normalized, {
    contract,
    clientId: options.client,
    references,
    lintReferences,
  });
  const outputPath = await secureWriteTmpJson(options.output, report);
  process.stdout.write(`${JSON.stringify({ outputPath, summary: report.summary }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`generate_variants: ${error.message}\n`);
    process.exitCode = 1;
  });
}
