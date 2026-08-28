# -*- coding: utf-8 -*-
"""新しいクライアント用のヒアリング履歴スプレッドシートを作る（導入時に1回だけ）。

作成後、そのIDを `references/clients/{client}/config.json` の hearingLog に書き戻す。

  python3 init_hearing_log.py --client foot --folder <DriveフォルダID>

すでに config.json に hearingLog.spreadsheetId がある場合は何もしない。
作り直したいときは --force を付ける（古い履歴は引き継がれない）。

  python3 init_hearing_log.py --self-test
"""
import argparse
import json
import os

SCOPES = ["https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive"]
SHEET = "ヒアリング履歴"
TITLE = "ヒアリング履歴"
HEAD = ["日時", "派遣先", "事業所", "案件番号", "層", "質問", "回答", "状態", "記録者",
        "職種"]   # J列。末尾に足しているので既存A〜I列の位置は動かない
WIDTHS = [90, 110, 110, 90, 150, 300, 220, 90, 80, 150]
HERE = os.path.dirname(os.path.abspath(__file__))


def config_path(client):
    return os.path.join(HERE, "..", "references", "clients", client, "config.json")


def existing_id(cfg):
    return cfg.get("hearingLog", {}).get("spreadsheetId")


def put_id(cfg, sid):
    """config.json に書き戻す辞書を返す（他のキーは触らない）。"""
    cfg = dict(cfg)
    log = dict(cfg.get("hearingLog", {}))
    log["spreadsheetId"] = sid
    log.setdefault("sheetName", SHEET)
    cfg["hearingLog"] = log
    return cfg


def format_requests(gid):
    reqs = [{"updateDimensionProperties": {
        "range": {"sheetId": gid, "dimension": "COLUMNS",
                  "startIndex": i, "endIndex": i + 1},
        "properties": {"pixelSize": w}, "fields": "pixelSize"}}
        for i, w in enumerate(WIDTHS)]
    reqs.append({"repeatCell": {
        "range": {"sheetId": gid, "startRowIndex": 0, "endRowIndex": 1},
        "cell": {"userEnteredFormat": {
            "backgroundColor": {"red": .82, "green": .84, "blue": .87},
            "textFormat": {"bold": True}}},
        "fields": "userEnteredFormat(backgroundColor,textFormat)"}})
    return reqs


def _self_test():
    assert len(HEAD) == len(WIDTHS) == 10
    cfg = {"clientId": "x", "outputSheets": {"variantsPrefix": "訴求案_"}}
    out = put_id(cfg, "SID")
    assert out["hearingLog"] == {"spreadsheetId": "SID", "sheetName": SHEET}
    assert out["outputSheets"] == cfg["outputSheets"]      # 他のキーを壊さない
    assert "hearingLog" not in cfg                          # 元の辞書を変えない
    assert existing_id(out) == "SID" and existing_id(cfg) is None
    keep = put_id({"hearingLog": {"sheetName": "別名"}}, "SID2")
    assert keep["hearingLog"]["sheetName"] == "別名"        # 既存の設定を上書きしない
    reqs = format_requests(0)
    # 列幅が列数ぶん + ヘッダー行の書式1件。列を足したらここも一緒に増える
    assert len(reqs) == len(WIDTHS) + 1
    assert reqs[-1]["repeatCell"]["range"]["endRowIndex"] == 1
    assert reqs[-2]["updateDimensionProperties"]["range"]["endIndex"] == len(HEAD)
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client", default="foot")
    p.add_argument("--folder", help="保存先DriveフォルダID")
    p.add_argument("--force", action="store_true")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    if not a.folder:
        p.error("--folder は必須です")

    path = config_path(a.client)
    cfg = json.load(open(path, encoding="utf-8"))
    if existing_id(cfg) and not a.force:
        print(f"すでに設定済みです: {existing_id(cfg)}")
        print("作り直すなら --force。古い履歴は引き継がれません。")
        return

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    sh = build("sheets", "v4", credentials=cred).spreadsheets()
    dr = build("drive", "v3", credentials=cred)

    ss = sh.create(body={
        "properties": {"title": TITLE},
        "sheets": [{"properties": {"title": SHEET,
                                   "gridProperties": {"frozenRowCount": 1}}}]}).execute()
    sid, gid = ss["spreadsheetId"], ss["sheets"][0]["properties"]["sheetId"]

    cur = dr.files().get(fileId=sid, fields="parents").execute().get("parents", [])
    dr.files().update(fileId=sid, addParents=a.folder,
                      removeParents=",".join(cur), fields="id").execute()

    sh.values().update(spreadsheetId=sid, range=f"{SHEET}!A1",
                       valueInputOption="USER_ENTERED",
                       body={"values": [HEAD]}).execute()
    sh.batchUpdate(spreadsheetId=sid, body={"requests": format_requests(gid)}).execute()

    json.dump(put_id(cfg, sid), open(path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"作成: https://docs.google.com/spreadsheets/d/{sid}/edit")
    print(f"{a.client}/config.json の hearingLog.spreadsheetId を更新しました。")


if __name__ == "__main__":
    main()
