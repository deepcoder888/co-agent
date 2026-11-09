# A-deepbooker analogy ledger

Collect the book's own analogies during the single reading pass, freeze a source-only analogy index that the generated book Agent can query, and deliver an Analogy Summary as Part III of the final Word report. Applies to STANDARD and LITERARY runs. It adds one ledger, one frozen index, one Markdown file and one Word part; `runtime.py`, `workflow.py`, `dependencies.json`, A-book, Deepbooker, the eight-file package, both Deepbooker READMEs and every existing gate stay unchanged. Deepbooker's "Helpful analogies and their limits" heading in Part I keeps its own job (analogies that explain the book) and may point to Part III.

## 1. What counts

Record an entry when the source maps relations from one domain (the vehicle) onto the subject (the target) to explain, argue or evoke:

- explicit comparisons: "X works like Y because…";
- extended metaphors that carry an argument across more than one sentence;
- parables, fables and thought experiments used as analogues;
- models borrowed from another field, such as "the market as a voting machine".

Skip idioms and dead metaphors, one-off decorative figures that map no relation, and examples of the same category (a case of X is an instance, not an analogy).

LITERARY sources: record allegory, recurring or extended metaphors and symbolic parallels that structure meaning. Record a simile only when it recurs or carries a theme.

Merge a recurring analogy into its first entry and list the later sections in `recurs_in`.

## 2. Collection during reading

1. At run start, create `combination-work/analogy-ledger.json` with `status: "COLLECTING"`. Declare `PROJECT_ROOT/book-agents/<agent>-analogies/` with the other targets.
2. After each A-book reading unit is committed, append the analogies from that unit before reading the next one. One writer owns the ledger.
3. Paraphrase target, vehicle and mapping. Quote at most a short phrase, within `evidence-and-xros.md` §5.
4. Give every entry an A-book source locator `Sxx[a,b)` that the runtime `lookup` operation can reopen, plus a human `display_locator`.
5. When the last substantive section is committed, set `status: "COMPLETE"` and `sections_scanned` to every substantive section ID, then freeze the index under §4 before any map freezes.

```json
{"schema_version": 1, "status": "COLLECTING", "sections_scanned": [],
 "entries": [{"analogy_id": "A001", "section_id": "S03", "locator": "S03[1200,1650)",
   "display_locator": "ch. 3", "speaker": "AUTHOR", "form": "ANALOGY", "target": "price volatility",
   "vehicle": "a manic-depressive business partner", "mapping": "daily quotes are offers you may ignore",
   "purpose": "ARGUE", "load_bearing": false, "claim_ids": [],
   "breakdown": "assumes the investor can wait out the mood", "breakdown_label": "INTERPRETATION",
   "recurs_in": ["S09"]}]}
```

Field values: `speaker` is `AUTHOR`, `NARRATOR`, `CHARACTER:<name>` or `QUOTED:<name>`. `form` is `ANALOGY`, `METAPHOR`, `SIMILE`, `ALLEGORY`, `PARABLE`, `THOUGHT_EXPERIMENT` or `MODEL`. `purpose` is `EXPLAIN`, `ARGUE`, `ILLUSTRATE` or `EVOKE`. `breakdown_label` is `BOOK` when the source states the limit, otherwise `INTERPRETATION` or `CRITIQUE`.

## 3. Linking during the report stage

After the bridge, set `load_bearing: true` and fill `claim_ids` for each analogy that supports a chapter core claim or a material claim. Write a breakdown for every load-bearing entry; external evidence about a breakdown goes in the summary's References, never in the sealed package or the frozen index. These fields change only `analogy-ledger.json`.

## 4. Frozen index and book-Agent queries

1. Write `book-agents/<agent>-analogies/analogy-index.json` once, from the COMPLETE ledger: `schema_version`, `source_sha256`, `sections_scanned` and, per entry, every field except `load_bearing`, `claim_ids` and any breakdown not labeled `BOOK`. Never modify it afterward; a defect needs a new index, new Agent binding and repeated Agent gates.
2. Bind its path and SHA-256 through `workflow.py bundle`; never retype the hash. Add the index to the v2 `sandbox_access` reads before the Agent is created, so the read-only Agent can open it.
3. Add these rules to the generated book Agent while A-book writes it, so NLPM, Doctor and the parent canary cover them:
   - **Binding:** `Analogy index`, `Analogy index SHA256` and the entry count, next to the source binding. Verify the hash with the other bindings. A missing file or mismatch disables analogy answers only: name the path and say so; other answers continue.
   - **Queries:** list analogies by chapter, speaker, form or vehicle domain; explain one analogy (target, vehicle, mapping, purpose, breakdown); find the analogies for a concept or term; compare two analogies; test where an analogy stops holding.
   - **Evidence:** reopen each cited entry's `locator` through the runtime `lookup` before stating BOOK content. Breakdowns labeled BOOK come from the index; any other breakdown is the Agent's own and labeled INTERPRETATION or CRITIQUE.
   - **Report links:** `<book-segment>/analogies/README.md`, when present, supplies load-bearing links and claim statuses. Label them REPORT and note that they sit outside the sealed binding.
   - **Spoilers:** in LITERARY runs, the stated-reading-position rule from `literary-mode.md` §3 also limits analogy answers.
   - **Description:** add one `<example>` showing an analogy query, such as "这本书用了哪些类比来解释 X？".
4. After the parent canary, the parent asks the generated Agent one analogy question from the index and records the answer and the source reopen in `analogy-checks.json` as `agent_analogy_query`.

## 5. Analogy Summary

Declare `<book-segment>/analogies/README.md` with the report targets at run start. Write it in the report language, after the two Deepbooker READMEs pass their content checks. Use these headings in order:

1. Title and bibliographic identity (title "Analogy Summary" in the report language)
2. Overview: totals by form, speaker and vehicle domain; a synthesis of which domains the author borrows from, which analogies carry the central argument, and which mislead most
3. Load-bearing analogies: each with target, vehicle, mapping, purpose, linked claims and their final statuses, and breakdown
4. Complete analogy table, in source order: number, locator, speaker, target, vehicle, mapping, breakdown
5. Coverage statement: `sections_scanned` against the substantive sections in `reading-state.json`
6. References

With zero entries, keep headings 1, 2, 5 and 6 and state that no qualifying analogy was found.

## 6. Word Part III and checks

1. Author Part III after Part II with the same Office CLI route: a page break, the label `Analogy Summary`, and the full content of `analogies/README.md`. Add Part III to the title-page table of contents.
2. Check Part III the way Deepbooker §7.2 checks the other parts: every heading once, in order, at a real Word heading level; its content manifest matched in order; lists, tables, links, styles and no Markdown residue. Parts I and II and their checks are unchanged.
3. v2 `render` and `review_plan` already cover every page; Part III pages need the same viewed PASS observations.
4. Before `report-validation.json`, save `combination-work/analogy-checks.json`: `ledger_complete`, `locators_present` (every entry reopens through `lookup`), `index_frozen` (index hash equals the Agent binding), `agent_analogy_query`, `table_matches_ledger` (count and order), `load_bearing_linked` (every claim ID exists in state) and `word_part_iii` (headings and manifest present). List the ledger, the index, the summary README and this check file in the validation `evidence` array.
5. A FAIL keeps the run `PARTIAL` until the defect is corrected and its dependent gates rerun.

## 7. Runs that predate the ledger

A run whose reading pass began without `analogy-ledger.json` cannot collect analogies without a second full reading. Record `status: "NOT_COLLECTED"`, write no index, omit the Agent analogy rules and Part III, report `Analogies: NOT_COLLECTED` and complete the run on its other gates. A run that began collecting but whose generated Agent was already written without the analogy rules keeps that Agent; report `Agent analogy queries: NOT_BOUND`. Reread or regenerate only when the user asks.
