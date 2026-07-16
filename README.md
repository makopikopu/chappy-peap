# パーペチュアル損益トラッカー

仮想通貨の無期限先物(パーペチュアル)取引の損益を管理するReactアプリです。Claude.aiのartifact上で作ったものを、単体で動くVite製プロジェクトに書き出しています。

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:5173` を開いてください。

## 動作環境について(重要)

Claude.aiのartifact環境と違い、これは**あなたのブラウザで直接動く、ふつうのWebアプリ**です。それによって変わる点が2つあります。

### 1. 良くなる点: 外部APIへの直接アクセスが可能に

artifact内では、外部APIへの直接アクセスがブロックされることがありました(Hyperliquidのウォレット取得や為替レートAPIなど)。単体アプリとして動かすと、この制限がなくなるはずです。`open.er-api.com`(現在レート)・`api.frankfurter.app`(当時レート)・`api.hyperliquid.xyz`(ウォレット取得)は、そのまま動作します。

### 2. 追加で必要になる点: Anthropic APIキー

「スクショを読み込む」「為替レートのスクショから読み取る」機能は、AI(Claude)による画像解析を使っています。artifact内では自動的に認証されていましたが、単体アプリではそうはいかないので、**ご自身のAnthropic APIキーが必要**です。

1. https://console.anthropic.com/settings/keys でAPIキーを発行(要クレジット/課金設定)
2. アプリ右上の鍵アイコンをクリックしてキーを貼り付け
3. このブラウザの `localStorage` にのみ保存されます(サーバーには送信されません。api.anthropic.com への画像解析リクエストにのみ使われます)

**このキーは公開しないでください。** GitHubにコミットしたり、他人と共有したりしないよう注意してください(`.gitignore` で `.env` 等は除外済みですが、ブラウザに直接入力する方式なのでソースコードには含まれません)。

キーが無くても、スクショ読み取り以外の機能(ウォレット取得・手動入力・為替レートAPI・期間別集計など)は問題なく使えます。

## データの保存について

すべてのデータ(取引履歴・為替レート・APIキー)は、開いているブラウザの `localStorage` に保存されます。つまり:

- パソコンとスマホなど、**別の端末・別のブラウザでは別々のデータ**になります(同期はされません)
- ブラウザのデータを消去すると、保存した内容も消えます
- 複数端末で同じデータを見たい場合は、Supabase等の外部データベースと連携する改修が別途必要です

## ビルドして公開する

```bash
npm run build
```

`dist/` フォルダに静的ファイルが生成されます。Vercel・Netlify・GitHub Pagesなど、静的サイトホスティングにそのままアップロードできます。

### GitHubへのアップロード手順

```bash
git init
git add .
git commit -m "Initial commit: perpetual P&L tracker"
git branch -M main
git remote add origin <あなたのGitHubリポジトリURL>
git push -u origin main
```

### Vercelでのデプロイ例

1. https://vercel.com にGitHubアカウントでログイン
2. 「New Project」→ このリポジトリを選択
3. Framework Preset は自動で「Vite」が検出されるはずです。そのままデプロイ

## 主な機能

- スクショ読み込み(AI画像解析)による取引履歴の自動入力
- Hyperliquid(MetaMask Perps)のウォレットアドレスから取引履歴を自動取得
- USD/JPY為替レート(現在・取引当時のレート、スクショ読み取り、投資サイトの表の一括貼り付け)
- 年別・月別・週別の損益集計(クリックで取引明細を展開)
- 重複取引の自動統合、日付表記の統一、取得元フィルタ・並び替え

## 技術スタック

- React 18 + Vite
- recharts(グラフ)
- lucide-react(アイコン)
