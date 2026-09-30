# FoxRelay: step-by-step guide

## In one line

You give it a goal or a PRD and go do other work. Opus plans and checks, Claude Code (Sonnet) writes the code. When it's done you hear a sound, get a notification, and everything is written up in `SUMMARY.md`.

## What it handles by itself

| Situation | What happens |
|---|---|
| Internet goes down | Pauses, continues by itself when the internet is back |
| Usage limit reached | Waits for the reset, then continues by itself |
| Laptop lid closed or sleep | Continues by itself after wake |
| A command hangs | Stops it after the timeout, tells Opus, work goes on |
| A question only you can answer | Parks it and keeps working on everything else |
| Stuck on the same problem | Tries another approach, then parks that part, then stops and calls you |
| Crash, terminal closed, Ctrl+C | Everything is saved. `relay resume` continues from the same spot |

Resuming never does work twice: the relay checks Claude Code's own session file to see whether an interrupted message arrived, and if it did, the engineer is told to check git and finish only what's left.

## One-time setup

1. Install (needs Node 18+ and a logged-in Claude Code):
   ```powershell
   git clone https://github.com/khobayer/foxrelay.git C:\tools\foxrelay
   cd C:\tools\foxrelay
   npm install -g .
   relay --version
   ```
2. Check sound and notifications:
   ```powershell
   relay --test-notify
   ```
   You should hear two sounds and see a notification. The `[check]` lines show what worked. Too quiet? See "Problems" below.
3. (Optional) Notifications on your phone: install the **ntfy** app, subscribe to a topic name nobody could guess (for example `relay-myname-8f3k2`), and put it in your project config:
   ```json
   "notify": { "ntfyUrl": "https://ntfy.sh/relay-myname-8f3k2" }
   ```

## Set up a project (once per project)

```powershell
cd D:\projects\my-app
git status                       # must be clean
git checkout -b relay/first-run
relay init
```

`relay init` creates three files in `docs\relay\` and adds `.relay/` to `.gitignore`:

- **goal.md**: what to finish, what "done" means, what not to touch. Replace every `[WRITE HERE]`. You can point it to your PRD.
- **rules.md**: house rules both models follow. Add your project's rules.
- **relay.config.json**: which commands the engineer may run (`workerAllowedTools`) and may never run (`workerDeniedTools`). Add anything dangerous in your project to the deny list.

Also good to have: a `CLAUDE.md` in the project root with the exact build and test commands, which database and port to use, and the folder structure. Claude Code reads it by itself.

Commit `docs/relay` and `.gitignore`.

## Before every run

- Git is clean and you're on a branch.
- Databases and services the tests need are running (the relay never starts them).
- If `.env` points at a live or production system, move it out of the project folder and put a local-only copy in its place for the run.

## Run it

```powershell
cd D:\projects\my-app
relay
```

Keep the first runs small, for example `relay --rounds 8`, and read `DECISIONS.md` afterwards. Once you trust its decisions, give it bigger work. Add `--confirm` to see every prompt before it's sent.

While it runs you see:
```
Progress [######------------------] 25%  3/12 milestones  |  now: M4  |  round 7/40  |  1h10m
/ Sonnet working on M4  2:13  Edit src/app/devices/page.tsx
```
The terminal title shows the percentage too.

**Check on it from another terminal** (or after coming back):
```powershell
relay status
```
It shows whether it's still running, what it's doing, the progress bar and the last log lines.

## When you hear a sound

**Finished (chime):** open `.relay\<date-time>\SUMMARY.md`. It lists what was built, which milestones are done, the decisions it made on its own, questions for you, commits, changed files and next steps. Press Enter in the terminal to stop the sound. If there are questions, press `a` to answer them and keep going.

**Needs you (alarm):** the terminal asks its questions one by one. Type an answer and press Enter. Enter alone skips one, `skip all` skips the rest. If you can't answer now, type `stop` and resume later.

**Always check the result yourself:** run the app, look at the screens, then push and tag. The relay never pushes.

## Common situations

**It stopped at the round limit** (`SUMMARY.md` says "Stopped at the round limit"): check the work, then continue with a higher limit:
```powershell
relay resume --rounds 40
```

**Crash or closed terminal:**
```powershell
relay resume
```
If an old Claude process is still running, the relay stops it first. If the run is still alive in another terminal, it refuses to start it twice.

**A longer message for the planner** (several answers, corrections, new instructions): write it in a file outside the project, then:
```powershell
relay resume -m D:\projects\relay-message.md
```
The planner reads it first and all open questions are closed.

**A round went wrong:** `CHECKPOINTS.md` lists the state before every round.
```powershell
relay --rollback .relay\<date-time> --to-round 5
relay resume
```
Uncommitted changes are kept in `git stash`.

## Problems

| Problem | Fix |
|---|---|
| The same "permission denial" every round | Add that command to `workerAllowedTools`, using the tool name shown in the denial |
| Commands like `rtk git status` are denied | You have a command-rewriting hook. Set `"workerDisableHooks": true`. Never add `Bash(rtk *)` |
| `claude` not found | Run `where.exe claude` and put that path in the config's `claudePath` |
| Rounds take long | Normal for big builds. Raise `timeoutMinutes` if runs get stopped |
| Sound too quiet | Open the Windows Volume Mixer during `relay --test-notify` and raise "PowerShell" / "System sounds". Or set `"soundRepeat": 3`, or your own `.wav` in `doneSoundFile` / `alertSoundFile` |
| Pasted a long answer and it went wrong | Use `relay resume -m file.md` for anything longer than one line |

## Honest limits

- Opus can't see the screen. Check the UI yourself.
- A vague goal gives a vague result. The clearer the PRD, the better the work.
- Plugins and hooks you installed in Claude Code apply to the engineer too, unless `workerDisableHooks` is on.
