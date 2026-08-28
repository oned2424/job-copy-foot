# -*- coding: utf-8 -*-
"""ヒアリング履歴スプレッドシートを読み書きする。

質問を作る前に read で既出を確認し、回答を受け取ったら append で追記する。
同じことを毎回フロントに聞かせないための土台。

  # 1) 質問を作る前に読む（既出は質問候補から外す）
  python3 hearing_log.py read --client foot \
      --site 派遣先名 --office 事業所名 --title 職種

  # 2) 回答を受け取ったら追記する（未回答だった事実も1行として残す）
  python3 hearing_log.py append --client foot \
      --site 派遣先名 --office 事業所名 --job 12204054 --title 職種 \
      --rows /tmp/hearing_rows.json

  # 3) フロントは案件番号を言わない。派遣先名から案件番号の候補を出す
  python3 hearing_log.py resolve --client foot \
      --site 派遣先名 --office 事業所名 --title 職種

--title（職種）を必ず渡す理由:
  層3は案件限りの回答である。同じ派遣先・同じ事業所でも、職種が変われば
  手積みの有無・必要な資格・服装・立ち仕事かどうかはまるごと変わる。
  --title があると、read は「今回の職種の回答」と「別の職種の案件の回答」を
  分けて出す。渡さないと全部が「前回の回答」として出てしまい、
  **別の仕事の事実が新しい原稿に混ざる。**
  append の --title は必須にしてある。J列に残さないと、次のセッションで
  この判定ができなくなるため（新規案件は Joblist に行が無く職種を引けない）。

--rows の形式:
  [{"layer": "層3（案件限り）", "question": "中型免許は必須ですか",
    "answer": "必須", "state": "確認済み"}]

  layer  : 層1（FooT全社） / 層2（事業所・恒久） / 層3（案件限り）
           ※ question-catalog.json に載っている質問は、ここの申告よりカタログを優先する。
             層をAIに判断させると毎回安全側（層3）へ倒れ、層1・層2が永久に埋まらない。
  state  : 確認済み / 未回答 / 要再確認
  answer : 空文字や「わからない」でも必ず1行残す（聞いていないのと区別するため）

  python3 hearing_log.py --self-test
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SHEET = "ヒアリング履歴"
HEAD = ["日時", "派遣先", "事業所", "案件番号", "層", "質問", "回答", "状態", "記録者",
        "職種"]   # J列。末尾に足しているので既存A〜I列の位置は動かない
STATES = {"確認済み", "未回答", "要再確認"}
TITLE_MATCH_MIN = 0.25   # 職種が同じと言える下限。これ未満なら別の仕事として扱う
L1, L2, L3 = "層1（FooT全社）", "層2（事業所・恒久）", "層3（案件限り）"
LAYERS = {L1, L2, L3}
HERE = os.path.dirname(os.path.abspath(__file__))


def load_hearing_log(client):
    """config.json から履歴スプレッドシートIDとシート名を取る。

    シート名は config で別名にできる（init_hearing_log.py が既存値を保持するため）。
    ここで定数固定にすると、別名にした環境で read/append が静かに空振りする。
    """
    path = os.path.join(HERE, "..", "references", "clients", client, "config.json")
    cfg = json.load(open(path, encoding="utf-8"))
    log = cfg.get("hearingLog", {})
    sid = log.get("spreadsheetId")
    if not sid:
        raise SystemExit(
            f"{client}/config.json に hearingLog.spreadsheetId がありません。"
            "履歴スプレッドシートを作ってからIDを書いてください。")
    return sid, log.get("sheetName") or SHEET


def load_catalog(client):
    """質問カタログ（質問文→層）。無ければ空で動く（層はAIの申告どおりになる）。"""
    path = os.path.join(HERE, "..", "references", "clients", client,
                        "question-catalog.json")
    if not os.path.exists(path):
        return []
    return json.load(open(path, encoding="utf-8")).get("questions", [])


def norm_q(s):
    """句読点・空白・記号を落として比較用にする。表記ゆれで照合が外れるのを防ぐ。"""
    return "".join(c for c in (s or "")
                   if c not in " 　、。，．・？?「」（）()【】\t\n")


def lookup_layer(question, catalog):
    """カタログから層を引く。question の完全一致 → aliases の部分一致の順。

    層の判定をAIに任せると毎回安全側（層3）へ倒れ、層2・層1が永久に埋まらない。
    ここで固定する。見つからなければ (None, None) を返し、呼び出し側が警告する。
    """
    q = norm_q(question)
    for e in catalog:
        if norm_q(e.get("question")) == q:
            return e["layer"], e.get("id")
    for e in catalog:
        for a in e.get("aliases", []):
            if norm_q(a) and norm_q(a) in q:
                return e["layer"], e.get("id")
    return None, None


def to_rows(records, site, office, job, today, author, catalog=None, title=""):
    """追記用の2次元配列にする。層・状態は既定値に丸めず、不正なら止める。

    catalog を渡した場合、層はカタログを優先する（AIの申告より対応表が正しい）。
    カタログに無い質問は申告どおり記録し、標準エラーに警告を出す。

    title（職種）は J列に残す。層3は案件限りの回答なので、次のセッションで
    「これは今回の職種の回答か」を判定するのに要る。案件番号から Joblist を引く
    手もあるが、新規案件は Joblist に行が無く判定できない。ここに書いておけば
    仮の案件番号（YYYYMMDD_派遣先名）でも判定できる。
    """
    catalog = catalog or []
    out = []
    for i, r in enumerate(records):
        layer, state = r.get("layer", ""), r.get("state", "")
        hit, qid = lookup_layer(r.get("question", ""), catalog)
        if hit:
            if hit != layer:
                print(f"  層をカタログで補正: rows[{i}] {layer or '(未指定)'} → {hit}"
                      f" [{qid}]", file=sys.stderr)
            layer = hit
        elif catalog:
            print(f"  ⚠ カタログに無い質問です（層3として記録）: "
                  f"{r.get('question', '')[:40]}", file=sys.stderr)
            layer = layer or L3
        if layer not in LAYERS:
            raise ValueError(f"rows[{i}].layer が不正: {layer!r} / 許可: {sorted(LAYERS)}")
        if state not in STATES:
            raise ValueError(f"rows[{i}].state が不正: {state!r} / 許可: {sorted(STATES)}")
        if not r.get("question", "").strip():
            raise ValueError(f"rows[{i}].question が空です")
        out.append([today, site, office, str(job), layer,
                    r["question"], r.get("answer", ""), state, author, title])
    return out


def filter_rows(values, site, office):
    """派遣先×事業所で絞る。ヘッダー行は落とす。

    層1（FooT全社）まで落ちる点に注意。層1は派遣先・事業所を跨いで有効なので、
    この関数だけで質問候補を決めてはいけない。layer1_rows() と合流させる。
    ここを緩めないのは、「この事業所は初回か」の判定にこの結果を使うからである。
    """
    hit = []
    for row in values[1:]:
        row = row + [""] * (len(HEAD) - len(row))
        if row[1] == site and (not office or row[2] == office):
            hit.append(row)
    return hit


def layer1_rows(values, catalog=None):
    """層1（FooT全社）の行を、派遣先・事業所に関係なく全件から拾う。

    層1は「二度と聞かない」区分である。別の派遣先・別の事業所の案件でも、
    FooT様の方針（例：性別・主婦主夫系のタグを使わない）は変わらない。
    filter_rows は site/office で絞るため、初めての事業所では層1まで空になり、
    一度答えてもらった全社方針をまた聞くことになる。ここで別に拾う。
    """
    out = []
    for row in values[1:]:
        row = row + [""] * (len(HEAD) - len(row))
        lv = row[4]
        if catalog:
            fixed, _ = lookup_layer(row[5], catalog)
            if fixed:
                lv = fixed
        if lv.startswith("層1"):
            out.append(row)
    return out


def dedupe_latest(rows):
    """同じ案件×同じ質問が複数行あるとき、最後に書かれた行だけ残す。

    スプレッドシートは追記専用にしてある（履歴を消さないため）ので、
    同じ案件で作り直すたびに同じ質問が積み上がる。読み出しでそのまま出すと、
    同じ質問が2回並び、古い回答と新しい回答のどちらが今なのか分からなくなる。
    行の並び順＝書かれた順なので、後勝ちにする。消すのは表示だけで、
    スプレッドシート側の履歴には手を触れない。
    """
    latest = {}
    for r in rows:
        latest[(r[3], norm_q(r[5]))] = r
    return list(latest.values())


def merge_layer1(hit, values, catalog=None):
    """site/office で絞った行に、層1の行を重複なく足す。

    同じ質問が複数の事業所で記録されていることがあるので、質問文で重複を落とす。
    先に記録された行（＝hit 側）を優先する。
    """
    seen = {norm_q(r[5]) for r in hit}
    out = list(hit)
    for r in layer1_rows(values, catalog):
        if norm_q(r[5]) not in seen:
            seen.add(norm_q(r[5]))
            out.append(r)
    return out


def split_by_layer(rows, catalog=None):
    """層1（全社・二度と聞かない）／層2（事業所）／層3（案件限り）に分ける。

    catalog を渡すと、E列に記録されている層よりカタログを優先する。
    E列は書き込み時のAIの申告値である。実測では8行すべてが層3へ倒れていた
    （層の判断をAIに任せると毎回安全側へ倒れる）。これをそのまま信じると
    層1・層2が永久に空になり、**一度確認した質問を毎回聞き直す**。
    append 時にも to_rows がカタログで直すが、手書きで入った行はここでしか救えない。
    """
    def layer_of(r):
        if catalog:
            fixed, _ = lookup_layer(r[5], catalog)
            if fixed:
                return fixed
        return r[4]

    l1, l2, l3 = [], [], []
    for r in rows:
        lv = layer_of(r)
        (l1 if lv.startswith("層1") else l2 if lv.startswith("層2") else l3).append(r)
    return l1, l2, l3


def relabeled(rows, catalog):
    """E列とカタログで層が食い違っている行を返す。読み手に補正の事実を伝えるため。"""
    if not catalog:
        return []
    out = []
    for r in rows:
        fixed, _ = lookup_layer(r[5], catalog)
        if fixed and fixed != r[4]:
            out.append((r, fixed))
    return out


def site_from_memo(memo):
    """求人メモから派遣先名だけを取り出す。

    メモは「乙川運送2000/1500」のように 派遣先名＋単価 で書かれている。
    単価は請求・支払の金額なので、**原稿にもドキュメントにも出してはいけない。**
    ここで数字以降を捨て、社名だけを返す。
    """
    s = (memo or "").strip()
    for i, c in enumerate(s):
        if c.isdigit():
            return s[:i].strip()
    return s


def title_overlap(want, actual):
    """職種名がどれくらい近いかを 0.0〜1.0 で返す。文字2-gramのDice係数。

    表記ゆれが大きい欄なので完全一致では判定できない。
    「倉庫内フォークリフト作業」と「フォークリフトで製品を倉庫に運ぶ作業」を
    同じ仕事だと言える程度の粗さにしてある。
    """
    def grams(s):
        s = re.sub(r"[\s　]+", "", (s or ""))
        return {s[i:i + 2] for i in range(len(s) - 1)}
    a, b = grams(want), grams(actual)
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def match_jobs(rows, site, want_title=None):
    """求人メモ由来の社名と入力された派遣先名を突き合わせる。

    人が手で書く欄なので完全一致は期待しない。どちらかがどちらかを含めば候補にする。
    確定はせず候補として返し、複数なら人に選んでもらう。

    want_title を渡すと、依頼された職種と既存求人の職種名の近さも一緒に返す。
    **派遣先が一致しても職種が違えば別の仕事**である。ここを見ないと、
    「乙川運送に倉庫内フォークリフトの依頼が来たが、乙川運送の既存求人は中型トラック
    輸送1件だけ」というときに、無関係な求人を黙って書き換えてしまう。
    """
    site = (site or "").strip()
    hit = []
    for job, title, memo in rows:
        name = site_from_memo(memo)
        if not name or not site:
            continue
        if name in site or site in name:
            hit.append((job, title, name, title_overlap(want_title, title)))
    return hit


def asked_questions(rows):
    """すでに `確認済み` の質問文。ここから質問候補を引く。"""
    return {r[5] for r in rows if r[7] == "確認済み"}


def _self_test():
    today = "2026-08-02"
    recs = [{"layer": "層3（案件限り）", "question": "年齢構成は",
             "answer": "", "state": "未回答"}]
    rows = to_rows(recs, "A運送", "B営業所", 123, today, "Codex")
    assert rows == [[today, "A運送", "B営業所", "123", "層3（案件限り）",
                     "年齢構成は", "", "未回答", "Codex", ""]], rows
    # J列（職種）。層3を次のセッションで流用してよいか判定するのに要る
    rows = to_rows(recs, "A運送", "B営業所", 123, today, "Codex", title="倉庫内作業")
    assert rows[0][9] == "倉庫内作業" and len(rows[0]) == len(HEAD), rows

    for bad in ({"layer": "層9", "question": "x", "state": "確認済み"},
                {"layer": "層2（事業所・恒久）", "question": "x", "state": "たぶん"},
                {"layer": "層2（事業所・恒久）", "question": " ", "state": "確認済み"}):
        try:
            to_rows([bad], "A", "B", 1, today, "t")
            raise AssertionError(f"不正を検出できていない: {bad}")
        except ValueError:
            pass

    # J列（職種）が空の行が混ざる。J列を足す前に記録された行がこれにあたる。
    # 読み出し側はJ列が空でも落ちてはいけない（案件番号から引き直す経路がある）。
    values = [HEAD,
              [today, "A運送", "B営業所", "1", L1, "性別・主婦主夫系のタグを外してよいですか。", "外す", "確認済み", "t", ""],
              [today, "A運送", "B営業所", "1", L2, "住所は", "◯◯町", "確認済み", "t", "倉庫内作業"],
              [today, "A運送", "B営業所", "1", L3, "年齢構成は", "", "未回答", "t", "倉庫内作業"],
              [today, "C物流", "D営業所", "2", L2, "住所は", "△△", "確認済み", "t", ""]]
    hit = filter_rows(values, "A運送", "B営業所")
    assert len(hit) == 3, hit
    l1, l2, l3 = split_by_layer(hit)
    assert (len(l1), len(l2), len(l3)) == (1, 1, 1), (l1, l2, l3)
    assert asked_questions(hit) == {"性別・主婦主夫系のタグを外してよいですか。", "住所は"}
    assert filter_rows(values, "A運送", "") == hit     # 事業所省略なら派遣先だけで絞る

    # 層1は派遣先・事業所を跨いで生きる。別会社の別事業所を引いても層1は出る。
    # ここが空になると、一度答えてもらった全社方針（性別タグ等）をまた聞くことになる。
    assert filter_rows(values, "C物流", "D営業所") == [values[4]]   # 素の絞り込みには層1が無い
    m = merge_layer1(filter_rows(values, "C物流", "D営業所"), values)
    assert len(m) == 2 and any(r[4] == L1 for r in m), m
    # 初回の事業所（履歴ゼロ）でも層1だけは引き継ぐ
    assert [r[4] for r in merge_layer1([], values)] == [L1]
    # 同じ質問を二重に出さない
    assert merge_layer1(hit, values) == hit

    # 同じ案件で作り直すと同じ質問が積まれる。読み出しでは後勝ちにする。
    dup = [[today, "A運送", "B営業所", "1", L3, "残業は", "なし", "確認済み", "t"],
           [today, "A運送", "B営業所", "1", L3, "残業は", "あり", "確認済み", "t"],
           [today, "A運送", "B営業所", "2", L3, "残業は", "なし", "確認済み", "t"]]
    dd = dedupe_latest(dup)
    assert len(dd) == 2, dd                      # 案件が違えば別物として残す
    assert dd[0][6] == "あり", dd                 # 同じ案件は後に書いた行が勝つ
    assert dedupe_latest(hit) == hit             # 重複が無ければ素通し

    # 層はカタログを優先する。AIが層3と申告しても、対応表が層1・層2なら直す。
    cat = load_catalog("foot")
    assert cat, "question-catalog.json が読めていない"
    assert lookup_layer("性別・主婦主夫系のタグを外してよいですか。", cat)[0] == L1
    assert lookup_layer("制服はありますか", cat)[0] == L2          # aliases の部分一致
    assert lookup_layer("いま現場で働いている方は、どの年代が多いですか。", cat)[0] == L3
    assert lookup_layer("社長の趣味は何ですか", cat) == (None, None)
    fixed = to_rows([{"layer": L3, "question": "性別のタグを外してよいですか。",
                      "answer": "外す", "state": "確認済み"}],
                    "A", "B", 1, today, "t", catalog=cat)
    assert fixed[0][4] == L1, fixed

    # 読み出し時もカタログを優先する。実データはE列が8行とも層3で記録されており、
    # 素通しすると層1・層2が空になって、確認済みの質問を毎回聞き直すことになる。
    bad = [HEAD,
           [today, "A運送", "B営業所", "1", L3,
            "性別・主婦主夫系のタグを外してよいですか。", "外す", "確認済み", "t"],
           [today, "A運送", "B営業所", "1", L3,
            "服装自由と制服ありはどちらを残しますか。", "制服あり", "確認済み", "t"],
           [today, "A運送", "B営業所", "1", L3,
            "いま現場で働いている方は、どの年代が多いですか。", "", "未回答", "t"]]
    bh = filter_rows(bad, "A運送", "B営業所")
    assert split_by_layer(bh) == ([], [], bh), "catalog なしではE列のまま扱う"
    b1, b2, b3 = split_by_layer(bh, cat)
    assert (len(b1), len(b2), len(b3)) == (1, 1, 1), (b1, b2, b3)
    assert len(relabeled(bh, cat)) == 2, relabeled(bh, cat)  # 年齢構成は層3のままが正しい

    # 求人メモは「社名＋単価」。単価は請求・支払の金額なので絶対に外へ出さない。
    assert site_from_memo("乙川運送2000/1500") == "乙川運送"
    assert site_from_memo("日本モウルド4勤1休2200/1700") == "日本モウルド"
    assert site_from_memo("") == ""
    memo_rows = [("12204054", "ドライバー", "乙川運送2000/1500"),
                 ("12199327", "検査", "タカミ2000/1500"),
                 ("11616728", "検査", "甲山本社検査2000")]
    assert [h[:3] for h in match_jobs(memo_rows, "乙川運送")] \
        == [("12204054", "ドライバー", "乙川運送")]
    assert [h[:3] for h in match_jobs(memo_rows, "甲山")] \
        == [("11616728", "検査", "甲山本社検査")]
    assert match_jobs(memo_rows, "存在しない会社") == []

    # 職種の近さ。表記が違っても同じ仕事なら拾い、別の仕事なら閾値を超えない。
    assert title_overlap("倉庫内フォークリフト作業",
                         "フォークリフトで製品を倉庫に運ぶ作業") >= TITLE_MATCH_MIN
    assert title_overlap("倉庫内フォークリフト作業",
                         "カウンター式フォークリフトで運搬作業") >= TITLE_MATCH_MIN
    assert title_overlap("倉庫内フォークリフト作業",
                         "中型トラックで中子の輸送スタッフ募集") < TITLE_MATCH_MIN
    assert title_overlap("", "何か") == 0.0 and title_overlap(None, "何か") == 0.0
    assert title_overlap("あ", "あ") == 0.0          # 2文字未満は判定材料にしない

    # 実際に起きた取り違え: 乙川運送の既存求人は中型トラック輸送1件だけ。
    # そこへ倉庫内フォークリフトの依頼が来ても、職種が一致しないので採用させない。
    taki = match_jobs([("12204054", "中型トラックで中子の輸送スタッフ募集", "乙川運送2000/1500")],
                      "乙川運送", "倉庫内フォークリフト作業")
    assert len(taki) == 1 and taki[0][3] < TITLE_MATCH_MIN
    assert not any(s >= TITLE_MATCH_MIN for *_, s in taki)

    # 層3は案件限りの回答。同じ事業所でも職種が違えば流用させない。
    # 乙川運送/一色営業所の履歴は案件12204054（中型トラック輸送）のもの。
    # 倉庫内フォークリフトの新規案件でこれを「前回の回答」として出すと、
    # 別の仕事の条件がそのまま新しい原稿に入る。
    l3rows = [["", "乙川運送", "一色営業所", "12204054", "層3（案件限り）",
               "積み下ろしは手積みですか", "手積みあり", "確認済み", "市野"]]
    titles = {"12204054": "中型トラックで中子の輸送スタッフ募集"}
    keep, drop = split_layer3_by_title(l3rows, "倉庫内フォークリフト作業", titles)
    assert keep == [] and drop == l3rows
    # 職種が近ければ流用してよい
    keep, drop = split_layer3_by_title(
        l3rows, "中型トラックでの配送", {"12204054": "中型トラックで中子の輸送スタッフ募集"})
    assert keep == l3rows and drop == []
    # Joblist に職種名が無い案件は判定できないので流用させない
    keep, drop = split_layer3_by_title(l3rows, "倉庫内フォークリフト作業", {})
    assert keep == [] and drop == l3rows
    # --title 未指定なら従来どおり全件を流用側に置く
    keep, drop = split_layer3_by_title(l3rows, None, titles)
    assert keep == l3rows and drop == []
    assert split_layer3_by_title([], "何か", {}) == ([], [])
    print("self-test OK")


def build_service():
    import google.auth
    from googleapiclient.discovery import build
    cred, _ = google.auth.default(scopes=SCOPES)
    return build("sheets", "v4", credentials=cred).spreadsheets()


def cmd_read(a):
    sid, sheet = load_hearing_log(a.client)
    sh = build_service()
    values = sh.values().get(spreadsheetId=sid,
                             range=f"{sheet}!A:J").execute().get("values", [])
    if not values:
        print("履歴は空です。初回の事業所として扱ってください（質問数を制限しない）。")
        return
    catalog = load_catalog(a.client)
    if not catalog:
        print("※ question-catalog.json が読めません。E列の層をそのまま使います。")

    hit = filter_rows(values, a.site, a.office or "")
    if not hit:
        print(f"{a.site} {a.office or ''} の履歴はありません。")
        print("→ 初回の事業所です。層2を埋めきるため質問数を制限しないでください。")
        print("　 ただし下の層1は事業所が変わっても有効です。ここは聞き直さないでください。\n")

    # 層1（FooT全社）は派遣先・事業所を跨いで有効。初回の事業所でも聞き直さない
    hit = merge_layer1(hit, values, catalog)
    if not hit:
        return
    before = len(hit)
    hit = dedupe_latest(hit)
    if before != len(hit):
        print(f"※ 同じ案件で同じ質問が {before - len(hit)} 件ぶん積まれていたので、"
              f"最後に書かれた回答だけを出しています（履歴自体は消していません）。")

    fixed = relabeled(hit, catalog)
    if fixed:
        print(f"※ E列の層が実態と違う行を {len(fixed)} 件、カタログで補正しました"
              f"（スプレッドシート側も直してください）:")
        for r, lv in fixed:
            print(f"    {r[4]} → {lv}  {r[5][:34]}")
        print()

    l1, l2, l3 = split_by_layer(hit, catalog)
    print(f"■ 層1（FooT全社／二度と聞かない）: {len(l1)}件")
    for r in l1:
        print(f"  [{r[7]}] {r[5]} → {r[6] or '（回答なし）'}")
    print(f"■ 層2（事業所・恒久／同じ事業所なら聞かない）: {len(l2)}件")
    for r in l2:
        print(f"  [{r[7]}] {r[5]} → {r[6] or '（回答なし）'}")
    print(f"■ 層3（案件限り／案件が変われば差分だけ確認する）: {len(l3)}件")
    for r in l3:
        print(f"  [{r[7]}] 案件{r[3]} {r[5]} → {r[6] or '（回答なし）'}")

    print("\n■ 質問候補から外す（層1・層2で確認済み）:")
    for q in sorted(asked_questions(l1) | asked_questions(l2)):
        print(f"  - {q}")

    prev = [r for r in l3 if r[7] == "確認済み" and r[6]]
    titles = {}
    if a.title and prev:
        titles = {job: t for job, t, _ in fetch_joblist_rows(sh, a.client)}
    keep, drop = split_layer3_by_title(prev, a.title, titles)

    if keep:
        # 回答を先頭に出す。質問文を先に置くと、読む人には白紙で聞き直された
        # ようにしか見えず「もう答えたのに」となる（実測）。
        # 質問文も残す。回答だけだと「前回は『必須』でした」となり、
        # 何の話か分からないまま渡すことになる。
        print("\n■ 層3：すでに回答がある項目"
              "（**変更がなければ回答不要**と添えて出す。白紙で聞き直さない）:")
        for r in keep:
            print(f"  - 前回この事業所の回答:「{r[6]}」（案件{r[3]}）")
            print(f"      {r[5]}")
        print("  ※職種・勤務地・時間帯が前回と変わる案件では、"
              "上の回答が変わりうる。変わる項目だけ理由を添えて確認する。")

    if drop:
        print(f"\n■ 層3：**別の職種の案件の回答。流用しない**"
              f"（今回の職種は「{a.title}」）:")
        for r in drop:
            was = (r[9] if len(r) > 9 and r[9] else "") or titles.get(r[3], "")
            print(f"  - 案件{r[3]}「{was or '（職種が分からない行）'}」の回答:「{r[6]}」")
            print(f"      {r[5]}")
        print("  ※同じ事業所でも仕事が違えば、手積み・資格・服装・立ち仕事かどうかは変わる。")
        print("  ※「前回はこうでした」と出さず、**通常の質問として聞き直してください。**")

    print("※層3で前回回答が無いものは通常の質問として聞く。")
    if not a.title:
        print("（--title に依頼フォーマットの「職種」を渡すと、"
              "上の層3が今回の職種の回答かどうかを判定します）")


def cmd_append(a):
    records = json.load(open(a.rows, encoding="utf-8"))
    today = a.date or datetime.now().strftime("%Y-%m-%d")
    rows = to_rows(records, a.site, a.office, a.job, today, a.author,
                   catalog=load_catalog(a.client), title=a.title or "")
    sid, sheet = load_hearing_log(a.client)
    sh = build_service()
    sh.values().append(
        spreadsheetId=sid, range=f"{sheet}!A:J",
        valueInputOption="USER_ENTERED", insertDataOption="INSERT_ROWS",
        body={"values": rows}).execute()
    n_open = sum(1 for r in rows if r[7] != "確認済み")
    print(f"{len(rows)}件を追記しました（うち未回答・要再確認 {n_open}件）。")


def load_joblist(client):
    """Joblist のスプレッドシートIDとシート名。求人メモ列の位置も返す。

    求人メモは 265列目（JE列）。config の range が A1:IE(239列) で止まっていたため
    長らく読めていなかった。ここでは range に依存せず列指定で取りにいく。
    """
    path = os.path.join(HERE, "..", "references", "clients", client, "config.json")
    cfg = json.load(open(path, encoding="utf-8"))
    sp = cfg.get("spreadsheet", {})
    return sp.get("id"), sp.get("sheetName") or "Sheet1", sp.get("memoColumn") or "JE"


def fetch_joblist_rows(sh, client):
    """Joblist から (求人番号, 職種名, 求人メモ) を全件返す。ヘッダー行は落とす。

    求人メモには請求単価・支払単価が入る。呼び出し側は site_from_memo() で社名だけを
    取り出すこと。**生のまま表示・出力しない。**
    """
    jid, jsheet, memo_col = load_joblist(client)
    res = sh.values().batchGet(
        spreadsheetId=jid,
        ranges=[f"{jsheet}!A:A", f"{jsheet}!H:H",
                f"{jsheet}!{memo_col}:{memo_col}"]).execute().get("valueRanges", [])
    cols = [[(row[0] if row else "") for row in v.get("values", [])] for v in res]
    n = max((len(c) for c in cols), default=0)
    cols = [c + [""] * (n - len(c)) for c in cols]
    return [r for r in list(zip(cols[0], cols[1], cols[2]))[1:] if r[0]]


def split_layer3_by_title(prev, want_title, titles):
    """層3の既回答を「流用してよい」「別の職種なので流用しない」に分ける。

    層3は案件限りの回答である。同じ派遣先・同じ事業所でも、職種が変われば
    手積みの有無・必要な資格・服装・立ち仕事かどうかはまるごと変わる。
    それを「前回この事業所の回答」として出すと、**別の仕事の事実が新しい原稿に混ざる。**
    案件番号から Joblist の職種名を引き、依頼された職種と近くない案件の回答は
    流用側に置かない。

    職種はまず行のJ列（履歴に記録した職種）を見る。無い行だけ titles
    （{案件番号: Joblistの職種名}）で補う。J列を優先するのは、新規案件だと
    Joblist に行が無く titles で引けないためである。
    どちらでも職種が分からない行は流用させない
    （判定できないものを「前回の回答」として渡さない）。
    want_title が空なら判定材料が無いので全件を流用側に置く（従来動作のまま）。
    """
    if not want_title:
        return list(prev), []
    keep, drop = [], []
    for r in prev:
        actual = (r[9] if len(r) > 9 and r[9] else "") or titles.get(r[3], "")
        ok = bool(actual) and title_overlap(want_title, actual) >= TITLE_MATCH_MIN
        (keep if ok else drop).append(r)
    return keep, drop


def cmd_resolve(a):
    """派遣先名から案件番号を引き当てる。履歴を第一、求人メモを第二の根拠にする。

    どちらも確定はしない。フロントは案件番号を言わない前提なので、候補を出して
    人に選んでもらう。勝手に1件へ決め打つと、別の派遣先の原稿を書き換えかねない。
    """
    sh = build_service()

    # 1) ヒアリング履歴の逆引き。過去に出稿していれば派遣先・事業所・案件番号が揃っている。
    sid, sheet = load_hearing_log(a.client)
    values = sh.values().get(spreadsheetId=sid,
                             range=f"{sheet}!A:J").execute().get("values", [])
    hist = filter_rows(values, a.site, a.office or "") if values else []
    jobs = sorted({r[3] for r in hist if r[3]})
    if jobs:
        print(f"■ ヒアリング履歴の案件番号: {', '.join(jobs)}")
        for j in jobs:
            offices = sorted({r[2] for r in hist if r[3] == j and r[2]})
            print(f"  - {j}（事業所: {'／'.join(offices) or '未記録'}）")
    else:
        print("■ ヒアリング履歴に該当なし。初回の派遣先・事業所として扱う。")

    # 2) Joblist の求人メモ。人が手で書く欄なので確定根拠にはしない。
    hit = match_jobs(fetch_joblist_rows(sh, a.client), a.site, a.title)
    if hit:
        print(f"\n■ 求人メモからの候補: {len(hit)}件")
        for job, title, name, score in hit:
            mark = "" if not a.title else (
                "  ← 職種一致" if score >= TITLE_MATCH_MIN
                else f"  ← ⚠ 依頼の職種と一致しません（近さ {score:.2f}）")
            print(f"  - {job} {title}（メモの社名: {name}）{mark}")
        print("※メモは人が手で書く欄です。確定せず、この候補で合っているか人に確認してください。")

        if a.title and not any(s >= TITLE_MATCH_MIN for *_, s in hit):
            print(f"\n⚠ 派遣先「{a.site}」は一致しましたが、依頼された職種"
                  f"「{a.title}」に一致する既存求人がありません。")
            print("  上の候補を勝手に選ばないでください。別の仕事を書き換えることになります。")
            print("  「既存求人のリライト」か「新規案件」かを人に確認してから進めてください。")
    else:
        print("\n■ 求人メモに一致なし。新規案件として扱う。")
        print(f"  タブ名は「{datetime.now().strftime('%Y%m%d')}_{a.site}」の仮名を使い、"
              "AirWork採番後に案件番号へリネームしてください。")

    if not a.title:
        print("\n（--title に依頼フォーマットの「職種」を渡すと、"
              "職種が合っているかも一緒に判定します）")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--self-test", action="store_true")
    sub = p.add_subparsers(dest="cmd")

    r = sub.add_parser("read")
    r.add_argument("--client", default="foot")
    r.add_argument("--site", required=True)
    r.add_argument("--office")
    r.add_argument("--title", help="依頼フォーマットの「職種」。渡すと層3の回答が"
                                   "今回の職種のものかを判定する")
    r.set_defaults(func=cmd_read)

    w = sub.add_parser("append")
    w.add_argument("--client", default="foot")
    w.add_argument("--site", required=True)
    w.add_argument("--office", required=True)
    w.add_argument("--job", required=True)
    w.add_argument("--rows", required=True)
    w.add_argument("--title", required=True,
                   help="依頼フォーマットの「職種」。J列に残す。次のセッションで"
                        "層3の回答を流用してよいかの判定に使うので省略できない")
    w.add_argument("--author", default="Codex")
    w.add_argument("--date")
    w.set_defaults(func=cmd_append)

    v = sub.add_parser("resolve")
    v.add_argument("--client", default="foot")
    v.add_argument("--site", required=True)
    v.add_argument("--office")
    v.add_argument("--title", help="依頼フォーマットの「職種」。渡すと職種の一致も判定する")
    v.set_defaults(func=cmd_resolve)

    a = p.parse_args()
    if a.self_test:
        _self_test()
        return
    if not getattr(a, "func", None):
        p.print_help()
        sys.exit(1)
    a.func(a)


if __name__ == "__main__":
    main()
