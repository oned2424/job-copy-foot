#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// /tmp の門番は secure_tmp.mjs が唯一。ここで自前の判定を持つと、
// 片方だけ直したときに静かに穴が空く（/private/tmp を片方だけ拒否する、など）。
import {
  ensureSecureTmpDirectory,
  secureReadTmpText,
  secureWriteTmpFile,
} from './secure_tmp.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const FIELD_CATEGORIES = Object.freeze(['copy', 'tags', 'immutable']);
const RULE_IDS = Object.freeze(Array.from({ length: 10 }, (_, index) => `R${index + 1}`));
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

async function readJson(jsonPath) {
  try {
    return JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON ${jsonPath}: ${error.message}`, { cause: error });
  }
}

function jsonPointer(root, pointer) {
  if (pointer == null || pointer === '' || pointer === '#') return root;
  const fragment = String(pointer).includes('#') ? String(pointer).split('#', 2)[1] : String(pointer);
  const normalized = fragment.replace(/^\$\.?/, '').replace(/^\//, '');
  if (!normalized) return root;
  const parts = normalized.startsWith('/')
    ? normalized.slice(1).split('/')
    : normalized.split(/[/.]/);
  return parts.filter(Boolean).reduce((value, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return value == null ? undefined : value[key];
  }, root);
}

export function parseRulesMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('airwork-ng.md must be text.');
  const startMatch = markdown.match(/<!--\s*[A-Z0-9_-]*LINT[A-Z0-9_-]*START\s*-->/i);
  const endMatch = markdown.match(/<!--\s*[A-Z0-9_-]*LINT[A-Z0-9_-]*END\s*-->/i);
  if (!startMatch || !endMatch || startMatch.index >= endMatch.index) {
    throw new Error('airwork-ng.md lint JSON START/END markers were not found.');
  }

  const start = startMatch.index + startMatch[0].length;
  const marked = markdown.slice(start, endMatch.index);
  const firstBrace = marked.indexOf('{');
  const lastBrace = marked.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace < firstBrace) {
    throw new Error('airwork-ng.md has no JSON object between lint markers.');
  }

  let parsed;
  try {
    parsed = JSON.parse(marked.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error(`airwork-ng.md lint JSON is invalid: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(parsed.rules)) throw new Error('airwork-ng.md lint JSON must contain rules[].');

  const ids = parsed.rules.map((rule) => rule?.id);
  const missing = RULE_IDS.filter((id) => !ids.includes(id));
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (missing.length || duplicates.length) {
    throw new Error(
      `airwork-ng.md must define R1-R10 exactly once (missing: ${missing.join(', ') || '-'}; duplicates: ${[...new Set(duplicates)].join(', ') || '-'}).`,
    );
  }
  return parsed;
}

export async function loadLintReferences(clientId, { skillRoot = SKILL_ROOT } = {}) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }
  const clientDirectory = path.join(skillRoot, 'references', 'clients', clientId);
  const [config, limits, airworkMarkdown, outputTemplate] = await Promise.all([
    readJson(path.join(clientDirectory, 'config.json')),
    readJson(path.join(clientDirectory, 'limits.json')),
    readFile(path.join(skillRoot, 'references', 'airwork-ng.md'), 'utf8'),
    readFile(path.join(skillRoot, 'assets', 'output-template.md'), 'utf8'),
  ]);
  if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new Error('config.json clientId is required.');
  }
  if (config.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${config.clientId}, requested client is ${clientId}.`);
  }
  return {
    config,
    limits,
    rulesDocument: parseRulesMarkdown(airworkMarkdown),
    outputTemplate,
  };
}

function normalizeText(value, normalization = {}) {
  let text = String(value ?? '');
  const unicodeForm = normalization.unicodeForm ?? normalization.unicode ?? normalization.form;
  if (unicodeForm && unicodeForm !== 'none' && unicodeForm !== 'NONE') text = text.normalize(unicodeForm);
  if (normalization.lineEndings === 'LF' || normalization.lineBreak === 'LF' || normalization.normalizeLineEndings === true) {
    text = text.replace(/\r\n?/g, '\n');
  }
  if (normalization.collapseWhitespace === true) text = text.replace(/\s+/gu, ' ');
  if (normalization.trim === true) text = text.trim();
  return text;
}

function patternSource(pattern) {
  if (typeof pattern === 'string') return pattern;
  if (!pattern || typeof pattern !== 'object') throw new Error(`Invalid lint pattern: ${JSON.stringify(pattern)}`);
  const source = pattern.source ?? pattern.pattern ?? pattern.regex;
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error(`Lint pattern has no source: ${JSON.stringify(pattern)}`);
  }
  if (pattern.type === 'literal') return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source;
}

function compilePattern(pattern) {
  const flags = typeof pattern === 'object' && pattern !== null ? (pattern.flags ?? 'u') : 'u';
  try {
    return new RegExp(patternSource(pattern), flags);
  } catch (error) {
    throw new Error(`Invalid lint regular expression ${patternSource(pattern)}: ${error.message}`, { cause: error });
  }
}

function firstPatternMatch(text, patterns, normalization) {
  if (!Array.isArray(patterns)) return null;
  const normalized = normalizeText(text, normalization);
  for (const pattern of patterns) {
    const regex = compilePattern(pattern);
    regex.lastIndex = 0;
    const match = regex.exec(normalized);
    if (match) {
      const configuredGroup = typeof pattern === 'object' && pattern !== null ? pattern.captureGroup : undefined;
      let content = match[0];
      if (Number.isInteger(configuredGroup)) content = match[configuredGroup] ?? match[0];
      if (typeof configuredGroup === 'string') content = match.groups?.[configuredGroup] ?? match[0];
      return {
        pattern,
        match,
        content,
        normalized,
      };
    }
  }
  return null;
}

function allPatternMatches(text, pattern, normalization) {
  const normalized = normalizeText(text, normalization);
  const configuredFlags = typeof pattern === 'object' && pattern !== null ? (pattern.flags ?? 'u') : 'u';
  const flags = configuredFlags.includes('g') ? configuredFlags : `${configuredFlags}g`;
  let regex;
  try {
    regex = new RegExp(patternSource(pattern), flags);
  } catch (error) {
    throw new Error(`Invalid lint regular expression ${patternSource(pattern)}: ${error.message}`, { cause: error });
  }

  const matches = [];
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    const configuredGroup = typeof pattern === 'object' && pattern !== null ? pattern.captureGroup : undefined;
    let content = match[0];
    if (Number.isInteger(configuredGroup)) content = match[configuredGroup] ?? match[0];
    if (typeof configuredGroup === 'string') content = match.groups?.[configuredGroup] ?? match[0];
    matches.push({ pattern, match, content, normalized });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return matches;
}

function fieldList(job, category) {
  const raw = job?.[category] ?? job?.fields?.[category] ?? [];
  if (Array.isArray(raw)) return raw.filter((field) => field && typeof field === 'object');
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([column, field]) => (
      field && typeof field === 'object' ? { column, ...field } : { column, value: field }
    ));
  }
  throw new Error(`Normalized job ${job?.jobNumber ?? '(unknown)'} has invalid ${category} fields.`);
}

function allFields(job, categories = FIELD_CATEGORIES) {
  return categories.flatMap((category) => fieldList(job, category).map((field) => ({ ...field, category })));
}

function nonempty(field) {
  return String(field?.value ?? '').length > 0;
}

function excerpt(value, matchContent, maximum = 180) {
  const text = String(value ?? '').replace(/\r\n?|\n/g, '\u23ce');
  const characters = Array.from(text);
  if (characters.length <= maximum) return text;
  const match = String(matchContent ?? '');
  const codeUnitIndex = match ? text.indexOf(match) : -1;
  const matchIndex = codeUnitIndex === -1 ? -1 : Array.from(text.slice(0, codeUnitIndex)).length;
  const start = Math.max(0, matchIndex === -1 ? 0 : matchIndex - Math.floor(maximum / 3));
  const sliced = characters.slice(start, start + maximum).join('');
  return `${start > 0 ? '\u2026' : ''}${sliced}${start + maximum < characters.length ? '\u2026' : ''}`;
}

function formatRuleText(rule, context) {
  const template = rule.message ?? rule.description ?? rule.title ?? rule.id;
  return String(template).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => String(context[key] ?? ''));
}

function createIssue({ rule, job, field, matchContent, detail, extra = {} }) {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title ?? rule.id,
    risk: rule.risk,
    basis: rule.basis,
    jobNumber: String(job.jobNumber ?? ''),
    approvalStatus: job.approvalStatus ?? '',
    publicationStatus: job.publicationStatus ?? '',
    isPublished: job.isPublished === true,
    column: field.column ?? '',
    header: field.header ?? '',
    evidenceStatus: field.evidenceStatus ?? '',
    detectedContent: excerpt(field.value, matchContent),
    matched: String(matchContent ?? ''),
    detail: detail ?? formatRuleText(rule, { match: matchContent, column: field.column }),
    source: job.source ?? null,
    ...extra,
  };
}

function hasEvidenceExemption(rule, field, normalization) {
  const exemptions = rule.evidencePatterns ?? rule.exemptionPatterns ?? rule.unlessPatterns;
  return Array.isArray(exemptions) && firstPatternMatch(field.value, exemptions, normalization) !== null;
}

function lintPatternRule(rule, job, normalization) {
  const issues = [];
  for (const field of fieldList(job, 'copy')) {
    if (!nonempty(field)) continue;
    const match = firstPatternMatch(field.value, rule.patterns, normalization);
    if (!match || hasEvidenceExemption(rule, field, normalization)) continue;
    issues.push(createIssue({
      rule,
      job,
      field,
      matchContent: match.content,
      extra: { patternId: match.pattern?.id ?? null },
    }));
  }
  return issues;
}

function includesColumn(field, configuredColumns) {
  if (configuredColumns == null) return true;
  const columns = Array.isArray(configuredColumns) ? configuredColumns : [configuredColumns];
  return columns.map(String).includes(String(field.column));
}

function lintContradictions(rule, job, normalization) {
  const issues = [];
  const tags = fieldList(job, 'tags').filter(nonempty);
  const copy = fieldList(job, 'copy').filter(nonempty);

  for (const contradiction of rule.contradictions ?? []) {
    const tagPatterns = contradiction.tagPatterns ?? contradiction.tag?.patterns ?? [];
    const copyPatterns = contradiction.copyPatterns
      ?? contradiction.textPatterns
      ?? contradiction.copy?.patterns
      ?? contradiction.text?.patterns
      ?? [];
    const tagColumns = contradiction.tagColumns ?? contradiction.tagColumn ?? contradiction.tag?.columns;
    const copyColumns = contradiction.copyColumns
      ?? contradiction.copyColumn
      ?? contradiction.textColumns
      ?? contradiction.textColumn
      ?? contradiction.copy?.columns
      ?? contradiction.text?.columns;

    const matchedTag = tags.find((field) => (
      includesColumn(field, tagColumns) && firstPatternMatch(field.value, tagPatterns, normalization)
    ));
    if (!matchedTag) continue;

    for (const field of copy) {
      if (!includesColumn(field, copyColumns)) continue;
      const textMatch = firstPatternMatch(field.value, copyPatterns, normalization);
      if (!textMatch) continue;
      const detailTemplate = contradiction.message ?? contradiction.description;
      const detail = detailTemplate
        ? String(detailTemplate)
          .replace(/\{\{\s*tag\s*\}\}/g, String(matchedTag.value))
          .replace(/\{\{\s*match\s*\}\}/g, textMatch.content)
        : formatRuleText(rule, { tag: matchedTag.value, match: textMatch.content });
      issues.push(createIssue({
        rule,
        job,
        field,
        matchContent: textMatch.content,
        detail,
        extra: {
          contradictionId: contradiction.id ?? null,
          conflictingTag: {
            column: matchedTag.column,
            header: matchedTag.header ?? '',
            value: matchedTag.value,
          },
        },
      }));
    }
  }
  return issues;
}

function resolveStatusReference(config, statusRef) {
  if (!statusRef) return undefined;
  const direct = jsonPointer(config, statusRef);
  if (direct != null) return direct;
  const pointer = String(statusRef).includes('#') ? String(statusRef).split('#', 2)[1] : statusRef;
  return jsonPointer(config, pointer);
}

function lintCandidateEvidence(rule, job, config, normalization) {
  const specification = rule.candidateEvidence ?? {};
  const expectedStatus = specification.status
    ?? resolveStatusReference(config, specification.statusRef)
    ?? config?.evidenceStatuses?.candidate;
  if (!expectedStatus) throw new Error(`${rule.id} candidateEvidence status could not be resolved.`);
  const categories = specification.categories ?? FIELD_CATEGORIES;
  const assertionPatterns = specification.assertionPatterns ?? [];
  const issues = [];

  const statusField = specification.statusField ?? 'evidenceStatus';
  const valueField = specification.valueField ?? 'value';
  const sourceColumnField = specification.sourceColumnField ?? 'sourceColumn';
  const minimumValueLength = Number.isInteger(specification.minimumValueLength)
    ? specification.minimumValueLength
    : 1;
  const evidence = Array.isArray(job.evidence) ? job.evidence : [];
  for (const item of evidence) {
    if (!item || item[statusField] !== expectedStatus) continue;
    const candidateValue = normalizeText(item[valueField], normalization);
    if (Array.from(candidateValue).length < minimumValueLength) continue;
    for (const field of fieldList(job, 'copy')) {
      const copyValue = normalizeText(field.value, normalization);
      if (!copyValue.includes(candidateValue)) continue;
      issues.push(createIssue({
        rule,
        job,
        field,
        matchContent: candidateValue,
        extra: {
          candidateEvidence: {
            sourceColumn: item[sourceColumnField] ?? '',
            value: item[valueField],
            status: item[statusField],
          },
        },
      }));
    }
  }

  for (const candidateField of allFields(job, categories)) {
    if (!nonempty(candidateField) || candidateField.evidenceStatus !== expectedStatus) continue;
    if (candidateField.category === 'copy') {
      const assertion = assertionPatterns.length
        ? firstPatternMatch(candidateField.value, assertionPatterns, normalization)
        : { content: candidateField.value };
      if (!assertion) continue;
      issues.push(createIssue({
        rule,
        job,
        field: candidateField,
        matchContent: assertion.content,
      }));
      continue;
    }

    const candidateValue = normalizeText(candidateField.value, normalization);
    if (Array.from(candidateValue).length < minimumValueLength) continue;
    for (const copyField of fieldList(job, 'copy')) {
      if (!normalizeText(copyField.value, normalization).includes(candidateValue)) continue;
      issues.push(createIssue({
        rule,
        job,
        field: copyField,
        matchContent: candidateValue,
        extra: {
          candidateEvidence: {
            sourceColumn: candidateField.column,
            value: candidateField.value,
            status: candidateField.evidenceStatus,
          },
        },
      }));
    }
  }
  return issues;
}

function numericLimit(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (!value || typeof value !== 'object') return undefined;
  for (const key of ['max', 'maximum', 'maxLength', 'maxCharacters', 'limit']) {
    if (Number.isInteger(value[key]) && value[key] >= 0) return value[key];
  }
  return undefined;
}

function collectLimits(value, output = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && item.column) {
        const limit = numericLimit(item);
        if (limit != null) output.set(String(item.column), { max: limit, metadata: item });
      } else {
        collectLimits(item, output);
      }
    }
    return output;
  }
  if (!value || typeof value !== 'object') return output;

  for (const [key, entry] of Object.entries(value)) {
    const limit = numericLimit(entry);
    if (/^[A-Za-z]+$/.test(key) && limit != null) {
      output.set(key.toUpperCase(), { max: limit, metadata: entry });
    } else if (entry && typeof entry === 'object') {
      collectLimits(entry, output);
    }
  }
  return output;
}

function limitCountingConfiguration(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('limits.json must contain an object.');
  }
  if (limits.unit !== 'unicode_code_points') {
    throw new Error(`Unsupported limits.json unit: ${String(limits.unit)}`);
  }
  if (!limits.normalization || typeof limits.normalization !== 'object' || Array.isArray(limits.normalization)) {
    throw new Error('limits.json normalization object is required.');
  }
  const unicodeForm = limits.normalization.unicodeForm
    ?? limits.normalization.unicode
    ?? limits.normalization.form;
  if (!['NFC', 'NFD', 'NFKC', 'NFKD', 'none', 'NONE'].includes(unicodeForm)) {
    throw new Error(`Unsupported limits.json Unicode normalization: ${String(unicodeForm)}`);
  }
  return {
    unit: limits.unit,
    normalization: limits.normalization,
  };
}

function countConfiguredUnits(value, counting) {
  const normalized = normalizeText(value, counting.normalization);
  if (counting.unit === 'unicode_code_points') return Array.from(normalized).length;
  throw new Error(`Unsupported limits.json unit: ${String(counting.unit)}`);
}

function lintLimits(rule, job, limits) {
  const counting = limitCountingConfiguration(limits);
  const limitMap = collectLimits(limits);
  const issues = [];
  for (const field of fieldList(job, 'copy')) {
    if (!nonempty(field)) continue;
    const configured = limitMap.get(String(field.column).toUpperCase()) ?? limitMap.get(String(field.header));
    if (!configured) continue;
    const actual = countConfiguredUnits(field.value, counting);
    if (actual <= configured.max) continue;
    issues.push(createIssue({
      rule,
      job,
      field,
      matchContent: field.value,
      extra: {
        actualLength: actual,
        maximumLength: configured.max,
        limitStatus: configured.metadata?.status ?? limits.status ?? null,
        countingUnit: counting.unit,
      },
    }));
  }
  return issues;
}

function flattenAllowedNames(value) {
  if (Array.isArray(value)) return value.flatMap(flattenAllowedNames);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenAllowedNames);
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

function resolveAllowedNames(config, reference) {
  if (!reference) return flattenAllowedNames(config?.allowedEntities);
  const pointer = String(reference).includes('#') ? String(reference).split('#', 2)[1] : reference;
  const resolved = jsonPointer(config, pointer);
  if (resolved == null) throw new Error(`allowedNamesRef could not be resolved: ${reference}`);
  return flattenAllowedNames(resolved);
}

function comparableEntity(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('ja-JP');
}

function entityIsAllowed(candidate, allowedNames) {
  const normalizedCandidate = comparableEntity(candidate);
  return allowedNames.some((allowed) => {
    const normalizedAllowed = comparableEntity(allowed);
    return normalizedAllowed.length > 0 && normalizedCandidate === normalizedAllowed;
  });
}

function lintEntities(rule, job, config, normalization) {
  const allowedNames = resolveAllowedNames(config, rule.allowedNamesRef);
  const issues = [];
  for (const field of fieldList(job, 'copy')) {
    if (!nonempty(field)) continue;
    for (const entityPattern of rule.entityPatterns ?? []) {
      for (const match of allPatternMatches(field.value, entityPattern, normalization)) {
        if (entityIsAllowed(match.content, allowedNames)) continue;
        issues.push(createIssue({
          rule,
          job,
          field,
          matchContent: match.content,
          extra: {
            entityPatternId: entityPattern?.id ?? null,
            entityCandidate: match.content,
          },
        }));
        break;
      }
      if (issues.some((issue) => issue.column === field.column)) break;
    }
  }
  return issues;
}

function lintRule(rule, job, context) {
  switch (rule.id) {
    case 'R1':
    case 'R2':
    case 'R3':
    case 'R4':
    case 'R5':
    case 'R10':
      return lintPatternRule(rule, job, context.normalization);
    case 'R6':
      return lintContradictions(rule, job, context.normalization);
    case 'R7':
      return lintCandidateEvidence(rule, job, context.config, context.normalization);
    case 'R8':
      return lintLimits(rule, job, context.limits);
    case 'R9':
      return lintEntities(rule, job, context.config, context.normalization);
    default:
      throw new Error(`Unsupported lint rule: ${rule.id}`);
  }
}

function deduplicateIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = [issue.jobNumber, issue.source?.rowNumber ?? '', issue.column, issue.ruleId].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countBy(items, keySelector) {
  const counts = {};
  for (const item of items) {
    const key = String(keySelector(item) ?? 'UNKNOWN');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function createSummary(jobs, issues) {
  const publishedJobs = jobs.filter((job) => job.isPublished === true);
  const publishedIssues = issues.filter((issue) => issue.isPublished === true);
  return {
    jobCount: jobs.length,
    publishedJobCount: publishedJobs.length,
    issueCount: issues.length,
    publishedIssueCount: publishedIssues.length,
    byRisk: countBy(issues, (issue) => issue.risk),
    publishedByRisk: countBy(publishedIssues, (issue) => issue.risk),
    byRule: countBy(issues, (issue) => issue.ruleId),
    publishedByRule: countBy(publishedIssues, (issue) => issue.ruleId),
    publishedJobsWithIssues: new Set(publishedIssues.map((issue) => issue.jobNumber)).size,
  };
}

export function lintNormalizedData(normalized, { clientId, config, limits, rulesDocument } = {}) {
  if (!normalized || typeof normalized !== 'object' || !Array.isArray(normalized.jobs)) {
    throw new Error('Normalized input must contain jobs[].');
  }
  if (!rulesDocument || !Array.isArray(rulesDocument.rules)) throw new Error('rulesDocument.rules[] is required.');
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }
  if (!config || typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new Error('config.json clientId is required.');
  }
  if (config.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${config.clientId}, requested client is ${clientId}.`);
  }
  if (typeof normalized.clientId !== 'string' || normalized.clientId.length === 0) {
    throw new Error('Normalized input clientId is required.');
  }
  if (normalized.clientId !== clientId) {
    throw new Error(`Client mismatch: input is ${normalized.clientId}, --client is ${clientId}.`);
  }
  const context = {
    config,
    limits,
    normalization: rulesDocument.normalization ?? {},
  };

  const rawIssues = [];
  for (const job of normalized.jobs) {
    for (const rule of rulesDocument.rules) rawIssues.push(...lintRule(rule, job, context));
  }
  const issues = deduplicateIssues(rawIssues);
  return {
    version: 1,
    clientId: clientId ?? normalized.clientId,
    inputSource: normalized.source ?? null,
    summary: createSummary(normalized.jobs, issues),
    issues,
  };
}

function markdownCell(value) {
  if (Array.isArray(value)) value = value.join(' / ');
  if (value && typeof value === 'object') value = JSON.stringify(value);
  return String(value ?? '').replace(/\r\n?|\n/g, '<br>').replace(/\|/g, '\\|');
}

function summaryMarkdown(summary) {
  const risks = Object.entries(summary.publishedByRisk)
    .map(([risk, count]) => `${risk}: ${count}件`)
    .join(' / ');
  return `検出 ${summary.publishedIssueCount}件${risks ? `（${risks}）` : ''} / 該当求人 ${summary.publishedJobsWithIssues}件 / 対象求人 ${summary.publishedJobCount}件（全${summary.jobCount}件中） / 全ステータス検出 ${summary.issueCount}件`;
}

export function renderMarkdown(template, report) {
  const findings = report.issues.filter((issue) => issue.isPublished === true);
  const nonPublishedFindings = report.issues.filter((issue) => issue.isPublished !== true);
  const findingRows = findings.length
    ? findings.map((issue) => (
      `| ${markdownCell(issue.jobNumber)} | ${markdownCell(issue.column)} | ${markdownCell(`${issue.ruleId} ${issue.ruleTitle}: ${issue.detectedContent}`)} | ${markdownCell(issue.risk)} | ${markdownCell(issue.basis)} |`
    )).join('\n')
    : '| - | - | 検出なし | - | - |';
  const replacements = {
    generatedAt: report.generatedAt,
    scope: `対象求人 掲載中${report.summary.publishedJobCount}件（全${report.summary.jobCount}件中）`,
    summary: summaryMarkdown(report.summary),
    findingRows,
  };

  const rendered = String(template).replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (placeholder, key) => (
    Object.hasOwn(replacements, key) ? replacements[key] : placeholder
  ));
  const unresolved = rendered.match(/\{\{\s*[A-Za-z0-9_-]+\s*\}\}/g);
  if (unresolved) throw new Error(`output-template.md has unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
  const nonPublishedRows = nonPublishedFindings.length
    ? nonPublishedFindings.map((issue) => (
      `| ${markdownCell(issue.jobNumber)} | ${markdownCell(issue.publicationStatus || '-')} | ${markdownCell(issue.column)} | ${markdownCell(`${issue.ruleId} ${issue.ruleTitle}: ${issue.detectedContent}`)} | ${markdownCell(issue.risk)} | ${markdownCell(issue.basis)} |`
    )).join('\n')
    : '| - | - | - | 検出なし | - | - |';
  const referenceSection = [
    '',
    '## 参考：非掲載求人の検出',
    '',
    '掲載中の判定表には混ぜず、下書き・停止中などの検出を参考情報として列挙する。',
    '',
    '| 求人番号 | 掲載状況 | 対象列 | 検出内容 | リスク | 根拠 |',
    '|---|---|---|---|---|---|',
    nonPublishedRows,
    '',
  ].join('\n');
  const body = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
  return `${body}${referenceSection}`;
}

function normalizedTestInput(input, config, rulesDocument, index) {
  if (input?.jobs && Array.isArray(input.jobs)) return input;
  const source = input ?? {};
  const categorized = { copy: [], tags: [], immutable: [] };
  const tagColumns = new Set(
    rulesDocument.rules
      .flatMap((rule) => rule.contradictions ?? [])
      .flatMap((contradiction) => contradiction.tagColumns ?? contradiction.tagColumn ?? []),
  );
  const addFields = (category, fields) => {
    const entries = Array.isArray(fields) ? fields : (fields ? [fields] : []);
    for (const entry of entries) {
      const field = typeof entry === 'string' ? { value: entry } : entry;
      if (!field || typeof field !== 'object') continue;
      categorized[category].push({
        column: field.column ?? '',
        header: field.header ?? '',
        value: field.value ?? '',
        evidenceStatus: field.evidenceStatus ?? config?.evidenceStatuses?.extracted ?? '',
      });
    }
  };

  if (Array.isArray(source.fields)) {
    for (const field of source.fields) {
      const category = FIELD_CATEGORIES.includes(field?.category) ? field.category : 'copy';
      addFields(category, field);
    }
  } else if (source.fields && typeof source.fields === 'object') {
    const hasCategories = FIELD_CATEGORIES.some((category) => Object.hasOwn(source.fields, category));
    if (hasCategories) {
      for (const category of FIELD_CATEGORIES) addFields(category, source.fields[category]);
    } else {
      for (const [column, value] of Object.entries(source.fields)) {
        addFields(tagColumns.has(column) ? 'tags' : 'copy', { column, value });
      }
    }
  }
  for (const category of FIELD_CATEGORIES) addFields(category, source[category]);

  if (source.valueFactory) {
    const factory = source.valueFactory;
    if (!factory.column || typeof factory.repeat !== 'string' || !Number.isInteger(factory.count) || factory.count < 0) {
      throw new Error(`Invalid self-test valueFactory: ${JSON.stringify(factory)}`);
    }
    addFields(tagColumns.has(factory.column) ? 'tags' : 'copy', {
      column: factory.column,
      value: factory.repeat.repeat(factory.count),
    });
  }

  return {
    version: 1,
    clientId: config?.clientId ?? 'self-test',
    source: { type: 'SELF_TEST' },
    jobs: [{
      jobNumber: source.jobNumber ?? `SELF_TEST_${index + 1}`,
      approvalStatus: source.approvalStatus ?? '',
      publicationStatus: source.publicationStatus ?? '',
      isPublished: source.isPublished ?? true,
      source: { type: 'SELF_TEST', rowNumber: index + 2 },
      evidence: Array.isArray(source.evidence) ? source.evidence.map((item) => ({ ...item })) : [],
      ...categorized,
    }],
  };
}

function sameStringSet(left, right) {
  const a = [...new Set(left.map(String))].sort();
  const b = [...new Set(right.map(String))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function runSelfTests({ clientId, config, limits, rulesDocument } = {}) {
  const cases = [];
  for (const rule of rulesDocument.rules) {
    const testInputs = Array.isArray(rule.testInput) ? rule.testInput : (rule.testInput ? [rule.testInput] : []);
    for (const testCase of testInputs) cases.push({ ownerRuleId: rule.id, testCase });
  }

  const results = cases.map(({ ownerRuleId, testCase }, index) => {
    const inputDefinition = testCase?.input ?? testCase;
    const normalized = normalizedTestInput(inputDefinition, config, rulesDocument, index);
    const lintResult = lintNormalizedData(normalized, { clientId, config, limits, rulesDocument });
    const actualRuleIds = [...new Set(lintResult.issues.map((issue) => issue.ruleId))].sort();
    const expectedDefinition = testCase?.expected ?? {};
    const expectedRuleIds = (
      expectedDefinition.ruleIds
      ?? expectedDefinition.rules
      ?? testCase?.expectedRuleIds
      ?? [ownerRuleId]
    ).map(String).sort();
    const passed = expectedDefinition.allowAdditional === true
      ? expectedRuleIds.every((id) => actualRuleIds.includes(id))
      : sameStringSet(actualRuleIds, expectedRuleIds);
    const actualContradictionIds = [...new Set(lintResult.issues
      .map((issue) => issue.contradictionId)
      .filter(Boolean))].sort();
    const actualEntities = [...new Set(lintResult.issues
      .map((issue) => issue.entityCandidate)
      .filter(Boolean))].sort();
    const metadataPassed = (
      (expectedDefinition.contradictionIds == null
        || sameStringSet(actualContradictionIds, expectedDefinition.contradictionIds))
      && (expectedDefinition.entities == null
        || sameStringSet(actualEntities, expectedDefinition.entities))
    );
    return {
      name: testCase?.name ?? `${ownerRuleId}_${index + 1}`,
      ownerRuleId,
      passed: passed && metadataPassed,
      expectedRuleIds,
      actualRuleIds,
      expectedContradictionIds: expectedDefinition.contradictionIds ?? [],
      actualContradictionIds,
      expectedEntities: expectedDefinition.entities ?? [],
      actualEntities,
      issueCount: lintResult.issues.length,
      issues: lintResult.issues.map((issue) => ({
        ruleId: issue.ruleId,
        column: issue.column,
        matched: issue.matched,
        risk: issue.risk,
      })),
    };
  });

  const coveredRules = new Set();
  for (const result of results) {
    if (result.passed && result.actualRuleIds.includes(result.ownerRuleId)) coveredRules.add(result.ownerRuleId);
  }
  const missingCoverage = RULE_IDS.filter((id) => !coveredRules.has(id));
  const failedCases = results.filter((result) => !result.passed).length;
  return {
    ok: failedCases === 0 && missingCoverage.length === 0,
    ruleCount: RULE_IDS.length,
    testCaseCount: results.length,
    passedCases: results.length - failedCases,
    failedCases,
    coveredRuleIds: [...coveredRules].sort(),
    missingCoverage,
    results,
  };
}

// 門番の中身は secure_tmp.mjs の self-test が試す。ここで見るのは
// 「lint_copy 側が呼び忘れていないか」だけ。だから main() をそのまま通す。
// 判定用パスは /etc 固定。スクリプトの置き場所から組み立てると、
// レビュー用に /private/tmp へコピーしたとき通ってしまう。
async function runTmpGateChecks(clientId) {
  const outside = '/etc/job-copy_must_not_be_read.json';
  const checks = [
    { name: 'tmp_gate_input', argv: ['--client', clientId, '--input', outside] },
    {
      name: 'tmp_gate_output_dir',
      argv: ['--client', clientId, '--input', '/tmp/job-copy_gate_probe.json',
        '--output-dir', '/etc'],
    },
  ];
  const results = [];
  for (const check of checks) {
    let message = '';
    try {
      await main(check.argv);
    } catch (error) {
      message = error.message;
    }
    results.push({
      name: check.name,
      ownerRuleId: 'TMP_GATE',
      passed: /\/tmp/.test(message),
      expectedRuleIds: [],
      actualRuleIds: [],
      expectedContradictionIds: [],
      actualContradictionIds: [],
      expectedEntities: [],
      actualEntities: [],
      issueCount: 0,
      issues: [],
      detail: message || '止まらなかった',
    });
  }
  return results;
}

function defaultDate() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('');
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
    if (!['--input', '--client', '--output-dir', '--date'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    index += 1;
    const key = argument.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    options[key] = value;
  }
  return options;
}


export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write([
      'Usage:',
      '  node lint_copy.mjs --input <normalized.json> --client <id> [--output-dir /tmp] [--date YYYYMMDD]',
      '  node lint_copy.mjs --client <id> --self-test',
      '',
    ].join('\n'));
    return;
  }
  if (!options.client) throw new Error('--client is required.');

  const references = await loadLintReferences(options.client);
  if (options.selfTest) {
    if (options.input || options.outputDir || options.date) {
      throw new Error('--self-test does not accept --input, --output-dir, or --date.');
    }
    const result = runSelfTests({ clientId: options.client, ...references });
    const gate = await runTmpGateChecks(options.client);
    result.results.push(...gate);
    result.testCaseCount = result.results.length;
    result.passedCases += gate.filter((g) => g.passed).length;
    result.failedCases += gate.filter((g) => !g.passed).length;
    result.ok = result.ok && gate.every((g) => g.passed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!options.input) throw new Error('--input is required unless --self-test is used.');
  const reportDate = options.date ?? defaultDate();
  if (!/^\d{8}$/.test(reportDate)) throw new Error('--date must be YYYYMMDD.');
  const outputDirectory = await ensureSecureTmpDirectory(options.outputDir ?? '/tmp');
  // 正規化済み Joblist JSON は求人本文そのもの。実データなので /tmp からしか読まない。
  // 出力側だけ門番を通しても、入力が Drive を読めるなら意味がない。
  const normalized = JSON.parse(await secureReadTmpText(options.input));
  const lintResult = lintNormalizedData(normalized, { clientId: options.client, ...references });
  const report = {
    ...lintResult,
    reportDate,
    generatedAt: new Date().toISOString(),
  };
  const jsonPath = path.join(outputDirectory, `lint_result_${reportDate}.json`);
  const markdownPath = path.join(outputDirectory, `lint_result_${reportDate}.md`);
  const markdown = renderMarkdown(references.outputTemplate, report);
  await Promise.all([
    secureWriteTmpFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    secureWriteTmpFile(markdownPath, markdown),
  ]);
  process.stdout.write(`${JSON.stringify({ jsonPath, markdownPath, summary: report.summary }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`lint_copy: ${error.message}\n`);
    process.exitCode = 1;
  });
}
