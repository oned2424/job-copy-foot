# -*- coding: utf-8 -*-
"""出稿用ドキュメントに転記する**前**に、原稿の中身を検査する。

**ここを通らないとドキュメントは作られない。** make_entry_doc.py が内部で呼ぶ。
飛ばすオプションは用意していない。チェックを外せるようにすると、
急いでいるときほど外され、外したことは誰も覚えていない。

lint_copy.mjs との違い:
  lint_copy   … 掲載してよい表現か（法令・NG語・体裁）を1本の原稿について見る
  precheck_doc … 掲載してよい**変更**か（減っていないか・依頼どおりか）を
                 現在値・依頼・兄弟求人と突き合わせて見る

2026-08-03 の甲山機工のテストで通ってしまった事故:
  - 掲載中の「土日休み・連休あり・身体の負担少なめ」が消える指示になった（P1）
  - 給与上限3000円が消え、2000円固定になった（P1）
  - 依頼に「1名」とあるのに採用予定人数が空のままだった（P3）
  - 依頼の勤務時間 8:00-17:00 が、掲載中の2交替と食い違うまま素通しされた（P4）
  - 職種名が「時給2000円・8時17時のリフト作業」になった（P5）
  - 15欄の合計が目標1135字に対して420字（37%）だった（P8）
これらを全部ここで止める。

  python3 precheck_doc.py --items /tmp/items176_selected.json \
      --current /tmp/current.json --request /tmp/request.json \
      [--siblings /tmp/siblings.json] [--meta /tmp/items176_selected.json.meta.json] \
      [--allow-shrink 24,64] [--confirmed hours,wage] --client foot

  python3 precheck_doc.py --self-test

--request のJSON（依頼フォーマット7項目をそのまま写す）:
  {"site":"甲山機工","office":"X市","title":"リフトで出荷作業",
   "duty":"倉庫作業","hours":"8:00-17:00","wage":"2000円","hires":"1名"}

終了コード: NGが1件でもあれば 1。WARN だけなら 0（表示はする）。
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from secure_tmp import load_tmp_json  # noqa: E402

NO_INPUT = "（入力なし）"
DELETE_PREFIX = "【削除】"
REVIEW_PREFIX = "【要確認】"
MARKERS = {NO_INPUT, "（社内管理用。触らない）", "（変更なし）"}
BLANKS = {"", "—", "-", "―", "ー", "－"}

# 原稿づくりで触ってはいけない項目。apply_plan.FROZEN と同じ。
# items JSON を手で作られたときの二重防御としてここでも見る。
FROZEN = {"1", "15", "16", "17", "18", "19", "35", "38", "68",
          "102", "103", "106", "107", "108", "130", "134"}

# 読者に向けた本文。ここに年齢・性別を書くと応募資格の制限とみなされる。
# 職場情報タグ（No.23）は別枠なので対象にしない。
BODY_NOS = {"3", "33", "7", "28"}
# No.3/33/7/28 以外にも応募者に表示される欄はある。
# 「職場環境の補足説明に30代活躍中」のように、本文4欄を避けて別欄に年代が入ると、
# 表示上は同じ求人票に年齢の記述が載る。ここも見ないと P6 は素通りする。
# ただし現在値をそのまま残しただけの欄まで NG にすると、
# 過去の掲載内容が原因でドキュメントが作れなくなる。だから
#   今回書き換えた欄 → NG（自分で入れたのだから直せる）
#   現在値を残した欄 → WARN（人が判断して書き換える）
# と分ける。
DISPLAY_NOS = {"22", "24", "63", "64", "88", "90", "97", "99", "153", "155"}
# 同じ派遣先の他求人の素材で埋まる見込みがある欄。
# No.3 職種名は依頼文、No.99 契約更新期間と No.153 試用期間は契約書、
# No.22 喫煙区分は媒体データ、No.155 選考フローは自社の定型で決まる。
# これらを「素材が余っています」と言っても打つ手が無いので P11 の対象から外す。
SIBLING_FILLABLE = {"7", "24", "28", "88", "90", "97"}
# 雇用対策法10条・男女雇用機会均等法5条・職安法5条の5。例外なし。
# 国籍は「歓迎」でも「不問」でも書けない。書いた時点で国籍を選考の軸にしたことになる。
# 3つめは「今の掲載値のままなら WARN に落としてよいか」。
# 年代は No.23 の職場情報タグに逃がせるので、こちらが書き換えていない欄は WARN でよい。
# 性別・国籍はタグにも逃がせない。掲載中の値でも、そのまま出せば違法な原稿になる。
# 「不問」と書けば安全、ではない。「年齢不問」「性別不問」は違法ではないが、
# 書いた時点で読者にその軸を意識させる。年代は No.23 の職場情報タグへ逃がす設計なので、
# 本文に年齢・性別の語が出る理由がそもそも無い。語ごと拾う。
AGE_SEX_NG = [
    (r"[0-9０-９]{2}\s*代", "年代", True),
    (r"年齢|年令|お年", "年齢", True),
    (r"若[いく手者]", "年齢の含み", True),
    (r"シニア|ミドル|ベテラン層", "年齢の含み", True),
    (r"性別|男性|女性|男女|女子|男子", "性別", False),
    (r"学生|主婦|主夫", "属性の限定", True),
    # 「日本籍歓迎」「永住者の方」は国籍で選ぶと書いたのと同じ。
    # 「国籍」の語を含まない言い換えを並べておかないと素通りする。
    (r"国籍|日本人|日本籍|外国人|外国籍|留学生|技能実習|特定技能|在留|ビザ|VISA"
     r"|永住者|永住権|定住者|帰化|日系人", "国籍", False),
]

# 職種名は検索されるための欄。条件は別の欄が持つ。
TITLE_NG = [
    (r"時給|月給|日給|[0-9０-９][0-9０-９,，]*\s*円", "金額"),
    (r"[0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2}|[0-9０-９]{1,2}\s*時\s*[0-9０-９]{1,2}\s*時", "時刻"),
]

# 媒体本文として不自然な言い回し（`references/writing-style.md` の正本はここ）。
# 求人原稿は説明書ではない。読者は条件を確かめに来ているが、
# 「〜を確認したうえで」と書かれると、読む前に手続きを命じられた感じになる。
STIFF = [
    (r"を確認したうえで|を踏まえたうえで|を考慮したうえで|したうえで", "「〜したうえで」は指示口調"),
    (r"となっております|しております(?!ます)", "「〜ております」は硬い"),
    (r"を想定しています|を想定しております", "「想定」は書き手の都合"),
    (r"する形になります|という形です", "「〜という形」は輪郭がぼける"),
    (r"本求人|今回の求人|この求人では|当求人", "原稿の外側に言及している"),
    (r"求職者|応募者の方は|候補者", "読者を三人称で呼んでいる"),
    (r"については、|に関しては、|に関しまして", "「〜については」は説明文の接続"),
    (r"という点で|という面で", "「〜という点で」は分析口調"),
    (r"以下のとおり|下記のとおり|上記の", "本文に箇条書きの案内は要らない"),
]
LONG_SENT = 60          # 1文がこれを超えると読点で息が切れる
LONG_SENT_MAX = 2       # 長い文がこれを超えたら WARN

# 同じ事実を欄をまたいで繰り返していないか見るときの一致長
REPEAT_LEN = 8
REPEAT_FIELDS = 3       # 同じ断片が何欄に出たら反復とみなすか

FILL_RATIO = 0.6        # 15欄の合計が目標のこれ未満なら WARN

# 全角数字と全角コロンだけ半角に寄せる。
# 長音符「ー」やダッシュ「―」は変換しない。「リーチ式」が「リ-チ式」になって
# NGメッセージに化けて出るし、BLANKS の判定は変換しなくても素通りする。
Z2H = str.maketrans("０１２３４５６７８９：", "0123456789:")


def norm(v):
    """比較用に均す。全角数字・空白・記号の揺れで判定を変えない。"""
    s = str(v or "").translate(Z2H)
    s = s.replace("　", " ")
    return re.sub(r"\s+", " ", s).strip()


def is_blank(v):
    return norm(v) in BLANKS


def is_marker(v):
    """事務員への指示であって、原稿本文ではない文字列。字数に数えない。"""
    s = str(v or "").strip()
    return s in MARKERS or s.startswith(DELETE_PREFIX) or s.startswith(REVIEW_PREFIX)


def body_len(v):
    """原稿として読者が読む文字数。指示文は 0 と数える。"""
    return 0 if is_marker(v) else len(str(v or "").strip())


def load_roles(root=ROOT):
    """appeal-formula.md に埋めた fieldTargets.roles を読む。

    15欄の項番と目標字数の正本はあのファイルにしかない。
    ここに写経すると、片方だけ直されて静かにズレる。
    """
    path = os.path.join(root, "references", "appeal-formula.md")
    text = open(path, encoding="utf-8").read()
    blocks = re.findall(r"```json\s*\n(.*?)\n```", text, re.S)
    for b in blocks:
        try:
            d = json.loads(b)
        except json.JSONDecodeError:
            continue
        roles = (d.get("fieldTargets") or {}).get("roles")
        if roles:
            return roles
    raise ValueError(f"{path} に fieldTargets.roles が見つかりません")


def digits(v):
    """文字列から数字だけを取り出す。「2000円」「1名」を比べるため。

    賃金には使わない。「1500〜1875円」が「15001875」になり、
    正しく分けて書かれた No.39/No.40 と必ず食い違う。賃金は wage_range() を使う。
    """
    return re.sub(r"[^0-9]", "", norm(v))


def wage_range(v):
    """賃金の書き方の揺れを下限・上限に分ける。

    「2000円」「1500〜1875円」「時給1200円～1500円」「月給20万円」が来る。
    100未満は「1名」「8:00」のような賃金でない数字なので落とす。
    compose_fields.mjs の parseWage() と同じ規則。片方だけ直すとズレる。
    """
    nums = []
    for m in re.finditer(r"([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万)?", norm(v)):
        n = round(float(m.group(1).replace(",", "")) * (10000 if m.group(2) else 1))
        if n >= 100:
            nums.append(str(n))
    return (nums[0] if nums else "", nums[1] if len(nums) > 1 else "")


def times(v):
    """「8:00-17:00」「8時00分〜17時00分」から時刻を拾う。"""
    s = norm(v)
    out = re.findall(r"([0-9]{1,2})\s*[:時]\s*([0-9]{1,2})", s)
    return {f"{int(h)}:{int(m):02d}" for h, m in out}


def as_rows(items):
    """[No., 項目名, 内部キー, 事務員転記] を No. で引ける辞書にする。"""
    return {str(r[0]): {"no": str(r[0]), "label": r[1], "key": r[2],
                        "val": str(r[3]) if len(r) > 3 else ""}
            for r in items[1:]}


def ng(out, cid, msg):
    out.append({"id": cid, "level": "NG", "message": msg})


def warn(out, cid, msg):
    out.append({"id": cid, "level": "WARN", "message": msg})


def check(items, current=None, request=None, siblings=None, meta=None,
          allow_shrink=None, confirmed=None, roles=None):
    """検査結果のリストを返す。呼び出し側が NG の有無で止める。"""
    rows = as_rows(items)
    current = current or {}
    request = request or {}
    confirmed = {c.strip() for c in (confirmed or [])}
    allow = {str(a).strip() for a in (allow_shrink or [])}
    roles = roles or load_roles()
    out = []

    def now_of(no):
        r = rows.get(str(no))
        return norm(current.get(r["key"], "")) if r else ""

    def val_of(no):
        r = rows.get(str(no))
        return r["val"] if r else ""

    # P1 掲載中の情報を減らしていないか
    # 情報が足りないときに既存の掲載内容を削るのはリライトではない。
    # 意図して減らすなら --allow-shrink でNo.を明示させる。
    for role in roles:
        no = str(role["itemNo"])
        v, n = val_of(no), now_of(no)
        if not n or no in allow:
            continue
        if is_marker(v) and str(v).startswith(DELETE_PREFIX):
            ng(out, "P1", f"No.{no} {role['label']}: 掲載中の「{n[:30]}」を消す指示になっています。"
                          f"意図した削除なら --allow-shrink {no} を付けてください")
        elif body_len(v) and body_len(v) < len(n) * 0.7:
            ng(out, "P1", f"No.{no} {role['label']}: {len(n)}字→{body_len(v)}字に減っています。"
                          f"情報が足りないなら今の値を残してください")

    # P2 契約で決まっている条件が書き換わっていないか
    for no in sorted(FROZEN, key=int):
        v, n = val_of(no), now_of(no)
        if not rows.get(no) or not n:
            continue
        if is_marker(v):
            ng(out, "P2", f"No.{no} {rows[no]['label']}: 契約条件を消す指示になっています")
        elif norm(v) != n:
            ng(out, "P2", f"No.{no} {rows[no]['label']}: 契約条件が「{n[:20]}」から"
                          f"「{norm(v)[:20]}」に変わっています")

    # P3 依頼フォーマットの値が原稿に入っているか
    if request.get("hires"):
        want = digits(request["hires"])
        got = digits(val_of("34"))
        if want and got != want:
            now = "空です" if not got else "「" + val_of("34") + "」です"
            ng(out, "P3", f"No.34 採用予定人数: 依頼は「{request['hires']}」ですが、{now}")
    if request.get("wage"):
        want_low, want_high = wage_range(request["wage"])
        got_low = digits(val_of("39")) or digits(now_of("39"))
        if want_low and got_low and got_low != want_low:
            ng(out, "P3", f"No.39 給与額下限: 依頼は「{request['wage']}」ですが「{got_low}」です")
        # 依頼が上限まで書いてきた時だけ上限も見る。下限だけの依頼で上限をNGにすると、
        # 掲載中の上限をそのまま残す正しい原稿が止まる。
        if want_high:
            got_high = digits(val_of("40")) or digits(now_of("40"))
            if got_high and got_high != want_high:
                ng(out, "P3", f"No.40 給与額上限: 依頼は「{request['wage']}」ですが"
                              f"「{got_high}」です")
    if request.get("hours"):
        want = times(request["hours"])
        got = times(val_of("88")) | times(now_of("88"))
        if want and not (want & got):
            ng(out, "P3", f"No.88 勤務時間の補足: 依頼の「{request['hours']}」が"
                          f"どこにも書かれていません")

    # P4 依頼と掲載中の食い違いを確認したか
    # 依頼が「8:00-17:00」なのに掲載中が2交替、という食い違いは
    # 依頼側の書き間違いか、現場が変わったかのどちらかで、原稿の問題ではない。
    # 黙ってどちらかを採用すると、応募者が来てから発覚する。
    if request.get("hours") and now_of("88"):
        want, have = times(request["hours"]), times(now_of("88"))
        if want and have and not (want & have) and "hours" not in confirmed:
            ng(out, "P4", f"勤務時間が食い違っています。依頼「{request['hours']}」／"
                          f"掲載中「{now_of('88')[:30]}」。どちらが正しいか確認し、"
                          f"--confirmed hours を付けてください")
    if request.get("wage") and now_of("39"):
        want, have = wage_range(request["wage"])[0], digits(now_of("39"))
        if want and have and want != have and "wage" not in confirmed:
            ng(out, "P4", f"時給が食い違っています。依頼「{request['wage']}」／"
                          f"掲載中「{have}」。確認して --confirmed wage を付けてください")

    # P5 職種名に条件が混じっていないか
    title = val_of("3")
    if not is_marker(title):
        for pat, what in TITLE_NG:
            if re.search(pat, norm(title)):
                ng(out, "P5", f"No.3 職種名に{what}が入っています（「{title}」）。"
                              f"条件は給与欄・勤務時間欄が持ちます")
                break

    # P6 年齢・性別を本文に書いていないか（雇用対策法10条・均等法5条）
    changed = set((meta or {}).get("changed") or [])
    for no in sorted(BODY_NOS | DISPLAY_NOS, key=int):
        if no not in rows:
            continue
        v = val_of(no)
        if is_marker(v):
            continue
        for pat, what, tagable in AGE_SEX_NG:
            m = re.search(pat, v)
            if not m:
                continue
            where = f"No.{no} {rows[no]['label']}に{what}の表現「{m.group(0)}」があります"
            if no in BODY_NOS or no in changed:
                ng(out, "P6", f"{where}。本文では条件で書いてください")
            elif tagable:
                warn(out, "P6", f"{where}（今の掲載値のまま）。"
                                f"年代は No.23 の職場情報タグに寄せてください")
            else:
                ng(out, "P6", f"{where}（今の掲載値のまま）。"
                              f"{what}はタグにも書けません。この欄から消してください")
            break

    # P7 空セルが残っていないか
    blank = [no for no, r in rows.items() if is_blank(r["val"])]
    if blank:
        ng(out, "P7", f"事務員転記が空の行が {len(blank)} 件あります"
                      f"（No. {', '.join(sorted(blank, key=int)[:10])}）")

    # P8 目標字数に届いているか
    total = sum(body_len(val_of(r["itemNo"])) for r in roles)
    target = sum(r.get("targetMin", 0) for r in roles)
    short = [(str(r["itemNo"]), r["label"], body_len(val_of(r["itemNo"])), r.get("targetMin", 0))
             for r in roles if body_len(val_of(r["itemNo"])) < r.get("targetMin", 0)]
    if target and total < target * FILL_RATIO:
        names = "、".join(f"No.{n} {lb} {c}/{t}字" for n, lb, c, t in short[:5])
        warn(out, "P8", f"15欄の合計が {total}/{target}字（{total * 100 // target}%）です。"
                        f"未達: {names}")
    elif short:
        # 合計が足りていても、欄ごとに見ると空に近い欄が残ることがある。
        # 合計だけ見ていると、長い欄が短い欄を隠して素通りする。
        names = "、".join(f"No.{n} {lb} {c}/{t}字" for n, lb, c, t in short)
        warn(out, "P8", f"目標字数に届いていない欄が {len(short)} 件あります（{names}）。"
                        f"聞けば埋まるものが無いか見てください")

    # P9 同じ事実を欄をまたいで繰り返していないか
    texts = {str(r["itemNo"]): val_of(r["itemNo"]) for r in roles}
    frags = {}
    for no, t in texts.items():
        if is_marker(t):
            continue
        s = norm(t)
        for i in range(0, max(0, len(s) - REPEAT_LEN + 1)):
            frags.setdefault(s[i:i + REPEAT_LEN], set()).add(no)
    repeated = sorted({f for f, nos in frags.items() if len(nos) >= REPEAT_FIELDS})
    if repeated:
        warn(out, "P9", f"同じ言い回しが{REPEAT_FIELDS}欄以上に出ています"
                        f"（例「{repeated[0]}」ほか{len(repeated) - 1}件）。"
                        f"字数を条件の繰り返しで埋めていないか見てください")

    # P10 媒体本文として自然に読めるか
    for no, t in sorted(texts.items(), key=lambda x: int(x[0])):
        if is_marker(t) or not t:
            continue
        for pat, why in STIFF:
            m = re.search(pat, t)
            if m:
                warn(out, "P10", f"No.{no} {rows[no]['label']}: 「{m.group(0)}」— {why}")
                break
        longs = [s for s in re.split(r"[。！？\n]", t) if len(s.strip()) > LONG_SENT]
        if len(longs) > LONG_SENT_MAX:
            warn(out, "P10", f"No.{no} {rows[no]['label']}: {LONG_SENT}字を超える文が"
                             f"{len(longs)}つあります。切って読ませてください")

    # P11 兄弟求人の素材が余っていないか
    if siblings:
        facts = siblings.get("facts") or {}
        pool = sum(len(v) for v in facts.values())
        # 合計が目標に届いていても、欄ごとに見ると未達が残ることがある。
        # 素材が余っている状態で未達欄があるなら、まだ拾えるものがある可能性が高い。
        # ただし未達欄を全部並べても意味がない。職種名は依頼文から、
        # 試用期間や契約更新は契約書から決まる欄で、他求人の素材では埋まらない。
        # 素材で本当に埋まる欄だけを挙げないと、毎回出る無視される警告になる。
        fillable = [x for x in short if x[0] in SIBLING_FILLABLE]
        if pool and (total < target * FILL_RATIO or fillable):
            where = "、".join(f"No.{n}" for n, _, _, _ in fillable[:8]) if fillable else "全体"
            warn(out, "P11", f"同じ派遣先の他求人から素材が {pool} 件集まっているのに、"
                             f"{where} が目標字数に届いていません。"
                             f"（選別を通る素材はこれより少ない場合があります）")
    elif current:
        warn(out, "P11", "兄弟求人の素材（--siblings）が渡されていません。"
                         "collect_siblings.py を先に通すと、"
                         "聞かなくても書ける事実が見つかることがあります")

    if meta:
        for no in meta.get("skipped") or []:
            r = rows.get(str(no))
            if r and not is_blank(current.get(r["key"], "")):
                warn(out, "P12", f"No.{no} {r['label']}: 情報が足りず書けなかったため、"
                                 f"今の掲載値を残しました")
    return out


def report(results):
    """結果を人が読める形で出し、NG件数を返す。"""
    ngs = [r for r in results if r["level"] == "NG"]
    ws = [r for r in results if r["level"] == "WARN"]
    for r in ngs:
        print(f"  NG   [{r['id']}] {r['message']}")
    for r in ws:
        print(f"  WARN [{r['id']}] {r['message']}")
    if not results:
        print("  問題なし")
    print(f"転記前チェック: NG {len(ngs)} 件 / WARN {len(ws)} 件")
    return len(ngs)


def _self_test():
    roles = load_roles()
    assert len(roles) == 15, len(roles)
    assert {str(r["itemNo"]) for r in roles} >= {"3", "7", "28", "33", "88"}

    assert norm("１２３　円") == "123 円"
    assert digits("2000円") == "2000" and digits("1名") == "1"
    assert times("8:00-17:00") == {"8:00", "17:00"}
    assert times("6:30～15:25、17:10～2:05") == {"6:30", "15:25", "17:10", "2:05"}
    assert body_len("（入力なし）") == 0 and body_len("あいう") == 3
    assert is_marker("【削除】今の「x」を消して空欄にする")
    assert is_marker("【要確認】今の「x」は裏が取れていません")
    assert not is_marker("土日休み")

    H = ["No.", "項目名", "内部キー", "事務員転記"]

    def items(**vals):
        base = {"3": ("職種名", "title"), "7": ("仕事内容", "description"),
                "24": ("職場環境", "work_environment"), "28": ("求める人材", "personal"),
                "33": ("キャッチ", "subtitle"), "34": ("採用予定人数", "hires_number"),
                "39": ("給与額下限", "minimum_salary"), "40": ("給与額上限", "maximum_salary"),
                "64": ("給与例", "salary_example"),
                "88": ("勤務時間補足", "working_time_supplement"),
                "90": ("休日補足", "holiday"), "16": ("勤務地名", "working_location_id_jp")}
        return [H] + [[no, lb, key, vals.get(no, "ダミー値")]
                      for no, (lb, key) in base.items()]

    # P1 掲載中の情報を消す指示を止める
    r = check(items(**{"24": "【削除】今の「土日休み・連休あり」を消して空欄にする"}),
              current={"work_environment": "土日休み・連休あり"}, roles=roles)
    assert any(x["id"] == "P1" and x["level"] == "NG" for x in r), r
    # --allow-shrink があれば通す（意図した削除）
    r = check(items(**{"24": "【削除】今の「土日休み・連休あり」を消して空欄にする"}),
              current={"work_environment": "土日休み・連休あり"},
              allow_shrink=["24"], roles=roles)
    assert not any(x["id"] == "P1" for x in r), r
    # 短くなりすぎたのも止める
    r = check(items(**{"7": "リフト作業"}),
              current={"description": "あ" * 200}, roles=roles)
    assert any(x["id"] == "P1" for x in r), r

    # P2 契約条件の書き換えを止める
    r = check(items(**{"16": "別の工場"}),
              current={"working_location_id_jp": "X工場"}, roles=roles)
    assert any(x["id"] == "P2" for x in r), r

    # P3 依頼の採用予定人数が落ちている
    r = check(items(**{"34": NO_INPUT}), request={"hires": "1名"}, roles=roles)
    assert any(x["id"] == "P3" for x in r), r
    r = check(items(**{"34": "1"}), request={"hires": "1名"}, roles=roles)
    assert not any(x["id"] == "P3" for x in r), r
    # 依頼の勤務時間が原稿のどこにも無い
    r = check(items(**{"88": "詳細は面談時に"}), request={"hours": "8:00-17:00"}, roles=roles)
    assert any(x["id"] == "P3" for x in r), r

    # 依頼の賃金がレンジでも、正しく分けて書いた原稿を止めない。
    # digits() で比べていた頃は「1500〜1875円」が「15001875」になり、
    # No.39=1500・No.40=1875 という正しい原稿が毎回 NG で止まっていた。
    assert wage_range("1500〜1875円") == ("1500", "1875")
    assert wage_range("2000円") == ("2000", "")
    assert wage_range("月給20万円") == ("200000", "")
    assert wage_range("1名") == ("", "")
    r = check(items(**{"39": "1500", "40": "1875"}), request={"wage": "1500〜1875円"}, roles=roles)
    assert not any(x["id"] == "P3" for x in r), r
    # 上限まで指定された依頼で上限が違えば止める。
    r = check(items(**{"39": "1500", "40": "3000"}), request={"wage": "1500〜1875円"}, roles=roles)
    assert any(x["id"] == "P3" and "No.40" in x["message"] for x in r), r
    # 下限だけの依頼なら上限は見ない（掲載中の上限を残すのが正しい）。
    r = check(items(**{"39": "2000", "40": "3000"}), request={"wage": "2000円"}, roles=roles)
    assert not any(x["id"] == "P3" for x in r), r

    # P4 依頼と掲載中の食い違い（甲山機工で起きたもの）
    r = check(items(**{"88": "8:00〜17:00"}), request={"hours": "8:00-17:00"},
              current={"working_time_supplement": "6:30～15:25、17:10～2:05"}, roles=roles)
    assert any(x["id"] == "P4" for x in r), r
    r = check(items(**{"88": "8:00〜17:00"}), request={"hours": "8:00-17:00"},
              current={"working_time_supplement": "6:30～15:25、17:10～2:05"},
              confirmed=["hours"], roles=roles)
    assert not any(x["id"] == "P4" for x in r), r

    # P5 職種名に金額・時刻
    r = check(items(**{"3": "時給2000円・8時17時のリフト作業"}), roles=roles)
    assert any(x["id"] == "P5" for x in r), r
    r = check(items(**{"3": "リフトで自動車部品の出荷作業"}), roles=roles)
    assert not any(x["id"] == "P5" for x in r), r

    # P6 年齢・性別を本文に書かない
    for bad in ("20代・30代が活躍中の職場です", "女性が活躍しています", "若い方歓迎"):
        r = check(items(**{"28": bad}), roles=roles)
        assert any(x["id"] == "P6" for x in r), (bad, r)
    r = check(items(**{"28": "フォークリフト運転技能講習修了者を歓迎します"}), roles=roles)
    assert not any(x["id"] == "P6" for x in r), r
    # 本文4欄の外でも見る。今回書き換えた欄なら止める。
    r = check(items(**{"24": "30代が活躍中の職場です"}),
              meta={"changed": ["24"]}, roles=roles)
    assert any(x["id"] == "P6" and x["level"] == "NG" for x in r), r
    # 現在値を残しただけなら止めずに知らせる。過去の掲載内容で作業が止まらないようにする。
    r = check(items(**{"24": "30代が活躍中の職場です"}), meta={"changed": []}, roles=roles)
    assert any(x["id"] == "P6" and x["level"] == "WARN" for x in r), r
    assert not any(x["id"] == "P6" and x["level"] == "NG" for x in r), r
    # No.23 の職場情報タグは年代を書いてよい欄。ここは対象外。
    r = check(items(**{"23": "20代が多い,30代が多い"}), meta={"changed": ["23"]}, roles=roles)
    assert not any(x["id"] == "P6" for x in r), r
    # 国籍。「歓迎」でも「不問」でも書けない（職安法5条の5）。
    for bad in ("日本国籍の方を歓迎します", "国籍不問です", "外国人の方も活躍中"):
        r = check(items(**{"28": bad}), roles=roles)
        assert any(x["id"] == "P6" and x["level"] == "NG" for x in r), (bad, r)
    # 性別・国籍はタグにも逃がせない。掲載中の値のままでも止める。
    for bad in ("女性が活躍しています", "外国籍の方が多い職場です"):
        r = check(items(**{"24": bad}), meta={"changed": []}, roles=roles)
        assert any(x["id"] == "P6" and x["level"] == "NG" for x in r), (bad, r)

    # P7 空セル
    bad = items()
    bad[1][3] = ""
    assert any(x["id"] == "P7" for x in check(bad, roles=roles))

    # P10 説明口調（ユーザー指摘の言い回し）
    r = check(items(**{"28": "時給・勤務時間・休日を確認したうえで、"
                             "リフト資格を活かしたい方に向いています。"}), roles=roles)
    assert any(x["id"] == "P10" for x in r), r
    r = check(items(**{"28": "フォークリフト運転技能講習修了者。時給2000円、8:00〜17:00、"
                             "土日休みの条件で、リフト資格を活かしたい方に向いています。"}),
              roles=roles)
    assert not any(x["id"] == "P10" for x in r), r

    # P9 同じ言い回しが3欄以上
    dup = "土日休みで残業ほぼなしの職場です"
    r = check(items(**{"7": dup, "28": dup, "33": dup}), roles=roles)
    assert any(x["id"] == "P9" for x in r), r

    # report は NG 件数を返す
    assert report([{"id": "P1", "level": "NG", "message": "x"},
                   {"id": "P8", "level": "WARN", "message": "y"}]) == 1
    assert report([]) == 0

    # 実データを Drive 配下から読ませない。読めるようにすると、そこに置く運用が生まれる。
    # 門番の中身は secure_tmp.py が試す。ここで見るのは「呼び忘れていないか」。
    import contextlib
    import io
    import tempfile
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        ok_items = os.path.join(d, "items.json")
        json.dump(items(), open(ok_items, "w", encoding="utf-8"))
        # /tmp の外だと確実に言い切れる場所にする。スクリプトの置き場所から組み立てると、
        # レビュー用に /tmp へコピーしただけでこのテストが落ちる。
        drive = "/etc/job-copy_must_not_be_read.json"
        for opt in ("--items", "--current", "--request", "--siblings", "--meta"):
            argv = ["--items", ok_items] if opt != "--items" else []
            argv_backup, sys.argv = sys.argv, ["precheck_doc.py", opt, drive] + argv
            try:
                with contextlib.redirect_stderr(io.StringIO()), \
                        contextlib.redirect_stdout(io.StringIO()):
                    main()
            except SystemExit as e:
                assert e.code == 1, (opt, e.code)
            else:
                raise AssertionError(f"{opt} に Drive 配下を渡しても止まらなかった")
            finally:
                sys.argv = argv_backup
    print("self-test OK")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--items")
    p.add_argument("--current")
    p.add_argument("--request", help="依頼フォーマット7項目のJSON")
    p.add_argument("--siblings", help="collect_siblings.py の出力")
    p.add_argument("--meta", help="apply_plan.py が出す <output>.meta.json")
    p.add_argument("--allow-shrink", default="",
                   help="意図して情報を減らすNo.（カンマ区切り）")
    p.add_argument("--confirmed", default="",
                   help="依頼と掲載中の食い違いを確認済みの項目（hours,wage）")
    p.add_argument("--client", default="foot")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()

    if a.self_test:
        _self_test()
        return
    if not a.items:
        p.error("--items は必須です")

    # 渡ってくるのは全部クライアントの実データ。/tmp の外からは読ませない。
    # 読めるようにしておくと、そこに実データを置く運用が生まれる。
    def load(path, what):
        return load_tmp_json(path, what) if path else None

    try:
        loaded = (load(a.items, "--items"), load(a.current, "--current"),
                  load(a.request, "--request"), load(a.siblings, "--siblings"),
                  load(a.meta, "--meta"))
    except ValueError as e:
        print(f"NG: {e}", file=sys.stderr)
        sys.exit(1)

    results = check(
        *loaded,
        allow_shrink=[s for s in a.allow_shrink.split(",") if s.strip()],
        confirmed=[s for s in a.confirmed.split(",") if s.strip()])
    if report(results):
        sys.exit(1)


if __name__ == "__main__":
    main()
