// Loads a zip into data/ from the terminal, the same code the landing page runs.
//
//   npm run load -- path/to/project.zip

import { copyFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { incomingName, ingestZip } from "../lib/ingest/run.ts";
import { DATA_DIR } from "../lib/store/projects.ts";

const [zip] = process.argv.slice(2);
if (!zip) {
  console.error("usage: npm run load -- <project.zip>");
  process.exit(1);
}
// The run moves the zip into the project it stores, so it works on a copy.
mkdirSync(DATA_DIR, { recursive: true });
const copy = path.join(DATA_DIR, incomingName());
copyFileSync(zip, copy);
const started = performance.now();
try {
  const outcome = await ingestZip(copy, path.basename(zip).replace(/\.zip$/i, ""), (stage, message) => console.log(`[${stage}] ${message}`));
  console.log(`${outcome.alreadyStored ? "Already stored" : "Stored"} as ${outcome.id} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(copy, { force: true });
}
