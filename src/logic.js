// Pure text functions for the dashboard. No browser dependencies, so they can be tested in Node.

export function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function snapshotPath(date) {
  return `history/${date.slice(0, 4)}/${date}.md`;
}

const ITEM_RE = /^(\s*)- (\[( |x|X)\] )?(.*)$/;
const DONE_TAG_RE = /\s*\(done (\d{4}-\d{2}-\d{2})\)\s*$/;
const HEADING_RE = /^#{1,6}\s/;

function indentOf(line) {
  return line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
}

// Returns {done: bool|null, date: string|null}; done is null for non-task lines.
export function taskState(line) {
  const m = line.match(ITEM_RE);
  if (!m || !m[2]) return { done: null, date: null };
  const done = m[3] !== " ";
  const dm = m[4].match(DONE_TAG_RE);
  return { done, date: dm ? dm[1] : null };
}

// Toggle the checkbox on one line, adding or removing the done date.
export function toggleLine(line, today) {
  const m = line.match(ITEM_RE);
  if (!m || !m[2]) return line;
  const indent = m[1];
  let text = m[4].replace(DONE_TAG_RE, "");
  if (m[3] === " ") return `${indent}- [x] ${text} (done ${today})`;
  return `${indent}- [ ] ${text}`;
}

// Make each task line consistent: finished items carry a done date, open items do not.
function fixDates(lines, today) {
  return lines.map((line) => {
    const m = line.match(ITEM_RE);
    if (!m || !m[2]) return line;
    const hasDate = DONE_TAG_RE.test(m[4]);
    if (m[3] !== " " && !hasDate) return `${line.replace(/\s+$/, "")} (done ${today})`;
    if (m[3] === " " && hasDate) return `${m[1]}- [ ] ${m[4].replace(DONE_TAG_RE, "")}`;
    return line;
  });
}

// Split a block of lines into top-level units. A unit is a top-level list item plus the
// more-indented lines that follow it, or any other single line.
function units(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(ITEM_RE);
    if (m && indentOf(line) === 0) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && indentOf(lines[j]) > 0 && !HEADING_RE.test(lines[j])) j++;
      out.push({ lines: lines.slice(i, j), item: true, done: taskState(line).done === true });
      i = j;
    } else {
      out.push({ lines: [line], item: false, done: false });
      i++;
    }
  }
  return out;
}

// Within each heading's block, move finished top-level items (with their sub-items) to the
// end of the block, keeping their relative order. Trailing blank lines stay at the end.
function sinkDone(lines) {
  const result = [];
  let block = [];
  const flush = () => {
    let end = block.length;
    while (end > 0 && block[end - 1].trim() === "") end--;
    const body = units(block.slice(0, end));
    const open = body.filter((u) => !u.done);
    const done = body.filter((u) => u.done);
    for (const u of open) result.push(...u.lines);
    for (const u of done) result.push(...u.lines);
    result.push(...block.slice(end));
    block = [];
  };
  for (const line of lines) {
    if (HEADING_RE.test(line)) {
      flush();
      result.push(line);
    } else block.push(line);
  }
  flush();
  return result;
}

// Remove finished items whose done date is before today, along with their sub-items.
function purge(lines, today) {
  const out = [];
  let skipIndent = -1;
  for (const line of lines) {
    if (skipIndent >= 0) {
      if (line.trim() !== "" && indentOf(line) > skipIndent && !HEADING_RE.test(line)) continue;
      skipIndent = -1;
    }
    const st = taskState(line);
    if (st.done && st.date && st.date < today) {
      skipIndent = indentOf(line);
      continue;
    }
    out.push(line);
  }
  return out;
}

// Applied on load and before each save.
export function normalize(text, today, { purgeOld = true } = {}) {
  let lines = text.split("\n");
  lines = fixDates(lines, today);
  if (purgeOld) lines = purge(lines, today);
  lines = sinkDone(lines);
  return lines.join("\n");
}

// Given a sorted list of snapshot dates, the latest one on or before `date`.
export function snapshotFor(dates, date) {
  let best = null;
  for (const d of dates) if (d <= date && (best === null || d > best)) best = d;
  return best;
}

export const TEMPLATE = `# Papers
## Example paper
- Status: describe where it stands
- [ ] A todo for this paper

# Connections
- [ ] A todo

# Social Networks special issue on network theory
- Status:
`;
