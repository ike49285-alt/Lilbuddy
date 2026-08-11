// worker.js — Lil Buddy's brain.
// Runs entirely on-device using transformers.js (https://huggingface.co/docs/transformers.js).
// Nothing here ever talks to a server other than the one-time model download.

import { pipeline, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.0";

// A tiny instruction-tuned model, small enough to run comfortably in a browser tab.
// Swap this for any other transformers.js-compatible chat model if you want a bigger brain.
const MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct";

const SYSTEM_PROMPT = [
  "You are Lil Buddy, a tiny, cheerful llama who lives inside a webpage.",
  "You are a small on-device language model, and you're proud of it.",
  "Keep replies short (1-4 sentences), warm, a little playful, and easy to read.",
  "If you don't know something, say so honestly instead of making it up.",
].join(" ");

const MAX_HISTORY_MESSAGES = 13; // system + last 6 exchanges

let history = [{ role: "system", content: SYSTEM_PROMPT }];
let generatorPromise = null;

function getGenerator(progress_callback) {
  if (!generatorPromise) {
    const useWebGPU = typeof navigator !== "undefined" && !!navigator.gpu;
    generatorPromise = pipeline("text-generation", MODEL_ID, {
      device: useWebGPU ? "webgpu" : "wasm",
      dtype: useWebGPU ? "q4f16" : "q8",
      progress_callback,
    });
  }
  return generatorPromise;
}

function trimHistory() {
  if (history.length > MAX_HISTORY_MESSAGES) {
    history = [history[0], ...history.slice(-(MAX_HISTORY_MESSAGES - 1))];
  }
}

self.addEventListener("message", async (event) => {
  const { type } = event.data || {};

  try {
    if (type === "load") {
      await getGenerator((progress) => {
        self.postMessage({ type: "progress", progress });
      });
      self.postMessage({ type: "ready" });
      return;
    }

    if (type === "reset") {
      history = [{ role: "system", content: SYSTEM_PROMPT }];
      self.postMessage({ type: "reset-ok" });
      return;
    }

    if (type === "generate") {
      const text = String(event.data.text ?? "");
      history.push({ role: "user", content: text });
      trimHistory();

      const generator = await getGenerator();
      let full = "";
      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk) => {
          if (!chunk) return;
          full += chunk;
          self.postMessage({ type: "token", token: chunk });
        },
      });

      await generator(history, {
        max_new_tokens: 200,
        temperature: 0.7,
        top_p: 0.9,
        repetition_penalty: 1.15,
        do_sample: true,
        streamer,
      });

      history.push({ role: "assistant", content: full.trim() });
      trimHistory();
      self.postMessage({ type: "done" });
    }
  } catch (err) {
    self.postMessage({ type: "error", error: err?.message || String(err) });
  }
});
