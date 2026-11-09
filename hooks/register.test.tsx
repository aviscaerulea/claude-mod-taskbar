import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// テスト対象の計画ツールの完全名
const PLAN_TOOL = 'mcp__task-bar__plan'

// プロンプト上のバンドを、ターミナルで 80 セル幅として描かせる
const BAND = {
  plugin: 'task-bar',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

/** プラグインの下に置くエンジン役のフックと、動かせる時計を用意する */
function engine(on: On) {
  on('tool.register', (_, e) => ({ value: { tool: `mcp__task-bar__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // command が fail の呼び出しだけエラーで終える
  on('tool.call', (_, e) => ((e as { command?: string }).command === 'fail' ? { result: 'boom', isError: true } : { result: {} }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return mock.clock(on, { now: 1_000 })
}

/** 利用者が Enter で送ったプロンプトの入力 */
const submitOf = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

// 5 手順のうち 2 つが完了、1 つが実行中の計画
const steps = [
  { text: 'one', status: 'completed' },
  { text: 'two', status: 'completed' },
  { text: 'three', status: 'in_progress' },
  { text: 'four', status: 'pending' },
  { text: 'five', status: 'pending' },
]

/** ツール呼び出しの結果から、モデルへ返した本文を取り出す */
const textOf = (r: unknown) => (r as { result?: unknown }).result

/** 計画がなく、バンドがエンジンの描画だけになることを確かめる */
async function expectNothingDrawn($: Engine) {
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await ui.find({ text: /Tasks/ })).toBeUndefined()
  await ui.unmount()
}

test('T1 計画の行に比率、件数、実行中の手順が出る', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: PLAN_TOOL, title: 'Job', steps } as never)
  expect(textOf(r)).toBe('Plan saved: 2 of 5 steps done.')

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Tasks 2/5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '：three' })).toBeDefined()
  await ui.unmount()
})

test('T2 全完了で All steps done を出し、20 秒後に消える', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'All steps done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '100%' })).toBeDefined()
  await ui.unmount()

  await clock.advance(20_000)
  await expectNothingDrawn($)
})

test('T3 不正な入力では計画を変えない', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const bad = [{}, { steps: [{ text: '', status: 'pending' }] }, { steps: [{ text: 'x', status: 'done' }] }]
  for (const args of bad) {
    const r = await $.tool.call({ tool: PLAN_TOOL, ...args } as never)
    expect(String(textOf(r))).toMatch(/^Plan not saved:/)
  }
  await expectNothingDrawn($)
})

test('T4 サブエージェントの plan 呼び出しは断る', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: PLAN_TOOL, steps, agentId: 'id-A' } as never)
  expect(String(textOf(r))).toMatch(/^Only the main chat keeps a plan\./)
  await expectNothingDrawn($)
})

test('T5 指示の節を足す（teammate には足さない）', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const compose = { model: 'm', promptModel: 'm', surfaces: ['terminal' as const], tools: [], outputStyle: null }
  const plain = await $.prompt.compose({ ...compose, traits: [] })
  expect(plain.sections.map(s => s.id)).toEqual(['task-bar:plan'])
  const mate = await $.prompt.compose({ ...compose, traits: ['teammate'] })
  expect(mate.sections).toEqual([])
})

test('T6 計画がなければ、ターンの最初の呼び出しに 1 回だけ作成を促す', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.context?.join('\n')).toMatch(/you have no plan/)
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(second.context ?? []).toEqual([])
  // サブエージェントのツール結果には付けない
  await $.prompt.submit(submitOf('again'))
  const sub = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'id-A' })
  expect(sub.context ?? []).toEqual([])
})

/** Bash を n 回呼び、各結果の催促文を返す */
async function bashNotes($: Engine, n: number, command = 'ls') {
  const notes: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await $.tool.call({ tool: 'Bash', command })
    notes.push((r.context ?? []).join('\n'))
  }
  return notes
}

test('T7 完了数が変わらないまま正常なツールを 5 回呼ぶと、1 回だけ更新を促す', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  const notes = await bashNotes($, 6)
  expect(notes.slice(0, 4).every(n => n === '')).toBe(true)
  expect(notes[4]).toMatch(/no step has been marked completed/)
  expect(notes[5]).toBe('')
})

test('T7b 同じ完了数の送り直しでは計数を戻さず、完了数が増えたら戻す', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await bashNotes($, 3)
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  const same = await bashNotes($, 2)
  expect(same[1]).toMatch(/no step has been marked completed/)
  const advanced = steps.map((st, i) => (i === 2 ? { ...st, status: 'completed' } : i === 3 ? { ...st, status: 'in_progress' } : st))
  await $.tool.call({ tool: PLAN_TOOL, steps: advanced } as never)
  const after = await bashNotes($, 5)
  expect(after.slice(0, 4).every(n => n === '')).toBe(true)
  expect(after[4]).toMatch(/no step has been marked completed/)
})

test('T7c エラーで終わったツールは停滞の計数に入れない', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  const failed = await bashNotes($, 6, 'fail')
  expect(failed.every(n => n === '')).toBe(true)
  const ok = await bashNotes($, 5)
  expect(ok[4]).toMatch(/no step has been marked completed/)
})

test('T8 保存できなかった plan 呼び出しでは、作成の催促を止めない', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  await $.tool.call({ tool: PLAN_TOOL } as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.context?.join('\n')).toMatch(/you have no plan/)
})

test('T11 通知から入ったプロンプトでは、催促の計数を戻さない', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } } as never)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.context ?? []).toEqual([])
})

test('T12 /clear で前の会話の計画を消す', async ($, on) => {
  engine(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await expectNothingDrawn($)
})

test('T13 題名は作業途中の計画からだけ引き継ぐ', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, title: 'Old', steps } as never)
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Old' })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Old' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Plan' })).toBeDefined()
  await ui.unmount()
})

test('T14 プロンプト送信で、全完了の計画は消え、作業途中の計画は残る', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await $.prompt.submit(submitOf('more'))
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Tasks 2/5' })).toBeDefined()
  await ui.unmount()

  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await $.prompt.submit(submitOf('next'))
  await expectNothingDrawn($)
})

test('T15 メインのターンが回答で終わると、未完了の計画を全完了にする', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'answer' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)

  // サブエージェントの終了と、中断で終わったターンでは変えない
  const end = { answer: 'done', durationMs: 1, turnId: 't1', isAborted: false }
  await $.turn.complete({ ...end, reason: 'answer', agentId: 'id-A' } as never)
  await $.turn.complete({ ...end, reason: 'aborted', isAborted: true } as never)
  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Tasks 2/5' })).toBeDefined()
  await ui.unmount()

  await $.turn.complete({ ...end, reason: 'answer' } as never)
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Tasks 5/5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'All steps done' })).toBeDefined()
  await ui.unmount()
})

test('T16 バーは実行中の区間を時間で伸ばし、完了で次の位置へ 1 秒かけて動く', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const first = steps.map((st, i) => ({ ...st, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: PLAN_TOOL, steps: first } as never)
  /** 完了区間の太線がちょうど cells セルあることを確かめる */
  const expectFill = async (cells: number) => {
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: '━'.repeat(cells) })).toBeDefined()
    await ui.unmount()
  }

  // 幅 59 セルのバーで、1 件目の区間（20%）の半分まで 30 秒で伸びる（5.9 セルを切り捨てて 5）
  await clock.advance(30_000)
  await expectFill(5)
  // 同じ状態の送り直しでは位置を変えない
  await $.tool.call({ tool: PLAN_TOOL, steps: first } as never)
  await expectFill(5)

  // 1 件目が完了すると、その時点の位置から動き出し、0.5 秒で次の位置との中間まで進む（幅は 58 セル）
  const second = steps.map((st, i) => ({ ...st, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: PLAN_TOOL, steps: second } as never)
  await expectFill(5)
  await clock.advance(500)
  await expectFill(8)

  // 1 件だけの計画を長く実行しても、区間の終端（全幅 59 セル）までは埋めず、先端の矢印を残す
  await $.tool.call({ tool: PLAN_TOOL, steps: [{ text: 'only', status: 'in_progress' }] } as never)
  await clock.advance(600_000)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '━'.repeat(58) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▶' })).toBeDefined()
  await ui.unmount()
})

test('T17 ターンが中断で終わると、バーをその位置で止め、次の計画から動かし直す', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const first = steps.map((st, i) => ({ ...st, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: PLAN_TOOL, steps: first } as never)
  /** 完了区間の太線がちょうど cells セルあることを確かめる */
  const expectFill = async (cells: number) => {
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: '━'.repeat(cells) })).toBeDefined()
    await ui.unmount()
  }
  await clock.advance(30_000)
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)
  await clock.advance(60_000)
  await expectFill(5)

  // 同じ状態の計画が届くと、止めた位置から伸び直す（巻き戻さない）
  await $.tool.call({ tool: PLAN_TOOL, steps: first } as never)
  await expectFill(5)
  await clock.advance(60_000)
  await expectFill(10)
})

test('T18 止めたバーより手前から始まる計画が届くと、バーをその位置へ戻して伸ばす', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 2 件完了、3 件目を実行中のまま中断で止める
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await clock.advance(30_000)
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)

  // 1 件目から始め直した計画は、1 秒で 1 件目の区間へ戻り、そこから伸びる（幅 59 セル）
  const first = steps.map((st, i) => ({ ...st, status: i === 0 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: PLAN_TOOL, steps: first } as never)
  await clock.advance(30_000)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '━'.repeat(5) })).toBeDefined()
  await ui.unmount()
})

test('T19 経過時間は計画の開始から数え、中断と全完了で止まり、100% では矢印を消す', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  /** 右端の経過時間が text であることを確かめる */
  const expectTime = async (text: string) => {
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
    await ui.unmount()
  }
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await expectTime('0:00:00')
  await clock.advance(65_000)
  await expectTime('0:01:05')

  // 中断の間は数えず、次の計画から続きを数える
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)
  await clock.advance(60_000)
  await expectTime('0:01:05')
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await clock.advance(10_000)
  await expectTime('0:01:15')

  // 全完了で止まり、矢印も消える
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await clock.advance(5_000)
  await expectTime('0:01:15')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '▶' })).toBeUndefined()
  await ui.unmount()
})

test('T9 計画がなければエンジンに任せる', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await expectNothingDrawn($)
})

test('T10 reload 前に保存した計画を描く', async ($, on) => {
  engine(on)
  // reload 前のモジュールが書いた値を、state.get の答えとして置く
  const kept = { title: 'Kept', steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }], shown: true }
  on('state.get', () => ({ value: { value: kept, version: 1 } }))
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'Tasks 1/2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '：b' })).toBeDefined()
  await ui.unmount()
})
