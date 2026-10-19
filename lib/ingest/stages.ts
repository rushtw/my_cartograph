// Shared by the run and the page that shows it, so there is one list of
// stages. No Node imports: the browser loads this.

export type Stage = "extract" | "select" | "parse" | "store";

export const STAGES: readonly { stage: Stage; label: string }[] = [
  { stage: "extract", label: "Unpack zip" },
  { stage: "select", label: "Select files" },
  { stage: "parse", label: "Parse imports" },
  { stage: "store", label: "Store project" },
];
