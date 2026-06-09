# TMT Web Translator

This browser extension translates webpage text between English, Nepali, and Tamang using the TMT API.

The most important part of setup is configuring your credentials correctly. This guide is written mainly for that.

## Credential setup (do this first)

### 1. Create your local `.env` file

From the project root:

```bash
copy .env.example .env
```

### 2. Add your real credentials in `.env`

Open `.env` and set both values:

```env
TMT_API_KEY=YOUR_API_KEY
TMT_API_ENDPOINT=YOUR_API_ENDPOINT
```

What each value means:

- `TMT_API_KEY`: your team token from organizers.
- `TMT_API_ENDPOINT`: the API URL to send translation requests.

### 3. Generate runtime config for the extension

```bash
node scripts/generate-config.mjs
```

This command reads `.env` and generates `config.js` that the extension can use at runtime.

## Why this flow exists

Chrome extensions cannot directly read `.env` files at runtime.

So the flow is:

1. Keep credentials in `.env` (local file).
2. Convert `.env` to `config.js` (generated file).
3. `background.js` reads values from `config.js`.

## Project structure (for local setup)

Use this tree to understand which files you need to configure locally and which files are core extension logic.

```text
Google-TMT/
├─ .env.example                 # Template credentials information (safe to commit)
├─ .env                         # Your local credentials (create this locally)
├─ .gitignore                   # Ignores .env and generated config.js
├─ manifest.json                # Extension manifest and permissions
├─ background.js                # Service worker; reads API_KEY/API_ENDPOINT from config.js
├─ content.js                   # Page text extraction and translation replacement logic
├─ content.css                  # Optional content-script UI styles
├─ config.js                    # Generated from .env (do not edit manually)
├─ scripts/
│  └─ generate-config.mjs       # Reads .env and generates config.js
├─ popup/
│  ├─ popup.html                # Popup markup
│  ├─ popup.css                 # Popup styling
│  └─ popup.js                  # Popup behavior and messaging
└─ icons/
	└─ ...                       # Extension icons
```

### Local configuration path (what to do in order)

Important: the browser does not parse `.env` at runtime.
`.env` is only a local input file for `scripts/generate-config.mjs`, which creates `config.js`.

1. Copy `.env.example` to `.env`.
2. Put your real token and endpoint in `.env`.
3. Run `node scripts/generate-config.mjs` to generate `config.js`.
4. Confirm `config.js` is generated.
5. Load or reload extension from `chrome://extensions/`.

### Which files you should edit vs not edit

- `.env` for your local key and endpoint.
- `.env.example` only if the expected variable names change for the whole team.
- Do not edit manually: `config.js` (it is generated).
- Usually do not need to edit: `background.js` unless API behavior changes.

## Full quick start

1. Clone the repository.

```bash
git clone <your-repo-url>
cd Google-TMT
```

2. Configure credentials using the 3 steps above.

3. Load extension in browser.

- Open `chrome://extensions/`
- Enable Developer mode
- Click Load unpacked
- Select this project folder

4. Test translation.

- Open any webpage
- Open extension popup
- Choose source and target language
- Turn translation on

## Important rule when credentials change

Any time you edit `.env`, run this again:

```bash
node scripts/generate-config.mjs
```

Then reload the extension in `chrome://extensions/`.

## Credential troubleshooting

If translation is not working, check in this order:

1. `.env` exists in project root.
2. `.env` has both `TMT_API_KEY` and `TMT_API_ENDPOINT`.
3. You ran `node scripts/generate-config.mjs` successfully.
4. Reloaded extension in `chrome://extensions/`.
5. Refreshed the target webpage.

If it still fails, your token may be invalid or expired.


