# -*- coding: utf-8 -*-
"""make_entry_doc.py が作ったドキュメントに、事務員が読める書式を当てる。

  python3 style_entry_doc.py --items /tmp/items176_selected.json --state /tmp/doc_state.json

当てる書式:
  - 余白 36pt（A4使用可能幅 523.3pt を確保する）
  - 列幅 [30, 105, 138, 248] = 521pt 固定
  - ヘッダ行 = グレー
  - 手を動かさない行（（入力なし）／（社内管理用。触らない））= ライトグレー
  - 消す行（【削除】…）= 薄い黄色（貼るのではなく消す作業なので色を分ける）
  - 判断が要る行（【要確認】…）= 薄いピンク（事務員では決められない。人に回す行）
  - 本文 9pt（176行を紙に収める）

色は「事務員が何をするか」で分ける。塗り分けを「値の有無」でやると、
貼る・消す・触らないの3つが同じ見た目になり、結局1行ずつ読ませることになる。

「（変更なし）」は 2026-08-02 に廃止した。書き換えていない項目にも現在の掲載値が
入るので、ライトグレーになる行は「もともと空」と「社内管理用」だけになる。
貼る行が増えるが、事務員が AirWork の画面と見比べる必要がなくなる。

★ Docs API v1 のタブ指定は2系統ある。混ぜると静かに別タブへ書かれる。
  updateDocumentStyle → リクエスト直下に "tabId"
  updateTextStyle     → "range" の中に "tabId"
  tableStartLocation  → Location なので "index" と同じ辞書に "tabId"

  python3 style_entry_doc.py --self-test
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# 実データ（原稿本文とドキュメントID）は /tmp からしか読まない。
# 門番の実装は secure_tmp.py が唯一。ここで自前の判定を書かない。
from secure_tmp import load_tmp_json  # noqa: E402

COLS = [30, 105, 138, 248]
STYLE_CHUNK = 200
BLANK = {"", "—", "-", "―", "ー", "－"}     # AirWork CSV が空欄に使う記号
# apply_plan.py / fetch_current.py が入れる「手を動かさない」印。
# 「（変更なし）」は廃止済みだが、古い items JSON を流されたときに
# 貼る値として扱われないよう残してある（沈める側に倒す）。
SKIP = {"（入力なし）", "（社内管理用。触らない）", "（変更なし）"}
DELETE_PREFIX = "【削除】"
REVIEW_PREFIX = "【要確認】"
GRAY = {"color": {"rgbColor": {"red": .82, "green": .84, "blue": .87}}}
LIGHT = {"color": {"rgbColor": {"red": .96, "green": .96, "blue": .96}}}
AMBER = {"color": {"rgbColor": {"red": 1.0, "green": .95, "blue": .80}}}
PINK = {"color": {"rgbColor": {"red": 1.0, "green": .89, "blue": .89}}}
SCOPES = ["https://www.googleapis.com/auth/documents"]


def is_skip(v):
    """事務員が何もしない行。ライトグレーで沈める。"""
    return str(v).strip() in BLANK or str(v).strip() in SKIP


def is_delete(v):
    """今の掲載値を消す行。貼る作業と混ざらないよう色を分ける。"""
    return str(v).strip().startswith(DELETE_PREFIX)


def is_review(v):
    """残すか消すかを人が決める行。事務員の手は止める。

    貼る・消すと同じ見た目にすると、事務員が判断してしまう。
    このスキルは事務員に判断させないことを前提に作っているので、色で明確に外す。
    """
    return str(v).strip().startswith(REVIEW_PREFIX)


def build_requests(rows, tab_start, tab_end, tid, cols=COLS):
    """書式リクエスト一覧と、行数の内訳 {paste, delete, skip} を返す。"""
    loc = {"index": tab_start, "tabId": tid}

    def cell_bg(row_index, color):
        return {"updateTableCellStyle": {
            "tableRange": {"tableCellLocation": {
                "tableStartLocation": loc, "rowIndex": row_index, "columnIndex": 0},
                "rowSpan": 1, "columnSpan": len(cols)},
            "tableCellStyle": {"backgroundColor": color}, "fields": "backgroundColor"}}

    margin = {"magnitude": 36, "unit": "PT"}
    reqs = [
        {"updateDocumentStyle": {"tabId": tid, "documentStyle": {
            "marginTop": margin, "marginBottom": margin,
            "marginLeft": margin, "marginRight": margin},
            "fields": "marginTop,marginBottom,marginLeft,marginRight"}},
        cell_bg(0, GRAY),
    ]
    for ci, w in enumerate(cols):
        reqs.append({"updateTableColumnProperties": {
            "tableStartLocation": loc, "columnIndices": [ci],
            "tableColumnProperties": {
                "widthType": "FIXED_WIDTH", "width": {"magnitude": w, "unit": "PT"}},
            "fields": "widthType,width"}})

    stat = {"paste": 0, "delete": 0, "review": 0, "skip": 0}
    for ri, r in enumerate(rows[1:], start=1):
        v = r[3] if len(r) >= 4 else ""
        if is_delete(v):
            stat["delete"] += 1
            reqs.append(cell_bg(ri, AMBER))
        elif is_review(v):
            stat["review"] += 1
            reqs.append(cell_bg(ri, PINK))
        elif is_skip(v):
            stat["skip"] += 1
            reqs.append(cell_bg(ri, LIGHT))
        else:
            stat["paste"] += 1

    reqs.append({"updateTextStyle": {
        "range": {"startIndex": tab_start, "endIndex": tab_end - 1, "tabId": tid},
        "textStyle": {"fontSize": {"magnitude": 9, "unit": "PT"}}, "fields": "fontSize"}})
    return reqs, stat


def _self_test():
    assert is_skip("—") and is_skip("  ") and not is_skip("派遣社員")
    assert is_skip("（入力なし）") and is_skip("（社内管理用。触らない）")
    assert is_skip("（変更なし）"), "古いJSONの「変更なし」を貼る値にしない"
    assert is_delete("【削除】今の「30代が多い」を消して空欄にする")
    assert not is_skip("【削除】今の「30代が多い」を消して空欄にする"), "消す行を沈めない"
    rev = "【要確認】今の「土日休み」は裏が取れていません。残すか消すかを決めてください"
    assert is_review(rev) and not is_delete(rev) and not is_skip(rev)
    # 現在値をそのまま書いた行は「貼る」扱い。ここを沈めると事務員が飛ばす
    assert not is_skip("喫煙所あり（屋内）")

    rows = [["No.", "項目名", "内部キー", "事務員転記"],
            ["1", "雇用形態", "job_type_jp", "派遣社員"],
            ["2", "喫煙所", "smoking", "喫煙所あり（屋内）"],   # 触っていないが現在値を貼る
            ["3", "職種2", "occupation_id_jp2", "（入力なし）"],
            ["176", "求人メモ", "job_offer_memo", "（社内管理用。触らない）"],
            ["90", "休日", "holiday", rev],
            ["23", "職場環境", "tags", "【削除】今の「女性が活躍中」を消して空欄にする"]]
    reqs, stat = build_requests(rows, 100, 900, "t.abc")
    assert stat == {"paste": 2, "delete": 1, "review": 1, "skip": 2}, stat
    # 1(余白) + 1(ヘッダ) + 4(列幅) + 2(沈める) + 1(判断) + 1(消す) + 1(フォント) = 11
    assert len(reqs) == 11, len(reqs)
    assert reqs[-2]["updateTableCellStyle"]["tableCellStyle"]["backgroundColor"] == AMBER
    assert reqs[-3]["updateTableCellStyle"]["tableCellStyle"]["backgroundColor"] == PINK

    assert reqs[0]["updateDocumentStyle"]["tabId"] == "t.abc", "documentStyle は直下 tabId"
    assert reqs[-1]["updateTextStyle"]["range"]["tabId"] == "t.abc", "textStyle は range 内 tabId"
    assert reqs[1]["updateTableCellStyle"]["tableRange"]["tableCellLocation"][
        "tableStartLocation"]["tabId"] == "t.abc", "tableStartLocation は Location なので tabId"
    assert reqs[1]["updateTableCellStyle"]["tableCellStyle"]["backgroundColor"] == GRAY
    assert sum(COLS) == 521

    # 実データを Drive 配下から読ませない。門番の中身は secure_tmp.py が試す。
    # ここで見るのは「呼び忘れていないか」だけ。
    # 判定用のパスは /tmp の外だと確実に言い切れる場所にする。スクリプトの置き場所から
    # 組み立てると、レビュー用に /tmp へコピーしただけでテストが落ちる。
    import contextlib
    import io
    import tempfile
    outside = "/etc/job-copy_must_not_be_read.json"
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        ok_state = os.path.join(d, "state.json")
        json.dump({"did": "d", "tid": "t"}, open(ok_state, "w", encoding="utf-8"))
        for opt, argv in (("--state", ["--items", ok_state]),
                          ("--items", ["--state", ok_state])):
            argv_backup, sys.argv = sys.argv, ["style_entry_doc.py", opt, outside] + argv
            try:
                with contextlib.redirect_stderr(io.StringIO()), \
                        contextlib.redirect_stdout(io.StringIO()):
                    main()
            except ValueError as e:
                assert "/tmp" in str(e), (opt, e)
            else:
                raise AssertionError(f"{opt} に /tmp 外を渡しても止まらなかった")
            finally:
                sys.argv = argv_backup
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--items")
    p.add_argument("--state")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return

    for name in ("items", "state"):
        if not getattr(a, name):
            p.error(f"--{name} は必須です")

    st = load_tmp_json(a.state, "--state")
    did, tid = st["did"], st["tid"]
    rows = load_tmp_json(a.items, "--items")

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    docs = build("docs", "v1", credentials=cred)

    doc = docs.documents().get(documentId=did, includeTabsContent=True).execute()
    tab = [t for t in doc["tabs"] if t["tabProperties"]["tabId"] == tid][0]
    tbl = [e for e in tab["documentTab"]["body"]["content"] if "table" in e][0]

    blank = [r[0] for r in rows[1:] if len(r) < 4 or not str(r[3]).strip()]
    if blank:
        print(f"注意: 事務員転記が空のままの行があります（No. {', '.join(map(str, blank[:10]))}"
              f"{' ほか' if len(blank) > 10 else ''}）。"
              "apply_plan.py を通していないか、--current を渡し忘れています。")

    reqs, stat = build_requests(rows, tbl["startIndex"], tbl["endIndex"], tid)
    print(f"style requests={len(reqs)}  貼る={stat['paste']}  消す={stat['delete']}  "
          f"要確認={stat['review']}  触らない={stat['skip']}")
    for i in range(0, len(reqs), STYLE_CHUNK):
        docs.documents().batchUpdate(
            documentId=did, body={"requests": reqs[i:i + STYLE_CHUNK]}).execute()
    print(f"https://docs.google.com/document/d/{did}/edit?tab={tid}")


if __name__ == "__main__":
    main()
