# lilbuddy 🦙

A lil buddy who lives on Safari — a lil LLM.

Lil Buddy is a single self-contained web page with a tiny chat widget in the
corner. Click the llama and say hi. Under the hood it runs a small
instruction-tuned language model **entirely in your browser** using
[transformers.js](https://huggingface.co/docs/transformers.js) — no backend
server, no API key, and nothing you type ever leaves the tab.

- 🧠 Model: [`onnx-community/Qwen2.5-0.5B-Instruct`](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct) — small (~300-400MB), noticeably more coherent than tinier models, still runs comfortably on a laptop or phone
- ⚡ Uses WebGPU when available (Safari 18+ supports this), falls back to WASM otherwise
- 💾 The model is cached by the browser after the first load, so later visits skip the download
- 🔒 Fully client-side — the only network request is the one-time model download from Hugging Face's CDN

## Running it

Just open `index.html` in Safari — double-click it, or drag it into a
browser window. No server, no build step, no install.

(The chat brain runs in a Web Worker, which browsers normally refuse to
create from a `file://` page. `app.js` works around that by spinning the
worker up from a Blob URL instead of a separate file, so it works either
way — double-clicked locally or served from a real host.)

Click the llama in the bottom-right corner to open the chat. The first
message triggers the model download — you'll see progress in the chat
header. After that it's instant, even offline, as long as the browser
cache hasn't been cleared.

You can also serve it from any static file host if you'd rather have a
link than a local file:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploying

This is a static site — no build step. Push it to GitHub Pages, Netlify,
Vercel, or any static host and it works as-is.

## Files

| File          | What it does                                             |
| ------------- | --------------------------------------------------------- |
| `index.html`  | Page markup + the chat widget UI                                    |
| `style.css`   | Styling, light/dark aware                                           |
| `app.js`      | Main-thread UI logic, plus the worker source (see note above) and its Blob-based setup |

## Customizing Lil Buddy

- **Personality**: edit `SYSTEM_PROMPT` inside the `WORKER_SOURCE` string in `app.js`.
- **Model**: change `MODEL_ID` inside `WORKER_SOURCE` to any chat model with
  transformers.js-compatible ONNX weights (see the
  [transformers.js model list](https://huggingface.co/models?library=transformers.js)).
  Bigger models are smarter but slower to download and run.
- **Look**: colors and layout live in `style.css`; the llama icon is inline
  SVG in `index.html`.

## Browser support

Requires a browser with Web Workers, ES modules, and either WebGPU or WASM
SIMD support — which covers all current versions of Safari, Chrome, and
Firefox. Older browsers will get a friendly error message in the chat panel
instead of a silent failure.
