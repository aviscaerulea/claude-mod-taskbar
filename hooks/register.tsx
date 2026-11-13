import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, Plan, PlanStatus, PlanStep } from '../types'

// モデルが呼ぶ計画ツールの完全名（$.tool.register の name は「plan」）
const PLAN_TOOL = 'mcp__task-bar__plan'

// 描画が読む計画は reload を越えて残る $.state に置く
const planAtom = atom({ plugin: 'task-bar', key: 'plan' } as const, null)

// 全完了した計画を 100% のまま見せておく時間（ミリ秒）
const DONE_HOLD_MS = 20_000
// 計画なしで何回ツールを呼んだら作成を促すか
const NUDGE_AFTER = 1
// 完了数が変わらないまま、正常に終わったツールを何回呼んだら更新を促すか（利用者の指定）
// 手順の完了の報告漏れに気付くきっかけを作るのが目的で、厳密な検出は狙わない（利用者の判断）
const STALE_AFTER = 5
// 実行中の手順の区間を、何ミリ秒ごとに上限までの残りの半分ずつ伸ばすか（減速しながら上限へ近づき、上限には届かない）
const CREEP_HALF_MS = 30_000
// 時間経過で伸ばす上限を、実行中の 1 件の区間に対する割合で示す（利用者の指定）
// 時間経過だけでバー上の 1 件分が完了したように見せないため、区間の終端より手前で止める
const CREEP_CAP = 0.75
// 完了数か実行中の手順が変わったとき、前の位置から新しい位置まで何ミリ秒で動かすか
const CATCH_MS = 1_000
// バーを描き直す間隔（ミリ秒）。エンジンは描き直しを 1 秒 10 回までにまとめるので、それより粗くする
// スピナーもこの間隔で 1 コマ進むため、回転が滑らかに見える 125 にする（1 回転は 1.25 秒）
const TICK_MS = 125
// bodyColumns が取れないときの幅（セル数）
const BAR_FALLBACK = 30
// plan ツールが受け付ける手順の状態
const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']
// 終了通知の task.status と、エージェント一覧の status のうち、作業単位を完了として扱う値
// killed は TaskStop 以外の停止、つまり利用者が画面で止めたときに届く（どちらも実機で確認済み）
const ENDED: readonly string[] = ['completed', 'failed', 'killed']

// バーの完了区間と、件数の文字
const BAR_COLOR = '#6b8fc6'
// バーの残りの区間の色（暗い灰色。利用者の指定）
// 文字と背景のコントラストを自動で上げるターミナルでは、暗い色を指定しても明るい灰色に引き上げられる（herdr 上で確認）。
// そのため色を暗くする代わりに、残りの区間は粗い点「·」で描いて目立たせない（利用者の判断）
const REST_COLOR = '#3a3a3a'
// 残りの区間のうち、件数の区切りにあたるセルに描く記号で、「·」より大きい点で区切りを示す（利用者の指定）
const REST_MARK = '•'
// 区切りの記号の色で、完了区間の青と反対側の色相の琥珀色を太字で描く（利用者の指定）。
// 完了区間と同じ青では目立たなかった。ターミナルのコントラスト補正が明るさの差を縮めるので、明るさでなく色相で区別する
const MARK_COLOR = '#e5a54b'
// バーの左端で回すスピナーのコマ（利用者が指定した点字の回転）と、全完了のときに代わりに描く記号
const SPIN_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// 完了の記号は ✔（U+2714）でなく ✓（U+2713）にする。✔ は絵文字の性質を持ち、2 セル幅で描くターミナルではバーが 1 セルずれるため
const SPIN_DONE = '✓'
// 完了区間と矢印に流す光の色（暗い順の 4 段。最も暗い段は完了区間と同じ青で、光の外側はこの色になる）
// filetree mod の光る演出に倣い、帯の中心からの距離で段を選ぶ（利用者の指定）
const SHINE_TONES = [BAR_COLOR, '#8eaad8', '#b6cbec', '#e4ecfa']
// 光の帯が 1 コマで進むセル数の基準（バーの長さの分は SHINE_ACCEL で足す）と、バーの両端の外側で帯を消しておくセル数（filetree mod と同じ値）
const SHINE_STEP = 1.6
const SHINE_PAD = 4
// バーの長さ 1 セルにつき、帯が 1 コマで進むセル数に足す量で、長いバーほど少し速く流す（利用者の指定）
// 幅 80 の画面でバーが全部進んだとき（57 セル）に約 1.7 倍の速さになり、端から端までを約 3 秒で渡る
const SHINE_ACCEL = 0.02
// 描画の順序が入れ替わり、少し前の時刻の描画が後から届いたときに、新しい計画とはみなさない巻き戻りのコマ数
const SHINE_LAG = 2

// システムプロンプトに足す節（モデルだけが読む）
const PLAN_PROMPT =
  `Your to-do list is the ${PLAN_TOOL} tool (this app has no TodoWrite). The user watches it as a progress bar. ` +
  'For any task that needs 2 or more steps or tool calls, call it first, before other tools, with every step in order and the first one in_progress. ' +
  'Call it again with the full list each time a step finishes or a new one starts. Mark the last step completed before your final answer. ' +
  'A step that launches subagents is one step. Skip it only for a one-line answer with no tool calls.'

// ツール結果に付ける催促文（モデルだけが読む）
const NUDGE_NEW = `Task bar: you have no plan for this task yet. Call ${PLAN_TOOL} now with every step in order, so the user sees your progress.`
const NUDGE_CONT = `Task bar: the plan has not changed this turn. If this is a new task, call ${PLAN_TOOL} with its steps. If it carries on the last one, send the updated list.`
const NUDGE_STALE = `Task bar: no step has been marked completed in a while. If a step finished, call ${PLAN_TOOL} with the full list now.`

// 催促の計数（ターン単位で数えるため $.state に置かない）
let turnCalls = 0
let turnPlanned = false
let nudged = false
// 完了数が最後に変わってから、正常に終わったツールの呼び出し回数
let sinceDone = 0
// 最後に保存した計画の完了数（-1 は未保存。計画の送り直しで完了数が変わったかを見るため）
let lastDone = -1
let staleNudged = false

// メインの会話のターンが動いている間 true（turn.start で立て、turn.complete で下ろす）
// reload で false に戻るが、続くターンの turn.complete で完了を判定し直すので、表示は終わりに揃う
let mainTurn = false
// 全完了した計画を隠すタイマー（reload で止まるため、モジュール変数で足りる）
let holdTimer: { cancel: () => void } | null = null
// 光の帯の位置（セル）と、その位置まで進めたコマ（経過時間を TICK_MS で割った値）
// reload で初期値（左端の外）に戻っても、帯は左端の外から流れ直すだけで、表示は崩れない
let shine = { pos: -SHINE_PAD, frame: 0 }
// 計画を表示している間だけバーを描き直し続けるタイマー（reload で止まるため、session.start で張り直す）
let ticker: { cancel: () => void } | null = null

/** n 文字を超える文字列を、末尾を「…」にして n 文字に切る */
const cut = (t: string, n: number) => (n <= 0 ? '' : t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t)
/** 改行と連続する空白を 1 つの空白にまとめる */
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
/** 手順の状態として受け付ける値か */
const isStatus = (v: unknown): v is PlanStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
/** completed の手順の数 */
const doneCount = (steps: PlanStep[]) => steps.filter(st => st.status === 'completed').length
/** 手順が 1 つ以上あり、すべて completed か（催促と題名の引き継ぎは手順だけで判断する） */
const isAllDone = (steps: PlanStep[]) => steps.length > 0 && steps.every(st => st.status === 'completed')

/** 計画の作業単位（reload 前の版が書いた値には無いので空とする） */
const jobsOf = (plan: Plan | null) => plan?.jobs ?? []
/**
 * 手順と作業単位を合わせた件数 n と完了数 done
 * バーの件数、百分率、割合はこの値で数え、サブエージェント 1 体とシェルコマンド 1 本をそれぞれ 1 件とする（利用者の指定）。
 */
function units(plan: Plan) {
  const jobs = jobsOf(plan)
  return { n: plan.steps.length + jobs.length, done: doneCount(plan.steps) + jobs.filter(j => j.done).length }
}
/** 未完了の作業単位の数 */
const runningJobs = (plan: Plan | null) => jobsOf(plan).filter(j => !j.done).length
/** 手順と作業単位が 1 つ以上あり、すべて完了か（作業単位が残る間は、手順が全完了でも計画を終えない） */
function isPlanDone(plan: Plan) {
  const u = units(plan)
  return u.n > 0 && u.done === u.n
}

/**
 * 計画が完了したか（手順と作業単位がすべて完了し、メインのターンも終わった）
 * finished の無い計画（reload 前の版の値）は、すべて完了していれば完了とみなす。
 */
const isFinished = (plan: Plan) => isPlanDone(plan) && plan.finished !== false
/** すべて完了したが、メインのターンが続いていて、Claude がまとめを書いている間か */
const isFinishing = (plan: Plan) => isPlanDone(plan) && !isFinished(plan)

/** 完了数、件数、実行中の手順の位置、未完了の作業単位の数をまとめた値（これが変わったときだけバーの動きの起点を置き直す） */
function progressKey(plan: Plan) {
  const u = units(plan)
  return `${u.done}/${u.n}/${plan.steps.findIndex(st => st.status === 'in_progress')}/${runningJobs(plan)}`
}

/**
 * 時刻 now にバーが描く割合（0〜1）を求める
 * 件数と完了数は手順と作業単位を合わせて数える（units）。
 * 実行中の手順か未完了の作業単位があれば、区間に CREEP_CAP を掛けた位置を上限とし、次の 1 件の区間を起点から CREEP_HALF_MS ごとに上限までの残りの半分ずつ伸ばし、完了の報告が届くまで上限には届かせない。
 * 起点が区間の中で上限を超えているとき（伸びている途中で件数が増えたとき）は、起点で留めて巻き戻さない。
 * 伸ばす起点は、完了数の位置と起点の割合 from の大きい方とし、止めた位置から再開してもバーを巻き戻さない。
 * from が区間の終端を超えるとき（完了数の少ない計画に置き換わったとき）は、完了数の位置から伸ばし、バーはそこへ戻る。
 * 起点 at から CATCH_MS の間は、from からその位置へ動かす。paused の計画は from の位置で止めたまま描く。
 * from と at が無い計画（reload 前の版の値）は、完了数の位置で止まったものとして描く。
 */
function shownRatio(plan: Plan, now: number) {
  const { n, done } = units(plan)
  if (!n) return 0
  const base = done / n
  const from = plan.from ?? base
  if (plan.paused) return from
  const dt = Math.max(0, now - (plan.at ?? now))
  const running = plan.steps.some(st => st.status === 'in_progress') || runningJobs(plan) > 0
  const end = running ? base + 1 / n : base
  const lo = from < end ? Math.max(base, from) : base
  const top = Math.max(lo, base + CREEP_CAP / n)
  const target = running ? lo + (top - lo) * (1 - 0.5 ** (dt / CREEP_HALF_MS)) : base
  const p = Math.min(1, dt / CATCH_MS)
  return from + (target - from) * p
}

/**
 * 時刻 now までの計画の経過時間（ミリ秒）を求める
 * 止めるまでに数えた spent に、数えている区間（startedAt から now）を足す。止めている間（startedAt が無い）は spent のまま。
 */
const elapsedMs = (plan: Plan, now: number) => (plan.spent ?? 0) + (plan.startedAt === undefined ? 0 : Math.max(0, now - plan.startedAt))

/**
 * 幅 barW のバーのうち、セル start から終端までの残りの区間を、色ごとに描き分ける連続した文字列の並びに分ける
 * n 件の区切り（k 件目の終わり、k = 1〜n-1）にあたるセルを REST_MARK（mark が true）、それ以外を「·」の連なりにする。
 * 区切りのセルは完了区間の長さと同じ切り捨ての式で求めるので、k 件が完了した時点で先端の矢印が来るセルと一致し、矢印に隠れる。
 */
function restRuns(barW: number, start: number, n: number) {
  const marks = new Set<number>()
  for (let k = 1; k < n; k++) marks.add(Math.floor((barW * k) / n + 1e-9))
  const runs: { text: string; mark: boolean }[] = []
  for (let i = Math.max(0, start); i < barW; i++) {
    const mark = marks.has(i)
    const last = runs[runs.length - 1]
    if (last && !mark && !last.mark) last.text += '·'
    else runs.push({ text: mark ? REST_MARK : '·', mark })
  }
  return runs
}

/**
 * 時刻 now にバーの左端へ描くスピナーの 1 文字を求める
 * 完了した計画では SPIN_DONE を返す。それ以外は（まとめ中も含めて）、経過時間が TICK_MS 進むごとに SPIN_FRAMES を 1 コマ進める。
 * 理由：経過時間は中断で止まるので、止めた計画では止めた時点のコマがそのまま残り、状態を別に持たずに済む（止まったコマは利用者の指定）
 */
function spinChar(plan: Plan, now: number) {
  if (isFinished(plan)) return SPIN_DONE
  return SPIN_FRAMES.charAt(Math.floor(elapsedMs(plan, now) / TICK_MS) % SPIN_FRAMES.length)
}

/**
 * 完了区間と先端の矢印を、色ごとに描き分ける連続した文字列の並びに分ける
 * セル 0 から fillC までを「━」、続く tip（空なら無し）を矢印として、どれも BAR_COLOR で描く。矢印は色が同じでも「━」の連なりに混ぜない。
 * 実行中の手順か未完了の作業単位がある間と、まとめ中の間は、完了区間と矢印の全体に光の帯を左から右へ流す（利用者の指定）。
 * 帯は経過時間の 1 コマごとに、SHINE_STEP にバーの長さに応じた SHINE_ACCEL の分を足したセル数だけ進む。
 * 矢印の SHINE_PAD セル先へ抜けたら、左端の SHINE_PAD セル手前から出直す。
 * 中断で止めた計画と完了した計画では流さない（止まった帯は表示の乱れに見えるため）。
 * 理由：帯の位置を経過時間から一度に求めると、バーが伸びて往復の長さや速さが変わったコマで帯が飛ぶため、位置を shine に持って前のコマから進める
 * 注意：描画は経過時間を読む前に待ち合わせるので、前後して届くことがある。SHINE_LAG コマまでの巻き戻りでは帯を動かさない
 */
function fillRuns(plan: Plan, now: number, fillC: number, tip: string) {
  const running = !plan.paused && (plan.steps.some(st => st.status === 'in_progress') || runningJobs(plan) > 0 || isFinishing(plan))
  const cells = [...'━'.repeat(fillC), ...tip]
  const frame = Math.floor(elapsedMs(plan, now) / TICK_MS)
  // 経過時間が SHINE_LAG コマより大きく巻き戻ったとき（新しい計画）は、左端の外から出直す
  if (frame < shine.frame - SHINE_LAG) {
    shine = { pos: -SHINE_PAD, frame }
  }
  else if (frame > shine.frame) {
    // 前のコマから進んだ分だけ動かし、矢印の先へ抜けたら左端の外から出直す
    const pos = shine.pos + (frame - shine.frame) * (SHINE_STEP + cells.length * SHINE_ACCEL)
    shine = { pos: pos > cells.length + SHINE_PAD ? -SHINE_PAD : pos, frame }
  }
  const band = shine.pos
  const runs: { text: string; color: string }[] = []
  cells.forEach((ch, i) => {
    const d = running ? Math.abs(i - band) : Infinity
    const color = SHINE_TONES[d < 0.8 ? 3 : d < 1.8 ? 2 : d < 2.8 ? 1 : 0] ?? BAR_COLOR
    const last = runs[runs.length - 1]
    if (last && last.color === color && i < fillC) last.text += ch
    else runs.push({ text: ch, color })
  })
  return runs
}

/** ミリ秒を「時:分:秒」（例：0:01:05）にする */
function clockText(ms: number) {
  const s = Math.floor(ms / 1000)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
}

/** mod 内部の失敗をトーストで知らせる（トースト自体の失敗は無視する） */
function warn($: EngineInterface, err: unknown) {
  try {
    $.ui.toast(cut(`task-bar: ${String(err)}`, 140))
  }
  catch {
    // トーストは知らせるだけなので、失敗しても続ける
  }
}

/**
 * バーを描き直すタイマーを、計画を表示しているかに合わせて張るか止める
 * 表示中はバーが時間で伸び、スピナーが回るため、描き直しを TICK_MS ごとに求め続ける。
 */
function syncTicker($: EngineInterface, shown: boolean) {
  if (shown) {
    ticker ??= $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
  }
  else {
    ticker?.cancel()
    ticker = null
  }
}

/** 計画を隠し、保留タイマーと描き直しタイマーを止める */
async function hidePlan($: EngineInterface) {
  holdTimer?.cancel()
  holdTimer = null
  syncTicker($, false)
  await update($, planAtom, p => (p ? { ...p, shown: false } : p))
}

/**
 * applyPlan が古い計画から作る、新しい計画の題名、手順、作業単位
 * keepPause は、作業単位の出入りだけを反映する更新の印で、中断で止めた計画を止めたまま書き換える（applyPlan の説明を参照）。
 */
type PlanChange = { title?: string; steps: PlanStep[]; jobs: Job[]; keepPause?: boolean }

/**
 * 計画を、古い計画から作った内容で丸ごと置き換える
 * 内容は make が update の中で古い計画から作る。サブエージェントの終了と手順の送り直しが続けて届いても、先の更新を古い値で上書きしないため。
 * 手順と作業単位がすべて完了し、メインのターンも動いていなければ完了（finished）とし、DONE_HOLD_MS 後に表示を消す。
 * すべて完了してもメインのターンが動いていれば、まとめ中として経過時間を数え続け、完了は turn.complete に任せる（利用者の指定）。
 * 題名がなければ、作業途中の前の計画からだけ題名を引き継ぎ、手順もなければ空にする。
 * 完了数か実行中が変わったときは、いまバーが描いている割合を起点にして新しい位置へ動かす。
 * 同じ状態の送り直しでは起点を保ち、バーを巻き戻さない。止めていたバーは、止めた位置から動かし直す。前の計画が隠れていれば 0 から動かす。
 * 経過時間は、表示中の計画からはそこまでの値を引き継ぎ、隠れた後の計画では 0 から数える。完了した計画では数えるのを止める。
 * keepPause の更新（作業単位の追加、完了、捨て）では、中断で止めた計画の paused、バーの位置、経過時間をそのまま保ち、件数だけを変える。
 * 中断した計画は、次に計画が届くまで止めたままにするため（利用者の判断で、バックグラウンド作業が動き続けていても同じ）。
 * ただし手順と作業単位がすべて完了になったときは、止めたままにしない。メインのターンが動いていなければ完了として 100% にして DONE_HOLD_MS 後に消し、動いていればまとめ中にする。
 */
async function applyPlan($: EngineInterface, make: (old: Plan | null) => PlanChange) {
  const now = await $.clock.now()
  let made: Plan | null = null
  await update($, planAtom, old => {
    const c = make(old)
    const done = isPlanDone({ title: '', steps: c.steps, jobs: c.jobs, shown: true })
    const finished = done && !mainTurn
    if (c.keepPause && old?.shown && old.paused && !done) {
      made = { ...old, steps: c.steps, jobs: c.jobs }
      return made
    }
    const next: Plan = {
      // 手順のない計画は題名を空のまま持ち、描画で Background と出す（後から届いた計画が Background を題名として引き継がないように）
      title: c.title || (old && !isAllDone(old.steps) ? old.title : '') || (c.steps.length ? 'Plan' : ''),
      steps: c.steps,
      jobs: c.jobs,
      shown: c.steps.length + c.jobs.length > 0,
      from: 0,
      at: now,
      spent: old?.shown ? elapsedMs(old, now) : 0,
      startedAt: finished ? undefined : now,
      finished,
    }
    made = old?.shown && !old.paused && progressKey(old) === progressKey(next)
      ? { ...next, from: old.from, at: old.at }
      : old?.shown ? { ...next, from: shownRatio(old, now) } : next
    return made
  })
  // made は update のコールバック内で代入するため、型の絞り込みが null のままにならないよう型を明示して読む
  const shown = made as Plan | null
  holdTimer?.cancel()
  holdTimer = null
  syncTicker($, !!shown?.shown && !shown.paused)
  if (shown && isFinished(shown)) {
    holdTimer = $.clock.after(DONE_HOLD_MS, () => {
      holdTimer = null
      void hidePlan($).catch(err => warn($, err))
    })
  }
}

/**
 * 作業単位を未完了として計画に加える（同じ id があれば置き換え、再開したサブエージェントを未完了に戻す）
 * 表示中の計画の手順と題名はそのまま残す。計画がないか隠れていれば、手順のない計画として表示する。
 */
async function addJob($: EngineInterface, job: Job) {
  await applyPlan($, old => ({
    title: old?.shown ? old.title : undefined,
    steps: old?.shown ? old.steps : [],
    jobs: [...(old?.shown ? jobsOf(old) : []).filter(j => j.id !== job.id), job],
    keepPause: true,
  }))
}

/**
 * id の作業単位を完了にする（kind を渡すと、その種類の作業単位だけを対象にする）
 * 表示中の計画に未完了のその作業単位があるときだけ書き換える。終了通知の行は描画のたびと reload のたびに届き直すため、何度呼ばれても結果は同じになる。
 */
async function finishJob($: EngineInterface, id: string, kind?: Job['kind']) {
  const plan = await read($, planAtom)
  if (!plan?.shown || !jobsOf(plan).some(j => j.id === id && !j.done && (!kind || j.kind === kind))) return
  await applyPlan($, old => ({
    title: old?.title,
    steps: old?.steps ?? [],
    jobs: jobsOf(old).map(j => (j.id === id ? { ...j, done: true } : j)),
    keepPause: true,
  }))
}

/**
 * plan ツールの入力を検証して計画に反映する
 * text はモデルへ返す 1 行の結果。不正な入力では計画を変えず、saved を false にする。
 */
async function planFromTool($: EngineInterface, args: Record<string, unknown>): Promise<{ saved: boolean; text: string; done?: number }> {
  const reject = (text: string) => ({ saved: false, text: `Plan not saved: ${text}` })
  const raw = args.steps
  if (!Array.isArray(raw)) return reject('send steps as a list of { text, status }.')
  const steps: PlanStep[] = []
  for (const st of raw as unknown[]) {
    const o = (st && typeof st === 'object' ? st : {}) as Record<string, unknown>
    const text = typeof o.text === 'string' ? oneLine(o.text) : ''
    if (!text) return reject('every step needs its text.')
    if (!isStatus(o.status)) return reject(`"${cut(text, 40)}" needs a status of pending, in_progress or completed.`)
    steps.push({ text, status: o.status })
  }
  // 表示中の計画の作業単位は引き継ぐ（隠れた計画の作業単位はすべて完了済みなので捨てる）
  const title = typeof args.title === 'string' ? oneLine(args.title) : undefined
  await applyPlan($, old => ({ title, steps, jobs: old?.shown ? jobsOf(old) : [] }))
  return { saved: true, text: `Plan saved: ${doneCount(steps)} of ${steps.length} steps done.`, done: doneCount(steps) }
}

/** 催促の計数を新しい作業の開始時点に戻す */
function resetNudge() {
  turnCalls = 0
  turnPlanned = false
  nudged = false
  sinceDone = 0
  lastDone = -1
  staleNudged = false
}

/**
 * メインセッションのツール結果に催促文を足す
 * そのターンで計画がないままツールを呼んだときに 1 回、完了数が長く変わらないときに 1 回足す。
 * 完了数の停滞は、拒否もエラーもなく終わった呼び出しだけで数える（失敗した呼び出しは手順を進めていないため）。
 */
async function withNudge<R>($: EngineInterface, r: R): Promise<R> {
  turnCalls++
  const failed = !r || typeof r !== 'object' || 'deny' in (r as object) || (r as { isError?: boolean }).isError === true
  if (!failed) sinceDone++
  const plan = await read($, planAtom).catch(() => null)
  const live = !!plan && plan.steps.length > 0 && !isAllDone(plan.steps)
  let note: string | null = null
  if (!turnPlanned && !nudged && turnCalls >= NUDGE_AFTER) {
    nudged = true
    note = live ? NUDGE_CONT : NUDGE_NEW
  }
  else if (live && !staleNudged && sinceDone >= STALE_AFTER) {
    staleNudged = true
    note = NUDGE_STALE
  }
  if (!note || !r || typeof r !== 'object' || 'deny' in (r as object)) return r
  const had = (r as { context?: readonly string[] }).context ?? []
  return { ...r, context: [...had, note] }
}

/**
 * メインの会話のツール結果から作業単位を記録する
 * Bash の結果に backgroundTaskId があれば、バックグラウンドのシェルコマンドとして加える（Ctrl+B やタイムアウトで後から裏へ回ったものも含む）。
 * TaskStop で止めた作業には終了通知が来ないため（実機で確認済み）、結果の task_id（無ければ入力の task_id）の作業単位をここで完了にする。
 * 拒否やエラーで終わった呼び出しは、作業を起動も停止もしていないので何もしない（停止に失敗した作業を完了にしないため）。
 */
async function trackJob($: EngineInterface, tool: string, input: Record<string, unknown>, r: unknown) {
  if (!r || typeof r !== 'object' || 'deny' in r || (r as { isError?: boolean }).isError === true) return
  const res = (r as { result?: unknown }).result
  if (tool === 'Bash') {
    const bg = res && typeof res === 'object' ? (res as { backgroundTaskId?: unknown }).backgroundTaskId : undefined
    if (typeof bg !== 'string' || !bg) return
    const label = oneLine(String(input.description || input.command || 'shell'))
    await addJob($, { id: bg, kind: 'shell', label, done: false })
  }
  else if (tool === 'TaskStop') {
    const stopped = stoppedId(res) ?? (typeof input.task_id === 'string' ? input.task_id : undefined)
    if (stopped) await finishJob($, stopped)
  }
}

/** TaskStop の結果（JSON の文字列かオブジェクト）から、止めた作業の task_id を取り出す（取れなければ undefined） */
function stoppedId(res: unknown): string | undefined {
  let o: unknown = res
  if (typeof res === 'string') {
    try {
      o = JSON.parse(res)
    }
    catch {
      return undefined
    }
  }
  const id = o && typeof o === 'object' ? (o as { task_id?: unknown }).task_id : undefined
  return typeof id === 'string' && id ? id : undefined
}

/**
 * mod のフックを登録する
 * plan ツールの登録、システムプロンプトへの指示、催促文、回答終了時の完了の補完、プロンプト上の計画バーの描画を担う。
 * メインの会話が起こしたサブエージェントとバックグラウンドのシェルコマンドも、1 件ずつ作業単位としてバーの件数に加える。
 */
export const register: Register = on => {
  // plan ツールを登録し、reload 前の全完了の計画を隠す
  on('session.start', async ($, e, next) => {
    await $.tool
      .register({
        name: 'plan',
        description:
          'Save the plan for the job in front of you: the steps in order, each pending, in_progress or completed. ' +
          'It draws a progress bar above the prompt for the user. Send the whole list every time, like TodoWrite. ' +
          'Only the main chat uses it: a subagent never calls it.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short name for the job, a few words.' },
            steps: {
              type: 'array',
              description: 'Every step, in order.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'The step in a few plain words.' },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['text', 'status'],
              },
            },
          },
          required: ['steps'],
        },
        // ToolSearch の後ろに隠れるとモデルが呼ばないため、常にモデルへ見せる
        isDeferred: false,
      })
      .catch(err => warn($, err))
    // reload で保留タイマーと描き直しタイマーが消えるため、完了した計画はここで隠し、作業途中とまとめ中の計画は描き直しを張り直す。
    // 表示の失敗でセッションの開始を止めない
    try {
      const plan = await read($, planAtom)
      if (plan?.shown && isFinished(plan)) await hidePlan($)
      else syncTicker($, !!plan?.shown && !plan.paused)
    }
    catch (err) {
      warn($, err)
    }
    return next(e)
  })

  // plan ツールの使い方をシステムプロンプトに足す（teammate と bare の構成には足さない）
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('teammate') || e.traits.includes('bare')) return r
    return { sections: [...r.sections, { id: 'task-bar:plan', text: PLAN_PROMPT, scope: 'session' as const }] }
  })

  // 利用者が送ったプロンプトは新しい作業として、催促を数え直す（通知やスケジュール実行では数え続ける）
  // 完了した計画は、20 秒の保留を待たずにここで隠す。モデルが新しい計画を送るまで前回の表示が残って見えるため（利用者の判断）。
  // まとめ中の計画は、作業中に送った追加のプロンプトでは隠さない（ターンが続いているため）。
  // 作業途中の計画は、続きの指示かもしれないので残す。ただし完了済みの作業単位は前の依頼のものとして捨て、未完了のものは残す。表示の失敗で送信を止めない
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      resetNudge()
      try {
        const plan = await read($, planAtom)
        if (plan?.shown && isFinished(plan)) await hidePlan($)
        else if (plan?.shown && jobsOf(plan).some(j => j.done)) {
          await applyPlan($, old => ({ title: old?.title, steps: old?.steps ?? [], jobs: jobsOf(old).filter(j => !j.done), keepPause: true }))
        }
      }
      catch (err) {
        warn($, err)
      }
    }
    return next(e)
  })

  // メインの会話が起動したサブエージェントを作業単位として件数に加える（フォアグラウンドもバックグラウンドも 1 体 1 件）
  // サブエージェント内部の手順は数えない（利用者の指定）。入れ子のサブエージェント、teammate、Workflow 内部の agent も数えない。
  // 再開（resume）はその id の作業単位を未完了に戻す。起動を断られたものは加えない。数えられなくても起動は止めない
  // 作業単位を加えた後に、エージェント一覧でその id がもう終わっていないかを突き合わせ、終わっていれば完了にする。
  // 起動直後に終わると、ここへ戻る前に turn.complete が届き、作業単位が無いので finishJob が何もしないまま過ぎるため。
  // 突き合わせは作業単位を加えた後に行うので、終了がその前に届いても後に届いても取りこぼさない（再開の実行も同じ）
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (e.parentAgentId !== undefined || e.isTeammate || e.workflow || r.deny !== undefined) return r
    const id = e.resume?.agentId ?? r.agentId
    if (!id) return r
    try {
      await addJob($, { id, kind: 'agent', label: oneLine(e.description || e.subagentType), done: false })
      const row = (await $.agent.list()).find(a => a.id === id)
      if (row && ENDED.includes(row.status)) await finishJob($, id)
    }
    catch (err) {
      warn($, err)
    }
    return r
  })

  // メインの会話のターンが動いている間を記録する（すべて完了しても、ターンが終わるまでは 100% にしないため）
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainTurn = true
    return next(e)
  })

  // サブエージェントのターンが終わったとき、その作業単位を完了にする（1 回の実行が 1 ターン。実機で、同じ agentId で届くことを確認済み）
  // 利用者が画面から止めたときも、reason が aborted の turn.complete が同じ agentId で届く（実機で確認済み）ので、終わり方は問わない。
  // その id の作業単位がまだ無いとき（起動直後に終わった場合）は何もせず、agent.spawn 側の突き合わせに任せる。
  // メインのターンが回答で終わったとき、未完了の手順は全完了として扱う。
  // モデルが最終回答の前に最後の手順を completed にし忘れると、バーが途中のまま残るため（利用者の判断）。
  // 未完了の作業単位が残る間は、手順が全完了でも計画は終わらず、バーは 100% にならない（作業単位の終了で完了する）。
  // 質問のために途中で止まった場合も手順は全完了になるが、次のターンでモデルが計画を送り直せば、新しい計画に置き換わる。
  // 中断、拒否、エラーで終わったときは、作業が止まったのでバーと経過時間をその位置で止め、描き直しも止める（利用者の判断）
  // すべて完了してまとめ中だった計画は、終わり方を問わず、ここで完了にする（Claude の作業が終わるまで 100% にしない。利用者の指定）
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) {
      await finishJob($, e.agentId).catch(err => warn($, err))
      return r
    }
    mainTurn = false
    try {
      const plan = await read($, planAtom)
      if (!plan?.shown) return r
      if (isFinishing(plan)) {
        await applyPlan($, old => ({ title: old?.title, steps: old?.steps ?? [], jobs: jobsOf(old) }))
        return r
      }
      if (isAllDone(plan.steps)) return r
      if (e.reason === 'answer') {
        await applyPlan($, old => ({
          title: old?.title,
          steps: (old?.steps ?? []).map(st => ({ ...st, status: 'completed' as const })),
          jobs: jobsOf(old),
        }))
      }
      else {
        const now = await $.clock.now()
        syncTicker($, false)
        await update($, planAtom, p => (p ? { ...p, from: shownRatio(p, now), at: now, paused: true, spent: elapsedMs(p, now), startedAt: undefined } : p))
      }
    }
    catch (err) {
      warn($, err)
    }
    return r
  })

  // /clear と resume では会話が替わるため、前の会話の計画と催促の計数を捨てる
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      resetNudge()
      holdTimer?.cancel()
      holdTimer = null
      syncTicker($, false)
      await update($, planAtom, () => null).catch(err => warn($, err))
    }
    return next(e)
  })

  // 型付きの tool マッチャは tsc が型を再帰で展開し続けるため、マッチャなしの 1 本で分岐する
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    const id = e.agentId
    if (tool === PLAN_TOOL) {
      if (id) return { result: 'Only the main chat keeps a plan. Carry on with your task.' } as never
      let said: Awaited<ReturnType<typeof planFromTool>> = { saved: false, text: 'Plan not saved: something went wrong. Carry on.' }
      try {
        said = await planFromTool($, e as unknown as Record<string, unknown>)
      }
      catch (err) {
        warn($, err)
      }
      // 保存できなかった呼び出しでは、催促を止めない
      // 完了数が変わったときだけ停滞の計数を戻す。同じ完了数の送り直しでは戻さない（別の計画への置き換えで減ったときも戻す）
      if (said.saved) {
        turnPlanned = true
        if (said.done !== lastDone) {
          lastDone = said.done ?? -1
          sinceDone = 0
          staleNudged = false
        }
      }
      return { result: said.text } as never
    }
    // 催促と作業単位の記録は、メインセッションのツール呼び出しだけで行う
    if (id) return next(e)
    const r = await next(e)
    try {
      await trackJob($, tool, e as unknown as Record<string, unknown>, r)
    }
    catch (err) {
      warn($, err)
    }
    return withNudge($, r)
  })

  // 終了通知の行で、シェルコマンドの作業単位を完了にする
  // 行にはエンジンが通知を解析した task（id と status）が付くので、通知本文の書式には依存しない（利用者の判断）。
  // 画面外の行でも描かれ、reload のたびに過去の行も描き直されるが、finishJob は未完了の作業単位だけを変えるので結果は変わらない。
  // サブエージェントは対象にしない。再開すると同じ id の作業単位が未完了に戻るため、前の実行の通知の行が描き直されると、実行中なのに完了になってしまう。
  // サブエージェントの終了は turn.complete と TaskStop で拾う
  // 描画を待たせないよう、完了の記録は待たずに描画の結果を返す
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const r = await next(e)
    const task = e.props.task
    if (task?.id && task.status !== undefined && ENDED.includes(task.status)) void finishJob($, task.id, 'shell').catch(err => warn($, err))
    return r
  })

  // プロンプト上に計画バーを描く（ターミナルだけ）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const plan = await read($, planAtom)
    if (!plan || !plan.shown || !units(plan).n) return next(e)
    // 他の mod のバンドは上に残す。エンジン自身の表示は入れ子にしない
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const rest = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const { Box, Text } = $.ui.resolve(e)
    const w = e.props.bodyColumns > 0 ? Math.floor(e.props.bodyColumns) : BAR_FALLBACK

    // 1 行目：「題名：いまの手順 · N running in background」（全角の幅も画面側の truncate-end が数えて切る）
    //   いまの手順は、実行中の手順、次の手順、Finishing up（まとめ中）、All steps done の順に選ぶ。手順が全完了で作業単位が残るときは出さない。
    //   未完了の作業単位があるときだけ、その数を末尾に出す
    // 2 行目：スピナー、完了の区間、先端の矢印、残り、件数、百分率、経過時間（実行中の手順は 1 行目で示し、バーでは区別しない）
    //   スピナーは完了するまで回り、中断で止まり、完了で ✓ になる（利用者の指定）
    //   まとめ中は、バーを終端の 1 セル手前で止め、百分率を 99% にする（利用者の指定）
    //   完了区間と矢印には、実行中の間だけ光の帯を流す（fillRuns）
    // 題名の行を上、バーを下に置く（利用者の指定）
    // 件数は、完了した手順と作業単位だけで数える
    // 百分率は、バーと揃えるため、時間で伸びる推定の位置を含めたバーの割合から求める（利用者の指定）
    //   完了数の割合を下限とし、完了の報告が届いたら、バーが CATCH_MS かけて追い付くのを待たずに百分率を進める
    //   四捨五入にし、2/3 件の完了を前と同じ 67% と出す
    //   計画が完了するまでは 99% で止め、完了したらすぐ 100% にする（まとめ中も 99%。利用者の指定）
    //   四捨五入で 99.5% 以上になる 50 件以上の計画や、全完了したバーから新しい計画へ 1 秒かけて戻る間に、未完了の 100% を出さないため
    const { n, done } = units(plan)
    const bg = runningJobs(plan)
    const finishing = isFinishing(plan)
    const now = await $.clock.now()
    const ratio = shownRatio(plan, now)
    // 件数と百分率の桁が増えるたびにバーが縮むのを防ぐため、件数は「10/10」、百分率は「100%」の幅を確保し、足りない分は左を空白で埋めて右に寄せる（利用者の指定）
    // 100 件以上の計画では件数が確保した幅を超え、そのときだけバーが縮む
    const pct = `${isFinished(plan) ? 100 : Math.min(99, Math.round(Math.max(done / n, ratio) * 100))}%`.padStart(4)
    const label = `Tasks ${`${done}/${n}`.padStart(5)}`
    const current = plan.steps.find(st => st.status === 'in_progress')
    const nextUp = plan.steps.find(st => st.status === 'pending')
    const line = current ? current.text : finishing ? 'Finishing up' : done === n ? 'All steps done' : nextUp ? `Next: ${nextUp.text}` : ''
    const title = plan.title || 'Background'
    // 右端には計画の開始からの経過時間を出す（完了と中断で止まる。利用者の指定）
    const time = clockText(elapsedMs(plan, now))
    // バーはスピナー 1 セル、件数、百分率、経過時間と、その間の空白 4 つを除いた残りの幅いっぱいに描く
    const barW = Math.max(6, w - label.length - pct.length - time.length - 5)
    // 切り捨てで数え、実行中の区間が四捨五入で終端まで埋まって完了に見えるのを防ぐ（小数の誤差で 1 セル欠けないよう微小な値を足す）
    const fillC = Math.min(finishing ? barW - 1 : barW, Math.max(0, Math.floor(barW * ratio + 1e-9)))
    // 100% に届くまでは、完了区間の先に、棒より大きい矢印の先端を 1 セル描く（利用者の指定）
    const tip = fillC < barW ? '▶' : ''

    return (
      <Box flexDirection="column">
        {rest as never}
        <Box key="task-bar" flexDirection="column">
          <Box key="plan-line" width={w}>
            <Text wrap="truncate-end">
              <Text bold>{title}</Text>
              {line ? <Text dimColor>{`：${line}`}</Text> : null}
              {bg ? <Text dimColor>{` · ${bg} running in background`}</Text> : null}
            </Text>
          </Box>
          <Box key="plan-row" flexDirection="row" gap={1} width={w}>
            <Text color={BAR_COLOR}>{spinChar(plan, now)}</Text>
            <Text>
              {fillRuns(plan, now, fillC, tip).map((run, i) => (
                <Text key={`fill-${i}`} color={run.color}>
                  {run.text}
                </Text>
              ))}
              {restRuns(barW, fillC + tip.length, n).map((run, i) => (
                <Text key={`rest-${i}`} color={run.mark ? MARK_COLOR : REST_COLOR} bold={run.mark}>
                  {run.text}
                </Text>
              ))}
            </Text>
            <Text bold color={BAR_COLOR}>
              {label}
            </Text>
            <Text dimColor>{pct}</Text>
            <Text dimColor>{time}</Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
