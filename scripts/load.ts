// Loads a zip or a folder into data/ from the terminal, the same code the landing page runs.
//
//   npm run load -- path/to/project.zip
//   npm run load -- path/to/project-folder

import path from "node:path";
import { ingestPath, inspectPath } from "../lib/ingest/run.ts";

const [given] = process.argv.slice(2);
if (!given) {
  console.error("usage: npm run load -- <project.zip | folder>");
  process.exit(1);
}
const started = performance.now();
const outcome = await ingestPath(await inspectPath(path.resolve(given)), (stage, message) => console.log(`[${stage}] ${message}`));
console.log(`${outcome.alreadyStored ? "Already stored" : "Stored"} as ${outcome.id} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
