# FoxRelay: ধাপে ধাপে বাংলা গাইড

## এক কথায়

আপনি goal বা PRD দেবেন, তারপর অন্য কাজে চলে যাবেন। Opus plan করবে আর কাজ যাচাই করবে, Claude Code (Sonnet) code লিখবে। কাজ শেষ হলে শব্দ হবে, notification আসবে, আর `SUMMARY.md` file-এ সব লেখা থাকবে।

## কী কী নিজে সামলাবে

| ঘটনা | কী হবে |
|---|---|
| Internet চলে গেল | থেমে অপেক্ষা করবে, ফিরলে নিজেই চালিয়ে যাবে |
| Usage limit শেষ | Reset পর্যন্ত অপেক্ষা করে নিজেই চালিয়ে যাবে |
| Laptop-এর lid বন্ধ বা sleep | জাগার পর নিজেই চলবে |
| কোনো command আটকে গেল | সময় পার হলে বন্ধ করবে, Opus-কে জানাবে, কাজ চলবে |
| এমন প্রশ্ন যেটা শুধু আপনি জানেন | প্রশ্ন রেখে দিয়ে বাকি কাজ চালিয়ে যাবে |
| একই সমস্যায় আটকে থাকা | অন্য পদ্ধতি নেবে, তারপর ওই অংশ বাদ রাখবে, তারপর থেমে আপনাকে ডাকবে |
| Crash, terminal বন্ধ, Ctrl+C | সব save থাকে। `relay resume` দিলে যেখানে থেমেছিল সেখান থেকে চলবে |

Resume করলে কাজ দুবার হয় না। Relay Claude Code-এর নিজের session file দেখে বোঝে message পৌঁছেছিল কিনা। পৌঁছে থাকলে Sonnet-কে শুধু বলা হয় git দেখে বাকিটা শেষ করতে।

## প্রথমবার সেটআপ (একবারই)

১. Install করুন (Node 18+ আর login করা Claude Code লাগবে):
```powershell
git clone https://github.com/khobayer/foxrelay.git C:\tools\foxrelay
cd C:\tools\foxrelay
npm install -g .
relay --version
```

২. শব্দ আর notification দেখুন:
```powershell
relay --test-notify
```
দুটো শব্দ আর একটা notification আসার কথা। `[check]` লাইনগুলোতে দেখাবে কোনটা কাজ করল। আস্তে শোনালে নিচের "সমস্যা" অংশ দেখুন।

৩. (ঐচ্ছিক) Phone-এ notification: **ntfy** app install করে এমন একটা topic-এ subscribe করুন যেটা কেউ অনুমান করতে পারবে না (যেমন `relay-myname-8f3k2`)। তারপর project-এর config-এ দিন:
```json
"notify": { "ntfyUrl": "https://ntfy.sh/relay-myname-8f3k2" }
```

## Project সেটআপ (প্রতি project-এ একবার)

```powershell
cd D:\projects\my-app
git status
git checkout -b relay/first-run
relay init
```

`git status` clean থাকতে হবে। `relay init` `docs\relay\`-এ তিনটা file বানাবে আর `.gitignore`-এ `.relay/` যোগ করবে:

- **goal.md:** কী শেষ করতে হবে, "done" মানে কী, কী ছোঁয়া যাবে না। প্রতিটা `[WRITE HERE]` বদলে দিন। চাইলে এখান থেকে আপনার PRD-র কথা বলে দিতে পারেন।
- **rules.md:** দুটো model-ই যে নিয়ম মানবে। আপনার project-এর নিয়ম যোগ করুন।
- **relay.config.json:** Sonnet কোন command চালাতে পারবে (`workerAllowedTools`) আর কোনটা কখনও পারবে না (`workerDeniedTools`)। আপনার project-এ ঝুঁকির কিছু থাকলে সেটা নিষিদ্ধ তালিকায় যোগ করুন।

Project-এর root-এ একটা `CLAUDE.md` থাকলে খুব কাজে দেয়। তাতে build আর test-এর হুবহু command, কোন database আর port, আর folder structure লিখে রাখুন। Claude Code এটা নিজে থেকেই পড়ে।

শেষে `docs/relay` আর `.gitignore` commit করুন।

## প্রতিটা run-এর আগে

- Git clean আছে, আর আপনি একটা branch-এ আছেন।
- Test-এর জন্য দরকারি database আর service চালু আছে। Relay এগুলো নিজে চালু করে না।
- `.env`-এ live বা production system-এর ঠিকানা থাকলে সেটা project folder থেকে সরিয়ে রাখুন, আর run-এর জন্য তার জায়গায় শুধু local-এর একটা copy বসান।

## চালানো

```powershell
cd D:\projects\my-app
relay
```

প্রথম কয়েকবার ছোট রাখুন, যেমন `relay --rounds 8`, আর পরে `DECISIONS.md` পড়ে দেখুন। Opus-এর সিদ্ধান্তে ভরসা হলে বড় কাজ দিন। প্রতিটা prompt পাঠানোর আগে নিজে দেখতে চাইলে `--confirm` যোগ করুন।

চলার সময় terminal-এ এরকম দেখাবে:
```
Progress [######------------------] 25%  3/12 milestones  |  now: M4  |  round 7/40  |  1h10m
/ Sonnet working on M4  2:13  Edit src/app/devices/page.tsx
```
Terminal-এর title-এও percentage দেখা যাবে।

**অন্য terminal থেকে বা ফিরে এসে অবস্থা দেখতে:**
```powershell
relay status
```
এটা দেখাবে relay এখনও চলছে কিনা, কী করছে, progress bar, আর log-এর শেষ কয়েকটা লাইন।

## শব্দ শুনলে

**কাজ শেষ (chime):** `.relay\<তারিখ-সময়>\SUMMARY.md` খুলুন। এতে থাকবে কী বানানো হলো, কোন milestone শেষ, Opus নিজে কী সিদ্ধান্ত নিয়েছে, আপনার জন্য কী প্রশ্ন আছে, কোন commit হলো, কোন file বদলালো, আর এরপর কী করবেন। Terminal-এ Enter চাপলে শব্দ বন্ধ হবে। প্রশ্ন থাকলে `a` চেপে উত্তর দিন, কাজ আবার চলবে।

**আপনাকে লাগবে (alarm):** Terminal একটা একটা করে প্রশ্ন করবে। উত্তর লিখে Enter চাপুন। শুধু Enter চাপলে একটা প্রশ্ন বাদ যায়, `skip all` লিখলে বাকি সব বাদ যায়। এখন উত্তর দিতে না পারলে `stop` লিখুন, পরে resume করবেন।

**শেষে সবসময় নিজে দেখবেন:** app চালিয়ে screen দেখুন, তারপর নিজে push আর tag করুন। Relay কখনও push করে না।

## সাধারণ পরিস্থিতি

**Round-এর সীমায় থেমে গেলে** (`SUMMARY.md`-এ লেখা "Stopped at the round limit"): কাজ দেখে নিন, তারপর বেশি সীমা দিয়ে চালিয়ে যান:
```powershell
relay resume --rounds 40
```

**Crash হলে বা terminal বন্ধ হয়ে গেলে:**
```powershell
relay resume
```
আগের কোনো Claude process চালু থেকে গেলে relay আগে সেটা বন্ধ করে। আর run যদি অন্য terminal-এ এখনও চলতে থাকে, একই run দুবার চালু করতে দেবে না।

**Planner-কে লম্বা message** (কয়েকটা উত্তর, সংশোধন, নতুন নির্দেশ): project-এর বাইরে একটা file-এ লিখুন, তারপর:
```powershell
relay resume -m D:\projects\relay-message.md
```
Planner সবার আগে এটা পড়বে, আর খোলা সব প্রশ্ন বন্ধ হয়ে যাবে।

**কোনো round খারাপ হলে:** `CHECKPOINTS.md`-এ প্রতিটা round-এর আগের অবস্থা লেখা থাকে।
```powershell
relay --rollback .relay\<তারিখ-সময়> --to-round 5
relay resume
```
Commit না করা পরিবর্তন হারাবে না, `git stash`-এ থাকবে।

## সমস্যা হলে

| সমস্যা | সমাধান |
|---|---|
| প্রতি round-এ একই "permission denial" | ওই command `workerAllowedTools`-এ যোগ করুন, denial-এ tool-এর যে নাম দেখায় সেই নামেই |
| `rtk git status` এর মতো command আটকে যাচ্ছে | আপনার একটা command-বদলানো hook আছে। Config-এ `"workerDisableHooks": true` দিন। `Bash(rtk *)` কখনও যোগ করবেন না |
| `claude` খুঁজে পাচ্ছে না | `where.exe claude` চালিয়ে যে path দেখায় সেটা config-এর `claudePath`-এ দিন |
| Round-এ অনেক সময় লাগছে | বড় build-এ এটা স্বাভাবিক। কোনো run মাঝপথে বন্ধ হয়ে গেলে `timeoutMinutes` বাড়ান |
| শব্দ খুব আস্তে | `relay --test-notify` চলার সময় Windows Volume Mixer খুলে "PowerShell" বা "System sounds"-এর slider বাড়ান। অথবা config-এ `"soundRepeat": 3` দিন, বা `doneSoundFile` / `alertSoundFile`-এ নিজের `.wav` দিন |
| লম্বা উত্তর paste করে গোলমাল হলো | এক লাইনের বেশি যেকোনো কিছুর জন্য `relay resume -m file.md` ব্যবহার করুন |

## সৎভাবে সীমাবদ্ধতা

- Opus screen দেখতে পায় না। UI নিজে চোখে দেখবেন।
- অস্পষ্ট goal দিলে ফলও অস্পষ্ট হবে। PRD যত পরিষ্কার, কাজ তত ভালো।
- Claude Code-এ আপনার install করা plugin আর hook Sonnet-এর উপরও কাজ করে, যদি না `workerDisableHooks` চালু থাকে।
