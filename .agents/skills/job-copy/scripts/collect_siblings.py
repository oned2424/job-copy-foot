# -*- coding: utf-8 -*-
"""同じ派遣先の他求人（＝兄弟求人）から、原稿に使える事実を集める。

**人に聞く前にここを通す。**

2026-08-03 の甲山機工のテストで、ヒアリング20問のうち17問が「不明」で返ってきた。
ところが同じ甲山機工の求人は Joblist に16件あり、「不明」と言われた項目の答えが
そのうち少なくとも8問ぶん、すでに書かれていた。

  Q「使うリフトはカウンター式ですか」    → 不明   … 兄弟求人に「カウンター式フォークリフト」
  Q「設備・支給品を教えてください」      → 不明   … 兄弟求人に「休憩室・更衣室・個人ロッカー完備」
  Q「月収例はありますか」                → 不明   … 兄弟求人に「月給40万円以上！！」
  Q「現場は何名体制ですか」              → 不明   … 兄弟求人に「10人前後の少ないライン」

質問を増やしても、派遣先に確認しないと答えられないことは答えが返ってこない。
このスキルのゴールは「FooTの代表が関わらなくても案ができる」なので、
**聞けない前提で、すでにある事実を拾うのが本筋**である。

集めた文は「素材」であって、そのまま原稿に貼るものではない。
- 由来は必ず求人番号つきで返す（`references/appeal-formula.md` の由来ラベルでは `媒体データ`）
- 事業所が違う求人の記述は、同じ派遣先でも現場が違う。`--office` で絞れないぶんは
  出力の `office_unknown` に落とし、使う前に人へ確認させる
- 年代の記述（「20代・30代が活躍中」など）は**応募資格には使えない**。
  職場情報タグと本文の訴求にだけ使う（`references/hearing-protocol.md`）

  python3 collect_siblings.py --client foot --site 甲山機工 \
      [--office X市] [--title リフトで出荷作業] [--exclude 5722250] \
      --output /tmp/siblings_YYYYMMDD.json

  python3 collect_siblings.py --self-test
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from secure_tmp import dump_tmp_json  # noqa: E402

# 兄弟求人から読む列。内部キーはヘッダーの「項目名(internal_key)」の括弧内。
#
# 条件そのものの欄（minimum_salary / maximum_salary / work_place / employment_type /
# working_time など、数値や区分がそのまま入る列）は読まない。
# あれは兄弟求人ごとに違うので、借りると別案件の時給や勤務地が原稿に載る。
#
# 一方、末尾が supplement の欄は「条件の欄」ではなく「補足説明の本文」で、
# そこには現場の事実（休憩55分、駅から車7分、制服代補助）が書かれている。
# だから本文としては読む。読まないと No.88 の休憩時間が永久に埋まらない。
#
# 補足説明の中に混ざっている条件文（「6:30～15:25」「時給1600円」など）は、
# ここでは捨てずに拾い、lib/sibling_material.mjs の選別層が
#   ・CONDITION_TEXT（時刻・金額・人数のパターン）
#   ・出所フィールド（salary_supplement / salary_example は無条件で条件扱い）
#   ・confidence（同一事業所の1求人にしか出てこないものは使わない）
# の3つで落とす。収集側で欄ごと落とすと、同じ欄にある使える事実まで消える。
CONDITION_SOURCE_KEYS = {"salary_supplement", "salary_example"}
READ_KEYS = [
    "title", "description", "personal", "subtitle",
    "work_environment", "welfare", "salary_supplement", "salary_example",
    "working_time_supplement", "holiday", "selection_flow",
    "probationary_period_supplement", "smoking_section_supplement",
]

# 文をカテゴリに割り振る。1文が複数カテゴリに入ってよい（設備と年代が同じ文にある等）。
# 「拾いすぎ」は人が捨てられるが、「拾い漏れ」は気づかれない。広めに取る。
CATEGORIES = [
    ("equipment", "使う機械・道具", [
        r"カウンター", r"リーチ", r"フォークリフト", r"リフト", r"クレーン", r"玉掛",
        r"ハンディ", r"端末", r"台車", r"パレット", r"工具", r"機械", r"装置"]),
    ("cargo", "扱う荷物・製品", [
        r"部品", r"製品", r"荷物", r"段ボール", r"ダンボール", r"資材", r"空箱",
        r"[0-9０-９]+\s*(?:kg|ｋｇ|キロ)", r"重さ", r"サイズ"]),
    ("ratio", "作業の割合", [
        r"[0-9０-９]+\s*割", r"約\s*[0-9０-９]+\s*[%％]", r"[0-9０-９]+\s*[%％]",
        r"全体の", r"メイン", r"がメインの"]),
    ("flow", "1日の流れ", [
        r"朝礼", r"始業", r"終業", r"午前", r"午後", r"休憩", r"1日の流れ",
        r"タイムスケジュール", r"スケジュール", r"[0-9０-９]+:[0-9０-９]+～"]),
    ("training", "教育・フォロー体制", [
        r"先輩", r"研修", r"教え", r"サポート", r"丁寧に", r"OJT", r"慣れるまで",
        r"未経験", r"イチから", r"一から", r"指導"]),
    ("team", "体制・人数", [
        r"[0-9０-９]+\s*人", r"[0-9０-９]+\s*名", r"体制", r"チーム", r"ライン",
        r"班", r"男女", r"スタッフ"]),
    ("facility", "設備・支給品", [
        r"休憩室", r"更衣室", r"ロッカー", r"食堂", r"自動販売機", r"自販機",
        r"電子レンジ", r"空調", r"エアコン", r"クーラー", r"駐車場", r"作業着",
        r"制服", r"安全靴", r"冷蔵庫", r"給茶", r"喫煙", r"トイレ", r"支給"]),
    ("salary_example", "月収例・手当", [
        r"月収", r"月給", r"年収", r"日払", r"週払", r"手当", r"昇給", r"賞与",
        r"[0-9０-９万]+\s*円"]),
    ("access", "立地・通勤", [
        r"駅", r"車で", r"車通勤", r"徒歩", r"バイク", r"自転車", r"IC", r"インター",
        r"[0-9０-９]+\s*分"]),
    ("age", "年代・活躍層", [
        r"[0-9０-９]+\s*代", r"活躍", r"若手", r"ミドル", r"シニア"]),
    ("overtime", "残業", [r"残業", r"時間外", r"定時"]),
    ("holiday_note", "休日・シフト", [
        r"土日", r"休み", r"休日", r"連休", r"シフト", r"交替", r"交代", r"年間休日"]),
    ("physical", "体への負担", [
        r"力仕事", r"重い", r"軽い", r"立ち", r"座り", r"негр", r"負担", r"冷暖房",
        r"暑", r"寒", r"きつ", r"ラク", r"らく", r"楽"]),
]

# 年代は応募資格に転用できない。出力を読む側へ毎回出す注意書き。
AGE_WARNING = ("※ 年代の記述は応募資格に使えません（雇用対策法10条）。"
               "職場情報タグと本文の訴求にだけ使ってください。")

# 文の切れ目。求人原稿は「♪」「◎」「！」で切っていることが多い。
SENT_SPLIT = re.compile(r"[。！？\n♪◎★☆]+")
# 拾わない文（短すぎる・記号だけ）
MIN_SENT = 6


def split_sentences(text):
    """原稿本文を文に割る。短すぎる断片と空白だけの行は捨てる。"""
    out = []
    for s in SENT_SPLIT.split(str(text or "")):
        s = re.sub(r"[\s　]+", " ", s).strip(" 、,・/｜|")
        if len(s) >= MIN_SENT:
            out.append(s)
    return out


def categorize(sentence):
    """1文が当てはまるカテゴリのキーを返す（0個以上）。"""
    hit = []
    for key, _label, pats in CATEGORIES:
        if any(re.search(p, sentence) for p in pats):
            hit.append(key)
    return hit


def header_index(head):
    """ヘッダー行「項目名(internal_key)」から {internal_key: 列番号} を作る。

    Joblist のヘッダーは日本語の項目名の末尾に括弧つきで英字キーが入っている。
    括弧が無い列は捨てる（`fetch_current.py` と同じ扱い）。
    """
    idx = {}
    for i, c in enumerate(head):
        m = re.search(r"\(([^()]+)\)\s*$", str(c))
        if m:
            idx.setdefault(m.group(1).strip(), i)
    return idx


def data_start(values):
    """データが始まる行番号を返す。**Joblist のヘッダーは2行ある。**

    1行目が項目名、2行目に注記が入っている。`values[1:]` から読むと
    2行目の注記を求人1件として扱ってしまい、全カテゴリにゴミが混ざる。
    英字キーの検出できた行の次からをデータとみなす。
    """
    for i, row in enumerate(values[:5]):
        if header_index(row):
            # 見つかった行の次が注記行かどうかを、求人番号が数字かどうかで見る
            nxt = values[i + 1] if len(values) > i + 1 else []
            first = str(nxt[0]).strip() if nxt else ""
            return i + (1 if first.isdigit() else 2)
    return 1


def site_key(name):
    """派遣先名から突き合わせ用のキーを作る。

    求人メモの派遣先名は人が手で書いていて、同じ現場でも表記が割れる。
    2026-08-03 に実測したところ、X市Y町の同じ事業所が Joblist 上で
    「甲山機工　リフト/X市/」「甲山本社」「甲山リフト」「甲山検査」
    「簡潔甲山検査」「甲山本社昼のみ」…と13通りに割れていた。
    /市区町村/ 以降・空白・区切り記号を落として比べる。
    """
    s = re.sub(r"[／/].*$", "", str(name or ""))
    return re.sub(r"[\s　･・,、]+", "", s)


def same_series(a, b):
    """2つの派遣先名が同じ会社を指していそうか。

    完全一致も先頭一致も求めない。**共通する2文字以上のかたまりがあれば同系列**とみなす。
    「簡潔甲山検査」のように会社名の前に語がつく書き方が実在するため、
    先頭2文字での判定だと同じ現場を取りこぼす（2026-08-03 に実測）。

    これ単独では別会社を拾いうる緩い判定なので、
    **呼び出し側で郵便番号一致と AND を取る**ことを前提にしている。
    同じ郵便番号（＝同じ住所）にいて社名に共通のかたまりがあるなら、
    同じ派遣先の書き分けと考えてよい。
    """
    a, b = site_key(a), site_key(b)
    if not a or not b:
        return False
    if a in b or b in a:
        return True
    return any(a[i:i + 2] in b for i in range(len(a) - 1))


def find_postcode(rows, idx, job):
    """対象求人の郵便番号を Joblist から引く。見つからなければ空文字。"""
    ji, pi = idx.get("job_offer_id"), idx.get("working_location_postcode")
    if ji is None or pi is None:
        return ""
    job = str(job or "").strip()
    for r in rows:
        if ji < len(r) and str(r[ji]).strip() == job:
            return str(r[pi]).strip() if pi < len(r) else ""
    return ""


def collect(rows, idx, site_of, site, office=None, exclude=None, postcode=None):
    """兄弟求人を絞り込み、文をカテゴリ別に集める。

    rows     : Joblist のデータ行（ヘッダーを除いたもの）
    idx      : {internal_key: 列番号}
    site_of  : 行 -> 派遣先名 を返す関数（求人メモから単価を落として取る）
    exclude  : 今回書き換える対象の求人番号。自分自身は素材にしない
    postcode : 対象求人の郵便番号。渡すと**事業所単位**で兄弟を絞る

    絞り込みの考え方:
      postcode あり … 郵便番号一致 AND 派遣先名が同系列（same_series）
      postcode なし … 派遣先名の部分一致だけ（従来どおり・表記ゆれに弱い）

    郵便番号を優先するのは、派遣先名より住所のほうが信用できるため。
    甲山グループは 1000001（X市）13件 と 1000002（Z地区）3件 に
    きれいに割れていて、名前では区別できないが郵便番号なら確実に分かれる。
    別事業所の記述を混ぜると「そこには無い設備」を原稿に書くことになる。
    """
    exclude = str(exclude or "").strip()
    site = (site or "").strip()
    postcode = str(postcode or "").strip()
    jobs, facts = [], {}
    for r in rows:
        def cell(key):
            i = idx.get(key)
            return str(r[i]).strip() if i is not None and i < len(r) else ""

        job = cell("job_offer_id") or (str(r[0]).strip() if r else "")
        if not job or job == exclude:
            continue
        name = site_of(r)
        if postcode:
            if cell("working_location_postcode") != postcode:
                continue
            if not same_series(name, site):
                continue
        elif not name or not site or not (name in site or site in name):
            continue

        fields = {k: cell(k) for k in READ_KEYS if cell(k)}
        if not fields:
            continue
        # 郵便番号で絞れた場合は同じ事業所だと確定している。
        # 郵便番号が無いときだけ、市区町村で当たりを付ける（確証ではない）。
        city = cell("working_location_city_area")
        if postcode:
            in_office = True
        else:
            in_office = bool(office) and bool(city) and (office in city or city in office)
        jobs.append({"job": job, "title": fields.get("title", ""),
                     "city": city, "site": name,
                     "sameOffice": in_office if (office or postcode) else None})

        for field, text in fields.items():
            for s in split_sentences(text):
                for key in categorize(s):
                    bucket = facts.setdefault(key, {})
                    ent = bucket.setdefault(s, {"text": s, "jobs": [], "fields": set()})
                    if job not in ent["jobs"]:
                        ent["jobs"].append(job)
                    ent["fields"].add(field)

    # 多くの求人に載っている記述ほど、その派遣先で安定している事実である
    out = {}
    for key, bucket in facts.items():
        items = [{"text": v["text"], "jobs": v["jobs"], "fields": sorted(v["fields"])}
                 for v in bucket.values()]
        items.sort(key=lambda x: (-len(x["jobs"]), -len(x["text"])))
        out[key] = items
    return jobs, out


def summarize(site, jobs, facts, office=None, postcode=None):
    """人が読む要約。どのカテゴリが何件取れたかと、代表例を出す。"""
    labels = {k: lb for k, lb, _ in CATEGORIES}
    lines = [f"派遣先「{site}」の兄弟求人 {len(jobs)} 件から素材を集めました。"]
    if postcode:
        lines.append(f"  郵便番号 {postcode} で事業所を確定して絞り込みました。"
                     "別事業所の求人は入っていません。")
        names = sorted({j.get("site", "") for j in jobs if j.get("site")})
        if len(names) > 1:
            lines.append("  Joblist 上の派遣先名の表記ゆれ: "
                         + " / ".join(names[:8])
                         + (f" ほか{len(names) - 8}通り" if len(names) > 8 else ""))
    elif office:
        same = [j for j in jobs if j.get("sameOffice")]
        lines.append(f"  うち市区町村が「{office}」と一致: {len(same)} 件"
                     "（事業所はJoblistの列に無いため確証ではありません）")
    if not jobs:
        lines.append("  該当なし。ヒアリングの回答だけで書くことになります。")
        return "\n".join(lines)
    lines.append("")
    for key, label, _ in CATEGORIES:
        items = facts.get(key) or []
        if not items:
            continue
        top = items[0]
        lines.append(f"■ {label}（{len(items)}件）")
        lines.append(f"    「{top['text'][:60]}」  ← 求人 {', '.join(top['jobs'][:3])}")
        if key == "age":
            lines.append(f"    {AGE_WARNING}")
    return "\n".join(lines)


def _self_test():
    assert split_sentences("基本乗りっぱなしのリフト作業♪ 未経験の方も歓迎します。") \
        == ["基本乗りっぱなしのリフト作業", "未経験の方も歓迎します"]
    # 「未経験OK」のような短い断片はタグの領分。原稿素材としては拾わない
    assert split_sentences("未経験OK。土日休み。") == []
    assert split_sentences(None) == []

    assert "equipment" in categorize("カウンター式フォークリフトを使って運びます")
    assert "facility" in categorize("休憩室・更衣室・個人ロッカー完備です")
    assert "age" in categorize("20代・30代を中心に活躍しています")
    assert "ratio" in categorize("フォークリフト作業は全体の2割程度です")
    assert categorize("こんにちは") == []

    head = ["求人番号(job_offer_id)", "職種名(title)", "仕事内容(description)", "備考"]
    idx = header_index(head)
    assert idx == {"job_offer_id": 0, "title": 1, "description": 2}, idx
    assert "備考" not in idx, "括弧の無い列を拾ってはいけない"

    # ヘッダーが2行あるケース。注記行をデータとして数えない
    v2 = [head, ["※必須", "", "", ""], ["111", "リフト", "本文", ""]]
    assert data_start(v2) == 2, data_start(v2)
    v1 = [head, ["111", "リフト", "本文", ""]]
    assert data_start(v1) == 1, data_start(v1)

    rows = [
        ["111", "リフトA", "カウンター式フォークリフトで運びます。休憩室完備です。"],
        ["222", "リフトB", "カウンター式フォークリフトで運びます。20代・30代が活躍中。"],
        ["333", "検査",   "目視検査のお仕事。休憩室完備です。"],
    ]
    site_of = lambda r: "甲山機工"
    jobs, facts = collect(rows, idx, site_of, "甲山機工", exclude="333")
    assert [j["job"] for j in jobs] == ["111", "222"], jobs
    assert all(j["job"] != "333" for j in jobs), "--exclude が効いていない"
    eq = facts["equipment"][0]
    assert eq["jobs"] == ["111", "222"], "同じ文は求人番号をまとめる"
    assert eq["fields"] == ["description"]
    # 2件に出る文が1件の文より先に来る（安定している事実を上に）
    assert len(facts["equipment"][0]["jobs"]) >= len(facts["equipment"][-1]["jobs"])
    assert any("20代" in i["text"] for i in facts["age"])

    # 派遣先が違う行は拾わない
    jobs2, _ = collect(rows, idx, lambda r: "別会社", "甲山機工")
    assert jobs2 == [], jobs2

    # --- 表記ゆれ（2026-08-03 に実データで露呈したバグ）---
    assert site_key("甲山機工　リフト/X市/") == "甲山機工リフト"
    assert site_key("甲山本社/X市/") == "甲山本社"
    assert same_series("甲山本社", "甲山機工"), "先頭2文字が共通なら同系列"
    assert same_series("甲山機工　機械OP/X市/", "甲山機工"), "包含なら同系列"
    assert same_series("簡潔甲山検査", "甲山機工"), "社名の前に語がついても同系列"
    assert not same_series("乙川運送", "甲山機工"), "無関係な派遣先を混ぜてはいけない"
    assert not same_series("", "甲山機工")

    # 郵便番号があれば、名前が割れていても同じ事業所を拾う。
    # 逆に、名前が似ていても郵便番号が違えば別事業所として弾く。
    head2 = ["求人番号(job_offer_id)", "職種名(title)", "仕事内容(description)",
             "郵便番号(working_location_postcode)"]
    idx2 = header_index(head2)
    rows2 = [
        ["5722250", "リフト出荷", "本社のリフト作業です。", "1000001"],
        ["5722253", "機械OP",   "カウンター式フォークリフトを使います。", "1000001"],
        ["10029667", "空箱整理", "休憩室完備です。", "1000001"],
        ["9483755", "Z地区リフト", "Z地区の屋外ヤードで運びます。", "1000002"],
        ["8000206", "配送",     "無関係な派遣先の求人です。", "1000001"],
    ]
    names = {"5722250": "甲山機工　リフト/X市/", "5722253": "甲山機工　機械OP/X市/",
             "10029667": "甲山リフト", "9483755": "甲山南リフト", "8000206": "乙川運送"}
    site_of2 = lambda r: names[r[0]]
    assert find_postcode(rows2, idx2, "5722250") == "1000001"
    assert find_postcode(rows2, idx2, "9999999") == ""
    j3, f3 = collect(rows2, idx2, site_of2, "甲山機工",
                     exclude="5722250", postcode="1000001")
    got = sorted(x["job"] for x in j3)
    assert got == ["10029667", "5722253"], got
    assert all(x["sameOffice"] for x in j3), "郵便番号一致は同じ事業所と確定できる"
    assert "Z地区" not in json.dumps(f3, ensure_ascii=False), "別事業所を混ぜてはいけない"
    assert "無関係" not in json.dumps(f3, ensure_ascii=False), "別派遣先を混ぜてはいけない"

    # 郵便番号を渡さないと、従来どおり名前一致になり「甲山リフト」を取りこぼす
    j4, _ = collect(rows2, idx2, site_of2, "甲山機工", exclude="5722250")
    assert [x["job"] for x in j4] == ["5722253"], j4

    s2 = summarize("甲山機工", j3, f3, postcode="1000001")
    assert "郵便番号 1000001" in s2
    assert "表記ゆれ" in s2, "名前が割れている事実を人に見せる"

    # 事実条件の列は読まない（別案件の時給が混ざる事故を防ぐ）
    for ng in ("minimum_salary", "maximum_salary", "hires_number", "job_type_jp"):
        assert ng not in READ_KEYS, f"{ng} を兄弟求人から借りてはいけない"

    s = summarize("甲山機工", jobs, facts)
    assert "兄弟求人 2 件" in s
    assert AGE_WARNING in s, "年代を出すときは毎回注意書きを添える"
    assert summarize("X", [], {}).endswith("書くことになります。")
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--client", default="foot")
    p.add_argument("--site", help="派遣先名（依頼フォーマットの■派遣先）")
    p.add_argument("--office", help="事業所名。市区町村との一致だけ見る（確証ではない）")
    p.add_argument("--title", help="今回の職種。出力に控えるだけで絞り込みには使わない")
    p.add_argument("--exclude", help="今回書き換える求人番号。自分自身を素材にしない")
    p.add_argument("--job", help="今回の求人番号。郵便番号を引いて事業所単位で絞る"
                                 "（省略時は --exclude を使う）")
    p.add_argument("--postcode", help="郵便番号を直接指定する。--job で引けないときだけ")
    p.add_argument("--output", help="素材JSONの保存先。/tmp 配下のみ")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    if not a.site:
        p.error("--site は必須です")

    from hearing_log import build_service, load_joblist, site_from_memo
    jid, jsheet, memo_col = load_joblist(a.client)
    sh = build_service()
    res = sh.values().batchGet(
        spreadsheetId=jid,
        ranges=[f"{jsheet}!A:IE", f"{jsheet}!{memo_col}:{memo_col}"]).execute()
    ranges = res.get("valueRanges", [])
    values = ranges[0].get("values", []) if ranges else []
    memos = ranges[1].get("values", []) if len(ranges) > 1 else []
    if not values:
        print("NG: Joblist が空です", file=sys.stderr)
        sys.exit(1)

    idx = header_index(values[0])
    start = data_start(values)
    rows = values[start:]

    # 求人メモは請求単価/支払単価を含む。派遣先名だけ取り出して、値は持ち回らない。
    tail = memos[start:]
    paired = [(r, site_from_memo(tail[i][0] if i < len(tail) and tail[i] else ""))
              for i, r in enumerate(rows)]
    # 事業所は郵便番号で決める。派遣先名は手書きで表記が割れるので信用しない。
    postcode = (a.postcode or "").strip()
    if not postcode:
        postcode = find_postcode(rows, idx, a.job or a.exclude)
    if not postcode:
        print("※ 対象求人の郵便番号が引けませんでした。派遣先名の部分一致で絞ります。\n"
              "   表記ゆれで兄弟を取りこぼす可能性があります"
              "（--job で求人番号を渡すか、--postcode を直接指定してください）\n")

    jobs, facts = collect(rows, idx, _site_lookup(paired),
                          a.site, a.office, a.exclude, postcode)

    print(summarize(a.site, jobs, facts, a.office, postcode))
    if a.output:
        payload = {"site": a.site, "office": a.office, "title": a.title,
                   "excluded": a.exclude, "postcode": postcode,
                   "jobs": jobs, "facts": facts,
                   "ageWarning": AGE_WARNING}
        try:
            dump_tmp_json(a.output, payload)
        except ValueError as e:
            print(f"NG: {e}", file=sys.stderr)
            sys.exit(1)
        print(f"\n素材 -> {a.output}")


def _site_lookup(paired):
    """行オブジェクトの同一性ではなく添字で派遣先名を引く。

    同じ内容の行が2件あると `list.index` は先頭を返してしまい、
    2件目の派遣先名が1件目のものに化ける。id() で引く。
    """
    table = {id(r): name for r, name in paired}
    return lambda r: table.get(id(r), "")


if __name__ == "__main__":
    main()
