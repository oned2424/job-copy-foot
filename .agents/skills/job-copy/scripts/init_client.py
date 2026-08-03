# -*- coding: utf-8 -*-
"""クライアントの初期設定。スプレッドシートと保存先フォルダを config.json に登録する。

  python3 init_client.py --client foot            # 対話。既存値はEnterで据え置き
  python3 init_client.py --client foot --check    # 対話せず、いまの設定で疎通確認だけ
  python3 init_client.py --client newco \
      --joblist <URL> --contract <URL> --hearing <URL> --output-folder <URL>

やること:
  1. いまどのアカウントでAPIを叩いているかを表示する
  2. 新規クライアントなら references/clients/{id}/ をテンプレから作る
  3. Joblist・内容確認書・ヒアリング履歴・出力先フォルダのIDを聞く（URLのまま貼ってよい）
  4. 全部に**実際にアクセスして**開けるか・書けるかを確認する
  5. config.json に書き戻す

ここで疎通まで確認するのは、IDだけ書いて後から
「共有したつもりが閲覧者だった」で落ちるのを初期設定の時点で捕まえるため。
サービスアカウント運用に切り替えたときに必ず一度は踏む。

  python3 init_client.py --self-test
"""
import argparse
import json
import os
import shutil
import sys

from client_config import (config_path, extract_id, known_clients, load_config,
                           save_config, whoami)

SCOPES = ["https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive"]
TEMPLATE_CLIENT = "foot"
# config.json は作り直すのでコピーしない。question-catalog.json は層1が会社固有なので警告を出す。
TEMPLATE_FILES = ["items176-master.json", "column-map.json", "contract-map.json",
                  "limits.json", "ab-log.schema.json", "question-catalog.json"]
COMPANY_SPECIFIC = "question-catalog.json"

BLANK_CONFIG = {
    "version": 1,
    # logSheetName は入稿指示ログの書き込み先。Sheet1 と別にしておかないと
    # AirWork のエクスポートを貼り替えたときに消える
    "spreadsheet": {"sheetName": "Sheet1", "range": "A1:IE12", "memoColumn": "JE",
                    "logSheetName": "入稿指示ログ"},
    "identity": {"jobNumberColumn": "A", "approvalStatusColumn": "B",
                 "publicationStatusColumn": "C"},
    "publishedStatusValues": ["02"],
    "evidenceStatuses": {"extracted": "EXTRACTED_JOBLIST", "candidate": "CANDIDATE",
                         "confirmedInternal": "CONFIRMED_INTERNAL",
                         "publicOfficial": "PUBLIC_OFFICIAL",
                         "missing": "MISSING", "conflict": "CONFLICT"},
    "contract": {"spreadsheet": {"sheetName": "作成用"}, "jobBindings": {}},
    "hearingLog": {"sheetName": "ヒアリング履歴"},
    "drive": {},
    "outputSheets": {"variantsPrefix": "訴求案_", "tagAuditPrefix": "タグ診断_",
                     "protectedSheetNames": ["Sheet1"]},
    "allowedEntities": {"companyNames": [], "assignmentSiteNames": []},
}

# 聞く項目: (見出し, configのパス, 種別, 説明)
# 種別 sheet_rw は書き込み権限まで確かめる。ここで落としておかないと、
# 初回の出稿が終わった直後にログ記録だけ失敗し、原因が権限だと気づけない。
FIELDS = [
    ("Joblist（AirWorkの求人エクスポート）", ("spreadsheet", "id"), "sheet_rw",
     "既存求人を特定して現在値を読む。派遣先名は求人メモ欄から拾う。"
     "入稿指示ログのタブを足すので編集権限が要る（Sheet1は書き換えない）"),
    ("内容確認書", ("contract", "spreadsheet", "id"), "sheet",
     "派遣先ごとの契約条件。行35（年齢・性別・国籍）は読み込まない"),
    ("ヒアリング履歴", ("hearingLog", "spreadsheetId"), "sheet_rw",
     "無ければ先に init_hearing_log.py で作る"),
    ("出稿用ドキュメントの保存先フォルダ", ("drive", "outputFolderId"), "folder",
     "「記載項目_派遣先名」をここに作る"),
]


def dig(cfg, path):
    cur = cfg
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def put(cfg, path, value):
    cur = cfg
    for k in path[:-1]:
        cur = cur.setdefault(k, {})
    cur[path[-1]] = value
    return cfg


def scaffold(client):
    """新規クライアントの references/clients/{id}/ をテンプレから作る。"""
    src = os.path.join(os.path.dirname(config_path(TEMPLATE_CLIENT)))
    dst = os.path.dirname(config_path(client))
    if os.path.isdir(dst):
        return []
    os.makedirs(dst, exist_ok=True)
    copied = []
    for name in TEMPLATE_FILES:
        s = os.path.join(src, name)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(dst, name))
            copied.append(name)
    cfg = json.loads(json.dumps(BLANK_CONFIG))
    cfg["clientId"] = client
    save_config(client, cfg)
    return copied


def ask(label, current, hint):
    cur = f"現在: {current}" if current else "未設定"
    print(f"\n■ {label}（{cur}）")
    print(f"  {hint}")
    while True:
        s = input("  URL または ID を貼る（Enterで据え置き / - で削除）> ").strip()
        if not s:
            return current
        if s == "-":
            return None
        fid = extract_id(s)
        if fid:
            return fid
        print("  → IDが読み取れません。共有リンクをそのまま貼ってください。")


def check_sheet(sheets, sid, drive=None):
    """開けることを確かめる。drive を渡すと編集権限まで見る。

    実際に書いて確かめない。確認のために相手のシートへ行を足して消すのは、
    履歴に残るうえ、途中で落ちたらゴミが残る。Drive の capabilities を見れば足りる。
    """
    r = sheets.spreadsheets().get(
        spreadsheetId=sid, fields="properties.title,sheets.properties.title").execute()
    tabs = [s["properties"]["title"] for s in r.get("sheets", [])]
    if drive is not None:
        cap = drive.files().get(
            fileId=sid, fields="capabilities(canEdit)").execute().get("capabilities", {})
        if not cap.get("canEdit"):
            raise ValueError(
                f"「{r['properties']['title']}」に書き込めません。"
                "共有の権限が「閲覧者」になっていないか確認してください")
    return f"{r['properties']['title']}（タブ: {', '.join(tabs[:6])}）"


def check_folder(drive, fid):
    r = drive.files().get(
        fileId=fid, fields="name,mimeType,capabilities(canAddChildren)").execute()
    if r["mimeType"] != "application/vnd.google-apps.folder":
        raise ValueError(f"フォルダではありません（{r['mimeType']}）")
    if not r.get("capabilities", {}).get("canAddChildren"):
        raise ValueError(f"「{r['name']}」に書き込めません。"
                         "共有の権限が「閲覧者」になっていないか確認してください")
    return r["name"]


def verify(cfg, sheets, drive):
    """全項目に実アクセスする。1件でも落ちたら False。"""
    ok = True
    for label, path, kind, _ in FIELDS:
        val = dig(cfg, path)
        if not val:
            print(f"  [未設定] {label}")
            ok = False
            continue
        try:
            if kind == "folder":
                name = check_folder(drive, val)
            else:
                # sheet_rw は編集権限まで確かめる。sheet は読めれば足りる
                name = check_sheet(sheets, val, drive if kind == "sheet_rw" else None)
            print(f"  [OK]     {label} → {name}")
        except Exception as e:
            print(f"  [NG]     {label} → {str(e).splitlines()[0][:120]}")
            ok = False
    return ok


def _self_test():
    cfg = {"a": {"b": 1}}
    assert dig(cfg, ("a", "b")) == 1
    assert dig(cfg, ("a", "z")) is None
    assert dig(cfg, ("a", "b", "c")) is None      # 途中がdictでなくても落ちない
    assert dig({}, ("x", "y")) is None
    put(cfg, ("drive", "outputFolderId"), "F1")
    assert cfg["drive"]["outputFolderId"] == "F1"
    put(cfg, ("a", "b"), 2)
    assert cfg["a"]["b"] == 2

    # テンプレは実在するファイルだけを並べる（コピー漏れに気づけない）
    src = os.path.dirname(config_path(TEMPLATE_CLIENT))
    for name in TEMPLATE_FILES:
        assert os.path.exists(os.path.join(src, name)), name
    assert COMPANY_SPECIFIC in TEMPLATE_FILES
    assert "config.json" not in TEMPLATE_FILES, "config.json はテンプレから複製しない"

    # 雛形は clientId 以外そろっていること
    for key in ("spreadsheet", "contract", "hearingLog", "drive"):
        assert key in BLANK_CONFIG, key
    assert BLANK_CONFIG["spreadsheet"]["memoColumn"] == "JE"
    # 入稿指示ログの書き込み先。Sheet1 と同じだと貼り替えで消える
    log = BLANK_CONFIG["spreadsheet"]["logSheetName"]
    assert log and log != BLANK_CONFIG["spreadsheet"]["sheetName"], log

    # FIELDS の書き込み先が雛形と噛み合うこと
    probe = json.loads(json.dumps(BLANK_CONFIG))
    for _, path, kind, _ in FIELDS:
        assert kind in ("sheet", "sheet_rw", "folder"), kind
        put(probe, path, "X")
        assert dig(probe, path) == "X", path
    assert probe["drive"]["outputFolderId"] == "X"

    # Joblist は入稿指示ログのタブを足すので編集権限が要る。
    # ここを sheet に戻すと、初回の出稿が終わった直後まで権限不足に気づけない
    kinds = {path: kind for _, path, kind, _ in FIELDS}
    assert kinds[("spreadsheet", "id")] == "sheet_rw"
    assert kinds[("hearingLog", "spreadsheetId")] == "sheet_rw"
    assert kinds[("contract", "spreadsheet", "id")] == "sheet", "内容確認書は読むだけ"
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client")
    p.add_argument("--check", action="store_true", help="対話せず疎通確認だけ")
    p.add_argument("--joblist")
    p.add_argument("--contract")
    p.add_argument("--hearing")
    p.add_argument("--output-folder")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    if not a.client:
        p.error(f"--client は必須です（既知: {', '.join(known_clients()) or 'なし'}）")

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    sheets = build("sheets", "v4", credentials=cred)
    drive = build("drive", "v3", credentials=cred)

    print(f"■ 認証: {whoami(cred, drive)}")
    print("  このアカウントから見えるものしか読み書きできません。"
          "サービスアカウントなら、対象を編集者で共有してください。")

    if not os.path.exists(config_path(a.client)):
        copied = scaffold(a.client)
        print(f"\n■ {a.client} を新規作成しました（テンプレ元: {TEMPLATE_CLIENT}）")
        for name in copied:
            mark = "  ★会社ごとに見直す" if name == COMPANY_SPECIFIC else ""
            print(f"    {name}{mark}")
        print(f"    ★{COMPANY_SPECIFIC} の層1は「その会社の方針」です"
              "（性別タグを出すか等）。コピーのまま使わないでください。")

    cfg = load_config(a.client)
    cfg["clientId"] = a.client

    given = {("spreadsheet", "id"): a.joblist,
             ("contract", "spreadsheet", "id"): a.contract,
             ("hearingLog", "spreadsheetId"): a.hearing,
             ("drive", "outputFolderId"): a.output_folder}
    non_interactive = a.check or any(given.values())

    for label, path, kind, hint in FIELDS:
        if a.check:
            continue
        raw = given.get(path)
        if non_interactive:
            if raw:
                fid = extract_id(raw)
                if not fid:
                    sys.exit(f"IDが読み取れません: {label} = {raw}")
                put(cfg, path, fid)
            continue
        put(cfg, path, ask(label, dig(cfg, path), hint))

    print("\n■ 疎通確認")
    ok = verify(cfg, sheets, drive)

    if not a.check:
        print(f"\n■ 保存: {save_config(a.client, cfg)}")

    if not ok:
        print("\n開けない項目があります。共有設定を直してから "
              f"`python3 init_client.py --client {a.client} --check` で再確認してください。")
        sys.exit(1)
    print(f"\n完了。`python3 hearing_log.py read --client {a.client} "
          "--site 派遣先名 --office 事業所名` から使えます。")


if __name__ == "__main__":
    main()
