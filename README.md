# FoxRelay

By Md. Khobayer Khan, [Delta Fox Technology](https://github.com/khobayer).

**Give it a goal or a whole PRD, then walk away.** A planner model (Opus) turns the goal into milestones and writes each step. Claude Code (Sonnet) implements it, runs the tests and commits. The planner checks the work against the real files and git, then writes the next step. The loop runs until every milestone is done, then plays a sound and leaves a `SUMMARY.md`.

```
you: goal / PRD
  └─> Opus (planner, read-only)      turns it into milestones, writes step 1
        └─> Sonnet (Claude Code)     implements, tests, commits, reports
              └─> Opus               verifies the report against the files + git,
                                     decides on its own, writes the next step ...
                                     until every milestone is done  ──>  sound + SUMMARY.md
```

It runs on your own `claude` CLI login, so there is no API key to set up. Usage counts against your Claude plan's limits.

Version 2.2.1. Zero dependencies. See [CHANGELOG.md](CHANGELOG.md).

> FoxRelay drives Claude Code, a product of Anthropic. It is an independent project, not affiliated with or endorsed by Anthropic.

## What it handles by itself

| Situation | What happens |
|---|---|
| Internet drops | Pauses, checks every 15s, continues when it's back |
| Usage limit hit | Waits for the reset, then continues |
| Laptop sleeps | Picks up after wake. Sleep doesn't count toward timeouts |
| A command hangs (dev server, watcher) | Stopped after the timeout, the planner is told, the run goes on |
| Relay crashes, terminal closed, Ctrl+C | State is saved after every step. `relay resume` continues from the same spot |
| A question only you can answer | Parked in `QUESTIONS.md`. Work continues on everything else |
| Same problem for several rounds | The planner changes approach, then parks the milestone, then stops and calls you |

**Resuming never repeats work.** Every message carries a marker. After an interruption the relay reads Claude Code's own session transcript to see whether the message actually arrived. If it did, the engineer is told to check git and finish what's left, and the task is not sent again.

## Requirements

- Node 18 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in (`claude` works in your terminal)
- A git repository for your project
- CI runs on Linux. It is used daily on Windows. macOS should work but is untested

## Install

```bash
git clone https://github.com/khobayer/foxrelay.git
cd foxrelay
npm install -g .
```

That gives you the `relay` command everywhere. Check with `relay --version`.

Without npm: keep the folder anywhere and run `node path/to/relay.mjs` instead of `relay`. On Windows you can add the folder to your PATH and use `relay.cmd`.

## Quick start

```bash
cd my-project
git checkout -b relay/first-run        # work on a branch
relay init                             # creates docs/relay/ and ignores .relay/
```

Edit the three files `relay init` created:

- `docs/relay/goal.md`: what to finish, what "done" means, what not to touch
- `docs/relay/rules.md`: house rules for this project
- `docs/relay/relay.config.json`: which commands the engineer may and may not run

Commit them, then:

```bash
relay                                  # start (uses docs/relay/)
relay status                           # from any terminal: progress and what it's doing
relay resume                           # after a crash, Ctrl+C or "needs you"
```

While it runs you see a live progress line and a spinner, and the terminal title shows the percentage:

```
Progress [##########--------------] 42%  5/12 milestones  |  now: M6  |  round 14/100  |  2h05m
/ Sonnet working on M6  3:41  Edit src/app/devices/page.tsx
```

The percentage counts finished milestones. The planner can add milestones as it learns more about the project, so it can move backwards a little.

## Commands

| Command | What it does |
|---|---|
| `relay init` | Set up `docs/relay/` in the current project |
| `relay` | Start a run with `docs/relay/goal.md` and `docs/relay/relay.config.json` |
| `relay --goal-file PRD.md` / `--goal "text"` | Start with another goal |
| `relay status [run-folder]` | Progress, current step, running or not, last log lines |
| `relay resume [run-folder]` | Continue the latest run (or the one given) |
| `relay resume --rounds 40` | Continue a run that stopped at its round limit |
| `relay resume -m message.md` | Send the planner a message of any length first: answers, corrections, new instructions |
| `relay --rollback <run-folder> --to-round <n>` | Reset the code to before round n (uncommitted changes go to `git stash`), then `relay resume` |
| `relay --test-notify` | Play the sounds and show a notification, with a report of each step |
| `--rounds <n>`, `--hours <n>` | Limits (default 100 rounds) |
| `--confirm` | Ask before every engineer run |
| `--config <file>` | Use another config |

Several projects at once: each project has its own `docs/relay/` and `.relay/`, so run one relay per project in separate terminals. The relay refuses to start the same run twice.

## Files in `.relay/<run>/`

| File | What it's for |
|---|---|
| `SUMMARY.md` | Read this first: result, milestones, open questions, decisions, commits, files changed, next steps |
| `PLAN.md` | Milestones and their status, updated every round |
| `DECISIONS.md` | Every decision the planner made on its own, with the reason |
| `QUESTIONS.md` | Questions for you, what it did meanwhile, and the answers |
| `CHECKPOINTS.md` | Git HEAD before each round, plus the rollback command |
| `relay.log` | Everything that was printed |
| `NNN-prompt.md`, `NNN-report.md` | What the engineer got and reported, per round |
| `state.json` | What resume uses. Don't edit it |

## Safety

Read this before an unattended run on a real project.

- **Work on a branch.** The relay commits locally and never pushes. You review, push and tag.
- **`workerDeniedTools` is a hard block.** Deny rules win over allow rules. The default denies `git push`, `git tag`, `git reset --hard`, `git clean`, `rm -rf`, `ssh`, database resets and reading `.env` files. Add anything dangerous in your project, for example `"Bash(npm run *:prod*)"` or `"Bash(docker *)"`.
- **Keep production credentials out of the project folder during a run.** If your `.env` points at a live system, move it out and put a local-only one in its place for the run.
- **Command-rewriting hooks break allow and deny rules.** If you use a Claude Code hook that rewrites commands (rtk, for example), set `"workerDisableHooks": true`. Otherwise `git push` can become `rtk git push` and slip past `Bash(git push*)`. Never add a broad rule like `Bash(rtk *)`.
- **The planner is read-only.** Opus can only Read, Glob and Grep. It cannot change your code.
- **The planner can't see your UI.** Check screens yourself before you ship.

## Config (`docs/relay/relay.config.json`)

Any key you leave out uses the default. Exception: `workerAllowedTools` and `workerDeniedTools` replace the defaults as a whole, so copy the full lists (`relay init` does this for you).

| Key | Default | Notes |
|---|---|---|
| `plannerModel` / `workerModel` | `claude-opus-5-5` / `claude-sonnet-5-5` | Aliases like `opus` and `sonnet` work too |
| `plannerEffort` / `plannerReviewEffort` | `high` / `medium` | High for planning and new milestones, medium for routine reviews |
| `workerAllowedTools` | npm, npx, node, git status/diff/log/add/commit, read-only shell tools | Commands the engineer may run without asking |
| `workerDeniedTools` | push, tag, hard reset, clean, rm -rf, ssh, db resets, .env reads | Commands the engineer can never run |
| `workerDisableHooks` | `false` | Turn off your own Claude Code hooks for the engineer |
| `maxRounds` / `maxHours` | `100` / `null` | |
| `timeoutMinutes` | `60` | Per Claude run, awake time only |
| `freshSessionPerMilestone` | `true` | New sessions per milestone keep context small and save tokens |
| `stuck` | `3 / 5 / 7` | Rounds without progress before: warn / park / stop |
| `recovery.maxWaitHours` | `12` | Give up waiting for internet or limits after this long |
| `notify.soundRepeat` | `2` | Times each sound plays in a row |
| `notify.doneSoundFile` / `alertSoundFile` | `null` | Your own `.wav` files |
| `notify.buzzUntilAck` | `true` | Repeat the sound every minute (up to 30 min) until you press Enter |
| `notify.ntfyUrl` | `null` | Phone push via [ntfy](https://ntfy.sh). Use a hard-to-guess topic name |
| `roles` | `{}` | Per-role model and extra instructions (backend, frontend, database, ...) |

### Roles

The planner tags every step with a role. You can give a role its own instructions or model:

```json
"roles": {
  "database": { "systemPromptFile": "roles/database.md" },
  "frontend": { "systemPromptFile": "roles/frontend.md", "model": "claude-sonnet-5-5" }
}
```

## Writing a good goal

- Say what "done" means in checkable terms: which commands must pass, which features must work.
- Say what must not be touched.
- For an existing project, make the first milestone an audit: run the build and tests and record what works before building anything new.
- Point to your PRD, and put project facts (commands, database, ports) in `CLAUDE.md`, which Claude Code reads by itself.
- Start with `--rounds 5` to `10` and read `DECISIONS.md` before you hand it a whole project overnight.

## Guides

- [GUIDE.md](GUIDE.md): step-by-step guide, Windows-friendly
- [GUIDE.bn.md](GUIDE.bn.md): বাংলা গাইড

## Tests

```bash
npm test
```

20 scenario tests with a fake `claude`: internet drops before and during a task, usage limits, crashes, leftover processes, hung commands, stuck milestones, round limits and extending them, rollback, deny lists, hooks, message files, question handling, `init`, `status`, `resume` and the double-start guard. No API calls. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
