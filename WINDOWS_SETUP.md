# Windows native / Codex アプリ用セットアップ

この互換版は、Windows native の Codex アプリで使うためのものです。WSL を選んだり、Ubuntu のターミナルを開いたりする必要はありません。

## Codex で開く場所

Codex アプリで、この互換版のフォルダをプロジェクトとして開きます。

    job-copy-foot-main
    └── .agents
        └── skills
            └── job-copy

Codex の実行環境は Windows native のままにします。

## 必要な実行環境

- Node.js 20 以上
- Python 3（この端末には既に導入済み）
- Git for Windows（履歴を残すため。スキル実行自体の前提ではない）

Node.js と Python の追加ライブラリは、Codex が必要な時点で案内します。Google アカウントへのログインや権限付与が必要になる操作は、必ず画面で本人に確認します。

## 実データの保管場所

元の配布物にある /tmp は Linux/macOS 専用です。この互換版では、Python と Node の処理が自動的に次の場所だけを使います。

    %LOCALAPPDATA%\JobCopy\tmp

この場所は Desktop・Documents・Google Drive の外です。初回使用時に、現在の Windows ユーザー、SYSTEM、管理者だけが読めるアクセス権を設定します。

以降の元資料中の /tmp/ファイル名 は、Windowsでは上の一時領域内の同名ファイルを指します。Windows native で /tmp をそのまま指定してはいけません。

## 日常の依頼方法

Codex のチャットで、次の7項目を伝えます。Codex が必要な処理を実行し、Google Drive の読み書きが発生する直前には確認します。

    ■ 派遣先        ：
    ■ 事業所        ：
    ■ 職種          ：
    ■ 任せる仕事     ：
    ■ 勤務時間・シフト：
    ■ 時給          ：
    ■ 採用予定人数   ：

## ブランチと更新

このフォルダは配布元の main を直接変更しません。Git for Windows の導入後に、windows-native-compat ブランチで変更理由と互換処理を記録します。配布元が更新されたら、その変更を確認してこの互換版へ反映します。

## Google連携用ライブラリ

Google スプレッドシートと Google ドキュメントを扱うには、Python に google-api-python-client と google-auth が必要です。この端末では PyPI への接続が Windows のネットワーク権限で拒否されたため、ネットワーク方針またはプロキシの設定後に導入します。これは Googleアカウントの権限とは別の、Pythonからの外部通信に関する端末設定です。
