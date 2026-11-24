/**
 * The node's thinking policy, shared by the provider form and the model-list toolbar so the two
 * cannot drift. `auto` passes the caller's own setting through; a level is forced onto every
 * request. A provider that refuses a level answers 400 naming the value (the console shows it),
 * which is why the setting lives on the node rather than in every client.
 */
export const THINKING_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto — whatever the client sends" },
  { value: "off", label: "Off — send no reasoning" },
  ...["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({ value: level, label: `Force ${level}` })),
];
