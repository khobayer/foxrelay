# Changelog

Check your version with `relay --version`.

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
