# Freehand

A Manus-style autonomous agent that runs on **free models**. Give it a goal; it plans, searches the web, reads pages, drives a real browser, writes files and runs code, and hands back a finished result. No credits.

- **Models:** Ollama (local, unlimited) and free cloud tiers (OpenRouter `:free` models, Groq, Google Gemini). Switch in Settings; set fallback providers so a rate limit on one free tier moves the task to the next.
- **Tools:** web search, page fetch, Playwright browser (click/type/scroll/screenshot), file read/write/edit, shell, Python, ask-the-user, and for games: `play_test`, `make_model` and `model_info`.
- **Games:** Freehand builds browser games (three.js for 3D, canvas for 2D), plays them itself with `play_test` (inputs, errors, failed files, a screenshot) and fixes what breaks. It will not finish while a game it changed is untested or still has errors. You play the result in the **Play** tab of the Computer panel, full screen, or in your own browser.
- **3D models:** `make_model` builds low-poly `.glb` models from shapes (box, sphere, cylinder, cone, pyramid, wedge, torus) and warns about parts that float or are buried. Attach your own models (`.glb`, `.gltf`, `.obj`, `.fbx`, `.stl`), images or sounds with the paperclip or by dropping them on the window; they land in the task's `assets/` folder and `model_info` tells the agent their size and animation names. Any model opens in the built-in 3D viewer.
- **UI:** laid out like Hatch and Claude's desktop app: a sidebar of recent tasks, a home screen with one composer box, the agent's work in a centered thread, a live plan checklist, the Computer panel (browser screenshots, command output, files), and full-page Settings with sections. Ctrl+K searches tasks and actions; deleting a task shows an Undo toast.
- **Effort:** Low, Medium, High or Max, like Claude's effort setting. Pick it in the composer or in Settings > Capabilities. Higher effort makes longer plans, gives the agent more tool steps (Low 40% of your step limit, Medium 70%, High 100%, Max 250%), and tells it to check more sources and review its work. Lower effort finishes faster.
- **Platforms:** Windows and Linux (Bazzite/Fedora/Ubuntu/Pop!_OS). Electron app + plain Node core.

## Run it

Requires Node 20+ (`node -v`).

```bash
npm install
npm start            # desktop window
npm run serve        # or: no Electron, open the printed link in your browser
```

Build installers (run each on its own OS):

```bash
npm run dist:win     # on Windows -> dist/freehand-x.y.z-x64.exe (portable + installer)
npm run dist:linux   # on Linux   -> dist/freehand-x.y.z.AppImage
./install.sh install # Linux: installs the AppImage to ~/.local + app menu entry
./install.sh --check # Linux: checks Ollama, browser, python, libfuse2
```

## Pick a model

| Option | Setup | Notes |
|---|---|---|
| **Ollama** (default) | Install from ollama.com, `ollama pull qwen3:8b` (or `llama3.1:8b`, a larger model if you have the VRAM) | Unlimited, private, offline. Set `OLLAMA_CONTEXT_LENGTH=16384` (or more) before starting Ollama: the default context is too small for agent work. |
| **OpenRouter** | Free key at openrouter.ai/keys, then "Load available models" and choose one ending in `:free` | Free models are rate-limited per day. |
| **Groq** | Free key at console.groq.com/keys | Very fast, tight per-minute limits. |
| **Gemini** | Free key at aistudio.google.com/apikey (`gemini-2.5-flash`) | Generous free tier, long context. |

Keys can also come from the environment: `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`.

**Tool mode.** "Automatic" tries native tool calling and switches to a JSON protocol if the model rejects it. Force **JSON mode** for small local models that handle tool calling badly.

## Local AI models and freehand-v2

Settings > Models > **Local AI models** lists what Ollama has, switches between models, downloads new ones by name, and imports a `.gguf` file you already have.

**freehand-v2** is Freehand's own Ollama model: a base model you pick (default `qwen3:4b-instruct`, fits a 4 GB graphics card) with instructions and settings for building games, making 3D models with `make_model`, using attached models and play-testing (16K context, low temperature). Press **Build it**; it takes a few seconds when the base model is already downloaded. Outside Freehand, `ollama run freehand-v2 "a low-poly street lamp"` replies with a `make_model` JSON spec.

## Be realistic about quality

Manus runs frontier models. Free and small models are noticeably weaker: expect more retries, shorter plans, and occasional wrong turns. What helps most: a 14B+ local model or a 70B free cloud model, concrete requests ("write X as a .md file"), and replying with corrections mid-task. The agent does not send screenshots to the model (most free models cannot see images); it works from the page's text and numbered element list, and shows screenshots to you.

## Safety

This agent runs commands **on your real machine**, not in a VM.

- **Shell and Python ask for your approval by default** (the shield button in the composer, or Settings > Capabilities > Safety). Only switch to "Run without asking" if you trust the model and task. A web page can talk a small model into running a harmful command.
- File tools are confined to the task's workspace folder (symlink escapes are blocked). Shell/Python start in that folder but are **not** sandboxed: an approved command can touch anything your user can.
- The local server binds to `127.0.0.1`, requires a per-launch secret cookie, and rejects foreign `Host` headers, so websites and other apps cannot drive the agent.
- API keys are stored in plain text in `settings.json` (owner-only permissions on Linux; on Windows it sits in your user profile). Files the agent writes are served as plain text, never rendered as HTML.

## Games and previews: how it stays safe

Games run on a second local server with its own port, so they are a different origin from the app. Its URLs carry a random per-launch token, and the app's API refuses any request that comes from another origin. A game cannot read your tasks, settings or keys, or tell the agent to run commands.

## Data

`%APPDATA%\freehand-agent` (Windows) or `~/.config/freehand-agent` (Linux; packaged app uses its own user-data folder): `settings.json`, and `tasks/<id>/workspace/` for each task's files. Override with `FREEHAND_HOME`.

## Browser tool

Uses, in order: `FREEHAND_BROWSER_PATH`, Playwright's Chromium (`npm run setup-browser`, ~150 MB), then Chrome/Edge installed on the system. Windows always has Edge, so it works out of the box there. On Bazzite, run `npm run setup-browser` once (or install Chrome).

## Bazzite notes

AppImages run on Bazzite if `libfuse2` is present (`./install.sh --check`); otherwise run with `--appimage-extract-and-run`. Alternatively use `npm run serve` inside a distrobox/toolbox. If you want Python for the agent's python tool, make sure `python3` is on the PATH where you launch it.

## Layout

```
electron/main.js     window + backend launcher
src/core/            config, provider adapters (OpenAI-compatible), agent loop
src/tools/           search/fetch, browser, files, shell/python
src/server/          local HTTP + SSE API, task store
ui/                  vanilla JS UI (no build step), bundled IBM Plex and Fraunces fonts, Phosphor icons
test/                npm test (mock-model suite), browser.test.js, ui-smoke.js
```

## Credits

Layout and styles follow Hatch. Fonts: IBM Plex Sans, IBM Plex Mono and Fraunces (SIL Open Font License), bundled so no font is fetched from the internet; type any installed font name in Settings > General to use your own. Icons: Phosphor (MIT).


## Install like a normal app (Start menu + auto-update)
Releases are built by GitHub Actions (`.github/workflows/release.yml`) and published to GitHub Releases.

1. Create an empty **public** repo named `freehand` on GitHub (auto-update needs public releases).
2. In this folder:
   ```
   git remote add origin https://github.com/Jayswansocool48/freehand.git
   git push -u origin main
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. When the Action finishes, open the repo's **Releases** page and download `Freehand-Setup-0.1.0.exe` (Windows) or `Freehand-0.1.0.AppImage` (Bazzite/Linux). The Windows installer adds Freehand to the Start menu and Desktop.
4. To ship an update: bump `version` in `package.json`, commit, push a new tag (`v0.1.1`). Installed copies download it in the background and offer "Restart now".

If you use a different GitHub name or repo name, change `build.publish` and `repository` in `package.json`.

## Run from source (development)
1. Install any Node.js (22, 24 or 26 all work).
2. Double-click `start.bat` (installs on first run, then launches), or `npm install && npm start`.
3. Optional: `powershell -ExecutionPolicy Bypass -File remove-other-node.ps1` lists your Node installs and removes the ones you don't want.

Electron is pinned to 45.x because older versions fail to install on Node 24.16+/26 and npm 11 blocks their postinstall script.

## Using your own model app
Point **Custom (OpenAI-compatible)** at your app's server address (Settings > Models), or let it serve the model through Ollama and pick Ollama.
