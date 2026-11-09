# Runtime and Authorization Contract

## 1. Standing consent

An explicit Deepbooker book invocation that supplies `BOOK_SOURCE` is the
user's standing consent for the whole run, so the workflow does not stop to ask
again for permission it already has. Apply that standing consent
to the scope defined in SKILL.md Section 1.7. It covers source reads, public
research, local readers and scoped dependency fetches, XROS methodology and
cost decisions, task-scoped verifier execution, state/checkpoint writes,
same-book report replacement after validation, Office CLI authoring, and
local rendering. The assistant may choose the research methodology within that scope.
Record the source fingerprint, current run/session, consent date and basis,
exact commands, finite cost ceilings, and runtime outcomes before execution.
Keep this runtime record with task-owned work files; preserve the canonical
reading-state schema and the two-README/one-DOCX output contract.

This explicit user direction supersedes dependency instructions to ask again
for equivalent operational consent, including XROS cost-preview and verifier
prompts. Apply it only inside a Deepbooker run. Preserve the installed XROS
specification validator, independent search/refutation, oracle pass condition,
soundness ceiling, and provenance downgrade rules.

The grant does not establish new facts or transfer another person's consent.
Keep generated non-goals, approaches, checklists and premises
`assistant-assumed` until actual user ratification exists; preserve XROS's
result ceiling for unratified items. Derive the research question from the
book claim, record assumptions, and continue the analysis. Label proposed
human-owned tripwires and experiments as proposals without assigning a
consenting owner or activating a reminder. Keep uncertain claim statuses
uncertain even when every execution permission is granted.

Continue within current system/developer restrictions and runtime decisions.
Credentials, purchases, external uploads of private books, publishing,
third-party messages, unrelated deletion, access-control bypass, and reset
card activation remain outside this book workflow. A revoked user grant or
newly requested scope requires a new scope decision.

## 2. Runtime preflight and recovery

1. Before reading the book, run one short shell canary that reads this Skill
   and the source metadata. Check the source reader, XROS validator, project
   output directory, Word output directory, Office CLI, and renderer. Test
   writes with unique task-owned probes and remove only those probes.
2. If process creation fails with `setup refresh had errors`, identify it as
   a Windows sandbox setup failure. When the runtime exposes an escalation
   request, submit the same bounded read using `require_escalated` and a
   stated purpose. This is a runtime review request under existing consent,
   not a new chat permission question. Use the same review path for a denied
   installed reader or renderer. Respect the decision. Changing shells
   does not repair a failure before process creation.
3. If escalation succeeds, continue authorized work through permitted tool
   requests. If it fails, preserve the last valid checkpoint, finish any
   independently executable stages, and report the exact blocked operation.
   Leave Windows owner/ACL repair and Codex configuration changes to a
   separately authorized repair task; ordinary book analysis does not change
   its own execution permissions.
4. Resolve local tools by the recorded absolute path. Prefer the existing
   project Office CLI wrapper. Use the workspace dependency loader for
   document rendering runtimes instead of assuming Python, Node, or `office`
   is on PATH. Load the Office CLI and document QA Skills for their stages.
   This book workflow already authorizes temporary local QA artifacts; a
   document-template picker or a general Skill's file-consent prompt does not
   require another decision. Use the existing Section 7 Word design contract.
5. For transient network/reader errors, allow at most two retries after the
   initial attempt. Before retrying a write, inspect the recorded output and
   process state; never replay a completed mutation. Preserve required stages
   as pending when the failure remains, and continue independent work.
6. Save validated state after each bounded reading section and completed
   research batch. Before Word authoring, preserve both finalized README
   files. On continuation, match the source and edition and resume the first
   unfinished stage. After a process timeout, check whether it is still
   running before starting another writer.

## 3. Windows rendering fallback

Attempt the document Skill's bundled `render_docx.py` first and retain its
failure log. If LibreOffice is absent or that renderer cannot start, use an
already installed Microsoft Word renderer for QA: inspect the existing
`<PROJECT_ROOT>/.deepbooker-work/render-docx-with-word.ps1` when present, or
use its equivalent invisible Word COM path. Open only the task's temporary
DOCX read-only, keep `Word.Visible = false`, export every page to a task-owned
PDF, close without saving, and rasterize every PDF page with bundled PDFium
or Poppler. This is rendering only; Office CLI remains the DOCX writer.
Require exporter exit 0, a nonempty PDF, one PNG per PDF page, and visual
inspection of every page under the unchanged Word QA contract. Record the
actual renderer and its exit codes. If neither installed renderer works,
preserve the report pair and return `PARTIAL` with the recorded failure.

## 4. Permission scope and completion

Skills inherit permissions from the hosting task; a plugin has no independent
full-access switch. Read the task's effective permissions and submit permitted
runtime approval requests when required. A project permission change belongs
to a separately authorized setup task and can affect other tasks in that
project. Runtime-managed restrictions or a task's explicit permission
selection can override project defaults. Verify effective settings instead
of claiming a file edit changed an already-running task.

No configuration guarantees continuous network service, quota, available
evidence, an unlocked output file, or an uninterrupted application process.
Use the existing `PARTIAL`/`BLOCKED` rules and a concrete resume action when
those occur. Claim `COMPLETE` only after every original coverage, chapter,
XROS, transfer, paired-README, structural, and rendered-page gate passes.
