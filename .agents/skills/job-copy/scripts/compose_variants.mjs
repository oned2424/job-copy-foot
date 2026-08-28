#!/usr/bin/env node

/**
 * 対象求人1本ぶんの A〜E 5案を組む。
 *
 * generate_variants.mjs との違い:
 *   - 掲載中の全求人ではなく、--job で指定した1本だけを扱う
 *   - 兄弟求人から集めた素材（siblings.json）を実際に本文へ流す
 *   - 案で変わる4欄だけでなく、15欄すべてを生成する
 *
 * 素材は sibling_material.mjs が「本文に使ってよいか」を判定したものだけ通す。
 * 文そのものは compose_fields.mjs の定型から出す。素材の文は連結しない。
 *
 * 入出力は /tmp のみ。実データを Drive 配下に置かない。
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  classifyAll,
  tagMaterials,
  blockedMaterials,
  selfTest as materialSelfTest,
} from './lib/sibling_material.mjs';
import {
  buildFactSheet,
  composeVariants,
  composeFactFields,
  len,
  clean,
  selfTest as fieldsSelfTest,
} from './lib/compose_fields.mjs';
import { TMP_ROOT, secureReadTmpText, secureWriteTmpFile } from './secure_tmp.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// No.23（職場環境タグ）のうち、年代タグだけは根拠の要件が違う。
// 「20代・30代に来てほしい」は採用側の希望であって現場の事実ではないので根拠にならない。
// 使ってよいのは (1) ヒアリングで年齢構成の回答が返った (2) 同一事業所の媒体データに記述がある の2つだけ。
// 「30代、40代、50代が活躍中」のように1文へ複数の年代が入る。全部拾う。
const AGE_TAG = /([0-9０-９]{2})\s*代/gu;

function agesIn(text) {
  return [...String(text).matchAll(AGE_TAG)]
    .map((m) => m[1].normalize('NFKC'))
    .filter((n) => Number(n) >= 10 && Number(n) <= 60);
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

export async function loadFieldRoles() {
  const markdown = await readFile(path.join(SKILL_ROOT, 'references', 'appeal-formula.md'), 'utf8');
  const rules = parseMarkedJson(markdown, 'JOB_COPY_APPEAL_RULES_START', 'JOB_COPY_APPEAL_RULES_END');
  const roles = rules?.fieldTargets?.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('appeal-formula.md fieldTargets.roles is required.');
  }
  return roles;
}

// 年代タグの候補を、根拠つきで返す。根拠が無い年代は返さない。
export function buildAgeTags(materials, hearingAges = []) {
  const found = new Map();
  for (const age of hearingAges) {
    for (const n of agesIn(age)) {
      if (!found.has(n)) found.set(n, { tag: `${n}代が多い`, provenance: '確認済み', evidence: String(age) });
    }
  }
  for (const m of tagMaterials(materials)) {
    for (const n of agesIn(m.text)) {
      if (!found.has(n)) found.set(n, { tag: `${n}代が多い`, provenance: '媒体データ', evidence: m.text, jobs: m.jobs });
    }
  }
  return [...found.values()].sort((a, b) => Number(a.tag.slice(0, 2)) - Number(b.tag.slice(0, 2)));
}

export function buildTagField(f, materials, hearingAges) {
  const tags = [...f.currentTags];
  const ages = buildAgeTags(materials, hearingAges);
  for (const a of ages) if (!tags.includes(a.tag)) tags.push(a.tag);
  if (f.licenses.length && !tags.includes('有資格者歓迎')) tags.push('有資格者歓迎');
  return { value: tags.join(','), ageEvidence: ages };
}

// 目標字数に届かない欄と、そもそも書けなかった欄を、理由つきで並べる。
// 本文に「未確認のため」と書く代わりにここへ出す。応募者に見せる文ではないため。
export function buildShortfalls(roles, fields) {
  const out = [];
  for (const role of roles) {
    const no = String(role.itemNo);
    const value = fields[no] ?? '';
    if (role.askIfEmpty === false) continue;
    if (!value) {
      out.push({ itemNo: no, label: role.label, reason: '根拠が無いため生成していません', have: 0, targetMin: role.targetMin });
      continue;
    }
    if (value === '__REVIEW__') {
      out.push({ itemNo: no, label: role.label, reason: '現在値の裏が取れないため人の判断へ回しました', have: 0, targetMin: role.targetMin });
      continue;
    }
    const have = len(value);
    if (have < role.targetMin) {
      out.push({ itemNo: no, label: role.label, reason: '使える根拠がこれだけでした', have, targetMin: role.targetMin });
    }
  }
  return out;
}

export async function composeForJob({ job, current, siblings, request, hearingAges = [] }) {
  const roles = await loadFieldRoles();
  const materials = classifyAll(siblings, {
    targetJobNumber: String(job),
    targetJobTitle: clean(current?.title ?? ''),
  });
  const f = buildFactSheet({ current, request, materials });
  const factFields = composeFactFields(f);
  const tag = buildTagField(f, materials, hearingAges);
  const common = { ...factFields, 23: tag.value };
  const variants = composeVariants(f).map((v) => ({
    ...v,
    fields: { ...v.fields },
    charCount: Object.fromEntries(Object.entries(v.fields).map(([k, t]) => [k, len(t)])),
  }));

  return {
    job: String(job),
    common,
    variants,
    meta: {
      materialCount: materials.length,
      usableCount: materials.filter((m) => m.usable).length,
      tagOnlyCount: tagMaterials(materials).length,
      blocked: blockedMaterials(materials).map((m) => ({ text: m.text, reasons: m.reasons })),
      ageEvidence: tag.ageEvidence,
      // 本文の根拠になった文をそのまま残す。
      // 事実チェック（generate_variants.mjs の factIntegrityIssues）は
      // 「対象求人の現在値に無い事実＝捏造」と判定する作りなので、
      // 兄弟求人から借りた事実は、根拠を渡さないと必ず HIGH_RISK になる。
      // ここに出しておけば、確認済みテキストとして渡して照合できる。
      evidence: materials.filter((m) => m.usable).map((m) => m.text),
      shortfalls: variants.map((v) => ({
        variant: v.id,
        items: buildShortfalls(roles, { ...common, ...v.fields }),
      })),
    },
  };
}

// 選ばれた1案を apply_plan.py が読む形（欄番号 → 値）に落とす。
// 「B案でいくがキャッチはD案」の差し替え指定。'33:D,7:A' の形。
// 手で plan.json を開いて書き換える運用にすると、貼り間違い・案の取り違えが
// 誰にも気づかれずにドキュメントまで通る。指定として受け取って機械が入れ替える。
export function parseFieldPicks(spec) {
  const picks = {};
  for (const part of String(spec ?? '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^([0-9]+):([A-Za-z])$/u);
    if (!m) throw new Error(`--field の書き方が違います: 「${s}」。「33:D」のように No.:案 で書いてください`);
    picks[m[1]] = m[2].toUpperCase();
  }
  return picks;
}

export function toPlan(result, variantId, fieldSpec = '') {
  const pick = (id) => {
    const v = result.variants.find((x) => x.id === id);
    if (!v) throw new Error(`Unknown variant: ${id}`);
    return v;
  };
  const base = pick(variantId);
  const plan = { ...result.common, ...base.fields };

  for (const [no, id] of Object.entries(parseFieldPicks(fieldSpec))) {
    const donor = pick(id);
    // 共通欄（5案とも同じ事実欄）を差し替え先に選ぶのは、案を取り違えている。
    if (!(no in base.fields)) {
      throw new Error(`No.${no} は案ごとに変わる欄ではありません。--field で差し替えられるのは `
        + `${Object.keys(base.fields).map((k) => `No.${k}`).join('・')} です`);
    }
    // 取り出し元にその欄が無いまま代入すると undefined が入り、JSON にしたときに
    // 欄ごと消える。「差し替えました」と表示された欄が原稿から抜けるのが一番まずい。
    if (!(no in donor.fields)) {
      throw new Error(`No.${no} は ${id}案 にありません。候補ファイルが壊れています`);
    }
    plan[no] = donor.fields[no];
  }

  // 生成できなかった欄は plan から外す。空文字を渡すと apply_plan.py が
  // 「書けなかった＝現在値を残す」と解釈するので、それが正しい振る舞いになる。
  for (const [k, val] of Object.entries(plan)) if (val === '') delete plan[k];
  return plan;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

async function readJsonFromTmp(p) {
  return JSON.parse(await secureReadTmpText(p));
}

export function selfTest() {
  // lib 2本は単体で起動しないので、ここから呼ばないと誰も回さないまま壊れる。
  // どちらのファイルの失敗か分かるように接頭辞を付ける。
  const failures = [
    ...materialSelfTest().map((n) => `sibling_material: ${n}`),
    ...fieldsSelfTest().map((n) => `compose_fields: ${n}`),
  ];
  const t = (name, ok) => { if (!ok) failures.push(name); };

  const ages = buildAgeTags(
    [{ text: '20代のスタッフが中心です', usable: false, display: 'tag', jobs: ['1'] },
      { text: '30代が多い職場', usable: false, display: 'tag', jobs: ['2'] },
      { text: '未経験歓迎', usable: true, display: 'body', jobs: ['3'] }],
    [],
  );
  t('媒体データから年代タグを2件出す', ages.length === 2 && ages.every((a) => a.provenance === '媒体データ'));
  t('本文可の素材から年代タグを作らない', !ages.some((a) => /未経験/u.test(a.evidence)));

  const hearing = buildAgeTags([], ['40代が中心']);
  t('ヒアリング回答は確認済みラベルになる', hearing.length === 1 && hearing[0].provenance === '確認済み' && hearing[0].tag === '40代が多い');

  const noAge = buildAgeTags([{ text: '20代・30代に来てほしい', usable: false, display: 'internal', jobs: ['1'] }], []);
  t('社内メモ扱いの希望は年代タグにしない', noAge.length === 0);

  const roles = [
    { itemNo: 7, label: '仕事内容', targetMin: 400, askIfEmpty: true },
    { itemNo: 95, label: '社会保険の理由', targetMin: 0, askIfEmpty: false },
    { itemNo: 64, label: '給与例', targetMin: 40, askIfEmpty: true },
    { itemNo: 99, label: '契約更新期間', targetMin: 10, askIfEmpty: true },
  ];
  const short = buildShortfalls(roles, { 7: 'あ'.repeat(100), 64: '__REVIEW__', 99: '' });
  t('目標未達を字数つきで報告する', short.some((s) => s.itemNo === '7' && s.have === 100 && s.targetMin === 400));
  t('__REVIEW__ は判断待ちとして報告する', short.some((s) => s.itemNo === '64' && /人の判断/u.test(s.reason)));
  t('空欄は根拠なしとして報告する', short.some((s) => s.itemNo === '99' && /根拠が無い/u.test(s.reason)));
  t('askIfEmpty:false の欄は報告しない', !short.some((s) => s.itemNo === '95'));

  const fake = {
    variants: [{ id: 'A', fields: { 3: '職種', 7: '本文', 33: '' } }],
    common: { 22: '禁煙です。', 153: '' },
  };
  const plan = toPlan(fake, 'A');
  t('選んだ案と共通欄を1つの plan にまとめる', plan['3'] === '職種' && plan['22'] === '禁煙です。');
  t('空欄は plan に入れない', !('33' in plan) && !('153' in plan));

  let threw = false;
  try { toPlan(fake, 'Z'); } catch { threw = true; }
  t('存在しない案を選んだら止める', threw);

  // --- 組み合わせ選択（「B案でいくがキャッチはD案」）--------------------
  // 手で plan.json を書き換えていた頃の手順を機械に移した分の回帰テスト。
  const two = {
    variants: [
      { id: 'B', fields: { 3: 'B職種', 7: 'B本文', 33: 'Bキャッチ' } },
      { id: 'D', fields: { 3: 'D職種', 7: 'D本文', 33: 'Dキャッチ' } },
    ],
    common: { 22: '禁煙です。' },
  };
  const mixed = toPlan(two, 'B', '33:D');
  t('指定した欄だけ別の案から取る', mixed['33'] === 'Dキャッチ');
  t('指定しなかった欄は選んだ案のまま', mixed['3'] === 'B職種' && mixed['7'] === 'B本文');
  t('共通欄は差し替えの影響を受けない', mixed['22'] === '禁煙です。');

  const many = toPlan(two, 'B', '33:D, 7:D');
  t('複数欄を差し替えられる', many['33'] === 'Dキャッチ' && many['7'] === 'D本文');
  t('空白まじりの指定も読む', many['3'] === 'B職種');
  t('小文字の案でも通る', toPlan(two, 'B', '33:d')['33'] === 'Dキャッチ');
  t('指定なしなら素の案と同じ', JSON.stringify(toPlan(two, 'B')) === JSON.stringify(toPlan(two, 'B', '')));

  const rejects = (spec, name) => {
    let caught = false;
    try { toPlan(two, 'B', spec); } catch { caught = true; }
    t(name, caught);
  };
  rejects('33-D', '書き方が違う指定は止める');
  rejects('33:Z', '存在しない案からは取らない');
  // 共通欄は5案とも同じ。ここを指定できると「差し替えたつもり」が静かに空振りする。
  rejects('22:D', '案で変わらない欄の差し替えは止める');

  // 取り出し元にその欄が無いとき。undefined が入ると JSON にした時点で欄ごと消え、
  // 「差し替えました」と表示されたのに原稿から抜ける、という一番気づけない壊れ方をする。
  const broken = {
    variants: [
      { id: 'B', fields: { 3: 'B職種', 33: 'Bキャッチ' } },
      { id: 'D', fields: { 3: 'D職種' } },
    ],
    common: {},
  };
  let brokenCaught = false;
  try { toPlan(broken, 'B', '33:D'); } catch { brokenCaught = true; }
  t('取り出し元にその欄が無い候補ファイルは止める', brokenCaught);

  return failures;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args['self-test']) {
    const failures = selfTest();
    const out = { ok: failures.length === 0, failures };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
    return out;
  }

  // 案を選ぶモードは --job を取らない。help 判定より先に処理する。
  if (args.from && !args.help) {
    const result = await readJsonFromTmp(args.from);
    const fieldSpec = args.field === true ? '' : String(args.field ?? '');
    const plan = toPlan(result, String(args.select || ''), fieldSpec);
    const outPath = String(args['plan-out'] || path.join(TMP_ROOT, 'plan.json'));
    await secureWriteTmpFile(outPath, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(`compose_variants: wrote ${outPath} (${Object.keys(plan).length} fields)\n`);
    // どの欄をどの案から取ったかを出す。plan.json を開かないと分からない状態にしない。
    for (const [no, id] of Object.entries(parseFieldPicks(fieldSpec))) {
      process.stdout.write(`  No.${no} は ${id}案 から差し替えました\n`);
    }
    return plan;
  }

  if (args.help || !args.job) {
    process.stdout.write([
      'Usage:',
      '  node compose_variants.mjs --job <案件番号> \\',
      '    --current /tmp/current.json --siblings /tmp/siblings.json \\',
      '    --request /tmp/request.json [--hearing-ages "40代が中心"] \\',
      '    --out /tmp/plan_candidates.json',
      '',
      '  node compose_variants.mjs --from /tmp/plan_candidates.json --select E --plan-out /tmp/plan.json',
      '',
      '  # B案でいくがキャッチ(No.33)だけD案、という組み合わせ選択',
      '  node compose_variants.mjs --from /tmp/plan_candidates.json --select B --field 33:D',
      '',
      '  node compose_variants.mjs --self-test',
      '',
      '入出力はすべて /tmp 配下のみ。',
      '',
    ].join('\n'));
    return null;
  }

  if (args.from) {
    const result = await readJsonFromTmp(args.from);
    const plan = toPlan(result, String(args.select || ''));
    const outPath = String(args['plan-out'] || path.join(TMP_ROOT, 'plan.json'));
    await secureWriteTmpFile(outPath, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(`compose_variants: wrote ${outPath} (${Object.keys(plan).length} fields)\n`);
    return plan;
  }

  const [current, siblings, request] = await Promise.all([
    readJsonFromTmp(String(args.current || path.join(TMP_ROOT, 'current.json'))),
    readJsonFromTmp(String(args.siblings || path.join(TMP_ROOT, 'siblings.json'))),
    readJsonFromTmp(String(args.request || path.join(TMP_ROOT, 'request.json'))),
  ]);
  const hearingAges = args['hearing-ages'] && args['hearing-ages'] !== true
    ? String(args['hearing-ages']).split(/[,、]/u).map((s) => s.trim()).filter(Boolean)
    : [];

  const result = await composeForJob({ job: args.job, current, siblings, request, hearingAges });
  const outPath = String(args.out || path.join(TMP_ROOT, 'plan_candidates.json'));
  await secureWriteTmpFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`compose_variants: wrote ${outPath} (${result.variants.length} variants, ${result.meta.usableCount}/${result.meta.materialCount} materials usable)\n`);
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`compose_variants: ${error.message}\n`);
    process.exitCode = 1;
  });
}
