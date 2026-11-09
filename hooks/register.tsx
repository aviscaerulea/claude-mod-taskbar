import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PlanStatus, PlanStep } from '../types'

// モデルが呼ぶ計画ツールの完全名（$.tool.register の name は「plan」）
const PLAN_TOOL = 'mcp__task-bar__plan'

// 描画が読む計画は reload を越えて残る $.state に置く
const planAtom = atom({ plugin: 'task-bar', key: 'plan' } as const, null)

// 全完了した計画を 100% のまま見せておく時間（ミリ秒）
const DONE_HOLD_MS = 20_000
// 計画なしで何回ツールを呼んだら作成を促すか
const NUDGE_AFTER = 1
// 計画の更新から何回ツールを呼んだら更新を促すか
const STALE_AFTER = 8
// bodyColumns が取れないときの幅（セル数）
const BAR_FALLBACK = 30
// plan ツールが受け付ける手順の状態
const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']

// バーの完了区間と、件数の文字
const BAR_COLOR = '#6b8fc6'
// バーの残りの区間の色（暗い灰色。利用者の指定）
// 文字と背景のコントラストを自動で上げるターミナルでは、暗い色を指定しても明るい灰色に引き上げられる（herdr 上で確認）。
// そのため色を暗くする代わりに、残りの区間は粗い点「·」で描いて目立たせない（利用者の判断）
const REST_COLOR = '#3a3a3a'

// システムプロンプトに足す節（モデルだけが読む）
const PLAN_PROMPT =
  `Your to-do list is the ${PLAN_TOOL} tool (this app has no TodoWrite). The user watches it as a progress bar. ` +
  'For any task that needs 2 or more steps or tool calls, call it first, before other tools, with every step in order and the first one in_progress. ' +
  'Call it again with the full list each time a step finishes or a new one starts. Mark the last step completed before your final answer. ' +
  'A step that launches subagents is one step. Skip it only for a one-line answer with no tool calls.'

// ツール結果に付ける催促文（モデルだけが読む）
const NUDGE_NEW = `Task bar: you have no plan for this task yet. Call ${PLAN_TOOL} now with every step in order, so the user sees your progress.`
const NUDGE_CONT = `Task bar: the plan has not changed this turn. If this is a new task, call ${PLAN_TOOL} with its steps. If it carries on the last one, send the updated list.`
const NUDGE_STALE = `Task bar: the plan has not changed in a while. If a step finished, call ${PLAN_TOOL} with the full list now.`

// 催促の計数（ターン単位で数えるため $.state に置かない）
let turnCalls = 0
let turnPlanned = false
let nudged = false
let sincePlan = 0
let staleNudged = false

// 全完了した計画を隠すタイマー（reload で止まるため、モジュール変数で足りる）
let holdTimer: { cancel: () => void } | null = null

/** n 文字を超える文字列を、末尾を「…」にして n 文字に切る */
const cut = (t: string, n: number) => (n <= 0 ? '' : t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t)
/** 改行と連続する空白を 1 つの空白にまとめる */
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
/** 手順の状態として受け付ける値か */
const isStatus = (v: unknown): v is PlanStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
/** completed の手順の数 */
const doneCount = (steps: PlanStep[]) => steps.filter(st => st.status === 'completed').length
/** 手順が 1 つ以上あり、すべて completed か */
const isAllDone = (steps: PlanStep[]) => steps.length > 0 && steps.every(st => st.status === 'completed')

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
 * 計画を丸ごと置き換える
 * 全完了なら DONE_HOLD_MS 後に表示を消す。題名がなければ、作業途中の前の計画からだけ題名を引き継ぐ。
 */
async function applyPlan($: EngineInterface, title: string | undefined, steps: PlanStep[]) {
  await update($, planAtom, old => ({
    title: title || (old && !isAllDone(old.steps) ? old.title : '') || 'Plan',
    steps,
    shown: steps.length > 0,
  }))
  holdTimer?.cancel()
  holdTimer = null
  if (isAllDone(steps)) {
    holdTimer = $.clock.after(DONE_HOLD_MS, () => {
      holdTimer = null
      void update($, planAtom, p => (p ? { ...p, shown: false } : p)).catch(err => warn($, err))
    })
  }
}

/**
 * plan ツールの入力を検証して計画に反映する
 * text はモデルへ返す 1 行の結果。不正な入力では計画を変えず、saved を false にする。
 */
async function planFromTool($: EngineInterface, args: Record<string, unknown>): Promise<{ saved: boolean; text: string }> {
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
  await applyPlan($, typeof args.title === 'string' ? oneLine(args.title) : undefined, steps)
  return { saved: true, text: `Plan saved: ${doneCount(steps)} of ${steps.length} steps done.` }
}

/** 催促の計数を新しい作業の開始時点に戻す */
function resetNudge() {
  turnCalls = 0
  turnPlanned = false
  nudged = false
  sincePlan = 0
  staleNudged = false
}

/**
 * メインセッションのツール結果に催促文を足す
 * そのターンで計画がないままツールを呼んだときに 1 回、計画が長く更新されないときに 1 回足す。
 */
async function withNudge<R>($: EngineInterface, r: R): Promise<R> {
  turnCalls++
  sincePlan++
  const plan = await read($, planAtom).catch(() => null)
  const live = !!plan && plan.steps.length > 0 && !isAllDone(plan.steps)
  let note: string | null = null
  if (!turnPlanned && !nudged && turnCalls >= NUDGE_AFTER) {
    nudged = true
    note = live ? NUDGE_CONT : NUDGE_NEW
  }
  else if (live && !staleNudged && sincePlan >= STALE_AFTER) {
    staleNudged = true
    note = NUDGE_STALE
  }
  if (!note || !r || typeof r !== 'object' || 'deny' in (r as object)) return r
  const had = (r as { context?: readonly string[] }).context ?? []
  return { ...r, context: [...had, note] }
}

/**
 * mod のフックを登録する
 * plan ツールの登録、システムプロンプトへの指示、催促文、回答終了時の完了の補完、プロンプト上の計画バーの描画を担う。
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
    // reload で保留タイマーが消えるため、全完了の計画はここで隠す。表示の失敗でセッションの開始を止めない
    try {
      const plan = await read($, planAtom)
      if (plan?.shown && isAllDone(plan.steps)) await update($, planAtom, p => (p ? { ...p, shown: false } : p))
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
  // 全完了の計画は、20 秒の保留を待たずにここで隠す。モデルが新しい計画を送るまで前回の表示が残って見えるため（利用者の判断）。
  // 作業途中の計画は、続きの指示かもしれないので残す。表示の失敗で送信を止めない
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      resetNudge()
      try {
        const plan = await read($, planAtom)
        if (plan?.shown && isAllDone(plan.steps)) {
          holdTimer?.cancel()
          holdTimer = null
          await update($, planAtom, p => (p ? { ...p, shown: false } : p))
        }
      }
      catch (err) {
        warn($, err)
      }
    }
    return next(e)
  })

  // メインのターンが回答で終わったとき、未完了の計画は全完了として扱う（中断、拒否、エラーで終わったターンとサブエージェントは除く）
  // モデルが最終回答の前に最後の手順を completed にし忘れると、バーが途中のまま残るため（利用者の判断）。
  // 質問のために途中で止まった場合も 100% になるが、次のターンでモデルが計画を送り直せば、新しい計画に置き換わる
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer') return r
    try {
      const plan = await read($, planAtom)
      if (plan?.shown && !isAllDone(plan.steps)) {
        await applyPlan($, plan.title, plan.steps.map(st => ({ ...st, status: 'completed' as const })))
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
      let said = { saved: false, text: 'Plan not saved: something went wrong. Carry on.' }
      try {
        said = await planFromTool($, e as unknown as Record<string, unknown>)
      }
      catch (err) {
        warn($, err)
      }
      // 保存できなかった呼び出しでは、催促を止めない
      if (said.saved) {
        turnPlanned = true
        sincePlan = 0
        staleNudged = false
      }
      return { result: said.text } as never
    }
    // 催促はメインセッションのツール結果にだけ付ける
    if (id) return next(e)
    return withNudge($, await next(e))
  })

  // プロンプト上に計画バーを描く（ターミナルだけ）
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const plan = await read($, planAtom)
    if (!plan || !plan.shown || !plan.steps.length) return next(e)
    // 他の mod のバンドは上に残す。エンジン自身の表示は入れ子にしない
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const rest = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null
    const { Box, Text } = $.ui.resolve(e)
    const w = e.props.bodyColumns > 0 ? Math.floor(e.props.bodyColumns) : BAR_FALLBACK

    // 1 行目：完了の区間、残り、件数、百分率（実行中の手順は 2 行目で示し、バーでは区別しない）
    // 2 行目：「題名：いまの手順」（実行中がなければ次の手順か All steps done。全角の幅も画面側の truncate-end が数えて切る）
    const n = plan.steps.length
    const done = doneCount(plan.steps)
    const pct = `${Math.round((done / n) * 100)}%`
    const label = `Tasks ${done}/${n}`
    const now = plan.steps.find(st => st.status === 'in_progress')
    const nextUp = plan.steps.find(st => st.status === 'pending')
    const line = now ? now.text : done === n ? 'All steps done' : nextUp ? `Next: ${nextUp.text}` : ''
    // バーは件数と百分率と、その間の空白 2 つを除いた残りの幅いっぱいに描く
    const barW = Math.max(6, w - label.length - pct.length - 2)
    const fillC = Math.round((barW * done) / n)

    return (
      <Box flexDirection="column">
        {rest as never}
        <Box key="task-bar" flexDirection="column">
          <Box key="plan-row" flexDirection="row" gap={1} width={w}>
            <Text>
              <Text color={BAR_COLOR}>{'━'.repeat(fillC)}</Text>
              <Text color={REST_COLOR}>{'·'.repeat(Math.max(0, barW - fillC))}</Text>
            </Text>
            <Text bold color={BAR_COLOR}>
              {label}
            </Text>
            <Text dimColor>{pct}</Text>
          </Box>
          <Box key="plan-line" width={w}>
            <Text wrap="truncate-end">
              <Text bold>{plan.title}</Text>
              {line ? <Text dimColor>{`：${line}`}</Text> : null}
            </Text>
          </Box>
        </Box>
      </Box>
    )
  })
}
