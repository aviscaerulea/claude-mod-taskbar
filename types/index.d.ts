export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = { text: string; status: PlanStatus }

/**
 * バーの件数に加える、メインの会話が起こした作業単位（サブエージェント 1 体か、バックグラウンドのシェルコマンド 1 本）
 * id はサブエージェントなら agentId、シェルコマンドなら Bash の結果の backgroundTaskId で、どちらも終了通知の task の id と一致する。
 */
export type Job = { id: string; kind: 'agent' | 'shell'; label: string; done: boolean }

/**
 * メインセッションの計画（shown は、全完了後 20 秒経つか手順も作業単位も空になると false）
 * jobs は手順とは別に件数へ加える作業単位で、reload 前の版が書いた値には無いので、読む側は空として扱う。
 * from と at はバーの動きの起点で、完了数か実行中の手順が変わった時刻 at に、バーが描いていた割合 from（0〜1）を持つ。
 * reload 前の版が書いた値には無いので、読む側は無いものとして扱う。
 * paused は、ターンが中断やエラーで終わってバーを from の位置で止めたことを示す（次に計画が届けば外れる）。
 * 経過時間は spent（止めるまでに数えたミリ秒）と startedAt（数えている区間の開始時刻。止めている間は無い）から求める。
 */
export type Plan = {
  title: string
  steps: PlanStep[]
  shown: boolean
  from?: number
  at?: number
  paused?: boolean
  spent?: number
  startedAt?: number
  jobs?: Job[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-bar': {
      plan: Plan | null
    }
  }
}
