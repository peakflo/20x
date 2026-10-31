# PR 661 app screenshots

These images show the 20x PR branch in the Electron app and the real mobile React build. The data is local sample data. It has no account, tenant, customer record, or usable model setting. The `raw/` images are full window captures. `annotate.py` adds the red marks, route captions, and close views to the nine images in this folder.

## Make a local profile

From the repository root, install and build the PR branch:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Use a new profile directory. Start and stop the built app once so it makes the SQLite schema. Keep port 20620 free for the local task API. Then add the sample rows:

```sh
PROFILE=/tmp/20x-pr661-profile
mkdir -p "$PROFILE/home" "$PROFILE/config" "$PROFILE/codex" "$PROFILE/opencode"
env HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/config" CODEX_HOME="$PROFILE/codex" OPENCODE_CONFIG_DIR="$PROFILE/opencode" pnpm exec electron . --user-data-dir="$PROFILE" --remote-debugging-port=9331
# Stop the app after it opens.
python3 docs/pr-screenshots/661/seed-mock.py "$PROFILE"
env HOME="$PROFILE/home" XDG_CONFIG_HOME="$PROFILE/config" CODEX_HOME="$PROFILE/codex" OPENCODE_CONFIG_DIR="$PROFILE/opencode" pnpm exec electron . --user-data-dir="$PROFILE" --remote-debugging-port=9331
```

The seed sets the default agent to a model name that does not exist. It makes three completed invoice tasks, a task with two sample flow uses, two sample skills, a held skill draft, and a local transcript with an inline HTML artifact. It does not start a model or use Workflo data. Use only the new profile for this task.

## Capture the desktop app

Open **Tasks > Review invoice 104 > Details** for image 1. Open **Skills > invoice-review** for images 2–4. Edit the description, capture the Save button, select Save, capture the ready draft, select Approve, and capture version 2. Open **Skills > self-improving-workflows** for image 5. Open **Tasks > Find an invoice reminder to automate > transcript** for images 6–7. Select Explore in the HTML card for image 7; the real bridge records the user message. `cdp.mjs` can capture a full Electron window and send a trusted click:

```sh
node docs/pr-screenshots/661/cdp.mjs shot docs/pr-screenshots/661/raw/01-task-flow.png
node docs/pr-screenshots/661/cdp.mjs click 400 225
```

The click coordinates are CSS pixels in the Electron window. Capture images 2–7 to the matching `raw/` names. For the inline card, capture image 6 before the click and image 7 after the click. A second run of `seed-mock.py` clears the local transcript for a new capture.

## Capture the mobile app

Stop the desktop app so port 20620 is free. Use a second new profile; start and stop the app once to make its schema, and run `seed-mock.py` on that profile. Install `aiohttp` in a local Python environment and start the mock API:

```sh
python3 docs/pr-screenshots/661/mobile-local-server.py /tmp/20x-pr661-mobile-profile
```

Open `http://127.0.0.1:20620/` in a 402 × 681 mobile browser view. In browser local storage, set `20x_session_token` to `mock-local`, then reload. Open **Tasks > Find an invoice reminder to automate > Agent Transcript**. Capture image 8. Select Explore in the HTML card and capture image 9. The server writes only that real click to the local SQLite transcript. It does not add a scripted agent reply.

## Add marks and close views

ImageMagick is required. Run:

```sh
python3 docs/pr-screenshots/661/annotate.py
```

If a screen layout changes, update the box and crop coordinates in `annotate.py` after you capture the new raw image.

## Small product fixes found during capture

The desktop artifact store and mobile API now keep the `inline` and `heightHint` fields when they read a registered artifact. Without these fields, the inline card becomes an artifact tile after a reload. The mobile page CSP now lets the sandboxed HTML frame run its inline button script in WebKit. This also permits inline script in the mobile page, so the CSP change needs security review.
