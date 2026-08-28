#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TMP_ROOT, ensureSecureTmpDirectory, secureReadTmpText, secureWriteTmpFile } from './secure_tmp.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..');
const REFERENCES_DIR = path.join(SKILL_ROOT, 'references');
const PERSONAS_DIR = path.join(REFERENCES_DIR, 'personas');
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PRIORITY_ORDER = Object.freeze({ A: 0, B: 1, C: 2 });
const ANSWERED_STATUSES = new Set(['CONFIRMED_INTERNAL', 'PUBLIC_OFFICIAL']);

const PERSONA_QUESTIONS = Object.freeze({
  1: 'この職種に実際に応募した方について、よく見られた職歴・保有資格・希望勤務条件を、分かる範囲で教えてください。',
  2: '応募者から、求人を見た時間帯や見た場面について実際に聞いたことがあれば教えてください。',
  3: '前職を辞めた理由として、面談でよく聞く話を3つ教えてください。',
  4: '応募理由や仕事選びで重視することとして、面談で実際に聞いた希望を教えてください。',
  6: '応募を迷った方や見送った方から、実際に聞いた不安・迷い・辞退理由を教えてください。',
  8: '応募者の方はどの求人サイトを見て来られることが多いですか。スマホからですか。実際に確認できた範囲で教えてください。',
  9: '応募したのに面談に来なかった方の、直前の様子で気づいたことはありますか。連絡内容など、確認できた事実を教えてください。',
  10: '求人票のどの言葉に反応がありましたか。逆に不安がられた言葉はありますか。実際の発言があれば教えてください。',
  11: '仕事の説明・見学・研修について、応募者や就業者から実際に好評だった支援や、分かりにくいと言われた点を教えてください。',
});

function assertClientId(clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client id: ${String(clientId)}`);
  }
}

function resolveTmpPath(candidate, kind, allowTmpRoot = false) {
  if (typeof candidate !== 'string' || candidate.length === 0) throw new Error(`${kind} path is required.`);
  const resolved = path.resolve(candidate);
  const relative = path.relative(TMP_ROOT, resolved);
  const inside = relative === '' ? allowTmpRoot : relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!inside) throw new Error(`${kind} must be inside ${TMP_ROOT}: ${resolved}`);
  return resolved;
}

async function readTmpJson(inputPath) {
  try {
    return JSON.parse(await secureReadTmpText(inputPath));
  } catch (error) {
    throw new Error(`内容確認書JSONを読み込めません: ${inputPath}: ${error.message}`, { cause: error });
  }
}

async function writeTmpText(outputPath, content) {
  await ensureSecureTmpDirectory(path.dirname(outputPath));
  return secureWriteTmpFile(outputPath, content);
}

function formatTokyoDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseArguments(argv) {
  const options = {
    client: null,
    contract: null,
    outputDir: TMP_ROOT,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--self-test') {
      options.selfTest = true;
      continue;
    }
    if (['--client', '--contract', '--output-dir'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--client') options.client = value;
      if (argument === '--contract') options.contract = value;
      if (argument === '--output-dir') options.outputDir = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function parseAxisNames(markdown, family) {
  const result = new Map();
  for (const line of markdown.split(/\r?\n/u)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (!new RegExp(`^${family}\\d{3}$`, 'u').test(cells[0] ?? '')) continue;
    const name = family === 'V' ? cells[2] : cells[1];
    if (!name) throw new Error(`訴求軸${cells[0]}の日本語名を読み取れません。`);
    result.set(cells[0], name);
  }
  return result;
}

async function loadAxisNames() {
  const sources = [
    ['V', path.join(REFERENCES_DIR, 'value-axes.md')],
    ['R', path.join(REFERENCES_DIR, 'recruit-axes.md')],
    ['S', path.join(REFERENCES_DIR, 'expression-frames.md')],
  ];
  const axisNames = new Map();
  for (const [family, sourcePath] of sources) {
    const parsed = parseAxisNames(await readFile(sourcePath, 'utf8'), family);
    if (parsed.size === 0) throw new Error(`${family}系の訴求軸を読み取れません: ${sourcePath}`);
    for (const [id, name] of parsed) axisNames.set(id, name);
  }
  return axisNames;
}

function parsePersonaSchema(markdown) {
  const chapters = new Map();
  for (const line of markdown.split(/\r?\n/u)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (!/^\d+$/u.test(cells[0] ?? '')) continue;
    const number = Number(cells[0]);
    if (number >= 1 && number <= 11 && cells[1]) chapters.set(number, cells[1]);
  }
  if (chapters.size !== 11) {
    throw new Error(`ペルソナスキーマは11章必要です。読み取れた章数: ${chapters.size}`);
  }
  return chapters;
}

async function loadSkeletonPersonas() {
  const schemaText = await readFile(path.join(PERSONAS_DIR, '_schema.md'), 'utf8');
  const chapters = parsePersonaSchema(schemaText);
  const entries = await readdir(PERSONAS_DIR, { withFileTypes: true });
  const personas = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'ja'))) {
    if (!entry.isFile() || entry.name === '_schema.md' || !entry.name.endsWith('.md')) continue;
    const content = await readFile(path.join(PERSONAS_DIR, entry.name), 'utf8');
    if (!/^status:\s*skeleton\s*$/mu.test(content)) continue;
    const title = content.match(/^#\s+(.+)$/mu)?.[1]?.trim();
    if (!title) throw new Error(`骨格ペルソナの名前を読み取れません: ${entry.name}`);
    personas.push({ fileName: entry.name, title });
  }
  return { chapters, personas };
}

function validateContractMap(contractMap, clientId, axisNames) {
  if (!contractMap || typeof contractMap !== 'object' || Array.isArray(contractMap)) {
    throw new Error('contract-map.json must contain an object.');
  }
  if (contractMap.clientId !== clientId) {
    throw new Error(`contract-map clientId mismatch: expected ${clientId}, actual ${String(contractMap.clientId)}`);
  }
  if (!Array.isArray(contractMap.fields) || contractMap.fields.length === 0) {
    throw new Error('contract-map.json fields[] is required.');
  }
  const keys = new Set();
  return contractMap.fields.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error('contract-map field must be an object.');
    if (typeof field.key !== 'string' || keys.has(field.key)) throw new Error(`Invalid or duplicate contract-map key: ${String(field.key)}`);
    keys.add(field.key);
    if (!Object.hasOwn(PRIORITY_ORDER, field.priority)) throw new Error(`${field.key}: priority must be A, B, or C.`);
    if (typeof field.askAs !== 'string' || field.askAs.trim().length === 0) throw new Error(`${field.key}: askAs is required.`);
    if (!Array.isArray(field.unlocks) || field.unlocks.some((id) => typeof id !== 'string')) {
      throw new Error(`${field.key}: unlocks must be a string array.`);
    }
    for (const id of field.unlocks) {
      if (!axisNames.has(id)) throw new Error(`${field.key}: unknown appeal axis id ${id}.`);
    }
    if (!Number.isInteger(field.sourceRow) || field.sourceRow <= 0 || field.sourceRow === 35) {
      throw new Error(`${field.key}: sourceRow must be a positive integer other than 35.`);
    }
    if (!Array.isArray(field.sourceRanges) || field.sourceRanges.length === 0) {
      throw new Error(`${field.key}: sourceRanges[] is required.`);
    }
    return field;
  });
}

function sanitizeTableCell(value) {
  return String(value ?? '')
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, '<br>');
}

function formatSourceRange(sourceRange) {
  const match = String(sourceRange).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/u);
  if (!match) return sourceRange;
  const [, startColumn, startRow, endColumn, endRow] = match;
  const rows = startRow === endRow ? `行${startRow}` : `行${startRow}〜${endRow}`;
  const columns = startColumn === endColumn ? `${startColumn}列` : `${startColumn}〜${endColumn}列`;
  return `${rows} ${columns}`;
}

function formatFieldLocation(field) {
  return field.sourceRanges.map(formatSourceRange).join('／');
}

function formatUnlocks(unlocks, axisNames) {
  if (unlocks.length === 0) return '確認済みの参照情報として整理できます（直接ひも付く訴求軸は未設定）';
  return unlocks.map((id) => `${id}（${axisNames.get(id)}）`).join('、');
}

function contractStatusByKey(contract) {
  if (contract == null) return new Map();
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || !Array.isArray(contract.fields)) {
    throw new Error('内容確認書JSONには fields[] が必要です。');
  }
  const byKey = new Map();
  for (const field of contract.fields) {
    if (!field || typeof field.key !== 'string') throw new Error('内容確認書JSONの各fieldにはkeyが必要です。');
    if (byKey.has(field.key)) throw new Error(`内容確認書JSONに重複キーがあります: ${field.key}`);
    byKey.set(field.key, {
      evidenceStatus: typeof field.evidenceStatus === 'string' ? field.evidenceStatus : 'MISSING',
      value: typeof field.value === 'string' ? field.value : '',
    });
  }
  return byKey;
}

function isAnswered(contractField) {
  return Boolean(
    contractField
    && ANSWERED_STATUSES.has(contractField.evidenceStatus)
    && contractField.value.trim().length > 0,
  );
}

function formatCurrentStatus(contractField) {
  const status = contractField?.evidenceStatus ?? 'MISSING';
  const labels = {
    MISSING: '未回答',
    CONFIRMED_INTERNAL: '社内確認済み',
    PUBLIC_OFFICIAL: '公開情報で確認済み',
    CANDIDATE: '裏取り待ち',
    CONFLICT: '回答の食い違いあり',
    EXTRACTED_JOBLIST: '求人票から抽出',
  };
  return `${labels[status] ?? '状態要確認'}（${status}）`;
}

function buildContractSection(fields, contract, axisNames) {
  const statusByKey = contractStatusByKey(contract);
  const pending = fields
    .filter((field) => !isAnswered(statusByKey.get(field.key)))
    .sort((left, right) => (
      PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
      || left.sourceRow - right.sourceRow
      || left.key.localeCompare(right.key)
    ));
  const priorityACount = pending.filter((field) => field.priority === 'A').length;
  const lines = [
    '## 1. 内容確認書で埋めてほしい項目',
    '',
    `優先度Aの項目だけでも埋まれば、訴求案の質が大きく変わります。現在の優先度Aは **${priorityACount}件** です。`,
    '',
    '状態表示の意味：`MISSING`は未回答、`CANDIDATE`は裏取り待ち、`CONFLICT`は回答の食い違い、`CONFIRMED_INTERNAL`は社内確認済みです。',
    '',
  ];
  if (pending.length === 0) {
    lines.push('現在、内容確認書について追加でお願いする項目はありません。', '');
    return { lines, pending, priorityACount };
  }
  lines.push(
    '| 優先度 | 何を聞くか | 記入場所 | これが埋まると | 現在の状態 |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const field of pending) {
    lines.push(`| ${field.priority} | ${sanitizeTableCell(field.askAs)} | ${sanitizeTableCell(formatFieldLocation(field))} | ${sanitizeTableCell(formatUnlocks(field.unlocks, axisNames))} | ${sanitizeTableCell(formatCurrentStatus(statusByKey.get(field.key)))} |`);
  }
  lines.push('');
  return { lines, pending, priorityACount };
}

function buildPersonaSection(personaData) {
  const lines = [
    '## 2. ペルソナを確定するための質問',
    '',
    '推測ではなく、応募対応・面談・就業後のやり取りで実際に見聞きした事実だけを、分かる範囲でご回答ください。',
    '',
  ];
  if (personaData.personas.length === 0) {
    lines.push('現在、確認対象の骨格ペルソナはありません。', '');
    return lines;
  }
  const chapterNumbers = Object.keys(PERSONA_QUESTIONS).map(Number).sort((a, b) => a - b);
  for (const persona of personaData.personas) {
    lines.push(
      `### ${persona.title}`,
      '',
      '| 章 | ご質問 | ご回答欄 |',
      '| --- | --- | --- |',
    );
    for (const chapterNumber of chapterNumbers) {
      const chapterName = personaData.chapters.get(chapterNumber);
      if (!chapterName) throw new Error(`ペルソナスキーマに第${chapterNumber}章がありません。`);
      lines.push(`| ${chapterNumber}. ${sanitizeTableCell(chapterName)} | ${sanitizeTableCell(PERSONA_QUESTIONS[chapterNumber])} |  |`);
    }
    lines.push('');
  }
  return lines;
}

function buildAirWorkSection(limits) {
  const sourcePriority = limits?.canonicalSource?.priority;
  if (!Array.isArray(sourcePriority) || sourcePriority.length === 0 || sourcePriority.some((item) => typeof item !== 'string')) {
    throw new Error('limits.json canonicalSource.priority[] is required.');
  }
  const bf = limits?.columns?.BF;
  const ax = limits?.columns?.AX;
  if (!bf || !ax) throw new Error('limits.json columns.BF and columns.AX are required.');
  return [
    '## 3. AirWork管理画面で確認してほしいこと',
    '',
    '### 3-1. タグの選択可否（未決#3）',
    '',
    '- FooT様の管理画面で、派遣求人の求人編集画面を開いてください。',
    '- タグ選択欄に「20代が多い」「30代が多い」に相当するタグがあるか確認してください。',
    '- 選択できる場合は、タグIDと画面上の正式名称を記録してください。',
    '- 選択後にAirWorkの審査を通過するかも確認してください。タグが選べることと、求人本文に同様の表現を書けることは別です。',
    '- 必要な理由：Phase 3のタグ診断では全11件にこのタグを「裏取り待ちの候補」として提案しています。確認できるまで自動付与はしません。',
    '',
    '| 確認項目 | ご回答欄 |',
    '| --- | --- |',
    '| 「20代が多い」相当タグを選べるか |  |',
    '| そのタグID・正式名称 |  |',
    '| 「30代が多い」相当タグを選べるか |  |',
    '| そのタグID・正式名称 |  |',
    '| 選択後に審査を通過したか |  |',
    '',
    '### 3-2. 文字数の実数上限（未決#4）',
    '',
    `現在の文字数上限はすべて暫定値です。特にBF（求人キャッチコピー）は暫定${bf.max}文字、AX（求める人材）は暫定${ax.max}文字として検査しています。次の順番で確認してください。`,
    '',
    ...sourcePriority.map((item, index) => `${index + 1}. ${item}`),
    '',
    '| 確認項目 | 確認できた上限・出典 |',
    '| --- | --- |',
    '| BF（求人キャッチコピー）の実数上限 |  |',
    '| AX（求める人材）の実数上限 |  |',
    '| その他、画面で確認できた列の上限 |  |',
    '',
  ];
}

function buildMeasurementSection() {
  return [
    '## 4. 効果測定で取れる数字（未決#13）',
    '',
    'A/B案の勝敗を何で判断できるか決めるため、AirWorkまたはIndeedの管理画面で次の数字を確認してください。',
    '',
    '| 確認項目 | 見られるか | 確認方法・補足 |',
    '| --- | --- | --- |',
    '| 求人ごとの表示回数（求人が画面に表示された回数） |  |  |',
    '| 求人ごとのクリック数 |  |  |',
    '| 求人単位の応募数 |  |  |',
    '| 期間を指定した絞り込み |  |  |',
    '| CSV形式でのダウンロード |  |  |',
    '',
    '何が取得できるか分からないままでは、A/B案の勝敗基準を決められません。確認できた画面名や操作手順も、分かる範囲で記入してください。',
    '',
  ];
}

function buildRequestMarkdown({
  clientId,
  fields,
  contract,
  axisNames,
  personaData,
  limits,
  generationDate,
}) {
  const contractSection = buildContractSection(fields, contract, axisNames);
  const lines = [
    `# 不足データ確認依頼書（${clientId}）`,
    '',
    `回答期限の目安：${generationDate}から1週間以内。分かる範囲で構いません。`,
    '',
    '求人の条件を推測せず、確認できた事実だけを訴求案へ反映するための依頼書です。空欄のままでも構いませんので、確認できた項目からご記入ください。',
    '',
    ...contractSection.lines,
    ...buildPersonaSection(personaData),
    ...buildAirWorkSection(limits),
    ...buildMeasurementSection(),
    '---',
    '',
    `この依頼書は自動生成です。生成日: ${generationDate}`,
    '',
  ];
  return {
    markdown: lines.join('\n'),
    pendingFields: contractSection.pending,
    priorityACount: contractSection.priorityACount,
  };
}

async function loadProductionInputs(clientId) {
  assertClientId(clientId);
  const clientDirectory = path.join(REFERENCES_DIR, 'clients', clientId);
  const [contractMap, limits, axisNames, personaData] = await Promise.all([
    readJson(path.join(clientDirectory, 'contract-map.json'), 'contract-map.json'),
    readJson(path.join(clientDirectory, 'limits.json'), 'limits.json'),
    loadAxisNames(),
    loadSkeletonPersonas(),
  ]);
  const fields = validateContractMap(contractMap, clientId, axisNames);
  return { fields, limits, axisNames, personaData };
}

async function generateRequest(options) {
  assertClientId(options.client);
  const outputDirectory = resolveTmpPath(options.outputDir, 'Output directory', true);
  await ensureSecureTmpDirectory(outputDirectory);
  const contract = options.contract ? await readTmpJson(options.contract) : null;
  if (contract?.clientId && contract.clientId !== options.client) {
    throw new Error(`内容確認書JSONのclientIdが一致しません: --client=${options.client}, JSON=${contract.clientId}`);
  }
  const production = await loadProductionInputs(options.client);
  const generationDate = formatTokyoDate();
  const result = buildRequestMarkdown({
    clientId: options.client,
    contract,
    generationDate,
    ...production,
  });
  const outputPath = path.join(outputDirectory, `data_request_${options.client}_${generationDate.replaceAll('-', '')}.md`);
  await writeTmpText(outputPath, result.markdown);
  return {
    outputPath,
    pendingFields: result.pendingFields.length,
    priorityACount: result.priorityACount,
    excludedAnsweredFields: production.fields.length - result.pendingFields.length,
    skeletonPersonas: production.personaData.personas.length,
  };
}

function fixtureAxisNames() {
  return new Map([
    ['R018', '残業の少なさ'],
    ['R047', '仕事内容の明確さ'],
  ]);
}

function fixtureFields() {
  return [
    {
      key: 'workSummary',
      label: '業務内容',
      sourceRow: 31,
      sourceRanges: ['B31:T31'],
      priority: 'A',
      unlocks: ['R047'],
      askAs: '実際の業務内容を教えてください。',
    },
    {
      key: 'monthlyOvertimeHours',
      label: '残業時間',
      sourceRow: 33,
      sourceRanges: ['N33:T33'],
      priority: 'B',
      unlocks: ['R018'],
      askAs: '月あたりの平均残業時間を教えてください。',
    },
    {
      key: 'companyName',
      label: '企業名',
      sourceRow: 10,
      sourceRanges: ['B10:X10'],
      priority: 'C',
      unlocks: [],
      askAs: '派遣先企業名を教えてください。',
    },
  ];
}

function fixturePersonaData() {
  return {
    chapters: new Map([
      [1, '一枚サマリー'],
      [2, '表の顔と裏の顔'],
      [3, '7つの痛み'],
      [4, '本音の欲求'],
      [5, '行動原理と深層心理'],
      [6, '自己破壊ループ'],
      [7, '恐怖と表裏一体の強み'],
      [8, '情報収集・検索行動'],
      [9, '購買行動'],
      [10, '言葉への反応'],
      [11, '学び方・助けられ方の好み'],
    ]),
    personas: [{ fileName: 'test.md', title: 'テスト用骨格ペルソナ' }],
  };
}

function fixtureLimits() {
  return {
    canonicalSource: { priority: ['確認手順A', '確認手順B'] },
    columns: {
      BF: { max: 100 },
      AX: { max: 2000 },
    },
  };
}

async function runSelfTest() {
  const cases = [];
  const check = (name, condition, details = '') => {
    cases.push({ name, passed: Boolean(condition), details });
  };
  const fields = fixtureFields();
  const axisNames = fixtureAxisNames();
  const common = {
    clientId: 'foot',
    fields,
    axisNames,
    personaData: fixturePersonaData(),
    limits: fixtureLimits(),
    generationDate: '2026-07-30',
  };

  const withoutContract = buildRequestMarkdown({ ...common, contract: null });
  check('contract omitted lists every field', withoutContract.pendingFields.length === 3);
  check('priority A is listed before B and C', withoutContract.pendingFields.map((field) => field.priority).join('') === 'ABC');
  check('axis id includes its Japanese name', withoutContract.markdown.includes('R047（仕事内容の明確さ）'));
  check('persona chapter 5 is not emitted', !withoutContract.markdown.includes('行動原理と深層心理'));
  check('persona chapter 7 is not emitted', !withoutContract.markdown.includes('恐怖と表裏一体の強み'));
  check('persona questions request observed facts', withoutContract.markdown.includes('実際に見聞きした事実') && !withoutContract.markdown.includes('20代の応募者はどう思っていますか'));
  check('exactly four numbered output sections', (withoutContract.markdown.match(/^## \d+\./gmu) ?? []).length === 4);

  const partlyAnswered = buildRequestMarkdown({
    ...common,
    contract: {
      fields: [
        { key: 'workSummary', value: '部品の検査', evidenceStatus: 'CONFIRMED_INTERNAL' },
        { key: 'monthlyOvertimeHours', value: '10時間', evidenceStatus: 'CANDIDATE' },
      ],
    },
  });
  check('confirmed field is excluded', !partlyAnswered.pendingFields.some((field) => field.key === 'workSummary'));
  check('candidate field remains unanswered', partlyAnswered.pendingFields.some((field) => field.key === 'monthlyOvertimeHours'));
  check('confirmed value is not copied into request', !partlyAnswered.markdown.includes('部品の検査'));

  let outsideTmpRejected = false;
  try {
    resolveTmpPath('/var/tmp/request.md', 'Output');
  } catch {
    outsideTmpRejected = true;
  }
  check('output outside /tmp is rejected', outsideTmpRejected);

  const tmpDirectory = await mkdtemp(path.join(TMP_ROOT, 'job-copy-request-selftest-'));
  try {
    const outputPath = path.join(tmpDirectory, 'data_request_foot_20260730.md');
    await writeTmpText(outputPath, withoutContract.markdown);
    const roundTrip = await readFile(outputPath, 'utf8');
    const mode = (await lstat(outputPath)).mode & 0o777;
    check('output round trip preserves markdown', roundTrip === withoutContract.markdown);
    check('output permission is 0600', mode === 0o600, mode.toString(8));
  } finally {
    await rm(tmpDirectory, { recursive: true, force: true });
  }

  const production = await loadProductionInputs('foot');
  check('production contract map has request metadata', production.fields.length > 0);
  check('production skeleton personas are readable', production.personaData.personas.length > 0);

  const failedCases = cases.filter((testCase) => !testCase.passed);
  const result = {
    ok: failedCases.length === 0,
    passedCases: cases.length - failedCases.length,
    failedCases: failedCases.length,
    cases,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

function printUsage() {
  process.stdout.write(
    'Usage:\n'
    + '  node scripts/make_request_sheet.mjs --client foot [--contract <private-temp>/contract.json] [--output-dir <private-temp>]\n'
    + '  node scripts/make_request_sheet.mjs --self-test\n',
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (options.selfTest) {
    if (options.client || options.contract || options.outputDir !== TMP_ROOT) {
      throw new Error('--self-test cannot be combined with other options.');
    }
    await runSelfTest();
    return;
  }
  if (!options.client) throw new Error('--client is required.');
  const result = await generateRequest(options);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`make_request_sheet: ${error.message}\n`);
  process.exitCode = 1;
});
