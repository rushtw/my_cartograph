import { groq } from "@ai-sdk/groq";

// The one place a model is chosen. Everything that calls a model imports this
// and nothing else imports a provider.

// One model for every task, as in my_polaris. The name is part of every cache
// key, so changing it can't serve an answer the new model never gave. Groq
// serves this under a plain name rather than a dated snapshot, so what sits
// behind the name is Groq's to change.
export const MODEL = "openai/gpt-oss-20b";

// Low reasoning effort: explanations are short and the person is waiting.
export const PROVIDER_OPTIONS = { groq: { reasoningEffort: "low" } } as const;

// Built on first use, so a missing key fails the call that needed it, in
// words, instead of the server's boot. The map works without one.
export function model() {
  if (!process.env.GROQ_API_KEY?.trim()) {
    throw new Error("GROQ_API_KEY isn't set in .env.local, so nothing can be explained");
  }
  return groq(MODEL);
}
