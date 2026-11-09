# A-deepbooker literary mode

Overlay for combined runs whose source is imaginative literature. It changes what the reading, maps, generated Agent and reports focus on. It changes no tool, schema or gate: `runtime.py`, `workflow.py`, `dependencies.json`, A-book, Deepbooker, the state validator and every v1/v2 acceptance gate stay byte-identical and mandatory. For a STANDARD source only §1 applies.

## 1. Classification gate

Classify during v2 preflight step 1, after identifying the edition and before declaring targets. Save `combination-work/genre-classification.json`:

```json
{"classification": "LITERARY", "form": "NOVEL", "basis": "SOURCE_EVIDENCE", "evidence": [{"locator": "copyright page", "finding": "CIP class I247.5; title page labels it 长篇小说"}]}
```

- `classification`: `LITERARY`, `STANDARD` or `UNRESOLVED`. `form` (LITERARY only): `NOVEL`, `NOVELLA`, `SHORT_STORIES`, `POETRY`, `DRAMA` or `LITERARY_PROSE`. `basis`: `SOURCE_EVIDENCE` or `USER_CHOICE`.
- LITERARY when the substantive body is fiction, poetry, drama or a literary-prose collection valued for its art. Accept two or more agreeing signals: a genre label on the title, cover or copyright page (长篇小说, 短篇小说集, 诗集, 剧本, "A Novel"); Chinese CIP class I outside I0 literary theory; Library of Congress PN–PZ outside criticism; BISAC FIC, POE or DRA; and a body built from scenes, characters and dialogue, verse lines or stage directions.
- STANDARD for biography, memoir, autobiography, history, literary criticism or theory, writing guides and books about myth or literature. They argue propositions and run the unchanged workflow.
- The user's explicit choice overrides the evidence; record it as `USER_CHOICE`.
- UNRESOLVED when the signals conflict or only one exists. Report the evidence and ask the user once before the reading pass. When no user can answer, return the question to the parent and stop as `BLOCKED`; never guess the mode.

## 2. Focus, in priority order

1. **Text facts.** Events, who did what, in which order, with a locator for every event. Invented plot detail is the main failure for fiction, so a BOOK answer about events needs its locator.
2. **Characters and relationships.** Identity, aliases and forms of address, kinship and rank, motives, arcs and changes in relationships. Chinese classics often give one person two or more names; register every one.
3. **Narrative craft.** Point of view and narrator reliability, structure and time order, foreshadowing and payoff, motifs and symbols, dialogue and style, and genre conventions.
4. **Themes as open questions.** State each theme with its textual evidence. Attribute competing readings to their critics and label them INTERPRETATION or EXTERNAL; a reading is never `VERIFIED`.
5. **Context.** Author biography, period, textual history (manuscripts, editions, continuations, disputed authorship) and translation. This is the only layer that receives external factual verification.
6. **Spoiler boundary.** Keep source order in every map so the generated Agent can answer from a stated reading position.

Keep the distinctions throughout: a character's or narrator's statement is not the author's view, and a character's choice is not the author's recommendation.

## 3. A-book stage mapping

Run A-book v3 unchanged: bounded windows, receipts, eight files, GROUNDED_QA_V3 at 18/20 or better with zero critical errors, NLPM, Doctor and the parent canary. Treat narrative chapters, embedded poems, epigraphs and a translator's or editor's critical preface as substantive; exclude blurbs and promotion as before. Fill the six Markdown maps this way:

| File | Literary content |
|---|---|
| chapter-map.md | Per chapter in source order: events (paraphrased), characters present, narrative function (setup, complication, turn, climax, resolution), motifs and locators. |
| concept-map.md | Exactly three core elements chosen from themes, motifs, central characters or narrative devices, scored as in §5. |
| first-principles.md | Rules of the story world (setting, social order, beliefs and values the characters hold), the central conflict and the causal engine of the plot. Label author design versus reader inference. |
| retrieval-bank.md | Q01–Q20 with all five kinds: definition = identity of a character, term or place; dependency = which event enables which; mechanism = how a device creates its effect or how a character change happens; boundary = what the text leaves open, plus edition differences; action = a reading, discussion or writing exercise. Make at least eight questions text-fact questions, spread across the first, middle and last thirds. |
| action-map.md | Close-reading tasks, re-reading paths, discussion questions, imitation-writing exercises and perspective-taking reflections, each labeled BOOK or adaptation, each with a time box and stop condition. |
| README.md | Add `Form: <form>` and the spoiler policy below. |

Write these rules into the generated book Agent's instructions:

- When the user states a reading position ("我读到第30回"), answer only from sections up to that position and ask before revealing later events. Without a stated position, answer from the whole work.
- Label BOOK (what the text states happens), INTERPRETATION, INFERENCE (implied but unstated), CRITIQUE and EXTERNAL.
- Attribute every statement to its speaker: author, narrator or named character.
- Paraphrase. Quote at most a short phrase per answer and never reconstruct a passage, chapter or complete poem from a copyrighted edition.

## 4. Bridge and reading-state mapping

Use the existing schema values only:

- `section_kind`: `CHAPTER` for each chapter, 回, story, poem group or act, following the edition's own divisions.
- Each READ chapter gets one core claim stating its function in the work, for example "第5回以判词和曲文预示主要女性人物的结局，为全书建立命运框架". Use `RHETORIC` for how the text structures or produces an effect and `VALUE_JUDGMENT` for a moral or thematic reading.
- Context claims use `HISTORICAL_INTERPRETATION` or `EMPIRICAL_INFERENCE` and follow `evidence-and-xros.md` unchanged.
- Mark a claim `material` when it changes the reading of the whole work, such as disputed authorship of a continuation.
- Interpretive core claims take XROS route `NONE` on the Tier C path and finalize as `NON_FALSIFIABLE_OR_INTERPRETIVE`. Their `ceiling` names the textual evidence and their `limitations` name the strongest competing reading.

## 5. Report mapping

Keep every Deepbooker heading, its order and every gate. Fill them as follows.

| Deepbooker item | Literary content |
|---|---|
| Executive summary lead-ins (labels unchanged) | Book content = story, setting and scope; Author's core viewpoints = central themes and the questions the work raises; Core premises = world rules and value premises; Core argument methods = narrative methods; Argument structure = arc from the opening situation through the turns to the ending. |
| Field and precise subfield | Literary tradition, genre, period and movement. |
| Core concepts and prerequisite knowledge | The three core elements plus the history, customs, naming systems and earlier works a reader needs. |
| Argument and chapter architecture | Plot and narrative architecture with the chapter matrix. |
| Foundational, related, corrective and deeper works | Influences, peers, works it shaped, major criticism and annotated editions. |
| Core proof and argument analysis | Craft analysis and the interpretive arguments with textual evidence. |
| Modern problems addressed | Lasting human questions the work illuminates, labeled INTERPRETATION. |
| Falsified, disputed and unverified claims | Contested context facts and contested readings. |
| Current best practices and evaluation standards | Recommended editions and translations, and the standards for judging a reading: textual support, coherence and accounting for counter-evidence. |
| Three-concept selection | Same four 0–2 criteria applied to the elements: centrality to the main conflict or theme, events explained across sections, recurrence, and need for later understanding. |
| AI-era maps | Keep all ten `$concept-ai-era` sections. Decision Map = the interpretive choices a reader makes; Search Space Expansion = alternative readings. |
| Transfer and five experiments | `ASSUMPTION_FOR_TRANSFER` applies to an interpretive viewpoint. Experiments are low-risk reading, writing, discussion or perspective-taking tasks. |

## 6. Literary checks

Before `report-validation.json`, save `combination-work/literary-checks.json` with a PASS or FAIL and evidence for each check, and list that file in the validation `evidence` array:

1. `character_register`: every major character has an identity, aliases and a first-appearance locator.
2. `event_locators`: every plot statement in the maps and reports carries a locator.
3. `speaker_attribution`: no statement by a character or narrator is presented as the author's view.
4. `source_order`: chapter-map entries keep source order so the spoiler rule can work.
5. `quotation_budget`: quotation stays within §3 and `evidence-and-xros.md` §5.

A FAIL keeps the run `PARTIAL` until the defect is corrected and its dependent gates rerun.

## 7. Conflicts and failures

- If this overlay and a base gate disagree, the base gate wins. Record the conflict in `literary-checks.json`.
- Fewer than three eligible elements is a named `PARTIAL` gap, as in the base workflow; never invent a third.
- If reading shows the classification was wrong, stop before the maps freeze, record the evidence and ask the user whether to switch modes. Committed reading receipts stay valid; the maps and QA questions follow the chosen mode.
