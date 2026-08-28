#!/usr/bin/env python3
"""Secure temporary-file helper for Job Copy.

On macOS/Linux, sensitive job-copy data stays below /tmp. On Windows, /tmp
does not exist, so the only accepted location is
%LOCALAPPDATA%\JobCopy\tmp. That folder is below the signed-in user's local
profile, not Desktop, Documents, or a cloud-synced folder.
"""

import argparse
import json
import os
import stat
import subprocess
import tempfile

WINDOWS = os.name == "nt"


def _default_out_dir():
    if not WINDOWS:
        return "/tmp"
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA が見つかりません。Windows のユーザープロファイルを確認してください。")
    return os.path.join(local_app_data, "JobCopy", "tmp")


OUT_DIR = os.path.abspath(_default_out_dir())


def _is_under(root, candidate):
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False


def _is_reparse_point(path):
    metadata = os.lstat(path)
    attributes = getattr(metadata, "st_file_attributes", 0)
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(flag and attributes & flag)


def _ensure_private_root():
    os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
    if os.path.islink(OUT_DIR) or _is_reparse_point(OUT_DIR):
        raise RuntimeError(f"一時領域がリンクです: {OUT_DIR}")
    if not WINDOWS:
        return

    user = os.environ.get("USERNAME")
    if not user:
        raise RuntimeError("USERNAME が見つかりません。Windows のユーザー名を確認してください。")

    completed = subprocess.run(
        [
            "icacls", OUT_DIR,
            "/inheritance:r",
            "/grant:r", f"{user}:(OI)(CI)F",
            "/grant:r", "*S-1-5-18:(OI)(CI)F",
            "/grant:r", "*S-1-5-32-544:(OI)(CI)F",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "一時領域のアクセス権を設定できませんでした: "
            + (completed.stderr or completed.stdout).strip()
        )


def _assert_no_reparse_points(root, candidate):
    relative = os.path.relpath(candidate, root)
    if relative in (".", ""):
        return
    current = root
    for part in relative.split(os.sep):
        current = os.path.join(current, part)
        if not os.path.lexists(current):
            break
        if os.path.islink(current) or _is_reparse_point(current):
            raise ValueError(f"パスにリンクまたはジャンクションが含まれています: {current}")


def require_tmp_path(path, what="ファイル"):
    """Return an absolute path only when it is inside the private temp root."""
    _ensure_private_root()
    resolved = os.path.abspath(path)
    if not _is_under(OUT_DIR, resolved) or resolved == OUT_DIR:
        raise ValueError(
            f"{what}は {OUT_DIR} 配下にしてください"
            "（実データを Drive・Desktop・Documents 配下に置かない）: "
            f"{resolved}"
        )

    _assert_no_reparse_points(OUT_DIR, resolved)
    real_parent = os.path.realpath(os.path.dirname(resolved))
    real_root = os.path.realpath(OUT_DIR)
    if not _is_under(real_root, real_parent):
        raise ValueError(f"{what}が一時領域の外を指しています: {resolved} -> {real_parent}")
    if os.path.lexists(resolved) and (os.path.islink(resolved) or _is_reparse_point(resolved)):
        raise ValueError(f"{what}がリンクまたはジャンクションです: {resolved}")
    return resolved


def secure_write_tmp(output_path, content):
    """Write UTF-8 content only below OUT_DIR."""
    resolved = require_tmp_path(output_path, "出力先")
    os.makedirs(os.path.dirname(resolved), mode=0o700, exist_ok=True)
    _assert_no_reparse_points(OUT_DIR, resolved)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(resolved, flags, 0o600)
    try:
        try:
            os.fchmod(fd, 0o600)
        except AttributeError:
            os.chmod(resolved, 0o600)
        os.write(fd, content.encode("utf-8"))
    finally:
        os.close(fd)
    return resolved


def dump_tmp_json(output_path, obj):
    return secure_write_tmp(output_path, json.dumps(obj, ensure_ascii=False))


def load_tmp_json(path, what="入力"):
    with open(require_tmp_path(path, what), encoding="utf-8") as handle:
        return json.load(handle)


def _self_test():
    def denied(path, why):
        try:
            require_tmp_path(path)
        except ValueError:
            return
        raise AssertionError(f"通してはいけないパスを通した（{why}）: {path}")

    denied(os.path.expanduser("~/Drive/items.json"), "ホーム配下")
    denied(os.path.join(os.path.expanduser("~"), "Documents", "items.json"), "Documents配下")
    denied(os.path.join(os.path.dirname(OUT_DIR), "outside.json"), "一時領域外")

    with tempfile.TemporaryDirectory(dir=OUT_DIR) as directory:
        target = os.path.join(directory, "x.json")
        assert dump_tmp_json(target, {"a": "あ"}) == os.path.abspath(target)
        assert load_tmp_json(target) == {"a": "あ"}

        link = os.path.join(directory, "escape")
        try:
            os.symlink(os.path.expanduser("~"), link)
        except OSError:
            pass
        else:
            denied(os.path.join(link, "items.json"), "リンクで外へ出る")

    print("self-test OK")


def main():
    parser = argparse.ArgumentParser(description="実データの入出力をユーザー専用一時領域に限る門番")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--check", help="このパスが実データの入出力先として使えるかを見る")
    args = parser.parse_args()
    if args.self_test:
        _self_test()
        return
    if args.check:
        print(require_tmp_path(args.check))
        return
    parser.error("--self-test か --check を指定してください")


if __name__ == "__main__":
    main()
