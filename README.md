# Dashboard

A single standing dashboard of projects and todos, stored as Markdown in a private GitHub repository, with a snapshot for each day on which it was changed.

The app is the static page in this repository (`index.html` and `app.js`), served by GitHub Pages. It holds no data. The data lives in a separate private repository (by default `dashboard-data`):

- `current.md`: the live dashboard
- `history/YYYY/YYYY-MM-DD.md`: the dashboard as it stood at the end of each day on which it was changed

## Format

- `#`, `##`, `###` headings: categories and subcategories
- `- [ ] text`: open todo
- `- [x] text (done YYYY-MM-DD)`: finished todo (the date is added automatically)
- `- text`: status note

A finished todo moves to the end of its section and is removed from the live dashboard on the next day. It remains in that day's snapshot.

## Use

- Edits save automatically about three seconds after you stop typing. Ctrl+S (Cmd+S) saves at once.
- Click a box to tick or untick it. Ctrl+Enter toggles the box on the current line.
- The arrows beside each heading fold and unfold sections.
- Choose a date, or use the arrow buttons, to see the dashboard as of the end of that day (read-only). "Back to today" returns to the live dashboard.
- If the dashboard was changed on another device while you were editing, the app stops and asks which version to keep.

## Setup on a new device

Open the page, click Settings, and enter the account name, the data repository name, and an access token.

To create a token: GitHub, Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token. Under "Repository access" choose "Only select repositories" and pick the data repository. Under "Repository permissions" set "Contents" to "Read and write". Choose an expiration date; when it expires, make a new token and enter it in Settings on each device.

## Building

`src/` holds the source. To rebuild `app.js` after changing it:

```
npm install
npx esbuild src/main.js --bundle --minify --format=iife --outfile=app.js
node test/logic.test.mjs
```
