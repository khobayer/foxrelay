# Changelog

Check your version with `relay --version`.

## 2.2.3 (1 Oct 2026)

- Usage limit: the relay now checks every `limitPollMinutes` (default 10) instead of sleeping until the reset time. If usage comes back early (extra usage, a plan change, another account), the run continues within minutes.
- Fix: the work clock counted at most 5 minutes per round, so a 40-minute round showed as 5 minutes and `--hours` limits fired far too late. It now counts the full time and still leaves out laptop sleep.
- Faster rounds: the engineer runs only the tests for what it changed while working, and the full suite and build once before its last commit, unless the project rules say otherwise.
- New look: colored output (section headers, Opus and Sonnet lines, warnings in yellow, success in green) and a footer pinned to the bottom of the terminal that always shows the progress bar, percentage, current milestone, round, work time and what is happening right now. The footer hides while you type an answer. `RELAY_PLAIN=1` or `NO_COLOR=1` turns colors off. The log file stays plain text.

## 2.2.2 (30 Sep 2026)

- Fix: a run that hit its round or time limit was reported as "Goal finished (planner verified)", because the planner is told to answer DONE on the last round. It now says "Stopped at the round limit" with the number of milestones left, in the terminal, in `relay status` and in SUMMARY.md.
- Fix: `relay resume --rounds N` now continues such a run, including runs saved by 2.2.1 and older.
- `relay resume --rounds N --message-file answers.md` answers the open questions and raises the limit in one step. Resuming a limit-stopped run without a higher limit tells you the exact command instead of doing nothing.
- Hints in the terminal and SUMMARY.md now use the short `relay resume` and `relay --rollback` commands.

## 2.2.1 (30 Sep 2026)

- New name: **FoxRelay** (was claude-relay). The command is still `relay`, and `foxrelay` works too. Project files (`docs/relay/`, `.relay/`) are unchanged, so existing projects and runs keep working.

## 2.2.0 (30 Sep 2026)

- Live progress: a spinner with elapsed time and the current action while Claude works, a milestone progress bar with percentage at every step, and the percentage in the terminal title.
- `relay status`: from any terminal, shows whether a run is alive, what it's doing, progress and the last log lines.
- `relay init`: sets up `docs/relay/` (config, rules, goal template) and adds `.relay/` to `.gitignore`.
- Plain `relay` uses `docs/relay/goal.md` and `docs/relay/relay.config.json` automatically. Goals with unfilled `[WRITE HERE]` placeholders are refused.
- `relay resume` continues the latest run of the project, no folder name needed.
- The same run can't be started twice (it would put two engineers on the same files).
- The safe deny list is now the built-in default, even when a config leaves it out. Read-only helpers (head, tail, wc, sort, sed -n) are allowed by default.
- Ready to publish: `npm install -g .` gives the `relay` command, MIT license, GitHub Actions CI, contributing guide, generic guides in English and Bangla.
- Plain ASCII in terminal headers and tool lines, so logs read cleanly in any Windows console.

## 2.1.0 (30 Sep 2026)

Everything found during the first real run, fixed for every project:

- `workerDeniedTools`: commands the engineer can never run, even if an allow rule matches (deny always wins).
- `workerDisableHooks`: turns off your own Claude Code hooks for the engineer. Needed when a hook rewrites commands (like rtk), because rewritten commands slip past allow and deny rules.
- `--message-file <file>`: send the planner a message of any length on resume (corrections, answers, guidance). It closes all open questions and holds back a waiting task so the planner can rewrite it.
- The planner closes questions itself when they are answered or no longer needed, so old questions are not asked again.
- Pasting several lines into an answer now counts as one answer. Type `skip all` to skip the remaining questions.
- A run that stopped at its round or time limit continues with a higher limit: `--resume-run <run> --rounds 40`.
- Louder built-in sounds (generated WAV files), `soundRepeat`, and your own `.wav` files via `doneSoundFile` / `alertSoundFile`.
- `--test-notify` shows the result of every step, so sound problems can be diagnosed.
- `relay.cmd` so `relay` works in Command Prompt and PowerShell once the folder is on PATH.
- Default engineer model: `claude-sonnet-5-5`.

## 2.0.0 (29 Sep 2026)

- Fully automatic by default, milestones, PLAN / DECISIONS / QUESTIONS / SUMMARY files.
- Survives internet drops, usage limits, laptop sleep and crashes (`--resume-run`), never repeats work.
- Git checkpoints and `--rollback`, stuck detection, round and time limits, sound and notifications.
