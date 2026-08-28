# -*- coding: utf-8 -*-
"""登録済みのスプレッドシートから Joblist の CSV を /tmp に書き出す。

  python3 export_csv.py --client foot
  → /tmp/foot_joblist_YYYYMMDD.csv

なぜ Joblist だけ CSV を挟むのか:
  データはスプレッドシートにあるので、CSV は本来なくてよい中間ファイルである。
  それでも挟むのは、Joblist を読む2本（read_joblist.mjs / preflight.mjs）が Node 製で、
  Google の認証を持っていないからである。Node にも認証を持たせると、認証の面倒を
  Python と Node の2箇所で見ることになり、導入先で二重に壊れる。
  そこで **認証は Python 側に一本化し、Node には CSV を渡す**。

  内容確認書はここでは出さない。読む側（scripts/read_contract.py）が Python なので
  認証を持っており、CSV を経由する理由がないためである。しかも CSV にすると
  「読まないと決めている行35（年齢・性別・国籍）」が物理的にファイルへ書き出される。
  read_contract.py は許可した範囲だけを values.batchGet で要求するので、行35は
  そもそも Google から返ってこない。運用ルールではなく構造で守るために直読みにした。

  Joblist の取得範囲は config の spreadsheet.range の末尾列まで（既定 A:IE＝239列）。
  スプレッドシートの実体は265列あるが、**わざと切って渡す**。
  265列目は求人メモで、中身は「◯◯運送2000/1500」＝請求単価と支払単価である。
  Node 側は原稿生成・lint・タグ診断を担当するだけで単価を要らないので、渡さない。
  単価を扱うのは fetch_current.py だけにし、そこで伏せ字にする（経路を1本に絞る）。
  preflight.mjs も239列を期待しているので、全列渡すとヘッダー検査で落ちる。

注意:
  - 出力先は /tmp のみ。実データには派遣先の情報が入るので Drive 配下に置かない。
  - 値はスプレッドシートの見たままを書く。加工・マスクはしない。

  python3 export_csv.py --self-test
"""
import argparse
import csv
import datetime
import io
import json
import os
import re
import sys

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
JOBLIST_LAST_COL = "IE"       # 239列目。求人メモ(265列目)は渡さない
from secure_tmp import OUT_DIR, require_tmp_path, secure_write_tmp  # noqa: E402


def pad(rows):
    """Sheets API は行末の空セルを返さない。最大列数に合わせて空文字で埋める。

    埋めないと行ごとに列数が変わり、CSV を読む側が列番号で拾えなくなる。
    """
    width = max((len(r) for r in rows), default=0)
    return [list(r) + [""] * (width - len(r)) for r in rows]


def last_col(rng, default=JOBLIST_LAST_COL):
    """"A1:IE12" → "IE"。config の range から末尾の列レターだけ取り出す。

    range の行番号（12）は集計用に絞ったもので、ここでは使わない。全行取る。
    """
    m = re.search(r":([A-Z]+)\d*$", (rng or "").upper())
    return m.group(1) if m else default


def targets(cfg):
    """(用途, スプレッドシートID, タブ名, 範囲, ファイル名の部品) を返す。

    内容確認書は入れない。read_contract.py がスプレッドシートを直読みするので、
    CSV にすると読まない行35まで書き出してしまう（docstring 参照）。
    """
    out = []
    sp = cfg.get("spreadsheet") or {}
    if sp.get("id"):
        out.append(("Joblist", sp["id"], sp.get("sheetName") or "Sheet1",
                    f"A:{last_col(sp.get('range'))}", "joblist"))
    return out


def out_path(client, kind, day, out_dir=OUT_DIR):
    return os.path.join(out_dir, f"{client}_{kind}_{day}.csv")


def _self_test():
    assert pad([[1, 2, 3], [1], []]) == [[1, 2, 3], [1, "", ""], ["", "", ""]]
    assert pad([]) == []

    # config の range から末尾列だけを取る。行番号は無視して全行取る
    assert last_col("A1:IE12") == "IE"
    assert last_col("a1:je100") == "JE"
    assert last_col("A:IE") == "IE"
    assert last_col(None) == "IE" and last_col("") == "IE"   # 未設定なら239列に倒す

    cfg = {"spreadsheet": {"id": "SID", "sheetName": "Sheet1", "range": "A1:IE12"},
           "contract": {"spreadsheet": {"id": "CID", "sheetName": "作成用"}}}
    # 内容確認書が config にあっても CSV にはしない（read_contract.py が直読みする）
    assert targets(cfg) == [("Joblist", "SID", "Sheet1", "A:IE", "joblist")]
    assert all(t[4] != "contract" for t in targets(cfg))
    assert len(targets({"spreadsheet": {"id": "SID"}})) == 1
    assert targets({"contract": {"spreadsheet": {"id": "CID"}}}) == []
    assert targets({}) == []
    # タブ名の既定値
    assert targets({"spreadsheet": {"id": "S"}})[0][2] == "Sheet1"
    # 求人メモ(265列目)まで取りに行かない。単価は node に渡さない
    assert targets({"spreadsheet": {"id": "S"}})[0][3] == "A:IE"

    assert out_path("foot", "joblist", "20260802") == os.path.join(OUT_DIR, "foot_joblist_20260802.csv")
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client", default="foot")
    p.add_argument("--date", help="ファイル名の日付。既定は今日 (YYYYMMDD)")
    p.add_argument("--out-dir", default=OUT_DIR)
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return

    try:
        require_tmp_path(os.path.join(a.out_dir, ".job-copy-path-check"), "出力先")
    except ValueError as error:
        sys.exit(f"NG: {error}")

    from client_config import load_config
    cfg = load_config(a.client)
    tgt = targets(cfg)
    if not tgt:
        sys.exit(f"NG: {a.client}/config.json にスプレッドシートIDがありません")

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    sh = build("sheets", "v4", credentials=cred).spreadsheets()

    day = a.date or datetime.datetime.now().strftime("%Y%m%d")
    made = {}
    for label, sid, sheet, rng, kind in tgt:
        rows = sh.values().get(spreadsheetId=sid,
                               range=f"{sheet}!{rng}").execute().get("values", [])
        if not rows:
            print(f"NG: {label} が空です（{sid} / {sheet}）", file=sys.stderr)
            sys.exit(1)
        path = out_path(a.client, kind, day, a.out_dir)
        buffer = io.StringIO(newline="")
        csv.writer(buffer).writerows(pad(rows))
        secure_write_tmp(path, buffer.getvalue())
        made[kind] = path
        cols = max(len(r) for r in rows)
        print(f"{label}: {len(rows)}行 × {cols}列 → {path}")

    print(f"\n次: node scripts/preflight.mjs --client {a.client} "
          f"--joblist {made.get('joblist', '<joblist>')}")
    print("   （内容確認書は CSV にしません。read_contract.py がスプレッドシートを直読みします）")


if __name__ == "__main__":
    main()
