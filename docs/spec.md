# fourth_power 仕様 — forge (GitHub / GitLab) を SSOT とする LLM 自律開発フレームワーク

状態: Draft / 本文書が normative。背景・動機は `docs/PROPOSAL.md` を参照する。
この文書は RFC 2119 の語彙を使う: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL。NEVER = MUST NOT、AVOID = SHOULD NOT。

## 1. 語義・準拠

- 「仕様書 (spec)」と「起案書 (proposal)」は文書ファイルのみ。Issue の契約条項 ID は本文書内の節番号で参照する (例: `spec §4.2`)。`§x.y` 参照は第 x 節の項目 y も指す MUST (不変条件の番号付き項目 6 は §2.6 と書く)。付録参照は本文書側には置かず、必ず `docs/PROPOSAL.md 付録 A` の形で書く MUST。付録 A の `TurnRequest`/`Action`/`CheckState`/`FilePatch` 型定義は normative のポインタ先として例外的に normative を担う (本文書の対応する節がポインタを持ち、PROPOSAL 自体には定めた規則が無い)。
- 状態語: `backlog`, `claimed`, `in_review`, `rebase_required`, `blocked/spec-gap`, `blocked/budget`, `blocked/infra`, `done` はラベル正式名として正確に使用する (bare な `blocked` ラベルは使用しない)。
- `forge` = GitHub / GitLab 系のプラットフォームの総称。`provider` は 2 語に分解 MUST: `forge provider` = forge 接続 adapter (§11)、`runtime provider` = seat の LLM モデル実行基盤 (§6)。単なる `provider` だけ書いて両者を混称して MUST NOT。プロジェクト (リポジトリ 1 つ) は単一 forge provider を MUST バインド (`forge.provider` は `docs/governance/projects.json`、§2.6)。起動は 1 プロジェクトを指定し、その forge provider 選択で行う (プロジェクト毎に github / gitlab のいずれか選択で足りる。複数 repo の同時 orchestration はスコープ外)。

## 2. 不変条件 (normative)

1. 永続状態 (label、claim コメント、PR/branch、Checks、accept 契約、決定ログ) は normalized forge リソース (§11) のみが MUST 保持する。進行状態・成果物・決定ログは Issue/PR/Checks/commit にのみ書き、ローカル DB・ローカルブランチ・ローカルの排他ロックを正式状態に MUST NOT。作業用クローン/ブランチは破棄しても MAY。実行中間物 (ワークスペース、turn の作業ログ、中間判断) は永続状態に MUST NOT。復元は永続状態 (§7 の決定表) のみから完全に成立 MUST で、実行中間物の forge 保存・forge からの復元使用・永続状態の再構築を MUST NOT。決定ログは §7 の要約 comment (可視 header 併記) と commit 履歴のみを指す。
2. main branch へ直接 push して MUST NOT。すべての変更は PR 経由のみ。マージは provider の ChangeRequest merge 経由のみ MUST。マージ方法の既定は `squash` (履歴直線、config key `mergeMethod` で上書き MAY、§2.6。台帳の merge subject 記録はどちらの方法でも成立し、`sha-approval` はマージ前 head SHA を突合するため影響しない、§8)。
3. セッションの直前状態は forge に存在 MUST。セッション中断・マシン消失後に復元できること (§7 の復元手順で検証 MUST)。
4. マージ可能性は CI が決める MUST。ローカルで green でも CI が green でなければマージ MUST NOT。
5. forge の読み書きは `src/forge.mjs` のみ MUST。src 配下に stateful な永続化 (DB, fs state, local lock) を保持して MUST NOT (CI check `no-state`、framework repo の PR に required)。`scripts/bootstrap.mjs` の forge 書込みは setup 時 (bootstrap 実行) のみ許容し、`src/` からの bootstrap import は MUST NOT (no-state が拒否)。
6. orchestrator の全設定 (label 正式名、`accept` job 名、budget cap、cohort ラベル、workflow 名、復元 scan 条件、seat モデル割当と階層 (`seatTiers`) と verifier 下限階層 (`verifierMinTier`)、context 予算上限、マージ方法 (`mergeMethod`、既定 `squash`、§2.2)、forge provider 単一選択 (テストプロバイダ `mock` を含む、§11)、exempt・権限ラベル一覧、human login 一覧 (`humanAccounts`)、canonical bot 識別 (check issuer)、turn 打切り間隔 (`turnTimeoutMin`、停滞検出は session の event 静寂 + 時刻測定とし、遅いが生きている応答の誤検知範囲は実装時に固定)、mergeable 再照合間隔、UI の読取・更新間隔 (`ui`)) は framework リポジトリの `docs/governance/config.json` (既定) + `projects.json` (プロジェクト毎上書き) に MUST 保持。プロジェクト本体のリポジトリに設定をコミ MUST NOT (本体コードと設定を依存させない)。プロジェクト側は bootstrap の materialize (label・protection・workflow) のみで、設定のコピーは持たない。CI check `config-consistency` が framework 設定と project の実状態 (label 名・protection・workflow) を照合し、乖離は fail MUST。config の読取は provider の API 経由 MUST (framework repo の read 権限は bootstrap が project CI に付与するか framework repo を readable にする)。ローカルの config/env (秘密の token を除く) で状態を代用 MUST NOT。Web の Draft ページの対話セッションは人間のセッションであり orchestrator の稼働 seat ではないので、`seatTiers` に draft key を持たせない (seat 割当は orchestrator の実装/検証 turn のみ)。

## 3. 状態機械

```mermaid
stateDiagram-v2
    [*] --> backlog
    backlog --> blocked/spec-gap: 条項なし Issue の検出 (claim 前に fail 判定)
    backlog --> blocked/budget: plan turn の budget cap 超過 (お題 Issue の plan turn のみ、§5・§7)
    backlog --> claimed: agent が claim (ラベル + claim コメント)
    claimed --> claimed: PR 作成・fix turn (CI red / draft の間は claimed 維持)
    claimed --> in_review: PR ready + CI green (verifier turn 通過込み、§8)
    claimed --> blocked/spec-gap: 条項なし・不明
    claimed --> blocked/budget: budget 超過 (turn 中の打切り)
    claimed --> blocked/infra: CI job 実行不能 (基盤障害)
    in_review --> in_review: verifier finding fix turn (open thread 解消まで)
    in_review --> rebase_required: mergeable_state dirty (§11 の写し)
    in_review --> blocked/budget: budget 超過
    in_review --> blocked/spec-gap: review 却下 (fix 不能の判断)
    in_review --> blocked/infra: CI job 実行不能 (基盤障害)
    rebase_required --> in_review: rebase 後 CI green
    rebase_required --> blocked/budget: budget 超過
    rebase_required --> blocked/spec-gap: rebase 中に条項欠落発見
    rebase_required --> blocked/infra: CI job 実行不能 (基盤障害)
    in_review --> done: マージ → done ラベル付与 → orchestrator が Issue close
    blocked/spec-gap --> backlog: 人間が再 triage (旧 claim 無効化・PR close 込み、§3)
    blocked/budget --> backlog: 人間が再 triage (旧 claim 無効化・PR close 込み、§3)
    blocked/infra --> backlog: 人間が再 triage (旧 claim 無効化・PR close 込み、§3)
    done --> [*]
```

- blocked ラベルは原因別に MUST 分離: `blocked/spec-gap` `blocked/budget` `blocked/infra`。M2 の統計は原因別集計を MUST 可能とする。
- claim 競合は同一ラベルの重複コメントで解決 MUST。勝者の判定は **forge API の created_at の先頭** MUST (comment 本文の `at <iso-time` は created_at と突合され、不一致は claim 成立 MUST NOT — 自己申告時刻による偽装は created_at が正とする)。created_at が同一秒のケースは競合として扱い、後から着いた claim は MUST 却下 (勝者は 1 つのみ)。comment edit・削除は fixture 回帰テストで挙動を固定 MUST (claim comment の edit は MUST 不可、書き直しは新 comment のみ)。解決時、敗者にはコメントで通知し敗者の claim コメントを残す MUST (台帳は §7 の式で session-id 単位、敗者コメントは winner の台帳に算入しない)。
- 再 triage (blocked→backlog) は人間操作 MUST で、操作時に (a) 旧 claimed ラベルを全削除、(b) 未マージ PR を close、(c) claim 競合の scan 窓を「再 triage 以降の claim」に MUST 絞り込み (旧 claim は勝者候補から除外、§7)、(d) お題 Issue の再 triage では plan turn の無効化 MUST (claim 不可) と、マージ済み plan PR から起票された child Issue の close MUST (介入算入、§9)。再 triage 自体が介入 (§9) で、done 到達経験はリセットされる。再 claim 禁止の例外: お題自身の re-claim は MAY (§7)。
- done 遷移: orchestrator はマージ成立時、先に `done` ラベル MUST 付与、その後に Issue を close MUST。PR 本文に `Closes #N` keyword を MUST 書かない (gate が本文を scan して拒否)。provider の auto close に依存 MUST NOT (done ラベル欠落の残存状態が生じる)。auto close してしまった場合は gate が done ラベル付与で MUST 是正。マージ成立・close 未実行のクラッシュ中間状態は done ラベルの有無で状態が決まる (§7 の決定表行)。
- 未マージの PR close はセッション放棄とみなす (介入、§9)。復元では PR 無しとして扱う (§7)。
- rebase turn も budget に算入 MUST (台帳は §7 の式)。

## 4. 受け入れ契約 (normative)

### 4.1 配置
- 受け入れテストの本体は `ci/accept/<id>.test.mjs` MUST。Issue 本文には契約条項参照 `accept:<id>` を MUST 持つ。
- CI job は単一の `accept` + 独立 check 群 (`accept-immutable` / `accept-vacuity` / `risk-tier` / `review-threads` / `status-exclusivity` / `sha-approval` / `config-consistency` / `scope-guard`) のみ MUST (per-issue workflow は MUST NOT — required check 名が動的になり branch protection と組めないため)。required 指定と一覧は §8 で統一 (diff に該当ファイルが無くなっても MUST 全 check が常に実行され、マージを阻止する)。承認階層・レビュー thread の判定は `risk-tier` / `review-threads` が担う。`scope-guard` は PR の changed paths が Issue の scope 宣言 (§5) を超えるときに fail MUST。

### 4.2 改変禁止 (gaming 防止)
- `ci/accept/` 以下の変更は、人間または exempt ラベル `accept-author` を持つ PR (reviewer 専用) のみ MUST。実装セッションの PR が `ci/accept/` を変更した場合、CI check `accept-immutable` (独立 check、required 指定) が fail MUST。`accept-author` の付与は人間・bootstrap のみ MUST で、orchestrator の gate は exempt・権限ラベルを付与する label Action を MUST 拒否する (実装セッションが自分で `accept-author` を付けて exempt 利得を得る経路は MUST 通さない)。accept-author PR も high path に触れるため spec §8 の人間承認 MUST は維持される (check の exempt と protection の承認は別層)。
- 受け入れテストが空 (対応ファイルなし) のまま green になって MUST NOT。CI は `accept:<id>` 条項に対し対応ファイルの存在照合 MUST。

### 4.3 完了の定義
- job `accept` の green が「完了」の定義 MUST。green でない PR は in_review に遷移 MUST NOT。
- 受け入れ条項を持たない Issue は claim MUST NOT (→ `blocked/spec-gap` で人間に委譲。ただし body に可視 header `plan:` を持つお題 Issue は例外とし、plan turn の起動対象とする (§5・§7)。`blocked/spec-gap` への遷移自体は §3 の決定論を維持する)。

### 4.4 bootstrap 順序
- `scripts/bootstrap.mjs` が label・branch protection・`accept` ワークフローを冪等 に setup MUST。冪等性と、setup 後の protection 状態アサーションを MUST 持つ: required check 名が §8 の一覧と一致、承認数が config.json の値、`dismiss_stale_reviews` が有効 (GitHub の head SHA 変更 dismiss)、`enforce_admins` が true、 orchestrator token が admin 権限を持たないこと (protection 変更不可)。bootstrap は config.json の cap 数値・tier path 一覧・`seatTiers`・`verifierMinTier` (階層上限の充足含む)・`humanAccounts`・required 一覧の存在もアサーション MUST (欠落は setup MUST fail)。
- Issue 作成前に `accept` ワークフローが存在 MUST (bootstrap が先行)。

### 4.5 品質担保・vacuous テスト禁止
- 受け入れテストは **minimum 1 assertion + minimum 1 expect 実体** を持つ MUST。`assert` の実体は node の `assert` import (または `node:test` の `assert` 使用) の呼び出しを指し、`expect` の実体は対応 runner の assertion 呼び出しを指す。`assert` 無し・ `it()` 空・ mock の返値をそのまま返すだけのファイルは CI の `accept-vacuity` check (AST 走査) が fail MUST。同 check は定数アサーション (`assert(true)`、`expect(1).toBe(1)` 等、observable を参照しない引数) も fail MUST。
- **Mutation テスト準拠**: 受け入れ対象の実装コードを revert すると red になること。人間・reviewer は scratch repo の throwaway branch で revert を適用し red を確認 MUST (適用後の branch は MUST 破棄し、本番 PR に revert commit を混ぜない)。red 確認は scratch の CI で MUST 実行 (fixture でなく、red 期待値の回帰は M1 で MUST 検証)。
- 実装セッションは `ci/accept/` を編集できない (§4.2) ため、green は「レビュー済みの受け入れ」に対する判定に固定される。
- 構造検証: accept ファイルは forge 上の `accept:<id>` 条項と MUST 照合 (§4.2)。照合なし green は fail。

## 5. 仕様書ワークフロー (normative)

- 仕様は `docs/spec.md` に MUST 集約し、normative な変更は spec PR (人間レビュー済み) → マージ後にのみ許容。
- Issue は spec のマージから導出 MUST。Issue 本文に spec 条項参照 (`spec §x.y`) を MUST 持つ。
- Issue 本文は固定テンプレート: 受け入れ条項 (`accept:<id>`) + scope (対象ファイルと non-goals) を MUST 持つ。実装 turn は scope を超えた repo 全体 scan を MUST NOT (verifier の読みスライス指定のみ例外)。turn 組立は参照条項のみ添付 MUST で spec 全文を payload に MUST NOT 含める。scope 宣言は PR の changed paths と照合される (deterministic check `scope-guard`、§4.1 — 宣言外ファイル変更は fail)。
- お題 Issue (オーケストレータによる自律分解) は plan turn を MAY とし設計上 MUST 許容: 可視 header `plan:` + 人間のお題本文 (author ∈ `humanAccounts` MUST。お題の原文のみを本文に置く) を持つ Issue を指す。orchestrator は `plan:` Issue に対して plan turn (MAY) を起動し、分解案 (spec 条項・accept 条項・child Issue・plan PR の差分) を `docs/plan/` の PR に起草 MUST。plan PR は tier high MUST (§8 — 承認ゲート = 分解への人間の判断)。child Issue は plan PR のマージ後にのみ起票 MUST: author = `botActor` MUST、本文は plan PR 差分からの機械的組立 MUST (spec 条項参照・`accept:<id>`・scope 宣言のみで自由文を本文に MUST NOT。§5 の固定テンプレートと `scope-guard` は child Issue にも成立し、accept 本文は受入契約の gate を通過した内容のみを写す)。plan PR が close された場合 child Issue は残さない (状態が残存しない)。お題 Issue は claim MUST NOT (plan turn のみ。plan turn の session-id は §12 の hidden key `<!-- fp:session <session-id> -->` と可視 header `plan <session-id>` の固定 comment に保持し、台帳は §7 の author・session-id 突合で数える)。
- peer query: agent は他 Issue (お題 Issue・関連 PR) へ query comment を発行 MAY。この comment は agent 著者であり、turn への再取込は要約のみ (§5 の agent 著者規定は変更せず、gate 判定入力・台帳不算入・hidden 禁止はそのまま)。
- 入力契約 (fourth_power への入力の定義): 起票 (Issue・plan PR・spec PR・accept PR) は、人間の gh 承認済み token の API 呼び出しとして行う MUST (author ∈ `humanAccounts`、identity 突合は不変)。本文は人間がプレビュー・編集した確定版のみを投稿 MUST (可視本文。`accept:<id>`・`plan:` header の意味は §4.3・§5 のまま)。会話セッションは omp のセッション履歴に残す (実行中間物、§2.1 — Web ページはセッション状態を保存しない。UI は差し替え前提で、固定されるのはこの契約のみ)。起票は単一の人間ログインのみ支持 (複数ログインはスコープ外)。UI 経由の書込みはこの起票のみで、label 操作・承認・レビュー投稿は UI の対象外 (ゲート・orchestrator の責任、§7・§8)。
- Issue 本文の機械可読規約: Issue 本文には fence 付きの機械可読ブロック `acceptBlock` (accept 条項・参照条項・scope 宣言の JSON) を 1 つ置く MUST。生成は Draft ページの組立ロジックのみ (`accept:<id`・`plan:` の可視 header と機械ブロックは組立側が決定論的に作る。LLM・skill はこのブロックを MUST 書かない)。payload 組立と `accept-vacuity` (§8) と plan child 組立 (§5) はこのブロックのみを読み、自由文から条項を parse しない。ブロック欠損 Issue は plan turn・claim の対象外 (gate が無視、§7)。
- プロンプトインジェクション: Issue 本文は信頼できる人間入力のみ MUST。agent 著者コメントは再取込時に要約のみ MAY。PR 差分由来の外部コンテンツを turn に MUST 混ぜない。**人間の同一性は `humanAccounts` (§2.6 の一覧) で決定 MUST**: Issue 本文編集・再 triage・承認は author が一覧に属する login のみ有効。一覧外 author の本文・コメント編集は turn に取り込まない (gate MUST 無視)。orchestrator の token アカウントを `humanAccounts` に登録 MUST NOT (bootstrap が同一性照合で拒否、§4.4)。

## 6. adapter 契約 (normative)

- `docs/PROPOSAL.md 付録 A` の `TurnRequest`/`Action` 型に適合 MUST。LLM 出力は Action 宣言のみ MUST。実行は Orchestrator が gate を経由して MUST 行う。
- 各 runtime provider は shared conformance suite (fixture に対する Action 出力検証) を MUST 通過する。判定は recorded fixture (offline の provider API JSON・実モデルレスポンスの録画) に対して決定論的に MUST 行う (live API 呼び出しでのしきい値判定は flaky になるので MUST NOT)。複数モデル接続は MUST 支持 (前提ではなく capability): orchestrator は seat (implement / verify / review) ごとに config.json の割当で別 runtime provider を MUST 使用でき、単一 runtime provider のみの構成も MUST 許容する。conformance suite は runtime provider × seat 組合せ毎のしきい値 (録画 fixture の schema 遵守 ≥ 99%、gate 拒否系 fixture の遵守 100%) を MUST 持ち、通過しない runtime provider はその seat の利用 MUST NOT。config.json の seat 割当 (`seatTiers` の階層順と model 割当、§2.6・§8 の階層判定) は suite の録画判定結果を MUST 参照し、未通過の runtime provider × seat 組合せを割当てている場合は setup MUST fail。
- `mergePr` はゲート (§8) 通過前に MUST 拒否。`blockIssue` は理由付き `blocked/*` ラベルのみ許容。
- turn budget は MUST 数値制約を持つ: budget cap は config.json の既定値 MUST、projects.json がプロジェクト毎に上書き MAY (小さい cap が優先、§2.6)。cap が無いまま budget は unbounded MUST NOT。config.json に cap 値が無ければ setup MUST fail (§4.4 の bootstrap アサーションで検証)。
- turn 入力 payload は config.json の `contextBudget` (読みスライス上限、要約 comment の字数上限) で MUST 上限化。上限超過時は組立前に MUST 間引く (優先: 全文→要約、diff→要約)。要約生成は決定論的組立 (条項参照文字列と決定的台帳行の truncation 結合) MUST で、LLM に要約の再生成を MUST NOT (M2 回帰 (k) で決定論検証)。

## 7. ループ・予算・復元 (normative)

- budget 台帳: **勝者 claim コメントからマージ成立 (または blocked 遷移) まで**の間で、**同一 session-id の勝者セッションの agent 著者コメントのみ** を数える MUST。ready 遷移後の turn (rebase・verifier findings fix・submit) も算入 MUST (ready 境界で台帳を区切らない)。ローカルカウンタ MUST NOT。敗者セッション・verifier の別セッションのコメントは台帳に算入しない (§3)。コメントの著者フィールド (forge の change author) と session-id の突合 MUST: 著者が勝者 claim と別セッションを示すコメントは台帳に算入 MUST NOT (session-id 文字列の模倣は author フィールドで弾く)。GitLab の system note は台帳に算入 MUST NOT (author 判定は note が regular かつ orchestrate アカウントの場合のみ)。
- budget 台帳は MUST 一意の計算式を持つ: maxTurns は台帳の agent 著者 comment 数、maxTimeSeconds と maxCostUsd は orchestrator が各 turn 末尾で MUST 記録する可視台帳行 `budget: consumed_usd=<num> consumed_seconds=<num> at <iso-time>` の数値のみから算出 MUST (ローカル集計からの逆算・forge に存在しない数値の復元は MUST NOT)。台帳行の数と agent comment 数の不一致 (turn が打ち切りで accounting line 無しで終わる中間クラッシュ等) は MUST fail とし、未記録 turn は保守側として 1 turn 加算・config.json の turn 上限値で概算する (cap 判定は保守的に行く)。cost の key 名は `maxCostUsd` のみ MUST (`maxUsd` は使用しない)。config.json と projects.json の cap の数値のみを使い、`maxTurns / maxCostUsd / maxTimeSeconds` のどれが先に来ても打ち切りとする。
- 復元: active ラベル (claimed / in_review / rebase_required の全部。claimed だけの scan はラベル遷移後のセッションをこぼすため MUST NOT) + PR の有無 + CI 状態 + open thread + 承認 + 台帳からの決定表 MUST。入力はラベル状態・PR 状態 (draft/ready/close/無し)・CI 状態 (無し/pending/red/green)・thread 数・承認記録 (tier 要求分)・台帳行。行の優先順位 MUST: budget 超過 > dirty > open thread > CI red > CI pending > green。行は 1 つの決定論的遷移 (ラベル + turn) に限定:
  - budget 超過 (概算込み) → `blockIssue` (blocked/budget)
  - dirty → rebase turn (rebase_required へ)
  - open thread ≥1 → fix turn (in_review 維持)
  - CI red → fix turn (現ラベル維持。in_review から claimed へ戻さない)
  - CI pending → verify turn (checks の pending 読みのみ。thread・承認判定はしない)
  - rebase_required + CI red → rebase turn 継続 (re-push 後に CI 検証)
  - PR 無し (claimed) → implement turn (PR 作成、claimed 維持)
  - PR draft → implement 継続 (claimed 維持)
  - green + tier 要求承認未充足 (high: `humanAccounts` 由来の承認無し / low: `cohort:typical` 付与かつ high path 非該当で tier 免除済み) → submit turn (review 依頼のみ、mergePr 不可)
  - green + tier 要求承認充足 → submit (merge 可。マージ実行 MUST は §8 の再照合通過時に限定)
  - PR close (未マージ) → 再 triage 待ち (ラベルは claimed 維持のまま人間判断、§3)
  - done ラベルあり + Issue open → close 是正 (done ラベルが状態の正、§3)
  - 承認後の新 commit (agent push) → 再 review (承認は head SHA 変更で無効、§8)
  復元 scan の勝者判定は scan 窓内の created_at 先頭 (§3) MUST で、復元セッションは **勝者の session-id を継承 MUST** (新 id を採らない — 新 id は re-claim とみなし budget 算入、claim コメント header は `claimed <同 id> at <元 created_at> resumed <iso-time>` に更新して created_at は改変しない)。復元 turn の読みは claim header・直近の要約 comment・PR/CI 状態のみ MUST (comment thread 全読 MUST NOT。gate 判定は §8 の再照合で API 個別フィールドを読む)。要約 comment は orchestrator が書く決定論的台帳記録 (永続側、§2.1・§6) で、実行中間ログは復元に入れない。
- claim コメント書式は MUST 固定: `claimed <session-id> at <iso-time>` に `<!-- fp:session <session-id> -->` を MUST 併記 (可視 header は fallback と機械 scan の両者で使う、§12)。`at <iso-time>` は MUST API の created_at 正規値から gate (src/forge.mjs) が書く (session-id・timestamp の任意 lines を Action body で許容しない — 偽造は created_at 突合で却下、§3)。復元 scan も config.json / projects.json の条件から決定 MUST (§2.6)。branch 命名規約 MUST は `llm/issue-<N>-<slug>` (N = Issue 番号、slug = Issue タイトル先頭 30 文字の正規化。PR head branch と claim 参照の branch はこの値)。
- budget 超過は `blocked/budget` MUST。台帳は forge の normalized リソースにのみ存在する。
- plan turn の起動は決定論 MUST: scan が `plan:` header を起動トリガーとして読む (LLLM の判断で起動・却下を選択しない)。plan turn の budget・台帳は §7 の既存計算をそのまま使う (cap 超過で `blocked/budget` を付与 MUST — §3 の budget 遷移がそのまま成立し、新ラベルを置かない)。PR のマージ可能性判定に plan turn は関与しない。plan turn の payload も `contextBudget` の上限対象 MUST (§6)。

## 8. ゲート (normative)

- branch protection MUST: main は direct push 禁止、required check の**全一覧** `accept` / `accept-immutable` / `accept-vacuity` / `risk-tier` / `review-threads` / `status-exclusivity` / `sha-approval` / `config-consistency` / `scope-guard` を個別名で MUST 指定 (GitHub Free で可能。`no-state` は framework repo の PR で required、§2.6)。承認数 (`required_approving_review_count`) は protection では静的な設定値 MUST (config.json の値。初期 1、M3 で low tier 免除稼働時に 0 へ bootstrap が切替、§4.4)。GitLab Free には承認 enforcement が無い (Premium 機能) ため、人間の承認要求 MUST は `risk-tier` check の承認記録読取で担保する (§11)。GitHub/GitLab の protection で PR 差分に応じた動的切替は持たない。tier に応じた承認免除・必須化は下の `risk-tier` check で判定する。
- マージは protection + required checks green + tier 所定の承認通過 + **下の再照合 bullet のゲート再判定**通過時のみ MUST (ゲート再照合結果がマージ許可の唯一の基礎で、protection は人間のフォールバック経路の担保)。人間が admin merge で迂回する経路は持たない (`enforce_admins` は true MUST、§4.4)。
- 承認は risk tier で MUST 決まる (change-set が決める、author では決まらない)。tier と path 一覧は `docs/governance/config.json` に MUST 保持 (§2.6)。
  - high: 変更された orchestrator 実装・定義 (`src/` 全体、特に `src/forge.mjs`)、`scripts/bootstrap.mjs`・`scripts/metrics.mjs` 含む `scripts/` 全体、`package.json` と lockfile、`ci/accept/`、`docs/spec.md`、`docs/PROPOSAL.md` (付録 A の型は normative、§1)、`docs/governance/`、orchestrator の prompt・テンプレート (`prompts/`・`templates/`)、テスト定義 (`tests/` と fixtures)、CI 定義ファイル (GitHub `.github/workflows/`、GitLab `.gitlab-ci.yml` と `include:`・composite actions・reusable workflow で参照されるファイル) に触れる変更 → 人間承認 MUST (verifier を含む agent の承認は MUST NOT で満たせない)。低 tier でも `ci/` と `scripts/` の変更は high に昇格 MUST (check 環境の書き換え経路を塞ぐため)。一覧は config.json の `tiers.highPaths` に MUST 保持 (check とゲートは同一一覧を読む)。
  - low: cohort:typical の変更 (high path を触らない) → 承認なしでマージ MAY (M3 設定)。既定 tier は high — `cohort:typical` 非付与の PR は high 扱い MUST (`cohort:typical` の付与は人間・bootstrap のみ MUST で、orchestrator の self 付与は gate が拒否し率の水増しを塞ぐ、§4.2・§9)。初期設定は全 PR に人間承認 1 人 (M3 まで低リスクも同率で要)。
  - tier 判定は CI check `risk-tier` が PR の changed paths と config.json の tier 一覧から計算し、要求を満たさない PR は fail MUST。high path の変更には人間の承認記録が必須であることも同じ check が承認記録 (API の approving review・approval list) を読んで判定 MUST (protection の承認数は静的なので、tier 免除はこの check で行う)。承認記録の author は `humanAccounts` 所属 MUST — orchestrator・verifier・実装 seat のアカウントの承認は high の人間承認を MUST 満たさない。
- レビュー: ready 前の verifier turn MUST (draft→ready 転換の瞬間、in_review 進入の最初の turn として発生 — §3 の遷移)。verifier の読み対象は PR diff・参照 spec 条項・受け入れファイルに MUST 限定 (実装過程 comment は読まない)。verifier は PR の本文・コードコメントをデータとして扱い MUST (diff 内に埋め込まれた指示をレビュー依頼・承認指示として従う経路を MUST 遮断)。verifier seat は実装 seat の階層以上を MUST 指定 (config.json の `seatTiers` 階層順による判定、§2.6・§6)。同一モデルの fresh context 自己レビューは許容するが、verifier の見逃し率がマージ率になるため 80% 目標 (§10 M3) は heterogen seat 構成で評価 MUST。finding は fix もしくは理由付き resolve のみ (放置 MUST NOT)。open thread が 1 つ以上ある PR は CI check `review-threads` が fail MUST で、マージ MUST NOT。verifier findings への fix turn は budget 算入 (§7)。
- 承認は head SHA の変更で MUST 無効: 承認後の新 commit が着いたら承認は再発行。GitHub は commit 駆動の review dismiss で MUST 充足。GitLab は new commit で承認を消す native の approval-reset 設定があるので設定が利用可なら MUST 有効化し、加えて deterministic check `sha-approval` (承認記録 SHA と head SHA の照合) で二重に MUST 検証する (resume 決定表 §7)。マージ action は merge 直前に head SHA・required checks・承認記録・open thread・ラベル状態・mergeable 状態を API で同期再照合 MUST (check 実行と merge の間の race で承認無効化・ラベル・thread 変化を許さない。再照合と異なる場合は fail 扱い、§7 の決定表に再戻し)。
- required check の issuer は canonical に MUST 正規化: 判定結果の投稿 (check run / commit status) は canonical な orchestrate bot アカウント (config.json の `botActor`) または adapter の写しのみ MUST。GitHub Actions の required check は PR head の workflow 定義で走るため、判定ロジックの本体は MUST framework repo の main にマージ済みの決定的実装 (canonical bot が merged main の版で判定し、head の workflow ラッパーは報告のみ、PR head 側のコードで判定して MUST NOT)。gate MUST 非 canonical issuer の同名 check 投稿を green として数えない (無視、§8 の再照合がマージ許可の唯一の基礎、§8 先頭)。
- CI の再実行条件は PR push のみ (ラベル・承認・thread の変化では provider は CI を再実行しない)。gate は config.json の再照合間隔でこれら全入力を API 再判定 MUST で、実行時点の check 結果を古い結論としてマージの根拠に MUST NOT (§8 の再照合が根拠)。
- ゲートのラベル操作は MUST 白名簿で制御: 状態ラベル (§1) の設定・除去は当該 Issue の勝者セッションの operation のみ許容。exempt・権限ラベル (`accept-author`・`cohort:typical`、§2.6 一覧) への Action は MUST 全拒否 (人間・bootstrap のみ付与、§4.2)。他セッションの claim・ラベル・PR への operation MUST NOT (介入境界)。
- `src/forge.mjs` 以外からの forge 書込経路は CI check `no-state` が fail MUST。

## 9. 計測 (normative)

- `scripts/metrics.mjs` が自律マージ率を算出 MUST。介入の定義: 人間による (a) `blocked/*`→`backlog` の再 triage、(b) Issue 本文の `accept:<id>` 条項・`ci/accept/` の編集、(c) 再 claim、(d) plan PR の merge と close (plan PR のマージ/クローズは人間の判断なので介入 — これは「ゲート承認」で §9 の「review 承認不算入」には該当しない、§8 の tier high は設計上の区別)。お題の再 triage も介入 (§3)。お題チェーンの close = 撤回意味 (child Issue の close = 分解案の取消し、§3)。分母 = チェーンの Issue 数。**review 承認は gate 所定であり介入不算入**。
- 分子: 介入行動が 0 の Issue で done 到達した数 (判定は history の介入行動種のみで数える — コメントパターン依存を MUST 排除: verifier comment・gate 承認・敗者 claim・台帳行は介入ではない、§8・§9 の定義に一致する行動だけ介入として数える)。分母: 対象 cohort のうち done / blocked に到達した全 Issue 数。
- cohort 定義は Issue ラベル `cohort:typical` で MUST 表現し、率の分母・分子は forge の normalized 状態から決定 MUST。ローカル集計 MUST NOT。`cohort:typical` の付与は人間・bootstrap のみ MUST (gate の self 付与拒否、§8。tier 既定 high と併せて水増しを塞ぐ、§8)。
- M3 の目標 80% は、metrics.mjs の出力に対して評価する (verifier seat が heterogen な構成で測定 MUST、§8)。low tier の承認なしマージ (§8) は承認を要する PR を減らす (承認は介入不算入のまま、分子の定義はコメントパターンに依存しない)。
- お題から done への自律率は metrics.mjs の MAY 出力とする (M4 の測定対象、§10。お題チェーンの介入 (d) は plan PR の記録に立つもので、child Issue の記録は (a)(b)(c)のみで判定する)。

## 10. マイルストーン受け入れ

- M0: spec PR が人間レビュー済みで main にマージ済み MUST。docs 段階の記録 commit (人間レビュー済みだが direct commit のもの) は M1 稼働時に spec PR として起草し直し、PR flow で確定 MUST (直接 commit を spec PR の条件と数えない)。bootstrap の冪等 setup と protection アサーション (§4.4 の全項目: required 一覧一致・承認数・`dismiss_stale_reviews`・`enforce_admins`・admin token 非確認・config 欠落 fail)、§8 の required check 全一覧 (`accept` job と §4.1 の独立 check 群 8 種) が scratch project で稼働 MUST。
- M1: scratch repo + Issue 1 本で全ループを forge provider (初期 GitHub) 実測。クローン破棄→再クローン復元を検証 MUST。CI red・承認なしでのマージ阻止 — green fixture だけでなく、`accept-immutable` (accept 改変) と `accept-vacuity` (vacuous file 注入) の red 実測も MUST。claim 重複検出 (created_at 不一致却下込み、§3) の fixture 回帰 MUST。mutation red 検証 (§4.5 の scratch revert で red 確認) MUST。
- M2: 単一ループ安定化 — 1 Issue = 1 セッション (単一ループ、複数 persona のエスカレーション強制は持たない)。決定表テスト (gate/resume/budget) + fixtures + 原因別 blocked 統計が CI で green MUST。以下の回帰ケースを MUST 含む: (a) 台帳の session-id 単位集計と敗者コメント混入 (author 突合含む)、(b) 承認未着の resume 行 (submit turn が review 依頼のみ)、(c) `accept-author` exempt の通過/拒否と権限ラベル self-付与の gate 拒否、(d) metrics の介入判定式 (承認は介入不算入)、(e) verifier 別セッションコメントの台帳不算入と open thread の merge 阻止、(f) 承認後の新 commit での再 review、(g) `risk-tier` の changed paths + 承認記録判定 (high 昇格・low 免除)、(h) `status-exclusivity` のラベル乖離注入 fail、(i) `config-consistency` と `no-state` の乖離・書込経路注入 fail、(j) 定数アサーションの `accept-vacuity` fail、(k) contextBudget 上限超過の間引き挙動、(l) 非 canonical issuer の同名 check 投稿の無視と stale 再照合 fail (§8)、(m) 再 triage 後の再 claim で勝者 session-id 継承と claim header 更新 (created_at 不改変、§7)、(n) `scope-guard` の scope 宣言外変更 fail、(o) claim comment の created_at 不一致 (timestamp 偽造) の却下 (§3)。選択 provider の決定表 fixture MUST 通過 (§11 の conformance bullet・緩和: プロジェクトの選択 provider のみ)。hidden marker の raw 永続と API fallback (§12) も回帰 MUST に含む。runtime provider × seat の録画 conformance suite (しきい値 99/100) も MUST 通過。
- M3: low tier (cohort:typical) は承認なしでマージできる設定へ移行済み MUST — protection の承認数を 0 へ bootstrap が切替 MUST (§8・§4.4。高 tier の承認要求は `risk-tier` が承認記録読取で維持)。metrics.mjs による cohort:typical の自律マージ率 80% 以上 MUST (heterogen 測定 MUST — heterogen は実装 seat が flash tier 以下かつ verifier seat が上位階層のこと (`seatTiers` の階層順と上限と `verifierMinTier` key、§2.6。§6 の heterogen 規定「実装 seat は flash tier、verifier は上位」の失効防止 — 「flash + 同 flash」測定を禁止)。`verifierMinTier` 設定が未充足なら setup MUST fail (§4.4 の bootstrap アサーション、§6 の conformance setup fail は階層上限まで網羅済み)。GitLab provider を選択したプロジェクトは全ループ実測 + クローン破棄復元検証 MUST (fixture のみでなく実測)。`sha-approval` の再照合 (push 後の承認無効) と `status-exclusivity` fallback の fixture MUST 通過 (選択 provider の conformance は §11 の conformance bullet)。
- M4: お題実測 — 人間のお題 1 本 (`plan:` header、author ∈ `humanAccounts`) で plan turn の分解案 (plan PR、tier high) を実測 MUST。plan PR マージ後の child Issue 起票→自律 claim→merge→done の連鎖を fixture のみでなく実測 MUST (spec §5)。お題チェーンの自律率 (child Issue の (a)(b)(c) 介入 0 で done 到達 / チェーンの Issue 数) を metrics.mjs が出力 MAY (spec §9)。plan PR close 時の child Issue 残存なし (§3 の撤回意味) も回帰 MUST。お題 Issue の再 triage で plan turn 無効化と child Issue close の連鎖を fixture 回帰 MUST。
- M5: 性能測定環境 — mock forge provider (§11 mock bullet) が稼働 MUST。orchestrator のコードは unchanged で、forge.mjs の endpoint が mock を指すのみ。claim→turn→gate→merge→done の全ループを mock 上で測定 MUST (モデル層は §6 の conformance 録画 fixture か live モデルのどちらかを project が選択)。お題 fixture 群 `tests/perform/topics/` (P1 ドッグフードの mini 実装 turn、P2 お題→plan PR→child Issue 連鎖、P3 負群 — 条項なし Issue / budget cap 超過 / accept-vacuous 注入、P4 クラッシュ復元) が存在 MUST で、P2 の「人間承認 1 回」は mock の recording 応答 (approve event fixture) で模擬する (mock は決定論、§11 mock bullet)。mock 実行での性能視点グループの出力 (metrics.mjs、§9) が MUST — 正実装性 (done が accept green のみで到達・false green は注入 fixture で検出)、実装成功率 (first-pass 率: 再 claim・resume なしで初 turn から done)、自律性 (介入 (a)-(d) 数・必須承認数・お題チェーン自律率)、効率 (turn 数・PR attempt 数・time・cost・gate 拒否数)、安定性 (クラッシュ復元成功率・中間状態残存なし率・claim 競合処理)、分解品質 (child Issue の done 率・plan PR の一発承認率)。M3/M4 の実測は本番 provider (scratch repo・throwaway repo) の live 実行 MUST (mock 実行を実測と数えない)。サービスリポジトリ (本体 project) には M0 の spec PR と人間の承認済み PR 以外 Issue/PR を起票 MUST NOT — 測定 Issue は mock か throwaway のみに置く (PROPOSAL §17)。

## 11. Forge object model (normative)

- `forge` の forge provider = `src/forge.mjs` の adapter 実装。forge provider 固有処理は `src/forge/<provider>.mjs` に MUST 分離。runtime provider (LLM モデル) とは語を分離 (§1)。
- 永続状態は下表の normalized class のみが MUST 保持。platform 固有 object (GitHub Projects、GitLab Epic、roadmap) は MUST NOT 決定表 (§7) に入らない。

| class | GitHub | GitLab | 要求 capability |
|---|---|---|---|
| Issue | Issue | Issue | body・note・label |
| ChangeRequest | PR (同一 repo branch; fork PR MUST NOT) | MR (同一 project branch) | diff・checks・thread・承認・mergeable |
| Note | Issue comment | note | claim 書式 (§7) 共通・hidden marker (§12) を raw で MUST 読取・GitLab system note は台帳不算入 (§7) |
| Label | label | scoped label | 状態語の単一集合排他 MUST |
| Check | check job | pipeline job | 決定表の入力・issuance は canonical 限定 (非 canonical は gate 無視、§8) |
| Mergeability | mergeable_state (unknown/behind/blocked/dirty) | detailed_merge_status / has_conflicts | dirty ↔ 衝突の写し (§7 決定表)。pending (unknown / detailed_pending) は gate の間隔で再照合 MUST (§8) |
| Plan | milestone | milestone | 計画専用 (状態 MUST NOT) |
| PlanGroup | 相当なし (MUST 省略可) | Epic | 計画専用・決定表 MUST NOT |
| Protection | branch protection + required check + review | protection rule + pipeline 成功必須 + approval rule (Free には approval enforcement 無し → `risk-tier` の記録読取で代替、§8) | ゲート (§8) |
| Config | framework commit (config.json・projects.json) | 同左 | §2.6。プロジェクト本体 repo に設定 MUST コミしない |

- label 排他: 同一 Issue に状態語ラベルを同時設定 MUST NOT。GitLab の scoped label は Premium 限定なので、利用不可 (Free) の場合も含め provider を問わず deterministic check `status-exclusivity` が MUST 保証 (GitLab で native が有効なら補助として併用可)。
- 承認失効 (§8): GitHub は commit 駆動 dismiss、GitLab は native の approval-reset 設定 (+ 設定が使えない環境では `sha-approval` check) で MUST 検証。
- thread 解決: GitHub の review thread・GitLab の unresolved discussion、`review-threads` check が API から MUST 読む。
- check 粒度: GitHub の required status check は check 名を個別指定できるが、GitLab の protected merge は pipeline 全体の成功が基本。GitLab では adapter MUST が pipeline の job 結果 (accept / risk-tier / review-threads / status-exclusivity / sha-approval / config-consistency / accept-vacuity / scope-guard) を MR の check 状態に写して個別判定可能にする MUST (マージ必須 check 指定は GitLab の設定で pipeline 成功 + 個別 job の MUST success 化で足りる)。写しの issuance は canonical bot または adapter のみ MUST (§8 — 同名偽装投稿は gate が無視)。
- tier path (§8): `tiers.highPaths` は provider 固有表記 MUST (GitHub `.github/workflows/`、GitLab `.gitlab-ci.yml` と `include:` 先ファイル)。GitLab の path ベース承認 (Code Owners) は Premium 限定なので、tier 判定は `risk-tier` check で MUST 担保 (free でも動く)。
- provider conformance (緩和): 選択 forge provider の決定表 fixture MUST 通過。2 provider (GitHub / GitLab) 両方の conformance 維持は RECOMMENDED な拡張で、プロジェクトのスコープは選択 forge provider のみ (この bullet 自身・§10 M2)。未通過の forge provider は本番利用 MUST NOT。
- Plan / PlanGroup は読み取らない: scan は label・note・checks のみ (§7)。
- forge provider `mock` (テストプロバイダ): 同一の normalized object model を throwaway のローカルリポジトリ内 (`tests/mock-forge/`、使い捨て — 損失は §2.1 の不変条件と一致) で実装 MAY。orchestrator の scan・決定表・gate・metrics のコードは本番と同一で unchanged、書込み経路は forge.mjs のみ (§2 不変条件 5)。mock provider は §11 の conformance fixture MUST 通過 (mock の object 応答 JSON を fixture とする)。mock プロバイダのプロジェクトは性能測定スコープのみとし、本番利用 MUST NOT。bootstrap の production setup は実行しない (§4.4 は本番 provider のみ)。
- milestone / epic の全体完了合意手順は spec で規定しない (人間または harness skill (PROPOSAL §16 の omp 側手順) の版付き合意と時間切れ ≠ 合格の手順による。seat 側のプロンプト層ではない)。

## 12. Hidden marker (normative)

- 補助的な stateful 情報は HTML comment (`<!-- ... -->` = hidden) に MUST 埋め込む。UI では見えないが raw は API で決定論的に返る (GitHub / GitLab とも raw body・note を保存・返すこと MUST 検証済み)。書式は固定: `<!-- fp:<key> <value> -->`。
- 利用可な key (固定): `session` (claim header と同一コメントに併記。復元時に継承 MUST、§7)、`scope` (§5 の条項参照宣言)、`summary` (submit turn の決定論的記録 — 決定論的組立で LLM 再生成は使わない (§6): resume 点 + 条項参照。中間判断は書かない MUST (§2.1)。同一コメント内に hidden で書き、別コメントを増やさない — marker のために台帳 comment 数は増えないが、submit turn の comment 自体は agent 著者 comment として台帳算入 (§7) のまま)。字数上限は config.json の `contextBudget` (§6)。
- `role` は MAY の補助 key: `<!-- fp:role <seat> -->` は UI の seat レーン表示のためだけのもので、ゲートの判定入力にも台帳算出にも使う MUST NOT (決定表は読まない、§7)。gate の判定入力は可視 header と API の可視フィールドから導出する (UI は補助表示のみ、PROPOSAL §14)。
- ゲートの判定入力は MUST hidden に書かない: label / 承認 / check / thread の判定 (§7・§8) は API の可視フィールドのみを読む。hidden の値を gate の判定に使う MUST NOT。
- marker 欠損・破損時は API 可視フィールドと claim コメント header に MUST fallback (§7)。hidden は補助情報であり、失われても復元決定は成立する。
