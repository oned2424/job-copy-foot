# -*- coding: utf-8 -*-
"""事務員がコピペで出稿するための「記載項目」Googleドキュメントを作る。

  python3 make_entry_doc.py \
      --items /tmp/items176_selected.json \
      --title 記載項目_派遣先名 \
      --tab   12204054 \
      --client foot \
      --state /tmp/doc_state.json \
      --current /tmp/current.json --request /tmp/request.json --siblings /tmp/siblings.json

★ 転記前チェック（precheck_doc.py）を内部で必ず通す。飛ばすオプションは無い。
  NGが1件でもあればドキュメントは作られない。--current / --request / --siblings を
  渡すほどチェックは厳しくなる（渡さないと比べる相手がいないので、その項目は外れる）。

  --items  差し替え済みの176項目JSON（apply_plan.py の出力）
  --title  ドキュメント名
  --tab    タブ名。既存求人は案件番号、新規案件は YYYYMMDD_派遣先名（AirWork採番後にリネーム）
  --client 保存先を config.json の drive.outputFolderId から引く（既定 foot）
  --folder 保存先を直接指定する。省略時は --client の設定を使う
  --state  {"did":..., "tid":...} の出力先。style_entry_doc.py が読む

★ 中身は表だけ。見出しも注記も入れない。
  このドキュメントは事務員にそのまま渡す作業指示である。
  ヒアリング結果・未回答項目・書かなかった表現といった経緯は、事務員の作業には要らない。
  経緯はヒアリング履歴スプレッドシートに残す（scripts/hearing_log.py）。
  事務員転記の列には、貼る値そのものか日本語の指示（【削除】…／（入力なし））が入るので、
  凡例が無くてもセルを読めば手が動く。
  書き換えていない項目にも現在の掲載値が入る（「（変更なし）」は 2026-08-02 に廃止）。
  事務員が AirWork の画面を見に行かなくても、この表だけで上から順に貼り終わる。

★ 1派遣先 = 1ドキュメント。案件はタブで増える。
  同じ派遣先で2回目以降を実行しても新しいファイルを作らない。保存先を名前で検索し、
  あればそのドキュメントにタブを足す（addDocumentTab）。同じ案件番号のタブが既にあれば
  中身を消して書き直す。だから「記載項目_◯◯」が何本もできることはなく、
  どれが正か分からなくなる状態を作らない。

注意:
  - 表の列幅合計は A4 使用可能幅（523.3pt）未満でなければならない。起動時に assert する。
  - insertText は startIndex の降順で流し込む。昇順だと後続のインデックスがずれる。
  - Docs API v1 のタブ指定は Location 直下の "tabId"。省略すると最初のタブに書かれる。
  - タブ追加のリクエスト名は addDocumentTab。discovery document には載っていないが動く
    （createTab / addTab / insertTab / createDocumentTab はいずれも存在しない）。

  python3 make_entry_doc.py --self-test
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from secure_tmp import dump_tmp_json, load_tmp_json, require_tmp_path  # noqa: E402

A4_WIDTH_PT = 595.2755905511812
MARGIN_PT = 36
COLS = [30, 105, 138, 248]           # No. / 項目名 / 内部キー / 事務員転記 = 521pt
INSERT_CHUNK = 300
SCOPES = ["https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/drive"]

# 内部キーごと外へ出さない項目。求人メモには請求単価/支払単価が入っている。
NEVER_EMIT = {"job_offer_memo"}
# 求人メモの列に置いてよい文字列。値そのものは何であれ通さない。
# 「（変更なし）」は廃止済みだが、古い items JSON をここで落とす理由が無いので残す。
ALLOWED_MARKERS = ("（社内管理用。触らない）", "（入力なし）", "（変更なし）")


def check_no_leak(rows):
    """派遣先にも事務員にも見せない値が混ざっていないか、最後の門で止める。

    求人メモの「◯◯運送2000/1500」は請求単価と支払単価である。
    fetch_current.py で伏せているが、plan 側から入る経路が残るのでここでも見る。
    """
    bad = []
    for r in rows[1:]:
        if len(r) >= 4 and r[2] in NEVER_EMIT:
            v = str(r[3]).strip()
            if v and v not in ALLOWED_MARKERS:
                bad.append((r[0], r[1]))
    if bad:
        raise ValueError(
            "社内管理用の項目に値が入っています（単価が漏れます）: "
            + " / ".join(f"No.{n} {name}" for n, name in bad)
            + "。（社内管理用。触らない）にするか空にしてください")
    return True


def check_cols(cols=COLS):
    usable = A4_WIDTH_PT - MARGIN_PT * 2
    if sum(cols) >= usable:
        raise ValueError(f"表が用紙幅を超えます: {sum(cols)}pt >= {usable:.1f}pt")
    return sum(cols)


def check_title(title):
    """ファイル名は「記載項目_派遣先名」だけ。案件番号・案・日付はタブ名の役目。

    ここを緩めると「記載項目_◯◯_12204054_B案_Cキャッチ」のような
    作業メモがそのままファイル名になり、同じ派遣先のドキュメントが何本もできる。
    """
    if not title.startswith("記載項目_"):
        raise ValueError(f"ファイル名は「記載項目_派遣先名」の形にしてください: {title}")
    tail = title[len("記載項目_"):]
    if not tail.strip():
        raise ValueError("派遣先名が空です")
    for word in ("案", "キャッチ"):
        if word in tail:
            raise ValueError(f"ファイル名に案の情報を入れません（'{word}'）: {title}。"
                             "1案件1タブで、タブ名を案件番号にしてください")
    if any(c.isdigit() for c in tail):
        raise ValueError(f"ファイル名に数字（案件番号・日付）を入れません: {title}。"
                         "案件番号は --tab に渡してタブ名にしてください")
    return title


def cell_inserts(table, rows):
    """(startIndex, text) の一覧を startIndex 降順で返す。"""
    ins = []
    for ri, tr in enumerate(table["table"]["tableRows"]):
        for ci, tc in enumerate(tr["tableCells"]):
            txt = str(rows[ri][ci]) if ri < len(rows) and ci < len(rows[ri]) else ""
            if txt.strip():
                ins.append((tc["content"][0]["startIndex"], txt))
    ins.sort(key=lambda x: -x[0])
    return ins


def iter_tabs(tabs):
    """タブを入れ子ごと平らに辿る。子タブを見落として同名タブを二重に作らないため。"""
    for t in tabs or []:
        yield t
        for c in iter_tabs(t.get("childTabs")):
            yield c


def find_tab(doc, title):
    """タブ名からタブを引く。無ければ None。"""
    for t in iter_tabs(doc.get("tabs")):
        if (t["tabProperties"].get("title") or "").strip() == str(title).strip():
            return t
    return None


def tab_end_index(tab):
    """タブ本文の最終インデックス。空タブなら 2（sectionBreak + 空段落）。"""
    content = tab.get("documentTab", {}).get("body", {}).get("content", [])
    return content[-1]["endIndex"] if content else 2


def find_doc(drive, title, folder):
    """保存先フォルダから同名ドキュメントを引く。無ければ None。

    2本以上見つかったら止める。どちらが正か分からない状態のまま書き足すと、
    「何が正で何が正じゃないのか分からない」を機械が量産することになる。
    """
    q = (f"name = '{title}' and '{folder}' in parents and trashed = false "
         "and mimeType = 'application/vnd.google-apps.document'")
    hit = drive.files().list(q=q, fields="files(id,name)",
                             pageSize=10).execute().get("files", [])
    if len(hit) > 1:
        raise ValueError(
            f"同名のドキュメントが {len(hit)} 本あります: "
            + " / ".join(f"https://docs.google.com/document/d/{f['id']}/edit" for f in hit)
            + "。1派遣先1ドキュメントにするため、残す1本以外を退避してから実行してください")
    return hit[0]["id"] if hit else None


def site_from_title(title):
    """「記載項目_乙川運送」→「乙川運送」。ログの派遣先列に入れる。"""
    return str(title).split("_", 1)[1].strip() if "_" in str(title) else str(title).strip()


def is_job_id(tab):
    """タブ名が案件番号（数字のみ）かどうか。

    新規案件のタブは `YYYYMMDD_派遣先名` で、AirWork の採番前なので照合の相手がいない。
    記録しても永遠に「未確認」で残るだけなので、番号が付いてから記録する。
    """
    return str(tab).strip().isdigit()


def run_precheck(a, rows):
    """転記前チェックを通す。NGが1件でもあればドキュメントを作らずに止まる。

    ★ 飛ばすオプションは用意していない。
      チェックを外せるようにすると、急いでいるときほど外される。
      そして外したことは誰も覚えていない。実際 2026-08-03 の甲山機工では、
      掲載中の「土日休み・連休あり」と月収例が消える指示のまま
      ドキュメントが出来上がり、人が目で気づくまで誰も止めなかった。

    --current が無い新規案件では、比較する現在値がないので
    P1（減っていないか）・P2（契約条件）・P4（依頼との食い違い）は自動で外れる。
    """
    import precheck_doc as C

    def load(path):
        # 実データは /tmp からしか読まない。門番は secure_tmp が唯一の実装。
        return load_tmp_json(path) if path and os.path.exists(path) else None

    meta = a.items + ".meta.json"
    print("--- 転記前チェック ---")
    results = C.check(
        rows, load(a.current), load(a.request), load(a.siblings), load(meta),
        allow_shrink=[s for s in (a.allow_shrink or "").split(",") if s.strip()],
        confirmed=[s for s in (a.confirmed or "").split(",") if s.strip()])
    if C.report(results):
        print("\n直してから、もう一度実行してください。ドキュメントは作っていません。",
              file=sys.stderr)
        sys.exit(1)


def log_changes(a):
    """入稿指示ログへ自動追記する。失敗してもドキュメント生成は成功のままにする。

    ここで例外を投げ返すと、出来上がっているドキュメントを人が「失敗した」と受け取り、
    もう一度作り直す。ログは補助であって成果物ではないので、警告に留める。
    """
    meta = a.items + ".meta.json"
    if not os.path.exists(meta):
        print("※ 入稿指示ログ未記録: 書き換えたNo.の記録がありません"
              f"（{os.path.basename(meta)}）。apply_plan.py を通してから実行すると記録されます")
        return
    if not is_job_id(a.tab):
        print(f"※ 入稿指示ログ未記録: タブ名 '{a.tab}' はまだ案件番号ではありません。"
              f"AirWork で採番されたら次を実行してください\n"
              f"    python3 push_to_joblist.py append --client {a.client} --job <案件番号> "
              f"--site {site_from_title(a.title)} --items {a.items} --meta {meta}")
        return
    try:
        import push_to_joblist as P
        P.do_append(argparse.Namespace(
            client=a.client, job=a.tab, site=site_from_title(a.title),
            items=a.items, meta=meta))
    except Exception as e:                    # noqa: BLE001 - ログ失敗で本体を落とさない
        print(f"※ 入稿指示ログの記録に失敗しました（ドキュメントは出来ています）: {e}\n"
              f"    あとで手動で: python3 push_to_joblist.py append --client {a.client} "
              f"--job {a.tab} --site {site_from_title(a.title)} "
              f"--items {a.items} --meta {meta}", file=sys.stderr)


def _self_test():
    assert site_from_title("記載項目_乙川運送") == "乙川運送"
    assert site_from_title("記載項目_◯◯運送_一色営業所") == "◯◯運送_一色営業所"
    assert site_from_title("乙川運送") == "乙川運送"
    assert is_job_id("12204054") and is_job_id(" 12204054 ")
    assert not is_job_id("20260802_乙川運送"), "新規案件のタブを案件番号と見なしてはいけない"

    assert check_cols() == 521
    try:
        check_cols([200, 200, 200])
        raise AssertionError("幅超過を検出できていない")
    except ValueError:
        pass

    # ファイル名に案件番号・案・日付を混ぜない（タブ名の役目）
    assert check_title("記載項目_乙川運送") == "記載項目_乙川運送"
    for ng in ("記載項目_乙川運送_12204054_B案_Cキャッチ", "記載項目_乙川運送_B案",
               "記載項目_乙川運送_20260802", "乙川運送", "記載項目_"):
        try:
            check_title(ng)
            raise AssertionError(f"弾けていない: {ng}")
        except ValueError:
            pass

    # 降順で返ること・空セルを飛ばすこと
    tbl = {"table": {"tableRows": [
        {"tableCells": [{"content": [{"startIndex": 10}]}, {"content": [{"startIndex": 20}]}]},
        {"tableCells": [{"content": [{"startIndex": 30}]}, {"content": [{"startIndex": 40}]}]}]}}
    ins = cell_inserts(tbl, [["No.", "項目名"], ["1", "  "]])
    assert [i for i, _ in ins] == [30, 20, 10], ins   # 空白セル(40)は飛ばす

    # 単価は最後の門で止める
    head4 = ["No.", "項目名", "内部キー", "事務員転記"]
    # fill_blanks は現在値をそのまま書くが、求人メモは fetch_current.py が伏せてある
    assert check_no_leak([head4, ["176", "求人メモ", "job_offer_memo", "（社内管理用。触らない）"]])
    assert check_no_leak([head4, ["176", "求人メモ", "job_offer_memo", "（変更なし）"]])  # 旧JSON
    try:
        check_no_leak([head4, ["176", "求人メモ", "job_offer_memo", "◯◯運送2000/1500"]])
        raise AssertionError("単価を素通ししている")
    except ValueError:
        pass

    # タブ探索。子タブまで辿らないと同名タブを二重に作る
    doc = {"tabs": [
        {"tabProperties": {"tabId": "t.0", "title": "12204054"},
         "documentTab": {"body": {"content": [{"endIndex": 1}, {"endIndex": 900}]}},
         "childTabs": [{"tabProperties": {"tabId": "t.9", "title": "12204099"},
                        "documentTab": {"body": {"content": [{"endIndex": 2}]}}}]},
        {"tabProperties": {"tabId": "t.1", "title": "12204055"},
         "documentTab": {"body": {"content": [{"endIndex": 2}]}}}]}
    assert len(list(iter_tabs(doc["tabs"]))) == 3
    assert find_tab(doc, "12204054")["tabProperties"]["tabId"] == "t.0"
    assert find_tab(doc, "12204099")["tabProperties"]["tabId"] == "t.9", "子タブを見落としている"
    assert find_tab(doc, " 12204055 ")["tabProperties"]["tabId"] == "t.1"   # 前後の空白は無視
    assert find_tab(doc, "99999999") is None
    assert tab_end_index(find_tab(doc, "12204054")) == 900
    assert tab_end_index(find_tab(doc, "12204055")) == 2, "空タブの判定"

    # 転記前チェックが本当に止めること。ここが素通りすると全部の防御が無意味になる
    ns = argparse.Namespace(items="/tmp/__nonexistent__.json", current=None,
                            request=None, siblings=None, allow_shrink="", confirmed="")
    bad = [head4, ["3", "職種名", "title", "時給2000円のリフト作業"]]   # P5 に当たる
    try:
        run_precheck(ns, bad)
        raise AssertionError("NGなのにドキュメント生成へ進もうとしている")
    except SystemExit as e:
        assert e.code == 1, e.code
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--items")
    p.add_argument("--title")
    p.add_argument("--tab")
    p.add_argument("--client", default="foot")
    p.add_argument("--folder")
    p.add_argument("--state")
    p.add_argument("--current", help="fetch_current.py の出力。転記前チェックが現在値と比べる")
    p.add_argument("--request", help="依頼フォーマット7項目のJSON。依頼どおりか照合する")
    p.add_argument("--siblings", help="collect_siblings.py の出力。素材の使い残しを見る")
    p.add_argument("--allow-shrink", default="",
                   help="意図して掲載情報を減らすNo.（カンマ区切り）")
    p.add_argument("--confirmed", default="",
                   help="依頼と掲載中の食い違いを確認済みの項目（hours,wage）")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return

    for name in ("items", "title", "tab", "state"):
        if not getattr(a, name):
            p.error(f"--{name} は必須です")

    # 保存先は config.json に持たせる。33桁のフォルダIDを毎回手で渡させない。
    from client_config import output_folder
    folder = a.folder or output_folder(a.client)

    check_cols()
    check_title(a.title)
    # rows は原稿そのもの。--state は書き先。どちらも /tmp の外に置かせない。
    try:
        rows = load_tmp_json(a.items, "--items")
        require_tmp_path(a.state, "--state")
    except ValueError as e:
        print(f"NG: {e}", file=sys.stderr)
        sys.exit(1)
    check_no_leak(rows)
    run_precheck(a, rows)

    blank = [r[0] for r in rows[1:] if len(r) < 4 or not str(r[3]).strip()]
    if blank:
        print(f"NG: 事務員転記が空の行が {len(blank)} 件あります"
              f"（No. {', '.join(map(str, blank[:10]))}"
              f"{' ほか' if len(blank) > 10 else ''}）。\n"
              "    空欄のまま渡すと事務員が「入れない」のか「消す」のか判断できません。\n"
              "    apply_plan.py に --current を渡して埋めてから実行してください。", file=sys.stderr)
        sys.exit(1)
    print(f"投入行数: {len(rows)}（ヘッダ含む）")

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    docs = build("docs", "v1", credentials=cred)
    drive = build("drive", "v3", credentials=cred)

    # 1) 派遣先のドキュメントを探す。無ければ作ってフォルダへ移す
    did = find_doc(drive, a.title, folder)
    if did:
        print(f"既存ドキュメントに追記: {did}")
    else:
        did = docs.documents().create(body={"title": a.title}).execute()["documentId"]
        cur = drive.files().get(fileId=did, fields="parents").execute().get("parents", [])
        drive.files().update(fileId=did, addParents=folder,
                             removeParents=",".join(cur), fields="id,parents").execute()
        print(f"新規作成 + フォルダ移動: {did} → {folder}")

    # 2) 案件番号のタブを用意する。1案件1タブで、作り直しても増やさない
    doc = docs.documents().get(documentId=did, includeTabsContent=True).execute()
    tab = find_tab(doc, a.tab)
    if tab:
        # 同じ案件の作り直し。中身を消してから書き直す（下に積むと二重になる）
        tid = tab["tabProperties"]["tabId"]
        end = tab_end_index(tab)
        if end > 2:
            docs.documents().batchUpdate(documentId=did, body={"requests": [
                {"deleteContentRange": {
                    "range": {"startIndex": 1, "endIndex": end - 1, "tabId": tid}}}]}).execute()
        print(f"既存タブ '{a.tab}' の中身を差し替え (tabId={tid})")
    elif len(list(iter_tabs(doc.get("tabs")))) == 1 and tab_end_index(doc["tabs"][0]) <= 2:
        # 作りたてのドキュメント。空のルートタブがあるので、足さずにリネームして使う
        tid = doc["tabs"][0]["tabProperties"]["tabId"]
        docs.documents().batchUpdate(documentId=did, body={"requests": [
            {"updateDocumentTabProperties": {
                "tabProperties": {"tabId": tid, "title": a.tab}, "fields": "title"}}]}).execute()
        print(f"ルートタブを '{a.tab}' にリネーム (tabId={tid})")
    else:
        # 同じ派遣先の別案件。タブを足す
        docs.documents().batchUpdate(documentId=did, body={"requests": [
            {"addDocumentTab": {"tabProperties": {"title": a.tab}}}]}).execute()
        doc = docs.documents().get(documentId=did, includeTabsContent=True).execute()
        tid = find_tab(doc, a.tab)["tabProperties"]["tabId"]
        print(f"タブ '{a.tab}' を追加 (tabId={tid})　"
              f"このドキュメントのタブ数={len(list(iter_tabs(doc.get('tabs'))))}")

    # 3) 空テーブルだけを置く。見出し・注記は入れない（事務員にそのまま渡す作業指示なので）
    def loc(i):
        return {"index": i, "tabId": tid}

    docs.documents().batchUpdate(documentId=did, body={"requests": [
        {"insertTable": {"location": loc(1),
                         "rows": len(rows), "columns": len(COLS)}}]}).execute()

    # 4) セルに値を投入（startIndex 降順・チャンク分割）
    doc = docs.documents().get(documentId=did, includeTabsContent=True).execute()
    body = find_tab(doc, a.tab)["documentTab"]["body"]["content"]
    tbl = [e for e in body if "table" in e][0]
    reqs = [{"insertText": {"location": loc(i), "text": t}}
            for i, t in cell_inserts(tbl, rows)]
    print(f"insertText: {len(reqs)} 件")
    for i in range(0, len(reqs), INSERT_CHUNK):
        docs.documents().batchUpdate(
            documentId=did, body={"requests": reqs[i:i + INSERT_CHUNK]}).execute()

    dump_tmp_json(a.state, {"did": did, "tid": tid})
    print(f"https://docs.google.com/document/d/{did}/edit?tab={tid}")

    # 5) 何を書き換えたかを Joblist の別タブへ自動で記録する。
    #    人が別コマンドを覚えて叩く運用にすると、忘れられて記録が虫食いになる。
    log_changes(a)

    print(f"次: python3 style_entry_doc.py --items {a.items} --state {a.state}")


if __name__ == "__main__":
    main()
