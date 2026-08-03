# Airワーク タグ診断ルール

タグ診断の正本。`audit_tags.mjs` はマーカー間JSONを読み、同じ語句・列・判定条件をコードへ複製しない。

## 機械可読ルール

<!-- JOB_COPY_TAG_RULES_START -->
```json
{
  "schemaVersion": "1.0.0",
  "normalization": {
    "unicode": "NFKC",
    "trim": true,
    "lineBreak": "LF"
  },
  "targetCategories": [
    {
      "id": "selection_flow",
      "label": "選考の流れ",
      "idColumns": ["HT"],
      "nameColumns": ["HU"]
    },
    {
      "id": "work_environment",
      "label": "職場環境",
      "idColumns": ["AQ"],
      "nameColumns": ["AR"]
    },
    {
      "id": "welfare",
      "label": "福利厚生",
      "idColumns": ["EQ"],
      "nameColumns": ["ER"]
    },
    {
      "id": "working_hours",
      "label": "勤務形態・勤務時間の特徴",
      "idColumns": ["EB"],
      "nameColumns": ["EC"]
    },
    {
      "id": "salary",
      "label": "給与の特徴",
      "idColumns": ["CU"],
      "nameColumns": ["CV"]
    },
    {
      "id": "holiday",
      "label": "休日・休暇",
      "idColumns": ["EE"],
      "nameColumns": ["EF"]
    },
    {
      "id": "job_features",
      "label": "仕事内容の特徴",
      "idColumns": ["P", "R", "T", "V", "X", "Z", "AB"],
      "nameColumns": ["Q", "S", "U", "W", "Y", "AA", "AC"]
    },
    {
      "id": "location_features",
      "label": "勤務地の特徴",
      "idColumns": ["AL"],
      "nameColumns": ["AM"]
    }
  ],
  "copyColumns": ["H", "O", "AP", "AS", "AX", "BF", "CW", "CX", "ED", "EG", "EP", "ES", "EV", "HS", "HV"],
  "immutableReferences": {
    "jobNumberColumn": "A",
    "publicationStatusColumns": ["B", "C"],
    "employmentTypeColumns": ["E", "F"],
    "ageRestrictionColumn": "AZ",
    "actualWorkLocationColumns": ["AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK"]
  },
  "removalRules": [
    {
      "id": "TAG_REMOVE_60S_APPLY",
      "target": "tag",
      "match": {
        "type": "tag_id",
        "columnsRef": "targetCategories.*.idColumns",
        "values": ["65U83"]
      },
      "recommendation": "REMOVE",
      "risk": "STRATEGY_MISMATCH",
      "reason": "20-30代獲得を目的とする求人で、60代を検索露出上の主対象としているため",
      "preserve": {
        "column": "AZ",
        "meaning": "年齢の制限=なし"
      }
    },
    {
      "id": "COPY_REMOVE_AGE_NEUTRAL",
      "target": "copy",
      "match": {
        "type": "regex",
        "columnsRef": "copyColumns",
        "source": "年齢\\s*不問",
        "flags": "u"
      },
      "recommendation": "REMOVE_FROM_MESSAGE",
      "risk": "HIGH_RISK",
      "reason": "年齢への直接言及であり、全年齢向けの訴求になって主対象が不明確になるため"
    },
    {
      "id": "COPY_REMOVE_WIDE_AGE_RANGE",
      "target": "copy",
      "match": {
        "type": "regex",
        "columnsRef": "copyColumns",
        "source": "10\\s*代[^。！？!\\n]{0,30}60\\s*代(?:まで)?(?:活躍中)?",
        "flags": "u"
      },
      "recommendation": "REMOVE_FROM_MESSAGE",
      "risk": "HIGH_RISK",
      "reason": "年齢への直接言及であり、全年齢向けの訴求になって主対象が不明確になるため"
    }
  ],
  "additionRules": [
    {
      "id": "TAG_ADD_20S_MANY_CANDIDATE",
      "tagId": null,
      "tagLabel": "20代が多い 相当",
      "recommendation": "PROPOSE_ONLY",
      "status": "CANDIDATE",
      "autoApply": false,
      "reason": "タグIDと派遣求人での選択可否が未確認。実態と異なれば虚偽表示になるため裏取りが必要。ヒアリング履歴の年齢構成が確認済みなら職場情報タグとして採用してよい。未回答なら既存タグも含めて全削除する。いずれの場合も応募資格は全年齢のまま動かさない"
    },
    {
      "id": "TAG_ADD_30S_MANY_CANDIDATE",
      "tagId": null,
      "tagLabel": "30代が多い 相当",
      "recommendation": "PROPOSE_ONLY",
      "status": "CANDIDATE",
      "autoApply": false,
      "reason": "タグIDと派遣求人での選択可否が未確認。実態と異なれば虚偽表示になるため裏取りが必要。ヒアリング履歴の年齢構成が確認済みなら職場情報タグとして採用してよい。未回答なら既存タグも含めて全削除する。いずれの場合も応募資格は全年齢のまま動かさない"
    },
    {
      "id": "TAG_ADD_EMPLOYEE_CONVERSION",
      "tagId": "4E8M2",
      "tagLabel": "社員登用あり",
      "recommendation": "ADD_IF_CONFIRMED",
      "status": "CONFIRMED_INTERNAL",
      "autoApply": false,
      "evidence": {
        "source": "contract",
        "row": 27,
        "field": "employeeConversionYesMarker",
        "fieldAliases": ["employeeConversionAvailability"],
        "allowedPatterns": ["^(?:有|有り|あり|TRUE|true|1|○|〇|☑)$"]
      },
      "reason": "内容確認書27行目で社員登用が有と確認できた場合のみ追加推奨"
    },
    {
      "id": "TAG_ADD_INEXPERIENCED",
      "tagId": null,
      "tagLabel": "未経験歓迎 相当",
      "recommendation": "ADD_IF_EXTRACTED",
      "status": "EXTRACTED_JOBLIST",
      "autoApply": false,
      "evidence": {
        "source": "joblist_copy",
        "columnsRef": "copyColumns",
        "patterns": [
          {
            "source": "(?:未経験(?:者)?(?:歓迎|OK|可|でも|から)|経験\\s*不問)",
            "flags": "iu"
          }
        ]
      },
      "alreadySatisfiedBy": {
        "tagNamePatterns": [
          {"source": "(?:業界)?未経験(?:者)?歓迎|経験\\s*不問", "flags": "iu"}
        ]
      },
      "reason": "現行原稿に未経験可の記述がある場合のみ追加推奨"
    }
  ],
  "textExpressionPolicy": {
    "tagSelectableDoesNotMeanCopyAllowed": true,
    "attributeTagExamples": ["20代が多い 相当", "30代が多い 相当"],
    "forbiddenCopyExamples": ["20代歓迎", "30代歓迎", "男性歓迎", "女性歓迎"],
    "basis": ["Airワーク §6-1", "雇用対策法10条", "男女雇用機会均等法5条"]
  },
  "duplicateGate": {
    "id": "DUPLICATE_HIRING_SLOT",
    "risk": "HIGH_RISK",
    "rule": "同じ採用枠について職種名や説明だけを変えた複数求人を掲載しない",
    "allowedSplitCriteria": [
      "実際に勤務地が異なる",
      "雇用形態ごとに採用枠・条件が異なる",
      "職種・仕事内容が明確に異なる",
      "シフト・資格・責任範囲等が実質的に別ポジション"
    ],
    "sameHiringSlotFactGroups": [
      "actualWorkLocation",
      "employmentTypeAndConditions",
      "jobDuties",
      "shiftQualificationResponsibility"
    ],
    "copyOnlyDifferenceIsNotEligible": true,
    "humanReviewRequired": true,
    "basis": ["Airワーク §5-3"]
  },
  "abTestPolicy": {
    "runSimultaneously": false,
    "sequence": [
      "施策前ベースライン",
      "タグ棚卸し後2週間",
      "A案2週間",
      "B案2週間"
    ],
    "minimumWeeksPerVariant": 2,
    "doNotCopyCompetitorParallelListings": true,
    "reason": "掲載枠コスト・Airワーク §5-3・応募管理上の問題を避け、タグと文面の効果を分離するため"
  }
}
```
<!-- JOB_COPY_TAG_RULES_END -->

## 運用上の意味

`65U83 60代も応募可`や年齢表現の削除は、60代を応募対象から外す操作ではない。`AZ 年齢の制限=なし`を維持するため、応募資格は全年齢のままである。変えるのは検索露出とメッセージの向き先だけとする。

タグとして選べることと、本文に書けることは別である。`20代が多い`相当のタグが存在しても、本文の`20代歓迎`を許可しない。`CANDIDATE`は提案にだけ出し、自動付与や文面生成の根拠に使わない。

同一求人のA/B案は同時掲載しない。前半2週間をA案、後半2週間をB案として期間で分ける。競合が同一求人を3本同時に出している運用は、掲載枠コスト・重複掲載規約・応募管理の観点から真似しない。
