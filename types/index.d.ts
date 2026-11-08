export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export type PlanStep = { text: string; status: PlanStatus }

/** メインセッションの計画（shown は、全完了後 20 秒経つか手順が空になると false） */
export type Plan = { title: string; steps: PlanStep[]; shown: boolean }

declare module 'claude-code' {
  interface PluginState {
    'task-bar': {
      plan: Plan | null
    }
  }
}
