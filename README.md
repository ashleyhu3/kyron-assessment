# Kyron evaluation workbench

This local application tests whether a healthcare agent did what it told the caller it had done. It runs synthetic scheduling and refill conversations, records what the agent heard and what the clinic system actually changed, and lets a reviewer inspect the evidence behind each score.

## Run the project

Use Node.js 22.18 or newer and npm. From the project root, run the following commands. After dependency installation, the evaluation runs locally without credentials or external services.

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4173**. A new workspace starts with saved baseline and candidate runs. The app stores runs and reviews in `data/kyron.sqlite`. For a fresh, temporary demo with the same examples, use `KYRON_DB=:memory: npm start`. For development, use `npm run dev`.

**Try A5 first.** In **Compare versions**, select the optimistic baseline and verified candidate. Open the **A5 · Commit followed by timeout** row title for the baseline conversation. **System state** shows that the appointment moved. **Conversation & checks** shows that the agent received a timeout before confirming the new slot. Return to the comparison and click A5’s improved **Claim support** cell to see the candidate check the original request before answering.

## Submission guide

| Requested item | Where to find it |
|---|---|
| Source code | The [simulation harness](src/harness), [evaluation engine](src/eval), [API and SQLite store](src/server), and [React interface](src/frontend) implement the full path from scenario to review. |
| Scenario and dataset definitions | [Scheduling, identity and ambiguous requests](scenarios/scheduling), [refill requests](scenarios/refills), and [fictional clinic policies](policies). Each scenario records what the caller wants, what the agent initially knows, tool state, and acceptable outcomes. |
| Evaluation instructions, logic and schemas | Scoring uses executable rules. The [seven metric implementations](src/eval/evaluators.ts), [claim extraction](src/eval/claims.ts), and [scoring pipeline](src/eval/pipeline.ts) define how evidence becomes a verdict. See the [scenario and trace contracts](src/contracts/types.ts), [expected-outcome schema](src/eval/predicates.ts), and [verdict types](src/eval/types.ts). |
| Manual labels and comparison artifacts | Seven human clarity labels, rationales and selected evidence appear in the [original calibration record](artifacts/calibration/human-review/before.json). The [rescored results](artifacts/calibration/human-review/after.json) and [disagreement notes](artifacts/calibration/human-review/disagreements.md) explain why the rule changed. The [callback comparison](artifacts/quality/R4-handoff-remediation/comparison.json) preserves a separate example of an evaluator fix. |
| Completed evaluation output | Follow A5 from its [scenario](scenarios/scheduling/A5.json) through the [baseline trace and scores](artifacts/experiment/52493570-faa6-4a22-8a40-40aa08974ab4/baseline/A5.json) and [candidate trace and scores](artifacts/experiment/52493570-faa6-4a22-8a40-40aa08974ab4/candidate/A5.json). The [paired experiment](artifacts/experiment/52493570-faa6-4a22-8a40-40aa08974ab4/comparison.json) covers all 26 scenarios under both configurations. |

## What’s in docs

- [Parts 6 and 7 — Product findings and production design](docs/product-and-production.md) 
- [Short submission summary](docs/submission-summary.md) 
- [Part 8 — Walkthrough video](docs/Evaluating%20Healthcare%20Voice%20Agents%20with%20Scenarios.mp4)

## Reproduce the results

```sh
npm run check
npm test
npm run evaluate -- artifacts/runs/unfamiliar-final/candidate-A5.json
npm run experiment
```

The third command scores one saved interaction and prints its evidence-linked verdicts. The fourth runs both configurations and exports a fresh comparison under `artifacts/experiment/`. The saved experiment recorded eight improved checks across three scenarios, zero regressions, four incomparable checks and two changes in applicability. These are counts from deliberately chosen synthetic cases. A recorded callback establishes that a task was created. Actual callback delivery and staff acceptance require separate evidence.

For browser acceptance tests, run `npx playwright install chromium` followed by `npm run test:browser`. The browser suite uses its own temporary database.
