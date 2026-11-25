import { EditorState, Compartment, RangeSetBuilder, Annotation } from "@codemirror/state";
import {
  EditorView, keymap, Decoration, ViewPlugin, WidgetType, drawSelection, highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle, indentOnInput,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import { localDate, snapshotPath, normalize, toggleLine, snapshotFor, TEMPLATE } from "./logic.js";
import { Repo, ConflictError } from "./github.js";

// ---------- state ----------
const S = {
  repo: null,
  currentSha: null,     // sha of current.md that the editor content is based on
  snapSha: {},          // path -> sha for snapshot files we know about
  dirty: false,
  saving: false,
  conflict: false,
  viewingPast: null,    // date string of snapshot being viewed, or null
  liveText: null,       // live document kept aside while viewing the past
  dayLoaded: null,      // date on which the live document was last normalized
  saveTimer: null,
};

const $ = (id) => document.getElementById(id);

function setStatus(text, cls = "") {
  const el = $("status");
  el.textContent = text;
  el.className = cls;
}

// ---------- editor decorations ----------
class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task-box";
    return box;
  }
  ignoreEvent() { return false; }
}

const TASK_RE = /^(\s*)- \[( |x|X)\]/;

function buildDecorations(view) {
  const b = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      const m = line.text.match(TASK_RE);
      if (m) {
        const done = m[2] !== " ";
        b.add(line.from, line.from, Decoration.line({ class: done ? "cm-task-done" : "cm-task-open" }));
        const boxFrom = line.from + m[1].length + 2;
        b.add(boxFrom, boxFrom + 3, Decoration.replace({ widget: new CheckboxWidget(done) }));
      } else if (/^\s*- /.test(line.text)) {
        b.add(line.from, line.from, Decoration.line({ class: "cm-note" }));
      }
      pos = line.to + 1;
    }
  }
  return b.finish();
}

const taskPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view); }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        if (!e.target.classList?.contains("cm-task-box")) return false;
        if (view.state.readOnly) { e.preventDefault(); return true; }
        const pos = view.posAtDOM(e.target);
        toggleAt(view, pos);
        e.preventDefault();
        return true;
      },
    },
  }
);

// Replace the document with `next`, changing only the region that differs, so the cursor
// and scroll position are disturbed as little as possible.
function replaceMinimal(view, next) {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length, endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) { endCur--; endNext--; }
  view.dispatch({ changes: { from: start, to: endCur, insert: next.slice(start, endNext) } });
}

function toggleAt(view, pos) {
  const line = view.state.doc.lineAt(pos);
  const today = localDate();
  view.dispatch({ changes: { from: line.from, to: line.to, insert: toggleLine(line.text, today) } });
  replaceMinimal(view, normalize(view.state.doc.toString(), today, { purgeOld: false }));
}

const hl = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.35em", fontWeight: "700", color: "#1d3557" },
  { tag: tags.heading2, fontSize: "1.15em", fontWeight: "700", color: "#274c77" },
  { tag: tags.heading3, fontSize: "1.05em", fontWeight: "700", color: "#3a5a80" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.processingInstruction, color: "#999" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
]);

const readOnlyComp = new Compartment();
// Marks programmatic loads so they do not count as user edits.
const loadAnnotation = Annotation.define();

function readOnlyExt(ro) {
  return [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];
}

const view = new EditorView({
  parent: $("editor"),
  state: EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      foldGutter(),
      markdown(),
      syntaxHighlighting(hl),
      taskPlugin,
      EditorView.lineWrapping,
      readOnlyComp.of(readOnlyExt(true)),
      keymap.of([
        { key: "Mod-s", run: () => { saveNow(); return true; } },
        { key: "Mod-Enter", run: (v) => { toggleAt(v, v.state.selection.main.head); return true; } },
        ...foldKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !S.viewingPast && !u.transactions.some((t) => t.annotation(loadAnnotation))) {
          S.dirty = true;
          setStatus("Unsaved changes", "dirty");
          scheduleSave();
        }
      }),
    ],
  }),
});

function setDoc(text, readOnly) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    effects: readOnlyComp.reconfigure(readOnlyExt(readOnly)),
    annotations: loadAnnotation.of(true),
  });
}

// ---------- loading and saving ----------
async function loadLive() {
  setStatus("Loading…");
  const today = localDate();
  let file = await S.repo.read("current.md");
  let text, isNew = false;
  if (file) {
    text = file.text;
    S.currentSha = file.sha;
  } else {
    text = TEMPLATE;
    S.currentSha = null;
    isNew = true;
  }
  const normalized = normalize(text, today);
  S.dayLoaded = today;
  S.viewingPast = null;
  setDoc(normalized, false);
  updatePastUI();
  S.dirty = isNew || normalized !== text;
  if (S.dirty) { setStatus("Unsaved changes", "dirty"); scheduleSave(); }
  else setStatus("Up to date", "ok");
}

function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 3000);
}

async function snapshotShaFor(path) {
  if (path in S.snapSha) return S.snapSha[path];
  const f = await S.repo.read(path);
  S.snapSha[path] = f ? f.sha : null;
  return S.snapSha[path];
}

async function saveNow() {
  clearTimeout(S.saveTimer);
  if (!S.repo || S.viewingPast || S.conflict || S.saving || !S.dirty) return;
  S.saving = true;
  setStatus("Saving…");
  try {
    const today = localDate();
    // If the day has changed since the document was loaded, clear out yesterday's finished items.
    const purgeOld = S.dayLoaded !== today;
    replaceMinimal(view, normalize(view.state.doc.toString(), today, { purgeOld }));
    S.dayLoaded = today;
    const text = view.state.doc.toString();
    const msg = `Update ${today}`;
    S.currentSha = await S.repo.write("current.md", text, S.currentSha, msg);
    const sp = snapshotPath(today);
    try {
      S.snapSha[sp] = await S.repo.write(sp, text, await snapshotShaFor(sp), `Snapshot ${today}`);
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      // Another device wrote today's snapshot; current.md succeeded, so ours is the latest state.
      delete S.snapSha[sp];
      S.snapSha[sp] = await S.repo.write(sp, text, await snapshotShaFor(sp), `Snapshot ${today}`);
    }
    if (view.state.doc.toString() === text) {
      S.dirty = false;
      setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "ok");
    } else scheduleSave();
  } catch (e) {
    if (e instanceof ConflictError) showConflict();
    else setStatus(e.message, "error");
  } finally {
    S.saving = false;
  }
}

// ---------- conflicts and other devices ----------
function showConflict() {
  S.conflict = true;
  clearTimeout(S.saveTimer);
  setStatus("Conflict", "error");
  $("conflict").hidden = false;
}

$("conflictLoad").onclick = async () => {
  try { await navigator.clipboard.writeText(view.state.doc.toString()); } catch { /* clipboard may be unavailable */ }
  $("conflict").hidden = true;
  S.conflict = false;
  S.dirty = false;
  await loadLive();
};

$("conflictKeep").onclick = async () => {
  const f = await S.repo.read("current.md");
  S.currentSha = f ? f.sha : null;
  $("conflict").hidden = true;
  S.conflict = false;
  S.dirty = true;
  await saveNow();
};

// When the page becomes visible again, pick up changes made on another device.
async function checkRemote() {
  if (!S.repo || S.viewingPast || S.saving || S.conflict) return;
  try {
    const f = await S.repo.read("current.md");
    const remoteSha = f ? f.sha : null;
    if (remoteSha !== S.currentSha) {
      if (S.dirty) showConflict();
      else await loadLive();
    } else if (S.dayLoaded !== localDate() && !S.dirty) {
      await loadLive();
    }
  } catch (e) {
    setStatus(e.message, "error");
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkRemote();
  else if (S.dirty) saveNow();
});
window.addEventListener("beforeunload", (e) => {
  if (S.dirty) { saveNow(); e.preventDefault(); }
});

// ---------- past days ----------
function updatePastUI() {
  const past = S.viewingPast;
  $("pastBanner").hidden = !past;
  $("todayBtn").hidden = !past;
  document.body.classList.toggle("past", !!past);
  if (!past) $("datePick").value = localDate();
}

async function showDate(date) {
  const today = localDate();
  if (!date || date >= today) { return backToToday(); }
  if (S.dirty) await saveNow();
  setStatus("Loading history…");
  try {
    const dates = await S.repo.snapshotDates();
    const d = snapshotFor(dates, date);
    if (!S.viewingPast) S.liveText = view.state.doc.toString();
    if (!d) {
      S.viewingPast = date;
      setDoc("(No saved dashboard on or before this date.)", true);
      $("pastBanner").textContent = `Nothing saved on or before ${date}.`;
    } else {
      const f = await S.repo.read(snapshotPath(d));
      S.viewingPast = d;
      setDoc(f.text, true);
      $("pastBanner").textContent = d === date
        ? `Dashboard as of the end of ${fmt(d)} (read-only)`
        : `No changes on ${fmt(date)}. Showing the end of ${fmt(d)}, the last earlier save (read-only).`;
    }
    $("datePick").value = date;
    updatePastUI();
    setStatus("Viewing history", "");
  } catch (e) {
    setStatus(e.message, "error");
  }
}

function fmt(d) {
  return new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

async function backToToday() {
  if (!S.viewingPast) return;
  S.viewingPast = null;
  setDoc(S.liveText ?? "", false);
  updatePastUI();
  setStatus(S.dirty ? "Unsaved changes" : "Up to date", S.dirty ? "dirty" : "ok");
  await checkRemote();
}

$("datePick").addEventListener("change", (e) => showDate(e.target.value));
$("todayBtn").onclick = backToToday;
$("prevDay").onclick = () => stepDay(-1);
$("nextDay").onclick = () => stepDay(1);

function stepDay(n) {
  const base = $("datePick").value || localDate();
  const d = new Date(base + "T12:00:00");
  d.setDate(d.getDate() + n);
  showDate(localDate(d));
}

// ---------- settings ----------
const KEY = "dashboard.settings";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

function openSettings(message) {
  const s = loadSettings() || { owner: "StephenBorgatti", repo: "dashboard-data", token: "" };
  $("setOwner").value = s.owner;
  $("setRepo").value = s.repo;
  $("setToken").value = s.token;
  $("setMsg").textContent = message || "";
  $("settings").showModal();
}

$("settingsBtn").onclick = () => openSettings();

$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = { owner: $("setOwner").value.trim(), repo: $("setRepo").value.trim(), token: $("setToken").value.trim() };
  localStorage.setItem(KEY, JSON.stringify(s));
  $("settings").close();
  await connect();
});

$("setForget").onclick = () => {
  localStorage.removeItem(KEY);
  $("setToken").value = "";
  $("setMsg").textContent = "Token removed from this device.";
};

async function connect() {
  const s = loadSettings();
  if (!s || !s.token) { openSettings("Enter your GitHub token to connect."); return; }
  S.repo = new Repo(s.owner, s.repo, s.token);
  S.snapSha = {};
  try {
    setStatus("Connecting…");
    await S.repo.init();
    await loadLive();
  } catch (e) {
    S.repo = null;
    setStatus("Not connected", "error");
    openSettings(e.message);
  }
}

$("datePick").value = localDate();
connect();
