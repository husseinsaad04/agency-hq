# Agency HQ

A local control room for my AI agents: who exists, what each is doing now, and safe buttons to control them.

## Run
```bash
cd ~/Projects/agency-hq && npm start      # then open http://127.0.0.1:7777
npm test                                   # Node's built-in test runner, no dependencies
```
Zero npm dependencies (Node 24 built-ins only). Data lives in `~/.agency-hq/agency.db` (events kept 7 days).

## Always on (LaunchAgent `local.agency-hq`)
Installed at `~/Library/LaunchAgents/local.agency-hq.plist`: starts at login (RunAtLoad), restarts within seconds if it crashes (KeepAlive), localhost only. Log: `~/.agency-hq/server.log`.
```bash
launchctl print gui/$(id -u)/local.agency-hq | grep -E "state|pid"     # status
launchctl kickstart -k gui/$(id -u)/local.agency-hq                    # restart (after code changes to server/)
launchctl bootout gui/$(id -u)/local.agency-hq                         # stop and disable until next bootstrap
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.agency-hq.plist   # start again
```
Changes to files in `web/` show on the next page reload; changes to `server/` need the restart command above. Do not also run `npm start` while the service is on (same port).

## What it shows (read-only adapters, polled every 3 s)
Claude Code sessions (from `~/.claude/sessions`, metadata only), OpenClaw and Hermes (Docker), Jarvis, the nightly jobs
and Clipflow monitor (launchd + newest report STATUS), Ollama, OpenCode/Aider/Codex (process check), and a static card for the cloud routine.

## What it can do (allowlisted actions only, see `server/actions.js`)
OpenClaw start/stop/restart, Ollama start/stop, nightly job run/pause/resume, open OpenCode/Aider/Codex/Claude in Terminal on a chosen project,
and run one Hermes task in its Docker sandbox on a chosen project. Dangerous ones ask for confirmation, server-enforced.

## Security
Localhost only, Host and Origin checks, a per-start secret nonce on every POST, strict CSP, fixed argv (no shell), validated inputs,
projects limited to folders under `~/Projects` (no `_` or `.` folders), prompts never stored (only their length), audit log in SQLite.

## Office view (default tab) and Roster tab
The Office is a pixel-art map drawn in code (no image files): agents walk to their desks and type when working, sleep on the sofa when on call,
the Night Watch stands at the board with a real-time clock, Ollama tends the server racks, OpenClaw paces inside the quarantine cage, and Claude Code
sessions take the lower desks when busy and hang out in the lounge when idle. Speech bubbles: "!" needs you, "?" unknown, "X" error, "zzz" resting.
Click a character to see its computer screen (real state, activity, recent events) and its control buttons. Layout and walking logic live in
`web/office-logic.js` (pure, unit-tested); drawing in `web/office.js`. In-world monitor animations are decorative; the screen panel is the truth.

## Live activity from Claude Code (hooks)
`node scripts/install-hooks.mjs` adds async command hooks (UserPromptSubmit, PreToolUse, Notification, Stop, SubagentStart/Stop, SessionEnd) to
`~/.claude/settings.json` (backup at `settings.json.agency-hq.bak`); `--remove` takes them out again. Only NEW sessions load them.
`hook/agency-hook.mjs` reduces each event to a tiny safe payload and POSTs it to localhost with a bearer token from `~/.agency-hq/hook-token` (0600).
Privacy: shell commands keep only the program name, files only the basename, web only the host; prompts, tool output, notification text and file
contents are never sent. It always exits 0 and never blocks Claude. If Agency HQ is not running the hook silently does nothing.
Result: sessions show "editing app.js", "reading notes.md", "running npm", "browsing docs.example.com", "thinking", "waiting for you (permission)",
and sub-agents appear as hard-hat helper characters beside their parent's desk. Monitors and bubbles change with the activity. Activity is in memory only.

## Levels (XP from verified results only)
Ledger in SQLite (`ledger` table, append-only; totals and levels are always derived). XP sources, and nothing else:
**+50** you press "Good result" on an agent (browser-only, needs the page's secret nonce, 10 per agent per hour, undo within 5 minutes),
**+10** a test run passed (auto from the hook, max 3 per session and 10 per agent per day, 20 s apart), **+5** a nightly check reported STATUS OK (once per job per day).
Failing tests and "Not good" earn 0 and lower the pass rate. Level n needs `100*(n-1)^1.5` XP (100, 283, 520, 800 ...). Rank (Intern, Junior, Engineer, Senior, Staff)
comes from the rolling pass rate of the last 40 verdicts, so it can go DOWN. Claude sessions and sub-agents all credit Claude Code.
Never XP for messages, tool calls, tokens, uptime, lines or files. The game is a read-only view and never feeds back into an agent's goals.
Hooks send only "a test run passed/failed" (never the command): `PostToolUse`/`PostToolUseFailure` for Bash.

## Self-improvement lab (LAB tab)
An agent may only SUGGEST a better version of its own instructions (plain text). It cannot touch files, settings, hooks, keys, tests or code.
Subject today: the Jarvis Night Watch report-writer prompt (`~/Automations/jarvis-health/prompt.md`).
- **Frozen exam** `lab/subjects/jarvis-health.js` (chmod 444; edit only by hand with `chmod u+w`): the rules (`oracle`), 12 practice cases and 8 HIDDEN cases the improver never sees, and a deterministic scorer. The improver is told the written rules (`spec`) but never the cases.
- **Cycle** (`lab/engine.js`): score the current prompt (each case twice) -> ask the local model (Ollama qwen3-coder, free, private) for a better one from 4 failures -> safety-check the text (size, keeps STATUS/PROBLEMS/NEXT STEP, no links/commands/"ignore instructions") -> test on practice cases -> test on hidden cases -> strict gate: practice must improve by 0.03, hidden must not drop AND must improve (otherwise it may be memorised), perfect-case counts must not drop. Hard budget 240 model calls, 30 minutes.
- **You decide** (`server/lab.js`): nothing deploys without your Approve (browser-only, secret nonce, explicit confirmation). Approve backs up the old prompt (`~/.agency-hq/lab-backups`), swaps the file atomically, records a version, and gives the agent +50 XP once. Refuses if the live prompt changed since the proposal (stale). Revert restores the previous version and takes the XP back. "Re-check with Claude" optionally re-scores old vs new with Haiku (~40 calls on your plan, asks first).
- Caveat: scores come from the local model, while the nightly job runs on Claude Sonnet. Review the DIFF yourself; a higher score does not prove better wording (proposal #1 scored higher but invented a ">2 error lines" rule).
- **Test-taker choice:** each cycle can use the free local model (default) or, opt-in per run, real Claude Sonnet (the model the nightly job uses; one run per case, about 60 to 130 calls on your plan; asks first). A cycle also keeps every attempt (text, outcome, scores) so a failed cycle can be read. The improver is told to make the SMALLEST edit and a proposal must still mention FACTS.
- Subjects: `jarvis-health` (deployed once) and `clipflow-monitor` (real Sonnet scores 55% fully-correct on its exam with the current prompt, so there is room; a Claude-as-test-taker cycle has not been run yet).
- Add a new subject = a new file in `lab/subjects/` exporting id, agent, promptPath, compose, factsOf, dev, heldout, score, spec; register it in `server/index.js`.

## Not built yet
OpenCode/Codex event adapters, a layout editor, and sound. See `CLAUDE.md` for the rules those must follow.

## Private phone access

Owner-authorized Tailscale Serve proxies the loopback server to the owner's devices. Optional `~/.agency-hq/phone-access.json` contains an exact private `.ts.net` origin and the owner's Tailscale login. Every proxied read and action requires that identity, the exact proxy host, and a loopback connection. All browser actions also retain same-origin, nonce, JSON and explicit-confirmation checks. Remote hooks are blocked. No public Funnel or LAN listener is used.

The current phone endpoint is `http://macbook-pro.tailf5cfde.ts.net:7778/`, transported inside Tailscale's encrypted private network (HTTP inside the VPN, not public HTTPS). On iPhone install Tailscale, use the same account as the Mac, turn it on, open the endpoint in Safari, and use Share → Add to Home Screen → Saad HQ. The Mac must be awake, connected, and running HQ. No background wake or power settings are changed.

Disable only HQ's proxy with `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --http=7778 off`. Remove the phone-access configuration and restart HQ to restore the local-only default. Do not reset unrelated Tailscale services. HTTPS can be added later after enabling tailnet certificates and updating the exact configured origin.

## Automatic project recovery and readiness

New company projects automatically assign a separate Builder or Tester repair run when a stage fails or reports an incomplete local deliverable. The original report is preserved and receives an automatic changes-requested review, never a fabricated owner approval. A repair needs explicit `REPAIR_RESOLVED: YES` and `HANDOFF_READY: YES` before the original specialist reruns the stage; its actual handoff and testing checks still gate advancement. There are at most two repairs per stage, separate from the two existing time-limit continuations. Owner login, permission, agreement, purchase, and subscription-limit blocks pause rather than bypassing controls or changing billing. Cancelled work and restarts never silently replay. Final delivery still needs the owner's review.

Every selected assignment and project card displays Handoff ready: Yes, No, Not yet, or Not confirmed. Readiness uses the final public report, never tool events or task approval alone. Conflicting markers or failed required checks remain No; older reports without an explicit decision are Not confirmed. Future agent prompts request a readiness decision for every result. No background agent processes are created just by enabling this feature.

## Dispatch desk (TASKS tab)
Click **New task**, choose a specialist, runtime, project, access mode and time budget, and send the assignment. The six built-in skills are Researcher, Planner, Builder, Reviewer, Tester and Writer. **Specialists & reusable skills → Create a skill** saves your own reusable instructions. These are roles for real assignments, not always-running processes.

Supported execution: Codex CLI (read-only or project-write), Claude Code (read-only), and Ruflo Research Team (Claude-powered, read-only). They use your existing CLI login and provider allowance. Ruflo initializes an isolated hive under `~/.agency-hq/ruflo-runs/<task-id>` and launches Claude; provider or permission failures are displayed instead of simulated success. Existing OpenCode/Aider launchers and Hermes sandbox controls remain available in Roster.

Tasks run up to two at once, with one task per project to avoid conflicting changes. The inbox has status filters, current activity, tool commands and exit codes, changed-file summaries, public replies, reported token usage/cost where the provider supplies it, 1–30 minute budgets, cancellation, explicit retries, follow-up assignments, and downloadable reports. Select an assignment's character in Office and click **View assignment** to open its task. Approve/Needs changes records your review; it does not deploy or undo project edits, and does not automatically award XP.

HQ-managed instructions, public replies and event summaries persist in SQLite for your task history. External sessions continue to use sanitized metadata and hooks only. Private reasoning, raw tool-result bodies and provider initialization payloads are omitted. Common key/password patterns are redacted from displayed replies and tool commands; this is not a comprehensive DLP filter. Do not include credentials in assignments.

On restart, pending/running tasks become **interrupted** rather than automatically repeating work. **Run again** creates a fresh run. Stopping a task terminates its process group; files already changed stay changed. Review the partial output before retrying. Claude/Ruflo may be unavailable when your Claude allowance is exhausted; Codex is a separate execution option.

## Connection recovery
Live status connects independently of the agent controls, which retry automatically if their initial request fails.
Hermes task-output polling retries after temporary connection failures without restarting the task.

### Company operating system

Use **COMPANY** to route a business objective, launch a playbook, browse department SOPs, or maintain project-specific shared knowledge. The public AI Company Map's 24 department functions plus conductor are covered by 25 original HQ roles. Six agency delivery roles bring the company library to 31; the original six specialists remain available (37 built-in roles total).

Every workflow stage is a real assignment visible in **TASKS**. Approve the result there, then return to COMPANY to save its output into the shared brain and send the next stage. Retries can include change instructions. Active brain notes are included in future tasks for that project; export them as Markdown for Obsidian.

See [coverage, architecture, and integration limits](docs/COMPANY-MAP-INTEGRATION.md). The source does not provide the author's private 57-agent pack. Publishing, messaging, avatar generation, scheduled backups, and account ingestion are represented by draft/analysis SOPs until the corresponding integrations are connected.

### Installed Paperclip company

**AGENCY TEAM** contains the 167 imported Agency Agents definitions and ten source divisions (leadership is a separate filter). Click **Assign from HQ** to choose project, runtime, access, budget, and instructions. The role's resolved instructions and HQ's active project knowledge are included at launch. Run progress, cancellation, and result approval remain in **TASKS**.

Paperclip runs at http://127.0.0.1:3100 under the `local.agency-hq.paperclip` LaunchAgent. Its company is Agency HQ. Imported-role assignments are mirrored to actual Paperclip issues, including the corresponding project, status, activity, and public result. Approved results become done; unapproved results stay in review and changes-requested/failed/interrupted results are blocked. Idempotency keys prevent duplicate issue creation during retries. If Paperclip is offline, HQ tasks keep running and synchronization retries later.

Execution is HQ-managed: Paperclip's native agent wakeups are paused, so assignments made directly in its UI do not start a second worker queue. Use HQ to dispatch. This preserves the existing two-worker/project locks and result-review gates. Paperclip's org chart, managed role instructions, local task board, and database backups are installed. Third-party accounts, publishing tools, and automatic provider failover have not been configured by this install.

Service packages, imported source/license files, role mapping, company connection, and Paperclip's private data live under `~/Projects/agency-hq-services/`. This directory and symlink aliases into it are excluded from selectable agent workspaces. Provider credentials are not copied into role instructions or company templates. Paperclip telemetry is disabled for this local service. HQ keeps its zero-dependency design; Paperclip's dependencies are installed separately.

Connection code: `server/paperclip.js`; imported skills enter the existing fixed-provider runner. The browser sees only the roster summaries and task links, not the internal synchronization snapshot. The service and HQ both stay bound to 127.0.0.1.

### Company tower interface

Headquarters presents all assignable HQ and imported specialists as residents with personal display names, stylized avatars, and private offices. Department floors combine HQ SOPs with the imported company; source roles and task identities stay intact. Cross-floor search, six-office pagination, and resident profiles lead to the existing assignment and review flow. Personal names are stored in this browser only.

The scene uses local CSS perspective and layered geometry, rather than a WebGL game engine. Walking and assistant companions are decorative; lighting and profile activity follow the actual HQ task queue. Assistant companions do not execute separate work. Pause ambience and the system reduced-motion preference stop scene animation. Systems, People, Workflows & memory, Assignments, and Lab remain available with a consistent dark interface.

### Saad Headquarters — interactive 3D company

The Headquarters tab now uses an original WebGL company model with all assignable specialists on department floors. Use Company view, Separate floors, department buttons, or people search to navigate. Drag to orbit, scroll/pinch to zoom, right-drag to pan, and Reset camera to return. Clicking a person selects their resident profile; clicking a monitor opens that resident's actual HQ workstation feed. Focus office moves the camera to the selected desk. The Walkthrough button explains dispatch, review and project memory.

Workstation panels poll the selected real task every two seconds; company snapshots refresh every four seconds. Screens render actual role, task status/title and activity, while detailed panels show the existing sanitized tool-event summaries and public replies. They do not capture external desktops, transcripts or private reasoning. Disconnections are marked stale, and old or other-resident task details are rejected. Avatar walking, lamps, landscaping and assistant orbs are decorative. No separate assistant agent is launched.

Three.js 0.186.1 and its matching OrbitControls are vendored from the official npm package under web/vendor, with the MIT license retained. OrbitControls' import is rewritten to the local Three.js module. The Node server still has zero npm dependencies and keeps its same-origin CSP and fixed static allowlist. Shared geometry, per-floor instanced meshes, a capped pixel ratio, reduced-motion support, and paused offscreen rendering limit scene cost. Unsupported WebGL falls back to the same accessible resident directory and task controls.


### Detailed department interiors
The original local WebGL model now sizes each department floor to its resident count, reserves a rear meeting suite / lounge / coffee bar, and fills spare office bays with focus booths. Individual glass office pods have carpet, L-shaped wood desks, keyboards, storage, lighting, plants, nameplates and visitor chairs. Tile and wood textures are procedurally generated locally. Rendering uses 1.5–2.5× display resolution subject to an eight-million-pixel buffer limit, anisotropic texture filtering, 768×432 workstation textures, and soft directional shadows in focused floor views. Tower views disable expensive shadow passes. Decorative furnishings never create tasks or workers.
Design references: Gensler Singapore (https://www.gensler.com/projects/gensler-singapore), Three.js responsive rendering (https://threejs.org/manual/pages/responsive.html), textures (https://threejs.org/manual/pages/textures.html), shadows (https://threejs.org/manual/pages/shadows.html). No reference image or third-party office model is embedded in the app.


### Codex subscription toolkit
HQ Codex assignments explicitly select the native OpenAI provider, require ChatGPT login, and enable live native web search. OpenAI and Azure API-key/gateway environment variables are removed from the Codex child; global Codex settings, stored login, configured skills/plugins/MCP, and sandbox access remain with Codex. Each new task records `billingMode: chatgpt-subscription`, the toolkit identifier, and a tool-policy timeline event. The assignment form and Assignments toolkit panel explain availability and shared plan limits. A subscription limit or authentication block stops the assignment; HQ never purchases credits or switches providers automatically. Existing third-party tools may have their own fees and require separate account authorization. Tool availability is conditional on account/client configuration, not merely a connector catalog entry. HQ memory remains project-scoped.
Official references: https://learn.chatgpt.com/docs/auth and https://learn.chatgpt.com/docs/extend/mcp?surface=cli . Read-only local probes confirmed native web search, image generation and browser/computer tool namespaces on this installation; probe outputs are retained under work/ for verification. No API key was created, no new provider or paid connector was enrolled.

Automatic local projects now finish as Delivered after verified stage handoffs; owner review remains optional and never fabricated. HQ supplies separate localhost static previews for supported projects and can retry one listener-blocked stage automatically. It serves no private files, executes no project scripts, and does not alter sandbox permissions. Server-backed previews, provider/login blocks, publishing and external actions still require their actual access and checks. Earlier superseded attempts remain in history and link to the current assignment.
