#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RISK_ORDER = Object.freeze({
  OK: 0,
  STRATEGY_MISMATCH: 1,
  REVIEW: 2,
  WARN: 3,
  CONFLICT: 4,
  HIGH_RISK: 5,
});

function normalizeText(value, normalization = {}) {
  let text = String(value ?? '');
  const unicodeForm = normalization.unicodeForm ?? normalization.unicode ?? normalization.form;
  if (unicodeForm && unicodeForm !== 'none' && unicodeForm !== 'NONE') text = text.normalize(unicodeForm);
  if (normalization.lineEndings === 'LF' || normalization.lineBreak === 'LF') {
    text = text.replace(/\r\n?/g, '\n');
  }
  if (normalization.collapseWhitespace === true) text = text.replace(/\s+/gu, ' ');
  if (normalization.trim === true) text = text.trim();
  return text;
}

function normalizedComparable(value, normalization) {
  return normalizeText(value, normalization).replace(/\s+/gu, '').toLocaleLowerCase('ja-JP');
}

function compilePattern(pattern) {
  if (!pattern || typeof pattern !== 'object' || typeof pattern.source !== 'string') {
    throw new Error(`Invalid tag rule pattern: ${JSON.stringify(pattern)}`);
  }
  try {
    return new RegExp(pattern.source, pattern.flags ?? 'u');
  } catch (error) {
    throw new Error(`Invalid tag rule regular expression ${pattern.source}: ${error.message}`, { cause: error });
  }
}

export function parseTagRulesMarkdown(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('airwork-tags.md must be text.');
  const startMarker = '<!-- JOB_COPY_TAG_RULES_START -->';
  const endMarker = '<!-- JOB_COPY_TAG_RULES_END -->';
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);
  if (start === -1 || end <= start) {
    throw new Error('airwork-tags.md tag JSON START/END markers were not found.');
  }
  const marked = markdown.slice(start + startMarker.length, end);
  const firstBrace = marked.indexOf('{');
  const lastBrace = marked.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace < firstBrace) {
    throw new Error('airwork-tags.md has no JSON object between tag markers.');
  }

  let rules;
  try {
    rules = JSON.parse(marked.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    throw new Error(`airwork-tags.md tag JSON is invalid: ${error.message}`, { cause: error });
  }

  if (!Array.isArray(rules.targetCategories) || rules.targetCategories.length !== 8) {
    throw new Error('airwork-tags.md must define exactly 8 targetCategories.');
  }
  const categoryIds = rules.targetCategories.map((category) => category?.id);
  if (categoryIds.some((id) => typeof id !== 'string' || id.length === 0) || new Set(categoryIds).size !== categoryIds.length) {
    throw new Error('airwork-tags.md targetCategories must have unique non-empty ids.');
  }
  for (const category of rules.targetCategories) {
    if (!Array.isArray(category.idColumns) || !Array.isArray(category.nameColumns)) {
      throw new Error(`Tag category ${category.id} must define idColumns[] and nameColumns[].`);
    }
    if (category.idColumns.length === 0 || category.idColumns.length !== category.nameColumns.length) {
      throw new Error(`Tag category ${category.id} must define matching ID/name column pairs.`);
    }
  }
  if (!Array.isArray(rules.copyColumns) || rules.copyColumns.length === 0) {
    throw new Error('airwork-tags.md copyColumns[] is required.');
  }
  if (!Array.isArray(rules.removalRules) || rules.removalRules.length !== 3) {
    throw new Error('airwork-tags.md must define exactly 3 removalRules.');
  }
  if (!Array.isArray(rules.additionRules) || rules.additionRules.length !== 4) {
    throw new Error('airwork-tags.md must define exactly 4 additionRules.');
  }
  if (!rules.duplicateGate || !Array.isArray(rules.duplicateGate.allowedSplitCriteria)) {
    throw new Error('airwork-tags.md duplicateGate is required.');
  }
  if (!rules.abTestPolicy || rules.abTestPolicy.runSimultaneously !== false) {
    throw new Error('airwork-tags.md abTestPolicy must prohibit simultaneous A/B publication.');
  }
  return rules;
}

async function readJson(jsonPath) {
  try {
    return JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read JSON ${jsonPath}: ${error.message}`, { cause: error });
  }
}

export async function loadTagReferences(clientId, { skillRoot = SKILL_ROOT } = {}) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }
  const clientDirectory = path.join(skillRoot, 'references', 'clients', clientId);
  const [config, markdown] = await Promise.all([
    readJson(path.join(clientDirectory, 'config.json')),
    readFile(path.join(skillRoot, 'references', 'airwork-tags.md'), 'utf8'),
  ]);
  if (config?.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${String(config?.clientId)}, requested client is ${clientId}.`);
  }
  return { config, rules: parseTagRulesMarkdown(markdown) };
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

function mapFields(job, category) {
  return new Map(fieldList(job, category).map((field) => [String(field.column ?? '').toUpperCase(), field]));
}

function splitCommaValues(value, normalization) {
  const text = normalizeText(value, normalization);
  if (!text) return [];
  return text.split(',').map((entry) => normalizeText(entry, normalization)).filter(Boolean);
}

function makePairConflict(job, category, idColumn, nameColumn, ids, names) {
  return {
    ruleId: 'TAG_PAIR_CONFLICT',
    risk: 'CONFLICT',
    jobNumber: String(job.jobNumber ?? ''),
    categoryId: category.id,
    categoryLabel: category.label,
    idColumn,
    nameColumn,
    idCount: ids.length,
    nameCount: names.length,
    detail: `${category.label}のID数(${ids.length})と名称数(${names.length})が一致しないため、人間による確認が必要`,
  };
}

function collectCurrentTags(job, rules) {
  const tagFields = mapFields(job, 'tags');
  const currentTagsByCategory = {};
  const issues = [];

  for (const category of rules.targetCategories) {
    const tags = [];
    for (let index = 0; index < category.idColumns.length; index += 1) {
      const idColumn = String(category.idColumns[index]).toUpperCase();
      const nameColumn = String(category.nameColumns[index]).toUpperCase();
      const idField = tagFields.get(idColumn);
      const nameField = tagFields.get(nameColumn);
      const ids = splitCommaValues(idField?.value, rules.normalization);
      const names = splitCommaValues(nameField?.value, rules.normalization);
      if (ids.length !== names.length) {
        issues.push(makePairConflict(job, category, idColumn, nameColumn, ids, names));
      }
      const length = Math.max(ids.length, names.length);
      for (let itemIndex = 0; itemIndex < length; itemIndex += 1) {
        tags.push({
          id: ids[itemIndex] ?? null,
          name: names[itemIndex] ?? null,
          idColumn,
          nameColumn,
          evidenceStatus: idField?.evidenceStatus ?? nameField?.evidenceStatus ?? '',
          pairingStatus: ids[itemIndex] != null && names[itemIndex] != null ? 'PAIRED' : 'CONFLICT',
        });
      }
    }
    currentTagsByCategory[category.id] = {
      label: category.label,
      tags,
    };
  }
  return { currentTagsByCategory, issues };
}

function flattenTags(currentTagsByCategory) {
  return Object.entries(currentTagsByCategory).flatMap(([categoryId, category]) => (
    category.tags.map((tag) => ({ ...tag, categoryId, categoryLabel: category.label }))
  ));
}

function makeRemovalIssue(job, removal) {
  return {
    ruleId: removal.ruleId,
    risk: removal.risk,
    jobNumber: String(job.jobNumber ?? ''),
    target: removal.target,
    column: removal.column ?? '',
    matched: removal.matched,
    detail: removal.reason,
  };
}

function evaluateRemovals(job, currentTagsByCategory, rules) {
  const removals = [];
  const copyFields = mapFields(job, 'copy');
  const tags = flattenTags(currentTagsByCategory);

  for (const rule of rules.removalRules) {
    const match = rule.match ?? {};
    if (match.type === 'tag_id') {
      const values = new Set((match.values ?? []).map((value) => normalizedComparable(value, rules.normalization)));
      for (const tag of tags) {
        if (!tag.id || !values.has(normalizedComparable(tag.id, rules.normalization))) continue;
        removals.push({
          ruleId: rule.id,
          target: rule.target,
          recommendation: rule.recommendation,
          risk: rule.risk,
          reason: rule.reason,
          matched: { id: tag.id, name: tag.name, categoryId: tag.categoryId },
          column: tag.idColumn,
          preserve: rule.preserve ?? null,
        });
      }
      continue;
    }

    if (match.type === 'regex') {
      const regex = compilePattern(match);
      for (const column of rules.copyColumns) {
        const field = copyFields.get(String(column).toUpperCase());
        if (!field || !normalizeText(field.value, rules.normalization)) continue;
        regex.lastIndex = 0;
        const found = regex.exec(normalizeText(field.value, rules.normalization));
        if (!found) continue;
        removals.push({
          ruleId: rule.id,
          target: rule.target,
          recommendation: rule.recommendation,
          risk: rule.risk,
          reason: rule.reason,
          matched: found[0],
          column: field.column,
          preserve: rule.preserve ?? null,
        });
      }
      continue;
    }

    throw new Error(`Unsupported removal rule match type: ${String(match.type)}`);
  }
  return removals;
}

function expectedExistingLabel(rule) {
  return String(rule.tagLabel ?? '').replace(/\s*相当\s*$/u, '').trim();
}

function alreadyHasTag(tags, rule, normalization) {
  const desiredId = normalizedComparable(rule.tagId, normalization);
  const desiredName = normalizedComparable(expectedExistingLabel(rule), normalization);
  const equivalentPatterns = rule.alreadySatisfiedBy?.tagNamePatterns ?? [];
  return tags.some((tag) => (
    (desiredId && normalizedComparable(tag.id, normalization) === desiredId)
    || (desiredName && normalizedComparable(tag.name, normalization) === desiredName)
    || equivalentPatterns.some((pattern) => {
      const regex = compilePattern(pattern);
      regex.lastIndex = 0;
      return regex.test(normalizeText(tag.name, normalization));
    })
  ));
}

function candidateAddition(rule) {
  return {
    ruleId: rule.id,
    tagId: rule.tagId,
    tagLabel: rule.tagLabel,
    recommendation: rule.recommendation,
    status: rule.status,
    autoApply: false,
    reason: rule.reason,
    evidence: null,
    tagSelectable: 'UNCONFIRMED',
    copyExpressionAllowed: false,
    requiresHumanVerification: true,
  };
}

function findMatchingCopyEvidence(job, evidence, normalization) {
  if (!evidence || evidence.source !== 'joblist_copy' || !Array.isArray(evidence.patterns)) return null;
  for (const field of fieldList(job, 'copy')) {
    if (!normalizeText(field.value, normalization)) continue;
    for (const pattern of evidence.patterns) {
      const regex = compilePattern(pattern);
      regex.lastIndex = 0;
      const match = regex.exec(normalizeText(field.value, normalization));
      if (match) {
        return {
          source: evidence.source,
          column: field.column,
          matched: match[0],
          evidenceStatus: field.evidenceStatus,
        };
      }
    }
  }
  return null;
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

function boundContractForJob(jobNumber, contract, config) {
  if (!contract) return null;
  const binding = config?.contract?.jobBindings?.[String(jobNumber)];
  const expectedIdentity = bindingIdentity(binding);
  if (!expectedIdentity) return null;
  if (!contractIdentityValues(contract).includes(expectedIdentity)) return null;
  return contract;
}

function contractField(contract, keys) {
  if (!Array.isArray(contract?.fields)) return null;
  const wanted = new Set(keys.filter(Boolean).map(String));
  return contract.fields.find((field) => field && wanted.has(String(field.key))) ?? null;
}

function confirmedContractEvidence(job, rule, contract, config, normalization) {
  const bound = boundContractForJob(job.jobNumber, contract, config);
  if (!bound) return null;
  const evidence = rule.evidence ?? {};
  const field = contractField(bound, [evidence.field, ...(evidence.fieldAliases ?? [])]);
  if (!field || Number(field.sourceRow) !== Number(evidence.row)) return null;
  if (field.evidenceStatus !== rule.status) return null;
  const value = normalizeText(field.value, normalization);
  const matched = (evidence.allowedPatterns ?? []).some((source) => {
    const pattern = typeof source === 'string' ? { source, flags: 'u' } : source;
    const regex = compilePattern(pattern);
    regex.lastIndex = 0;
    return regex.test(value);
  });
  if (!matched) return null;
  return {
    source: 'contract',
    key: field.key,
    sourceRow: field.sourceRow,
    sourceRange: field.sourceRange ?? null,
    value,
    evidenceStatus: field.evidenceStatus,
  };
}

function evaluateAdditions(job, currentTagsByCategory, rules, contract, config) {
  const additions = [];
  const tags = flattenTags(currentTagsByCategory);

  for (const rule of rules.additionRules) {
    if (alreadyHasTag(tags, rule, rules.normalization)) continue;

    if (rule.recommendation === 'PROPOSE_ONLY' && rule.status === 'CANDIDATE') {
      additions.push(candidateAddition(rule));
      continue;
    }

    if (rule.recommendation === 'ADD_IF_CONFIRMED') {
      const evidence = confirmedContractEvidence(job, rule, contract, config, rules.normalization);
      if (!evidence) continue;
      additions.push({
        ruleId: rule.id,
        tagId: rule.tagId,
        tagLabel: rule.tagLabel,
        recommendation: rule.recommendation,
        status: rule.status,
        autoApply: false,
        reason: rule.reason,
        evidence,
        tagSelectable: true,
        copyExpressionAllowed: true,
        requiresHumanVerification: false,
      });
      continue;
    }

    if (rule.recommendation === 'ADD_IF_EXTRACTED') {
      const evidence = findMatchingCopyEvidence(job, rule.evidence, rules.normalization);
      if (!evidence) continue;
      additions.push({
        ruleId: rule.id,
        tagId: rule.tagId,
        tagLabel: rule.tagLabel,
        recommendation: rule.recommendation,
        status: rule.status,
        autoApply: false,
        reason: rule.reason,
        evidence,
        tagSelectable: rule.tagId ? true : 'UNCONFIRMED',
        copyExpressionAllowed: true,
        requiresHumanVerification: rule.tagId == null,
      });
      continue;
    }

    throw new Error(`Unsupported addition recommendation: ${String(rule.recommendation)}`);
  }
  return additions;
}

function nonemptyValues(fields) {
  return fields
    .filter((field) => normalizeText(field.value).length > 0)
    .sort((left, right) => String(left.column).localeCompare(String(right.column)))
    .map((field) => `${field.column}=${normalizeText(field.value, { unicode: 'NFKC', trim: true })}`);
}

function configuredFields(job, category, columns) {
  const byColumn = mapFields(job, category);
  return columns.map((column) => byColumn.get(String(column).toUpperCase())).filter(Boolean);
}

function semanticFields(job, category, headerPattern) {
  return fieldList(job, category).filter((field) => headerPattern.test(String(field.header ?? '')));
}

function duplicateFactGroups(job, rules) {
  const references = rules.immutableReferences ?? {};
  return {
    actualWorkLocation: nonemptyValues(configuredFields(job, 'immutable', references.actualWorkLocationColumns ?? [])),
    employmentTypeAndConditions: nonemptyValues(configuredFields(job, 'immutable', references.employmentTypeColumns ?? [])),
    jobDuties: nonemptyValues(semanticFields(job, 'immutable', /occupation_id|^職種[123]/u)),
    shiftQualificationResponsibility: nonemptyValues(semanticFields(job, 'immutable', /working_style|勤務形態/u)),
  };
}

function copySignature(job, normalization) {
  const values = nonemptyValues(fieldList(job, 'copy'));
  return createHash('sha256').update(normalizeText(values.join('\n'), normalization)).digest('hex');
}

function duplicateSignature(job, rules) {
  const groups = duplicateFactGroups(job, rules);
  const requiredGroups = rules.duplicateGate.sameHiringSlotFactGroups ?? Object.keys(groups);
  const values = requiredGroups.map((group) => groups[group] ?? []);
  if (values.some((groupValues) => groupValues.length === 0)) return null;
  const serialized = JSON.stringify(values);
  return {
    hash: createHash('sha256').update(serialized).digest('hex').slice(0, 16),
    groups: requiredGroups,
  };
}

function findDuplicateCandidates(jobs, rules) {
  const grouped = new Map();
  for (const job of jobs) {
    const signature = duplicateSignature(job, rules);
    if (!signature) continue;
    const entry = grouped.get(signature.hash) ?? { signature, jobs: [] };
    entry.jobs.push(job);
    grouped.set(signature.hash, entry);
  }

  const candidates = [];
  for (const { signature, jobs: matchingJobs } of grouped.values()) {
    if (matchingJobs.length < 2) continue;
    const publishedJobs = matchingJobs.filter((job) => job.isPublished === true);
    const copySignatures = new Set(matchingJobs.map((job) => copySignature(job, rules.normalization)));
    const simultaneouslyPublished = publishedJobs.length >= 2;
    candidates.push({
      ruleId: rules.duplicateGate.id,
      signature: signature.hash,
      matchedFactGroups: signature.groups,
      jobNumbers: matchingJobs.map((job) => String(job.jobNumber)),
      publishedJobNumbers: publishedJobs.map((job) => String(job.jobNumber)),
      copyDiffers: copySignatures.size > 1,
      simultaneouslyPublished,
      risk: simultaneouslyPublished ? rules.duplicateGate.risk : 'REVIEW',
      humanReviewRequired: rules.duplicateGate.humanReviewRequired === true,
      detail: simultaneouslyPublished
        ? `同じ事実署名の掲載中求人が${publishedJobs.length}件ある。文面差だけの同一採用枠でないか人間が確認する`
        : '同じ事実署名の求人が複数ある。現在は同時掲載ではないが、再掲載前に同一採用枠でないか確認する',
      allowedSplitCriteria: rules.duplicateGate.allowedSplitCriteria,
    });
  }
  return candidates.sort((left, right) => left.jobNumbers[0].localeCompare(right.jobNumbers[0]));
}

function highestRisk(items) {
  return items.reduce((highest, item) => {
    const risk = typeof item === 'string' ? item : item?.risk;
    return (RISK_ORDER[risk] ?? 0) > (RISK_ORDER[highest] ?? 0) ? risk : highest;
  }, 'OK');
}

function countBy(items, selector) {
  const result = {};
  for (const item of items) {
    const key = String(selector(item));
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function createSummary(rows, duplicateCandidates) {
  const publishedRows = rows.filter((row) => row.isPublished);
  const issueCount = rows.reduce((count, row) => count + row.issues.length, 0);
  const publishedIssueCount = publishedRows.reduce((count, row) => count + row.issues.length, 0);
  return {
    jobCount: rows.length,
    publishedJobCount: publishedRows.length,
    rowsWithIssues: rows.filter((row) => row.issues.length > 0).length,
    publishedRowsWithIssues: publishedRows.filter((row) => row.issues.length > 0).length,
    issueCount,
    publishedIssueCount,
    removalCount: rows.reduce((count, row) => count + row.removals.length, 0),
    publishedRemovalCount: publishedRows.reduce((count, row) => count + row.removals.length, 0),
    additionCount: rows.reduce((count, row) => count + row.additions.length, 0),
    publishedAdditionCount: publishedRows.reduce((count, row) => count + row.additions.length, 0),
    riskCounts: countBy(rows, (row) => row.risk),
    publishedRiskCounts: countBy(publishedRows, (row) => row.risk),
    duplicateCandidateCount: duplicateCandidates.length,
    publishedDuplicateCandidateCount: duplicateCandidates.filter((candidate) => candidate.simultaneouslyPublished).length,
  };
}

function validateInput(normalized, clientId, config, contract) {
  if (!normalized || typeof normalized !== 'object' || !Array.isArray(normalized.jobs)) {
    throw new Error('Normalized input must contain jobs[].');
  }
  if (normalized.clientId !== clientId) {
    throw new Error(`Client mismatch: input is ${String(normalized.clientId)}, --client is ${clientId}.`);
  }
  if (config?.clientId !== clientId) {
    throw new Error(`Client mismatch: config is ${String(config?.clientId)}, --client is ${clientId}.`);
  }
  if (contract?.clientId != null && contract.clientId !== clientId) {
    throw new Error(`Client mismatch: contract is ${String(contract.clientId)}, --client is ${clientId}.`);
  }
  const numbers = normalized.jobs.map((job) => String(job?.jobNumber ?? ''));
  if (numbers.some((number) => number.length === 0)) throw new Error('Every normalized job must have jobNumber.');
  if (new Set(numbers).size !== numbers.length) throw new Error('Normalized input contains duplicate jobNumber values.');
}

export function auditNormalizedData(normalized, {
  clientId,
  config,
  rules,
  contract = null,
} = {}) {
  validateInput(normalized, clientId, config, contract);
  const rows = normalized.jobs.map((job) => {
    const { currentTagsByCategory, issues: pairIssues } = collectCurrentTags(job, rules);
    const removals = evaluateRemovals(job, currentTagsByCategory, rules);
    const additions = evaluateAdditions(job, currentTagsByCategory, rules, contract, config);
    const removalIssues = removals.map((removal) => makeRemovalIssue(job, removal));
    return {
      jobNumber: String(job.jobNumber),
      approvalStatus: job.approvalStatus ?? '',
      publicationStatus: job.publicationStatus ?? '',
      isPublished: job.isPublished === true,
      currentTagsByCategory,
      removals,
      additions,
      risk: 'OK',
      issues: [...pairIssues, ...removalIssues],
    };
  });

  const rowsByJobNumber = new Map(rows.map((row) => [row.jobNumber, row]));
  const duplicateCandidates = findDuplicateCandidates(normalized.jobs, rules);
  for (const candidate of duplicateCandidates) {
    for (const jobNumber of candidate.jobNumbers) {
      const row = rowsByJobNumber.get(jobNumber);
      if (!row) continue;
      row.issues.push({
        ruleId: candidate.ruleId,
        risk: candidate.risk,
        jobNumber,
        matchedJobNumbers: candidate.jobNumbers.filter((number) => number !== jobNumber),
        copyDiffers: candidate.copyDiffers,
        detail: candidate.detail,
      });
    }
  }
  for (const row of rows) row.risk = highestRisk(row.issues);

  const preserve = rules.removalRules.find((rule) => rule.preserve)?.preserve ?? null;
  return {
    schemaVersion: '1.0.0',
    clientId,
    inputSource: normalized.source ?? null,
    contractSource: contract?.source ?? null,
    summary: createSummary(rows, duplicateCandidates),
    rows,
    duplicateCandidates,
    policy: {
      preserveAgeRestriction: preserve,
      textExpressionPolicy: rules.textExpressionPolicy,
      duplicateGate: rules.duplicateGate,
      abTestPolicy: rules.abTestPolicy,
    },
    notes: [
      `${preserve?.column ?? 'AZ'} 年齢の制限=なしを維持するため、削除推奨後も応募資格は全年齢のまま。変えるのは検索露出とメッセージの向き先だけ。`,
      'タグとして選択できることと、本文に表現できることは別。CANDIDATEは提案のみで自動付与せず、文面生成の根拠に使わない。',
      '同一求人のA/B案は同時掲載せず、前半2週間をA案、後半2週間をB案として期間で分ける。',
      '競合の同一求人3本同時投下は、掲載枠コスト・Airワーク §5-3・応募管理上の問題があるため真似しない。',
    ],
  };
}

function testField(column, value, header = '', evidenceStatus = 'EXTRACTED_JOBLIST') {
  return { column, header, value, evidenceStatus };
}

function makeTestJob({
  jobNumber,
  location,
  published = true,
  tagIdValue = '',
  tagNameValue = '',
  workEnvironmentTagId = '',
  workEnvironmentTagName = '',
  ax = '',
  bf = '',
}) {
  return {
    jobNumber,
    approvalStatus: '03',
    publicationStatus: published ? '02' : '01',
    isPublished: published,
    copy: [
      testField('AX', ax, '求める人材(personal)'),
      testField('BF', bf, '求人キャッチコピー(subtitle)'),
      testField('O', `確認済みの仕事内容 ${jobNumber}`, '仕事内容(description)'),
    ],
    tags: [
      testField('HT', tagIdValue, '選考の流れID(selection_flow_id)'),
      testField('HU', tagNameValue, '選考の流れ(selection_flow_id_name)'),
      testField('AQ', workEnvironmentTagId, '職場環境ID(work_environment_id)'),
      testField('AR', workEnvironmentTagName, '職場環境(work_environment_id_name)'),
    ],
    immutable: [
      testField('E', '6', '雇用形態CD(job_type)'),
      testField('F', '派遣社員', '雇用形態(job_type_jp)'),
      testField('AF', location, '勤務地番号(working_location_id)'),
      testField('AJ', '愛知県', '勤務地都道府県(working_location_prefecture)'),
      testField('AK', location, '勤務地市区町村(working_location_city_area)'),
      testField('I', 'occupation-test', '職種1CD(occupation_id_1)'),
      testField('J', '検査', '職種1(occupation_id_jp1)'),
      testField('CY', '01', '勤務形態CD(working_style)'),
      testField('CZ', '固定時間制', '勤務形態(working_style_jp)'),
      testField('AZ', 'なし', '年齢の制限(age_limit_jp)'),
    ],
  };
}

export function runSelfTests({ clientId, config, rules } = {}) {
  const tagRemovalRule = rules.removalRules.find((rule) => rule.match?.type === 'tag_id');
  const targetTagId = tagRemovalRule?.match?.values?.[0];
  const normalized = {
    version: 1,
    clientId,
    source: { type: 'SELF_TEST' },
    jobs: [
      makeTestJob({
        jobNumber: 'self-1',
        location: 'same-site',
        tagIdValue: targetTagId,
        tagNameValue: '60代も応募可',
        ax: '年齢不問',
        bf: '10代から60代まで活躍中',
      }),
      makeTestJob({
        jobNumber: 'self-2',
        location: 'different-site',
        tagIdValue: 'ID-A,ID-B',
        tagNameValue: '名称A',
        ax: '確認済み条件のみ',
        bf: '確認済み条件のみ',
      }),
      makeTestJob({
        jobNumber: 'self-3',
        location: 'same-site',
        tagIdValue: '',
        tagNameValue: '',
        ax: '別の表現による求める人材',
        bf: '別の表現によるキャッチコピー',
      }),
      makeTestJob({
        jobNumber: 'self-4',
        location: 'third-site',
        workEnvironmentTagId: 'D9PP2',
        workEnvironmentTagName: '未経験者歓迎',
        ax: '未経験者歓迎',
        bf: '確認済み条件のみ',
      }),
    ],
  };
  const result = auditNormalizedData(normalized, { clientId, config, rules });
  const first = result.rows.find((row) => row.jobNumber === 'self-1');
  const second = result.rows.find((row) => row.jobNumber === 'self-2');
  const fourth = result.rows.find((row) => row.jobNumber === 'self-4');
  const candidateAdditions = result.rows.flatMap((row) => row.additions).filter((addition) => addition.status === 'CANDIDATE');
  const cases = [
    {
      name: '削除3ルール',
      pass: first?.removals.length === 3 && new Set(first.removals.map((item) => item.ruleId)).size === 3,
      actual: first?.removals.map((item) => item.ruleId) ?? [],
    },
    {
      name: 'CANDIDATEは提案のみ・自動付与なし・本文利用不可',
      pass: candidateAdditions.length > 0 && candidateAdditions.every((item) => (
        item.autoApply === false
        && item.copyExpressionAllowed === false
        && item.requiresHumanVerification === true
        && typeof item.reason === 'string'
        && item.reason.length > 0
      )),
      actual: candidateAdditions.map((item) => ({ ruleId: item.ruleId, autoApply: item.autoApply, copyExpressionAllowed: item.copyExpressionAllowed })),
    },
    {
      name: 'タグIDと名称の件数不一致',
      pass: second?.issues.some((issue) => issue.ruleId === 'TAG_PAIR_CONFLICT' && issue.risk === 'CONFLICT') === true,
      actual: second?.issues.filter((issue) => issue.ruleId === 'TAG_PAIR_CONFLICT') ?? [],
    },
    {
      name: '同一事実署名・文面差の重複候補',
      pass: result.duplicateCandidates.some((candidate) => candidate.copyDiffers && candidate.simultaneouslyPublished && candidate.risk === 'HIGH_RISK'),
      actual: result.duplicateCandidates,
    },
    {
      name: '既存の未経験歓迎相当タグは重複提案しない',
      pass: fourth?.additions.some((item) => item.ruleId === 'TAG_ADD_INEXPERIENCED') === false,
      actual: fourth?.additions.map((item) => item.ruleId) ?? [],
    },
  ];
  return {
    ok: cases.every((testCase) => testCase.pass),
    passedCases: cases.filter((testCase) => testCase.pass).length,
    failedCases: cases.filter((testCase) => !testCase.pass).length,
    cases,
  };
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
    if (!['--input', '--contract', '--client', '--output'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function secureReadTmpJson(inputPath) {
  try {
    return JSON.parse(await secureReadTmpText(inputPath));
  } catch (error) {
    throw new Error(`Failed to read JSON ${inputPath}: ${error.message}`, { cause: error });
  }
}

async function secureWriteTmpJson(outputPath, value) {
  return secureWriteTmpFile(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write([
      'Usage:',
      '  node audit_tags.mjs --input <private-temp>/normalized.json [--contract <private-temp>/contract.json] --client <id> --output <private-temp>/raw.json',
      '  node audit_tags.mjs --client <id> --self-test',
      '',
    ].join('\n'));
    return;
  }
  if (!options.client) throw new Error('--client is required.');
  const references = await loadTagReferences(options.client);

  if (options.selfTest) {
    if (options.input || options.contract || options.output) {
      throw new Error('--self-test does not accept --input, --contract, or --output.');
    }
    const result = runSelfTests({ clientId: options.client, ...references });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!options.input) throw new Error('--input is required unless --self-test is used.');
  if (!options.output) throw new Error('--output is required unless --self-test is used.');
  const resolvedInput = path.resolve(options.input);
  const resolvedOutput = path.resolve(options.output);
  if (resolvedInput === resolvedOutput || (options.contract && path.resolve(options.contract) === resolvedOutput)) {
    throw new Error('Output must not overwrite the normalized or contract input.');
  }
  const [normalized, contract] = await Promise.all([
    secureReadTmpJson(options.input),
    options.contract ? secureReadTmpJson(options.contract) : Promise.resolve(null),
  ]);
  const report = {
    ...auditNormalizedData(normalized, {
      clientId: options.client,
      ...references,
      contract,
    }),
    generatedAt: new Date().toISOString(),
  };
  const outputPath = await secureWriteTmpJson(options.output, report);
  process.stdout.write(`${JSON.stringify({ outputPath, summary: report.summary }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`audit_tags: ${error.message}\n`);
    process.exitCode = 1;
  });
}
