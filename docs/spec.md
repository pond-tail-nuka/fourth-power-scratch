# fourth_power 仕様 — forge (GitHub / GitLab) を SSOT とする LLM 自律開発フレームワーク

状態: Draft / 本文書が normative。背景・動機は `docs/PROPOSAL.md` を参照する。
この文書は RFC 2119 の語彙を使う: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL。NEVER = MUST NOT、AVOID = SHOULD NOT。

## 1. 語義・準拠

- 「仕様書 (spec)」「起案書 (proposal) は文書ファイルのみ。Issue の契約条項 ID は本文書内の節番号で参照する (例: `spec §4.2`)。`§x.y 参照は第 x 節の項目 y も指す MUST (不変条件の番号付き項目 6 は §2.6 と書く)。付録参照は本文書側には無く、必ず `docs/PROPOSAL.md 付録 A` の形で書く MUST。
- 状態語: `backlog`, `claimed`, `in_review`, `rebase_required`, `blocked/spec-gap`, `blocked/budget`, `blocked/infra`, `done` はラベル正式名として正確に使用する (bare な `blocked` ラベルは使用しない)。
- `forge` = GitHub / GitLab 系のプラットフォームの総称。`provider` は 2 語に分解 MUST: `forge provider` = forge 接続 adapter (§11)、`runtime provider` = seat の LLM モデル実行基盤 (§6)。単なる `provider` だけ書いて両者を混称して MUST NOT。プロジェクト (リポジトリ 1 つ) は単一 forge provider を MUST バインド (`forge.provider` は `docs/governance/projects.json`、§2.6)。起動は 1 プロジェクトを指定し、その forge provider 選択で行う (プロジェクト毎に github / gitlab のいずれか選択で足りる。複数 repo の同時 orchestration はスコープ外)。

## 2. 不変条件 (normative)

1. 永続状態 (label、claim コメント、PR/branch、Checks、accept 契約、決定ログ) は normalized forge リソース (§11) のみが MUST 保持する。進行状態・成果物・決定ログは Issue/PR/Checks/commit にのみ書き、ローカル DB・ローカルブランチ・ローカルの排他ロックを正式状態に MUST NOT。作業用クローン/ブランチは破棄しても MAY。実行中間物 (ワークスペース、turn の作業ログ、中間判断) は永続状態に MUST NOT。復元は永続状態 (§7 の決定表) のみから完全に成立 MUST で、実行中間物の forge 保存や forge からの再構築を MUST NOT に使わない。
2. main branch へ直接 push して MUST NOT。すべての変更は PR 経由のみ。マージは provider の ChangeRequest merge 経由のみ MUST。
3. セッションの直前状態は forge に存在 MUST。セッション中断・マシン消失後に復元できること (§7 の復元手順で検証 MUST)。
4. マージ可能性は CI が決める MUST。ローカルで green でも CI が green でなければマージ MUST NOT。
5. forge の読み書きは `src/forge.mjs` のみ MUST。src 配下に stateful な永続化 (DB, fs state, local lock) を保持して MUST NOT (CI check `no-state`)。
6. orchestrator の全設定 (label 正式名、`accept` job 名、budget cap、cohort ラベル、workflow 名、復元 scan 条件、seat モデル割当、context 予算上限、forge provider 単一選択) は framework リポジトリの `docs/governance/config.json` (既定) + `projects.json` (プロジェクト毎上書き) に MUST 保持。プロジェクト本体のリポジトリに設定をコミ MUST NOT (本体コードと設定を依存させない)。プロジェクト側は bootstrap の materialize (label・protection・workflow) のみで、設定のコピーは持たない。CI check `config-consistency` が framework 設定と project の実状態 (label 名・protection・workflow) を照合し、乖離は fail MUST。ローカルの config/env (秘密の token を除く) で状態を代用 MUST NOT。

## 3. 状態機械

```mermaid
stateDiagram-v2
    [*] --> backlog
    backlog --> claimed: agent が claim (ラベル + claim コメント)
    claimed --> claimed: PR 作成・fix turn (CI red / draft の間は claimed 維持)
    claimed --> in_review: PR ready + CI green
    claimed --> blocked/spec-gap: 条項なし・不明
    in_review --> in_review: verifier finding fix turn (open thread 解消まで)
    in_review --> rebase_required: mergeable_state dirty
    rebase_required --> in_review: rebase 後 CI green
    rebase_required --> blocked/budget: budget 超過
    in_review --> blocked/budget: budget 超過
    in_review --> blocked/spec-gap: review 却下 (fix 不能の判断)
    in_review --> blocked/infra: CI job 実行不能 (基盤障害)
    in_review --> done: マージ後 agent が Issue close
    blocked/spec-gap --> backlog: 人間が再 triage
    blocked/budget --> backlog: 人間が再 triage
    blocked/infra --> backlog: 人間が再 triage
    done --> [*]
```

- blocked ラベルは原因別に MUST 分離: `blocked/spec-gap` `blocked/budget` `blocked/infra`。M2 の統計は原因別集計を MUST 可能とする。
- claim 競合は同一ラベルの重複コメント (先頭 timestamp) で解決 MUST。comment edit・削除は fixture 回帰テストで挙動を固定 MUST。解決時、敗者にはコメントで通知し敗者の claim コメントを残す MUST (台帳は §7 の式で session-id 単位、敗者コメントは winner の台帳に算入しない)。
- rebase turn も budget に算入 MUST (台帳は §7 の式)。

## 4. 受け入れ契約 (normative)

### 4.1 配置
- 受け入れテストの本体は `ci/accept/<id>.test.mjs` MUST。Issue 本文には契約条項参照 `accept:<id>` を MUST 持つ。
- CI は job `accept` と独立 check `accept-immutable` のみ MUST (per-issue workflow は MUST NOT — required check 名が動的になり branch protection と組めないため)。承認階層・レビュー thread の判定は §8 の独立 check `risk-tier` / `review-threads` が担う (required 指定)。

### 4.2 改変禁止 (gaming 防止)
- `ci/accept/` 以下の変更は、人間または exempt ラベル `accept-author` を持つ PR (reviewer 専用) のみ MUST。実装セッションの PR が `ci/accept/` を変更した場合、CI check `accept-immutable` (独立 check、required 指定) が fail MUST。`accept-author` の付与は人間・bootstrap のみ MUST で、orchestrator の gate は exempt・権限ラベルを付与する label Action を MUST 拒否する (実装セッションが自分で `accept-author` を付けて免証を得る経路は MUST 通さない)。accept-author PR も high path に触れるため §8 の人間承認 MUST は維持される (check の exempt と protection の承認は別層)。
- 受け入れテストが空 (対応ファイルなし) のまま green になって MUST NOT。CI は `accept:<id>` 条項に対し対応ファイルの存在照合 MUST。

### 4.3 完了の定義
- job `accept` の green が「完了」の定義 MUST。green でない PR は in_review に遷移 MUST NOT。
- 受け入れ条項を持たない Issue は claim MUST NOT (→ `blocked/spec-gap` で人間に委譲)。

### 4.4 bootstrap 順序
- `scripts/bootstrap.mjs` が label・branch protection・`accept` ワークフローを冪等 に setup MUST。冪等性と、setup 後の protection 状態アサーションを持つ MUST。
- Issue 作成前に `accept` ワークフローが存在 MUST (bootstrap が先行)。

### 4.5 品質担保・vacuous テスト禁止
- 受け入れテストは **minimum 1 assertion + minimum 1 expect 実体** を持つ MUST。`assert` 無し・ `it()` 空・ mock の返値をそのまま返すだけのファイルは CI の `accept-vacuity` check (AST 走査) が fail MUST。同 check は定数アサーション (`assert(true)`、`expect(1).toBe(1)` 等、observable を参照しない引数) も fail MUST。
- **Mutation テスト準拠**: 受け入れ対象の実装コードを revert すると red になること。人間・reviewer は scratch repo の throwaway branch で revert を適用し red を確認 MUST (適用後の branch は MUST 破棄し、本番 PR に revert commit を混ぜない)。red 確認は scratch の CI で MUST 実行 (fixture でなく、red 期待値の回帰は M1 で MUST 検証)。
- 実装セッションは `ci/accept/` を編集できない (§4.2) ため、green は「レビュー済みの受け入れ」に対する判定に固定される。
- 構造検証: accept ファイルは forge 上の `accept:<id>` 条項と MUST 照合 (§4.2)。照合なし green は fail。

## 5. 仕様書ワークフロー (normative)

- 仕様は `docs/spec.md` に MUST 集約し、normative な変更は spec PR (人間レビュー済み) → マージ後にのみ許容。
- Issue は spec のマージから導出 MUST。Issue 本文に spec 条項参照 (`spec §x.y`) を MUST 持つ。
- Issue 本文は固定テンプレート: 受け入れ条項 (`accept:<id>`) + scope (対象ファイルと non-goals) を MUST 持つ。実装 turn は scope を超えた repo 全体 scan を MUST NOT (verifier の読みスライス指定のみ例外)。turn 組立は参照条項のみ添付 MUST で spec 全文を payload に MUST NOT 含めない。
- プロンプトインジェクション: Issue 本文は信頼できる人間入力のみ MUST。agent 著者コメントは再取込時に要約のみ MAY。PR 差分由来の外部コンテンツを turn に MUST 混ぜない。

## 6. adapter 契約 (normative)

- `docs/PROPOSAL.md 付録 A` の `TurnRequest`/`Action` 型に適合 MUST。LLM 出力は Action 宣言のみ MUST。実行は Orchestrator が gate を経由して MUST 行う。
- 各 runtime provider は shared conformance suite (fixture に対する Action 出力検証) を MUST 通過する。判定は recorded fixture (offline の provider API JSON・実モデルレスポンスの録画) に対して決定論的に MUST 行う (live API 呼び出しでのしきい値判定は flaky になるので MUST NOT)。複数モデル接続は MUST 支持 (前提ではなく capability): orchestrator は seat (implement / verify / review) ごとに config.json の割当で別 runtime provider を MUST 使用でき、単一 runtime provider のみの構成も MUST 許容する。conformance suite は runtime provider × seat 組合せ毎のしきい値 (録画 fixture の schema 遵守 ≥ 99%、gate 拒否系 fixture の遵守 100%) を MUST 持ち、通過しない runtime provider はその seat の利用 MUST NOT。
- `mergePr` はゲート (§8) 通過前に MUST 拒否。`blockIssue` は理由付き `blocked/*` ラベルのみ許容。
- turn budget は MUST 数値制約を持つ: budget cap は config.json の既定値 MUST、projects.json がプロジェクト毎に上書き MAY (小さい cap が優先、§2.6)。cap が無いまま budget は unbounded MUST NOT。config.json に cap 値が無ければ setup MUST fail (§4.4 の bootstrap アサーションで検証)。
- turn 入力 payload は config.json の `contextBudget` (読みスライス上限、要約 comment の字数上限) で MUST 上限化。上限超過時は組立前に MUST 間引く (優先: 全文→要約、diff→要約)。

## 7. ループ・予算・復元 (normative)

- budget 台帳: claim コメント (勝者セッション) から ready コメントまでの間、**同一 session-id の勝者セッションの agent 著者コメントのみ** を数える MUST。ローカルカウンタ MUST NOT。rebase turn と verifier findings への実装側 fix turn も算入 MUST。敗者セッション・verifier の別セッションのコメントは台帳に算入しない (§3)。コメントの著者フィールド (forge の change author) と session-id の突合 MUST: 著者が勝者 claim と別セッションを示すコメントは台帳に算入 MUST NOT (session-id 文字列の模倣は author フィールドで弾く)。
- budget 台帳は MUST 一意の計算式を持つ: maxTurns は台帳の agent 著者 comment 数、maxTimeSeconds と maxCostUsd / maxUsd は orchestrator が各 turn 末尾で MUST 記録する可視台帳行 `budget: consumed_usd=<num> consumed_seconds=<num> at <iso-time>` の数値のみから算出 MUST (ローカル集計からの逆算・forge に存在しない数値の復元は MUST NOT)。config.json と projects.json の cap の数値のみを使い、`maxTurns / maxCostUsd / maxUsd / maxTimeSeconds` のどれが先に来ても打ち切りとする。
- 復元: active ラベル (claimed / in_review / rebase_required の全部。claimed だけの scan はラベル遷移後のセッションをこぼすため MUST NOT) + PR の有無 + CI 状態から resume 点を決める MUST 決定表: PR 無し → implement、PR draft / CI red → fix turn (claimed 維持)、PR ready + CI pending → verify、PR ready+CI green+承認なし → submit turn (review 依頼のみ、mergePr 不可)、PR ready+CI green+承認あり → submit (merge 可)、dirty → rebase、承認後の新 commit (agent push) → 再 review (承認は head SHA 変更で無効、§8)。復元 turn の読みは claim header・直近の要約 comment・PR/CI 状態のみ MUST (comment thread 全読 MUST NOT)。要約 comment は orchestrator が書く決定論的台帳記録 (永続側、§2.1) で、実行中間ログは復元に入れない。
- claim コメント書式は MUST 固定: `claimed <session-id> at <iso-time>` に `<!-- fp:session <session-id> -->` を MUST 併記 (可視 header は fallback と機械 scan の両者で使う、§12)。復元 scan も config.json / projects.json の条件から決定 MUST (§2.6)。
- budget 超過は `blocked/budget` MUST。台帳は forge の normalized リソースにのみ存在する。

## 8. ゲート (normative)

- branch protection MUST: main は direct push 禁止、required check `accept` / `accept-immutable` / `risk-tier` / `review-threads`。承認数 (`required_approving_review_count`) は protection では静的な設定値 MUST (config.json の値。GitHub/GitLab の protection で PR 差分に応じた動的切替は持たない。tier に応じた承認免除・必須化は下の `risk-tier` check で判定する)。
- マージは protection + required checks green + tier 所定の承認通過時のみ MUST。
- 承認は risk tier で MUST 決まる (change-set が決める、author では決まらない)。tier と path 一覧は `docs/governance/config.json` に MUST 保持 (§2.6)。
  - high: 変更された orchestrator 実装・定義 (`src/` 全体、特に `src/forge.mjs`)、`scripts/bootstrap.mjs`・`scripts/metrics.mjs` 含む `scripts/` 全体、`package.json` と lockfile、`ci/accept/`、`docs/spec.md`、`docs/governance/`、CI 定義ファイル (GitHub `.github/workflows/`、GitLab `.gitlab-ci.yml` と `include:` で参照されるファイル) に触れる変更 → 人間承認 MUST (verifier を含む agent の承認は MUST NOT で満たせない)。低 tier でも `ci/` と `scripts/` の変更は high に昇格 MUST (check 環境の書き換え経路を塞ぐため)。
  - low: cohort:typical の変更 (high path を触らない) → 承認なしでマージ MUST 可 (M3 設定)。初期設定は全 PR に人間承認 1 人 (低リスクも同率で要)。
  - tier 判定は CI check `risk-tier` が PR の changed paths と config.json の tier 一覧から計算し、要求を満たさない PR は fail MUST。high path の変更には人間の承認記録が必須であることも同じ check が承認記録 (API の approving review・approval list) を読んで判定 MUST (protection の承認数は静的なので、tier 免除はこの check で行う)。
- レビュー: ready 前の verifier turn MUST。verifier の読み対象は PR diff・参照 spec 条項・受け入れファイルに MUST 限定 (実装過程 comment は読まない)。verifier は PR の本文・コードコメントをデータとして扱い MUST (diff 内に埋め込まれた指示をレビュー依頼・承認指示として従う経路を MUST 遮断)。verifier seat は実装 seat の階層以上を MUST 指定 (config.json の割当、§2.6・§6)。同一モデルの fresh context 自己レビューは許容するが、verifier の見逃し率がマージ率になるため 80% 目標 (§10 M3) は heterogen seat 構成で評価 MUST。finding は fix もしくは理由付き resolve のみ (放置 MUST NOT)。open thread が 1 つ以上ある PR は CI check `review-threads` が fail MUST で、マージ MUST NOT。verifier findings への fix turn は budget 算入 (§7)。
- 承認は head SHA の変更で MUST 無効: 承認後の新 commit が着いたら承認は再発行。GitHub は commit 駆動の review dismiss で MUST 充足。GitLab は new commit で承認を消す native の approval-reset 設定があるので設定が利用可なら MUST 有効化し、加えて deterministic check `sha-approval` (承認記録 SHA と head SHA の照合) で二重に MUST 検証する (resume 決定表 §7)。マージ action は merge 直前に head SHA と required checks を API で同期再照合 MUST (check 実行と merge の間の race で承認無効化を許さない)。
- `src/forge.mjs` 以外からの forge 書込経路は CI check `no-state` が fail MUST。

## 9. 計測 (normative)

- `scripts/metrics.mjs` が自律マージ率を算出 MUST。介入の定義: 人間による (a) `blocked/*`→`backlog` の再 triage、(b) Issue 本文の `accept:<id>` 条項・`ci/accept/` の編集、(c) 再 claim。**review 承認は gate 所定であり介入不算入**。
- 分子: 介入行動が 0 の Issue で done 到達 (勝者 claim コメント + 勝者 agent コメント + merge/close のみ) の数。分母: 対象 cohort のうち done / blocked に到達した全 Issue 数。
- cohort 定義は Issue ラベル `cohort:typical` で MUST 表現し、率の分母・分子は forge の normalized 状態から決定 MUST。ローカル集計 MUST NOT。
- M3 の目標 80% は、metrics.mjs の出力に対して評価する。low tier の承認なしマージ (§8) が分子を増やす。high tier の人間承認も gate 所定で介入不算入のまま。

## 10. マイルストーン受け入れ

- M0: spec PR が人間レビュー済みで main にマージ済み MUST。bootstrap の冪等 setup と protection アサーション、`accept` job が稼働 MUST。
- M1: scratch repo + Issue 1 本で全ループを forge provider (初期 GitHub) 実測。クローン破棄→再クローン復元を検証 MUST。CI red・承認なしでのマージ阻止、claim 重複検出の fixture 回帰 MUST。mutation red 検証 (§4.5 の scratch revert で red 確認) MUST。
- M2: 単一ループ安定化 — 1 Issue = 1 セッション (単一ループ、複数 persona のステークション強制は持たない)。決定表テスト (gate/resume/budget) + fixtures + 原因別 blocked 統計が CI で green MUST。以下の回帰ケースを MUST 含む: (a) 台帳の session-id 単位集計と敗者コメント混入 (author 突合含む)、(b) 承認未着の resume 行 (submit turn が review 依頼のみ)、(c) `accept-author` exempt の通過/拒否と権限ラベル self-付与の gate 拒否、(d) metrics の介入判定式 (承認は介入不算入)、(e) verifier 別セッションコメントの台帳不算入と open thread の merge 阻止、(f) 承認後の新 commit での再 review、(g) `risk-tier` の changed paths + 承認記録判定 (high 昇格・low 免除)、(h) `status-exclusivity` のラベル乖離注入 fail、(i) `config-consistency` と `no-state` の乖離・書込経路注入 fail、(j) 定数アサーションの `accept-vacuity` fail、(k) contextBudget 上限超過の間引き挙動。選択 provider の決定表 fixture MUST 通過 (§11・緩和: プロジェクトの provider のみ)。hidden marker の raw 永続と API fallback (§12) も回帰 MUST に含む。runtime provider × seat の録画 conformance suite (しきい値 99/100) も MUST 通過。
- M3: low tier (cohort:typical) は承認なしでマージできる設定へ移行済み MUST。metrics.mjs による cohort:typical の自律マージ率 80% 以上 MUST。GitLab provider を選択したプロジェクトは `sha-approval` の再照合 (push 後の承認無効) と `status-exclusivity` fallback の fixture MUST 通過 (選択 provider の conformance は §11 前段)。

## 11. Forge object model (normative)

- `forge` の forge provider = `src/forge.mjs` の adapter 実装。forge provider 固有処理は `src/forge/<provider>.mjs` に MUST 分離。runtime provider (LLM モデル) とは語を分離 (§1)。
- 永続状態は下表の normalized class のみが MUST 保持。platform 固有 object (GitHub Projects、GitLab Epic、roadmap) は MUST NOT 決定表 (§7) に入らない。

| class | GitHub | GitLab | 要求 capability |
|---|---|---|---|
| Issue | Issue | Issue | body・note・label |
| ChangeRequest | PR | MR (同一 project branch) | diff・checks・thread・承認 |
| Note | Issue comment | note | claim 書式 (§7) 共通・hidden marker (§12) を raw で MUST 読取 |
| Label | label | scoped label | 状態語の単一集合排他 MUST |
| Check | check job | pipeline job | 決定表の入力 |
| Plan | milestone | milestone | 計画専用 (状態 MUST NOT) |
| PlanGroup | 相当なし (MUST 省略可) | Epic | 計画専用・決定表 MUST NOT |
| Protection | branch protection + required check + review | protection rule + pipeline 成功必須 + approval rule | ゲート (§8) |
| Config | framework commit (config.json・projects.json) | 同左 | §2.6。プロジェクト本体 repo に設定 MUST コミしない |

- label 排他: 同一 Issue に状態語ラベルを同時設定 MUST NOT。GitLab の scoped label は Premium 限定なので、利用不可 (Free) の場合も含め provider を問わず deterministic check `status-exclusivity` が MUST 保証 (GitLab で native が有効なら補助として併用可)。
- 承認失効 (§8): GitHub は commit 駆動 dismiss、GitLab は native の approval-reset 設定 (+ 設定が使えない環境では `sha-approval` check) で MUST 検証。
- thread 解決: GitHub の review thread・GitLab の unresolved discussion、`review-threads` check が API から MUST 読む。
- check 粒度: GitHub の required status check は check 名を個別指定できるが、GitLab の protected merge は pipeline 全体の成功が基本。GitLab では adapter MUST が pipeline の job 結果 (accept / risk-tier / review-threads / status-exclusivity / sha-approval / config-consistency) を MR の check 状態に写して個別判定可能にする MUST (マージ必須 check 指定は GitLab の設定で pipeline 成功 + 個別 job の MUST success 化で足りる)。
- tier path (§8): `tiers.highPaths` は provider 固有表記 MUST (GitHub `.github/workflows/`、GitLab `.gitlab-ci.yml` と `include:` 先ファイル)。GitLab の path ベース承認 (Code Owners) は Premium 限定なので、tier 判定は `risk-tier` check で MUST 担保 (free でも動く)。
- provider conformance (緩和): 選択 forge provider の決定表 fixture MUST 通過。2 provider (GitHub / GitLab) 両方の conformance 維持は RECOMMENDED な拡張で、プロジェクトのスコープは選択 forge provider のみ (§11 前段・§10 M2)。未通過の forge provider は本番利用 MUST NOT。
- Plan / PlanGroup は読み取らない: scan は label・note・checks のみ (§7)。

## 12. Hidden marker (normative)

- 補助的な stateful 情報は HTML comment (`<!-- ... -->` = hidden) に MUST 埋め込む。UI では見えないが raw は API で決定論的に返る (GitHub / GitLab とも raw body・note を保存・返すこと MUST 検証済み)。書式は固定: `<!-- fp:<key> <value> -->`。
- 利用可な key (固定): `session` (claim header と同一コメントに併記)、`scope` (§5 の条項参照宣言)、`summary` (submit turn の決定論的記録: resume 点 + 条項参照。中間判断は書かない MUST (§2.1)。同一コメント内に hidden で書き、別コメントを増やさない — marker のために台帳 comment 数は増えないが、submit turn の comment 自体は agent 著者 comment として台帳算入 (§7) のまま)。字数上限は config.json の `contextBudget` (§6)。
- gate 入力 MUST hidden に書かない: label / 承認 / check / thread の判定 (§7・§8) は API の可視フィールドのみを読む。hidden の値を gate の判定に使う MUST NOT。
- marker 欠損・破損時は API 可視フィールドと claim コメント header に MUST fallback (§7)。hidden は補助情報であり、失われても復元決定は成立する。
