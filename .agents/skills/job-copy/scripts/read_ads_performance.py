# -*- coding: utf-8 -*-
"""AirWork有料広告の実績（求人単位）を読み、求人ごとに「どの欄を直すか」を返す。

  python3 read_ads_performance.py --client foot \
      --spreadsheet 'https://docs.google.com/spreadsheets/d/xxx/edit' \
      --sheet sponsor_求人単位_FooT --output /tmp/ads_performance.json

AirWorkのエクスポートには求人番号が入っていない。入っているのは「求人内容」列で、
中身は 雇用形態｜職種名｜求人キャッチコピー の全角パイプ結合。
これは Joblist の job_type_jp / title / subtitle をそのまま繋いだものなので、
Joblist 側から同じ文字列を組み立てれば求人番号を引き当てられる。
（FooT様の掲載中69件で 一意に的中69 / 複数候補0 / 該当なし0 を確認済み）

企業名列は派遣元（例: 株式会社FooT）で固定になる。Joblist の出向先企業名は
掲載中の全件が空で、派遣先は勤務地でしか分からない。突き合わせに企業名は使わない。

★ 何が分かるか（ファネルのどこで落ちているか）
    クリック率      検索一覧に出るのは 雇用形態/職種名/キャッチ だけ → No.3 / No.33
    応募開始率      詳細を読んで応募ボタンを押したか              → No.7 / No.28
    応募完了率      フォームを最後まで埋めたか                    → 原稿の外（選考フロー等）
  雇用形態(No.1)は FROZEN なので、入口を直す手段は職種名とキャッチコピーの2つだけ。

判定は「掲載中の求人の中央値」を基準にした相対評価。業種も媒体も違う外部の平均値は使わない。

  python3 read_ads_performance.py --self-test
"""
import argparse
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# 実績JSONは求人本文と実数値。実データなので /tmp からしか出さない。
from client_config import extract_id, load_config  # noqa: E402
from secure_tmp import dump_tmp_json, require_tmp_path  # noqa: E402

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
KEY_RE = re.compile(r"\(([A-Za-z0-9_]+)\)\s*$")

# AirWorkの列見出し → このスクリプト内での呼び名。見出しはAirWorkの表記に合わせる。
ADS_COLUMNS = {
    "求人内容": "jobContent",
    "勤務地": "location",
    "企業名": "company",
    "初回掲載日時": "firstPosted",
    "最終更新日": "lastUpdated",
    "求人URL": "url",
    "表示数": "impressions",
    "クリック率": "ctr",
    "クリック数": "clicks",
    "応募開始率": "startRate",
    "応募開始数": "starts",
    "応募完了率": "finishRate",
    "応募数": "applies",
    "応募率": "applyRate",
    "クリック単価": "cpc",
    "応募開始単価": "cpStart",
    "応募単価": "cpApply",
    "利用済予算": "cost",
}
REQUIRED_COLUMNS = ("jobContent", "impressions", "clicks", "starts", "applies")

# 判定のしきい値。会社ごとに変えられるよう config.json 側で上書きできる。
DEFAULT_THRESHOLDS = {
    # 母数が無い求人を「弱い」と判定すると、掲載したばかりの求人を毎回書き直すことになる。
    "minImpressions": 1000,
    "minClicks": 30,
    # 中央値の何倍を下回ったら弱いと見なすか。
    "weakRatio": 0.7,
    # 応募完了率だけは原稿の外の話なので、はっきり低いときだけ拾う。
    "finishWeakRatio": 0.6,
}

# 診断コード → (表示名, 直す欄, 直す欄の名前)
DIAGNOSIS = {
    "INSUFFICIENT_DATA": ("母数不足・判定しない", [], "もう少し配信してから見る"),
    "OUTSIDE_COPY": ("原稿の外", [], "選考フロー・応募フォーム側（No.155ほか）"),
    "ENTRY_WEAK": ("入口が弱い", ["3", "33"], "職種名・求人キャッチコピー"),
    "BODY_WEAK": ("中身が弱い", ["7", "28"], "仕事内容・求める人材"),
    "BOTH_WEAK": ("全面リライト", ["3", "33", "7", "28"],
                  "職種名・キャッチ・仕事内容・求める人材"),
    "HEALTHY": ("手をつけない", [], "現状維持"),
}


def to_num(value):
    """'4.3%' でも '193円' でも 0.043 でも数値で返す。読めなければ None。

    UNFORMATTED_VALUE で取れば数値だが、CSVを貼り直した表では文字列になる。
    どちらで来ても同じ結果にする。
    """
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(",", "").replace("円", "").replace("¥", "")
    percent = s.endswith("%")
    if percent:
        s = s[:-1]
    try:
        n = float(s)
    except ValueError:
        return None
    return n / 100 if percent else n


def find_header(rows):
    """見出し行の位置を返す。装飾ありの表（見出し2行＋空行）でも当たるように探す。"""
    for i, row in enumerate(rows[:15]):
        cells = {str(c).strip() for c in row}
        if "求人内容" in cells and "表示数" in cells:
            return i
    return None


def column_index(header):
    """見出し行 → {呼び名: 列番号}。知らない列は無視する。"""
    out = {}
    for i, cell in enumerate(header):
        name = ADS_COLUMNS.get(str(cell).strip())
        if name and name not in out:
            out[name] = i
    return out


def normalize(text):
    """突き合わせ用に空白の揺れだけ吸収する。表記そのものは変えない。"""
    return re.sub(r"\s+", " ", str(text or "")).strip()


def join_key(job_type, title, subtitle):
    """AirWorkの「求人内容」と同じ形に組み立てる。"""
    return "｜".join(normalize(x) for x in (job_type, title, subtitle))


def split_job_content(text):
    """「派遣社員｜目視検査｜未経験OK」→ 3つに割る。区切りは全角/半角どちらも許す。"""
    parts = [normalize(p) for p in re.split(r"[｜|]", str(text or ""))]
    while len(parts) < 3:
        parts.append("")
    # キャッチコピー自体にパイプが入っていたら、後ろは繋ぎ直す。
    return parts[0], parts[1], "｜".join(parts[2:])


def extract_internal_key(header_cell):
    """Joblistの「雇用形態(job_type_jp)」→ job_type_jp。"""
    m = KEY_RE.search(str(header_cell or "").strip())
    return m.group(1) if m else None


def build_joblist_index(values, published_values):
    """Joblist → {突き合わせキー: [求人番号, ...]}。掲載中だけを対象にする。

    掲載を止めた求人まで入れると、同じキャッチを使い回した過去求人に当たって
    「複数候補」になる。実績が出ているのは掲載中の求人だけなので絞る。
    """
    if not values:
        return {}, 0
    header = values[0]
    idx = {}
    for i, cell in enumerate(header):
        key = extract_internal_key(cell)
        if key and key not in idx:
            idx[key] = i

    def cell(row, key):
        i = idx.get(key)
        return str(row[i]).strip() if i is not None and len(row) > i else ""

    book = {}
    live = 0
    for row in values[1:]:
        if not row or not str(row[0]).strip():
            continue
        status = str(row[2]).strip() if len(row) > 2 else ""
        if published_values and status not in published_values:
            continue
        live += 1
        key = join_key(cell(row, "job_type_jp"), cell(row, "title"), cell(row, "subtitle"))
        book.setdefault(key, []).append(str(row[0]).strip())
    return book, live


def parse_rows(rows):
    """実績シート → レコードのリスト。数値が読めない行は落とす。"""
    head = find_header(rows)
    if head is None:
        raise SystemExit("NG: 「求人内容」と「表示数」を含む見出し行が見つかりません。"
                         "求人単位のタブを --sheet で指定してください")
    cols = column_index(rows[head])
    missing = [k for k in REQUIRED_COLUMNS if k not in cols]
    if missing:
        raise SystemExit(f"NG: 必要な列がありません: {missing}（見出し行={head + 1}行目）")

    out = []
    for row in rows[head + 1:]:
        if not row:
            continue
        content = normalize(row[cols["jobContent"]]) if len(row) > cols["jobContent"] else ""
        if not content:
            continue
        rec = {"jobContent": content}
        for name, i in cols.items():
            if name == "jobContent":
                continue
            rec[name] = row[i] if len(row) > i else ""
        for name in ("impressions", "clicks", "starts", "applies", "cost"):
            rec[name] = to_num(rec.get(name)) or 0
        # 率は元の列を使わず、実数から引き直す。表示桁で丸めた率で判定すると
        # 母数の小さい求人ほど誤差が乗る。
        rec["ctr"] = rec["clicks"] / rec["impressions"] if rec["impressions"] else 0.0
        rec["startRate"] = rec["starts"] / rec["clicks"] if rec["clicks"] else 0.0
        rec["finishRate"] = rec["applies"] / rec["starts"] if rec["starts"] else 0.0
        rec["applyRate"] = rec["applies"] / rec["clicks"] if rec["clicks"] else 0.0
        out.append(rec)
    return out


def has_enough_data(rec, th):
    return (rec["impressions"] >= th["minImpressions"]
            and rec["clicks"] >= th["minClicks"])


def baseline(records, th):
    """母数のある求人だけで中央値を出す。ここが全判定の基準になる。"""
    live = [r for r in records if has_enough_data(r, th)]
    if not live:
        return None
    return {
        "ctr": statistics.median(r["ctr"] for r in live),
        "startRate": statistics.median(r["startRate"] for r in live),
        "finishRate": statistics.median(r["finishRate"] for r in live),
        "sampleSize": len(live),
    }


def diagnose(rec, base, th):
    """1求人の判定コードを返す。基準が作れないときは全件「判定しない」。"""
    if base is None or not has_enough_data(rec, th):
        return "INSUFFICIENT_DATA"
    weak_entry = rec["ctr"] < base["ctr"] * th["weakRatio"]
    weak_body = rec["startRate"] < base["startRate"] * th["weakRatio"]
    weak_finish = rec["finishRate"] < base["finishRate"] * th["finishWeakRatio"]
    if weak_entry and weak_body:
        return "BOTH_WEAK"
    if weak_entry:
        return "ENTRY_WEAK"
    if weak_body:
        return "BODY_WEAK"
    if weak_finish:
        return "OUTSIDE_COPY"
    return "HEALTHY"


def gain_estimate(rec, base, th):
    """中央値まで戻したとき応募が何件増えるか。優先順位はこれで並べる。

    「率がいちばん低い求人」から直すと、表示数の少ない求人ばかり並んで
    手間の割に応募が増えない。増える件数で並べ替える。
    """
    if base is None or not has_enough_data(rec, th):
        return 0.0
    ideal = rec["impressions"] * base["ctr"] * base["startRate"] * base["finishRate"]
    return max(0.0, ideal - rec["applies"])


def winners(records, base, th, limit=5):
    """クリック率が高い求人の入口の文言。A〜E案を作るときの素材にする。

    「勝っている求人の書き方」は同じ会社・同じ媒体の中にしかない。
    外部の一般論より、隣の求人が実際に取れている言い回しの方が当たる。
    """
    live = [r for r in records if has_enough_data(r, th)]
    if not live or base is None:
        return []
    live.sort(key=lambda r: -r["ctr"])
    out = []
    for rec in live[:limit]:
        _, title, subtitle = split_job_content(rec["jobContent"])
        out.append({
            "jobNumber": rec.get("jobNumber"),
            "title": title,
            "subtitle": subtitle,
            "ctr": round(rec["ctr"], 4),
            "ctrVsMedian": round(rec["ctr"] / base["ctr"], 2) if base["ctr"] else None,
        })
    return out


def build_report(ads_rows, joblist_values, cfg):
    th = dict(DEFAULT_THRESHOLDS)
    th.update((cfg.get("adsPerformance") or {}).get("thresholds") or {})
    published = set(cfg.get("publishedStatusValues") or [])

    records = parse_rows(ads_rows)
    book, live_count = build_joblist_index(joblist_values, published)

    matched = ambiguous = 0
    for rec in records:
        hits = book.get(rec["jobContent"], [])
        if len(hits) == 1:
            rec["jobNumber"] = hits[0]
            rec["match"] = "OK"
            matched += 1
        elif len(hits) > 1:
            rec["jobNumber"] = None
            rec["match"] = "AMBIGUOUS"
            rec["candidates"] = hits
            ambiguous += 1
        else:
            rec["jobNumber"] = None
            rec["match"] = "NOT_FOUND"

    base = baseline(records, th)
    for rec in records:
        code = diagnose(rec, base, th)
        label, fields, target = DIAGNOSIS[code]
        rec["diagnosis"] = code
        rec["diagnosisLabel"] = label
        rec["focusFields"] = fields
        rec["focusFieldNames"] = target
        rec["gainEstimate"] = round(gain_estimate(rec, base, th), 1)

    ranked = sorted(records, key=lambda r: -r["gainEstimate"])
    for i, rec in enumerate(ranked, 1):
        rec["priority"] = i if rec["gainEstimate"] > 0 else None

    jobs = {r["jobNumber"]: r for r in records if r.get("jobNumber")}
    return {
        "baseline": base,
        "thresholds": th,
        "match": {
            "adsRows": len(records),
            "joblistPublished": live_count,
            "matched": matched,
            "ambiguous": ambiguous,
            "notFound": len(records) - matched - ambiguous,
        },
        "jobs": jobs,
        "records": ranked,
        "winners": winners(records, base, th),
    }


def print_summary(report, top=10):
    m = report["match"]
    base = report["baseline"]
    print(f"実績 {m['adsRows']}件 / Joblist掲載中 {m['joblistPublished']}件 → "
          f"引き当て {m['matched']}件・複数候補 {m['ambiguous']}件・該当なし {m['notFound']}件")
    if not base:
        print("※ 母数のある求人が無いため判定できません（配信量が足りない）")
        return
    print(f"基準（掲載中の中央値・n={base['sampleSize']}）"
          f" クリック率 {base['ctr'] * 100:.1f}%"
          f" / 応募開始率 {base['startRate'] * 100:.1f}%"
          f" / 応募完了率 {base['finishRate'] * 100:.1f}%")

    counts = {}
    for rec in report["records"]:
        counts[rec["diagnosisLabel"]] = counts.get(rec["diagnosisLabel"], 0) + 1
    print("内訳: " + " / ".join(f"{k} {v}件" for k, v in counts.items()))

    print(f"\n直す優先順位（上位{top}件・中央値まで戻した場合に増える応募数）")
    for rec in report["records"][:top]:
        if not rec["gainEstimate"]:
            break
        job = rec.get("jobNumber") or f"（未引当:{rec['jobContent'][:20]}…）"
        print(f"  +{rec['gainEstimate']:5.1f}件  求人{job:<10} {rec['diagnosisLabel']:<12}"
              f" 直す欄={rec['focusFieldNames']}"
              f"  表示{int(rec['impressions']):,} 応募{int(rec['applies'])}件")

    if report["winners"]:
        print("\nクリック率が高い求人の入口（A〜E案の素材）")
        for w in report["winners"]:
            print(f"  中央値の{w['ctrVsMedian']}倍  {w['title']}｜{w['subtitle']}")


def _self_test():
    assert to_num("4.3%") == 0.043
    assert to_num("193円") == 193.0
    assert to_num("1,234") == 1234.0
    assert to_num(0.043) == 0.043
    assert to_num("") is None and to_num(None) is None and to_num("あ") is None

    assert join_key("派遣社員", " 目視検査 ", "未経験OK") == "派遣社員｜目視検査｜未経験OK"
    assert split_job_content("派遣社員｜目視検査｜未経験OK") == ("派遣社員", "目視検査", "未経験OK")
    assert split_job_content("派遣社員|検査|A|B") == ("派遣社員", "検査", "A｜B")
    assert split_job_content("派遣社員") == ("派遣社員", "", "")
    assert extract_internal_key("雇用形態(job_type_jp)") == "job_type_jp"
    assert extract_internal_key("備考") is None

    head = ["求人内容", "表示数", "クリック率", "クリック数", "応募開始率", "応募開始数",
            "応募完了率", "応募数", "利用済予算"]
    # 装飾ありの表（見出し2行＋空行のあとにヘッダー）でも見つけられること
    decorated = [["Foot様用"], ["集計期間"], [], head]
    assert find_header(decorated) == 3
    assert find_header([["関係ない"], ["列"]]) is None
    assert column_index(head)["applies"] == 7

    def row(content, imp, clk, sta, app):
        return [content, imp, "", clk, "", sta, "", app, clk * 200]

    # 健全12件を並べて中央値を作り、そこへ弱点を1件ずつ混ぜる。
    ads = [head]
    for i in range(12):
        ads.append(row(f"派遣社員｜検査{i}｜未経験OK", 10000, 500, 125, 75))
    ads.append(row("派遣社員｜入口弱｜キャッチ", 10000, 150, 37, 22))    # CTR 1.5%
    ads.append(row("派遣社員｜中身弱｜キャッチ", 10000, 500, 40, 24))    # 開始率 8%
    ads.append(row("派遣社員｜両方弱｜キャッチ", 10000, 150, 12, 7))
    ads.append(row("派遣社員｜完了弱｜キャッチ", 10000, 500, 125, 20))   # 完了率 16%
    ads.append(row("派遣社員｜母数無｜キャッチ", 200, 8, 2, 1))

    joblist = [["求人番号(job_offer_id)", "承認(approval_status)", "掲載(publish_status)",
                "雇用形態(job_type_jp)", "職種名(title)", "キャッチ(subtitle)"]]
    for i in range(12):
        joblist.append([f"90{i:02d}", "", "02", "派遣社員", f"検査{i}", "未経験OK"])
    for n, t in (("9101", "入口弱"), ("9102", "中身弱"), ("9103", "両方弱"),
                 ("9104", "完了弱"), ("9105", "母数無")):
        joblist.append([n, "", "02", "派遣社員", t, "キャッチ"])
    # 掲載を止めた求人が同じキャッチを持っていても、複数候補にしない
    joblist.append(["9999", "", "09", "派遣社員", "入口弱", "キャッチ"])

    rep = build_report(ads, joblist, {"publishedStatusValues": ["02"]})
    assert rep["match"] == {"adsRows": 17, "joblistPublished": 17,
                            "matched": 17, "ambiguous": 0, "notFound": 0}, rep["match"]
    got = {n: rep["jobs"][n]["diagnosis"] for n in
           ("9101", "9102", "9103", "9104", "9105", "9000")}
    assert got == {"9101": "ENTRY_WEAK", "9102": "BODY_WEAK", "9103": "BOTH_WEAK",
                   "9104": "OUTSIDE_COPY", "9105": "INSUFFICIENT_DATA",
                   "9000": "HEALTHY"}, got
    assert rep["jobs"]["9101"]["focusFields"] == ["3", "33"]
    assert rep["jobs"]["9102"]["focusFields"] == ["7", "28"]
    assert rep["jobs"]["9103"]["focusFields"] == ["3", "33", "7", "28"]
    assert rep["jobs"]["9104"]["focusFields"] == []
    # 母数不足は直す対象に出さない（掲載したてを毎回書き直させない）
    assert rep["jobs"]["9105"]["gainEstimate"] == 0.0
    assert rep["jobs"]["9105"]["priority"] is None
    # 表示数が同じなら、落ち幅の大きい求人が上に来る
    assert rep["jobs"]["9103"]["gainEstimate"] > rep["jobs"]["9101"]["gainEstimate"]
    assert rep["records"][0]["jobNumber"] == "9103"
    assert rep["baseline"]["sampleSize"] == 16

    # 実績側に無い求人・Joblist側に無い求人
    rep2 = build_report([head, row("派遣社員｜知らない｜求人", 10000, 500, 125, 75)],
                        joblist, {"publishedStatusValues": ["02"]})
    assert rep2["match"]["notFound"] == 1 and rep2["jobs"] == {}

    # しきい値を config で上げれば、母数不足の線も動く
    rep3 = build_report(ads, joblist, {
        "publishedStatusValues": ["02"],
        "adsPerformance": {"thresholds": {"minClicks": 200}}})
    assert rep3["jobs"]["9101"]["diagnosis"] == "INSUFFICIENT_DATA"

    # 出力先が /tmp 外なら、Sheets を読む前に止まること
    import contextlib
    import io
    argv_backup, sys.argv = sys.argv, [
        "read_ads_performance.py", "--spreadsheet", "1" * 30,
        "--sheet", "x", "--output", "/etc/job-copy_must_not_be_written.json"]
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
    p.add_argument("--spreadsheet", help="広告実績のスプレッドシート（URLでもIDでも可）")
    p.add_argument("--sheet", help="求人単位のタブ名")
    p.add_argument("--output", help="出力先（/tmp配下のみ）")
    p.add_argument("--top", type=int, default=10, help="優先順位の表示件数")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    if not a.output:
        p.error("--output は必須です")
    require_tmp_path(a.output, "--output")

    cfg = load_config(a.client)
    ads_cfg = (cfg.get("adsPerformance") or {}).get("spreadsheet") or {}
    ads_id = extract_id(a.spreadsheet) or ads_cfg.get("id")
    ads_sheet = a.sheet or ads_cfg.get("sheetName")
    if not ads_id or not ads_sheet:
        p.error("広告実績の場所が分かりません。--spreadsheet と --sheet を渡すか、"
                f"{a.client}/config.json の adsPerformance.spreadsheet に書いてください")

    joblist = cfg.get("spreadsheet") or {}
    if not joblist.get("id"):
        raise SystemExit(f"{a.client}/config.json に spreadsheet.id がありません")

    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    sh = build("sheets", "v4", credentials=cred).spreadsheets()

    def read(sid, rng):
        return sh.values().get(spreadsheetId=sid, range=rng,
                               valueRenderOption="UNFORMATTED_VALUE"
                               ).execute().get("values", [])

    ads_rows = read(ads_id, f"'{ads_sheet}'!A1:Z")
    if not ads_rows:
        raise SystemExit(f"NG: '{ads_sheet}' が空です")
    # config の range は239列で切ってあるが、突き合わせに要るのは先頭の数列だけ。
    joblist_rows = read(joblist["id"], f"{joblist.get('sheetName') or 'Sheet1'}!A1:CE")

    report = build_report(ads_rows, joblist_rows, cfg)
    dump_tmp_json(a.output, report)
    print_summary(report, a.top)
    print(f"\n-> {a.output}")
    print("次: 直す求人を1つ選び、依頼フォーマットで生成に進む"
          "（focusFields の欄を重点的に振る）")


if __name__ == "__main__":
    main()
