# Agency HQ × AI Company Map

Integrated on October 7, 2026. Source: [public AI Company Map](https://splashy-sedum-02b.notion.site/MAP-The-AI-Company-Map-How-to-Wire-a-Business-That-Runs-on-Agents-3b93462b4c448136bfcfe81a8dd94753).

The public page describes an architecture and 24 department functions plus a conductor. It claims a 57-agent company but does not enumerate all 57, provide their private prompts, or link downloadable agent files. Its final offer asks readers to contact the author for the actual pack. HQ's SOPs are original adaptations of those published functions; this is not an import of the private pack. The public page was saved as a local research reference, not installed as executable software.

## Coverage of every published role

| Source department / function | HQ specialist | Current execution |
| --- | --- | --- |
| Conductor | Company Conductor | Real planning assignment; transparent keyword routing suggests playbooks |
| Agentic OS: nightly consolidation | Knowledge Groundskeeper | Knowledge inspection and proposed consolidation; no nightly schedule |
| Agentic OS: health check | System Health Analyst | Project inspection and evidence-backed findings |
| Agentic OS: backup | Backup Planner | Backup/restore runbook; no uploads or scheduled backup |
| Agentic OS: cockpit runner | Queue Coordinator + HQ task runner | Queue analysis plus actual fixed-CLI dispatch, project locks, cancellation and budgets |
| Content: scout | Content Scout | Public research and cited opportunities |
| Content: teardown | Content Teardown Analyst | Evidence-based analysis and creative brief |
| Content: scriptwriter | Scriptwriter | Original scripts and production brief |
| Content: producer | Production Planner | Production package; HeyGen/ElevenLabs generation is not connected |
| Content: publisher | Publication Planner | Release package; external posting is not connected |
| Content: community | Community Response Planner | Reply drafts and flow design; ManyChat/social actions are not connected |
| Content: growth | Growth Analyst | Analysis of supplied metrics; automatic account ingestion is not connected |
| Sales: lead logger | Lead Intake Analyst | Structured supplied prospect data; no CRM writes |
| Sales: prospect prep | Prospect Researcher | Public business research and supplied relationship context |
| Sales: pipeline review | Pipeline Reviewer | Analysis of supplied pipeline exports |
| Comms: inbox triage | Inbox Triage Analyst | Triage selected message excerpts; no mailbox ingestion or sending |
| Comms: calendar prep | Meeting Prep Specialist | Brief from supplied meeting context; no calendar writes |
| Comms: router | Communication Router | Ownership and escalation recommendations |
| Finance: budget watcher | Budget Analyst | Supplied spend-versus-plan analysis; no money movement |
| Finance: contract watch | Contract Milestone Analyst | Explicit dates and obligations from supplied excerpts; owner decisions |
| Finance: P&L reporter | Business Metrics Analyst | Supplied revenue/cost report; no automatic accounting integration |
| Personal: daily planner | Daily Planner | Priorities and time-block plan |
| Personal: night review | Work Retrospective Analyst | Supplied plan-versus-result review; no nightly schedule |
| Personal: discipline tracker | Routine Reviewer | Voluntary log recap |
| Personal: health | Wellbeing Researcher | General cited research; no personalized medical decisions |

Added agency delivery department: Client Strategist, Proposal Writer, Solution Architect, Delivery Engineer, Delivery QA, and Client Handoff Writer. Combined with the original six HQ specialists, the library contains **37 built-in specialist roles**, plus up to 30 custom roles. Roles are reusable instructions, not always-running processes.

## Operating model

- COMPANY provides seven departments, six archetypes, searchable SOPs, and downloadable Markdown skill files. Each SOP includes trigger/use, inputs, ordered steps, and handoff.
- The conductor desk explains matched keywords and suggests a playbook. It is deterministic routing, not a hidden model decision. A separate Company Conductor assignment can produce a more considered plan; it does not silently launch arbitrary workers.
- Six fixed playbooks cover content, proposals, project delivery, company health, weekly business review, and meeting preparation.
- Starting a playbook submits its first real task to Codex, Claude, or Ruflo using existing account configuration. Each stage has its own budget. Delivery uses Codex project-write access; other playbooks use read-only access.
- Every stage waits for task review. After approval, **Save knowledge & send next stage** stores the approved result and submits the next task with a previous-stage excerpt. The final handoff closes the workflow.
- Rejected, failed, cancelled, or interrupted stages can be retried with additional change instructions. Stop closes a workflow and stops an active task. Restart never replays pending work.
- Shared Brain stores project-specific owner notes and approved results in the existing local SQLite database. Active notes are supplied at task launch, limited to 12 recent notes and 12,000 characters. The task records included note IDs. Edited knowledge affects future launches, not already-running prompts.
- Archive/restore is reversible. Export produces Markdown suitable for an Obsidian vault; HQ does not scan or modify a user's existing vault.
- Each approved-result note has a source task reference. Long outputs are clearly marked excerpts, and the full output stays in task history. Saving the same task twice does not duplicate its note.

## Limits that remain visible

Autonomy tags reflect the SOP's intended human involvement. All current playbooks still use result review and explicit handoff. Autonomous scheduling and external sending are not enabled. Tool requirements appear on relevant role cards. No API keys, SaaS connections, private 57-agent pack, voice/avatar assets, or external account authorizations are provided by the public map.

Localhost binding, fixed provider executables, validated project paths, existing origin/nonce guards, private-reasoning exclusion, task budgets, and concurrency limits remain in effect. The existing Jarvis service and AutoClip are untouched. No commits, deployments, messages, payments, or public posts were made.

## Verification

103 tests pass, including project knowledge isolation, archive/restore, approved-result provenance, approval-gated handoffs, retry changes, transactional rollback, restart behavior, access validation, and browser mutation guards. A real Codex verification workflow was dispatched through the COMPANY UI with the project knowledge note included. Its result remains available for owner review.
