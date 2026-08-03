# -*- coding: utf-8 -*-
"""選ばれた訴求案を176項目マスタの「事務員転記」列へ差し替える。

読み手は原稿を書いた人ではなく事務員である。**判断させない。**
そのため「事務員転記」列には、値そのものか、次のどれかの指示だけを置く。
空セルを残すと「入力しないのか、消すのか、まだ書いていないのか」が読み手に判別できない。

  値そのもの        … AirWork の同じ項目へそのまま貼る
  【削除】…         … 今入っている値を消す（今回の書き換えで外した項目）
  【要確認】…       … 裏が取れていないので、残すか消すかを人が決める
  （入力なし）      … 今も空で、今回も入れない
  （社内管理用。触らない） … 求人メモ。単価が入るので値を出さない

**書き換えていない項目にも、いま掲載されている値をそのまま書く。**
「（変更なし）」とだけ書くと、事務員は AirWork の画面を開いて
「今なんと入っているか」を自分で確かめることになる。それは判断であり、確認作業である。
ドキュメントだけ見て上から順に貼れる状態にする（2026-08-02 変更）。

★ plan の値は4種類ある（2026-08-03 変更）
  "文章"        … この値を貼る
  ""            … **書けなかった**（情報が足りず今回は書けない）→ 現在値をそのまま残す
  "__DELETE__"  … 意図して消す → 【削除】…
  "__REVIEW__"  … 裏が取れないので人に判断させる → 【要確認】…

以前は "" を「削除」として扱っていた。だが原稿を書く側から見ると、
「書けなかった」と「消したい」はまったく別の意味である。
2026-08-03 の甲山機工のテストでは、ヒアリング20問中17問が「不明」で返り、
書けなかった4欄が全部【削除】になった。掲載中の「土日休み・連休あり・身体の負担少なめ」
「月収50万円以上可」「給与上限3000円」が消える指示になり、**求人が痩せた。**
情報が足りないときに既存の掲載内容を消すのは、リライトではなく破壊である。
書けないなら手を触れない。消すなら消すと明示させる。

入力:
  --items   176項目JSON  [["No.","項目名","内部キー","事務員転記"], ...]
  --plan    採用案JSON   {"3": "職種名の新しい値", "7": "仕事内容の新しい値", ...}
            キーは176項目版のNo.（★265列Joblist版のNo.とは採番が別）
  --current 現在の掲載値JSON（任意）{"内部キー": "いま入っている値", ...}
            fetch_current.py --client foot --job 案件番号 --output で作る。
            **既存求人の修正では必須。** 無いと書き換えていない項目が全部
            （入力なし）になり、事務員が既存の掲載内容を消してしまう。
            新規入稿では渡すものが無いので省略する。
出力:
  --output  差し替え後の176項目JSON
  同じ場所に `<output>.meta.json` も書く。**どのNo.を書き換えたか**だけの小さなファイルで、
  make_entry_doc.py がこれを拾って入稿指示ログへ自動記録する（push_to_joblist.py）。
  出来上がった176項目JSONだけを見ても「元から入っていた値」と「今回変えた値」は区別できないので、
  ここで分けておかないと後段が判定できない。

設計上の約束:
  - No.列は文字列で照合する。int で比較すると全項目スキップされて静かに失敗する。
  - plan にあって items に無いNo.があれば異常終了する（取りこぼしを黙って通さない）。
  - 事実条件（雇用形態・勤務地・給与形態・試用期間の条件）は FROZEN として拒否する。
    差し替えてよいのは表現層（職種名・キャッチ・仕事内容・求める人材・補足説明）とタグ層。

  python3 apply_plan.py --self-test
"""
import argparse
import json
import os
import sys
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from secure_tmp import dump_tmp_json, load_tmp_json  # noqa: E402

HEADER = ["No.", "項目名", "内部キー", "事務員転記"]

NO_INPUT = "（入力なし）"
DELETE_PREFIX = "【削除】"
REVIEW_PREFIX = "【要確認】"
# plan の値に置くセンチネル。原稿本文としてこの文字列を書くことはない
DELETE = "__DELETE__"
REVIEW = "__REVIEW__"
SENTINELS = {DELETE, REVIEW}
# AirWork の CSV が空欄に使う記号。値として扱わない。
BLANKS = {"", "—", "-", "―", "ー", "－"}
# 事務員への指示であって、AirWork に貼る値ではない文字列
MARKERS = {NO_INPUT}

# 原稿づくりで触ってはいけない項目（176項目版のNo.）。
# 契約と法令で決まる条件であり、訴求のために書き換える対象ではない。
# ここに入れていない No.34（採用予定人数）と No.39/40（給与額）は
# 依頼フォーマットで指定される値なので、書き換えの可否ではなく
# 「依頼と一致しているか」を precheck_doc.py が見る。
FROZEN = {
    "1",                                    # 雇用形態
    "15", "16", "17", "18", "19",           # 勤務地（種別・名称・郵便番号・都道府県・市区町村）
    "35",                                   # 給与形態
    "38",                                   # 給与額範囲
    "68",                                   # 勤務時間の記載方法
    "102", "103", "106", "107", "108",      # 試用・研修期間の給与条件
    "130", "134",                           # 試用・研修期間の勤務時間条件
}


def is_blank(v):
    return str(v).strip() in BLANKS


def apply_plan(rows, plan):
    """rows を破壊的に更新し、(書き換えたNo., 見つからなかったNo., 書けなかったNo.) を返す。

    戻り値の1つ目（changed）は入稿指示ログに載る「今回こう変えた」の集合である。
    plan に "" を置いた項目はここに入らない。書けなかったものは変更ではない。
    """
    if not rows or rows[0] != HEADER:
        raise ValueError(f"1行目がヘッダ {HEADER} ではありません: {rows[0] if rows else '空'}")

    plan = {str(k): v for k, v in plan.items()}
    frozen = sorted(FROZEN & set(plan), key=lambda x: int(x))
    if frozen:
        raise ValueError(
            "契約で決まっている項目は原稿づくりで書き換えられません: "
            f"No.{', No.'.join(frozen)}（雇用形態・勤務地・給与形態・試用期間の条件）")

    hit, skipped = set(), set()
    for r in rows[1:]:
        no = str(r[0])
        if no not in plan:
            continue
        while len(r) < 4:
            r.append("")
        val = plan[no]
        if isinstance(val, str) and val in SENTINELS:
            r[3] = val
            # 削除は意図した変更なのでログに残す。要確認は人の判断待ちなので残さない
            (hit if val == DELETE else skipped).add(no)
        elif is_blank(val):
            # 書けなかった。セルは空のままにして、fill_blanks に現在値を戻させる
            skipped.add(no)
        else:
            r[3] = val
            hit.add(no)
    return hit, set(plan) - hit - skipped, skipped


def fill_blanks(rows, current=None, changed=None):
    """空セルとセンチネルを、事務員向けの指示に置き換える。

    current（内部キー→現在の掲載値）を渡すと、同じ「空」でも
    「今の値を消す」と「もともと何も無い」を書き分けられる。
    ここを一緒くたにすると、事務員が消してはいけない値を消す。

    書き換えていない項目には、いま掲載されている値をそのまま入れる。
    以前は「（変更なし）」と書いていたが、それだと事務員が AirWork の画面で
    今の値を確かめる必要があり、ドキュメント1枚では作業が終わらなかった。
    多少ドキュメントが長くなっても、上から順に貼れることを優先する。
    """
    current = current or {}
    stat = {"value": 0, "delete": 0, "review": 0, "no_input": 0}
    for r in rows[1:]:
        while len(r) < 4:
            r.append("")
        key, val = r[2], str(r[3]).strip()
        now = " ".join(str(current.get(key, "")).split())

        if val == DELETE:
            if is_blank(now):
                # 消す対象が無い。指示を出すほうがまぎらわしい
                r[3] = NO_INPUT
                stat["no_input"] += 1
            else:
                r[3] = f"{DELETE_PREFIX}今の「{now[:40]}」を消して空欄にする"
                stat["delete"] += 1
        elif val == REVIEW:
            if is_blank(now):
                r[3] = NO_INPUT
                stat["no_input"] += 1
            else:
                r[3] = (f"{REVIEW_PREFIX}今の「{now[:40]}」は裏が取れていません。"
                        "残すか消すかを決めてください")
                stat["review"] += 1
        elif not is_blank(val):
            stat["value"] += 1
        elif not is_blank(now):
            # 書けなかった項目も、触っていない項目も、現在値をそのまま出す。
            # 情報が足りないことを理由に掲載中の値を消さない
            r[3] = now
            stat["value"] += 1
        else:
            r[3] = NO_INPUT
            stat["no_input"] += 1
    return stat


def _self_test():
    rows = [HEADER, ["1", "雇用形態", "job_type_jp", "派遣社員"],
            ["3", "職種名", "title", "旧タイトル"],
            ["23", "職場環境", "tags", "30代が多い,制服あり"]]
    hit, missing, skipped = apply_plan(rows, {3: "新タイトル", "23": "制服あり"})
    assert not missing and not skipped, (missing, skipped)
    assert hit == {"3", "23"}, hit
    assert rows[2][3] == "新タイトル"
    assert rows[3][3] == "制服あり", "根拠のない年齢タグが残っている"
    assert rows[1][3] == "派遣社員", "planに無い項目を書き換えてはいけない"

    # int キーでも文字列に正規化されること
    rows2 = [HEADER, ["7", "仕事内容", "description", "旧"]]
    hit2, _, _ = apply_plan(rows2, {7: "新"})
    assert hit2 == {"7"} and rows2[1][3] == "新"

    # 存在しないNo.は missing に出る
    _, missing3, _ = apply_plan([HEADER, ["1", "a", "b", "c"]], {"999": "x"})
    assert missing3 == {"999"}, missing3

    # 契約で決まっている項目は受け付けない。No.40（給与上限）は依頼値なので通す
    for ng in ("1", "16", "35", "68", "107"):
        try:
            apply_plan([HEADER, [ng, "x", "k", ""]], {ng: "改ざん"})
        except ValueError as e:
            assert "書き換えられません" in str(e)
        else:
            raise AssertionError(f"No.{ng} が通ってしまった")
    apply_plan([HEADER, ["40", "給与額上限", "maximum_salary", ""]], {"40": "3000"})

    # ★ plan の値4種。「書けなかった」で既存の掲載内容が消えないこと
    rows4 = [HEADER,
             ["3", "職種名", "title", ""],                     # 書き換えた
             ["24", "職場環境", "work_environment", ""],       # 書けなかった（""）
             ["64", "給与例", "salary_example", ""],           # 意図して消す
             ["90", "休日", "holiday", ""],                    # 裏が取れない
             ["21", "喫煙所", "smoking", "—"],                 # 触っていない
             ["36", "業務単位名", "units_per_job", ""]]        # もともと空
    cur = {"title": "旧タイトル", "work_environment": "土日休み・連休あり",
           "salary_example": "月収50万円以上可", "holiday": "土日休み",
           "smoking": "喫煙所あり（屋内）"}
    hit4, missing4, skipped4 = apply_plan(
        rows4, {"3": "新タイトル", "24": "", "64": DELETE, "90": REVIEW})
    assert not missing4
    assert hit4 == {"3", "64"}, hit4
    assert skipped4 == {"24", "90"}, "書けなかった項目を変更として記録してはいけない"

    stat = fill_blanks(rows4, cur)
    assert rows4[1][3] == "新タイトル"
    # ここが 2026-08-03 の修正点。書けなかった欄の現在値が残る
    assert rows4[2][3] == "土日休み・連休あり", rows4[2][3]
    assert rows4[3][3].startswith(DELETE_PREFIX) and "月収50万" in rows4[3][3], rows4[3][3]
    assert rows4[4][3].startswith(REVIEW_PREFIX) and "土日休み" in rows4[4][3], rows4[4][3]
    # 触っていない項目も「（変更なし）」ではなく現在値を書く。事務員に調べさせない
    assert rows4[5][3] == "喫煙所あり（屋内）", rows4[5][3]
    assert rows4[6][3] == NO_INPUT, rows4[6][3]
    assert stat == {"value": 3, "delete": 1, "review": 1, "no_input": 1}, stat
    assert not any(is_blank(r[3]) for r in rows4[1:]), "空セルが残っている"
    assert not any(r[3] == "（変更なし）" for r in rows4[1:]), "「（変更なし）」が残っている"
    assert not any(str(r[3]) in SENTINELS for r in rows4[1:]), "センチネルが表に出ている"

    # 消す対象がそもそも無いときは、削除指示を出さない
    rows5 = [HEADER, ["64", "給与例", "salary_example", ""]]
    apply_plan(rows5, {"64": DELETE})
    s5 = fill_blanks(rows5, {})
    assert rows5[1][3] == NO_INPUT and s5["delete"] == 0, rows5[1][3]

    # 求人メモは fetch_current.py が伏せ字にして返す。そのまま書いても単価は出ない
    rows6 = [HEADER, ["176", "求人メモ", "job_offer_memo", ""]]
    fill_blanks(rows6, {"job_offer_memo": "（社内管理用。触らない）"})
    assert rows6[1][3] == "（社内管理用。触らない）", rows6[1][3]

    # --current が無ければ全部「入力なし」。ここで現在値をでっち上げない
    rows7 = [HEADER, ["21", "喫煙所", "smoking", ""]]
    assert fill_blanks(rows7) == {"value": 0, "delete": 0, "review": 0, "no_input": 1}
    assert rows7[1][3] == NO_INPUT

    # 原稿と掲載中の実データを Drive 配下に出し入れさせない。
    # 門番の中身は secure_tmp.py が試す。ここで見るのは「呼び忘れていないか」。
    import contextlib
    import io
    import tempfile
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        ok_items = os.path.join(d, "items.json")
        json.dump([HEADER, ["3", "職種名", "title", ""]],
                  open(ok_items, "w", encoding="utf-8"))
        ok_plan = os.path.join(d, "plan.json")
        json.dump({"3": "リフトで出荷作業"}, open(ok_plan, "w", encoding="utf-8"))
        ok_out = os.path.join(d, "out.json")
        # /tmp の外だと確実に言い切れる場所にする。スクリプトの置き場所から組み立てると、
        # レビュー用に /tmp へコピーしただけでこのテストが落ちる。
        drive = "/etc/job-copy_must_not_exist.json"

        for name, argv in (
            ("--plan", ["--items", ok_items, "--plan", drive, "--output", ok_out]),
            ("--current", ["--items", ok_items, "--plan", ok_plan, "--output", ok_out,
                           "--current", drive]),
            ("--output", ["--items", ok_items, "--plan", ok_plan, "--output", drive]),
        ):
            argv_backup, sys.argv = sys.argv, ["apply_plan.py"] + argv
            try:
                # 止まったときのNGメッセージは想定どおりなので self-test には出さない
                with contextlib.redirect_stderr(io.StringIO()):
                    main()
            except SystemExit as e:
                assert e.code == 1, (name, e.code)
            else:
                raise AssertionError(f"{name} に Drive 配下を渡しても止まらなかった")
            finally:
                sys.argv = argv_backup
            assert not os.path.exists(drive), f"{name} で Drive 配下に書いてしまった"
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--items")
    p.add_argument("--plan")
    p.add_argument("--output")
    p.add_argument("--current", help="内部キー→現在の掲載値のJSON。省略すると全部（入力なし）になる")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return

    for name in ("items", "plan", "output"):
        if not getattr(a, name):
            p.error(f"--{name} は必須です")

    # --items は値の入っていない176項目マスタ（スキル同梱）なので Drive 配下でよい。
    # plan と current は書き上げた原稿と掲載中の実データ。ここは /tmp の外に出さない。
    try:
        rows = json.load(open(a.items, encoding="utf-8"))
        plan = load_tmp_json(a.plan, "--plan")
        current = load_tmp_json(a.current, "--current") if a.current else {}
    except ValueError as e:
        print(f"NG: {e}", file=sys.stderr)
        sys.exit(1)
    if not current:
        print("注意: --current が無いので、書き換えていない項目が全部「（入力なし）」になります。"
              "既存求人の修正では必ず渡してください（事務員が今の掲載内容を消します）。",
              file=sys.stderr)

    try:
        hit, missing, skipped = apply_plan(rows, plan)
    except ValueError as e:
        print(f"NG: {e}", file=sys.stderr)
        sys.exit(1)
    if missing:
        print(f"NG: planのNo.が176項目マスタに見つかりません: {sorted(missing)}", file=sys.stderr)
        sys.exit(1)

    stat = fill_blanks(rows, current)
    # 書き上がった rows は派遣先の原稿そのもの。/tmp 配下に 0600 でしか置かない。
    try:
        dump_tmp_json(a.output, rows)
        # 書き換えたNo.を別ファイルに残す。176項目JSONを見ても今回変えた分は判別できない
        meta_path = a.output + ".meta.json"
        dump_tmp_json(meta_path, {"changed": sorted(hit, key=lambda x: int(x)),
                                  "skipped": sorted(skipped, key=lambda x: int(x)),
                                  "generated_at": datetime.now().isoformat(timespec="seconds")})
    except ValueError as e:
        print(f"NG: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"差し替え {len(hit)} 項目 -> {a.output}")
    print(f"  書き換えたNo. -> {meta_path}")
    print(f"  貼る値 {stat['value']} / 削除 {stat['delete']} / "
          f"要確認 {stat['review']} / 入力なし {stat['no_input']}")
    for r in rows[1:]:
        if str(r[0]) in hit:
            v = str(r[3])
            mark = "  ※削除" if v.startswith(DELETE_PREFIX) else ""
            print(f"  No.{r[0]:>3} {r[1]}  ({len(v)}文字){mark}")
    if skipped:
        print(f"  書けなかった（現在値を残した）No.: {sorted(skipped, key=lambda x: int(x))}")


if __name__ == "__main__":
    main()
