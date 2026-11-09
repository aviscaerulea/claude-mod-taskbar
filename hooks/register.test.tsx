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
  on('tool.call', () => ({ result: {} }))
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

test('T7 未完了の計画が 8 回更新されないと、1 回だけ更新を促す', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(submitOf('go'))
  await $.tool.call({ tool: PLAN_TOOL, steps } as never)
  const notes: string[] = []
  for (let i = 0; i < 9; i++) {
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
    notes.push((r.context ?? []).join('\n'))
  }
  expect(notes.slice(0, 7).every(n => n === '')).toBe(true)
  expect(notes[7]).toMatch(/has not changed in a while/)
  expect(notes[8]).toBe('')
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
