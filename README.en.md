# task-bar
[![日本語](https://img.shields.io/badge/lang-日本語-red)](README.md)
[![English](https://img.shields.io/badge/lang-English-blue)](README.en.md)
[![License](https://img.shields.io/github/license/aviscaerulea/claude-mod-taskbar)](LICENSE)

A Claude Code mod that shows the steps of Claude's work and their progress as a thin bar right above the prompt in the terminal.
Even with a model that has no TodoWrite, you can see at a glance what is being worked on and how far it has come.

```
認証機能の実装：テストを書く
⠹ ━━━━━━━━━━━━━━━━━━━━━━━━━━▶··········•············•············ Tasks   2/5  41% 0:03:12
```

## Features

- Progress bar: When Claude updates its step list, shows the progress as a bar, the finished steps as a count, and how full the bar is as a percentage.
- Smooth motion: Extends the running step's part of the bar little by little over time, up to three quarters of that step's share, and moves on to the next position in about a second when the step is done.
- Moving shine: While work is running, sweeps a light from left to right across the whole filled part of the bar, a little faster on a longer bar, and drops it when the work is interrupted.
- Spinner: Spins at the left end of the bar until Claude finishes its work, stops when the work is interrupted, and turns into `✓` when Claude is done.
- Elapsed time: Shows the time since the plan started at the right end of the bar, and stops it when every step is done or the work is interrupted.
- Current step: Shows the job's title and the step in progress above the bar.
- Plan nudge: When Claude starts working without a step list, asks Claude to make one.
- Update nudge: When Claude uses tools 5 times with no new step finished, asks it once to update the step list.
- Background work: Keeps the bar below 100% until every subagent and background shell command finishes.
  - Counts each one Claude starts as one item.
- Completion fill-in: When Claude ends its answer without marking the last steps done, treats the remaining steps as done.
- Finishing up: Even when every step is done, holds the bar at 99% and shows `Finishing up` until Claude finishes writing its answer.
- Automatic cleanup: When every step is done and Claude has finished its answer, hides the bar after 20 seconds or as soon as you send the next prompt.

## Installation

### Requirements

- A version of Claude Code that supports mods (hooks-module plugins); tested on `v2.1.319`
- Claude Code in the terminal

### Steps

Run the following at the Claude Code prompt.

```
/plugin install task-bar --marketplace aviscaerulea/claude-mod-taskbar
```

Answer `y` when asked to add the marketplace.
Then choose user as the install scope.

To install from a shell, run:

```
claude plugin install task-bar --marketplace aviscaerulea/claude-mod-taskbar
```

## Usage

Nothing to do after installing.
When you ask for a job with two or more steps, Claude makes a step list, the bar appears, and it moves forward each time a step finishes.

## Limitations

- The bar is shown only in the terminal, not in the desktop app or IDE extensions
- The bar changes only when Claude updates its step list, so a new bar may take a moment to appear after you send a prompt
- When Claude ends its answer midway to ask you a question, the bar still goes to 100%
- Only the main chat keeps a step list; a subagent counts as one item, without its own steps
- Workflow and Monitor runs are not counted
- Where another plugin composes the system prompt first, the instruction to make a step list does not reach Claude
  - In that case only the nudges during work ask Claude to make a step list
- Collapsing with `[-]` at the right end of the bar hides the bar until you open it again
