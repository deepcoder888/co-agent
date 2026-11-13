# A-deepbooker protocol v1

## Authority and components
A source-bound combination invocation authorizes both declared delivery branches and their working files. Inspect/review/preflight requests remain read-only. Existing spending authority applies; additional unapproved charges require a decision.
Inherit the caller's actual filesystem/approval settings; use live web in the report stage. Check write access to exact Agent and report targets before long reading. Generated book Agents remain read-only.
Reuse A-book v3 without changing its helper bytes or old profiles. Its no-research/no-Word rule applies to the creation stage. The report stage then uses Deepbooker's contracts. Keep one writer for each run; the parent canary is a handoff after sealing.
Use runtime.py alongside this file with Python 3.11+: python -X utf8 -B runtime.py --request absolute-request.json. --request - reads JSON stdin. Exit 0 means an operation succeeded, not a book completed.
dependencies.json records the reviewed dependency hashes. The existing Reading/.deepbooker-work/documents-runtime/Scripts/python.exe supplies PDF dependencies.

## 1. Preflight and targets
1. Call {"op":"dependencies","project_root":"<DEEPBOOKER_HOME>"}. Read the returned Deepbooker files at their resolved locations. Resolution checks project plugin, the Reading installation, then installed reading cache. A dependency hash change requires review; preserve sealed manifests.
2. Call {"op":"inspect","source":"absolute/book.pdf"}. Supported containers: EPUB, text PDF, DOCX, UTF-8 TXT/MD/HTML/HTM. Reject extension/container mismatch and encryption. Inventory text availability and visual review items; extraction counts never mean reading.
3. Load the source adapter and pdf:pdf or documents:documents for those formats. Reconcile all PDF pages, DOCX body/tables/notes and other substantive parts, EPUB spine/navigation/images. A local HTML with linked missing chapters is incomplete.
4. Resolve TITLE, AUTHOR, EDITION, LANGUAGE, publication year (null if unknown), AGENT_NAME and PROJECT_ROOT from user/source evidence. Default knowledge: PROJECT_ROOT/book-agents/<agent>-knowledge; work: sibling <agent>-knowledge.abook-work; Agent: ~/.codex/agents/<agent>.toml. Use safe filenames, absent new targets and canonical non-overlapping paths.
5. A PDF reading copy uses sibling <agent>-source, outside the eight-file package and A-book work. Default combination work: PROJECT_ROOT/.a-deepbooker-work/<agent>.
6. Follow Deepbooker's sanitization/collision contract for <book-segment>/reading-state.json, eat-the-book/README.md and chapter-transfer/README.md. Final Word: <DEEPBOOKER_HOME>/word/<book-segment>-deepbooker.docx. Preserve unrelated outputs; resume only matching identities.
7. Disclose targets once, then proceed within authorization. Retain source-review.json, bridge request/evidence, combination.json, report-validation.json and combination-check.json in combination work. These are internal records, not extra book deliverables.

## Author-derived Agent names
Choose the name before declaring run targets. This rule overrides A-book's general naming default for combined runs.
1. Verify the author's identity from this edition's title/copyright pages. Distinguish authors from translators/editors and foreign names in Chinese translation from Chinese personal names. Use a user-selected author; otherwise the first credited author, recording all coauthors and the selection.
2. For a non-Chinese personal name, select one verified surname or given name in the author's original spelling; prefer the surname, then given-name alternatives in source order. Use a documented Latin transliteration when the script is not Latin. Do not invent an original spelling from a Chinese translation; consult authoritative bibliographic evidence only to resolve identity, outside the source-only A-book stage, or report the unresolved identity.
3. For a Chinese personal name of more than two Han characters, take its final two characters; for exactly two, take both. Join their verified Mandarin Hanyu Pinyin syllables without spaces, tones or separators, capitalize the first letter (张三丰 -> Sanfeng; 李白 -> Libai; 欧阳修 -> Yangxiu). Use v for ü. Verify polyphonic name readings; do not guess. A one-character name or unresolved pronunciation requires the missing identity information.
4. Normalize the display name to Unicode NFC; the filename is its lowercase safe stem. Compare NFC/casefold names after stripping an optional leading hyphen, against both TOML name fields and filename stems in the user Agent directory, every applicable project/ancestor .codex/agents directory, any configured Agent registrations and the current runtime catalog. Treat malformed/unreadable catalog entries as an unresolved collision check, not free names.
5. If a foreign author's preferred surname is occupied, try their remaining verified given/surname candidates. If all candidates are occupied, or the Chinese Pinyin base is occupied, retain the chosen author-derived base with the smallest unused numeric suffix starting at 2, e.g. Gordon2 or Libai2. This suffix only disambiguates the author name; never replace or modify an existing Agent.
6. Record author identity evidence, original name, name category, candidates/Pinyin, collision scan, chosen display name and target path in combination-work/author-naming.json. Check the catalog again immediately before committing the generated Agent. A newly occupied name requires a new available candidate and consistent regenerated path bindings; never overwrite. For a resumed run, reuse its recorded name only after verifying that the existing target is the exact Agent bound by that run's manifest.

## 2. Source preparation and coverage
Native supported sources go directly to A-book when its extractor represents all included content. Preserve original hashes and locators.
For PDF pages without extractable text, render and inspect the original first. Use installed OCR only after its language/probe checks; otherwise transcribe only wholly legible substantive content. Unverified pages remain blocked-source. Do not install OCR implicitly.
After visual review, prepare a copy:
{"op":"prepare_pdf","source":"absolute/original.pdf","output_dir":"absolute/author-source","page_overrides":{"2":{"kind":"blank","text":"","evidence":"Original rendered page 2 is blank."},"3":{"kind":"transcription","text":"Complete reviewed transcription.","evidence":"Original page 3 checked against transcript."}}}
Every textless page requires an override. blank means a confirmed blank page; praise/advertisements retain their visible text and are later excluded. Overrides may repair faulty extraction on any page. Figure-only substantive pages require a description/transcription plus original-image locator and uncertainty.
The command creates reading-copy.epub and source-provenance.json in an absent directory: one spine item per original page, original/copy hashes and extraction/transcription methods. Keep the original for figure/OCR questions. No format-disguising rename.
For a copy, A-book BOOK_SOURCE is the EPUB. Before QA, put original path/hash, provenance path/hash and page mapping in the knowledge README/maps; require generated Agents to verify original and copy. Deepbooker's book fingerprint is the original; register the copy as a second source. A transcription is derived evidence, not exact printed wording.

After source inspection, write:
{"source_sha256":"A-book source hash","original_sha256":"original hash, same for native","inventory_reconciled":true,"figures_and_tables_checked":true,"notes_checked":true,"exclusions_checked":true,"unresolved_gaps":[],"evidence":[{"locator":"original page or EPUB entry","finding":"actual inspection and limits"}]}
Require at least one evidence item and cover each flagged source-review item. These are accountable model judgments, not proof of understanding. Preserve extraction failures as gaps. The bridge rejects unresolved gaps or wrong hashes.

Use A-book's scope in both branches: preserve substantive author/third-party prefaces, arguments, notes, appendices and figures. Exclude only classified praise/reviews/promotion/non-substantive acknowledgments/navigation/publication metadata/citation-only bibliography. Keep bibliography locators and mixed-entry exact excluded ranges. Complete means all included substantive material with disclosed exclusions.

## 3. Reading and Agent stage
Read a-book.toml and protocol-v3.md and execute their creation operations. Use the bound runtime, <=6,000-code-point reading units, ordered commitments, immutable IDs and original run identity. Initial full reading happens once; QA and disputes use source reopens.
Before maps freeze, rank source concepts with Deepbooker's four 0..2 criteria/tie-breaks. Use the same three concepts in compact maps and expanded reports.
Retain GROUNDED_QA_V3: >=18/20, zero critical errors, one local repair, closed_book_mastery=NOT_PERFORMED. Finish eight files, NLPM >=90, TOML and real Doctor checks.
The parent invokes the fresh named book Agent and records independent identity plus first/middle/last source, concept and bounded action checks. A child continues report work while that canary is pending and returns its exact handoff. It never self-certifies the canary.

## 3a. Pre-seal audit repair (combined runs only)
Audit source wording and locators before freezing QA. If a later map audit finds a concrete error after round 1 PASSED_GROUNDED but before package audit/sealing/Agent creation, the combined helper provides begin_audit_repair. This is an explicit extension to the unchanged base runtime, not a historical failed answer or a whole-test restart.
Use only after the prior writer is terminal and current state hash/revision match. The original creation-and-fix authorization covers this bounded corrective work; record its actual basis. Do not ask again solely because the original QA passed.
Request schema:
{"op":"begin_audit_repair","work_dir":"absolute/author-knowledge.abook-work","expected_revision":94,"expected_state_sha256":"current state hash","unit_id":"post-pass-map-audit","authorization":"Actual user creation/fix instruction","issues":[{"question_id":"Q04","reason":"Concrete source-backed map defect","map_files":["retrieval-bank.md"],"additional_evidence":[]}]}
Each issue targets an existing question and only its frozen affected maps. additional_evidence may append valid included source windows of the same {section_id,locator} shape as frozen evidence; keep all original windows and a maximum of four total. Criteria, wording, question kind and evidence class cannot change.
The operation locks and journals the transition, retaining the entire original passing assessment, original questions/hash, map hashes, finding scope and extension hash. Existing base failed_ids is used only as the audit-affected repair target set; audit_repair explicitly records this distinction. No historical verdict is falsified.
Use the original base commit_files API to correct only the declared maps. Then record repair-complete with these audit-affected IDs and maps_corrected reasons, run start_retest, and answer/verify the selected affected questions plus three deterministically selected previously passed questions. Retain every other answer/verdict. The original one-repair allowance is shared with this route; no third round or repeated audit repair.
Call {"op":"audit_repair_status","work_dir":"absolute/author-knowledge.abook-work"} after retesting and before package audit. It must report VALID and PASSED_GROUNDED. Failed retesting or undeclared changes remain blocked; never seal around them. Archive the original history in WORK_DIR; final package ledger reports round 2 and the final question hash. Report the audit correction separately from the original QA result.
After this gate, continue package audit, sealing, Agent validation, bridge, research and document production. The bridge and combination check validate the repair record and preserved history. Keep the base A-book helper, protocol, old profiles and source bytes unchanged.

## 4. Bridge
After package sealing, prepare:
{
 "op":"bridge","abook_work":"absolute/author-knowledge.abook-work",
 "project_root":"absolute/project","report_dir":"absolute/project/book-segment",
 "word_path":"<DEEPBOOKER_HOME>/word/book-segment-deepbooker.docx",
 "combination_work":"absolute/project/.a-deepbooker-work/author",
 "source_review":"absolute/source-review.json","provenance":null,
 "book":{"title":"Title","author":"Author","edition":"Exact edition","language":"en","publication_year":2020},
 "research_cutoff":{"date":"YYYY-MM-DD","timezone":"<IANA time zone of this computer>"},
 "sections":[{"section_id":"S01","section_kind":"CHAPTER","core_claims":[
 {"claim_id":"C01","normalized_claim":"Source-grounded proposition.","claim_type":"EMPIRICAL_INFERENCE","material":true}]}]
}
Map every A-book section exactly once in source order, including exclusions. Use Deepbooker section kinds; each READ CHAPTER needs an actual core proposition. Other included sections may have zero or more. Claims have unique IDs and one of its six claim types. For a copy, provenance is the PDF source-provenance.json path.
The helper verifies state, sealed files, all source receipts and source review; it writes canonical reading-state.json with READ/EXCLUDED sections and IDENTIFIED claims with null statuses. Store mixed exclusions, source receipts and their hashes in bridge-evidence.json. Importing reading never finalizes an external claim.
combination.json binds outputs, sources, A-book run, review and dependency hashes. Repeated identical bridges resume without overwriting research. Mismatched bindings reject. Interrupted seed creation resumes only when the existing bytes equal the deterministic expected seed. Validate state with the existing validate-reading-state.ps1.

## 5. Research and deliverables
Read the resolved Deepbooker SKILL.md and its runtime-and-authorization, analysis-and-report, evidence-and-xros and transfer-applications references at stage boundaries. The source-bound combination request supplies its scoped operational authorization; record that actual basis.
Replace only its full-reading loop with the verified bridge. Reconcile inventory and every chapter claim; keep BOOK fidelity and external truth checks distinct.
Complete nine analysis groups, XROS for required testable chapter/material claims, preserved Tier C ceilings, three concept-ai-era maps, conditional transfer analysis and five admitted experiments. Compact A-book maps cannot replace these analyses.
Store dated EXTERNAL/CRITIQUE findings in reports; preserve the sealed source package. Failed tools and unavailable evidence remain pending.
Produce two README reports, one final combined DOCX and reading-state.json. Office CLI authors Word; documents:documents checks structure and every rendered page. Use the existing windowless render fallback; record renderer exit and inspected page count.

## 6. Completion and resume
After real validation, save report-validation.json:
{
 "source_sha256":"original hash",
 "checks":{"state":true,"coverage":true,"chapters":true,"xros":true,"analysis":true,"concepts":true,"transfer":true,"readmes":true,"word_structure":true,"word_visual":true},
 "artifacts":{"book_report":"hash","transfer_report":"hash","word":"hash"},
 "state_sha256":"reading-state hash",
 "evidence":[{"path":"absolute project validator or QA evidence","sha256":"hash"}],
 "render":{"exit_code":0,"pages":3,"inspected_pages":3}
}
Booleans record actual checks; require source citations, no missing included content, finalized claims/XROS, concept and transfer gates. Evidence files must exist within task project paths.
Run {"op":"check","combination":"absolute/combination.json","validation":"absolute/report-validation.json"} and save its result as combination-check.json. The helper checks identity/hashes and both completion states; pending gates yield PARTIAL. It cannot mechanically prove semantic understanding or honest visual judgment.
Resume from A-book state, reading-state.json and combination.json without resetting either branch. Word failure retains completed Agent/research work. Missing canary retains overall PARTIAL. Legacy v2 is not imported by this v3 bridge; preserve its history.
Tests prove reader/mapping/hash/collision/gate behavior. A short runtime canary proves discovery and bounded execution. Neither is a completed full-book run; report those levels separately.
