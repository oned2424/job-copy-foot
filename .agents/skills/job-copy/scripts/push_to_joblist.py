# -*- coding: utf-8 -*-
"""出稿用ドキュメントで出した指示を Joblist スプシの別タブへ自動で記録し、あとで照合する。

  append : 書き換えた項目を「入稿指示ログ」タブへ書く（状態=未確認）
  verify : Joblist の現在値と突き合わせ、状態を 確認済み / 差分あり に更新する

★ なぜ別タブなのか
  Joblist の Sheet1 は AirWork から落とした CSV をまるごと貼り替える運用である。
  そこに列を足すと、次にエクスポートを貼った瞬間に消える。だから **Sheet1 は触らない**。
  記録は同じスプシの別タブに置く。貼り替えても残り、AirWork の現実も汚さない。

★ なぜ「未確認」から始めるのか
  スキルが書けるのは「こう入稿してほしい」という意図までで、
  事務員が実際に AirWork へ貼ったかどうかは分からない。
  貼った前提で書くと、次に fetch_current.py がそれを現在値として読み、
  「【削除】今の◯◯を消して」が存在しない値を消せという指示になる。事務員が一番混乱する壊れ方である。
  そこで状態を持たせ、AirWork のエクスポートで裏が取れて初めて 確認済み に上げる。

  Joblist が「現実」、このログが「意図」。混ぜない。

★ 人が起動を覚えなくていい
  append は make_entry_doc.py が、verify は fetch_current.py が自動で呼ぶ。
  手で叩く必要はない（叩いても同じ結果になる）。

  python3 push_to_joblist.py append --client foot --job 12204054 \
      --site 乙川運送 --items /tmp/items176_selected.json --meta /tmp/items176_selected.meta.json
  python3 push_to_joblist.py verify --client foot --job 12204054
  python3 push_to_joblist.py --self-test
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# 原稿行JSON・現在値JSONは掲載中の求人本文そのもの。実データなので /tmp からしか読まない。
# apply_plan.py --items（値の入っていない176項目マスタ）だけが意図的な例外で、
# ここに来る --items は値が入ったあとの原稿なので縛る。門番は secure_tmp.py が唯一。
from secure_tmp import load_tmp_json  # noqa: E402

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

DEFAULT_LOG_SHEET = "入稿指示ログ"
HEADER = ["記録日時", "案件番号", "派遣先", "No.", "項目名", "内部キー",
          "指示した値", "状態", "照合日時", "AirWorkの実値"]

NEW = "未確認"
OK = "確認済み"
NG = "差分あり"

DELETE_PREFIX = "【削除】"
# 残すか消すかを人が決める行。指示が確定していないのでログにも照合にも載せない。
REVIEW_PREFIX = "【要確認】"
# 事務員への指示であって AirWork に貼る値ではないもの。照合対象から外す。
MARKERS = {"（入力なし）", "（社内管理用。触らない）", "（変更なし）"}
BLANKS = {"", "—", "-", "―", "ー", "－"}

# ここに書き込んだら事故。AirWork のエクスポートを貼るタブは触らない。
PROTECTED = re.compile(r"^(sheet|シート)\d*(\s|$)", re.I)


def norm(v):
    """比較用に均す。全角空白・連続空白・前後空白の差で「差分あり」にしない。"""
    s = str(v or "").replace("　", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return "" if s in BLANKS else s


def is_delete(v):
    return str(v or "").startswith(DELETE_PREFIX)


def check_sheet_name(name):
    """書き込み先が AirWork のエクスポートを貼るタブでないことを確かめる。"""
    if PROTECTED.match(str(name).strip()):
        raise ValueError(
            f"書き込み先が '{name}' になっています。ここは AirWork のエクスポートを貼るタブで、"
            f"貼り替えのたびに消えます。config.json の spreadsheet.logSheetName を "
            f"'{DEFAULT_LOG_SHEET}' のような別名にしてください")
    return name


def build_rows(items, changed, job, site, now):
    """書き換えた項目だけをログ行にする。176項目を全部残すと案件が増えるたび行が膨らむ。"""
    changed = {str(c) for c in changed}
    idx = {}
    out = []
    for r in items[1:]:
        no = str(r[0])
        if no not in changed:
            continue
        val = str(r[3]) if len(r) > 3 else ""
        if val.startswith(REVIEW_PREFIX):
            # 指示ではなく判断待ち。ログに載せると「未反映」と数えられ続ける
            changed = changed - {no}
            continue
        out.append([now, str(job), site, no, r[1], r[2], val, NEW, "", ""])
        idx[(str(job), r[2])] = len(out) - 1
    missing = changed - {r[3] for r in out}
    if missing:
        raise ValueError(f"書き換えたはずのNo.が176項目に見つかりません: {sorted(missing)}")
    return out


def merge(existing, fresh):
    """(案件番号, 内部キー) が同じ行は上書きする。最新の指示だけを正とする。

    返り値は (更新する行番号→行, 追記する行のリスト)。
    履歴を積み上げないのは、事務員向けの指示は最新の1件しか意味を持たないため。
    経緯は出稿用ドキュメントのタブ側に残る。
    """
    pos = {}
    for i, row in enumerate(existing[1:], start=2):   # 1始まり・ヘッダー行を除く
        if len(row) > 5:
            pos[(str(row[1]).strip(), str(row[5]).strip())] = i
    upd, add = {}, []
    for row in fresh:
        k = (str(row[1]).strip(), str(row[5]).strip())
        if k in pos:
            upd[pos[k]] = row
        else:
            add.append(row)
    return upd, add


def verify_rows(existing, current, job, now):
    """まだ裏が取れていない行を現在値と突き合わせる。返り値は (行番号→(状態, 実値), 集計)。

    対象は「確認済み以外」＝未確認と差分あり。差分ありを対象から外すと、
    事務員があとから貼っても確認済みに上がらず、いつまでも赤いままになる。
    確認済みは触らない。一度 AirWork に載ったことが取れれば、その指示の役目は終わり。
    """
    upd, stat = {}, {OK: 0, NG: 0}
    for i, row in enumerate(existing[1:], start=2):
        if len(row) < 8:
            continue
        if str(row[1]).strip() != str(job).strip() or str(row[7]).strip() == OK:
            continue
        key, want = str(row[5]).strip(), str(row[6])
        if want.strip() in MARKERS or want.startswith(REVIEW_PREFIX):
            continue                      # 貼る値ではないので照合しない
        if key not in current:
            continue                      # Joblist に無い内部キーは判定材料が無い
        got = norm(current[key])
        hit = (got == "") if is_delete(want) else (got == norm(want))
        upd[i] = (OK, "") if hit else (NG, current[key])
        stat[OK if hit else NG] += 1
    return upd, stat


def load_config(client):
    path = os.path.join(HERE, "..", "references", "clients", client, "config.json")
    cfg = json.load(open(path, encoding="utf-8"))
    sp = cfg.get("spreadsheet", {})
    if not sp.get("id"):
        raise ValueError(f"{path} に spreadsheet.id がありません")
    return sp["id"], check_sheet_name(sp.get("logSheetName") or DEFAULT_LOG_SHEET)


def open_log(sh, sid, name):
    """ログタブを開く。無ければ作ってヘッダーを置く。既存の値は触らない。"""
    meta = sh.get(spreadsheetId=sid, fields="sheets.properties").execute()
    titles = [s["properties"]["title"] for s in meta["sheets"]]
    if name not in titles:
        sh.batchUpdate(spreadsheetId=sid, body={"requests": [
            {"addSheet": {"properties": {"title": name}}}]}).execute()
        sh.values().update(spreadsheetId=sid, range=f"'{name}'!A1",
                           valueInputOption="RAW",
                           body={"values": [HEADER]}).execute()
        print(f"タブ '{name}' を新規作成しました")
        return [HEADER]
    rows = sh.values().get(spreadsheetId=sid,
                           range=f"'{name}'!A1:J").execute().get("values", [])
    if not rows:
        sh.values().update(spreadsheetId=sid, range=f"'{name}'!A1",
                           valueInputOption="RAW",
                           body={"values": [HEADER]}).execute()
        return [HEADER]
    return rows


def _service(sid):
    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    return build("sheets", "v4", credentials=cred).spreadsheets()


def do_append(a):
    sid, name = load_config(a.client)
    items = load_tmp_json(a.items, "--items")
    changed = load_tmp_json(a.meta, "--meta").get("changed", []) if a.meta else []
    if not changed:
        print("記録する書き換えがありません（meta の changed が空）")
        return 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    fresh = build_rows(items, changed, a.job, a.site, now)

    sh = _service(sid)
    existing = open_log(sh, sid, name)
    upd, add = merge(existing, fresh)

    data = [{"range": f"'{name}'!A{i}", "values": [row]} for i, row in upd.items()]
    if data:
        sh.values().batchUpdate(spreadsheetId=sid, body={
            "valueInputOption": "RAW", "data": data}).execute()
    if add:
        sh.values().append(spreadsheetId=sid, range=f"'{name}'!A1",
                           valueInputOption="RAW", insertDataOption="INSERT_ROWS",
                           body={"values": add}).execute()
    print(f"入稿指示ログへ記録: 新規 {len(add)} 件 / 更新 {len(upd)} 件（状態={NEW}）")
    print(f"  AirWork へ貼ったあと、次に Joblist を更新すると自動で照合されます")
    return 0


def do_verify(a):
    sid, name = load_config(a.client)
    # スプシに触る前に読む。取りにいってから断ると、実データを載せてから止めることになる。
    current = load_tmp_json(a.current, "--current") if a.current else None

    sh = _service(sid)
    existing = open_log(sh, sid, name)
    if len(existing) < 2:
        return 0

    if current is None:
        from fetch_current import build_current, load_config as lc
        jid, jsheet = lc(a.client)
        values = sh.values().get(spreadsheetId=jid,
                                 range=f"{jsheet}!A1:JZ").execute().get("values", [])
        hit = [r for r in values[1:] if r and str(r[0]).strip() == str(a.job).strip()]
        if not hit:
            print(f"求人番号 {a.job} が Joblist にありません。照合を飛ばします")
            return 0
        current = build_current(values[0], hit[0])

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    upd, stat = verify_rows(existing, current, a.job, now)
    if not upd:
        print("照合対象なし（未確認の指示はありません）")
        return 0

    data = [{"range": f"'{name}'!H{i}:J{i}", "values": [[state, now, got]]}
            for i, (state, got) in upd.items()]
    sh.values().batchUpdate(spreadsheetId=sid, body={
        "valueInputOption": "RAW", "data": data}).execute()
    print(f"照合: {OK} {stat[OK]} 件 / {NG} {stat[NG]} 件")
    if stat[NG]:
        print(f"  ※ {NG} は AirWork にまだ反映されていないか、事務員が別の値で入稿しています。"
              f"'{name}' タブのJ列で実値を確認してください")
    return 0


def pending(sh, sid, name, job):
    """まだ AirWork に載ったと確認できていない件数。fetch_current.py の警告に使う。

    未確認と差分ありを両方数える。どちらも「この現在値には前回の指示が入っていない」
    という同じ意味を持つので、片方だけ数えると警告が出なくなる。
    """
    rows = sh.values().get(spreadsheetId=sid,
                           range=f"'{name}'!A1:J").execute().get("values", [])
    return sum(1 for r in rows[1:]
               if len(r) > 7 and str(r[1]).strip() == str(job).strip()
               and str(r[7]).strip() != OK)


def _self_test():
    assert norm(" 制服　あり ") == "制服 あり"
    assert norm("—") == "" and norm("－") == "" and norm(None) == ""
    assert is_delete("【削除】今の「軽作業」を消して空欄にする")
    assert not is_delete("軽作業")

    # Sheet1 系へ書こうとしたら止める
    for bad in ("Sheet1", "Sheet1 のコピー", "sheet", "シート1"):
        try:
            check_sheet_name(bad)
            raise AssertionError(f"'{bad}' を止めていない")
        except ValueError:
            pass
    assert check_sheet_name(DEFAULT_LOG_SHEET) == DEFAULT_LOG_SHEET
    assert check_sheet_name("入稿指示ログ_2026") == "入稿指示ログ_2026"

    items = [["No.", "項目名", "内部キー", "事務員転記"],
             ["1", "雇用形態", "job_type_jp", "派遣社員"],
             ["3", "職種名", "title", "新タイトル"],
             ["5", "職種2", "occupation_id_jp2", "【削除】今の「軽作業」を消して空欄にする"],
             ["23", "職場環境", "tags", "制服あり"]]
    fresh = build_rows(items, ["3", 5, "23"], "12204054", "乙川運送", "2026-08-02 10:00")
    assert len(fresh) == 3, fresh                       # 書き換えた項目だけ
    assert [r[3] for r in fresh] == ["3", "5", "23"]
    assert all(r[7] == NEW for r in fresh), "最初から確認済みにしてはいけない"
    assert fresh[0][6] == "新タイトル" and fresh[0][5] == "title"
    try:
        build_rows(items, ["999"], "12204054", "乙川運送", "x")
        raise AssertionError("存在しないNo.を黙って通した")
    except ValueError:
        pass

    # 同じ (案件番号, 内部キー) は行を増やさず上書きする
    existing = [HEADER,
                ["2026-08-01 09:00", "12204054", "乙川運送", "3", "職種名", "title",
                 "旧タイトル", NEW, "", ""],
                ["2026-08-01 09:00", "12204055", "乙川運送", "3", "職種名", "title",
                 "別案件", NEW, "", ""]]
    upd, add = merge(existing, fresh)
    assert list(upd) == [2], upd                        # 2行目だけ上書き
    assert upd[2][6] == "新タイトル"
    assert len(add) == 2, add                           # title 以外は追記
    assert all(r[1] == "12204054" for r in add)

    # 照合。一致→確認済み、不一致→差分あり、削除は空なら一致
    existing2 = [HEADER,
                 ["", "12204054", "乙川運送", "3", "職種名", "title", "新タイトル", NEW, "", ""],
                 ["", "12204054", "乙川運送", "5", "職種2", "occupation_id_jp2",
                  "【削除】今の「軽作業」を消して空欄にする", NEW, "", ""],
                 ["", "12204054", "乙川運送", "23", "職場環境", "tags", "制服あり", NEW, "", ""],
                 ["", "12204054", "乙川運送", "176", "求人メモ", "job_offer_memo",
                  "（社内管理用。触らない）", NEW, "", ""],
                 ["", "12204054", "乙川運送", "7", "仕事内容", "description", "本文", OK, "", ""],
                 ["", "12204054", "乙川運送", "64", "給与例", "salary_example", "月25万",
                  NG, "2026-08-01 12:00", "月20万"],
                 ["", "12204055", "乙川運送", "3", "職種名", "title", "別案件", NEW, "", ""]]
    cur = {"title": "新タイトル　", "occupation_id_jp2": "—",
           "tags": "制服あり,30代が多い", "job_offer_memo": "◯◯運送2000/1500",
           "description": "本文", "salary_example": "月25万"}
    upd2, stat2 = verify_rows(existing2, cur, "12204054", "2026-08-02 11:00")
    assert upd2[2][0] == OK, upd2[2]                    # 全角空白の差は無視
    assert upd2[3][0] == OK, upd2[3]                    # 削除指示 → 実値が空なら一致
    assert upd2[4][0] == NG and upd2[4][1] == "制服あり,30代が多い"
    assert 5 not in upd2, "求人メモを照合対象にしてはいけない"
    assert 6 not in upd2, "確認済みの行を再判定してはいけない"
    # 差分ありの行は次の照合で拾い直す。あとから貼られたら確認済みに上げる
    assert upd2[7][0] == OK, "差分ありのまま塩漬けにしている"
    assert 8 not in upd2, "別案件の行に触れてはいけない"
    assert stat2 == {OK: 3, NG: 1}, stat2

    # Joblist に無い内部キーは判定材料が無いので放置する（勝手に差分ありにしない）
    upd3, stat3 = verify_rows(existing2, {"title": "新タイトル"}, "12204054", "x")
    assert list(upd3) == [2] and stat3 == {OK: 1, NG: 0}, (upd3, stat3)

    # 原稿・現在値を Drive 配下から読めないこと。門番の中身は secure_tmp.py が試すので、
    # ここで見るのは「呼び忘れていないか」だけ。スプシへ触る前に止まることも兼ねる。
    # 判定用パスは /etc 固定。スクリプトの置き場所から組み立てると、
    # レビュー用に /private/tmp へコピーしたとき通ってしまう。
    outside = "/etc/job-copy_must_not_be_read.json"
    import tempfile
    fd, inside = tempfile.mkstemp(dir="/tmp", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(items, fh)
    try:
        for kw in ({"items": outside, "meta": None}, {"items": inside, "meta": outside}):
            try:
                do_append(argparse.Namespace(client="foot", job="12204054", site="", **kw))
                raise AssertionError(f"{kw} で /tmp 外を読んでも止まらなかった")
            except ValueError as e:
                assert "/tmp" in str(e), e
    finally:
        os.unlink(inside)
    try:
        do_verify(argparse.Namespace(client="foot", job="12204054", current=outside))
        raise AssertionError("--current に /tmp 外を渡しても止まらなかった")
    except ValueError as e:
        assert "/tmp" in str(e), e
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", nargs="?", choices=["append", "verify"])
    p.add_argument("--client", default="foot")
    p.add_argument("--job")
    p.add_argument("--site", default="")
    p.add_argument("--items")
    p.add_argument("--meta")
    p.add_argument("--current", help="verify で使う現在値JSON。省略すると Joblist から直接読む")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    if not a.mode:
        p.error("append か verify を指定してください")
    if not a.job:
        p.error("--job は必須です")
    if a.mode == "append":
        if not a.items:
            p.error("append には --items が必要です")
        sys.exit(do_append(a))
    sys.exit(do_verify(a))


if __name__ == "__main__":
    main()
