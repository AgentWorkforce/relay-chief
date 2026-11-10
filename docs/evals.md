# Classifier evaluations

## Overlap, 2026-11-10

Run by the pipeline team on our own workspace's sessions, using the request `src/jev.ts` sends: repository, work key and a summary capped at 16,000 characters. The model was `jev-latest`. Only aggregates were shared.

| Pairs | Classified as overlap | Overlap at confidence 0.80 or more |
| --- | --- | --- |
| Real overlap incidents (2) | 2 | 1 |
| Planned parallel work (24) | 24 | 24 |
| Hard negatives (38) | 38 | 27 |
| Unrelated (1) | 1 | 1 |

Thirty reruns returned the same choice every time, with confidence varying by at most 0.05. The classifier is repeatable but does not separate real overlap from planned parallel or unrelated work.

Each request described two sessions together, which may push the model toward overlap. Chief's own requests describe one issue at a time, so this result says nothing about follow-up or blocked decisions. With two incidents, recall is unmeasured.

**Decision:** an overlap classification is ignored (`overlap_requires_detector`) and never reserves a coordinate task. Overlap evidence will come from a pair-level detector instead, calibrated on a larger set of real incidents before any action depends on it.

## Follow-up confidence, live on agentrelay-dev

The same issue scored 0.73, then 0.77, then 0.99 as its text was made more specific. The 0.80 gate therefore depends heavily on how an issue is written. It needs calibrating on real customer issues before a customer relies on it.
