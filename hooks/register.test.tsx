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

// エンジン役が $.agent.list() に返す一覧（engine() のたびに空へ戻し、テストが書き換える）
let agentRows: { id: string; status: string; description: string; type: string }[] = []

/** プラグインの下に置くエンジン役のフックと、動かせる時計を用意する */
function engine(on: On) {
  agentRows = []
  on('agent.list', () => ({ value: agentRows }) as never)
  on('tool.register', (_, e) => ({ value: { tool: `mcp__task-bar__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // command が fail の呼び出しだけエラーで終え、bg の Bash はバックグラウンドへ回したものとして ID を返す。TaskStop は止めた ID を返す
  on('tool.call', (_, e) => {
    const o = e as { tool: string; command?: string; task_id?: string }
    if (o.command === 'fail') return { result: 'boom', isError: true } as never
    if (o.tool === 'Bash' && o.command === 'bg') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } } as never
    if (o.tool === 'TaskStop') return { result: { message: 'stopped', task_id: o.task_id, task_type: 'local_bash' } } as never
    return { result: {} } as never
  })
  // 起動したサブエージェントの ID は、入力の name（無ければ a1）とする
  on('agent.spawn', (_, e) => ({ model: 'm', agentId: (e as { name?: string }).name ?? 'a1' }))
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

  // 幅 57 セルのバーで、1 件目の区間（20%）の半分まで 30 秒で伸びる（5.7 セルを切り捨てて 5）
  await clock.advance(30_000)
  await expectFill(5)
  // 同じ状態の送り直しでは位置を変えない
  await $.tool.call({ tool: PLAN_TOOL, steps: first } as never)
  await expectFill(5)

  // 1 件目が完了すると、その時点の位置から動き出し、0.5 秒で次の位置との中間まで進む（幅は 56 セル）
  const second = steps.map((st, i) => ({ ...st, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' }))
  await $.tool.call({ tool: PLAN_TOOL, steps: second } as never)
  await expectFill(5)
  await clock.advance(500)
  await expectFill(8)

  // 1 件だけの計画を長く実行しても、区間の終端（全幅 57 セル）までは埋めず、先端の矢印を残す
  await $.tool.call({ tool: PLAN_TOOL, steps: [{ text: 'only', status: 'in_progress' }] } as never)
  await clock.advance(600_000)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '━'.repeat(56) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '━'.repeat(57) })).toBeUndefined()
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
  await expectFill(9)
})

test('T18 止めたバーより手前から始まる計画が届くと、バーをその位置へ戻して伸ばす', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 2 件完了、3 件目を実行中のまま中断で止める
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await clock.advance(30_000)
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)

  // 1 件目から始め直した計画は、1 秒で 1 件目の区間へ戻り、そこから伸びる（幅 57 セル）
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

/** メインの会話からサブエージェントを起動する（extra で入れ子や teammate の印を足す） */
const spawn = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.agent.spawn({
    prompt: 'p', description: 'scan', subagentType: 'Explore', background: true, fork: false, parentModel: 'm',
    tool_use_id: 't', provider: { plugin: 'engine', tier: 'core' }, ...extra,
  } as never)

/** 終了通知の行を、エンジンが解析した task 付きで描かせる */
async function notify($: Engine, id: string, status: string) {
  const ui = await $.ui.mount({
    plugin: 'task-bar', component: 'UserMessage', surface: 'terminal',
    props: { text: 'n', origin: { kind: 'task-notification' }, isExpanded: false, task: { id, status } },
  } as never)
  await ui.unmount()
}

/** バンドに text の Text があるか（absent なら無いこと）を確かめる */
async function expectBand($: Engine, texts: string[], absent: string[] = []) {
  const ui = await $.ui.mount(BAND)
  for (const text of texts) expect(await ui.find({ type: 'Text', text })).toBeDefined()
  for (const text of absent) expect(await ui.find({ type: 'Text', text })).toBeUndefined()
  await ui.unmount()
}

/** サブエージェントのターンの終了 */
const agentEnd = (agentId: string) => ({ answer: 'done', durationMs: 1, turnId: 't2', isAborted: false, reason: 'answer', agentId }) as never

test('T20 サブエージェントは 1 件として数え、終わるまで回答の終了でも 100% にしない', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: 'answer' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await spawn($)
  await expectBand($, ['Tasks 2/6'])

  await $.turn.complete({ answer: 'done', durationMs: 1, turnId: 't1', isAborted: false, reason: 'answer' } as never)
  await expectBand($, ['Tasks 5/6', ' · 1 running in background'], ['100%', 'All steps done'])

  await $.turn.complete(agentEnd('a1'))
  await expectBand($, ['Tasks 6/6', '100%', 'All steps done'], [' · 1 running in background'])
})

test('T21 バックグラウンドのシェルコマンドは終了通知で完了し、全完了の 20 秒後に消える', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await $.tool.call({ tool: 'Bash', command: 'bg' })
  await expectBand($, ['Tasks 5/6', ' · 1 running in background'])

  await notify($, 'b1', 'running')
  await expectBand($, ['Tasks 5/6'])
  await notify($, 'b1', 'completed')
  await expectBand($, ['Tasks 6/6', '100%'])
  // 同じ通知の行が描き直されても変わらない
  await notify($, 'b1', 'completed')
  await expectBand($, ['Tasks 6/6'])

  await clock.advance(20_000)
  await expectNothingDrawn($)
})

test('T21b TaskStop で止めた作業は通知なしで完了にする', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await $.tool.call({ tool: 'Bash', command: 'bg' })
  await expectBand($, ['Tasks 2/6'])
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1' } as never)
  await expectBand($, ['Tasks 3/6'], [' · 1 running in background'])
})

test('T22 入れ子、teammate、Workflow 内部の agent と、サブエージェントの Bash は数えない', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await spawn($, { parentAgentId: 'x', name: 'n1' })
  await spawn($, { isTeammate: true, name: 'n2' })
  await spawn($, { workflow: { runId: 'wf_1', agentIndex: 1 }, name: 'n3' })
  await $.tool.call({ tool: 'Bash', command: 'bg', agentId: 'id-A' })
  await expectBand($, ['Tasks 2/5'])
})

test('T23 プロンプト送信で、完了済みの作業単位を捨て、未完了のものは残す', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await spawn($, { name: 'a1' })
  await spawn($, { name: 'a2' })
  await $.turn.complete(agentEnd('a1'))
  await expectBand($, ['Tasks 3/7'])
  await $.prompt.submit(submitOf('more'))
  await expectBand($, ['Tasks 2/6', ' · 1 running in background'])
})

test('T24 計画がなくても、作業単位だけで Background のバーを出す', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await spawn($)
  await expectBand($, ['Background', 'Tasks 0/1', ' · 1 running in background'])
  // 後から届いた題名なしの計画は Background を引き継がない
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await expectBand($, ['Plan', 'Tasks 2/6'])
})

test('T25 TaskStop で止めたサブエージェントも完了にする', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await spawn($)
  await $.tool.call({ tool: 'TaskStop', task_id: 'a1' } as never)
  await expectBand($, ['Tasks 3/6'])
})

test('T26 中断で止めた計画は、作業単位の出入りでは止めたまま件数だけ変え、全完了で 100% にする', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await spawn($)
  await clock.advance(30_000)
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)
  const ui = await $.ui.mount(BAND)
  const bar = (await ui.find({ type: 'Text', text: /^━+$/ }))
  await ui.unmount()

  // 作業単位の追加と完了の後も、バーの位置と経過時間は止めたまま
  await clock.advance(60_000)
  await $.tool.call({ tool: 'Bash', command: 'bg' })
  await $.turn.complete(agentEnd('a1'))
  await clock.advance(60_000)
  await expectBand($, ['Tasks 3/7', '0:00:30'])
  const after = await $.ui.mount(BAND)
  expect(await after.find({ type: 'Text', text: /^━+$/ })).toEqual(bar)
  await after.unmount()

  // モデルが全完了の計画を送ると止めた状態が外れ、残りの作業単位が終われば 100% になる
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await notify($, 'b1', 'completed')
  await clock.advance(1_000)
  await expectBand($, ['Tasks 7/7', '100%'])
})

test('T27 起動の記録より先に終わったサブエージェントは、エージェント一覧と突き合わせて完了にする', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await $.turn.complete(agentEnd('a9'))
  agentRows = [{ id: 'a9', status: 'completed', description: 'scan', type: 'Explore' }]
  await spawn($, { name: 'a9' })
  await expectBand($, ['Tasks 3/6'], [' · 1 running in background'])
  // 一覧で実行中のものは未完了のまま加える
  agentRows = [{ id: 'a8', status: 'running', description: 'scan', type: 'Explore' }]
  await spawn($, { name: 'a8' })
  await expectBand($, ['Tasks 3/7', ' · 1 running in background'])
})

test('T28 再開したサブエージェントは、前の実行の終了通知の行が描き直されても完了にしない', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await spawn($)
  await $.turn.complete(agentEnd('a1'))
  await spawn($, { resume: { agentId: 'a1' } })
  await notify($, 'a1', 'completed')
  await expectBand($, ['Tasks 2/6', ' · 1 running in background'])
  // 再開した実行の終了は turn.complete で拾う
  await $.turn.complete(agentEnd('a1'))
  await expectBand($, ['Tasks 3/6'], [' · 1 running in background'])
})

test('T29 エラーで終わった TaskStop では、作業単位を完了にしない', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  await $.tool.call({ tool: 'Bash', command: 'bg' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'b1', command: 'fail' } as never)
  await expectBand($, ['Tasks 2/6', ' · 1 running in background'])
})

test('T30 残りの区間は、件数の区切りのセルを琥珀色の太字の大きい点で描く', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 5 件すべて未着手なら、幅 57 セルのバーの 11, 22, 34, 45 セル目が区切り（0 セル目は先端の矢印）
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'pending' })) } as never)
  type Drawn = { props?: { color?: string }; text?: string; children?: (Drawn | string)[] }
  const ui = await $.ui.mount(BAND)
  // バーの行は 1 つの Text にまとまり、その子が色ごとの連なりになる（find の text は部分一致で、バーの行全体が見つかる）
  const bar = (await ui.find({ type: 'Text', text: '•' })) as Drawn | undefined
  await ui.unmount()
  const dots = (k: number) => '·'.repeat(k)
  expect(bar?.text).toBe(`▶${dots(10)}•${dots(10)}•${dots(11)}•${dots(10)}•${dots(11)}`)
  const runs = (bar?.children ?? []).filter((c): c is Drawn => typeof c === 'object')
  const marks = runs.filter(c => c.children?.[0] === '•')
  expect(marks.length).toBe(4)
  expect(marks.every(c => c.props?.color === '#e5a54b' && c.props?.bold === true)).toBe(true)
  expect(runs.filter(c => c.children?.[0] === dots(11)).every(c => c.props?.color === '#3a3a3a')).toBe(true)
})

test('T31 左端のスピナーは未完了の間だけ回り、中断で止まり、全完了で ✓ になる', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  // 125 ミリ秒ごとに 1 コマ進み、10 コマで一巡する
  await expectBand($, ['⠋'])
  await clock.advance(125)
  await expectBand($, ['⠙'], ['⠋'])
  await clock.advance(125 * 9)
  await expectBand($, ['⠋'])

  // 中断で止めた間は、止めた時点のコマのまま動かない
  await clock.advance(250)
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)
  await clock.advance(60_000 + 125)
  await expectBand($, ['⠹'])

  // 全完了では ✓ に替わる
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await expectBand($, ['✓'], ['⠹'])
})

type Drawn = { props?: { color?: string }; text?: string; children?: (Drawn | string)[] }

/** バーの完了区間と矢印のセルを、左から 1 セルずつ色と組にして返す */
async function barCells($: Engine) {
  const ui = await $.ui.mount(BAND)
  // 「━」と矢印が並ぶのはバーの行全体の Text だけ（色ごとの子は、矢印を「━」の連なりと分けて持つ）
  const bar = (await ui.find({ type: 'Text', text: /━▶/ })) as Drawn | undefined
  await ui.unmount()
  const out: { ch: string; color?: string }[] = []
  for (const c of bar?.children ?? []) {
    const t = typeof c === 'object' ? c.children?.[0] : undefined
    if (typeof c !== 'object' || typeof t !== 'string' || !/^[━▶]+$/.test(t)) continue
    for (const ch of [...t]) out.push({ ch, color: c.props?.color })
  }
  return out
}

/** 最も明るい色のセルの位置（無ければ -1） */
const brightest = (cs: { color?: string }[]) => cs.findIndex(c => c.color === '#e4ecfa')

/** 長さ len のバーで、光の帯が 1 コマに進むセル数（1.6 にバーの長さ 1 セルあたり 0.02 を足す） */
const shineStep = (len: number) => 1.6 + len * 0.02

test('T32 実行中は進んだ部分の全体に光の帯を流し、バーが伸びても帯を飛ばさず、中断では流さない', async ($, on) => {
  const clock = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  const cells = () => barCells($)

  // 帯は 1 コマ（125 ミリ秒）に shineStep のセル数ずつ右へ進む。バーが伸びても位置は飛ばず、矢印の先へ抜けたときだけ左端から出直す
  // 計画の開始直後から 120 コマを見る。最初の 1 秒でバーが完了数の位置まで大きく伸びるので、その間も帯が飛ばないことを確かめる
  // 帯が見えないコマ（バーの両端の外にいる間）も数え、見え直したときに次のどちらかであることを確かめる
  //   前進：最後に見えた位置より右で、見えなかったコマの分を含めて shineStep の範囲に収まる
  //   出直し：最後に見えた位置が矢印の近くで、見え直した位置が左端の近く（バーの途中から左端へ戻るのは飛び）
  let last = -1
  let gap = 0
  let sweeps = 0
  let reachedDone = false
  for (let k = 0; k < 120; k++) {
    const cs = await cells()
    const at = brightest(cs)
    if (at < 0) {
      gap++
    }
    else {
      if (last >= 0) {
        const restarted = at <= 2 && last >= cs.length - 4
        const forward = at - last >= 1 && at - last <= Math.ceil(shineStep(cs.length) * (gap + 1)) + 1
        expect(restarted || forward).toBe(true)
        if (restarted) sweeps++
      }
      // 2 往復目からは、バーが完了数の位置（セル 22）より長いので、完了済みの区間を光が通ることを確かめられる
      // 出直した直後に光る左端（セル 0〜2）は数えず、完了済みの区間の途中（セル 3〜21）を光が通ったときだけ数える
      if (sweeps > 0 && at >= 3 && at < 22) reachedDone = true
      last = at
      gap = 0
    }
    await clock.advance(125)
  }
  expect(sweeps).toBeGreaterThanOrEqual(2)
  expect(reachedDone).toBe(true)

  // 中断で止めた計画では、帯を流さず全体を青で描く
  await $.turn.complete({ answer: '', durationMs: 1, turnId: 't1', isAborted: true, reason: 'aborted' } as never)
  expect((await cells()).every(c => c.color === '#6b8fc6')).toBe(true)

  // 実行中の手順がない計画では、9 コマ続けて見ても、先端の矢印を含めて常に青で描く
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: st.status === 'in_progress' ? 'pending' : st.status })) } as never)
  for (let k = 0; k < 9; k++) {
    expect((await cells()).every(c => c.color === '#6b8fc6')).toBe(true)
    await clock.advance(125)
  }

  // 計画が消えた後の新しい計画では、経過時間が 0 から数え直すので、帯は左端から出直す
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map(st => ({ ...st, status: 'completed' })) } as never)
  await clock.advance(20_000)
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  let first = -1
  for (let k = 0; k < 12 && first < 0; k++) {
    await clock.advance(125)
    first = brightest(await cells())
  }
  expect(first).toBeGreaterThanOrEqual(0)
  expect(first).toBeLessThanOrEqual(2)
})

test('T33 光の帯は、バーが長いほど速く流れる', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 5 件中 4 件が完了した計画で、バーは 57 セル中の約 46 セルまで進む
  await $.tool.call({ tool: PLAN_TOOL, steps: steps.map((st, i) => ({ ...st, status: i < 4 ? 'completed' : 'in_progress' })) } as never)
  await clock.advance(2_000)
  // 帯が左端から出直したコマを 3 回まで記録し、2 回目から 3 回目までを 1 往復のコマ数とする
  const restarts: number[] = []
  let last = -1
  let len = 0
  for (let k = 0; k < 200 && restarts.length < 3; k++) {
    const cs = await barCells($)
    const at = brightest(cs)
    len = cs.length
    if (at >= 0) {
      if (last >= 0 && at < last) restarts.push(k)
      last = at
    }
    await clock.advance(125)
  }
  expect(restarts.length).toBe(3)
  const period = (restarts[2] ?? 0) - (restarts[1] ?? 0)
  // 1 コマ 1.6 セルの一定の速さなら、両端の外の 8 セルを含めて (len + 8) / 1.6 コマかかる。長いバーではそれより明らかに短い
  expect(period).toBeLessThan((len + 8) / 1.6 - 4)
  expect(period).toBeGreaterThanOrEqual(Math.floor((len + 8) / shineStep(len)) - 1)
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
