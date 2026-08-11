// app.js — wires up the Lil Buddy chat widget UI and talks to worker.js over postMessage.

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
    worker = new Worker("worker.js", { type: "module" });
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
