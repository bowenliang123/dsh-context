![ソーシャルプレビュー](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[简体中文](https://github.com/bowenliang123/dsh-context/blob/main/README.md) · [English](https://github.com/bowenliang123/dsh-context/blob/main/README_en.md) · [日本語](https://github.com/bowenliang123/dsh-context/blob/main/README_ja.md) · [Español](https://github.com/bowenliang123/dsh-context/blob/main/README_es.md) · [Français](https://github.com/bowenliang123/dsh-context/blob/main/README_fr.md) · [Deutsch](https://github.com/bowenliang123/dsh-context/blob/main/README_de.md) · [Русский](https://github.com/bowenliang123/dsh-context/blob/main/README_ru.md) · [Português](https://github.com/bowenliang123/dsh-context/blob/main/README_pt.md)

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**Agent のコンテキストを可視化・管理するための最高の [DeepSeek Harness プラグイン](https://www.deepseek.com/harness/)。**

> DeepSeek Harness チームのメンバー [@tianyicui](https://github.com/tianyicui) と [@turtle1999](https://github.com/turtle1999) が推薦し、スターを付けています。[X の投稿](https://x.com/tianyi/status/2105256532657267119)をご覧ください。

[`dsh-context`](https://www.npmjs.com/package/dsh-context) は、コンテキストのライフサイクル全体を管理する機能を提供します。
- **Context Insights ページ** — セッション横断の概要を、第 1 レベルのサイドバーパネル（Plugins と Automation tasks と同列）として提供。7 日間の Token/費用チャート付き KPI バンド、アクティビティヒートマップ、構成全体のリング、フィルター可能で任意のセッションへ直接移動できるセッションカードを備えています。
- **Context タブ** — DeepSeek Harness のコンテキスト統計、構成、推移、イベント、メッセージ、コマンド実行を表示する UI コンテキストダッシュボード。
- **Fleet タブ** — Agent ファミリー専用のページ。現在の Agent、その親、すべてのサブ Agent をそれぞれ 1 枚のリアルタイムカードで表示します。
- **Context パネル** — 同じダッシュボードを右サイドバーのタブとしても利用可能。サイドバーのガイドページで **Context** を選択すると、Agent ネットワークを含むパネルがチャットの横に開きます。
- **`/context` コマンド** — 現在のコンテキスト構成と最近のコンテキストの変遷を表示するスラッシュコマンド。

▶️ **4 分間の動画ツアー** — [Bilibili で視聴](https://www.bilibili.com/video/BV1bn4K6TEEV/)（中国語）。

[![dsh-context と DeepSeek Harness：コンテキストの構成、変遷、マルチ Agent チーム](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/video-cover.jpg)](https://www.bilibili.com/video/BV1bn4K6TEEV/)

## インストール / 更新

### DeepSeek Harness の Web 版またはデスクトップ版にインストール

**Add plugin** ウィザードの検索ボックスに `dsh-context` と入力し、**Install** をクリックします。

![プラグイン追加ウィザード](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/add-plugin-wizard.png)

### `dsh` CLI でインストール

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) から [`dsh-context`](https://www.npmjs.com/package/dsh-context) プラグインをインストールします。

```sh
dsh plugin --profile web add dsh-context
```

`dsh-context` プラグインを更新する場合は、次を実行します。

```sh
dsh plugin --profile web update dsh-context@latest
```

その後、`dsh web` で Web UI を起動します。ビルドも再起動も不要です。

## 使用方法

5 つの入口が示すのは同じ内容です。Agent が何を保持しているか、それをどのように得たか、そしてどのように使ったかを確認できます。

| 入口 | 機能 |
| --- | --- |
| **Context Insights ページ** | すべてのセッションを一覧：使用量、費用、キャッシュヒット率、毎日のアクティビティ、セッションごとのコンテキスト概要。期間、日付、グループ、検索で絞り込み、ワンクリックで移動できます。 |
| **Context タブ** | 完全なダッシュボード：統計、構成、リクエストごとの推移、イベント、ファイルアクティビティ、コマンド実行を各セッションで確認できます。 |
| **Fleet タブ** | Agent ネットワーク：現在の Agent、その親、すべてのサブ Agent をリアルタイムで表示します。 |
| **`/context` コマンド** | チャットを離れずに、同じ構成情報とコンテキストブラウザーを中央のモーダルで表示します。 |
| **Preferences カード** | ユーザーごとのデフォルト設定：パネルの入口、Insights の期間、推移と並び順のデフォルト、各セッションのシステムプロンプトの前後に連結する接頭辞/接尾辞。 |

## 🗂️ Context Insights ページ

サイドバーのパネル一覧で **Context Insights / コンテキストインサイト**（**Plugins** と **Automation tasks** と同じ階層）をクリックすると、中央カラム全体のパネルとしてページが開きます。

![Context Insights ページ](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| セクション | 答えられる疑問 |
| --- | --- |
| **KPI バンド** | 使用量はどのくらいか——選択した期間（7 日 / 30 日 / すべて）にアクティブだったセッションについて、課金 Token、推定費用、キャッシュヒット率、ターンを各ステップの開始日に帰属させて集計します。ツール実行とアクティブ時間は、これらのセッションとそのサブ Agent の全ライフサイクルを対象とし、時間統計カードと一致します。 |
| **7 日間の使用量チャート** | 毎日どのくらい使ったか——最近 7 日間の課金 Token と推定費用を日ごとのペア棒グラフで表示し、セッションの最終アクティブ日ではなく、各セッション内の各リクエストの開始日で集計します。 |
| **アクティビティヒートマップ** | 実際にいつ作業したか——最近 8 週間の毎日の課金 Token。日付をクリックすると、その日にアクティブだったセッションを絞り込み、3 つの集計カードの対象もその日だけにできます。 |
| **スキル読み込み** | どのスキルを、何回、最後にいつ読み込んだか——選択した期間内の読み込み回数をスキルごとに集計。クリックすると、そのスキルを読み込んだセッションを絞り込めます。 |
| **ツール呼び出し** | どのツールを、何回、最後にいつ実行したか——日別台帳からツールごとの実行回数を集計。クリックすると、そのツールを実行したセッションを絞り込めます。 |
| **コマンド実行** | どのプログラムを、何回、最後にいつ実行したか——プログラムごとのコマンド実行回数をディスパッチ時に計数。クリックすると、そのプログラムを実行したセッションを絞り込めます。 |
| **設定入口** | ページタイトルバーのボタン——Context タブの Plugin Info カードにある、このプラグインの設定への保護されたジャンプと同じものです。 |
| **Context Composition** | 選択した期間の課金 Token がどこで使われたかを、Token カードの課金分類（Tool Calls、Reasoning、Answers……）で内訳表示します。 |
| **セッションカード** | 4 つのカードの下に各セッションの概要を表示：構成リング、課金 Token、ターン、費用、ワークスペースグループ / プロジェクトパス。最近のアクティビティ、Token 数、コンテキストサイズで並び替え、検索、ワークスペースでグループ化できます。カードをクリックするとセッションが開きます。 |

## 📊 Context タブ

任意のセッションを開き、**Context / コンテキスト** タブをクリックします。

![Context パネルの概要](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| カード | 答えられる疑問 |
| --- | --- |
| **Context Stats** | ターン、ステップ、ユーザー入力、リアルタイムのツール呼び出し——さらに models.dev の価格表から推定した費用（`?` にホバーすると 100 万 Token あたりの単価を表示。DeepSeek のみピーク/オフピークを区別し、掲載価格はオフピーク料金、ピーク時間帯は 2 倍で課金）。 |
| **Token Stats** | 課金 Token がどこで使われたか——合計は入力欄の下のチャット統計行と同じで、システムプロンプト、ツール定義、ユーザーメッセージ、注入コンテキスト、スキル注入、ツール呼び出し、推論、応答に内訳表示します。ツール呼び出しには、ツール名と引数（プロンプトで再生された分と出力で生成された分）、およびそれらのツールが返した結果を含めます。応答は同じアシスタント内容と出力からモデルの応答本文を切り出し、推論も同様に思考内容を切り出します。セッションのキャッシュヒット率は隅に表示されます。 |
| **Timing Stats** | アクティブ時間がモデル呼び出し、ツール実行、オーバーヘッドにどう配分されたか。 |
| **Current Context** | この瞬間にウィンドウにある内容。 |
| **Context Trend** | 各リクエストのサイズとその変化の経緯。 |
| **Context Browser** | 任意のリクエストが実際に何から構成されていたか。 |
| **Context Events** | ウィンドウがいつ、なぜ変化したか。 |
| **File Activity** | Agent がファイルに対して何をしたか。 |
| **コマンド実行** | Agent がどのコマンドを実行し、各実行がどう終了し、主にどのプログラムを使ったか。 |

費用の推定は、文書化された一連のルールに従います。[モデル価格のマッピング方法](docs/model-pricing-mapping.md)。

タイトルの占有率と構成データは、チャット入力欄のコンテキストリングと同じ**公式 Token 計量プロジェクション**（`contextPressure` / `contextBreakdown`）から読み取るため、数値は常にリングと一致します。カードのパーセンテージは同じ占有率を小数点第 1 位まで表示したものです。

**Context Stats** カードの Agent Network セル（Agent ファミリー全体の課金 Token と推定費用）をクリックすると **Fleet** タブへ移動します。入出力行のピルもジャンプリンクで、**ユーザー入力** はコンテキストブラウザーのユーザーメッセージを開き、**読み取り / 書き込み / 検索 / 画像** は対応するフィルターを選択したファイルアクティビティカードへ移動します。

### Context Stats

#### Token Stats と Timing Stats
![Token Stats と Timing Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Context Stats
![Context Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)

### 🧱 現在のコンテキスト — この瞬間のコンテキストウィンドウの内容

![Current Context カード](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

モデルのウィンドウ全体を基準にした 6 色の積み上げバーです（末尾の斜線付きの 2 つの領域 = 自動圧縮の予約領域。順にヘッドルーム、リクエスト用に予約された出力ウィンドウ）。システムプロンプト、ツール定義、ユーザーメッセージ、注入コンテキスト、アシスタント応答、ツール結果のそれぞれに、およその Token 数と割合を表示します。会話の品質が低下し始めたとき、*具体的にどの部分*が原因かをここで確認できます。

### 📈 コンテキストの推移 — ターンまたはステップごとのコンテキストの増大と変遷

![ステップ概要付きの Context Trend](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

モデルリクエストごとに 1 本の積み上げ棒を表示します。メッセージ単位より細かく、ウィンドウの増大をターンごとに追えます。

- **✨ ステップ概要** — グラフの下に 3 行の分かりやすい概要を表示。**User** はそのターンを開始したメッセージを振り返り、**In** は新たに加わった内容（通常は以前のツール結果）を一覧し、**Response** は応答や呼び出したツールを表示します。行をクリックすると、Context ブラウザーで対応するメッセージを開きます。
- **✂ イベントをマーク** — 圧縮と剪定イベントを発生した棒に印すため、減少の理由が一目で分かります。
- **好みの方法で表示** — **Step / Turn** の粒度、**Total**（累積構成）または **Delta**（各リクエストの符号付き変化）を選択でき、横スクロールでセッション全体を確認できます。Delta モードでは、増加は基準線の上に積み上がり、圧縮は下へ伸びます。

![Delta モードの Context Trend](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **概要** — 1 つのスイッチでセッション全体（ステップまたはターン）をパネル幅に収め、連続した積み上げリボンとして表示します。横スクロールや追加読み込みなしに、各圧縮による減少と構成変化を一望できます。マーカーは四分位点と全範囲を示します。ホバーで数値を読み、分類帯にホバーするとその分類をリボン全体で強調し、クリックするとステップを固定してコンテキストブラウザーでその分類を展開します（DNA モードと Adaptive とは排他）。
- **ホバーと固定** — ホバーでツールチップを即時表示。クリックで完全な内訳を固定し、推定値の横にプロバイダーが報告した **Actual Prompt / Output / Cache** を表示します。
- **リアルタイム連動** — 棒にホバーすると、グラフの横の Context ブラウザーでそのステップに組み立てられたコンテキストをプレビューします。グラフから離れると自分で選択した内容に戻ります。

### 🧭 コンテキストブラウザー — 任意のリクエストの内容を確認

**Live（次のリクエスト）** または保持されている任意のステップを選択すると、そのリクエストの構成内容を参照できます。7 つの折りたたみ可能な分類を展開すると項目ごとの行と Token 消費を表示し、各項目をさらに展開すると**実際の内容**——システムプロンプト、各ツールの JSON schema、メッセージテキスト、推論内容、ツール引数、ツール出力——を確認できます。スキルの内容（利用可能なスキルのカタログ、`/skill` 呼び出し、`skill` ツールによる読み込み）には独立した **Skill Injections** 分類があるため、見えにくいスキルのコンテキスト使用量が注入コンテキストやツール結果の分類に隠れることはありません。

- **各ツールの提供者** — 各ツール定義行には、可能な範囲で特定した提供元ラベルが付きます。`tool-*` はファーストパーティパッケージ、`dsh-*` は機能パッケージ、`mcp:<server>` はプロキシ、あるいは `tools.register()` からリアルタイムに監視した正確なプラグインを表示します。**サイズ / 名前** で並び替え、各分類固有の検索フィールドで絞り込めます。

![提供元チップ、フィルター、並び替え付きのツールスキーマ](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **種類でアシスタント応答を絞り込み** — アシスタント分類の検索ボックスには **Thinking / Tools / Answer** タグがあり、現在の検索結果内でその種類を含む応答数をそれぞれ表示します（1 つの応答が複数の種類を含む場合あり）。タグをクリックすると一致する応答だけを残し、再クリックでフィルターを解除します。

![種類フィルターチップ付きのアシスタント応答](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-assistant-kinds.png)

- **ツール結果を展開して呼び出し全体を表示** — ツール名、引数、**OK/error** 状態に加え、行数と **Raw / Markdown** 切り替え付きの結果本文を表示します。

![Raw/Markdown 切り替え付きで展開したツール結果](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **添付ファイルを順序どおりにカード表示** — メッセージ内の `image` と `file` ブロックをメッセージ内の順序で並べ、ブロックごとに 1 枚のカードを表示します。画像にはサムネイル、寸法、保存サイズ、DeepSeek 公式の画像 Token 推定を表示し、その他のファイルには種類のアイコン、拡張子、保存サイズを表示します。1 回クリックすると、実際のファイル名で dsh 内蔵のプレビュー欄（Markdown、コード、PDF、Office、画像ビューアー）に添付ファイルを開きます。

![寸法、保存サイズ、Token 推定を表示した画像添付カード](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **前のターンとの比較** — 分類ごとの符号付き差分バッジ（`+N` 項目、`±Nk` Token）で、そのターンで追加または回収された内容が一目で分かります。圧縮前の古いステップは削除済みメッセージのアーカイブから再構成します。ステップの構成が近似値だけの場合は、カードにその旨を明示します。

- **DNA モードでコンテキストを平坦に展開** — 棒グラフをモデルの読み取り順に項目ごとの色帯で描画し、その下に同じ内容を平坦な一覧として表示します。最新メッセージが最上部です（モデルは古い順に読むため、一覧はその逆順）。各行にはプロンプト内の位置（`#12`）、分類、導入ステップ、Token 消費が付き、展開すると同じ完全な内容を確認できます。ツール定義とシステムプロンプトは 2 つのグループ行として一覧の末尾を締めます。カードの高さは横の構成カードと推移カードにそろえられ、完全に平坦化したセッションはカード内でスクロールするため、ページ全体を埋め尽くしません。

### ⚡ コンテキストイベント — ウィンドウがいつ、なぜ変化したか

![圧縮イベントを含む Context Events](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

すべての注入、圧縮、剪定、モデル切り替え、プランモード切り替えを、発生元（指示ファイル、プラグイン ID、スキル名）、Token の正味変化量（圧縮イベントでは回収量）、ターン / ステップ、時刻とともに記録します。**Inject / Compact / Prune / Switch / Mode** タグで種類別にログを絞り込め、各タグにはセッション全体の対応イベント総数を表示します。

### 📁 ファイルアクティビティ — Agent がファイルに対して行ったこと

![ファイルアクティビティ](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

操作されたファイルごとに 1 行——読み取り、書き込み、検索——を表示し、推移グラフで選択したステップまで集計します。

- **用途ごとの回数** を集計し、タイトルバーのタグ（**Read / Written / Searched / Images**）をフィルターとしても使えます。パス検索ボックスも利用できます。
- **行数変化** — 各 `edit` / `write` 操作の推定 `+追加 / −削除` 行数を、ファイルごとと合計で確認できます。
- **すべてのモードを集計** — ネイティブツール、Minimal プリセットの `str_replace_editor`、PTC `run_code` プログラム内のネストされた呼び出しをすべて各ツールの行に集計します。
- **検索結果を実際のファイルに対応付け** — 一致したファイルには独自の操作行とヒット回数を表示します。
- **行をクリック**すると完全な操作ログを展開し、各操作から Context ブラウザーの対応するツール結果へ直接移動できます。
- **ファイル名をクリック**すると、内蔵 Files サイドバーとまったく同じ動作で右側の Sidebar にファイルプレビューを開きます。同じビューアーとファイルごとの独立タブを使用します。Harness にそのカラムがない場合は、従来どおりシステムでファイル名を開きます。

### 🖥️ コマンド実行 — Agent が実行した内容

![コマンド実行](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/command-executions.png)

各 Shell とコード実行の状態、実経過時間、ステップ位置に加え、セッション概要、注目項目へのショートカット、プログラム分布を表示します。注目項目とプログラム分布は常にセッション全体を対象とし、検索と状態フィルターだけが右側の一覧を絞り込みます。左側をクリックするたびに対応する視点がフィルターボックスに反映されます。プログラムをクリックすると名前を入力してその行を強調し、再クリックすると両方を解除します。フィルターボックスには常に現在有効なフィルターが表示されます。

## 🚢 Fleet タブ

任意のセッションを開き、**Context** の右にある **Fleet / フリート** タブをクリックします。Agent ファミリー専用のページで、上部にサマリー帯、その下に **Agent ネットワーク** と **Agent 間の協調**、さらに **協調タスク** と **イベント検査** が並びます。

![6 個の Agent のフリート概要：フリートサマリー、Agent ネットワーク、Agent 間の協調、協調タスク、イベント検査](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-overview.png)

サマリー帯には Agent 数、実行中、作業項目、メッセージ数が並びます。グラフまたはレーンで Agent を選ぶと、協調ビューがその Agent に絞り込まれ、ページは常に 1 人のメンバーについて答えます。

### 🕸 Agent ネットワーク — ファミリー全体の俯瞰

現在の Agent、その親、すべてのサブ Agent を Agent ごとに 1 枚のカードで表示します。タイトル、リアルタイムのコンテキストサイズとウィンドウ占有率、構成バー、実行時間、実行済みステップ数を確認できます。関係線はそれぞれの系統色で親から展開します。カードにホバーすると関係チェーン全体を強調し、詳細バーで完全な内訳を表示します。ノードをクリックすると、そのノードが強調されます。実行中の Agent は入線の緑のパルスと、タイトル横の Harness 内蔵スピナーでアクティブ状態を示します。タスク完了後、インジケーターはタイトルのサブ Agent 一覧と同じ緑のドットに変わります。狭いパネルではファミリーを整然とした行に折りたたみ、横スクロールバーは表示しません。

### 🛰 Agent 間の協調 — ファミリーを 1 本のタイムラインに

各 Agent に 1 本のレーンを割り当て、Agent 間メッセージ、チームタスクのマーカー、委任記録を同じタイムラインに並べます。静かなレーンは切り替えで折りたためます。チームタスクの番号はレーン間で同じタスクを示し、同じ番号は同一タスクです。ホバーすると関連する記録が連動します。**Earliest / Latest** で順序を切り替え、検索ボックスでレーンを絞り込み、タスクをクリックするとタイムラインをフィルターしてそのタスクを表示します。

### ✅ 協調タスク — 誰が何をしているか

**協調タスク** ボードはチームタスクとサブ Agent への委任を 1 か所にまとめます。担当者グループ、状態フィルター（すべて / 進行中 / 待機中 / 完了）、タスクにフォーカスすると前提条件チェーン全体を強調する blocked-by リンクを備えます。各カードには担当 Agent、タスク概要、書き込みスコープ、最終報告が付き、タスクをクリックすると完全な説明をその場で（原文 / Markdown で）展開できます。

### 📡 イベント検査 — 誰が誰に何を伝えたか

**イベント検査** カードはファミリーのセッションログを自動で読み取るため、手動スキャンは不要です。メッセージ、レポート、委任記録が 1 つのストリームにまとまり、タイムラインのノードまたはストリームの記録を選ぶと完全な記録を表示します。発生元のセッションログとシーケンス、サブ Agent ではなくランタイムが完了を記録した場合の注記、完全な完了レポート（構造化結果または診断を含む）、参加者カード（サイドバーまたはページ全体でチャットを開く）が含まれます。種類やテキストで絞り込め、共有の Agent 選択でハブ全体を絞り込めます。

右側 Sidebar の **Context** パネルにも同じカードを埋め込むため、チャットを読みながら Agent ファミリーをいつでも 1 クリックで確認できます。Fleet タブが不要な場合は Preferences カードで **Fleet tab** をオフにできます。カードは引き続きこのパネルに残り、Harness が Sidebar を提供する限り、Context タブのファミリーセルからもここで開けます。

## ⌨️ `/context` コマンド

`/context` と入力するか（または `/` メニューから選択し）、Enter を押します。

![Context コマンドを含むスラッシュメニュー](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

中央のダイアログに **Current Composition** カードと **Context browser** が表示されます。タブと同じ構成バー、ステップごとのセレクター、`vs previous turn` 差分バッジを備えています。

![/context モーダル](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ 設定

**Context** Preferences カードには、このプラグインのユーザー単位の設定を保存します。**コンテキストパネルの入口**（**Context** セッションタブ、右側の Sidebar パネル、その両方、または非表示。非表示では返信行のジャンプボタンも非表示）、**Fleet** タブ自体の表示 / 非表示スイッチ（コンテキストパネルの入口の影響を受けない）、**Context Insights** ページのデフォルト期間（今日 / 過去 7 日 / 過去 30 日 / すべて。デフォルトは過去 30 日。ページで期間プリセットをクリックするとこの設定に書き戻す）、推移の粒度（Step/Turn）、推移モード（Total/Delta）、デフォルトで表示する推移の時間曲線、推移の自動概要しきい値、Context Browser の比較基準、ツールと File Activity の並び順、Context Insights の表示 / 非表示スイッチです。このカードは **Plugins** ページにあります。サイドバーの **Plugins** 入口 → **dsh-context** プラグインパッケージのページ → **Configuration** セクション（カードはこの入口のリアルタイム Config フォームから提供）。

**System Prompt · Prefix / Suffix** 行には自由なテキストを入力し、各セッションのシステムプロンプトの先頭 / 末尾に連結して、すべての Agent（サブ Agent を含む）に適用します。Harness 自身のプロンプト組み立てフローとともに適用される、デプロイ単位の役割設定または行動ルールです。変更は次のターンから有効になり、行を空欄にすると対応する設定を無効にできます。

Context Insights の期間プリセットボタンは、選択をデフォルト値として保存します。その他のグラフやカード内の切り替えは現在のビューだけに適用され、保存済みの設定を上書きしません。

![Context 設定カード](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## 補足

- **キャッシュ使用量** — プラグインが dsh のプロジェクションキャッシュに書き込むのは、セッションごとの簡潔な概要（構成、カウント、費用/時間、モデル情報）だけです。サイズの大きいイベントごとの詳細（surface テキスト、リクエスト内訳、ファイル操作、コマンドプログラム、span）は、パネルで必要になったときに永続ログから再集計するため、長いセッションでもキャッシュを小さく保てます。詳細ビューには上限があります（ステップ 1500 · ターン 300 · イベント 400 · surface ノード 2000 · アーカイブ 400 · ファイル操作 400 · コマンド 400）。
- **推定値と実測値** — 各分類の数値には dsh 自身の固定密度ヒューリスティック（内蔵 Token メーターと同じ）を使用します。推移グラフでステップを固定すると、詳細には推定値の横にプロバイダー報告の実測値を表示します。Token カードでは ≈ 推定の構成割合と、プロバイダーが正確に報告した課金合計を並べて表示します。
- **互換性** — データ形状に基づく同じコードパスで、V4 セッションログ形式の `@deepseek-ai/dsh` **0.2.0-rc.2 以降**をサポートします（`0.2.0` と `0.2.1` 系列はそれぞれの rc.2 リリースで、`0.2.2` 系列は rc.1 で検証済み）。リリースごとのサポート状況と検証方法は [docs/compatibility.md](docs/compatibility.md) を参照してください。
- **国際化** — UI は簡体字中国語、英語、日本語、スペイン語、フランス語、ドイツ語、ロシア語、ポルトガル語に対応しています（言語の切り替えには dsh 0.2.2 以降が必要です。それ以前のサポート版では中国語と英語のみ）。

## 気に入りましたか？

`dsh-context` が Agent の保持内容を理解する助けになったなら、[GitHub](https://github.com/bowenliang123/dsh-context) で ⭐ を付けていただけると嬉しいです。issue / PR も歓迎します！

## ライセンス

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
