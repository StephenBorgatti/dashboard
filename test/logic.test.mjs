import assert from "node:assert/strict";
import { normalize, toggleLine, snapshotFor, taskState, snapshotPath } from "../src/logic.js";

const today = "2026-11-25";

// toggle
assert.equal(toggleLine("- [ ] Do it", today), "- [x] Do it (done 2026-11-25)");
assert.equal(toggleLine("  - [x] Do it (done 2026-11-20)", today), "  - [ ] Do it");
assert.equal(toggleLine("- plain note", today), "- plain note");

// done items sink to the end of their block, with sub-items, before trailing blanks
const a = `# Papers
- Status: x
- [x] Finished (done 2026-11-25)
  - child of finished
- [ ] Open one
  - child of open

# Connections
- [x] typed by hand
- [ ] open
`;
const expectA = `# Papers
- Status: x
- [ ] Open one
  - child of open
- [x] Finished (done 2026-11-25)
  - child of finished

# Connections
- [ ] open
- [x] typed by hand (done 2026-11-25)
`;
assert.equal(normalize(a, today), expectA);

// purge items done before today, keep today's; unticked loses date
const b = `# A
- [ ] open
- [x] old (done 2026-11-24)
  - old child
- [x] new (done 2026-11-25)
- [ ] reopened (done 2026-11-20)
## Sub
  - [x] nested old (done 2026-11-01)
- note
`;
const expectB = `# A
- [ ] open
- [ ] reopened
- [x] new (done 2026-11-25)
## Sub
- note
`;
assert.equal(normalize(b, today), expectB);

// idempotent
assert.equal(normalize(expectB, today), expectB);

// snapshot lookup
assert.equal(snapshotFor(["2026-11-20", "2026-11-23", "2026-11-25"], "2026-11-24"), "2026-11-23");
assert.equal(snapshotFor(["2026-11-20"], "2026-11-19"), null);
assert.equal(snapshotPath("2026-11-25"), "history/2026/2026-11-25.md");
assert.deepEqual(taskState("- [X] a (done 2026-01-02)"), { done: true, date: "2026-01-02" });

console.log("all tests passed");
