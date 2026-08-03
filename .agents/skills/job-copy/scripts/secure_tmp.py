#!/usr/bin/env python3
"""実データのJSON/CSVを /tmp の外に置かせないための門番。

派遣先の求人データ（社名・住所・原稿本文・請求単価）は Drive 配下に一切残さない。
残ると Drive の同期でクライアント外へ複製され、取り消せない。

各スクリプトが自前で判定を書くと、片方だけ直したときに静かに穴が空く。
ここが唯一の実装で、read_contract / collect_siblings / apply_plan / precheck_doc /
make_entry_doc はこれを呼ぶ。

macOS の /tmp は /private/tmp への symlink。パス文字列の判定（symlink を解決しない）と
実体の判定（解決する）の両方を通す。片方だけだと macOS で誤判定する。

  $ python3 scripts/secure_tmp.py --self-test
"""

import argparse
import json
import os

OUT_DIR = "/tmp"
# macOS では /tmp -> /private/tmp。どちらの書き方で渡されても通す。
_ROOTS = (OUT_DIR, os.path.realpath(OUT_DIR))


def _is_under(root, candidate):
    return candidate == root or candidate.startswith(root.rstrip(os.sep) + os.sep)


def require_tmp_path(path, what="ファイル"):
    """実データの入出力先が /tmp 配下かを確かめて、絶対パスを返す。

    `/tmp/../Users/...` や、`/tmp/link -> ~/Drive/...` のような
    symlink 経由の抜け道もここで塞ぐ。
    """
    resolved = os.path.abspath(path)
    if not any(_is_under(r, resolved) for r in _ROOTS):
        raise ValueError(f"{what}は {OUT_DIR} 配下にしてください"
                         f"（実データを Drive 配下に置かない）: {resolved}")
    # 親ディレクトリの実体を見る。ファイル自身は未作成のこともあるので親で判定する。
    real_parent = os.path.realpath(os.path.dirname(resolved))
    if not any(_is_under(os.path.realpath(r), real_parent) for r in _ROOTS):
        raise ValueError(f"{what}が {OUT_DIR} の外を指しています: {resolved} -> {real_parent}")
    if os.path.islink(resolved):
        raise ValueError(f"{what}が symlink です: {resolved}")
    return resolved


def secure_write_tmp(output_path, content):
    """/tmp 配下に 0600 で書く。書けたパスを返す。"""
    resolved = require_tmp_path(output_path, "出力先")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(resolved, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, content.encode("utf-8"))
    finally:
        os.close(fd)
    return resolved


def dump_tmp_json(output_path, obj):
    """実データのJSONを /tmp 配下に 0600 で書く。"""
    return secure_write_tmp(output_path, json.dumps(obj, ensure_ascii=False))


def load_tmp_json(path, what="入力"):
    """実データのJSONを /tmp 配下からだけ読む。

    Drive 配下の JSON を読めてしまうと、そこに実データを置く運用が生まれる。
    読めなくしておけば置かれない。
    """
    return json.load(open(require_tmp_path(path, what), encoding="utf-8"))


def _self_test():
    import contextlib
    import tempfile

    def denied(path, why):
        try:
            require_tmp_path(path)
        except ValueError:
            return
        raise AssertionError(f"通してはいけないパスを通した（{why}）: {path}")

    denied(os.path.expanduser("~/Drive/items.json"), "ホーム配下")
    denied("/tmp/../Users/apple/items.json", "..で外へ出る")
    denied("/var/tmp/items.json", "/tmp ではない")
    denied("/etc/job-copy_items.json", "/tmp ではない")

    # 相対パスは cwd 次第。cwd が /tmp のときに通るのは正しいので、
    # 「Drive 配下で作業している」状況を作って確かめる。
    with contextlib.chdir(os.path.expanduser("~")):
        denied("items.json", "相対パス（cwdはDrive配下）")

    # /tmp も /private/tmp も同じ場所として通る。
    assert require_tmp_path("/tmp/items.json") == "/tmp/items.json"
    require_tmp_path("/private/tmp/items.json")

    with tempfile.TemporaryDirectory(dir=OUT_DIR) as d:
        target = os.path.join(d, "x.json")
        assert dump_tmp_json(target, {"a": "あ"}) == os.path.abspath(target)
        assert os.stat(target).st_mode & 0o777 == 0o600, "0600 で書けていない"
        assert load_tmp_json(target) == {"a": "あ"}

        # symlink で /tmp の外へ逃がす経路を塞ぐ。
        link = os.path.join(d, "escape")
        os.symlink(os.path.expanduser("~"), link)
        denied(os.path.join(link, "items.json"), "symlinkで外へ出る")

        # ファイル自身が symlink の場合も書かせない。
        flink = os.path.join(d, "f.json")
        os.symlink("/etc/hosts", flink)
        denied(flink, "出力先がsymlink")

    print("self-test OK")


def main():
    p = argparse.ArgumentParser(description="実データの入出力を /tmp 配下に限る門番")
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--check", help="このパスが実データの入出力先として使えるかを見る")
    a = p.parse_args()
    if a.self_test:
        _self_test()
        return
    if a.check:
        print(require_tmp_path(a.check))
        return
    p.error("--self-test か --check を指定してください")


if __name__ == "__main__":
    main()
