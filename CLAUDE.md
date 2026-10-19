@AGENTS.md

# my_cartograph

A local app (one user, localhost, no sign-in) that reads a TypeScript or JavaScript project from a zip and draws it as a dependency map. Everything on screen comes from really parsing the code. The AI explains what the parser found; it never decides what is there. This file replaces the original Cartograph's rules for this project: no Clerk, no Supabase, no organizations.

## Stack

Next.js 16 App Router, React 19, TypeScript strict, ts-morph (parser), React Flow + dagre (map), Tailwind v4, Vercel AI SDK (`ai`, `@ai-sdk/groq`, `zod`) with Groq `openai/gpt-oss-20b`. npm. No database: stored projects are plain files in `data/`.

## Things not to do

- **Never decide that two files are connected.** An edge exists because the parser resolved a real import to a real file. Unresolved is reported with a reason, never guessed.
- **Never invent something to fill a gap.** Skipped file? Say so and count it. Route not fully recoverable? Show none. Absent beats approximate.
- **Don't install a package without asking.** Name it, say what for, wait.
- **Don't grade the code.** No scores, ratings, severity or "issues found".
- **Don't leave the build broken, don't weaken a check to make it pass.**

## How the code is laid out

- The parsing code (`lib/parser`) imports no Next, React or file-store code. Path in, data out, runnable from `npm run parse -- <dir>`.
- No framework checks inside the parser; that knowledge lives in an adapter.
- Graph calculations (`lib/graph`) are pure functions over a file list and an edge list.
- File and zip access happens in server code, never in components. Everything under `data/` goes through `lib/store`.
- One place chooses the model (`lib/ai/client.ts`). The model name is part of every cache key.
- The zip is untrusted input: refuse absolute paths, `..`, symlinks, and sizes that lie.

## Conventions

Comment the decisions, not the syntax. No `any`. The UI is a dense developer tool: small type, monospace for paths, colour only for direction and kind, nothing moves unless clicked.
