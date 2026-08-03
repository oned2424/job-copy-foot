# -*- coding: utf-8 -*-
"""クライアント設定（references/clients/{id}/config.json）の読み書きと、
Drive/SheetsのURLからIDを取り出す処理をまとめる。

各スクリプトが個別に config.json のパスを組み立てると、
クライアントを増やしたときに直し忘れが出る。ここ1箇所に集める。

  python3 client_config.py --self-test
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REFS = os.path.join(HERE, "..", "references")

# https://docs.google.com/spreadsheets/d/{ID}/edit
# https://docs.google.com/document/d/{ID}/edit
# https://drive.google.com/drive/folders/{ID}?usp=sharing
URL_ID = re.compile(r"/(?:d|folders)/([A-Za-z0-9_-]{20,})")
BARE_ID = re.compile(r"^[A-Za-z0-9_-]{20,}$")


def clients_dir():
    return os.path.join(REFS, "clients")


def config_path(client):
    return os.path.join(clients_dir(), client, "config.json")


def known_clients():
    d = clients_dir()
    if not os.path.isdir(d):
        return []
    return sorted(x for x in os.listdir(d)
                  if os.path.isfile(os.path.join(d, x, "config.json")))


def load_config(client):
    path = config_path(client)
    if not os.path.exists(path):
        raise SystemExit(
            f"{client} の config.json がありません: {path}\n"
            f"    既知のクライアント: {', '.join(known_clients()) or '（なし）'}\n"
            f"    新規なら: python3 init_client.py --client {client}")
    return json.load(open(path, encoding="utf-8"))


def save_config(client, cfg):
    path = config_path(client)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def extract_id(text):
    """URLでもIDでも受け取ってIDを返す。取れなければ None。

    フロントはURLをそのまま貼る。IDだけ抜いて渡せと言うと必ず事故る
    （`?usp=sharing` を含めたまま貼られる、`/edit#gid=0` が付く）。
    """
    s = (text or "").strip()
    if not s:
        return None
    m = URL_ID.search(s)
    if m:
        return m.group(1)
    return s if BARE_ID.match(s) else None


def output_folder(client, cfg=None):
    """出稿用ドキュメントの保存先フォルダID。init_client.py が書く。"""
    cfg = cfg or load_config(client)
    fid = (cfg.get("drive") or {}).get("outputFolderId")
    if not fid:
        raise SystemExit(
            f"{client}/config.json に drive.outputFolderId がありません。\n"
            f"    python3 init_client.py --client {client} で設定してください"
            f"（--folder で直接渡すこともできます）")
    return fid


def whoami(cred, drive=None):
    """いまどのアカウントとしてAPIを叩いているかを1行で返す。

    ADC（人のアカウント）は「誰として動いているか」が見えないまま権限だけ広い。
    サービスアカウントとの取り違えも起きるので、初期設定と疎通確認で必ず表示する。
    """
    sa = getattr(cred, "service_account_email", None)
    if sa:
        return f"サービスアカウント: {sa}"
    if drive is not None:
        try:
            u = drive.about().get(fields="user(emailAddress)").execute()
            return f"ユーザー認証（ADC）: {u['user']['emailAddress']}"
        except Exception:
            pass
    return "ユーザー認証（ADC）: アカウント不明"


def _self_test():
    assert extract_id("https://docs.google.com/spreadsheets/d/1yLxgGmajRyZO6RmKX19bz"
                      "vIKzCtCEhz3hLvKbf7FGQY/edit?usp=sharing#gid=420701458"
                      ) == "1yLxgGmajRyZO6RmKX19bzvIKzCtCEhz3hLvKbf7FGQY"
    assert extract_id("https://docs.google.com/document/d/1Ht6eqgl-6A7Z5oArIa45tYHM6"
                      "um8NEQGtavR4Jp2HgM/edit") == "1Ht6eqgl-6A7Z5oArIa45tYHM6um8NEQGtavR4Jp2HgM"
    assert extract_id("https://drive.google.com/drive/folders/14iwPxbz1WpgHDlnWjnZVi"
                      "zRk5pnma9yO?usp=sharing") == "14iwPxbz1WpgHDlnWjnZVizRk5pnma9yO"
    assert extract_id("  14iwPxbz1WpgHDlnWjnZVizRk5pnma9yO  ") == "14iwPxbz1WpgHDlnWjnZVizRk5pnma9yO"
    for ng in ("", "   ", "12204054", "乙川運送", None):
        assert extract_id(ng) is None, ng

    assert "foot" in known_clients()
    cfg = load_config("foot")
    assert cfg["clientId"] == "foot"

    try:
        load_config("__no_such_client__")
        raise AssertionError("存在しないクライアントを素通ししている")
    except SystemExit:
        pass

    class SA:
        service_account_email = "bot@x.iam.gserviceaccount.com"
    assert whoami(SA()).startswith("サービスアカウント:")
    assert whoami(object()) == "ユーザー認証（ADC）: アカウント不明"
    print("self-test OK")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--self-test", action="store_true")
    if p.parse_args().self_test:
        _self_test()
    else:
        p.error("--self-test 以外の使い方はありません（他スクリプトから import します）")
