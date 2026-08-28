#!/usr/bin/env python3
"""内容確認書スプレッドシートを直接読み、原稿生成が使う contract JSON を作る。

使い方:
  python3 read_contract.py --client foot
  python3 read_contract.py --client foot --output /tmp/contract.json
  python3 read_contract.py --client foot --probe      # 疎通確認だけ（値は読まない）
  python3 read_contract.py --self-test

なぜ CSV を挟まないのか（毎回聞かれるので書いておく）:
  データはスプレッドシートにある。以前 CSV を挟んでいたのは、読み取り側が
  Node 製で Google の認証を持っていなかったからで、設計上の必然ではなかった。
  認証は Python 側に一本化してあるので、Python から直接読めば CSV は要らない。

  もう一つ、こちらの方が重い理由がある。CSV を挟むと、読まないと決めた
  行35（年齢・性別・国籍）まで物理的にファイルへ書き出される。preflight が
  「シート全体形式。行35が含まれますが参照しません」と警告していたのがそれで、
  「参照しない」を運用ルールで守っている状態だった。

  直読みでは contract-map.json に書かれた許可範囲だけを batchGet で取りに行く。
  行35を含む範囲はそもそも要求しないので、行35の値は手元に一度も来ない。
  運用ルールではなく構造で守る。

行35ガード（1つでも外すと法令リスクに戻る）:
  (a) compile_contract_map()  … マップ側で source_row=35 と行35をまたぐ範囲を拒否
  (b) build_range_requests()  … API へ投げる直前に全範囲を再検査
  (c) normalize_six_column_rows() … レコード側で source_row=35 と行35を含む範囲を拒否
  (d) run_self_test()         … 行35を要求したら例外を投げる fetcher で通し、
                                 sentinel が出力 JSON に出ないことを検査
"""

import argparse
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

# 出力先を /tmp 配下に縛る門番。実装は secure_tmp.py の1本だけ。
# 各スクリプトが自前で書いていた頃は、片方だけ直したときに静かに穴が空いた。
from secure_tmp import OUT_DIR, secure_write_tmp  # noqa: E402,F401

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

CONTRACT_HEADERS = ("client_id", "source_row", "source_range", "key", "value", "evidence_status")
EXCLUDED_SOURCE_ROW = 35

CLIENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
RANGE_RE = re.compile(r"^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$")
ROW_RE = re.compile(r"^[1-9][0-9]*$")

SENTINEL = "ROW35_AGE_GENDER_NATIONALITY_MUST_NOT_BE_READ"


# ---------------------------------------------------------------- 基本ユーティリティ

def column_to_index(column):
    """A→0, B→1, AZ→51。read_joblist.mjs の columnToIndex と同じ 0 起点。"""
    if not isinstance(column, str) or not re.fullmatch(r"[A-Za-z]+", column or ""):
        raise ValueError(f"Invalid spreadsheet column: {column!r}")
    value = 0
    for char in column.upper():
        value = value * 26 + ord(char) - 64
    return value - 1


def parse_source_range(source_range):
    if not isinstance(source_range, str):
        raise ValueError("source_range must be a string.")
    match = RANGE_RE.match(source_range)
    if not match:
        raise ValueError(f"Invalid source_range: {source_range!r}")
    start_column = column_to_index(match.group(1))
    start_row = int(match.group(2))
    end_column = column_to_index(match.group(3))
    end_row = int(match.group(4))
    if start_column > end_column or start_row > end_row:
        raise ValueError(f"Reversed source_range: {source_range}")
    return {
        "startColumn": start_column,
        "startRow": start_row,
        "endColumn": end_column,
        "endRow": end_row,
    }


def range_contains_row(source_range, row_number):
    parsed = parse_source_range(source_range)
    return parsed["startRow"] <= row_number <= parsed["endRow"]


def parse_source_row(value):
    if not isinstance(value, str) or not ROW_RE.match(value):
        raise ValueError(f"source_row must be a positive base-10 integer: {value!r}")
    return int(value)


def normalize_cell(value):
    """NFKC 正規化 + 改行を LF に統一 + 前後の空白除去。read_contract.mjs と同じ。"""
    text = "" if value is None else str(value)
    return unicodedata.normalize("NFKC", text).replace("\r\n", "\n").replace("\r", "\n").strip()


def assert_client_id(client_id):
    if not isinstance(client_id, str) or not CLIENT_ID_RE.match(client_id):
        raise ValueError(f"Invalid client id: {client_id}")


# ---------------------------------------------------------------- (a) マップの検証

def compile_contract_map(contract_map, client_id):
    """contract-map.json を検証して使える形にする。行35ガード(a)はここ。"""
    assert_client_id(client_id)
    if not isinstance(contract_map, dict):
        raise ValueError("contract-map.json must contain an object.")
    if contract_map.get("clientId") != client_id:
        raise ValueError(
            f"Client mismatch: contract-map is {contract_map.get('clientId')}, "
            f"requested client is {client_id}."
        )
    columns = contract_map.get("csvColumns")
    if not isinstance(columns, list) or tuple(columns) != CONTRACT_HEADERS:
        raise ValueError(f"contract-map.json csvColumns must be exactly: {','.join(CONTRACT_HEADERS)}")
    raw_fields = contract_map.get("fields")
    if not isinstance(raw_fields, list) or not raw_fields:
        raise ValueError("contract-map.json fields[] is required.")

    fields = []
    by_key = {}
    for raw in raw_fields:
        if not isinstance(raw, dict):
            raise ValueError("Every contract-map field must be an object.")
        key = raw.get("key")
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise ValueError(f"Invalid contract-map key: {key}")
        if key in by_key:
            raise ValueError(f"Duplicate contract-map key: {key}")
        label = raw.get("label")
        if not isinstance(label, str) or not label:
            raise ValueError(f"contract-map label is required for {key}.")
        source_row = raw.get("sourceRow")
        if not isinstance(source_row, int) or isinstance(source_row, bool) or source_row <= 0:
            raise ValueError(f"contract-map sourceRow must be a positive integer for {key}.")
        if source_row == EXCLUDED_SOURCE_ROW:
            raise ValueError(
                f"contract-map must structurally exclude source row {EXCLUDED_SOURCE_ROW}: {key}"
            )
        raw_ranges = raw.get("sourceRanges")
        if not isinstance(raw_ranges, list) or not raw_ranges:
            raise ValueError(f"contract-map sourceRanges[] is required for {key}.")
        ignore_values = raw.get("ignoreValues")
        if ignore_values is not None and (
            not isinstance(ignore_values, list)
            or any(not isinstance(value, str) for value in ignore_values)
        ):
            raise ValueError(f"contract-map ignoreValues[] must contain strings for {key}.")

        source_ranges = []
        for raw_range in raw_ranges:
            if not isinstance(raw_range, str) or raw_range != raw_range.strip():
                raise ValueError(f"contract-map source range must be an exact string for {key}.")
            parsed = parse_source_range(raw_range)
            if parsed["startRow"] <= EXCLUDED_SOURCE_ROW <= parsed["endRow"]:
                raise ValueError(
                    f"contract-map range must structurally exclude row "
                    f"{EXCLUDED_SOURCE_ROW}: {raw_range}"
                )
            if not parsed["startRow"] <= source_row <= parsed["endRow"]:
                raise ValueError(
                    f"contract-map sourceRow {source_row} is outside {raw_range} for {key}."
                )
            if raw_range in source_ranges:
                raise ValueError(f"Duplicate contract-map source range for {key}: {raw_range}")
            source_ranges.append(raw_range)

        field = {
            "key": key,
            "label": label,
            "sourceRow": source_row,
            "sourceRanges": tuple(source_ranges),
            "ignoreValues": tuple(ignore_values or ()),
        }
        fields.append(field)
        by_key[key] = field

    return {"fields": tuple(fields), "byKey": by_key}


def load_references(client_id, skill_root=SKILL_ROOT):
    assert_client_id(client_id)
    client_dir = os.path.join(skill_root, "references", "clients", client_id)
    config = _read_json(os.path.join(client_dir, "config.json"))
    contract_map = _read_json(os.path.join(client_dir, "contract-map.json"))
    if config.get("clientId") != client_id:
        raise ValueError(
            f"Client mismatch: config is {config.get('clientId')}, requested client is {client_id}."
        )
    sheet = (config.get("contract") or {}).get("spreadsheet")
    if not isinstance(sheet, dict) or not sheet.get("id"):
        raise ValueError("config.json contract.spreadsheet.id is required.")
    if not isinstance(config.get("evidenceStatuses"), dict):
        raise ValueError("config.json evidenceStatuses is required.")
    return config, contract_map, compile_contract_map(contract_map, client_id)


def _read_json(json_path):
    try:
        with open(json_path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as error:
        raise ValueError(f"Failed to read JSON {json_path}: {error}") from error


# ---------------------------------------------------------------- (b) 要求する範囲を組む

def build_range_requests(compiled):
    """(field, source_range) の並びを作る。行35ガード(b)はここ。

    ここで作った範囲しか API に投げない。行35を含む範囲は (a) で弾かれているが、
    マップを手で書き換えられても止まるように、投げる直前にもう一度見る。
    """
    requests = []
    for field in compiled["fields"]:
        for source_range in field["sourceRanges"]:
            if range_contains_row(source_range, EXCLUDED_SOURCE_ROW):
                raise ValueError(
                    f"Refusing to request row {EXCLUDED_SOURCE_ROW}: {field['key']} {source_range}"
                )
            requests.append((field, source_range))
    if not requests:
        raise ValueError("contract-map produced no ranges to read.")
    return requests


def to_a1(sheet_name, source_range):
    escaped = str(sheet_name).replace("'", "''")
    return f"'{escaped}'!{source_range}"


# ---------------------------------------------------------------- 値の取り出しと統合

def extract_range_value(field, source_range, values):
    """batchGet が返した「その範囲だけ」の 2 次元配列から値を取り出す。

    values[0][0] が範囲の左上。行35は要求していないので values に含まれ得ない。
    """
    parsed = parse_source_range(source_range)
    if parsed["startRow"] <= EXCLUDED_SOURCE_ROW <= parsed["endRow"]:
        raise ValueError(f"source_range must not include row {EXCLUDED_SOURCE_ROW}: {source_range}")
    ignored = {normalize_cell(value) for value in field["ignoreValues"]}
    width = parsed["endColumn"] - parsed["startColumn"] + 1
    height = parsed["endRow"] - parsed["startRow"] + 1
    collected = []
    for row_offset in range(height):
        row = values[row_offset] if row_offset < len(values) else []
        for column_offset in range(width):
            cell = row[column_offset] if column_offset < len(row) else ""
            value = normalize_cell(cell)
            if value and value not in ignored:
                collected.append(value)
    return " | ".join(collected)


def choose_evidence_status(entries, config):
    statuses = config["evidenceStatuses"]
    conflict = statuses.get("conflict")
    missing = statuses.get("missing")
    if not conflict or not missing:
        raise ValueError("config.json evidenceStatuses.conflict and evidenceStatuses.missing are required.")
    if any(entry["evidenceStatus"] == conflict for entry in entries):
        return conflict
    nonempty = [entry for entry in entries if entry["value"] != ""]
    if not nonempty:
        return missing
    distinct = list(dict.fromkeys(
        entry["evidenceStatus"] for entry in nonempty if entry["evidenceStatus"] != missing
    ))
    if len(distinct) > 1:
        return conflict
    return distinct[0] if distinct else missing


def merge_entries(field, entries, config):
    statuses = config["evidenceStatuses"]
    if not entries:
        return {
            "key": field["key"],
            "label": field["label"],
            "value": "",
            "sourceRow": field["sourceRow"],
            "sourceRange": ", ".join(field["sourceRanges"]),
            "evidenceStatus": statuses["missing"],
        }
    distinct_values = list(dict.fromkeys(
        entry["value"] for entry in entries if entry["value"] != ""
    ))
    conflicting = len(distinct_values) > 1
    selected = choose_evidence_status(entries, config)
    ranges = list(dict.fromkeys(entry["sourceRange"] for entry in entries))
    return {
        "key": field["key"],
        "label": field["label"],
        "value": " | ".join(distinct_values) if conflicting else (distinct_values[0] if distinct_values else ""),
        "sourceRow": field["sourceRow"],
        "sourceRange": ", ".join(ranges),
        "evidenceStatus": statuses["conflict"] if conflicting else selected,
    }


# ---------------------------------------------------------------- (c) レコードの検証

def normalize_six_column_rows(rows, client_id, config, compiled, source):
    """6列形式のレコード列を検証して contract JSON に畳む。行35ガード(c)はここ。

    スプシ直読みでもこの関数を通す。読み取り経路が変わっても、
    「行35のレコードは通らない」という検査を1か所に残すため。
    """
    assert_client_id(client_id)
    if config.get("clientId") != client_id:
        raise ValueError(
            f"Client mismatch: config is {config.get('clientId')}, requested client is {client_id}."
        )
    if not rows:
        raise ValueError("Contract records have no header row.")
    if tuple(rows[0]) != CONTRACT_HEADERS:
        raise ValueError(f"Contract header must be exactly: {','.join(CONTRACT_HEADERS)}")

    allowed_statuses = set(config.get("evidenceStatuses", {}).values())
    if not allowed_statuses or any(not isinstance(value, str) for value in allowed_statuses):
        raise ValueError("config.json evidenceStatuses must contain string values.")
    if not config["evidenceStatuses"].get("conflict") or not config["evidenceStatuses"].get("missing"):
        raise ValueError("config.json conflict and missing evidence statuses are required.")

    grouped = {field["key"]: [] for field in compiled["fields"]}
    input_record_count = 0
    for record_index, row in enumerate(rows[1:], start=1):
        if len(row) != len(CONTRACT_HEADERS):
            raise ValueError(
                f"Contract schema drift at record {record_index}: "
                f"row has {len(row)} columns; expected {len(CONTRACT_HEADERS)}."
            )
        input_record_count += 1
        row_client_id, raw_source_row, source_range, key, value, evidence_status = row
        if row_client_id != client_id:
            raise ValueError(f"Client mismatch at record {record_index}: {row_client_id} != {client_id}.")

        source_row = parse_source_row(raw_source_row)
        if source_row == EXCLUDED_SOURCE_ROW:
            raise ValueError(f"Source row {EXCLUDED_SOURCE_ROW} is structurally forbidden.")
        if range_contains_row(source_range, EXCLUDED_SOURCE_ROW):
            raise ValueError(f"source_range must not include row {EXCLUDED_SOURCE_ROW}: {source_range}")
        if not isinstance(key, str) or key != key.strip():
            raise ValueError(f"Contract key must be exact at record {record_index}.")
        field = compiled["byKey"].get(key)
        if not field:
            raise ValueError(f"Unknown contract key at record {record_index}: {key}")
        if source_row != field["sourceRow"]:
            raise ValueError(
                f"Unexpected source_row for {key}: {source_row}; expected {field['sourceRow']}."
            )
        if source_range not in field["sourceRanges"]:
            raise ValueError(f"Unexpected source_range for {key}: {source_range}.")
        if evidence_status not in allowed_statuses:
            raise ValueError(f"Unknown evidence_status for {key}: {evidence_status}.")
        grouped[key].append({
            "value": value,
            "sourceRow": source_row,
            "sourceRange": source_range,
            "evidenceStatus": evidence_status,
        })

    fields = [merge_entries(field, grouped[field["key"]], config) for field in compiled["fields"]]
    return {
        "version": 1,
        "clientId": client_id,
        "source": {
            **source,
            "inputRecordCount": input_record_count,
            "mappedFieldCount": len(fields),
            "structurallyExcludedRows": [EXCLUDED_SOURCE_ROW],
        },
        "fields": fields,
    }


# ---------------------------------------------------------------- スプシから読む

def sheets_fetcher(spreadsheet_id, a1_ranges):
    """Sheets API の batchGet。要求した範囲だけを返す（シート全体は取らない）。"""
    import google.auth
    from googleapiclient.discovery import build

    cred, _ = google.auth.default(scopes=SCOPES)
    api = build("sheets", "v4", credentials=cred).spreadsheets()
    response = api.values().batchGet(
        spreadsheetId=spreadsheet_id,
        ranges=a1_ranges,
        majorDimension="ROWS",
    ).execute()
    value_ranges = response.get("valueRanges", [])
    if len(value_ranges) != len(a1_ranges):
        raise ValueError(
            f"Sheets API returned {len(value_ranges)} ranges; expected {len(a1_ranges)}."
        )
    return [item.get("values", []) for item in value_ranges]


def read_contract(client_id, fetcher=None, skill_root=SKILL_ROOT):
    config, _contract_map, compiled = load_references(client_id, skill_root)
    sheet_cfg = (config.get("contract") or {}).get("spreadsheet") or {}
    sheet_name = sheet_cfg.get("sheetName") or "作成用"
    spreadsheet_id = sheet_cfg["id"]

    requests = build_range_requests(compiled)
    a1_ranges = [to_a1(sheet_name, source_range) for _field, source_range in requests]
    values_per_range = (fetcher or sheets_fetcher)(spreadsheet_id, a1_ranges)
    if len(values_per_range) != len(requests):
        raise ValueError(
            f"Fetcher returned {len(values_per_range)} ranges; expected {len(requests)}."
        )

    confirmed = config["evidenceStatuses"].get("confirmedInternal")
    missing = config["evidenceStatuses"].get("missing")
    if not confirmed or not missing:
        raise ValueError("config.json confirmedInternal and missing evidence statuses are required.")

    rows = [list(CONTRACT_HEADERS)]
    for (field, source_range), values in zip(requests, values_per_range):
        value = extract_range_value(field, source_range, values)
        rows.append([
            client_id,
            str(field["sourceRow"]),
            source_range,
            field["key"],
            value,
            confirmed if value else missing,
        ])

    return normalize_six_column_rows(rows, client_id, config, compiled, {
        "type": "CONTRACT_SHEET",
        "spreadsheet": sheet_cfg,
        "requestedRanges": a1_ranges,
    })


def check_map(client_id, skill_root=SKILL_ROOT):
    """contract-map.json の構造検査だけ行う。ネットワークも認証も使わない。

    preflight.mjs から呼ばれる。Node 側に同じ検証を書くと二重実装になるので、
    contract-map を読む責任はこのファイルだけが持つ。
    """
    config, contract_map, compiled = load_references(client_id, skill_root)
    requests = build_range_requests(compiled)
    sheet_cfg = (config.get("contract") or {}).get("spreadsheet") or {}
    if not sheet_cfg.get("id"):
        raise ValueError("config.json の contract.spreadsheet.id がありません。")
    return {
        "ok": True,
        "clientId": client_id,
        "configClientId": config.get("clientId"),
        "contractMapClientId": contract_map.get("clientId"),
        "sheetName": sheet_cfg.get("sheetName") or "作成用",
        "fieldCount": len(compiled["fields"]),
        "rangeCount": len(requests),
        "requestedRows": sorted({f["sourceRow"] for f in compiled["fields"]}),
        "structurallyExcludedRows": [EXCLUDED_SOURCE_ROW],
    }


def probe(client_id, skill_root=SKILL_ROOT):
    """疎通確認。セルの値は1つも読まず、メタデータだけ取る。"""
    import google.auth
    from googleapiclient.discovery import build

    config, _contract_map, compiled = load_references(client_id, skill_root)
    sheet_cfg = (config.get("contract") or {}).get("spreadsheet") or {}
    sheet_name = sheet_cfg.get("sheetName") or "作成用"
    requests = build_range_requests(compiled)

    cred, _ = google.auth.default(scopes=SCOPES)
    api = build("sheets", "v4", credentials=cred).spreadsheets()
    meta = api.get(
        spreadsheetId=sheet_cfg["id"],
        fields="properties.title,sheets.properties.title",
    ).execute()
    tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
    if sheet_name not in tabs:
        raise ValueError(f"タブ「{sheet_name}」がありません。実際のタブ: {', '.join(tabs)}")
    return {
        "ok": True,
        "clientId": client_id,
        "spreadsheetId": sheet_cfg["id"],
        "title": meta.get("properties", {}).get("title"),
        "sheetName": sheet_name,
        "rangeCount": len(requests),
        "fieldCount": len(compiled["fields"]),
        "structurallyExcludedRows": [EXCLUDED_SOURCE_ROW],
    }


# ---------------------------------------------------------------- (d) self-test

def _assert(condition, message):
    if not condition:
        raise AssertionError(f"Self-test failed: {message}")


def _expect_raise(callback, pattern):
    try:
        callback()
    except Exception as error:  # noqa: BLE001 - 検査目的
        if not re.search(pattern, str(error)):
            raise AssertionError(f"expected /{pattern}/, got: {error}") from error
        return
    raise AssertionError(f"expected /{pattern}/, but nothing was raised")


def run_self_test():
    config = {
        "clientId": "foot",
        "contract": {"spreadsheet": {"id": "test", "sheetName": "作成用"}},
        "evidenceStatuses": {
            "extracted": "EXTRACTED_JOBLIST",
            "candidate": "CANDIDATE",
            "confirmedInternal": "CONFIRMED_INTERNAL",
            "publicOfficial": "PUBLIC_OFFICIAL",
            "missing": "MISSING",
            "conflict": "CONFLICT",
        },
    }
    contract_map = {
        "clientId": "foot",
        "csvColumns": list(CONTRACT_HEADERS),
        "fields": [
            {"key": "companyName", "label": "企業名", "sourceRow": 10, "sourceRanges": ["B10:X10"]},
            {"key": "workSite", "label": "就業先", "sourceRow": 10,
             "sourceRanges": ["Z10:AZ10", "BA10:BZ10"], "ignoreValues": ["請求先"]},
        ],
    }
    compiled = compile_contract_map(contract_map, "foot")
    cases = 0

    # 1. 正常系。範囲ごとの 2 次元配列から値を取り、6列形式へ畳む。
    rows = [list(CONTRACT_HEADERS),
            ["foot", "10", "B10:X10", "companyName", "FooT,株式会社\n本社", "CONFIRMED_INTERNAL"],
            ["foot", "10", "Z10:AZ10", "workSite", "岡崎工場", "CONFIRMED_INTERNAL"],
            ["foot", "10", "BA10:BZ10", "workSite", "X工場", "CONFIRMED_INTERNAL"]]
    normalized = normalize_six_column_rows(rows, "foot", config, compiled, {"type": "TEST"})
    _assert(len(normalized["fields"]) == 2, "mapped fields count")
    _assert(normalized["fields"][0]["value"] == "FooT,株式会社\n本社", "newline preservation")
    _assert(normalized["fields"][1]["evidenceStatus"] == "CONFLICT", "duplicate key conflict status")
    _assert(normalized["fields"][1]["value"] == "岡崎工場 | X工場", "duplicate key conflict values")
    cases += 4

    # 2. extract_range_value: ignoreValues 除外・空セル無視・複数セル連結。
    _assert(extract_range_value(compiled["byKey"]["workSite"], "Z10:AZ10",
                                [["請求先", "", "岡崎工場"]]) == "岡崎工場", "ignoreValues excluded")
    _assert(extract_range_value(compiled["byKey"]["companyName"], "B10:X10",
                                []) == "", "empty range yields empty value")
    _assert(extract_range_value(compiled["byKey"]["companyName"], "B10:X10",
                                [["ＦｏｏＴ　株式会社"]]) == "FooT 株式会社", "NFKC normalization")
    cases += 3

    # 3. 行35ガード(a): マップ側で拒否する。
    _expect_raise(lambda: compile_contract_map({
        "clientId": "foot", "csvColumns": list(CONTRACT_HEADERS),
        "fields": [{"key": "banned", "label": "禁止", "sourceRow": 35, "sourceRanges": ["B35:X35"]}],
    }, "foot"), r"exclude source row 35")
    _expect_raise(lambda: compile_contract_map({
        "clientId": "foot", "csvColumns": list(CONTRACT_HEADERS),
        "fields": [{"key": "spanning", "label": "またぎ", "sourceRow": 33, "sourceRanges": ["B30:X40"]}],
    }, "foot"), r"exclude row 35")
    cases += 2

    # 4. 行35ガード(c): レコード側で拒否する。
    bad_rows = [
        (["foot", "35", "B35:X35", "companyName", "禁止", "CONFIRMED_INTERNAL"], r"35"),
        (["foot", "10", "B10:Y10", "companyName", "FooT", "CONFIRMED_INTERNAL"], r"Unexpected source_range"),
        (["foot", "11", "B10:X10", "companyName", "FooT", "CONFIRMED_INTERNAL"], r"Unexpected source_row"),
        (["foot", "10", "B10:X10", "unknownKey", "FooT", "CONFIRMED_INTERNAL"], r"Unknown contract key"),
        (["other", "10", "B10:X10", "companyName", "FooT", "CONFIRMED_INTERNAL"], r"Client mismatch"),
        (["foot", "10", "B10:X10", "companyName", "FooT", "NOPE"], r"Unknown evidence_status"),
    ]
    for row, pattern in bad_rows:
        _expect_raise(
            lambda row=row: normalize_six_column_rows(
                [list(CONTRACT_HEADERS), row], "foot", config, compiled, {"type": "TEST"}),
            pattern,
        )
    cases += len(bad_rows)

    # 5. 行35ガード(b)+(d): 実際の foot マップで通し、
    #    行35を要求したら爆発する fetcher を使って sentinel が出ないことを確かめる。
    real_config, _real_map, real_compiled = load_references("foot")
    real_requests = build_range_requests(real_compiled)
    _assert(
        all(not range_contains_row(source_range, EXCLUDED_SOURCE_ROW)
            for _field, source_range in real_requests),
        "no requested range contains row 35",
    )
    asked = []

    def hostile_fetcher(_spreadsheet_id, a1_ranges):
        out = []
        for a1 in a1_ranges:
            asked.append(a1)
            source_range = a1.split("!", 1)[1]
            if range_contains_row(source_range, EXCLUDED_SOURCE_ROW):
                raise AssertionError(f"row {EXCLUDED_SOURCE_ROW} was requested: {a1}")
            out.append([[SENTINEL if range_contains_row(source_range, EXCLUDED_SOURCE_ROW) else "値"]])
        return out

    hostile = read_contract("foot", fetcher=hostile_fetcher)
    _assert(SENTINEL not in json.dumps(hostile, ensure_ascii=False), "row 35 sentinel absent from output")
    _assert(len(asked) == len(real_requests), "every mapped range was requested exactly once")
    _assert(hostile["source"]["structurallyExcludedRows"] == [EXCLUDED_SOURCE_ROW], "excluded rows recorded")
    _assert(len(hostile["fields"]) == len(real_compiled["fields"]), "all mapped fields present")
    cases += 5

    # 6. 範囲の外を返す fetcher（行数・列数が合わない）でも範囲外を拾わない。
    def wide_fetcher(_spreadsheet_id, a1_ranges):
        return [[["A", "B", "C", "D"], ["余分な行"]] for _ in a1_ranges]

    wide = read_contract("foot", fetcher=wide_fetcher)
    company = next(f for f in wide["fields"] if f["key"] == "companyName")
    _assert("余分な行" not in company["value"], "values outside the declared range are ignored")
    cases += 1

    # 7. A1 表記のクォート。
    _assert(to_a1("作成用", "B10:X10") == "'作成用'!B10:X10", "A1 quoting")
    _assert(to_a1("O'Brien", "A1:B2") == "'O''Brien'!A1:B2", "A1 quote escaping")
    cases += 2

    # 8. 出力は /tmp 配下・0600 のみ。macOS の /tmp -> /private/tmp も通ること。
    import tempfile
    with tempfile.TemporaryDirectory(dir=OUT_DIR) as tmp_dir:
        target = os.path.join(tmp_dir, "contract.json")
        secure_write_tmp(target, "{}\n")
        _assert(os.stat(target).st_mode & 0o777 == 0o600, "output mode is 0600")
        _assert(open(target, encoding="utf-8").read() == "{}\n", "/tmp roundtrip")
        link = os.path.join(tmp_dir, "link.json")
        os.symlink(target, link)
        _expect_raise(lambda: secure_write_tmp(link, "{}\n"), r"symlink")
    _expect_raise(lambda: secure_write_tmp("/etc/job-copy-test.json", "{}\n"), r"/tmp")
    cases += 4

    return {
        "ok": True,
        "cases": cases,
        "passedCases": cases,
        "failedCases": 0,
        "checks": [
            "range extraction with ignoreValues and NFKC",
            "six-column normalization and conflict merge",
            "row 35 rejection in contract-map (guard a)",
            "row 35 never requested from the API (guard b)",
            "row 35 rejection in records (guard c)",
            "row 35 sentinel absent from output over the real map (guard d)",
            "values outside the declared range are ignored",
            "A1 quoting",
            "output confined to /tmp with mode 0600",
        ],
    }


# ---------------------------------------------------------------- CLI

def main():
    parser = argparse.ArgumentParser(description="内容確認書スプシを直接読んで contract JSON を作る")
    parser.add_argument("--client", help="クライアントID（例: foot）")
    parser.add_argument("--output", help=f"出力先（既定: {OUT_DIR}/<client>_contract.json）")
    parser.add_argument("--probe", action="store_true", help="疎通確認だけ行う（値は読まない）")
    parser.add_argument("--check-map", action="store_true", dest="check_map",
                        help="contract-map.json の構造検査だけ行う（通信しない）")
    parser.add_argument("--self-test", action="store_true", dest="self_test")
    args = parser.parse_args()

    if args.self_test:
        if args.client or args.output or args.probe or args.check_map:
            sys.exit("--self-test は他のオプションと併用できません。")
        print(json.dumps(run_self_test(), ensure_ascii=False, indent=2))
        return

    if not args.client:
        sys.exit("--client は必須です。")

    if args.check_map:
        print(json.dumps(check_map(args.client), ensure_ascii=False))
        return

    if args.probe:
        print(json.dumps(probe(args.client), ensure_ascii=False))
        return

    normalized = read_contract(args.client)
    output_path = args.output or os.path.join(OUT_DIR, f"{args.client}_contract.json")
    resolved = secure_write_tmp(output_path, json.dumps(normalized, ensure_ascii=False, indent=2) + "\n")
    conflict_status = (
        (_read_json(os.path.join(SKILL_ROOT, "references", "clients", args.client, "config.json"))
         .get("evidenceStatuses") or {}).get("conflict")
    )
    conflicts = [f for f in normalized["fields"] if f["evidenceStatus"] == conflict_status]
    print(json.dumps({
        "output": resolved,
        "clientId": normalized["clientId"],
        "fields": len(normalized["fields"]),
        "conflicts": len(conflicts),
        "ranges": len(normalized["source"]["requestedRanges"]),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - CLI の最終ハンドラ
        sys.exit(f"read_contract: {error}")
