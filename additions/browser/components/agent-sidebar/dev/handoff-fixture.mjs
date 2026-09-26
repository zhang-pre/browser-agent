export const handoffJson = summary => JSON.stringify({
  schemaVersion: 1, summary, nextAction: "continue",
  facts: [], hypotheses: [], deadends: [], decisions: [], artifacts: [], observations: [],
});
