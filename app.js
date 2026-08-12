// app.js — wires up the Lil Buddy chat widget UI and talks to a worker over postMessage.
//
// The worker source is embedded below (rather than loaded from worker.js) and spun up
// from a Blob URL. That's not stylistic — browsers refuse to construct a Worker at all
// (classic or module) from a page opened via file://, since the script origin is "null".
// Blob URLs sidestep that entirely, so Lil Buddy works whether you double-click this
// file in Finder or load it from a real server. No build step, no bundler.

const WORKER_SOURCE = `
// Lil Buddy's brain. Runs entirely on-device using transformers.js
// (https://huggingface.co/docs/transformers.js). Nothing here ever talks to a
// server other than the one-time model download.

import { pipeline, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.2.0";

// A tiny instruction-tuned model, small enough to run comfortably in a browser tab.
// Swap this for any other transformers.js-compatible chat model for a bigger brain.
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
    // Always run on wasm with plain int8 weights. WebGPU + fp16 ("q4f16") is
    // faster where it works, but Safari's WebGPU backend advertises
    // navigator.gpu without reliably supporting native Float16Array yet,
    // which throws deep inside onnxruntime-web at generation time. wasm/q8
    // has no float16 tensors anywhere in the path, so it just works
    // everywhere — and the model is only 135M params, so CPU is still fast.
    generatorPromise = pipeline("text-generation", MODEL_ID, {
      device: "wasm",
      dtype: "q8",
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
`;

function createBuddyWorker() {
  const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  return new Worker(url, { type: "module" });
}

const toggleBtn = document.getElementById("buddy-toggle");
const badge = document.getElementById("buddy-badge");
const panel = document.getElementById("buddy-panel");
const closeBtn = document.getElementById("buddy-close");
const resetBtn = document.getElementById("buddy-reset");
const messagesEl = document.getElementById("buddy-messages");
const form = document.getElementById("buddy-form");
const input = document.getElementById("buddy-input");
const sendBtn = document.getElementById("buddy-send");
const statusEl = document.getElementById("buddy-status");

let worker = null;
let state = "idle"; // idle | loading | ready | busy | error
let currentAssistantBubble = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function addBubble(role, text = "") {
  const bubble = document.createElement("div");
  bubble.className = `bubble bubble-${role}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function setInteractive(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

function openPanel() {
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  toggleBtn.setAttribute("aria-expanded", "true");
  badge.hidden = true;
  if (state === "idle") startWorker();
  if (state === "ready") input.focus();
}

function closePanel() {
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
  toggleBtn.setAttribute("aria-expanded", "false");
}

function startWorker() {
  state = "loading";
  setStatus("Waking up… (downloading Lil Buddy's brain, first time only)");
  setInteractive(false);

  if (!("Worker" in window)) {
    handleFatal("This browser doesn't support Web Workers, so Lil Buddy can't wake up here.");
    return;
  }

  try {
    worker = createBuddyWorker();
  } catch (err) {
    handleFatal(`Couldn't start Lil Buddy's brain: ${err.message || err}`);
    return;
  }

  worker.addEventListener("message", onWorkerMessage);
  worker.addEventListener("error", (err) => {
    handleFatal(err.message || "An unknown error stopped Lil Buddy's brain.");
  });

  worker.postMessage({ type: "load" });
}

function handleFatal(message) {
  state = "error";
  setInteractive(false);
  setStatus("Something went wrong 😕");
  addBubble("system", message);
}

function onWorkerMessage(event) {
  const { type } = event.data;

  switch (type) {
    case "progress": {
      const p = event.data.progress;
      if (p && p.status === "progress" && p.file) {
        const pct = p.total ? Math.round((p.loaded / p.total) * 100) : null;
        setStatus(pct != null ? `Downloading ${p.file}… ${pct}%` : `Downloading ${p.file}…`);
      } else if (p && p.status === "ready") {
        setStatus("Almost there…");
      }
      break;
    }

    case "ready": {
      state = "ready";
      setInteractive(true);
      setStatus("Ready — say hi!");
      addBubble(
        "assistant",
        "Hey, I'm Lil Buddy 🦙 — a tiny LLM running right here in your browser, no server involved. Ask me anything!"
      );
      input.focus();
      break;
    }

    case "token": {
      if (currentAssistantBubble) {
        currentAssistantBubble.textContent += event.data.token;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      break;
    }

    case "done": {
      state = "ready";
      setInteractive(true);
      setStatus("Ready!");
      currentAssistantBubble = null;
      input.focus();
      break;
    }

    case "reset-ok": {
      break;
    }

    case "error": {
      state = "ready";
      setInteractive(true);
      setStatus("Hit a snag, but I'm okay — try again?");
      addBubble("system", `Error: ${event.data.error}`);
      currentAssistantBubble = null;
      break;
    }
  }
}

toggleBtn.addEventListener("click", () => {
  if (panel.classList.contains("open")) {
    closePanel();
  } else {
    openPanel();
  }
});

closeBtn.addEventListener("click", closePanel);

resetBtn.addEventListener("click", () => {
  if (!worker || state === "loading") return;
  messagesEl.innerHTML = "";
  worker.postMessage({ type: "reset" });
  addBubble("assistant", "Fresh start! What's on your mind? 🦙");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || state !== "ready" || !worker) return;

  addBubble("user", text);
  input.value = "";
  state = "busy";
  setInteractive(false);
  setStatus("Thinking…");
  currentAssistantBubble = addBubble("assistant", "");
  worker.postMessage({ type: "generate", text });
});
