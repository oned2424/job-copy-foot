// 兄弟求人から集めた素材を、原稿に流し込んでよいものだけに絞る層。
//
// collect_siblings.py は「拾い漏れより拾いすぎ」の方針で広く集める。
// そのままでは、別求人の応募条件や別グループの勤務時間が本文に混入する。
// ここで4つの軸に分類し、本文に入れてよい素材だけを通す。
//
//   表示先 display    : body（本文可） / tag（職場環境タグのみ） / internal（社内メモのみ）
//   確度   confidence : current（対象求人の現在値） / repeated（同一事業所の複数求人に反復）
//                       / single（同一事業所だが1求人のみ） / foreign（別事業所）
//   種別   kind       : site_common（事業所の設備・立地） / workplace（職場の様子）
//                       / job_specific（その求人の作業内容） / condition（労働条件）
//   近接度 proximity  : same（同一求人） / near（同系統の職種） / far（別職種）
//
// 本文に通すのは display=body かつ kind∈{site_common,workplace} かつ
// confidence∈{current,repeated} かつ proximity≠far のものだけ。
// 落ちた素材は捨てずに reason を付けて返す。ヒアリングの質問候補になる。

export const DISPLAY = { BODY: 'body', TAG: 'tag', INTERNAL: 'internal' };
export const CONFIDENCE = { CURRENT: 'current', REPEATED: 'repeated', SINGLE: 'single', FOREIGN: 'foreign' };
export const KIND = { SITE: 'site_common', WORKPLACE: 'workplace', JOB: 'job_specific', CONDITION: 'condition' };
export const PROXIMITY = { SAME: 'same', NEAR: 'near', FAR: 'far' };

// 性別に触れる素材は本文にもタグにも出さない。男女雇用機会均等法5条。
// collect_siblings の age カテゴリに「女性スタッフ活躍中」が実在するため、
// 年代判定より先にこの網をかける。
const GENDER = /女性|男性|主婦|主夫|ママ|パパ|女子|男子|婦人/u;

// 年代は職場情報タグ（No.23）としてのみ使う。本文の訴求には使わない。
const AGE = /[0-9０-９]{2}\s*代|若手|シニア|中高年|ミドル|高校生|大学生|学生/u;

// 国籍・在留資格に触れる素材も本文・タグともに不可。職安法5条の5。
const NATIONALITY = /外国|国籍|留学生|技能実習|特定技能|ビザ|在留/u;

// 労働条件。同じ事業所でも求人ごとに違うため、兄弟から本文へ直接持ち込まない。
// 時刻（6:30~15:25 等）を必ず含める。同じ事業所でも日勤・2交替でグループが分かれ、
// 別グループの勤務時間が本文に載ると求人票そのものが誤りになる。
const CONDITION_TEXT = /時給|日給|月給|月収|年収|賞与|昇給|手当|祝い金|[0-9０-９,，]+\s*[万千]?\s*円|残業[0-9０-９]|[0-9０-９]+\s*名|採用予定|交通費|[0-9０-９]{1,2}\s*[:：時]\s*[0-9０-９]{2}|日勤|夜勤|交替|交代|シフト制/u;

// 給与を説明する欄。ここから来た文は、金額が書かれていなくても条件として扱う。
// collect_siblings.py の CONDITION_SOURCE_KEYS と対にする。
const CONDITION_SOURCE_FIELDS = new Set(['salary_supplement', 'salary_example']);

// 応募条件・歓迎要件。その求人固有の条件なので、別求人から借りると嘘になる。
const REQUIREMENT_TEXT = /歓迎|必須|不問|以上の方|できる方|お持ちの方|資格|免許|経験者|未経験(?:歓迎|可|OK|ＯＫ)/u;

// カテゴリごとの既定の分類。collect_siblings.py の CATEGORIES と対応する。
const CATEGORY_RULE = {
  equipment: { kind: KIND.JOB, display: DISPLAY.BODY },
  cargo: { kind: KIND.JOB, display: DISPLAY.BODY },
  physical: { kind: KIND.JOB, display: DISPLAY.BODY },
  ratio: { kind: KIND.JOB, display: DISPLAY.BODY },
  team: { kind: KIND.WORKPLACE, display: DISPLAY.BODY },
  training: { kind: KIND.WORKPLACE, display: DISPLAY.BODY },
  age: { kind: KIND.WORKPLACE, display: DISPLAY.TAG },
  facility: { kind: KIND.SITE, display: DISPLAY.BODY },
  access: { kind: KIND.SITE, display: DISPLAY.BODY },
  flow: { kind: KIND.SITE, display: DISPLAY.BODY },
  salary_example: { kind: KIND.CONDITION, display: DISPLAY.INTERNAL },
  overtime: { kind: KIND.CONDITION, display: DISPLAY.INTERNAL },
  holiday_note: { kind: KIND.CONDITION, display: DISPLAY.INTERNAL },
};

// 職種の系統。同じ事業所でも、リフトと検査では使える素材が違う。
// 郵便番号一致だけでは業務内容の混入を防げないため、ここで近接度を測る。
const JOB_FAMILIES = [
  ['forklift', /フォークリフト|リフト|カウンター|リーチ|玉掛|クレーン/u],
  ['inspection', /検査|検品|目視|測定|品質/u],
  ['assembly', /組立|組付|加工|溶接|プレス|塗装|機械オペ/u],
  ['picking', /ピッキング|仕分|梱包|包装|出荷|入荷|棚入|ラベル/u],
  ['delivery', /配送|運転|ドライバー|集荷|納品|トラック/u],
  ['cleanup', /空箱|整理|清掃|片付|回収/u],
  ['office', /事務|データ入力|受付|電話/u],
];

export function normalize(text) {
  return String(text ?? '').normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

export function jobFamilies(text) {
  const t = normalize(text);
  return JOB_FAMILIES.filter(([, re]) => re.test(t)).map(([id]) => id);
}

// 対象求人の職種と、素材の出所求人の職種を突き合わせて近接度を返す。
// どちらかが系統不明のときは near にする。far にすると素材が消えすぎるため。
export function proximityOf(materialJobs, targetJobNumber, jobFamilyIndex) {
  const ids = (materialJobs || []).map(String);
  if (ids.includes(String(targetJobNumber))) return PROXIMITY.SAME;
  const targetFam = jobFamilyIndex.get(String(targetJobNumber)) || [];
  if (targetFam.length === 0) return PROXIMITY.NEAR;
  let sawKnown = false;
  for (const id of ids) {
    const fam = jobFamilyIndex.get(id) || [];
    if (fam.length === 0) continue;
    sawKnown = true;
    if (fam.some((f) => targetFam.includes(f))) return PROXIMITY.NEAR;
  }
  return sawKnown ? PROXIMITY.FAR : PROXIMITY.NEAR;
}

export function confidenceOf(materialJobs, targetJobNumber) {
  const ids = (materialJobs || []).map(String);
  if (ids.includes(String(targetJobNumber))) return CONFIDENCE.CURRENT;
  if (ids.length >= 2) return CONFIDENCE.REPEATED;
  if (ids.length === 1) return CONFIDENCE.SINGLE;
  return CONFIDENCE.FOREIGN;
}

// 1件の素材を分類する。カテゴリの既定値から始めて、本文の中身で降格させる。
export function classify(material, { targetJobNumber, jobFamilyIndex }) {
  const text = normalize(material.text);
  const base = CATEGORY_RULE[material.category] || { kind: KIND.JOB, display: DISPLAY.INTERNAL };
  let display = base.display;
  let kind = base.kind;
  const notes = [];

  if (GENDER.test(text)) {
    display = DISPLAY.INTERNAL;
    notes.push('性別に触れているため使用不可');
  } else if (NATIONALITY.test(text)) {
    display = DISPLAY.INTERNAL;
    notes.push('国籍・在留資格に触れているため使用不可');
  } else if (AGE.test(text) && display === DISPLAY.BODY) {
    // 年代の記述は、カテゴリが age でなくてもタグ止まりにする。
    display = DISPLAY.TAG;
    notes.push('年代に触れているため職場環境タグのみ');
  }

  if (display !== DISPLAY.INTERNAL && CONDITION_TEXT.test(text) && kind !== KIND.CONDITION) {
    kind = KIND.CONDITION;
    notes.push('金額・人数を含むため労働条件として扱う');
  }
  // 出所の欄そのものが給与の説明なら、文面に金額が書かれていなくても条件として扱う。
  // 「昇給は年1回です」のように数字が無い給与の文は CONDITION_TEXT をすり抜けるが、
  // 昇給の有無は求人ごとに違うので、別求人から借りると嘘になる。
  if (kind !== KIND.CONDITION
      && (material.fields || []).length
      && (material.fields || []).every((f) => CONDITION_SOURCE_FIELDS.has(f))) {
    kind = KIND.CONDITION;
    notes.push('給与欄の文面のため労働条件として扱う');
  }
  if (display !== DISPLAY.INTERNAL && REQUIREMENT_TEXT.test(text) && kind === KIND.WORKPLACE) {
    kind = KIND.CONDITION;
    notes.push('応募条件の文面のため対象求人固有として扱う');
  }

  const confidence = confidenceOf(material.jobs, targetJobNumber);
  const proximity = proximityOf(material.jobs, targetJobNumber, jobFamilyIndex);

  let usable = true;
  const reasons = [];
  if (display === DISPLAY.INTERNAL) { usable = false; reasons.push(notes[0] || '本文・タグともに使用不可'); }
  if (display === DISPLAY.TAG) { usable = false; reasons.push('職場環境タグ専用'); }
  if (kind === KIND.CONDITION) { usable = false; reasons.push('労働条件は対象求人の値を使う'); }
  if (kind === KIND.JOB && confidence !== CONFIDENCE.CURRENT && proximity !== PROXIMITY.SAME) {
    usable = false;
    reasons.push('別求人の作業内容のため確認が必要');
  }
  if (confidence === CONFIDENCE.SINGLE && kind !== KIND.SITE) {
    usable = false;
    reasons.push('同一事業所だが1求人にしか出てこない');
  }
  if (confidence === CONFIDENCE.FOREIGN) { usable = false; reasons.push('出所不明'); }
  // 駐車場・最寄駅・食堂は職種に関係なく事業所の事実なので、近接度は問わない。
  if (proximity === PROXIMITY.FAR && kind !== KIND.SITE) {
    usable = false;
    reasons.push('別系統の職種の記述');
  }

  return {
    text,
    category: material.category,
    jobs: (material.jobs || []).map(String),
    fields: material.fields || [],
    display, kind, confidence, proximity, usable,
    reason: usable ? '' : reasons.join(' / '),
    notes,
  };
}

// siblings.json を丸ごと受け取り、分類済みの素材配列を返す。
//
// targetJobTitle は必ず渡すこと。対象求人は siblings.jobs に入っていない
// （collect_siblings.py が自分自身を除外する）ため、これが無いと対象の職種系統が
// 不明のまま扱われ、職種近接度による遮断が丸ごと効かなくなる。
export function classifyAll(siblings, { targetJobNumber, targetJobTitle }) {
  const jobFamilyIndex = new Map();
  for (const job of siblings?.jobs || []) {
    jobFamilyIndex.set(String(job.job), jobFamilies(`${job.title || ''} ${job.site || ''}`));
  }
  if (targetJobTitle) {
    jobFamilyIndex.set(String(targetJobNumber), jobFamilies(targetJobTitle));
  }
  const facts = siblings?.facts || {};
  const out = [];
  const seen = new Set();
  for (const [category, list] of Object.entries(facts)) {
    for (const item of list || []) {
      // 同じ文が複数カテゴリに入ることがある（access に休憩時間が混ざる等）。
      // 先に出たカテゴリの分類を残し、重複は落とす。
      const key = `${normalize(item.text)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(classify({ ...item, category }, { targetJobNumber, jobFamilyIndex }));
    }
  }
  return out;
}

export function usableMaterials(classified) {
  return classified.filter((m) => m.usable);
}

export function tagMaterials(classified) {
  return classified.filter((m) => m.display === DISPLAY.TAG);
}

export function blockedMaterials(classified) {
  return classified.filter((m) => !m.usable && m.display !== DISPLAY.TAG);
}

// 欄ごとに、どのカテゴリの素材を使ってよいか。
// ここに無いカテゴリの素材はその欄に入れない。
export const FIELD_SOURCES = {
  description: ['equipment', 'cargo', 'physical', 'team', 'training', 'flow', 'access', 'facility'],
  personal: ['team', 'training', 'physical'],
  work_environment: ['team', 'training', 'facility'],
  working_time_supplement: ['flow'],
  welfare: ['facility'],
  probationary_period_supplement: ['training'],
  subtitle: ['facility', 'flow'],
};

export function materialsForField(classified, role) {
  const allowed = FIELD_SOURCES[role];
  if (!allowed) return [];
  return classified.filter((m) => m.usable && allowed.includes(m.category));
}

export function selfTest() {
  const failures = [];
  const t = (name, cond) => { if (!cond) failures.push(name); };

  const idx = new Map([
    ['100', ['forklift']],
    ['200', ['cleanup']],
    ['300', ['forklift']],
    ['400', []],
  ]);
  const ctx = { targetJobNumber: '100', jobFamilyIndex: idx };

  const gender = classify({ text: '女性スタッフ活躍中', jobs: ['200', '300'], category: 'age' }, ctx);
  t('性別素材を遮断する', gender.display === DISPLAY.INTERNAL && gender.usable === false);

  const age = classify({ text: '20代・30代が活躍中の職場です', jobs: ['200', '300'], category: 'team' }, ctx);
  t('年代はタグ止まりにする', age.display === DISPLAY.TAG && age.usable === false);

  const facility = classify({ text: '無料駐車場完備で車通勤OK', jobs: ['200', '300'], category: 'facility' }, ctx);
  t('事業所共通の設備は本文に通す', facility.usable === true && facility.kind === KIND.SITE);

  const cond = classify({ text: '入社祝い金10万円を支給します', jobs: ['200', '300'], category: 'training' }, ctx);
  t('金額を含む素材は労働条件に降格する', cond.kind === KIND.CONDITION && cond.usable === false);

  const req = classify({ text: '免許はあるけど、しばらく乗っていない方も歓迎', jobs: ['200'], category: 'training' }, ctx);
  t('別求人の応募条件を本文に通さない', req.usable === false);

  const far = classify({ text: '空パレットを所定の位置に戻します', jobs: ['200'], category: 'cargo' }, ctx);
  t('別系統の職種の作業を本文に通さない', far.usable === false && far.proximity === PROXIMITY.FAR);

  const near = classify({ text: '自動車部品の製品パレットを移動します', jobs: ['300'], category: 'cargo' }, ctx);
  t('同系統でも1求人のみなら確認へ回す', near.proximity === PROXIMITY.NEAR && near.usable === false);

  const own = classify({ text: '基本は乗りっぱなしのリフト作業です', jobs: ['100'], category: 'equipment' }, ctx);
  t('対象求人の現在値は本文に通す', own.confidence === CONFIDENCE.CURRENT && own.usable === true);

  const shift = classify({ text: '●日勤:6:30~15:25', jobs: ['200', '300'], category: 'flow' }, ctx);
  t('別グループの勤務時間を本文に通さない', shift.kind === KIND.CONDITION && shift.usable === false);

  const rest = classify({ text: '休憩時間 55分+10分サービス休憩あり', jobs: ['200', '300'], category: 'flow' }, ctx);
  t('休憩の運用は本文に通す', rest.usable === true);

  const single = classify({ text: '◯◯本線の駅から車7分', jobs: ['200'], category: 'access' }, ctx);
  t('立地は1求人のみでも通す', single.usable === true);

  const dup = classifyAll({
    jobs: [{ job: '200', title: '空箱整理' }],
    facts: { access: [{ text: '休憩55分', jobs: ['200'] }], flow: [{ text: '休憩55分', jobs: ['200'] }] },
  }, { targetJobNumber: '100' });
  t('同じ文の重複を落とす', dup.length === 1);

  // 対象求人は siblings.jobs に入っていない。職種を渡さないと近接度の遮断が効かない。
  const otherFamily = { jobs: [{ job: '200', title: '空箱の整理' }, { job: '300', title: '空箱の回収' }], facts: { team: [{ text: '2人1組で運びます', jobs: ['200', '300'] }] } };
  const noTitle = classifyAll(otherFamily, { targetJobNumber: '100' });
  const withTitle = classifyAll(otherFamily, { targetJobNumber: '100', targetJobTitle: 'リフトで自動車部品の出荷作業' });
  t('職種を渡すと別系統の作業を遮断する', noTitle[0].usable === true && withTitle[0].usable === false);

  const forField = materialsForField([
    { text: 'a', category: 'facility', usable: true },
    { text: 'b', category: 'overtime', usable: true },
  ], 'welfare');
  t('欄ごとに使えるカテゴリを限定する', forField.length === 1 && forField[0].text === 'a');

  return failures;
}
