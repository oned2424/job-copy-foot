# job-copy 初期設定と実行手順
git URL：
https://github.com/oned2424/job-copy-foot

下記スキルで求人原稿を作ってください。
スキル:
/Users/apple/Library/CloudStorage/GoogleDrive-yuma2433@gmail.com/マイドライブ/ObsidianVault/20_AIカンパニー/事業部/005_岡崎AI会_home/005_PJ/005_人材会社システム/000_共通スキル/.agents/skills/job-copy/SKILL.md

テスト1
■ 派遣先        ：豊臣機工
■ 事業所        ：安城
■ 職種          ：リフトで出荷作業
■ 任せる仕事     ：倉庫作業
■ 勤務時間・シフト：8:00-17:00
■ 時給          ：2000円
■ 採用予定人数   ：1名


この手順書は、FooT様の担当者がスキルを動かせる状態にし、求人原稿の公開前チェック、タグ棚卸し、A〜E 5案の作成までを実行できるようになるまでを説明します。上から順に進めてください。

手順1〜3は**導入時に1回だけ**の作業です。とくに手順3では、スキルが読み書きするスプレッドシートとフォルダをGoogleドライブ側に用意します。**ここを飛ばすとスキルは何も読めません。**手順4以降が日々の作業です。

**Windowsの方は、手順0から始めてください。**macOSの方は手順1からです。

## この手順書を誰がやるか

**手順書をまるごとCodexに渡しても導入は終わりません。**Codexが代われない作業が2つあります。

| 手順 | Codexに任せられるか | 任せられない理由 |
|---|---|---|
| 0. WSL2を用意する | **不可** | PowerShellの管理者実行、パソコンの再起動、Codexの設定画面の操作、アプリの再起動。**そもそも切り替える前のCodexはWindows側にいるので、自分を切り替えられません。** |
| 1. Node.js・Python を入れる | 可 | `sudo` のパスワードだけ人が打つ |
| 2. スキルを配置する | 可 | GitHubの認証だけ人が打つ |
| 3. Googleドライブ側を用意する | **不可** | Airワークからのエクスポート、ドライブでのフォルダ作成、共有相手の追加、鍵ファイルの受け渡し。すべてブラウザ上の操作で、値を持っているのも人です |
| 4. 入力CSVを用意する | 可 | 手順3が終わっていること |
| 5. 動作確認をする | 可 | |

**手順0を人がやり終えてから、この手順書をCodexに渡してください。**
手順3も、必要な4つのURLと鍵ファイルを人が用意したあとであれば、
`init_client.py` の実行そのものはCodexに任せられます。

## 0. Windowsの場合：WSL2を用意する（macOSの方は飛ばす）

このスキルは、Linux と macOS のファイルの扱い方を前提に作ってあります。
実データ（派遣先の社名・住所・原稿）は `/tmp` という一時置き場にしか書かない設計で、
**Windows の PowerShell から直接動かすと `/tmp` が存在しないため、最初のコマンドで止まります。**

Windows では **WSL2** を使います。Windows の中で Ubuntu（Linux）を動かす、
Microsoft 公式の機能です。Codex デスクトップアプリは WSL2 を正式にサポートしており、
切り替えれば **macOS とまったく同じ手順がそのまま通ります。スキル側の改造は要りません。**

### WSL2 を入れる

PowerShell を「管理者として実行」で開き、次を実行します。

```powershell
wsl --install
```

パソコンの再起動を求められたら再起動します。起動後、Ubuntu のウィンドウが自動で開くので、
**Ubuntu用のユーザー名とパスワードを決めます。**
（これは Windows のログインパスワードとは別物です。あとで何度も使うので控えておいてください）

入ったことを確認します。PowerShell で次を実行します。

```powershell
wsl --version
```

`WSL バージョン: 2.x.x` のように **2** で始まれば正常です。
**WSL1 では動きません。**Codex は 0.115 以降、WSL1 のサポートを終了しています。

### Codex アプリを WSL に切り替える

1. Codex（ChatGPT デスクトップアプリ）を開き、**Settings** を開く
2. エージェントの実行環境を **`Windows native` から `WSL` に変更**し、Ubuntu を選ぶ
3. **アプリを再起動する**

再起動しないと切り替わりません。切り替えたかどうかは、Codex に
`uname -a` と打たせて `Linux` と返ってくるかで分かります。
`Microsoft Windows` と返る場合はまだ切り替わっていません。

### 以降のコマンドは、すべて Ubuntu の中で打つ

この手順書に出てくる `python3` `node` `git` は、**すべて Ubuntu 側**に入れます。
Windows 側にインストールした Node.js や Python は、**WSL からは見えません。**
「入れたはずなのに `command not found` と言われる」の原因はほぼこれです。

作業フォルダも Ubuntu 側（`/home/ユーザー名/` の下）に置いてください。
Windows のドライブ（`/mnt/c/...`）に置くと、動きはしますが遅くなり、
ファイルの権限設定（このスキルは実データを本人だけが読める設定で書きます）が効きません。

## 1. 必要なもの

### Codex

FooT様では **Codex デスクトップアプリ**（Microsoft Store / ChatGPT アプリ）を使います。

- ダウンロード: [ChatGPT デスクトップアプリ](https://chatgpt.com/download)

インストール後、ChatGPT のアカウントでサインインしてください。
**Windowsの方は、手順0の「Codex アプリを WSL に切り替える」を必ず済ませてから先へ進みます。**

（ターミナルから使う Codex CLI でも同じスキルが動きます。その場合は
[公式手順](https://learn.chatgpt.com/docs/codex/cli) に従って `npm install --global @openai/codex` で入れます）

### Node.js 20以上

Node.jsは、このスキルに含まれる処理ファイルを動かすための実行環境です。外部パッケージの追加は不要です。

**Windows（Ubuntu の中）の場合**、Ubuntu の標準リポジトリには古い版しか無いため、
公式リポジトリを足してから入れます。

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**macOSの場合**は [Node.js公式](https://nodejs.org/ja/download) から入れます。

どちらも、最後に確認します。

```bash
node --version
```

表示が、例えば `v20.19.0` のように `v20`以上で始まれば条件を満たします。

### Python 3.9以上

Googleスプレッドシートとドキュメントを読み書きする処理はPythonで動きます。

**Windows（Ubuntu の中）の場合**、Python本体は入っていますが、
追加部品を入れる仕組みが別売りになっています。次を順に実行します。

```bash
sudo apt-get update
sudo apt-get install -y python3-venv
python3 -m venv ~/job-copy-venv
echo 'source ~/job-copy-venv/bin/activate' >> ~/.bashrc
source ~/.bashrc
python3 -m pip install --upgrade google-api-python-client google-auth
```

3行目でこのスキル専用の置き場所を作り、4行目で**Ubuntu を開くたび自動でそこに入る**ようにしています。
これをやらずに `pip install` すると `externally-managed-environment` というエラーで止まります。

**macOSの場合**は最初から入っているので、確認だけします。

```bash
python3 --version
python3 -c "import googleapiclient, google.auth; print('OK')"
```

2行目で `ModuleNotFoundError` が出た場合だけ、次を実行してから再確認します。

```bash
python3 -m pip install --upgrade google-api-python-client google-auth
```

## 2. スキルを配置する

配布は Git で行います。配布リポジトリは次の1つです。

```text
https://github.com/oned2424/job-copy-foot
```

**privateリポジトリのため、招待を受けたGitHubアカウントでしか開けません。**
市野から招待メールが届いていることを確認してください。GitHubアカウントを持っていない場合は、
先に https://github.com/signup で作成し、そのユーザー名を市野に伝えてください。

**Windowsの方は Ubuntu のターミナルで**、macOSの方はターミナルで実行します。

```bash
cd ~
git clone https://github.com/oned2424/job-copy-foot.git job-copy-work
cd job-copy-work
```

初回だけ、GitHubのユーザー名とパスワードを聞かれます。
**ここで聞かれるパスワードは、GitHubのログインパスワードではなく「アクセストークン」です。**
GitHubにログインした状態で https://github.com/settings/tokens にアクセスし、
`Generate new token (classic)` から `repo` にチェックを入れて作成した文字列を貼り付けてください。
トークンは一度しか表示されないので、作成時に控えておきます。

`git` が入っていない場合は、Ubuntu なら `sudo apt-get install -y git` で入れます。

スキルが更新されたときは、同じフォルダで次を実行すれば最新になります。

```bash
cd ~/job-copy-work && git pull
```

clone後、作業フォルダが次の形になっていることを確認します。`.agents`はファイル名の先頭がドットのため、通常は非表示のフォルダです。

```text
job-copy-work/
└── .agents/
    └── skills/
        └── job-copy/
            ├── SKILL.md
            ├── SETUP.md
            ├── scripts/
            ├── references/
            └── assets/
```

Codex にこの作業フォルダを開かせます。

**Codex デスクトップアプリの場合**は、`Add new project`（または `Ctrl+O`）で `job-copy-work` を選びます。
Windows で WSL に切り替えてある場合、フォルダ選択の窓のパス欄に `\\wsl$\` と入力すると
Ubuntu の中が見えるので、そこから `home` → ユーザー名 → `job-copy-work` と辿ります。

**Codex CLI の場合**は、作業フォルダのトップで `codex` と打ちます。

どちらの場合も、Codexの入力欄で `/skills` を入力し、`job-copy` が一覧に表示されることを確認します。表示されない場合は、作業フォルダの位置と `.agents/skills/job-copy/SKILL.md` の存在を確認し、Codexを再起動してください。

## 3. Googleドライブ側を用意する（導入時に1回）

スキルを置いただけでは動きません。**読み書きする実体はGoogleドライブ側にあります。**
ここで4つを用意し、最後にスキルへ登録します。導入時に1回だけの作業です。

### 用意するもの

| # | 名前 | 何に使うか | 作り方 | スキルに必要な権限 |
|---|---|---|---|---|
| 1 | Joblistスプレッドシート | 既存求人を特定し、いま掲載されている値を読む | Airワークから求人をエクスポートし、スプレッドシートとして保存する | **編集**（下記） |
| 2 | 内容確認書スプレッドシート | 派遣先ごとの契約条件を読む | 既にあるものをそのまま使う | 閲覧 |
| 3 | ヒアリング履歴スプレッドシート | 一度聞いた質問と回答を貯める | **スクリプトが作ります**（後述） | 編集 |
| 4 | 出稿用ドキュメントの保存先フォルダ | 「記載項目_派遣先名」の出力先 | ドライブで空のフォルダを新規作成する | 編集 |

2をスキルが書き換えることはありません。

**1（Joblist）が編集権限なのは、`入稿指示ログ` という別タブを1枚追加するためです。**
Airワークからエクスポートした `Sheet1` は読むだけで、**1文字も書き換えません。**
スキルは「今回どの項目をどう直してくださいと指示したか」をこの別タブに残し、
次にJoblistを貼り替えたとき、Airワークの実際の値と突き合わせて
「事務員がまだ貼っていない項目」を教えます。

タブを分けているのは、`Sheet1` がエクスポートのたびに丸ごと貼り替えられるからです。
そこに列を足すと次の貼り替えで消えます。スキル側にも `Sheet1` へ書き込もうとしたら
その場で止まる仕掛けを入れてあります（`check_sheet_name()`）。
このタブは初回実行時に自動で作られるので、手で用意する必要はありません。

### 置き場所を決める

**4つとも、その会社のフォルダの中に置きます。**同じフォルダにまとめる必要はありませんが、
次のように分けると迷いません。

```text
{会社名}/
├── 入力/       ← 1 Joblist・2 内容確認書・3 ヒアリング履歴
└── 出稿用/     ← 4 出稿用ドキュメントの保存先フォルダ
```

**入力の3つと出力フォルダは分けてください。**同じ場所にすると、出稿用ドキュメントが増えたときに
JoblistがGoogleドライブ上で埋もれます。

CSVや作業途中のファイルはドライブに置きません。`/tmp` だけを使います（手順4）。

#### 複数の会社を扱うときも、ファイルは会社ごとに分ける

ヒアリング履歴を1つのファイルにまとめ、タブで会社を分ける形にしないでください。
**Googleドライブの共有はファイル単位で、タブごとに権限を分けることができません。**
1社に共有した時点で、同じファイルの中にある他社のタブ（派遣先の社名・事業所・条件）が
すべて見えます。シートの保護は編集を防ぐだけで、閲覧は防げません。

会社を追加するときは、その会社のフォルダの中に新しいヒアリング履歴を作ります
（`init_hearing_log.py --client 会社名 --folder その会社のフォルダID`）。
横断して見返したい場合は、手元に読み取り専用の集計シートを別途作り、
そちらから各社のファイルを参照してください。**集計シートは会社に共有しません。**

### 認証を決める

スキルは担当者の代わりにGoogleへログインして読み書きします。方式は2つあり、
**どちらを選んでもスキル側の設定は変わりません。**運用として選ぶだけです。

| | A. 担当者のGoogleアカウント | B. サービスアカウント（推奨） |
|---|---|---|
| 正体 | 人のアカウントを借りる | ロボット専用のメールアドレス |
| 準備 | コマンドを1回実行してログインする | 鍵ファイルを受け取り、対象を**そのアドレスに共有**する |
| 見える範囲 | **その人がドライブで見えるファイル全部** | **共有したものだけ** |
| 担当者が変わったら | 動かなくなる | 影響なし |
| 期限 | 切れる。再ログインが要る | 切れない |
| 管理するもの | なし | 鍵ファイル。**漏れたら共有先が全部触られる** |

**Bを推奨します。**業務用のドライブには契約書や個人情報が同居します。
Aだと、スキルはそのすべてに手が届く状態で動きます。Bなら共有した4つ以外には触れません。

#### B（サービスアカウント）を選ぶ場合

1. 市野からロボット用のメールアドレス（`〜@〜.iam.gserviceaccount.com`）と鍵ファイルを受け取る
2. 鍵ファイルをパソコンの中に置く。**メールやチャットに貼らない。ドライブにも上げない**

**Windowsの方は、Ubuntu の中に置いてください。**Windows 側（ダウンロードフォルダ等）に
置いたままだと、鍵ファイルを本人だけが読める状態にできません。
Ubuntu のターミナルで次のようにコピーします（`ユーザー名` は Windows 側のユーザー名）。

```bash
mkdir -p ~/.job-copy && chmod 700 ~/.job-copy
cp /mnt/c/Users/ユーザー名/Downloads/xxxxx.json ~/.job-copy/
chmod 600 ~/.job-copy/xxxxx.json
```

コピーが済んだら、**Windows 側のダウンロードフォルダにある元ファイルは削除してください。**

3. ターミナルで、鍵ファイルの場所を環境変数に設定する

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/鍵ファイルを置いた絶対パス/xxxxx.json"
```

毎回打つのが手間なら、次のファイルの末尾に同じ1行を追記し、ターミナルを開き直します。

- Windows（Ubuntu）: `~/.bashrc`
- macOS: `~/.zshrc`

4. 用意した4つを、そのメールアドレスに共有する

| 対象 | 共有時に選ぶ権限 |
|---|---|
| Joblistスプレッドシート | **編集者**（`入稿指示ログ` タブを追加するため。`Sheet1` は書き換えません） |
| 内容確認書スプレッドシート | 閲覧者 |
| ヒアリング履歴スプレッドシート | 編集者 |
| 出稿用ドキュメントの保存先フォルダ | 編集者 |

Joblistを閲覧者のままにすると、出稿用ドキュメントは作れますが、
その直後の記録で `※ 入稿指示ログの記録に失敗しました` と出ます。
ドキュメント自体は正常なので作り直す必要はありません。権限を編集者に変えてから、
表示されるコマンドをそのまま実行すれば記録されます。

ヒアリング履歴はこれから作るので、先に**出力フォルダまたは入力フォルダを編集者で共有**しておきます。
スクリプトはそのフォルダの中にスプレッドシートを作ります。

Bで作ったファイルは、置き場所はフォルダの中でも、**持ち主はロボットのアカウント**になります。
ロボットのアカウントには保管容量がほとんどないため、出稿用ドキュメントが増えると
作成に失敗することがあります。**この方式での初回の出稿用ドキュメント作成には市野が立ち会います。**
共有ドライブが使える場合は、保存先フォルダを共有ドライブの中に置いてください（持ち主がドライブ側になり、この制約が消えます）。

#### A（担当者のGoogleアカウント）を選ぶ場合

`gcloud` の導入が別途必要です。導入後、次を1回実行します。

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/drive,openid,https://www.googleapis.com/auth/userinfo.email
```

スプレッドシート・ドキュメント・ドライブの3つが要ります。`spreadsheets` だけで通すと、
ヒアリング履歴までは動き、**出稿用ドキュメントの作成でだけ落ちます。**

### ヒアリング履歴スプレッドシートを作る

一度聞いた質問を貯めておき、次のセッションで同じことを聞かないための土台です。
自分で新規作成せず、次のコマンドで作ります（列の並びが決まっているためです）。

```bash
cd .agents/skills/job-copy
python3 scripts/init_hearing_log.py --client foot --folder <保存先フォルダID>
```

`<保存先フォルダID>` は、置き場所に決めたフォルダのURLに含まれる文字列です。

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
                                       ↑ ここから ? までがフォルダID
```

作成したIDは `references/clients/foot/config.json` に自動で書き戻されます。
すでに設定済みなら何もしません。

### 登録して疎通確認をする

最後に、4つの場所をスキルに教えます。**共有リンクのURLをそのまま貼れます。**

```bash
python3 scripts/init_client.py --client foot
```

順に4項目を聞かれるので、それぞれのURLを貼ります（Enterで据え置き）。
入力が終わると、実際にアクセスして開けるか・書けるかを確かめます。

```text
■ 認証: サービスアカウント: xxxxx@xxxxx.iam.gserviceaccount.com

■ 疎通確認
  [OK]     Joblist（AirWorkの求人エクスポート） → ...
  [OK]     内容確認書 → ...
  [OK]     ヒアリング履歴 → ...
  [OK]     出稿用ドキュメントの保存先フォルダ → ...
```

**4つすべてが `[OK]` になるまで先へ進まないでください。**
`[NG]` の大半は、共有の権限が「閲覧者」のままです。直したあとは次で再確認します。

このとき、**Joblistとヒアリング履歴は「開けるか」だけでなく「書けるか」まで確かめます。**
この2つは編集権限が要るためです（Joblistは `入稿指示ログ` タブを追加するため。
Airワークからエクスポートした `Sheet1` は書き換えません）。
閲覧者のままだと、ここで `[NG] 〜 に書き込めません` と出ます。
内容確認書は読むだけなので、閲覧者のままで `[OK]` になります。

```bash
python3 scripts/init_client.py --client foot --check
```

先頭の「■ 認証」行に、いまどのアカウントとして動いているかが出ます。
想定と違うアカウントが表示されたら、そのまま進めず市野へ連絡してください。

FooT以外の会社で使い始めるときは `--client` に別の名前を付けます。設定一式が複製され、
同じ流れで登録できます。ただし複製された `question-catalog.json` には
「その会社の方針」（毎回聞かなくてよい前提）が入っているので、そのまま使わないでください。

## 4. 入力CSVを用意する

手順3で登録したスプレッドシートから、コマンド1つで作ります。**手でダウンロードしません。**

```bash
cd .agents/skills/job-copy
python3 scripts/export_csv.py --client foot
```

```text
Joblist: 76行 × 239列 → /tmp/foot_joblist_20260802.csv

次: node scripts/preflight.mjs --client foot --joblist /tmp/foot_joblist_20260802.csv
   （内容確認書は CSV にしません。read_contract.py がスプレッドシートを直読みします）
```

作業日の日付が自動で付きます。中身が古くなるので、作業のたびに実行してください。

CSVになるのは**Joblistだけ**です。内容確認書のCSVは作りません。

### なぜJoblistだけCSVを作るのか（データはスプレッドシートにあるのに）

もっともな疑問です。CSVは**中間ファイル**で、本来なくても成立します。

このスキルは処理をPythonとNodeで分けています。Joblistを読む2本
（`preflight` / `read_joblist`）はNode製で、Googleの認証を持っていません。
Node側にも認証を持たせると、認証まわりの面倒を2箇所で見ることになり、
導入先で二重に壊れます。そこで**認証はPythonに一本化し、Nodeへはファイルで渡します。**
その受け渡し用がCSVです。`export_csv.py` がその橋渡しをします。

もう1つ、**渡す範囲を絞る**役目があります。Joblistの実体は265列ありますが、
CSVには先頭239列だけを書きます。265列目の「求人メモ」には請求単価と支払単価が
入っており、原稿づくりには要らないからです。単価を読むのは `fetch_current.py` だけで、
そこで伏せ字になります。**単価が通る道を1本に絞っています。**

### 内容確認書はCSVにしない

読む側の `scripts/read_contract.py` はPythonなので認証を持っており、CSVを挟む理由がありません。

それ以上に大きい理由があります。CSVにすると、**読まないと決めている行35
（年齢・性別・国籍）が物理的にファイルへ書き出されてしまいます。**
`read_contract.py` は `contract-map.json` が許可した範囲だけを Google に要求するので、
行35はそもそも返ってきません。運用ルールではなく**構造**で守るために直読みにしてあります。

### 取り扱い

`/tmp`は一時ファイルだけを置く場所です。パソコンの再起動などで消えることがあります。

JoblistのCSVには派遣先企業名が入ります。**`/tmp`以外に複製を残さないでください。**
Googleドライブや共有フォルダに置かないでください。
`export_csv.py` は `/tmp` 以外を出力先に指定すると停止します。
`read_contract.py` の出力（`/tmp/foot_contract.json`）も同じ扱いで、`/tmp` 以外には書けません。

## 5. 動作確認をする

まず、スキルに含まれる処理そのものが壊れていないかを確認します。
このチェックはGoogleに接続しません。ネットワークも認証も不要です。

```bash
cd .agents/skills/job-copy

ng=0
for f in apply_plan client_config collect_siblings export_csv fetch_current hearing_log \
         init_client init_hearing_log make_entry_doc precheck_doc push_to_joblist \
         read_ads_performance read_contract secure_tmp style_entry_doc; do
  python3 scripts/$f.py --self-test > /dev/null 2>&1 \
    && printf '  OK   %s.py\n' "$f" || { printf '  NG   %s.py\n' "$f"; ng=1; }
done
for f in compose_variants make_request_sheet preflight read_joblist secure_tmp write_output; do
  node scripts/$f.mjs --self-test > /dev/null 2>&1 \
    && printf '  OK   %s.mjs\n' "$f" || { printf '  NG   %s.mjs\n' "$f"; ng=1; }
done
for f in audit_tags generate_variants lint_copy; do
  node scripts/$f.mjs --self-test --client foot > /dev/null 2>&1 \
    && printf '  OK   %s.mjs\n' "$f" || { printf '  NG   %s.mjs\n' "$f"; ng=1; }
done
[ $ng -eq 0 ] && echo '==== 全24本 通過 ====' || echo '==== 失敗あり ===='
```

**24本すべてが `OK` になれば正常です。**
`NG` が1つでも出る場合は配布が壊れているので、自分で直さず市野へ連絡してください。

- Pythonの15本は `self-test OK` という行を出します。`read_contract.py` だけはJSONを返します。
- Nodeの9本はJSONを返します。
- `audit_tags` `generate_variants` `lint_copy` の3本は `--client foot` が必要です。
  付け忘れると失敗します。
- `hearing_log` は「層をカタログで補正」という行を手前に出します。これは正常です。
- 中身を目で見たいときは、`> /dev/null 2>&1` を外して1本ずつ流してください。

次に、実データを読めるかを確認します。作業フォルダから次を実行します。

```bash
node scripts/preflight.mjs --client foot --joblist /tmp/foot_joblist_YYYYMMDD.csv
```

内容確認書は指定しません。preflightがスプレッドシートを直接見にいきます。

必須項目がすべて `OK` で、最後に正常と表示されれば環境は正常です。

- 検査8（内容確認書マップ・行35）は通信しません。`contract-map.json` に行35を含む範囲が
  あれば `NG` で止まります。
- 検査9（内容確認書 疎通）はスプレッドシートに触りますが、セルの値は1つも読みません。
  認証やネットワークが無い環境では `WARN`（注意）になりますが、そこでは止まりません。

ヒアリング履歴につながっているかも確認します。

```bash
python3 scripts/hearing_log.py read --client foot --site 派遣先名
```

履歴が無ければ「初回の事業所です」と表示されます。
（ここは疎通確認なので `--title` は不要です。実務では必ず付けます。理由は下の章）エラーが出る場合は
`config.json` の `hearingLog.spreadsheetId` と、そのファイルへの編集権限を確認してください。

## 6. 実行する

**この章のコマンドは、下の「依頼を受け取ってヒアリングする」を済ませてから流します。**
順序を入れ替えると、回答が反映されない訴求案ができます。

### 依頼を受け取ってヒアリングする（省略不可）

フロントから次の7項目を受け取ります。**案件番号は含まれません。**渡されていなければ、
このフォーマットをそのまま提示して記入を求めます。入力がないことを理由に止めないでください。

```
■ 派遣先        ：
■ 事業所        ：
■ 職種          ：
■ 任せる仕事     ：
■ 勤務時間・シフト：
■ 時給          ：
■ 採用予定人数   ：
```

受け取ったら、派遣先＋事業所＋職種でJoblistを引いて案件番号を特定します。

```bash
python3 scripts/hearing_log.py resolve --client foot \
    --site 派遣先名 --office 事業所名 --title 職種
```

`⚠ 依頼された職種に一致する既存求人がありません` と出たら、**候補の案件番号を使わないでください。**
派遣先が同じでも別の仕事です。「既存求人のリライトか、新規案件か」をフロントに確認します。
新規案件ならタブ名は `YYYYMMDD_派遣先名` の仮名を使い、AirWorkで採番されてからリネームします。

次に履歴を読みます。**`--title` に■職種をそのまま渡してください。**

```bash
python3 scripts/hearing_log.py read --client foot \
    --site 派遣先名 --office 事業所名 --title 職種
```

`--title` を渡すと、層3（案件限りの回答）のうち**別の職種の案件の回答**が分けて表示されます。
そのブロックは「前回はこうでした」と見せず、通常の質問として聞き直してください。
同じ事業所でも仕事が違えば、手積み・資格・服装・立ち仕事かどうかは変わります。

履歴が0件なら初回の事業所です。履歴があれば、まだ聞いていない項目だけを聞きます。
**質問数に上限は設けません。**往復は1回きりなので、聞かなかったことは埋まらないまま残ります。
目標字数（仕事内容400字・求める人材150字など）に届く材料が揃うまで聞いてください。
質問を出したら**回答を待ちます。**質問と訴求案を同時に出さないでください。

回答を受け取ったら `/tmp/hearing_rows.json` を作り、履歴に追記します。
**答えが返らなかった項目も `"state": "未回答"` として1行残します。**

```bash
python3 scripts/hearing_log.py append --client foot \
    --site 派遣先名 --office 事業所名 --job 案件番号 --title 職種 \
    --rows /tmp/hearing_rows.json
```

`--title` は必須です。職種を残しておかないと、次回の `read` が
「この回答は今回の職種のものか」を判定できません。

ここまで終わってから、下のコマンド群に進みます。
判断基準の詳細は `SKILL.md` 手順0と `references/hearing-protocol.md` にあります。

### 入力を正規化する

正規化は、必要な項目だけを後続処理用のJSONに整える作業です。
Joblistは手順4で作ったCSVから、内容確認書はスプレッドシートから直接読みます。

```bash
node scripts/read_joblist.mjs --csv /tmp/foot_joblist_YYYYMMDD.csv --client foot --output /tmp/normalized.json
python3 scripts/read_contract.py --client foot --output /tmp/contract.json
```

### 公開前チェック（lint）

lintは、求人原稿から法令・Airワーク規約上の高リスク候補を検出します。自動修正はしません。

```bash
node scripts/lint_copy.mjs --input /tmp/normalized.json --client foot --output-dir /tmp
```

確認するファイル: `/tmp/lint_result_YYYYMMDD.md`

### タグの棚卸し

現行タグの削除推奨、追加推奨、リスクを一覧にします。タグを自動で変更しません。

```bash
node scripts/audit_tags.mjs \
  --input /tmp/normalized.json \
  --contract /tmp/contract.json \
  --client foot \
  --output /tmp/tag_audit_raw_YYYYMMDD.json

node scripts/write_output.mjs \
  --tag-audit /tmp/tag_audit_raw_YYYYMMDD.json \
  --client foot \
  --date YYYYMMDD \
  --output-dir /tmp
```

確認するファイル: `/tmp/tag_audit_YYYYMMDD.md`

### A〜E の5案を作る

確認済みの事実条件を変えず、訴求の軸だけを変えた5案を作ります。

**手順は `SKILL.md` が正本です。**ここにコマンドを書き写すと、実装を直したときに
片方だけ古くなります。`SKILL.md` の「5案は `compose_variants.mjs` が作る」の節に従ってください。

要点だけ:

- 文面は**すべて `compose_variants.mjs` が作ります。**AIが手で書き起こしません。
  手で書くと走らせるたびに文面が変わり、裏の無い文（「残業は別途支給します」など）が混ざります。
- 入力は4つ（`--current` / `--siblings` / `--request` / 任意の `--hearing-ages`）で、
  手順0〜3までで全部そろっています。
- 出力は `/tmp/plan_candidates.json`。5案共通の欄と、案ごとに変わる4欄が入っています。
- 5案をチャットに並べたら、フロントに1つ選んでもらいます。
  「B案でいくがキャッチはC案」のような組み合わせも受け付けます。
- 選ばれた案は `SKILL.md` 手順5で出稿用ドキュメントにします。

雛形は `assets/variants5-template.md` です。
`assets/variants3-template.md` `assets/variants-template.md` `assets/ab-result-template.md` は
旧運用（3案・A/B）の雛形で、いまの提示には使いません。
掲載後の効果測定を行う場合の任意テンプレとして残してあります。

`generate_variants.mjs` と `write_output.mjs` は、掲載中求人をまとめて処理してA/B 2案ぶんの
候補を出す**旧世代の実装**です。5案の提示には使いません。

### 足りない情報の確認依頼書を作る

```bash
node scripts/make_request_sheet.mjs --client foot --contract /tmp/contract.json --output-dir /tmp
```

確認するファイル: `/tmp/data_request_foot_YYYYMMDD.md`

## 7. 困ったとき

**Windowsの方は、まず下の表（Windows特有）を見てください。**

| 表示される内容 | 主な原因 | 直し方 |
| --- | --- | --- |
| `must be a file below /tmp` / `/tmp` が無い | Codexが `Windows native` のまま動いている | 手順0に戻り、Settings で `WSL` に切り替えて**アプリを再起動**する |
| `python3: command not found` / `node: command not found` | Windows側にだけ入れた。WSLからは見えない | Ubuntu のターミナルで手順1をやり直す |
| `externally-managed-environment` | 手順1のvenvを作らずに `pip install` した | 手順1のPythonの手順を最初から実行する |
| `uname -a` が `Microsoft Windows` を返す | WSLへの切り替えが完了していない | Settings を確認し、**アプリを再起動**する。`wsl --version` が 2 系であることも確認する |
| ファイルの権限に関する警告が出る | 作業フォルダを `/mnt/c/...` に置いている | `~/job-copy-work`（Ubuntu側）に clone し直す |

以下は共通です。

| 表示される内容 | 主な原因 | 直し方 |
| --- | --- | --- |
| Node.jsのバージョンが要件未満 | Node.js 20未満 | 手順1のNode.jsを導入し直し、`node --version`を再確認する |
| 必須ファイルがありません | cloneが不完全、またはファイルを移動した | `cd ~/job-copy-work && git pull` を実行する。解消しなければ市野へ連絡する |
| JSONが壊れています | 設定ファイルが書き換わった | 自分で修正せず、市野から配布ファイルを受け取り直す |
| CSVが見つかりません | ファイル名、日付、置き場所が違う | `/tmp`のファイル名を確認し、Joblistと内容確認書の日付を合わせる |
| UTF-8ではありません | 別のソフトでCSVを保存し直した | GoogleスプレッドシートからCSVを再ダウンロードし、内容を編集せず移動する |
| Joblistの列数・列名が違います | `Sheet1`以外を取得したか、列構成が変わった | タブを確認して再ダウンロードする。同じなら市野へ連絡する |
| 6列形式に `source_row=35` があります | 自動出力側の異常 | 処理を続けず、CSVを削除して市野へ連絡する |
| クライアントIDが一致しません | FooT以外の6列CSVを渡した | 対象CSVを確認する。判断できなければ市野へ連絡する |
| `/tmp`へ書き込めません | ファイルやフォルダの権限異常 | パソコンを再起動して再実行する。解消しなければ管理者へ連絡する |
| 疎通確認で `[NG] 〜 に書き込めません` | 共有の権限が「閲覧者」のまま | 対象を「編集者」に変えて `init_client.py --client foot --check` で再確認する |
| 疎通確認で `[NG] File not found` | 共有していない、またはURLが別ファイル | 手順3の共有先とURLを見直す |
| `drive.outputFolderId がありません` | 手順3の登録が済んでいない | `init_client.py --client foot` を実行する |
| 「■ 認証」に想定と違うアカウントが出る | 鍵ファイルの指定漏れ、または別アカウントでログイン済み | `GOOGLE_APPLICATION_CREDENTIALS` の設定を確認する。解消しなければ市野へ連絡する |

自分で直してよいのは、`export_csv.py` の再実行、Joblistの貼り替え、Node.jsやPythonの導入、`git pull` までです。設定JSON、ルール、スクリプトを自分で書き換えないでください。再実行で直らない列相違、設定JSONの異常、必須ファイル不足、行35に関する異常は市野へ連絡してください。

## 8. やってはいけないこと

- 出力された訴求案を、人間の確認なしでそのまま掲載しないでください。
- 元のJoblistや内容確認書を、この作業のために書き換えないでください。
  Airワークからエクスポートしたタブ（`Sheet1`）は、そのまま貼り替えてください。
  スキルが追加する `入稿指示ログ` タブは別枠です。**このタブを消したり、
  中の「状態」列を手で書き換えたりしないでください。**「事務員がまだ貼っていない項目」が
  分からなくなり、次の原稿を古い内容の上に作ってしまいます。
- lintの検出がゼロでも、掲載可能の保証ではありません。最終的な掲載判断は必ず人間が行ってください。
- 内容確認書CSVを `/tmp` 以外に保管・共有しないでください。
- スキル内の設定、規約、訴求軸辞書を独自に変更しないでください。
- 鍵ファイル（サービスアカウントのJSON）をメール・チャット・Googleドライブに置かないでください。パソコンの中だけに保管します。
- `config.json` を手で書き換えないでください。スプレッドシートを差し替えるときも `init_client.py` から行います。
- Joblistと内容確認書を、スキルの都合で並べ替えたり列を足したりしないでください。読み取り専用の入力です。
