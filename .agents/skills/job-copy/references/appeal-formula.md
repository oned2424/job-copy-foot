# 求人訴求案の生成ルール

訴求案生成の正本。年齢・性別を直接書かず、確認済みの事実だけを使って表現層を変える。

**現行フローはA〜E 5案である。**A・B・Cは訴求軸を変えた3案、D・Eは文章構成型（QUEST）を変えた2案。
組み立て方は本ファイル末尾の「本文の文章構成型（A〜E 5案の設計）」が正本。
このファイル内の`abDifferenceCount`や「A/Bで型を変える」は2案時代の記述で、
掲載後に効果を測る場合の制約（差分変数を1つに絞る）を指す。
フロントに並べる5案は軸または構成型そのものを変えるので、この差分1変数ルールに縛られない。
5案の作り方は`SKILL.md`手順3、提示フォーマットは`assets/variants5-template.md`が正本。

**このファイルが縛るのは本文コピー（キャッチ・仕事内容・求める人材）だけである。**
職場情報タグの年齢構成はここの禁止語の対象外で、ヒアリングで裏が取れた場合に限り使える。
本文とタグの線引きは `hearing-protocol.md` の「年齢・性別・国籍の扱い」を正本とする。

## 機械可読ルール

`generate_variants.mjs` はマーカー間JSONを読み、禁止語・訴求軸対応・根拠条件をコードへ複製しない。

<!-- JOB_COPY_APPEAL_RULES_START -->
```json
{
  "schemaVersion": "1.0.0",
  "normalization": {
    "unicode": "NFKC",
    "trim": true,
    "lineBreak": "LF"
  },
  "generationFormula": [
    "ターゲット条件",
    "状況・トリガー",
    "未充足欲求／不満",
    "属性・仕組み",
    "実用便益",
    "心理・人生価値",
    "根拠",
    "オファー",
    "表現フレーム"
  ],
  "appealLayers": [
    {
      "id": "screening",
      "label": "足切り回避軸",
      "role": "無いと応募検討に入らない事実条件",
      "allowedAsPrimary": false
    },
    {
      "id": "anxiety_relief",
      "label": "不安解消軸",
      "role": "興味はあるが応募できない状態を防ぐ",
      "allowedAsPrimary": false
    },
    {
      "id": "differentiation",
      "label": "差別化軸",
      "role": "同条件の求人から選ばれる理由を作る",
      "allowedAsPrimary": true
    }
  ],
  "titleTypes": [
    {"id": "condition_benefit", "label": "条件利益型"},
    {"id": "anxiety_relief", "label": "不安解消型"},
    {"id": "career", "label": "キャリア型"},
    {"id": "job_value", "label": "仕事価値型"},
    {"id": "relationships", "label": "人間関係型"},
    {"id": "scarcity", "label": "希少性型"}
  ],
  "variantPolicy": {
    "primaryAppealCount": 1,
    "primaryAppealLayer": "differentiation",
    "secondaryAppealMax": 2,
    "abDifferenceCount": 1,
    "applyCommonImprovementsToBoth": true,
    "lintFunctionRef": "scripts/lint_copy.mjs",
    "suppressRisk": "HIGH_RISK",
    "humanDecisionColumnMustRemainBlank": true,
    "runSimultaneously": false
  },
  "defaultAxes": ["V084", "V101", "V098", "V023"],
  "axisDictionaryCounts": {"V": 132, "R": 158, "S": 55},
  "personaPolicy": {
    "files": [
      "personas/driver-aichi.md",
      "personas/factory-inspect-aichi.md"
    ],
    "skeletonStatus": "skeleton",
    "fallbackNote": "ペルソナ未確定のためデフォルト軸で生成"
  },
  "axisMapping": {
    "V084": {
      "label": "若々しさ・成熟",
      "copyDirection": "年齢を書かず、挑戦・次の選択肢・前進を価値として描く",
      "allowedEvidenceStatuses": ["CONFIRMED_INTERNAL", "EXTRACTED_JOBLIST", "PUBLIC_OFFICIAL"]
    },
    "V101": {
      "label": "昇進・前進",
      "copyDirection": "確認済みの社員登用制度を、将来のステップとして描く",
      "requiredEvidence": {
        "source": "contract",
        "row": 27,
        "fields": ["employeeConversionYesMarker", "employeeConversionPeriod", "directEmploymentSalaryRange"],
        "allowedStatuses": ["CONFIRMED_INTERNAL"],
        "allowedYesPatterns": ["^(?:有|有り|あり|TRUE|true|1|○|〇|☑)$"]
      },
      "missingBehavior": "DO_NOT_GENERATE"
    },
    "V098": {
      "label": "学習",
      "copyDirection": "仕事内容・作業詳細・研修記載から、確認できる習得内容だけを描く",
      "allowedEvidenceSources": ["joblist_copy", "contract_row_31"],
      "allowedEvidenceStatuses": ["CONFIRMED_INTERNAL", "EXTRACTED_JOBLIST", "PUBLIC_OFFICIAL"]
    },
    "V023": {
      "label": "キャッシュフロー改善",
      "copyDirection": "日払い・週払い・前払いの確認済み条件を前に出す",
      "factPatterns": [
        {"source": "(?:日払い|週払い|前払い)", "flags": "u"}
      ],
      "allowedEvidenceStatuses": ["CONFIRMED_INTERNAL", "EXTRACTED_JOBLIST", "PUBLIC_OFFICIAL"]
    }
  },
  "competitorVariables": {
    "allowed": [
      {
        "id": 1,
        "label": "金額の見せ方",
        "rAxisIds": ["R001", "R011", "R012"],
        "sAxisIds": ["S063", "S001"],
        "requiresConfirmedMoneyFacts": true
      },
      {
        "id": 2,
        "label": "職種の呼び方",
        "rAxisIds": ["R047", "R099"],
        "sAxisIds": ["S063", "S065"],
        "requiresEvidence": ["joblist_job_title", "contract_row_31"]
      },
      {
        "id": 4,
        "label": "応募障壁の下げ方",
        "rAxisIds": ["R117", "R118", "R122"],
        "sAxisIds": ["S035", "S039"],
        "requiresConfirmedBarrierFacts": true
      },
      {
        "id": 5,
        "label": "緊急性",
        "rAxisIds": [],
        "sAxisIds": ["S045", "S044", "S054"],
        "requiresConfirmedRemainingSlotsOrDeadline": true
      },
      {
        "id": 7,
        "label": "休日",
        "rAxisIds": ["R014", "R024"],
        "sAxisIds": ["S059"],
        "requiresEvidence": ["joblist_holiday", "contract_rows_49_51"]
      },
      {
        "id": 8,
        "label": "作業の質",
        "rAxisIds": ["R099", "R059", "R156"],
        "sAxisIds": ["S056", "S070"],
        "requiresEvidence": ["joblist_description", "contract_rows_29_31"]
      },
      {
        "id": 9,
        "label": "住居・移動のうち送迎のみ",
        "rAxisIds": ["R035"],
        "sAxisIds": [],
        "allowedValues": ["送迎無料"],
        "requiresEvidence": ["contract_row_33"]
      }
    ],
    "forbidden": [
      {
        "id": 3,
        "label": "属性訴求",
        "blockedAxisIds": [],
        "reason": "年齢・性別の直接表現になるため"
      },
      {
        "id": 6,
        "label": "雇用の安定",
        "blockedAxisIds": ["R037", "R038", "R043"],
        "reason": "競合とFooTで雇用契約の事実が異なるため",
        "exception": "R043は内容確認書27行目のCONFIRMED_INTERNAL経路だけで利用可"
      },
      {
        "id": "9_housing",
        "label": "住居系",
        "blockedAxisIds": ["R009", "R153"],
        "blockedValues": ["寮費無料", "個室寮", "家賃0円", "奨励金"],
        "reason": "FooTの求人に住居支援の事実がないため"
      }
    ]
  },
  "forbiddenOutputPatterns": [
    {
      "id": "employment_misrepresentation",
      "source": "(?:正社員|正社員採用|直接雇用)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "age_attribute",
      "source": "(?:(?:[1-9][0-9]?|100)\\s*(?:代|歳)|年齢\\s*不問|若い|若手|若者|シニア|ミドル)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "sex_attribute",
      "source": "(?:男性|女性|男女|主婦|主夫)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "unsupported_housing",
      "source": "(?:寮|家賃|奨励金)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "competitor_identifier",
      "source": "(?:0063131_[^\\s]*|(?:^|[?&])jk=[A-Za-z0-9_-]+)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "manuscript_self_reference",
      "source": "(?:今回|本|この|当)の?(?:原稿|募集原稿|求人原稿|掲載文|求人票)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "previous_posting_reference",
      "source": "(?:現行|既存|前回|元)の?(?:求人|原稿|掲載|募集)(?:に|は|では|から)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "editorial_exclusion",
      "source": "(?:今回は|ここでは|本欄では)[^。！？!\\n]{0,40}(?:入れません|入れず|含めません|含めず|書きません|載せません)",
      "flags": "u",
      "risk": "HIGH_RISK"
    },
    {
      "id": "unverified_disclaimer",
      "source": "(?:未確認|未回答|裏(?:が|を)取れていない|確認(?:が|を)?取れていない)(?:の|な)?ため|(?:数字|表現|内容|情報)[^。！？!\\n]{0,12}(?:は|を)?(?:書いて|記載して|入れて)いません",
      "flags": "u",
      "risk": "HIGH_RISK"
    }
  ],
  "demotedLeadPatterns": [
    {"id": "dependent_income", "source": "扶養内\\s*(?:OK|可)?", "flags": "iu"},
    {"id": "four_hours_only", "source": "1日\\s*4時間(?:だけ)?", "flags": "u"},
    {"id": "slow_morning", "source": "(?:朝が早すぎない|朝はゆっくり)", "flags": "u"},
    {"id": "age_neutral", "source": "年齢\\s*不問", "flags": "u"},
    {"id": "easy_light_work", "source": "(?:カンタン|簡単)[・\\s]*(?:軽作業)?|軽作業", "flags": "u"}
  ],
  "commonImprovements": [
    {
      "id": "remove_decorations",
      "applyTo": ["A", "B"],
      "pattern": {"source": "[☆♪★]", "flags": "u"}
    },
    {
      "id": "move_confirmed_money_to_front",
      "applyTo": ["A", "B"],
      "requiresConfirmedMoneyFacts": true
    },
    {
      "id": "do_not_lead_with_demoted_patterns",
      "applyTo": ["A", "B"],
      "patternsRef": "demotedLeadPatterns"
    }
  ],
  "factPatterns": {
    "comparison": "variant_fact_tokens_must_be_subset_of_confirmed_source_tokens",
    "categories": [
      {
        "id": "salary",
        "sourceColumns": ["BG", "BH", "BI", "BJ", "BK", "BL", "BM", "BN", "BO", "BP", "CW", "CX"],
        "patterns": [
          {"source": "(?:時給|日給|月給|年収|給与|基本給)?\\s*[¥￥]?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:円|万円|万)", "flags": "u"}
        ]
      },
      {
        "id": "working_time",
        "sourceColumns": ["CY", "CZ", "ED"],
        "contractRows": [39, 40, 41, 42, 43, 45],
        "patterns": [
          {"source": "(?:[01]?\\d|2[0-3]):[0-5]\\d", "flags": "u"},
          {"source": "\\d+(?:\\.\\d+)?\\s*(?:時間|h)", "flags": "iu"}
        ]
      },
      {
        "id": "location",
        "sourceColumns": ["AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK"],
        "patterns": [
          {"source": "(?:愛知県)?[^、。\\s]{1,20}(?:市|区|町|村)", "flags": "u"}
        ]
      },
      {
        "id": "employment_type",
        "sourceColumns": ["E", "F", "EV"],
        "patterns": [
          {"source": "(?:派遣社員|契約社員|アルバイト|パート|有期|無期)", "flags": "u"}
        ]
      },
      {
        "id": "social_insurance",
        "sourceColumns": ["EH", "EI", "EJ", "EK", "EL", "EM", "EN", "EO", "EP"],
        "patterns": [
          {"source": "(?:健康保険|厚生年金|雇用保険|労災保険|社会保険)", "flags": "u"}
        ]
      }
    ],
    "onAddedOrChangedFact": "HIGH_RISK"
  },
  "monthlyConversion": {
    "allowEstimatedValues": false,
    "hourlyRateSource": "joblist_confirmed_salary",
    "allowedContractRows": [33, 39, 40, 41, 42, 43, 45],
    "requiredFacts": ["hourlyRate", "scheduledHoursPerDay", "workingDaysPerMonth"],
    "optionalOvertimeFacts": ["overtimeHoursPerMonth", "overtimeHourlyRate"],
    "formula": "hourlyRate * scheduledHoursPerDay * workingDaysPerMonth + overtimeHoursPerMonth * overtimeHourlyRate",
    "copyMustStateCalculationConditions": true,
    "informationColumn": "J",
    "informationFormat": "{status} | 月額換算根拠: 内容確認書 行{rows}; {conditions}",
    "missingBehavior": "DO_NOT_CONVERT"
  },
  "evidencePolicy": {
    "allowed": ["CONFIRMED_INTERNAL", "EXTRACTED_JOBLIST", "PUBLIC_OFFICIAL"],
    "blocked": ["CANDIDATE", "MISSING", "CONFLICT"],
    "blockedBehavior": {
      "CANDIDATE": "DO_NOT_GENERATE",
      "MISSING": "DO_NOT_GENERATE",
      "CONFLICT": "ESCALATE_TO_HUMAN"
    }
  },
  "fieldTargets": {
    "note": "文字数の上限はlimits.jsonが正本。ここは競合実測から決めた下限の目安。届かない場合も推測で埋めない。",
    "ownerMeaning": {
      "variant": "A〜E案ごとに変える欄",
      "fact": "5案共通の事実欄。案では変えない"
    },
    "roles": [
      { "role": "title", "itemNo": 3, "label": "職種名", "owner": "variant", "targetMin": 20, "askIfEmpty": true },
      { "role": "subtitle", "itemNo": 33, "label": "求人キャッチコピー", "owner": "variant", "targetMin": 60, "askIfEmpty": true },
      { "role": "description", "itemNo": 7, "label": "仕事内容", "owner": "variant", "targetMin": 400, "askIfEmpty": true },
      { "role": "personal", "itemNo": 28, "label": "求める人材", "owner": "variant", "targetMin": 150, "askIfEmpty": true },
      { "role": "salary_supplement", "itemNo": 63, "label": "給与の補足説明", "owner": "fact", "targetMin": 60, "askIfEmpty": true },
      { "role": "salary_example", "itemNo": 64, "label": "給与例", "owner": "fact", "targetMin": 40, "askIfEmpty": true },
      { "role": "working_time_supplement", "itemNo": 88, "label": "勤務時間・シフト・最低勤務期間の補足説明", "owner": "fact", "targetMin": 30, "askIfEmpty": true },
      { "role": "holiday", "itemNo": 90, "label": "休日・休暇の補足説明", "owner": "fact", "targetMin": 30, "askIfEmpty": true },
      { "role": "work_environment", "itemNo": 24, "label": "職場環境の補足説明", "owner": "fact", "targetMin": 30, "askIfEmpty": true },
      { "role": "probationary_period_supplement", "itemNo": 153, "label": "試用・研修期間の補足説明", "owner": "fact", "targetMin": 20, "askIfEmpty": true },
      { "role": "welfare", "itemNo": 97, "label": "福利厚生の補足説明", "owner": "fact", "targetMin": 150, "askIfEmpty": true },
      { "role": "selection_flow", "itemNo": 155, "label": "選考についての補足説明", "owner": "fact", "targetMin": 120, "askIfEmpty": true },
      { "role": "contract_renewal_period", "itemNo": 99, "label": "契約更新期間", "owner": "fact", "targetMin": 10, "askIfEmpty": true },
      { "role": "smoking_section_supplement", "itemNo": 22, "label": "喫煙に関する補足説明", "owner": "fact", "targetMin": 15, "askIfEmpty": true },
      { "role": "no_social_insurance_reason", "itemNo": 95, "label": "選択できない社会保険がある場合の理由", "owner": "fact", "targetMin": 0, "askIfEmpty": false }
    ]
  },
  "personaFallback": {
    "skeletonStatus": "skeleton",
    "axisOrderRef": "defaultAxes",
    "note": "ペルソナ未確定のためデフォルト軸で生成"
  },
  "competitorFallback": {
    "missingIsFatal": false,
    "axisOrderRef": "defaultAxes",
    "note": "競合パターン未読のため訴求軸辞書のみで生成"
  }
}
```
<!-- JOB_COPY_APPEAL_RULES_END -->

## 訴求案の生成式

```text
ターゲット条件
× 状況・トリガー
× 未充足欲求／不満
× 属性・仕組み
× 実用便益
× 心理・人生価値
× 根拠
× オファー
× 表現フレーム
```

入力要素をすべて埋める必要はない。確認済みの要素だけを使い、`CANDIDATE`・`MISSING`・`CONFLICT`をコピーへ混ぜない。

### 求人での展開例

| 要素 | 内容 |
|---|---|
| ターゲット | 子育て中の経験者 |
| 状況・不満 | 夕方の予定が読めず、家族との時間を確保できない |
| 属性・仕組み | 17時定時、転勤なし、希望休制度 |
| 実用便益 | 家族行事や送迎の予定を立てやすい |
| 心理・人生価値 | 家庭を犠牲にせず働ける安心と納得感 |
| 根拠 | 平均残業6.2時間、有休取得実績、子育て社員の事例 |
| オファー | 応募前の職場見学、カジュアル面談 |
| 表現フレーム | 具体フレーム＋利得フレーム |
| コピー例 | 家族の予定を、仕事の都合で諦めない。 |

これは生成式の構造例であり、FooT求人へ事実として転用しない。

## 求人訴求の3分類

1. **足切り回避軸** — 給与、勤務時間、休日、勤務地、雇用形態、仕事内容、応募資格、残業、転勤、福利厚生など、無いと応募検討に入らない条件。
2. **不安解消軸** — 未経験でも可能か、研修、身体負担、人間関係、ノルマ、入社後の支援、評価、求人と実態の一致など、応募前の不安を解く情報。
3. **差別化軸** — 独自の仕事内容、キャリア機会、裁量、社会的意義、組織文化、制度、技術、顧客・案件、成長機会など、同条件の求人から選ばれる理由。

主訴求は必ず③差別化軸から1つ選ぶ。①足切り回避軸は消さずに残し、①と②は副訴求として最大2つまで添える。

## 訴求タイトルの6型

| 型 | 用途 |
|---|---|
| 条件利益型 | 確認済みの条件を、得られる生活上の利益へつなぐ |
| 不安解消型 | 応募前の具体的不安を、確認済みの制度・手順で解く |
| キャリア型 | 身につく技能や確認済みの次の選択肢を示す |
| 仕事価値型 | 仕事内容が誰に何をもたらすかを示す |
| 人間関係型 | 確認済みのチーム構造・支援方法を示す |
| 希少性型 | 確認済みの募集枠・期限・固有性だけを示す |

BF（求人キャッチコピー）はこの6型から選ぶ。A/Bで型を変える場合は、主訴求を固定して差分を1つにする。

## デフォルト軸

ペルソナが`status: skeleton`の場合は、`V084 → V101 → V098 → V023`の順に根拠を探す。V101は内容確認書27行目が確認済みの場合だけ使う。年齢や性別を直接書かず、確認済み事実の表現だけを変える。

## 競合パターンの境界

安全に使えるのは変数1・2・4・5・7・8と、変数9の送迎だけ。変数3の属性訴求、変数6の雇用安定、変数9の住居系を使わない。R043は競合の型として使わず、内容確認書27行目の実データを根拠にした独立経路だけを許可する。

競合分析（`references/clients/{client}/competitors/_merged.md`）が無い場合も停止せず、デフォルト軸だけで生成して備考にフォールバック理由を残す。

## 月額換算

時給から月額へ換算する場合は、Joblistの確認済み時給と、内容確認書33・39〜43・45行目にある所定労働時間・月間勤務日数・残業条件だけを使う。必要な実数が1つでも欠ける場合は換算しない。換算値を出す場合は、原稿とJ列の両方に算出条件と出典行を明記する。

## 本文の文章構成型（A〜E 5案の設計）

上の「訴求タイトルの6型」はNo.33キャッチコピー用で、**本文（No.7仕事内容）の組み立て方ではない。**
本文は、何を言うか（訴求軸）と、どの順で読ませるか（構成型）の2軸で決める。

| 案 | 変えるもの | 構成型 |
|---|---|---|
| A・B・C | **訴求軸を変える**（例 A=通勤と生活リズム／B=作業負荷／C=収入の読みやすさ） | 説明型（結論→具体→補足） |
| **D** | **構成型を変える** | **QUEST-悩み型** |
| **E** | **構成型を変える** | **QUEST-数字型** |

A・B・Cは「何を言うか」の3択、D・Eは「どう読ませるか」の2択。
D・Eの訴求軸は、A〜Cで最も裏が取れている軸を使い回してよい（軸の新規発明はしない）。

### QUESTフォーミュラ

| 記号 | 段 | 求人での役割 |
|---|---|---|
| **Q** | Qualify | 読み手に「これは自分向けだ」と気づかせる。**ここで絞る** |
| **U** | Understand | いまの不満・不安を言語化して、分かっていることを示す |
| **E** | Educate | 実際の仕事・条件を具体的に教える。**確認済みの事実だけ** |
| **S** | Stimulate | 得られる生活の変化を**数字で**示す |
| **T** | Transition | 次の一歩を軽くする。応募の手順と持ち物 |

### D案：QUEST-悩み型（Qを悩みの列挙で行う）

```text
Q  土日はしっかり休みたい。でも収入は落としたくない。
U  この2つを両立できる求人が少ないことは、探している方ほどご存じだと思います。
E  {確認済みの仕事内容。工程・使う機械・1日の流れ}
S  {年間休日◯日／月収例◯円（内訳）／残業月◯時間}
T  {応募に要るもの／面接の形式／連絡から内定までの日数}
```

**この型は年齢をひとことも書かずに読み手を絞れる。**
競合の実例（`competitors/_merged.md` セクション10）では、悩みを3行並べる書き出しが使われている。
年齢・性別を応募条件に書く禁止（セクション8-2）を守ったまま、20〜30代が反応する条件で絞れる唯一の経路。

### E案：QUEST-数字型（Qを条件の断定で行う）

```text
Q  年間休日{◯}日。月収例{◯}円。未経験スタート{◯}割。
U  条件で選びたい方向けに、先に数字を出します。
E  {確認済みの仕事内容}
S  {残業単価／深夜単価／昇給・賞与の実績}
T  {応募手順}
```

**数字が1つでも確認できていない場合、この型は使わない。**
「約」「程度」で濁した数字を並べるとQ段の意味が消える。数字が足りないならD案だけを出す。

### 5案に共通する制約

- **確認済みの事実だけを使う。**構成型を変えても、書ける事実は増えない。
- 未回答だった項目は5案すべてで使わない。型を埋めるために推測を書かない。
- 5案は同時掲載しない。1案を選んでから掲載する。

## 欄別の目標情報量

競合（ワールドインテック・Indeed 11本）の実測と、AirWorkの上限（`limits.json`）の対比。
**上限まで書くことが目的ではない。確認済みの事実が尽きたらそこで止める。**

| No. | 欄 | 上限 | 競合の実測 | 目標 |
|---|---|---|---|---|
| 7 | 仕事内容 | 10,000字 | 平均**383字**・最長450字 | **400〜600字**。工程・使う機械・1日の流れ・何をしないかまで書く |
| 28 | 求める人材 | 2,000字 | 平均104字 | 150〜300字。**必須条件を先に確定させ、残りは応募障壁を下げるために使う**（セクション11） |
| 33 | キャッチコピー | 100字 | — | 上限内で最大まで使う |
| 63 | 給与の補足説明 | 1,000字 | 手当を漏れなく列挙 | **残業単価・深夜単価を金額で書く**（`残業2,250円` のように） |
| 64 | 給与例 | 1,000字 | `月収例373,880円（1,800円×156.6H＋残業2,250円×20H＋深夜450円×60H＋通勤手当20,000円）` | **内訳を全部書く。**時給×時間だけで終えない |
| — | 休日・休暇の補足説明 | 1,000字 | `年間休日121日` ＋長期連休を具体名で | **年間休日を日数で書く。**「土日休み」だけで終えない |
| — | 勤務時間・シフトの補足説明 | 1,000字 | `実働7時間50分／休憩60分／残業月20時間` | 実働・休憩・残業見込みを数字で |
| — | 職場環境の補足説明 | 1,000字 | 独立欄を持たず、勤務地備考に喫煙情報を入れている | 喫煙環境・空調・立ち仕事の有無。**確認できた分だけ** |
| — | 試用・研修期間の補足説明 | 1,000字 | 全求人同一・`14日間／同条件` の3行 | 期間と、条件が本採用と同じかどうかだけ。長く書かない |

**競合は欄数で勝っていない。数字で書ける欄を数字で埋めて勝っている。**
「土日休み」「未経験歓迎」「アットホーム」のような、どの求人にも書ける言葉を減らし、
その求人でしか書けない数字（年間休日日数・残業単価・実働時間・月収例の内訳）に置き換える。

### 書けない欄は空欄のままにする

上の表の目標に届かない場合、推測で埋めない。
`前回推測`・`未検証` の値を使って字数を稼ぐことは、5案すべてで禁止する。
足りない項目は手順0のヒアリングに回し、それでも回答が無ければその欄は触らない。
