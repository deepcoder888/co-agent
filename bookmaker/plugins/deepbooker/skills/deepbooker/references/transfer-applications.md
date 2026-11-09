# Conditional Transfer Application Contract

## Contents

1. [Select the viewpoint](#1-select-the-viewpoint)
2. [Separate evidence from assumption](#2-separate-evidence-from-assumption)
3. [Build the domain map](#3-build-the-domain-map)
4. [Classify applications](#4-classify-applications)
5. [Rate confidence](#5-rate-confidence)
6. [Rank applications](#6-rank-applications)
7. [Design five experiments](#7-design-five-experiments)
8. [Completion checks](#8-completion-checks)

## 1. Select the viewpoint

Use one of these modes:

| Mode | Selection rule | Output boundary |
|---|---|---|
| `CENTRAL` | Select the finalized claim that carries the book's central conclusion. | Produce one application map. |
| `CHAPTER` | Use the exact finalized claim the user selects from one chapter. | Produce one application map. |
| `ALL_CHAPTERS` | Select every finalized chapter core claim. | Produce a separately labeled map for each claim; do not merge claims. |

Default to `CENTRAL`. Require the user's explicit request for `CHAPTER` or
`ALL_CHAPTERS`. Record the claim identifier, normalized proposition, edition
locator, claim type, final evidence status, ceiling, and limitations before
mapping applications.

## 2. Separate evidence from assumption

Start the transfer section with this exact label:

```text
ASSUMPTION_FOR_TRANSFER: For this application analysis only, treat the selected
viewpoint as true. Its recorded factual evidence status remains <CLAIM_STATUS>.
```

This is a conditional reasoning device. Preserve `FALSIFIED`,
`DISPUTED_OR_MIXED`, `UNVERIFIED_OR_INSUFFICIENT_EVIDENCE`, or any other final
status without upgrading it. For a falsified claim, call the map
`COUNTERFACTUAL TRANSFER` directly below the assumption label.

Summarize the viewpoint in one or two sentences. Then state a mechanism chain
with at least two explicit links in the form `condition -> process -> outcome`.
Name the evidence source or book locator for each link, or mark the link
`ASSUMED`.

## 3. Build the domain map

Evaluate these twelve domains in order:

1. Personal decision-making
2. Learning
3. Physical and mental health
4. Relationships
5. Family life
6. Work
7. Organizations
8. Personal finance
9. Consumption
10. Technology use
11. Creativity
12. Community participation

Add another domain only when both conditions hold:

- a concrete scenario identifies an actor, context, action, and observable
  outcome;
- a causal or analogical mechanism connects the selected viewpoint to that
  outcome.

Admit an application only when every field below is nonempty:

| Field | Requirement |
|---|---|
| `application_id` | Unique identifier. |
| `domain` | One domain from the ordered list or an admitted extension. |
| `scenario` | Actor, context, action, and observable outcome. |
| `mechanism` | Explicit transfer chain and why the transfer follows. |
| `conditions` | Observable preconditions and one failure threshold. |
| `benefits` | One or more measurable or directly observable gains. |
| `limitations_and_risks` | Boundary conditions, harms, and uncertainty. |
| `counterexample` | One case where the transfer fails or reverses. |
| `classification` | Enum from Section 4. |
| `confidence` | Enum and basis from Section 5. |
| `claim_status` | Unchanged factual status of the selected viewpoint. |
| `sources_or_locators` | Edition locators and inspected external sources. |
| `score` | Four component scores and total from Section 6. |

Group the final table by domain. Omit a domain when no candidate passes the
admission gate; list each omission and its failed gate in Limitations.

## 4. Classify applications

Assign exactly one:

- `DIRECT_APPLICATION`: the original and target contexts use the same causal
  mechanism, and the target action changes the same kind of variable.
- `ANALOGICAL_EXTENSION`: at least two structural elements map between the
  contexts, and the report names one boundary where the analogy stops.
- `SPECULATIVE_POSSIBILITY`: the mechanism is coherent but lacks inspected
  direct evidence in the target context.

Classification describes the transfer, not the truth of the book claim.

## 5. Rate confidence

Assign exactly one and record the matching basis:

| Rating | Required basis |
|---|---|
| `HIGH` | The selected viewpoint is `VERIFIED` or `SUPPORTED`; the target application has either two independent authoritative sources or one systematic review, consensus statement, or standard; the mechanism has no unresolved contradictory source. |
| `MEDIUM` | The viewpoint has a final status; the target application has one inspected authoritative source or two independent indirect sources; one mechanism link remains inferential. |
| `LOW` | The target application has no inspected supporting source, uses `SPECULATIVE_POSSIBILITY`, or depends on two or more assumed mechanism links. |

Use `LOW` when a higher rating's complete basis is absent.

## 6. Rank applications

Score each admitted application from 0 to 2 on four dimensions:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Evidence | `LOW` confidence | `MEDIUM` confidence | `HIGH` confidence |
| Actionability | Requires unavailable authority or resources | Can start after one named dependency | Can start with resources already controlled by the reader |
| Safety and reversibility | Irreversible or lacks a stop condition | Reversible with a named cost | Reversible within one day and has a stop condition |
| Observable value | No defined outcome measure | One proxy measure | One direct outcome measure plus review date |

Sum to a maximum of 8. Rank by total, then Evidence, then Safety and
reversibility, then Actionability, then first appearance in the domain order.
Select exactly the first five. If fewer than five applications pass the
admission gate, return `PARTIAL` and do not invent candidates.

## 7. Design five experiments

For each selected application, provide:

1. `hypothesis`: one falsifiable sentence;
2. `action`: one behavior the reader controls;
3. `duration`: a fixed period or repetition count;
4. `metric`: a baseline and one numeric or binary outcome;
5. `stop_condition`: the harm, cost, or threshold that ends the experiment;
6. `review_date`: an ISO date or a date derived from the start date;
7. `interpretation_rule`: what result supports, weakens, or leaves the transfer
   unresolved.

These experiments test the application in the reader's context. They do not
replace scientific verification of the original viewpoint.

## 8. Completion checks

Before marking the transfer stage complete:

1. Confirm the exact assumption label and unchanged claim status appear before
   the map.
2. Confirm the viewpoint summary and mechanism chain precede the domain table.
3. Confirm all twelve named domains were evaluated and each omission names its
   failed gate.
4. Confirm every admitted row contains all thirteen fields from Section 3.
5. Recompute classification, confidence basis, four scores, total, ranking,
   and tie-break order.
6. Confirm exactly five selected applications and seven experiment fields per
   selection.
7. Confirm limitations distinguish source evidence, inference, analogy, and
   speculation.
