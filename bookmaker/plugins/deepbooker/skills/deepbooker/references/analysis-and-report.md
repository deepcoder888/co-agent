# Analysis and Report Contract

## Contents

1. [State contract](#1-state-contract)
2. [Coverage rules](#2-coverage-rules)
3. [Chapter verification gate](#3-chapter-verification-gate)
4. [Required analysis](#4-required-analysis)
   - [Opening executive summary contract](#41-opening-executive-summary-contract)
   - [Three-concept selection and AI-era maps](#42-three-concept-selection-and-ai-era-maps)
5. [Paired README order](#5-paired-readme-order)
6. [Paired README checks](#6-paired-readme-checks)
7. [Word conversion and QA](#7-word-conversion-and-qa)

## 1. State contract

Use `schema_version: "1.0.0"`.

### 1.1 Top-level fields

Require:

- `schema_version`: exactly `1.0.0`;
- `run_id`: UUID;
- `run_status`: `IN_PROGRESS`, `PARTIAL`, `COMPLETE`, or `BLOCKED`;
- `book`: nonempty `title`, `author`, `edition`, and `language`, plus
  `publication_year` as an integer or `null`;
- `source`: `kind` as `LOCAL_FILE` or `PUBLIC_URL`, nonempty
  `canonical_locator`, `sha256` as 64 lowercase hexadecimal characters, and
  `final_url`, `etag`, and `last_modified` as strings or `null`;
- `research_cutoff`: `date` in `YYYY-MM-DD` form and a nonempty IANA
  `timezone`;
- `sources`, `sections`, `claims`, and `xros`: arrays;
- `transfer`: object using Section 1.6;
- `updated_at`: ISO-8601 timestamp with a numeric UTC offset.

### 1.2 Source registry entry

Require:

- unique `source_id`;
- `source_type`: `BOOK`, `PRIMARY`, `OFFICIAL`, `PEER_REVIEWED`,
  `SYSTEMATIC_REVIEW`, `CONSENSUS`, `STANDARD`, or `SECONDARY`;
- nonempty `citation` and `locator_or_url`;
- `accessed_at`: ISO-8601 timestamp with numeric offset;
- `content_sha256`: 64 lowercase hexadecimal characters or `null`;
- `private`: Boolean.

### 1.3 Section entry

Require:

- unique `section_id`;
- nonempty `title` and `locator`;
- `section_kind`: `FRONT_MATTER`, `PREFACE`, `INTRODUCTION`, `CHAPTER`,
  `CONCLUSION`, `APPENDIX`, `NOTES`, or `OTHER`;
- `status`: `PENDING`, `READ`, `UNREADABLE`, `MISSING`, or `EXCLUDED`;
- `reason`: string or `null`, and nonempty when status is `EXCLUDED`,
  `UNREADABLE`, or `MISSING`;
- `notes`: paraphrased notes only;
- `claim_ids`: unique claim identifiers within the entry;
- `core_claim_ids`: unique claim identifiers within the entry; require one or
  more when `section_kind` is `CHAPTER` and `status` is `READ`, otherwise allow
  an empty array;
- `updated_at`: ISO-8601 timestamp with numeric offset.

### 1.4 Claim entry

Require:

- unique `claim_id`;
- nonempty `normalized_claim`;
- `claim_type`: `FORMAL_PROOF`, `EMPIRICAL_INFERENCE`,
  `CONCEPTUAL_FRAMEWORK`, `HISTORICAL_INTERPRETATION`, `RHETORIC`, or
  `VALUE_JUDGMENT`;
- nonempty `book_locators`;
- `core_for_section_ids`: unique existing chapter section identifiers; use an
  empty array when the claim is not a chapter core viewpoint;
- `material`: Boolean;
- `workflow_status`: `IDENTIFIED`, `RESEARCHED`, `XROS_PENDING`, or
  `FINALIZED`;
- `claim_status`: `null` before `FINALIZED`; otherwise one final status from
  `evidence-and-xros.md`;
- `source_ids`: unique source identifiers within the entry;
- `xros_id`: string or `null`;
- `ceiling` and `limitations`: strings or `null`;
- `updated_at`: ISO-8601 timestamp with numeric offset.

### 1.5 XROS entry

Require:

- unique `xros_id` and an existing `claim_id`;
- `route`: `SHARPEN`, `COMPILE`, `RUN`, `REASON`, or `NONE`;
- `spec_path`: project-contained path or `null`;
- `spec_validation`: `NOT_CREATED`, `PENDING`, `VALID`, `INVALID`, or
  `BLOCKED`;
- `soundness`: `sound`, `statistical`, `none`, or `null`;
- `approval_state`: `NOT_REQUIRED`, `PENDING_COST`, `PENDING_VERIFIER`,
  `APPROVED_THIS_SESSION`, or `EXPIRED`;
- `approval_session_id`: string or `null`;
- `approval_timestamp`: ISO-8601 timestamp with numeric offset or `null`;
- `cost_preview`: object or `null`;
- `approval_history`: array;
- `verifier_command`: exact command string or `null`;
- `verifier_command_fingerprint`: 64 lowercase hexadecimal characters or
  `null`;
- `exit_code`: integer or `null`;
- `pass_condition_result`: `PASS`, `FAIL`, `NOT_RUN`, or `BLOCKED`;
- `dispatch_mode`: `INDEPENDENT_SUBAGENTS`, `SEQUENTIAL_PASSES`, or
  `NOT_RUN`;
- nonempty `outcome`;
- `ceiling` and `limitations`: strings or `null`;
- `provenance`: `user_items` and `assistant_items` as nonnegative integers,
  plus `downgrade_required` as Boolean.

### 1.6 Transfer object

Require:

- `mode`: `CENTRAL`, `CHAPTER`, or `ALL_CHAPTERS`;
- `status`: `PENDING`, `COMPLETE`, or `PARTIAL`;
- `assumption_label`: exactly `ASSUMPTION_FOR_TRANSFER`;
- `selected_viewpoint_ids`: unique existing claim identifiers whose
  `workflow_status` is `FINALIZED`;
- `applications`: array of objects satisfying
  `transfer-applications.md`, with unique `application_id` values;
- `top_five_ids`: exactly five unique existing application identifiers when
  five applications pass the admission gate, otherwise an empty array and
  `status: PARTIAL`;
- `limitations`: array of nonempty strings.

Keep each selected claim's factual `claim_status` unchanged. The assumption
label authorizes only conditional transfer analysis; it never upgrades the
claim's evidence status.

### 1.7 Cost preview and approval history

`DEEPBOOKER_RUN_AUTHORIZED` binds the user's standing operational consent to
the supplied source fingerprint, derived project outputs, and current run.
Apply `runtime-and-authorization.md` before deriving each preview and verifier
fingerprint. Record the consent basis alongside the run's runtime evidence and
record each exact fingerprint in approval history without asking again. The
record represents application of standing consent, not a manual click or
independent factual ratification.

The canonical cost preview contains:

- `claim_id`;
- `spec_path`;
- `route_count`;
- `min_rounds` and `max_rounds`;
- `verification_votes`;
- `token_ceiling`;
- `exact_verifier_command`.

Serialize the preview as UTF-8 JSON with lexicographically sorted object keys,
no insignificant whitespace, and no Unicode escaping unless required for valid
JSON. Derive `cost_preview_identifier` as the lowercase SHA-256 hex digest of
those exact serialized bytes.

Derive `verifier_command_fingerprint` as the lowercase SHA-256 hex digest of
the exact UTF-8 bytes of `verifier_command`, including every space and quote.

Each `approval_history` record requires:

- `approval_type`: `COST` or `VERIFIER`;
- `session_id`;
- `approved_at`: ISO-8601 timestamp with numeric offset;
- `approved_scope`: the matching 64-character lowercase fingerprint.

Append the `COST` history record from `DEEPBOOKER_RUN_AUTHORIZED` before
changing `approval_state` from `PENDING_COST` to `PENDING_VERIFIER`. Validate
its `approved_scope` against the current `cost_preview_identifier`.

Append the `VERIFIER` history record from `DEEPBOOKER_RUN_AUTHORIZED` before
changing `approval_state` from `PENDING_VERIFIER` to
`APPROVED_THIS_SESSION`. Validate its `approved_scope` against the current
`verifier_command_fingerprint`.

On a new task or session, preserve `approval_history`, set the prior approval
to `EXPIRED`, clear its session identifier and timestamp, then use that
invocation's `DEEPBOOKER_RUN_AUTHORIZED` record to bind the standing consent
to the current exact preview and command fingerprints. A stored command
fingerprint alone grants no new execution; recheck the current source, scope,
consent, and runtime restrictions before continuing without duplicate questions.

### 1.8 State validation

Before replacing `reading-state.json`:

1. Parse all fields and enforce types and enumerations.
2. Reject duplicate source, section, claim, and XROS identifiers.
3. Resolve every section-to-claim, claim-to-source, and claim-to-XROS reference.
4. Resolve every chapter `core_claim_ids` reference bidirectionally against the
   claim's `core_for_section_ids`. Require at least one core claim for every
   `READ` chapter and a final claim status for every referenced core claim.
5. Validate SHA-256 values, UUIDs, dates, timestamps, and canonical
   project-contained paths.
6. Recompute section coverage, substantive-chapter totals, verified-chapter
   totals, and chapter core-viewpoint totals from section and claim entries.
7. Validate the transfer object, application identifiers, admission gates,
   classification and confidence enums, score totals, and top-five tie-breaks.
8. Require a final claim status only when `workflow_status` is `FINALIZED`.
9. For Tier C, require `soundness: none`, a null verifier command and exit
   code, `pass_condition_result: NOT_RUN`, and `approval_state: NOT_REQUIRED`.
10. For pending approvals, require a null exit code and `NOT_RUN`; require a
   verifier command when approval is `PENDING_VERIFIER`.
11. For unavailable XROS, require `route: NONE`, null specification path,
   soundness, verifier command, fingerprint, and exit code,
   `spec_validation: BLOCKED`, `approval_state: NOT_REQUIRED`,
   `pass_condition_result: BLOCKED`, and `outcome: XROS_UNAVAILABLE`.
12. For a non-XROS interpretive claim, require `route: NONE`, null
    specification path, soundness, verifier command, fingerprint, and exit
    code, `spec_validation: NOT_CREATED`, `approval_state: NOT_REQUIRED`, and
    `pass_condition_result: NOT_RUN`.
13. Recompute each preview and command fingerprint, validate every approval
    history record, and require current-session identifiers and timestamps to
    match `APPROVED_THIS_SESSION`.
14. Replace the state file only after all checks pass. Otherwise preserve the
    previous valid state and return `PARTIAL`.

## 2. Coverage rules

Treat a section as substantive when removing it would omit an argument,
definition, evidence item, example needed for interpretation, conclusion,
appendix result, or substantive note. Treat title pages, blank pages,
publisher advertisements, and purely mechanical indexes as non-substantive
unless the book relies on them for meaning.

Calculate:

```text
substantive_total = READ + UNREADABLE + MISSING + justified_EXCLUDED
coverage_ratio = READ / substantive_total
gaps = UNREADABLE + MISSING
substantive_chapter_total = count(section_kind == CHAPTER and status in READ, UNREADABLE, MISSING, EXCLUDED)
verified_chapters = count(section_kind == CHAPTER and status == READ and all core_claim_ids are FINALIZED)
```

Do not count `PENDING` in a finished run. Claim complete reading only when
every substantive section is `READ` or has a recorded, justified `EXCLUDED`
status. A user-approved substantive exclusion still appears in the ledger and
prevents a cover-to-cover claim unless the user explicitly narrows the reading
scope.

## 3. Chapter verification gate

For each substantive chapter in source order:

1. Summarize the chapter's function in the book's argument in one or two
   sentences.
2. Extract one or more core viewpoints as normalized propositions. Use more
   than one only when the chapter advances independent conclusions.
3. Attach an edition locator to every proposition and distinguish the author's
   statement from the assistant's reconstruction.
4. Classify every proposition by claim type and final evidence status.
5. Route every testable proposition through XROS. Use the Tier C or
   interpretive path when no sound mechanical or statistical verifier exists.
6. Record supporting and conflicting sources, ceiling, and limitations.
7. Mark the chapter verified only when all `core_claim_ids` are finalized and
   the bidirectional state references pass.

Do not infer chapter verification from whole-book thesis verification. One
verified central thesis does not satisfy a chapter whose core viewpoint was not
separately classified.

## 4. Required analysis

Answer all nine groups:

1. Identify the broad field, precise subfield, and detailed problem category
   the author examines.
2. Map intellectual lineage: foundational or pioneering works, close peers,
   and later corrective, deeper, or more accurate works. Explain the specific
   relationship rather than returning an unsupported list.
3. State the minimum prerequisite knowledge needed to understand the book's
   valid content. Explain useful metaphors or analogies and name where each
   analogy fails.
4. Explain the chapter progression, dependencies among claims, rhetorical
   structure, and evidentiary structure. Include the chapter-verification
   matrix required by Section 3.
5. Identify the central proofs or arguments. Classify each as formal proof,
   empirical inference, conceptual framework, historical interpretation,
   rhetoric, or value judgment, and route every material testable claim through
   XROS.
6. Explain which modern problems the book addresses. Classify current claim
   status and reserve `FALSIFIED` for evidence meeting the rules in
   `evidence-and-xros.md`.
7. For claims that survive verification, identify current best practices and
   concrete evaluation or decision criteria. Mark evidence-constrained
   brainstorming as `HYPOTHESIS` or `PROPOSAL`.
8. Assess transfer to other domains, life, and work under the explicit
   `ASSUMPTION_FOR_TRANSFER` label. Follow `transfer-applications.md` for the
   admission gate, table fields, classifications, confidence rubric, ranking,
   and five experiments.
9. Produce the report with an executive summary and table of contents at the
   start and References as the final section.

### 4.1 Opening executive summary contract

Apply this contract to the `Executive summary` near the beginning of both
README files. Each summary must stand on its own for a reader who has not read
the book. The Book Analysis README carries the full account. The Chapter
Verification and Transfer README restates the same account compactly before
reporting chapter-verification and transfer results.

Use five visible lead-ins and cover all five elements:

1. **Book content:** State the subject, scope, main problem, major bodies of
   material, and the conclusion the book seeks to establish. Describe the
   whole-book progression rather than reproducing the table of contents.
2. **Author's core viewpoints:** State the central thesis and the major claims
   that support it. Explain how those claims depend on or reinforce one
   another.
3. **Core premises and assumptions:** Identify the factual, conceptual, and
   value premises on which the argument depends. Say which premises the author
   states and which are the assistant's reconstruction of an implicit dependency.
4. **Core argument methods:** Name the evidence and reasoning methods used,
   such as cases, data, experiments, historical comparison, causal analysis,
   conceptual distinctions, counterexamples, or value argument. Explain the
   role each major method plays in supporting the thesis.
5. **Argument structure:** Trace the path from the opening problem and premises
   through the major argumentative stages to the conclusion. Name dependencies
   among stages and distinguish evidentiary support from rhetorical sequencing.

For both summaries:

- Ground every book-specific statement in the supplied edition. Attach a page,
  chapter, section, or EPUB locator to each of the five elements; use multiple
  locators for a synthesis that spans chapters.
- Use the existing author-statement, interpretation, inference, claim-status,
  and evidence distinctions. Keep the author's position separate from the assistant's
  reconstruction and reserve extended critique for later sections.
- Define a term on first use when the remaining argument depends on that term.
- Write in the report language as connected explanatory prose. Use the five
  lead-ins for navigation, and give each lead-in the propositions and logical
  links needed to answer its matching acceptance question below.
- Name source gaps, unreadable sections, and unresolved reconstruction limits
  inside the summary. A gap that prevents any of the five elements from being
  established makes that README check `FAIL` and the run `PARTIAL`.

Before finalizing each README, verify that its summary lets a first-time reader
answer all five questions without consulting later sections:

1. What does the book cover and what problem does it address?
2. What is the author's central thesis and which major claims support it?
3. Which explicit or reconstructed premises does the argument require?
4. Which evidence and reasoning methods support the major claims?
5. How does the argument progress from its premises to its conclusion?

Record `PASS` only when all five answers are explicit, source-grounded, and
mutually consistent. Record `FAIL` for the README and return `PARTIAL` when one
or more answers is absent, unsupported, or contradicted by the coverage ledger.

### 4.2 Three-concept selection and AI-era maps

After the nine groups are complete, build a candidate list from concepts that
the supplied edition names, defines, or uses as a recurring structural unit.
Require at least one edition locator for every candidate. Score each candidate
from 0 to 2 on all four dimensions:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Thesis centrality | Incidental to the thesis | Supports one major claim | Load-bearing for the central conclusion |
| Explanatory leverage | Explains one local point | Connects multiple claims in one section | Connects claims across multiple sections |
| Recurrence or structural importance | Appears once without structural work | Recurs or structures one major section | Recurs and structures multiple major sections |
| Reader utility | Optional for later understanding | Clarifies later content | Required to understand later arguments or decisions |

Sum the four scores to a maximum of 8. Select exactly the three highest totals.
Break ties by thesis centrality, then explanatory leverage, then first source
appearance. For each selected concept, report the four component scores, total,
edition locators, and one sentence explaining why it outranks the nearest
excluded candidate.

Create one nested `$concept-ai-era` map for each selected concept. Use the
report language and retain all ten current sections: Essence, World Model,
Concept Map, Decision Map, Search Space Expansion, Ecosystem, Transferable
Principles, Minimum Mental Model, Common Misconceptions, and Summary. Use the
concept title as a level-three heading and the ten section titles as level-four
headings so all three maps remain inside one top-level report section. Preserve
the installed Skill's tables, 10-20-item Minimum Mental Model, causal focus,
stable-versus-changing distinction, quality checks, and final contrast
sentence. Place citations beside current or drift-prone claims and consolidate
their bibliographic entries in the report's final References section.

## 5. Paired README order

Create both Markdown artifacts from the same validated state and source
registry. Each file must remain independently readable and end with its own
References section.

### 5.1 Book Analysis README

Write to:

```text
<PROJECT_ROOT>/<book-segment>/eat-the-book/README.md
```

Use these headings in this order:

1. Title and bibliographic identity
2. Executive summary
3. Table of contents
4. Reading scope and coverage statement
5. Field and precise subfield
6. Core concepts and prerequisite knowledge
7. Helpful analogies and their limits
8. Argument and chapter architecture
9. Foundational, related, corrective, and deeper works
10. Core proof and argument analysis
11. Modern problems addressed
12. Falsified, disputed, and unverified claims
13. Current best practices and evaluation standards
14. Limitations and unresolved questions
15. Coverage ledger
16. Three Most Important Concepts - AI-Era Learning Maps
17. References

### 5.2 Chapter Verification and Transfer README

Write to:

```text
<PROJECT_ROOT>/<book-segment>/chapter-transfer/README.md
```

Use these headings in this order:

1. Title and bibliographic identity
2. Executive summary
3. Table of contents
4. Chapter-by-chapter verification matrix
5. XROS claim-verification matrix
6. Conditional transfer premise and mechanism
7. Cross-domain application map
8. Five highest-ranked daily experiments
9. Limitations and unresolved questions
10. Coverage reconciliation
11. References

## 6. Paired README checks

Before completion:

1. Confirm both files exist, are nonempty UTF-8 Markdown, and use the exact
   canonical paths from Section 5.
2. Confirm each executive summary passes Section 4.1, each executive summary
   and table of contents precedes analysis, and each References section is the
   final top-level section in its file.
3. Place citations adjacent to every supported external claim and give the
   analyzed edition a reliable page, chapter, section, or EPUB locator for each
   book-specific claim.
4. In the Book Analysis README, explain why each related book is foundational,
   parallel, corrective, or deeper and give every analogy an explicit breakdown
   boundary.
5. Reconcile coverage counts in both files with `reading-state.json` and the
   source structure. Reconcile all nine analysis groups across the two files;
   count each required group at least once and identify its owning heading.
6. Show each material claim's status and evidence sources in the file that owns
   its full analysis.
7. In the Chapter Verification and Transfer README, show every substantive
   chapter exactly once in the chapter-verification matrix. Require nonempty
   core viewpoints, locators, claim types, final statuses, ceilings, and
   limitations; reconcile all chapter counts with state.
8. Show each XROS claim's tier, route, outcome, ceiling, approval state, and
   limitations without treating a pending approval as a failed claim.
9. Require the exact transfer-assumption label, every application field,
   classification and confidence basis, application score, deterministic
   ranking, and five experiment records from `transfer-applications.md`.
10. In the Book Analysis README, require exactly three selected concepts, four
    component scores and one total per concept, edition locators, and one
    comparative rationale per concept.
11. Require exactly ten ordered AI-era subsections under each selected concept;
    require all thirty subsections to precede the Book Analysis README's final
    References section.
12. Build a content manifest for each README from every nonempty paragraph,
    heading, list item, table cell, link label, citation locator, and visible
    code line. Store the two manifests in memory for Word fidelity validation;
    write no third combined Markdown report.
13. Record `book_analysis`, `chapter_transfer`, and `five_questions` summary
    checks as `PASS` or `FAIL`. Require `five_questions: PASS` only when both
    README summaries answer all five Section 4.1 questions; a failed summary
    check makes the run `PARTIAL`.

## 7. Word conversion and QA

### 7.1 Conversion command and write safety

1. Select the first supported mode using the preflighted command's local help:
   - `MULTI_INPUT`: two ordered Markdown inputs to one DOCX;
   - `OFFICE_TWO_STAGE`: Markdown-to-DOCX for each input, then a documented
     DOCX concatenation operation; template-data `merge` is not concatenation;
   - `OFFICE_AUTHORED`: when native conversion is absent, use Office CLI
     `create`, schema-checked `batch`/`add`/`set`, and its documented OOXML
     operations to author both complete README manifests into one DOCX in
     order. Reuse a project builder only after inspecting its parameters and
     content mapping; supply this book's paths, title, author, edition, and
     date explicitly. Preserve paragraphs, headings, lists, tables, links,
     citations, and code lines without summarizing or dropping content.
   In every mode Office CLI performs every DOCX mutation. A parser may prepare
   command data but may not become a substitute DOCX writer.
2. Resolve the final path exactly as:

   ```text
   <DEEPBOOKER_HOME>\word\<book-segment>-deepbooker.docx
   ```

   Create `<DEEPBOOKER_HOME>\word` when absent. Resolve the canonical
   path and require containment under that exact directory.
3. Preserve this source order in every mode:
   - Part I: `<book-segment>/eat-the-book/README.md`;
   - Part II: `<book-segment>/chapter-transfer/README.md`.
4. Build argument arrays from the documented Office CLI syntax. Treat source
   paths, book text, and metadata as data, never as command fragments. Use no
   shell concatenation, third Markdown file, or non-Office converter.
5. Create task-owned temporary conversion files inside a unique directory
   under `<DEEPBOOKER_HOME>\word`. For `OFFICE_TWO_STAGE`, require exit
   code 0 and a nonempty DOCX from both conversions before invoking the Office
   CLI merge command. For `OFFICE_AUTHORED`, use a new temporary DOCX, require
   exit code 0 from create and every mutation, and flush/close any resident
   before another tool reads the file.
6. Record the resolved executable path, exposed version, mode, every exact
   argument array, each exit code, and every temporary output path. Require
   exit code 0 and a nonempty combined temporary DOCX before structural
   validation. In `OFFICE_AUTHORED`, `convert_exit` is the authoring result and
   `merge_exit` is `NOT_RUN`; record the selected mode so no merge is implied.
7. Replace an existing final DOCX only when its provenance matches the same
   source fingerprint and edition. Preserve an existing DOCX with mismatched or
   missing provenance and use a collision-safe sibling path. Replace the
   selected final path only after all structural and visual checks pass.

### 7.2 Structural fidelity

Open the temporary DOCX as an OOXML package and require all checks below:

1. The package, relationships, and main document part parse without error.
2. The document starts with a title page containing the book title, author,
   edition, `Deepbooker`, and generation date, followed by a Word table of
   contents that lists both parts and their heading levels.
3. Part I is labeled `Book Analysis`; Part II is labeled `Chapter Verification
   and Transfer`; a page break precedes Part II.
4. Every Markdown heading from each input appears once inside its owning part,
   in source order, and maps to a real Word heading level. The document contains
   the chapter-verification and three transfer headings, exactly three
   selected-concept headings, and ten ordered AI-era subsection headings beneath
   each selected concept.
5. Each pre-conversion content manifest from Section 6 matches its Word part in
   source order after whitespace normalization. Content from Part I precedes
   every content-manifest item from Part II.
6. Markdown lists map to Word numbering definitions; Markdown tables map to
   Word tables with the same row count, column count, and cell text; links map
   to visible labels plus hyperlink relationships or preserved visible URLs.
7. Body text uses a Word style between 10.5 and 12 points with line spacing
   between 1.15 and 1.5. Page margins are between 2.0 and 2.54 centimeters.
   Heading 1 is at least 16 points; Heading 2 is at least 13 points and smaller
   than Heading 1; body text is smaller than Heading 2.
8. Page numbers appear after the title page. Tables repeat header rows across
   page breaks when they occupy more than one page.
9. No raw Markdown heading markers, table delimiters, or fenced-code markers
   remain as accidental body text.

### 7.3 Rendered-page quality

Load `documents:documents` for validation after Office CLI conversion. Render
every DOCX page to PNG, inspect every page at 100% zoom, and require:

- no clipped, overlapping, or missing text;
- no broken glyphs, orphaned headings, or empty content pages;
- a readable title and heading hierarchy with consistent typography and
  paragraph spacing;
- lists with aligned wrapped lines;
- tables with readable column widths, wrapped cell text, visible headers, and
  no content pressed against borders;
- page breaks that keep headings with following content and avoid unexplained
  large blank areas;
- a visible Part I/Part II hierarchy and a page break between the two reports;
- all three concept maps visually distinguishable inside Part I;
- the chapter matrix, application map, and experiment table legible in Part II.

When a check fails, use only styling, template, merge, or layout options
documented by the resolved Office CLI and reconvert from the unchanged two
finalized README files. Allow at most two remediation conversions after the
first attempt. Repeat all structural and rendered-page checks after each
attempt.

### 7.4 Completion and failure

After all checks pass, atomically replace the selected same-book
`<DEEPBOOKER_HOME>\word\<book-segment>-deepbooker.docx` path with the
validated temporary file and remove only task-owned temporary conversion and
render artifacts. If command discovery, either conversion, merge, structural
validation, rendering, or visual inspection fails, preserve both finalized
README files, preserve any pre-existing DOCX, return `PARTIAL`, set the failed
`OFFICE_CLI` evidence field, and name one concrete recovery action.
