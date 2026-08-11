# lilbuddy 🦙

A lil buddy who lives on Safari — a lil LLM.

Lil Buddy is a single self-contained web page with a tiny chat widget in the
corner. Click the llama and say hi. Under the hood it runs a small
instruction-tuned language model **entirely in your browser** using
[transformers.js](https://huggingface.co/docs/transformers.js) — no backend
server, no API key, and nothing you type ever leaves the tab.

- 🧠 Model: [`HuggingFaceTB/SmolLM2-135M-Instruct`](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct) — tiny (~100MB), runs comfortably on a laptop or phone
- ⚡ Uses WebGPU when available (Safari 18+ supports this), falls back to WASM otherwise
- 💾 The model is cached by the browser after the first load, so later visits skip the download
- 🔒 Fully client-side — the only network request is the one-time model download from Hugging Face's CDN

## Running it locally

Because the chat brain runs in a module Web Worker, it needs to be served
over `http://` rather than opened directly as a `file://` URL. Any static
file server works:

```bash
# with Python
python3 -m http.server 8000

# or with Node
npx serve .
```

Then open <http://localhost:8000> in Safari (or any modern browser) and
click the llama in the bottom-right corner.

The first message triggers the model download — you'll see progress in the
chat header. After that it's instant, even offline, as long as the browser
cache hasn't been cleared.

## Deploying

This is a static site — no build step. Push it to GitHub Pages, Netlify,
Vercel, or any static host and it works as-is.

## Files

| File          | What it does                                             |
| ------------- | --------------------------------------------------------- |
| `index.html`  | Page markup + the chat widget UI                          |
| `style.css`   | Styling, light/dark aware                                 |
| `app.js`      | Main-thread UI logic, talks to `worker.js` via messages   |
| `worker.js`   | Loads the model and runs generation off the main thread   |

## Customizing Lil Buddy

- **Personality**: edit `SYSTEM_PROMPT` in `worker.js`.
- **Model**: change `MODEL_ID` in `worker.js` to any chat model with
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
