// 15欄の本文を組む層。
//
// 素材の文をそのまま連結すると「◆無料駐車場完備」のような媒体記号が本文に出る。
// そこで素材は「事実が有るか無いか」の判定にだけ使い、文はこちらの定型から出す。
// こうすると、素材側の誤字・装飾・体言止めが原稿に流れ込まない。
//
// 根拠の優先順位（この順で探し、最初に見つかったところで止める）
//   1. 対象求人の現在値（current.json）
//   2. 依頼7項目とヒアリング確認済みの回答（request.json）
//   3. 選別を通った兄弟素材（sibling_material.mjs で usable=true のもの）
//   4. 見つからなければ書かない。字数のために説明文を足さない。

import { normalize } from './sibling_material.mjs';

const DECOR = /^[◆■●★☆・‣▼▶◎〇○\s]+|[♪◎☆★]+$/gu;
// 閉じ括弧で終わる文に句点を足すと「〜ください。）。」になる。ここで終わりと見なす。
const ENDS_SENTENCE = /[。！？!?」』）)]$/u;

// 出力用の整形。素材の照合に使う normalize() と違い NFKC をかけない。
// NFKC は「（社内規定有）」を「(社内規定有)」に、「OK！」を「OK!」に変えてしまう。
// 掲載中の表記をこちらの都合で書き換えないため、ここでは記号を触らない。
export function clean(text) {
  return String(text ?? '').replace(/\r\n?/gu, '\n').replace(DECOR, '').trim();
}

export function len(text) {
  return Array.from(normalize(text)).length;
}

// 依頼の賃金は「2000円」「1500〜1875円」「時給1200円～1500円」「月給20万円」と書き方が揺れる。
// 数字だけを抜いて連結すると 15001875 という存在しない賃金になり、末尾の「円」だけ落とすと
// 「時給時給1200円～1500円」になる。下限・上限の数値に分けてから組み直す。
// 100未満は「1名」「8:00」のような賃金でない数字なので落とす。
export function parseWage(text) {
  const nums = [];
  for (const m of normalize(text ?? '').matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?/gu)) {
    const n = Math.round(Number(m[1].replace(/,/gu, '')) * (m[2] ? 10000 : 1));
    if (n >= 100) nums.push(String(n));
  }
  return { low: nums[0] ?? '', high: nums[1] ?? '' };
}

// 賃金を本文に書くときの文字列。表記の揺れを吸収して1つの形に揃える。
export function wageText(f) {
  const { low, high } = parseWage(f.wage);
  if (!low) return '';
  return high && Number(high) > Number(low)
    ? `${f.salaryForm}${low}円〜${high}円`
    : `${f.salaryForm}${low}円`;
}

// 事実を打ち消している言い方。これを見ないと「駐車場はありません」という素材から
// 「無料駐車場があるので車でも通えます」が出る。求職者に嘘をつくので、語の有無だけで
// 判定してはいけない。
const NEGATED = /ありません|ございません|ありませ|設けていません|無し|なし|不可|できません|出来ません|禁止|お断り|ご遠慮|利用不可|使用不可|廃止/u;
// 節をまたいで否定が来る書き方（「駐車場は、ありません」）を拾うための頭出し。
const NEGATION_HEAD = /^(?:ありません|ございません|ありませ|設けていません|なし|無し|不可|できません|出来ません)/u;
// 「ある」が条件つきの言い方。無料・支給と断定してはいけない。
const CONDITIONAL = /有料|自己負担|実費|一部負担|別途費用|要相談|台数[^。]*限り|空きがあれば|抽選|規定[^。]*(?:内|により)/u;

// 素材は「駐車場完備、制服なし」のように1文へ複数の事実が読点で並ぶ。
// 文だけで切ると片方の否定がもう片方に波及するので、読点でも切る。
function clauses(text) {
  return String(text).split(/[。！？!?\n、，,]/u).map((s) => s.trim()).filter(Boolean);
}

// 素材群から「この事実が肯定されているか」を判定する。文は取り出さない。
// 照合のときだけ NFKC をかける。「２０分」と「20分」を同じ事実として数えるため。
// パターンにあたった節が否定・条件つきなら、その節は根拠にしない。
export function hasFact(materials, pattern, { allowConditional = false } = {}) {
  return materials.some((m) => {
    const cs = clauses(normalize(m.text));
    return cs.some((cl, i) => {
      if (!pattern.test(cl)) return false;
      const next = cs[i + 1] ?? '';
      const scope = NEGATION_HEAD.test(next) ? `${cl}${next}` : cl;
      if (NEGATED.test(scope)) return false;
      return allowConditional || !CONDITIONAL.test(scope);
    });
  });
}

export function pickFact(materials, pattern, opts) {
  return pickFacts(materials, pattern, opts)[0] ?? null;
}

// 同じ種類の事実が複数ある欄（最寄り駅が2つある等）のための全件版。
// 1件だけ返す pickFact と否定・条件の判定は同じにする。ここを素の match() で
// 書くと「駅から徒歩10分ではありません」からアクセスを断定する穴が開く。
// 条件つき（有料・要相談・規定により）を落とす既定も hasFact と揃える。
// 「休憩60分（要相談）」から「休憩は60分です」を作ると、まだ決まっていない条件を
// 約束したことになる。値を取り出す側は数字だけ見て条件を見落とすので、ここで止める。
export function pickFacts(materials, pattern, { allowConditional = false } = {}) {
  const hits = [];
  for (const m of materials) {
    const cs = clauses(normalize(m.text));
    for (let i = 0; i < cs.length; i += 1) {
      const hit = cs[i].match(pattern);
      if (!hit) continue;
      const next = cs[i + 1] ?? '';
      const scope = NEGATION_HEAD.test(next) ? `${cs[i]}${next}` : cs[i];
      if (NEGATED.test(scope)) continue;
      if (!allowConditional && CONDITIONAL.test(scope)) continue;
      hits.push({ match: hit, source: m });
    }
  }
  return hits;
}

// 「日勤」と書けるのは、勤務時間が1本で夜をまたがないと言い切れるときだけ。
// 時間帯が複数書いてある・交替やシフトの語がある場合は、日勤とは言い切らない。
//
// 見るのは依頼の勤務時間が最優先。依頼と掲載中がズレていること自体は
// precheck_doc.py の P4 が NG で止め、人が `--confirmed hours` を付けないと通らない。
// つまりここへ来た時点で「日勤に変わった」は人が確認済みなので、
// 掲載中が2交替のままでも依頼を信じて書く。依頼に勤務時間が無いときだけ掲載中を見る。
const SHIFT_WORDS = /交替|交代|シフト|夜勤|深夜|準夜|早番|遅番/u;
const TIME_RANGE = /([0-9]{1,2}):([0-9]{2})\s*[-〜~ー–—]\s*([0-9]{1,2}):([0-9]{2})/gu;

export function isDayShift(...texts) {
  const joined = texts.map((t) => normalize(t ?? '')).filter(Boolean).join(' ');
  if (!joined) return false;
  if (SHIFT_WORDS.test(joined)) return false;
  const ranges = [...joined.matchAll(TIME_RANGE)];
  // 同じ時間帯が2回書いてあるだけなら1本として扱う。別の時間帯が並ぶなら交替とみなす。
  const uniq = new Set(ranges.map((r) => `${r[1]}:${r[2]}-${r[3]}:${r[4]}`));
  if (uniq.size !== 1) return false;
  const [r] = ranges;
  const start = Number(r[1]);
  const end = Number(r[3]) + (Number(r[4]) > 0 ? 1 : 0);
  return start >= 5 && end <= 19 && end > start;
}

// 現在値・依頼・素材から、原稿を書くのに必要な事実だけを集めた表を作る。
// ここに無い事実は原稿に書けない。
export function buildFactSheet({ current, request, materials }) {
  const c = (key) => clean(current?.[key] ?? '');

  // 対象求人の現在値は、兄弟素材より強い根拠。判定の材料に必ず含める。
  // ここを素材だけにすると、現行本文にしか無い事実（長期就業が多い等）を毎回落とす。
  const CURRENT_TEXT_KEYS = [
    'description', 'work_environment', 'welfare', 'personal', 'subtitle',
    'selection_flow', 'holiday', 'working_time_supplement', 'salary_supplement',
  ];
  const usable = [
    ...CURRENT_TEXT_KEYS.map((k) => ({ text: c(k), category: 'current', usable: true })).filter((m) => m.text),
    ...materials.filter((m) => m.usable),
  ];

  const restHit = pickFact(usable, /休憩[^。]*?([0-9]+)\s*分/u);
  const extraRestHit = pickFact(usable, /([0-9]+)\s*分\s*(?:の)?サービス休憩/u);
  // 「「北原」駅から徒歩10分ではありません」を通さないので pickFacts を経由する。
  const stationHits = pickFacts(
    usable,
    /(?:([^\s「]*?線)?)\s*「(.+?)」\s*駅(?:から|からは)?\s*(車|徒歩|バス)\s*([0-9]+)\s*分/u,
  ).map(({ match: h }) => ({ line: h[1] || '', station: h[2], means: h[3], minutes: h[4] }));

  const licenses = clean(current?.license_id_name ?? '')
    .split(/[,、]/u).map((s) => s.trim()).filter(Boolean);

  return {
    // --- 対象求人の現在値（最優先の根拠）---
    title: c('title'),
    description: c('description'),
    subtitle: c('subtitle'),
    personal: c('personal'),
    holiday: c('holiday'),
    welfare: c('welfare'),
    selectionFlow: c('selection_flow'),
    salarySupplement: c('salary_supplement'),
    salaryExample: c('salary_example'),
    workEnvironment: c('work_environment'),
    probation: c('probationary_period_supplement'),
    contractRenewal: c('contract_renewal_period'),
    smokingType: c('smoking_section_type_jp'),
    smokingSupplement: c('smoking_section_supplement'),
    currentTags: c('work_environment_id_name').split(/[,、]/u).map((s) => s.trim()).filter(Boolean),
    minSalary: c('minimum_salary'),
    maxSalary: c('maximum_salary'),
    salaryForm: c('salary_form_jp') || '時給',
    licenses,

    // --- 依頼7項目 ---
    site: clean(request?.site ?? ''),
    office: clean(request?.office ?? ''),
    requestedTitle: clean(request?.title ?? ''),
    duty: clean(request?.duty ?? ''),
    hours: clean(request?.hours ?? ''),
    wage: clean(request?.wage ?? ''),
    hires: clean(request?.hires ?? ''),

    // --- 兄弟素材から判定した事実（真偽のみ）---
    restMinutes: restHit ? restHit.match[1] : '',
    extraRestMinutes: extraRestHit ? extraRestHit.match[1] : '',
    stations: stationHits,
    // 「駐車場がある」と「無料である」は別の事実。有料でも hasParking は真になるので、
    // 無料と書くのは「無料」の根拠がある時だけにする。
    hasParking: hasFact(usable, /駐車場|車通勤/u, { allowConditional: true }),
    parkingFree: hasFact(usable, /無料駐車場|駐車場[^。、]{0,6}無料/u),
    // 制服が「ある」だけでは貸与とも自己負担とも言えない。支給・補助は別に裏を取る。
    hasUniform: hasFact(usable, /制服|作業着/u, { allowConditional: true }),
    uniformLent: hasFact(usable, /制服[^。、]{0,6}(?:貸与|支給|無償)|作業着[^。、]{0,6}(?:貸与|支給|無償)/u),
    uniformSubsidy: hasFact(usable, /制服代.*(?:補助|支給)|作業着.*支給/u),
    hasCanteen: hasFact(usable, /食堂/u),
    hasLocker: hasFact(usable, /ロッカー/u),
    hasDrink: hasFact(usable, /給茶|自販機|冷蔵庫/u),
    hasDrinkService: hasFact(usable, /飲料水[^。]*支給|飲み物[^。]*支給/u),
    bikeOk: hasFact(usable, /バイク通勤|バイク[^。]*(?:OK|可)/u),
    mentorsNearby: hasFact(usable, /先輩|丁寧に教え|近くに.*いる/u),
    soloWork: hasFact(usable, /1人|一人|コツコツ/u),
    longTenure: hasFact(usable, /長期|長く働/u),
    lightWork: hasFact(usable, /負担少な|負担が少な|乗りっぱなし|軽作業/u),
    // 未経験可は求人固有の条件。兄弟求人からは取らず、対象求人の値だけを見る。
    // 「未経験不可」から「経験は問いません」を出さないよう、語の有無ではなく hasFact で見る。
    noExperienceOk: hasFact(
      [{ text: `${c('personal')} ${clean(current?.work_environment_id_name ?? '')}` }],
      /未経験|経験不問|学歴不問/u,
    ),
    // 昇給も求人固有。兄弟求人の昇給は別の派遣先の話なので根拠にしない。
    // 「昇給なし」から「昇給あり」を出さないよう、語の有無ではなく hasFact で見る。
    hasRaise: hasFact([{ text: c('salary_supplement') }], /昇給/u),
    // 「土日休み」と書けるのは休日欄で休みだと言えるときだけ。
    // 「シフト制」「土日出勤あり」から土日休みを作らない。
    weekendOff: hasFact([{ text: c('holiday') }], /土日(?:祝)?[^。、]{0,4}休/u),
    // 「日勤のみ」は依頼の勤務時間と掲載中の勤務時間補足の両方で夜をまたがないときだけ。
    dayShiftOnly: request?.hours
      ? isDayShift(request.hours)
      : isDayShift(c('working_time_supplement')),
  };
}

// --- 欄ごとの組み立て ---------------------------------------------------

function sentences(list) {
  return list.filter(Boolean).map((s) => (ENDS_SENTENCE.test(s) ? s : `${s}。`)).join('\n');
}

// skip は「この事実は他のブロックかリード文で既に書いた」という申告。
// 同じ事実を2回書くと文字数だけ増えて中身が薄い原稿になるので、書いた側が申告する。
export function composeAccess(f, skip = new Set()) {
  const parts = [];
  if (f.stations.length && !skip.has('station')) {
    const s = f.stations.slice(0, 2)
      .map((x) => `${x.line ? `${x.line}` : ''}「${x.station}」駅から${x.means}${x.minutes}分`)
      .join('、');
    parts.push(s);
  }
  if (f.hasParking && !skip.has('parking')) {
    // 「無料」と書けるのは無料の裏が取れているときだけ。有料の駐車場を無料と書くと、
    // 応募者は入社してから知ることになる。
    const lot = f.parkingFree ? '無料駐車場' : '駐車場';
    parts.push(f.bikeOk ? `${lot}があるので車でもバイクでも通えます` : `${lot}があるので車でも通えます`);
  }
  return parts.length ? sentences(parts) : '';
}

export function composeWorkplaceNote(f, skip = new Set()) {
  const parts = [];
  if (f.mentorsNearby && !skip.has('mentor')) parts.push('近くに先輩がいるので、わからないことはすぐ聞けます');
  if (f.lightWork && !skip.has('light')) parts.push('体への負担が少ない作業です');
  if (f.soloWork && !skip.has('solo')) parts.push('ひとりで集中して進める時間が長い職場です');
  if (f.longTenure && !skip.has('tenure')) parts.push('長く働いている方が多い職場です');
  if (f.hasCanteen && !skip.has('canteen')) parts.push('社員食堂を利用できます');
  return parts.length ? sentences(parts) : '';
}

export function composeDutyBody(f) {
  const parts = [];
  const place = f.office ? `${f.office}の現場` : '';
  const duty = f.duty || f.title;
  if (duty) parts.push(place ? `${place}で、${duty}をお任せします` : `${duty}をお任せします`);
  // 現在値の訴求は必ず残す。ここを落とすと今より弱い原稿になる。
  if (f.description) parts.push(f.description);
  return parts.length ? sentences(parts) : '';
}

export function composeHours(f) {
  const parts = [];
  if (f.hours) parts.push(`勤務時間は${f.hours}です`);
  if (f.restMinutes && f.extraRestMinutes) {
    parts.push(`休憩は${f.restMinutes}分。それとは別に${f.extraRestMinutes}分のサービス休憩があります`);
  } else if (f.restMinutes) {
    parts.push(`休憩は${f.restMinutes}分です`);
  }
  return parts.length ? sentences(parts) : '';
}

export function composeHolidayBody(f) {
  return f.holiday ? sentences([f.holiday]) : '';
}

export function composeTraining(f) {
  return f.mentorsNearby ? sentences(['慣れるまでは近くの先輩が教えます']) : '';
}

export function composeRequirementBody(f) {
  const parts = [];
  if (f.licenses.length) {
    // 免許名は現在値の表記をそのまま使う。言い換えると資格の同一性が崩れる。
    parts.push(`応募には${f.licenses[f.licenses.length - 1]}が必要です`);
  }
  if (f.hires) parts.push(`採用予定は${f.hires}です`);
  return parts.length ? sentences(parts) : '';
}

export function composeCommute(f, skip = new Set()) {
  const parts = [];
  // 制服が「ある」だけでは貸与とも自己負担とも言えない。裏が取れた言い方だけ書く。
  if (f.uniformSubsidy) parts.push('制服代の補助があります');
  else if (f.uniformLent) parts.push('制服を貸与します');
  if (f.hasLocker && !skip.has('locker')) parts.push('ロッカーを使えます');
  // 素材にあるのが給茶機か冷蔵庫か自販機かは分からないので、どれか1つに断定しない。
  if (f.hasDrink && !skip.has('drink')) parts.push('現場に飲み物を置ける設備があります');
  // 「毎日」は根拠がない。支給の有無だけを書く。
  if (f.hasDrinkService && !skip.has('drink')) parts.push('飲料水の支給があります');
  return parts.length ? sentences(parts) : '';
}

// --- variant欄（A〜E案で変える4欄）---------------------------------------
//
// 5案は「別の事実を書く」のではなく「同じ事実をどの順で見せるか」を変える。
// 案ごとに新しい文を作ると根拠が案の数だけ必要になり、必ずどこかで捏造が混じる。
// ブロックの並べ替えなら、どの案を選んでも書いてあることは全部裏が取れている。

export const VARIANT_AXES = [
  { id: 'A', name: '生活リズム軸', order: ['hours', 'holiday', 'duty', 'training', 'workplace', 'access', 'commute', 'require'] },
  { id: 'B', name: '身体負担軸', order: ['duty', 'workplace', 'training', 'hours', 'holiday', 'access', 'commute', 'require'] },
  { id: 'C', name: '収入・条件軸', order: ['duty', 'hours', 'holiday', 'commute', 'workplace', 'training', 'access', 'require'] },
  { id: 'D', name: 'QUEST・悩み型', order: ['duty', 'training', 'workplace', 'hours', 'holiday', 'access', 'commute', 'require'] },
  { id: 'E', name: 'QUEST・数字型', order: ['duty', 'hours', 'holiday', 'access', 'training', 'workplace', 'commute', 'require'] },
];

// 案ごとのリード文。全て対象求人の事実に接続してから書く。
// 事実が無い案はリードを出さない（「〜な方へ」だけ書いて中身が無い状態を防ぐ）。
function leadFor(axis, f) {
  switch (axis) {
    case 'A':
      return f.hours && f.holiday ? '生活のリズムを崩さずに働きたい方へ' : '';
    case 'B':
      return f.lightWork ? '体への負担が少ない仕事を探している方へ' : '';
    case 'C':
      return wageText(f) ? `${wageText(f)}のお仕事です` : '';
    case 'D':
      return f.soloWork ? '自分のペースで集中して働きたい方へ' : '';
    case 'E': {
      const nums = [];
      if (wageText(f)) nums.push(wageText(f));
      if (f.restMinutes) {
        const total = Number(f.restMinutes) + Number(f.extraRestMinutes || 0);
        nums.push(`休憩${total}分`);
      }
      if (f.hires) nums.push(`採用予定${f.hires}`);
      return nums.length >= 2 ? nums.join('。') : '';
    }
    default:
      return '';
  }
}

// リード文で使った事実。本文ブロック側では書かない。
const LEAD_SKIP = { A: [], B: ['light'], C: [], D: ['solo'], E: [] };

function blocksFor(f, skip) {
  return {
    duty: composeDutyBody(f),
    hours: composeHours(f),
    holiday: composeHolidayBody(f),
    training: composeTraining(f),
    workplace: composeWorkplaceNote(f, skip),
    access: composeAccess(f, skip),
    commute: composeCommute(f),
    require: composeRequirementBody(f),
  };
}

export function composeDescription(axis, f) {
  const spec = VARIANT_AXES.find((a) => a.id === axis) || VARIANT_AXES[0];
  const skip = new Set(LEAD_SKIP[axis] || []);
  // 「先輩が教えます」は training ブロックが必ず担当する。
  // workplace 側にも先輩の文があるため、両方出すと同じことを2回書く原稿になる。
  if (composeTraining(f)) skip.add('mentor');
  // 職場の雰囲気（ひとり作業・長期就業・食堂）は No.24 職場環境の補足説明が担当する。
  // AirWork は No.7 と No.24 を別セクションで並べて表示するため、
  // 両方に同じ文を出すと応募者には同じことを2回言っている原稿に見える。
  for (const k of ['solo', 'tenure', 'canteen']) skip.add(k);
  const blocks = blocksFor(f, skip);
  const lead = leadFor(axis, f);
  const body = spec.order.map((k) => blocks[k]).filter(Boolean);
  return [lead ? `${lead}。` : '', ...body].filter(Boolean).join('\n');
}

export function composeTitle(axis, f) {
  const base = f.requestedTitle || f.title;
  if (!base) return '';
  // 職種名に金額・時刻は入れない（P5）。案の違いは条件語だけで付ける。
  // 「土日」の語があるだけでは休みとは限らない（「土日出勤あり」）。
  // 「日勤」も勤務時間の裏が取れて初めて書ける。職種名は一番目立つので断定しない。
  const suffix = {
    A: (f.dayShiftOnly && f.weekendOff && '日勤・土日休み') || (f.weekendOff && '土日休み') || '',
    B: f.lightWork ? '体の負担少なめ' : '',
    C: f.hasRaise ? '昇給あり' : '',
    D: f.soloWork ? 'ひとり作業中心' : '',
    E: f.hasParking ? '車通勤OK' : '',
  }[axis] || '';
  return suffix ? `${base}／${suffix}` : base;
}

export function composeSubtitle(axis, f) {
  const parts = [];
  const wage = wageText(f);
  switch (axis) {
    case 'A':
      // 「日勤」を足せるのは夜をまたがないと言い切れるときだけ。
      // 休日欄は現在値をそのまま出すので断定にはならない。
      if (f.hours) parts.push(f.dayShiftOnly ? `${f.hours}の日勤` : f.hours);
      if (f.holiday) parts.push(f.holiday.replace(/[、。]/gu, '・'));
      if (wage) parts.push(wage);
      break;
    case 'B':
      if (f.description) parts.push(f.description.replace(/[。\n]/gu, ''));
      if (f.lightWork) parts.push('体への負担少なめ');
      if (wage) parts.push(wage);
      break;
    case 'C':
      if (wage) parts.push(wage);
      if (f.hasRaise) parts.push('昇給あり');
      if (f.holiday) parts.push(f.holiday.replace(/[、。]/gu, '・'));
      break;
    case 'D':
      if (f.soloWork) parts.push('ひとりで集中できる作業');
      if (f.mentorsNearby) parts.push('慣れるまでは先輩がフォロー');
      if (wage) parts.push(wage);
      break;
    case 'E':
      if (wage) parts.push(wage);
      if (f.restMinutes) parts.push(`休憩${Number(f.restMinutes) + Number(f.extraRestMinutes || 0)}分`);
      // 「無料」と書けるのは無料の裏が取れているときだけ。有料の駐車場を無料と書くと、
      // 応募者は初出勤の日に知らされていない出費を負う。No.97 と同じ判定にする。
      if (f.parkingFree) parts.push('無料駐車場あり');
      else if (f.hasParking) parts.push('駐車場あり');
      break;
    default:
      break;
  }
  return parts.length ? `${parts.join('。')}。` : '';
}

export function composePersonal(axis, f) {
  const parts = [];
  if (f.licenses.length) {
    parts.push(`${f.licenses[f.licenses.length - 1]}を修了している方を歓迎します`);
  }
  if (f.noExperienceOk) parts.push('この現場での経験は問いません');
  if (f.mentorsNearby) parts.push('慣れるまでは先輩がそばについて教えます');
  if (f.soloWork) parts.push('ひとりで集中して進めたい方に向いています');
  // 勤務時間欄・休日欄に何か入っているだけでは「日勤のみ」「土日休み」の根拠にならない。
  // 裏が取れたところまでを書く。
  if (f.dayShiftOnly && f.weekendOff) parts.push('日勤のみで土日休みなので、生活のリズムを崩さずに働けます');
  else if (f.weekendOff) parts.push('土日休みなので、生活のリズムを崩さずに働けます');
  else if (f.dayShiftOnly) parts.push('日勤のみなので、生活のリズムを崩さずに働けます');
  if (f.hasParking) parts.push('車で通える方も歓迎です');

  // 案ごとに並べ方だけ変える。書く内容は同じ。
  const rotate = { A: 4, B: 3, C: 0, D: 2, E: 5 }[axis] ?? 0;
  const head = parts.filter((_, i) => i === rotate);
  const rest = parts.filter((_, i) => i !== rotate);
  return sentences([...head, ...rest]);
}

// A〜Eの5案ぶん、本文4欄を組む。
export function composeVariants(f) {
  return VARIANT_AXES.map((a) => ({
    id: a.id,
    name: a.name,
    fields: {
      3: composeTitle(a.id, f),
      33: composeSubtitle(a.id, f),
      7: composeDescription(a.id, f),
      28: composePersonal(a.id, f),
    },
  }));
}

// --- fact欄（5案共通）---------------------------------------------------

export function composeFactFields(f) {
  const out = {};

  // No.22 喫煙。現在値の区分から導出する。区分が無ければ書かない。
  if (/敷地内.*禁煙|全て禁煙/u.test(f.smokingType)) out['22'] = '敷地内は全面禁煙です。';
  else if (/屋内.*禁煙/u.test(f.smokingType)) out['22'] = '屋内は禁煙です。';
  else if (f.smokingSupplement) out['22'] = f.smokingSupplement;

  // No.24 職場環境の補足。素材から判定した事実だけで書く。
  // 教育体制（先輩）と作業のきつさは No.7 仕事内容が担当する。ここは職場の雰囲気だけ。
  const wp = composeWorkplaceNote(f, new Set(['mentor', 'light']));
  if (wp) out['24'] = wp.replace(/\n/gu, '');

  // No.34 採用予定人数。依頼の値をそのまま使う。
  if (f.hires) out['34'] = f.hires.replace(/名$/u, '');

  // No.39/40 給与額。依頼の賃金が最新の指示なのでここで反映する。
  // 出さないと、依頼で時給が変わったときに No.39 が掲載中の額のまま残り、
  // precheck_doc.py の P3 が毎回 NG を出して原稿が作れなくなる。
  {
    const req = parseWage(f.wage);
    if (req.low) {
      out['39'] = req.low;
      // 依頼が上限を書いてこなければ掲載中の上限を残す。落とすと条件が悪化して見える。
      const high = req.high || String(f.maxSalary).replace(/[^0-9]/gu, '');
      if (high && Number(high) > Number(req.low)) out['40'] = high;
    }
  }

  // No.63 給与の補足。依頼の時給と現在値の昇給記述を組む。
  // 上限は現在値（No.40）を根拠にする。依頼が下限だけを指定してきても、
  // 掲載中の上限を落とすと今より条件の悪い求人に見える。
  {
    const parts = [];
    const req = parseWage(f.wage);
    const low = req.low || String(f.minSalary).replace(/[^0-9]/gu, '');
    // 依頼が上限まで書いてきたらそれが最新の指示。書いてこなければ掲載中の上限を残す。
    const high = req.high || String(f.maxSalary).replace(/[^0-9]/gu, '');
    if (low && high && Number(high) > Number(low)) parts.push(`${f.salaryForm}${low}円〜${high}円`);
    else if (low) parts.push(`${f.salaryForm}${low}円`);
    if (f.hasRaise) parts.push('昇給あり');
    if (parts.length) out['63'] = sentences([parts.join('。')]).replace(/\n/gu, '');
  }

  // No.88 勤務時間の補足。
  const hours = composeHours(f);
  if (hours) out['88'] = hours.replace(/\n/gu, '');

  // No.90 休日の補足。現在値をそのまま使う。
  if (f.holiday) out['90'] = sentences([f.holiday]).replace(/\n/gu, '');

  // No.97 福利厚生。現在値を土台に、素材で確認できた設備だけ足す。
  {
    const base = f.welfare ? f.welfare.split('\n').map((s) => clean(s)).filter(Boolean) : [];
    const add = [];
    // 「無料」と書けるのは無料の裏が取れているときだけ。有料の駐車場を無料と書かない。
    if (f.hasParking && !base.some((b) => /駐車場/u.test(b))) {
      add.push(f.parkingFree ? '無料駐車場あり' : '駐車場あり');
    }
    if (f.uniformSubsidy && !base.some((b) => /制服/u.test(b))) add.push('制服代の補助あり');
    // 素材にあるのが個人ロッカーか更衣室かは分からないので「ロッカールーム」と断定しない。
    if (f.hasLocker && !base.some((b) => /ロッカー/u.test(b))) add.push('ロッカーあり');
    const all = [...base, ...add];
    if (all.length) out['97'] = `${all.join('。')}。`;
  }

  // No.153 試用期間。現在値が空なら書かない。「無し」と断定しない。
  if (f.probation) out['153'] = sentences([f.probation]).replace(/\n/gu, '');

  // No.155 選考の補足。現在値をそのまま整える。
  if (f.selectionFlow) {
    out['155'] = f.selectionFlow.split('\n').map((s) => clean(s)).filter(Boolean)
      .map((s) => (ENDS_SENTENCE.test(s) ? s : `${s}。`)).join('');
  }

  // No.99 契約更新期間。現在値が空なら書かない。
  if (f.contractRenewal) out['99'] = f.contractRenewal;

  // No.64 給与例。現在値の裏が取れないため、人の判断へ回す。
  if (f.salaryExample) out['64'] = '__REVIEW__';

  return out;
}

export function selfTest() {
  const failures = [];
  const t = (name, cond) => { if (!cond) failures.push(name); };

  const materials = [
    { text: '休憩時間 55分+10分サービス休憩あり', usable: true },
    { text: '◯◯本線「北原」駅からは車7分', usable: true },
    { text: '無料駐車場完備で車通勤OK', usable: true },
    { text: '◆制服代全額補助', usable: true },
    { text: '先輩スタッフが丁寧に教えます', usable: true },
    { text: '20代が多い職場です', usable: false },
  ];
  const f = buildFactSheet({
    current: {
      title: 'リフトで出荷作業', description: '基本乗りっぱなしのリフト作業♪',
      holiday: '土日休み、連休あり', welfare: '社会保険完備\n車通勤OK',
      smoking_section_type_jp: 'なし（敷地内全て禁煙）',
      license_id_name: 'フォークリフト運転特別教育,フォークリフト運転技能講習',
      salary_supplement: '★昇給あり', salary_form_jp: '時給',
    },
    request: { office: 'X市', duty: '倉庫内でのフォークリフト出荷作業', hours: '8:00-17:00', wage: '2000円', hires: '1名' },
    materials,
  });

  t('休憩の分数を素材から拾う', f.restMinutes === '55' && f.extraRestMinutes === '10');
  t('駅名と所要時間を拾う', f.stations.length === 1 && f.stations[0].station === '北原' && f.stations[0].minutes === '7');
  t('駐車場の有無を判定する', f.hasParking === true);
  t('制服代の補助を判定する', f.uniformSubsidy === true);
  t('遮断済み素材を事実に混ぜない', f.hasCanteen === false);
  t('免許名を現在値から取る', f.licenses.length === 2);

  const fields = composeFactFields(f);
  t('喫煙は区分から導出する', fields['22'] === '敷地内は全面禁煙です。');
  t('勤務時間は依頼と休憩素材で組む', /8:00-17:00/u.test(fields['88']) && /55分/u.test(fields['88']) && /10分/u.test(fields['88']));
  t('福利厚生は現在値を土台に足す', /社会保険完備/u.test(fields['97']) && /無料駐車場あり/u.test(fields['97']));
  t('給与補足に依頼の時給が入る', /時給2000円/u.test(fields['63']));
  t('試用期間は現在値が空なら書かない', fields['153'] === undefined);
  t('装飾記号を落とす', !/[◆♪]/u.test(JSON.stringify(fields)));

  const access = composeAccess(f);
  t('アクセス文を組む', /「北原」駅から車7分/u.test(access) && /駐車場/u.test(access));

  const duty = composeDutyBody(f);
  t('現在値の訴求を本文に残す', /基本乗りっぱなしのリフト作業/u.test(duty));

  const req = composeRequirementBody(f);
  t('免許要件と採用人数を書く', /フォークリフト運転技能講習/u.test(req) && /1名/u.test(req));

  // --- ここから下は「無い事実を書かない」ための回帰テスト ---------------
  // 語が出てくるだけで事実と数えていた頃、下のどれもが逆の意味の原稿になった。

  const denied = [
    { text: '駐車場はありません', usable: true },
    { text: '制服なし、ロッカーは利用できません', usable: true },
  ];
  const fd = buildFactSheet({ current: {}, request: {}, materials: denied });
  t('否定文を事実にしない（駐車場）', fd.hasParking === false);
  t('否定文を事実にしない（制服）', fd.hasUniform === false);
  t('読点の先の否定も届く（ロッカー）', fd.hasLocker === false);

  const paid = [{ text: '駐車場は有料です（月2000円）', usable: true }];
  const fp = buildFactSheet({ current: {}, request: {}, materials: paid });
  t('有料でも駐車場の存在は認める', fp.hasParking === true);
  t('有料駐車場を無料と書かない', fp.parkingFree === false);
  t('アクセス文でも無料と断定しない', !/無料/u.test(composeAccess(fp)));
  t('福利厚生でも無料と断定しない', !/無料駐車場/u.test(composeFactFields(fp)['97'] || ''));
  // キャッチは一番読まれる。ここだけ判定が緩いと、応募者は初出勤の日に
  // 知らされていない駐車場代を払うことになる。
  t('E案キャッチでも無料と断定しない', !/無料/u.test(composeSubtitle('E', fp)));
  t('E案キャッチは駐車場の存在までは書ける', /駐車場あり/u.test(composeSubtitle('E', fp)));

  // 「未経験不可」から「経験は問いません」を出すと、応募資格を逆に伝える。
  const noExp = buildFactSheet({
    current: { personal: '未経験不可。同種業務の経験が必要です' },
    request: {},
    materials: [],
  });
  t('未経験不可を未経験歓迎にしない', noExp.noExperienceOk === false);
  t('未経験可はそのまま拾う', buildFactSheet({
    current: { personal: '未経験の方も歓迎します' }, request: {}, materials: [],
  }).noExperienceOk === true);

  // 駅アクセスだけ素の match() で拾っていた頃、否定文からアクセスを断定していた。
  const noStation = [{ text: '◯◯線「北原」駅から徒歩10分ではありません', usable: true }];
  const fns = buildFactSheet({ current: {}, request: {}, materials: noStation });
  t('否定文から駅アクセスを断定しない', fns.stations.length === 0);
  const twoStations = [
    { text: '◯◯線「北原」駅から車7分', usable: true },
    { text: '△△線「南原」駅から徒歩12分', usable: true },
  ];
  t('駅が2つあれば2つとも拾う',
    buildFactSheet({ current: {}, request: {}, materials: twoStations }).stations.length === 2);

  // 値を取り出す側は数字だけ見るので、条件つきを落とすのは pickFacts の仕事。
  // 「休憩60分（要相談）」を「休憩は60分です」と書くと、決まっていない条件を約束する。
  const condRest = [{ text: '休憩60分（要相談）', usable: true }];
  const fcr = buildFactSheet({ current: {}, request: {}, materials: condRest });
  t('条件つきの休憩時間を断定しない', fcr.restMinutes === '');
  t('条件つきなら休憩の文を出さない', !/休憩/u.test(composeHours(fcr)));
  const condStation = [{ text: '◯◯線「北原」駅からバス10分（要相談）', usable: true }];
  t('条件つきの駅アクセスを断定しない',
    buildFactSheet({ current: {}, request: {}, materials: condStation }).stations.length === 0);
  t('条件つきでも明示すれば取り出せる',
    pickFacts(condRest, /休憩[^。]*?([0-9]+)\s*分/u, { allowConditional: true }).length === 1);

  // 「昇給なし」から「昇給あり」を作ると、掲載中と逆の条件を出す。
  const noRaise = buildFactSheet({
    current: { salary_supplement: '昇給なし', salary_form_jp: '時給' },
    request: { wage: '1200円' },
    materials: [],
  });
  t('昇給なしを昇給ありにしない', noRaise.hasRaise === false);
  t('給与補足に昇給ありを足さない', !/昇給/u.test(composeFactFields(noRaise)['63'] || ''));
  t('C案キャッチに昇給ありを足さない', !/昇給/u.test(composeSubtitle('C', noRaise)));
  t('C案の職種名に昇給ありを足さない', !/昇給/u.test(composeTitle('C', noRaise)));

  // 休日欄・勤務時間欄に何か入っているだけで「日勤のみで土日休み」と書いていた。
  const shift = buildFactSheet({
    current: { title: 'リフト作業', holiday: 'シフト制', working_time_supplement: '2交替 6:30〜15:25／17:10〜2:05' },
    request: { hours: '8:00-17:00' },
    materials: [],
  });
  t('シフト制を土日休みにしない', shift.weekendOff === false);
  // 依頼と掲載中のズレは precheck の P4 が止める。ここまで来たら人が確認済みなので、
  // 掲載中が2交替のままでも依頼の勤務時間を信じて日勤と書く。
  t('依頼が日勤なら掲載中が2交替でも日勤と書く', shift.dayShiftOnly === true);
  t('求める人材で土日休みを断定しない', !/土日休み/u.test(composePersonal('A', shift)));
  t('職種名で土日休みを断定しない', !/土日休み/u.test(composeTitle('A', shift)));
  // 依頼に勤務時間が無ければ掲載中を見る。そこが2交替なら日勤とは書けない。
  const noHours = buildFactSheet({
    current: { title: 'リフト作業', holiday: 'シフト制', working_time_supplement: '2交替 6:30〜15:25／17:10〜2:05' },
    request: {},
    materials: [],
  });
  t('依頼に勤務時間が無ければ2交替を日勤にしない', noHours.dayShiftOnly === false);
  t('依頼が無いとき職種名で日勤を断定しない', !/日勤/u.test(composeTitle('A', noHours)));
  t('依頼が無いときキャッチで日勤と断定しない', !/日勤/u.test(composeSubtitle('A', noHours)));
  t('依頼が無いとき求める人材で日勤を断定しない', !/日勤のみ/u.test(composePersonal('A', noHours)));
  // 依頼そのものが交替なら、依頼を信じても日勤にはならない。
  t('依頼が2交替なら日勤にしない', buildFactSheet({
    current: {}, request: { hours: '6:30-15:25、17:10-2:05' }, materials: [],
  }).dayShiftOnly === false);
  // 裏が取れているときは今までどおり書ける（黙って字数が減らないこと）。
  t('裏が取れた土日休みは書く', f.weekendOff === true && f.dayShiftOnly === true);
  t('裏が取れていれば日勤・土日休みを書く', /日勤・土日休み/u.test(composeTitle('A', f)));
  t('土日だけ裏が取れたら土日休みだけ書く', (() => {
    const only = buildFactSheet({
      current: { title: 'リフト作業', holiday: '土日休み', working_time_supplement: '2交替' },
      request: {},
      materials: [],
    });
    return composeTitle('A', only).endsWith('／土日休み');
  })());
  t('「土日出勤あり」を土日休みにしない', buildFactSheet({
    current: { holiday: '土日出勤あり' }, request: {}, materials: [],
  }).weekendOff === false);
  t('夜をまたぐ時間帯を日勤にしない', isDayShift('17:10-2:05') === false);
  t('時間帯が2本あれば日勤にしない', isDayShift('6:30〜15:25 17:10〜2:05') === false);
  t('同じ時間帯が2回書いてあっても日勤と見る', isDayShift('8:00-17:00', '勤務時間は8:00-17:00です') === true);

  t('賃金レンジを下限・上限に分ける',
    parseWage('1500〜1875円').low === '1500' && parseWage('1500〜1875円').high === '1875');
  t('単位つきの賃金を数値にする', parseWage('月給20万円').low === '200000');
  t('賃金でない数字を拾わない', parseWage('1名').low === '' && parseWage('8:00-17:00').low === '');
  const fr = buildFactSheet({
    current: { salary_form_jp: '時給', maximum_salary: '3000' },
    request: { wage: '1500〜1875円' },
    materials: [],
  });
  const rangeFields = composeFactFields(fr);
  t('レンジの数字を連結しない', /時給1500円〜1875円/u.test(rangeFields['63']));
  t('依頼の賃金を No.39/40 に出す', rangeFields['39'] === '1500' && rangeFields['40'] === '1875');

  return failures;
}
