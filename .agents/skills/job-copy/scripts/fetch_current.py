# -*- coding: utf-8 -*-
"""いま掲載中の求人の値を「内部キー → 値」で取り出す。apply_plan.py --current の入力。

  python3 fetch_current.py --client foot --job 12204054 --output /tmp/current.json

これが無いと apply_plan.py は「今の値を消す」と「もともと空」を区別できず、
事務員転記の列が空欄だらけになる。既存求人を書き換えるときは必ず先に通す。

Joblist のヘッダーは「項目名(internal_key)」の形。末尾の括弧内を内部キーとして拾う。
列数は 265。config の range（A1:IE=239列）に引きずられると 求人メモ まで届かない。

★ 単価を外に出さない
  求人メモ(job_offer_memo) には「◯◯運送2000/1500」のように請求単価/支払単価が入る。
  派遣先にも事務員にも見せない情報なので、値を伏せて返す。
  伏せ字は apply_plan.py にそのまま渡り、事務員転記の列でも
  「（社内管理用。触らない）」として出る＝事務員は手を付けない。

  python3 fetch_current.py --self-test
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# 現在値JSONは掲載中の求人本文そのもの。実データなので /tmp からしか出さない。
# 門番の実装は secure_tmp.py が唯一。ここで自前の判定を書かない。
from secure_tmp import dump_tmp_json, require_tmp_path  # noqa: E402

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
KEY_RE = re.compile(r"\(([A-Za-z0-9_]+)\)\s*$")

# 値を外に出さない内部キー。伏せ字にして「触らない」へ倒す。
REDACT = {"job_offer_memo": "（社内管理用。触らない）"}


def extract_key(header):
    """「雇用形態(job_type_jp)」→ job_type_jp。括弧が無い列は内部キー無しとして捨てる。"""
    m = KEY_RE.search((header or "").strip())
    return m.group(1) if m else None


def build_current(header, row):
    """ヘッダー行と1案件の行から {内部キー: 値} を作る。"""
    out = {}
    for i, h in enumerate(header):
        key = extract_key(h)
        if not key:
            continue
        if key in REDACT:
            # 値の有無だけ伝える。中身（単価）は載せない。
            out[key] = REDACT[key] if i < len(row) and str(row[i]).strip() else ""
            continue
        out[key] = str(row[i]).strip() if i < len(row) else ""
    return out


def load_config(client):
    path = os.path.join(HERE, "..", "references", "clients", client, "config.json")
    cfg = json.load(open(path, encoding="utf-8"))
    sp = cfg.get("spreadsheet", {})
    if not sp.get("id"):
        raise ValueError(f"{path} に spreadsheet.id がありません")
    return sp["id"], sp.get("sheetName") or "Sheet1"


def verify_pending(client, job, current_path):
    """前回の入稿指示と今の掲載値を突き合わせ、残った未確認を警告する。

    Joblist は「現実」、入稿指示ログは「意図」。ここで初めて意図に裏が取れる。
    未確認が残るのは、事務員がまだ貼っていないか、AirWork のエクスポートが古いかのどちらか。
    どちらにせよ「この現在値には前回の指示が入っていない」ことを言わないと、
    次の原稿を古い現実の上に積むことになる。
    """
    try:
        import argparse as _ap
        import push_to_joblist as P
        P.do_verify(_ap.Namespace(client=client, job=job, current=current_path))
        sid, name = P.load_config(client)
        left = P.pending(P._service(sid), sid, name, job)
        if left:
            print(f"※ 前回の指示のうち {left} 件がまだ AirWork に反映されていません"
                  f"（'{name}' タブ）。この現在値にはその分が入っていません")
    except Exception as e:                    # noqa: BLE001 - 照合失敗で本体を落とさない
        print(f"※ 入稿指示ログの照合を飛ばしました: {e}", file=sys.stderr)


def _self_test():
    assert extract_key("雇用形態(job_type_jp)") == "job_type_jp"
    assert extract_key("仕事内容の特徴（勤務地）(job_features_work_location_id_name)") \
        == "job_features_work_location_id_name"
    assert extract_key("内部キーの無い列") is None

    header = ["求人番号(job_offer_id)", "雇用形態(job_type_jp)",
              "職場環境(workplace_id_name)", "備考", "求人メモ(job_offer_memo)"]
    cur = build_current(header, ["12204054", "派遣社員", "制服あり,30代が多い", "x",
                                 "◯◯運送2000/1500"])
    assert cur["job_type_jp"] == "派遣社員"
    assert "備考" not in cur and len(cur) == 4, cur      # 括弧の無い列は捨てる
    assert cur["job_offer_memo"] == REDACT["job_offer_memo"]
    assert "2000" not in json.dumps(cur, ensure_ascii=False), "単価が漏れている"

    # 行が短くても落ちない（末尾の空セルは Sheets が返さない）
    short = build_current(header, ["12204054", "派遣社員"])
    assert short["workplace_id_name"] == "" and short["job_offer_memo"] == ""

    # 現在値JSONを Drive 配下へ書けないこと。門番の中身は secure_tmp.py が試すので、
    # ここで見るのは「呼び忘れていないか」だけ。Sheets を読む前に止まることも兼ねて確かめる。
    import contextlib
    import io
    argv_backup, sys.argv = sys.argv, [
        "fetch_current.py", "--job", "12204054",
        "--output", "/etc/job-copy_must_not_be_written.json"]
    try:
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            main()
    except ValueError as e:
        assert "/tmp" in str(e), e
    else:
        raise AssertionError("--output に /tmp 外を渡しても止まらなかった")
    finally:
        sys.argv = argv_backup
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client", default="foot")
    p.add_argument("--job")
    p.add_argument("--output")
    p.add_argument("--no-verify", action="store_true",
                   help="入稿指示ログとの自動照合を止める（通常は使わない）")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    for name in ("job", "output"):
        if not getattr(a, name):
            p.error(f"--{name} は必須です")
    # 書き出す直前ではなく、Sheets を読む前に出力先を検査する。
    # 取得してから止めると、実データをメモリに載せてから断ることになる。
    require_tmp_path(a.output, "--output")

    sid, sheet = load_config(a.client)

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    sh = build("sheets", "v4", credentials=cred).spreadsheets()

    # 265列ぶん取りにいく。config の range は使わない（239列で切れている）。
    values = sh.values().get(spreadsheetId=sid,
                             range=f"{sheet}!A1:JZ").execute().get("values", [])
    if not values:
        print("NG: シートが空です", file=sys.stderr)
        sys.exit(1)

    header = values[0]
    hit = [r for r in values[1:] if r and str(r[0]).strip() == str(a.job).strip()]
    if not hit:
        print(f"NG: 求人番号 {a.job} が見つかりません。"
              f"新規案件なら apply_plan.py を --current 無しで実行してください",
              file=sys.stderr)
        sys.exit(1)
    if len(hit) > 1:
        print(f"NG: 求人番号 {a.job} が {len(hit)} 行あります。Joblist を確認してください",
              file=sys.stderr)
        sys.exit(1)

    cur = build_current(header, hit[0])
    filled = sum(1 for v in cur.values() if v)
    dump_tmp_json(a.output, cur)
    print(f"求人 {a.job}: 内部キー {len(cur)} 件 / うち値あり {filled} 件 -> {a.output}")

    # ここが「AirWork の現実」を見る唯一のタイミングなので、前回出した指示と突き合わせる。
    # 人が別コマンドを覚える運用にすると回らないので自動で走らせる。
    if not a.no_verify:
        verify_pending(a.client, a.job, a.output)

    print(f"次: python3 apply_plan.py --items ... --plan ... --current {a.output} "
          f"--output /tmp/items176_selected.json")


if __name__ == "__main__":
    main()
