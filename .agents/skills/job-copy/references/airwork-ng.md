# Airワーク求人原稿 lint 根拠・機械可読ルール

Phase 1 lint用の公開規約要約と機械可読ルール。原典は `Airワーク求人掲載 NG・注意事項.md`。lintは候補を検出するだけで、元原稿を修正しない。

## 責任分界

Airワークには非公開の審査基準がある。検出なしでも掲載可能とは限らず、最終判断は人間が行う。文字数、禁止語、審査閾値は変更され得るため、管理画面と最新公式ヘルプを優先する。

## 機械可読ルール

次のマーカー間JSONを `lint_copy.mjs` の正本とする。正規表現、テスト入力、矛盾条件、企業名抽出条件をコードへ複製しない。

<!-- JOB_COPY_LINT_RULES_START -->
```json
{
  "schemaVersion": "1.0.0",
  "normalization": { "unicode": "NFKC", "trim": true, "lineBreak": "LF" },
  "rules": [
    {
      "id": "R1",
      "title": "年齢に言及する表現",
      "risk": "HIGH_RISK",
      "basis": ["Airワーク §6-1", "雇用対策法10条"],
      "patterns": [
        { "id": "age_number", "source": "(?:[1-9][0-9]?|100)\\s*(?:代|歳)", "flags": "u" },
        { "id": "age_neutral", "source": "年齢\\s*不問", "flags": "u" },
        { "id": "age_descriptor", "source": "(?:若い|若手|若者|シニア|ミドル)", "flags": "u" }
      ],
      "testInput": [
        { "name": "年齢と性別を別検出", "input": { "fields": { "AX": "・20代〜30代の女性スタッフが中心となって活躍中！" } }, "expected": { "ruleIds": ["R1", "R2"] } },
        { "name": "年齢不問", "input": { "fields": { "BF": "年齢不問★" } }, "expected": { "ruleIds": ["R1"] } }
      ]
    },
    {
      "id": "R2",
      "title": "性別に言及する表現",
      "risk": "HIGH_RISK",
      "basis": ["Airワーク §6-1", "男女雇用機会均等法5条"],
      "patterns": [
        { "id": "sex_terms", "source": "(?:女性|男性|男女|主婦|主夫)", "flags": "u" },
        { "id": "gendered_job_title", "source": "(?:ウェイトレス|(?:営業|セールス|ビジネス|サラリー|ガード|カメラ|ドア|キッチン)マン)", "flags": "u" }
      ],
      "testInput": [
        { "name": "性別表現", "input": { "fields": { "AX": "女性スタッフが活躍中" } }, "expected": { "ruleIds": ["R2"] } }
      ]
    },
    {
      "id": "R3",
      "title": "国籍・人種に言及する表現",
      "risk": "HIGH_RISK",
      "basis": ["Airワーク §6-1", "職業安定法5条の5"],
      "patterns": [
        { "id": "nationality_race", "source": "(?:国籍\\s*不問|外国(?:人|籍)|日本人|中国人|韓国人|朝鮮人|白人|黒人|人種)", "flags": "u" }
      ],
      "testInput": [
        { "name": "国籍不問", "input": { "fields": { "AX": "国籍不問です" } }, "expected": { "ruleIds": ["R3"] } }
      ]
    },
    {
      "id": "R4",
      "title": "断定的な将来表現",
      "risk": "WARN",
      "basis": ["Airワーク §18（誇大・虚偽表示）"],
      "patterns": [
        { "id": "definitive_future", "source": "(?:必ず稼げる|絶対(?:に)?[^。！？!\\n]{0,30}(?:稼げる|儲かる|正社員|昇給|採用|成功)|(?:年収|月収|収入)[^。！？!\\n]{0,20}確実)", "flags": "u" }
      ],
      "testInput": [
        { "name": "収入の断定", "input": { "fields": { "BF": "未経験でも必ず稼げる" } }, "expected": { "ruleIds": ["R4"] } }
      ]
    },
    {
      "id": "R5",
      "title": "根拠なき最上級表現",
      "risk": "WARN",
      "basis": ["景品表示法"],
      "requiresEvidence": true,
      "patterns": [
        { "id": "superlative", "source": "(?:日本一|世界一|業界\\s*(?:No\\.?\\s*1|ナンバーワン|1位)|地域\\s*(?:No\\.?\\s*1|ナンバーワン|1位))", "flags": "iu" }
      ],
      "evidencePatterns": [
        { "id": "source_citation", "source": "(?:出典|調査(?:名|期間|主体)|第三者機関|\\d{4}年[^。]{0,30}調べ)", "flags": "u" }
      ],
      "testInput": [
        { "name": "根拠のないNo.1", "input": { "fields": { "BF": "業界No.1の働きやすさ" } }, "expected": { "ruleIds": ["R5"] } }
      ]
    },
    {
      "id": "R6",
      "title": "事実条件タグと文面の矛盾",
      "risk": "HIGH_RISK",
      "basis": ["Airワーク §18（虚偽表示）"],
      "contradictions": [
        {
          "id": "overtime_none_vs_overtime_copy",
          "tagColumns": ["EB", "EC"],
          "tagPatterns": [{ "source": "残業(?:なし|ゼロ|ほぼなし)", "flags": "u" }],
          "copyColumns": ["H", "O", "AP", "AS", "AX", "BF", "CW", "CX", "ED", "EG", "EP", "ES", "EV", "HS", "HV"],
          "copyPatterns": [{ "source": "(?:残業で(?:しっかり)?稼げる|残業(?:あり|が多い|をお願い))", "flags": "u" }]
        },
        {
          "id": "weekends_off_vs_weekend_work",
          "tagColumns": ["EE", "EF"],
          "tagPatterns": [{ "source": "(?:土日祝休み|完全週休2日)", "flags": "u" }],
          "copyColumns": ["O", "ED", "EG"],
          "copyPatterns": [{ "source": "(?:土日(?:も|は)?(?:出勤|勤務)|休日出勤あり)", "flags": "u" }]
        },
        {
          "id": "no_transfer_vs_transfer",
          "tagColumns": ["AL", "AM"],
          "tagPatterns": [{ "source": "転勤なし", "flags": "u" }],
          "copyColumns": ["O", "AX", "BF"],
          "copyPatterns": [{ "source": "(?:全国転勤|転勤あり)", "flags": "u" }]
        }
      ],
      "testInput": [
        { "name": "残業タグとの矛盾", "input": { "fields": { "EC": "残業なし", "O": "残業でしっかり稼げる職場です" } }, "expected": { "ruleIds": ["R6"], "contradictionIds": ["overtime_none_vs_overtime_copy"] } }
      ]
    },
    {
      "id": "R7",
      "title": "CANDIDATE情報を根拠にした断定",
      "risk": "WARN",
      "basis": ["実装計画書 §8-3(d)"],
      "candidateEvidence": {
        "statusRef": "references/clients/foot/config.json#/evidenceStatuses/candidate",
        "statusField": "status",
        "valueField": "value",
        "sourceColumnField": "sourceColumn",
        "matchMode": "normalized_candidate_value_appears_in_copy",
        "minimumValueLength": 2
      },
      "testInput": [
        { "name": "候補タグを事実として記載", "input": { "fields": { "ES": "社員登用あり" }, "evidence": [{ "sourceColumn": "ER", "value": "社員登用あり", "status": "CANDIDATE" }] }, "expected": { "ruleIds": ["R7"] } }
      ]
    },
    {
      "id": "R8",
      "title": "文字数超過",
      "risk": "WARN",
      "basis": ["references/clients/foot/limits.json"],
      "limitsRef": "references/clients/foot/limits.json",
      "testInput": [
        { "name": "職種名の暫定上限超過", "input": { "valueFactory": { "column": "H", "repeat": "あ", "count": 101 } }, "expected": { "ruleIds": ["R8"] } }
      ]
    },
    {
      "id": "R9",
      "title": "許可リストにない企業名・派遣先名",
      "risk": "HIGH_RISK",
      "basis": ["Airワーク §5-1", "Airワーク §13-1", "Airワーク §17-2"],
      "entityPatterns": [
        { "id": "labeled_company", "source": "(?:派遣先|就業先|勤務先|企業名|会社名)\\s*[:：]\\s*(?<entity>(?:(?:株式会社|有限会社|合同会社)[^\\s、。,.，．「」『』【】()（）]+|[^\\s、。,.，．「」『』【】()（）:：]+(?:株式会社|有限会社|合同会社)))", "flags": "u", "captureGroup": "entity" },
        { "id": "quoted_company", "source": "[「『【](?<entity>(?:(?:株式会社|有限会社|合同会社)[^「」『』【】]+|[^「」『』【】]+(?:株式会社|有限会社|合同会社)))[」』】]", "flags": "u", "captureGroup": "entity" }
      ],
      "allowedNamesRef": "references/clients/foot/config.json#/allowedEntities",
      "testInput": [
        { "name": "未許可の架空派遣先名", "input": { "fields": { "O": "派遣先：架空物流株式会社" } }, "expected": { "ruleIds": ["R9"], "entities": ["架空物流株式会社"] } }
      ]
    },
    {
      "id": "R10",
      "title": "原稿についての説明・編集判断が本文に混入",
      "risk": "HIGH_RISK",
      "basis": ["納品要件（事務員がそのままコピペで出稿できること）", "Airワーク §5-1（求人情報の正確性）"],
      "patterns": [
        { "id": "manuscript_self_reference", "source": "(?:今回|本|この|当)の?(?:原稿|募集原稿|求人原稿|掲載文|求人票)", "flags": "u" },
        { "id": "previous_posting_reference", "source": "(?:現行|既存|前回|元)の?(?:求人|原稿|掲載|募集)(?:に|は|では|から)", "flags": "u" },
        { "id": "editorial_exclusion", "source": "(?:今回は|ここでは|本欄では)[^。！？!\\n]{0,40}(?:入れません|入れず|含めません|含めず|書きません|載せません)", "flags": "u" },
        { "id": "unverified_disclaimer", "source": "(?:未確認|未回答|裏(?:が|を)取れていない|確認(?:が|を)?取れていない)(?:の|な)?ため|(?:数字|表現|内容|情報)[^。！？!\\n]{0,12}(?:は|を)?(?:書いて|記載して|入れて)いません", "flags": "u" }
      ],
      "testInput": [
        { "name": "原稿への自己言及", "input": { "fields": { "O": "今回の原稿では輸送業務は入れません。" } }, "expected": { "ruleIds": ["R10"] } },
        { "name": "未確認の断り書き", "input": { "fields": { "O": "作業量は未確認のため、1日何件といった数字は書いていません。" } }, "expected": { "ruleIds": ["R10"] } }
      ]
    }
  ]
}
```
<!-- JOB_COPY_LINT_RULES_END -->

## 根拠要約

### §6-1 差別表現・応募資格

例外を除き、国籍・人種、思想・宗教、身体・健康、家族、出身、年齢、性別などを理由に募集を限定しない。`国籍不問`、`20〜30代歓迎`、`女性歓迎`も明示例に含まれる。属性ではなく職務上必要な能力・経験・勤務条件を書く。

### §18 虚偽・誇大表示

表現を直しても実態と一致しなければ虚偽表示になる。`未経験でも絶対稼げる`、`必ず正社員になれます`、実態と異なる`残業ゼロ`、根拠のない最上級表現は高リスク。Phase 1は検出のみで書き換えない。

### §5-1 求人情報の正確性

求人は実在し、最新かつ具体的でなければならない。存在しない仕事、終了済み求人、別求人への誘導、偽の勤務地、到達不能な好条件、雇用形態を誤認させる表示を禁止する。

### §5-3 同一採用枠の重複掲載

同じ採用枠について、職種名や説明だけを変えた複数求人を作成しない。分けて掲載できるのは、次のいずれかにより実質的に別の採用枠である場合に限る。

- 実際に勤務地が異なる
- 雇用形態ごとに採用枠・条件が異なる
- 職種・仕事内容が明確に異なる
- シフト、資格、責任範囲等が実質的に別ポジションである

同一勤務地・同一条件・同一採用枠で、`一般事務`、`未経験OKの一般事務`、`土日休みの一般事務`のように表現だけを変えた求人は1件に統合する。A/Bテストも同一求人を複製して同時掲載せず、期間で分ける。

### §13-1 派遣・有料職業紹介

求人企業から直接依頼を受けた求人だけを掲載し、派遣・紹介であること、実際の就業先、職務、条件を事実どおり示す。架空案件、終了案件、登録者集めだけの求人は掲載しない。

### §17-2 Indeed／Indeed PLUS

偽の勤務地、無関係な職種名、募集者と雇用主の関係が不明な求人、登録者獲得だけの内容、終了済み求人、応募後の別求人誘導などは非掲載・露出制限のリスクがある。

### §21-1 非公開の審査基準

内部スコア、禁止語辞書、審査閾値は非公開であり、公開情報だけで完全網羅できない。lint通過は掲載可否や適法性を保証しない。

## 正本

- Airワーク 原稿掲載ガイドライン: <https://faq.rct.airwork.net/hc/ja/articles/20866792651673-%E5%8E%9F%E7%A8%BF%E6%8E%B2%E8%BC%89%E3%82%AC%E3%82%A4%E3%83%89%E3%83%A9%E3%82%A4%E3%83%B3>
- Airワーク 派遣社員求人に必要な設定: <https://faq.rct.airwork.net/hc/ja/articles/20870158764057-%E6%9C%89%E6%96%99%E8%81%B7%E6%A5%AD%E7%B4%B9%E4%BB%8B-%E6%B4%BE%E9%81%A3%E7%A4%BE%E5%93%A1%E3%81%AE%E6%B1%82%E4%BA%BA%E3%82%92%E5%8B%9F%E9%9B%86%E3%81%99%E3%82%8B%E9%9A%9B%E3%81%AB%E5%BF%85%E8%A6%81%E3%81%AA%E8%A8%AD%E5%AE%9A>
- Indeed 求人掲載基準・利用規約: <https://jp.indeed.com/legal>

更新時は公式原典とFooT様の管理画面を確認し、マーカー間JSONと根拠要約を同時に更新する。
