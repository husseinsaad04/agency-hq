# Agency HQ research and implementation notes

Research date: October 7, 2026. This is a technical control-room specification, rather than a claim that a particular agency business model is profitable.

## Research method and Ruflo outcome

The installed Ruflo 3.52.0 CLI and its local skill were inspected. An isolated hierarchical-mesh hive was initialized with two researcher registrations and a Claude coordinator launched through `hive-mind spawn --claude --non-interactive --no-auto-permissions`. Claude returned a session-limit error before research began, reporting a 7:40 AM America/Detroit reset. No research findings are attributed to that blocked run. The source synthesis below was completed separately from official documentation. A registration count is not proof that two model workers executed; only observed process/tool events establish work.

Ruflo documentation: https://github.com/ruvnet/ruflo/blob/main/docs/STATUS.md
Ruflo swarm plugin: https://github.com/ruvnet/ruflo/blob/main/plugins/ruflo-swarm/README.md

## Patterns that matter for this HQ

### 1. A specialist needs a clear role, reusable instructions, and a concrete assignment

CrewAI separates agent roles, goals, tools and tasks. This is useful as a design pattern without adding CrewAI as a dependency. A dashboard's agents should have distinct responsibilities and explicit deliverables. A researcher returns evidence; a planner returns acceptance criteria; a builder implements; a reviewer finds defects; a tester verifies; a writer produces a complete draft. Merely naming more avatars does not add capability.

Source: https://docs.crewai.com/en/concepts/agents

Applied: six reusable built-in specialist skills, custom skills, project selection, task instructions, and independently chosen execution runtime. Skills are applied to actual task prompts; a role does not imply a running process.

### 2. Observability should show execution, not an invented progress percentage

LangGraph documents streamed state updates, message output and tool lifecycle events. The practical lesson is to expose timestamps, what tool started, what finished, and what result was returned. The office animation can communicate state, but the task detail view must provide evidence. Private model reasoning is not required for operational visibility.

Source: https://docs.langchain.com/oss/javascript/langgraph/streaming

Applied: durable task events; command start/completion and exit codes; changed-file and web-search summaries; public replies; current activity; result text. Uninstrumented external sessions retain existing metadata/hook visibility and do not get fabricated task histories.

### 3. Completion and human acceptance are different states

CrewAI human-feedback workflows and LangGraph interrupts emphasize an explicit point where a person reviews work. A successful model process does not prove the assignment was fulfilled. The first live HQ verification demonstrated this: the agent exited successfully but honestly reported a failed file-reading command. That result was reviewable and was marked as needing changes.

Sources: https://docs.crewai.com/en/learn/human-in-the-loop
https://docs.langchain.com/oss/javascript/langgraph/interrupts

Applied: tasks move to a review state, then the user approves or requests changes. A follow-up can use the original assignment. Review records a verdict; it does not deploy code, reverse existing edits, or grant XP automatically. This is an end-of-run review, not a mid-tool approval/resume protocol.

### 4. Queues, cancellation and budgets make autonomy controllable

AutoGen documents timeout and externally triggered termination conditions. For a local dashboard, a stop button must terminate the agent rather than just change a badge. Avoid parallel writers in the same project, and do not replay potentially destructive work automatically after a crash.

Source: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html

Applied: two concurrent task slots, one assignment per project, twenty active/queued tasks maximum, explicit cancellation, 1–30 minute time budgets, process-group termination, interrupted state after restart, and explicit new-run retries. The queue is not a recurring scheduler.

### 5. Use provider-native execution events instead of screen scraping

The Codex CLI documents non-interactive execution, saved authentication reuse and JSON Lines events for commands, file changes, messages and turn outcomes. This provides the task event stream directly. Claude exposes its own stream-json output. Ruflo can launch Claude, but coordination setup and actual agent execution must remain distinguishable.

Source: https://learn.chatgpt.com/docs/non-interactive-mode

Applied: fixed Codex/Claude/Ruflo executables; prompts over stdin for direct CLI runs; no arbitrary shell endpoint; preserved provider permissions. Codex supports read-only and project-write modes. Claude is restricted to inspection/research tools. Ruflo uses an isolated hive and a restricted Claude wrapper. Provider-reported usage is displayed where available; estimated dollar figures are not invented.

## Priorities and next extensions

Implemented first: specialist library; dispatch form; durable inbox; task filters; live events; results; review/follow-up; explicit retry; stop; time limits; reported usage; downloadable reports; Office-to-assignment navigation; connection recovery.

Good next extensions require separate implementation and testing: multi-stage missions with dependencies; mid-run user questions and permission replies; artifact inventory/diffs; provider readiness checks; project-specific knowledge packs; measured cost caps; external OpenCode/Aider event ingestion. These are not represented as working features in this release.

## Verification

The existing 81-test baseline passed before edits. Tests were added for real task lifecycle behavior using injected processes: queues, project serialization, chunked event parsing, provider failures, denied permissions, cancellation, restart recovery, custom skills, request guards, project-boundary validation, usage, timeouts and Ruflo's staged launch. Live Codex assignments were dispatched through the dashboard to verify the actual UI-to-process-to-timeline path. Claude/Ruflo successful research execution remains unverified because the account allowance was exhausted.
