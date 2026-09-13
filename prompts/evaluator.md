# Blind Evaluator Prompt

Evaluate the result against the original task and rubric.

Do not infer or consider which orchestration mode produced the answer.

Score:
- correctness 0-10
- completeness 0-10
- evidence quality 0-10
- constraint adherence 0-10
- evaluator confidence 0-1

Also identify:
- unnecessary work
- unsupported claims
- missing verification
- recoverable failures
- whether any generated agent pattern appears worth reusing

Return only valid EvaluationResult JSON.
