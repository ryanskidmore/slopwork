# Spike S3 — JSONC library

**Status:** done. **Time spent:** ~1h (as budgeted). **Throwaway spike** — code lived in a scratch dir, not in this repo. This document is the only durable artifact.

## Decision

Use **`jsonc-parser`** (Microsoft's, `microsoft/node-jsonc-parser`, the one VS Code embeds) for *reading* every `.jsonc` file in `.slop/db/` — it is fault-tolerant, never throws, and gives structured errors good enough for A3's "clear errors on hand-corrupted files" requirement. For *writing*, use a **hybrid, per-file-class strategy**, not a single uniform answer:

- **Tickets and sessions** (human-facing, git-committed, hand-edited via `slop edit`): attempt **surgical `modify()` + `applyEdits()`** to preserve human comments, but wrap every write in a mandatory **reparse-and-validate safety net** that falls back to a **canonical whole-object `JSON.stringify(x, null, 2)` rewrite** whenever the surgical result fails to reparse cleanly or fails a structural deep-equal check. This is not a hedge for style — empirical testing found a **real data-corruption bug** in the currently-published stable version (`3.3.1`) that the safety net directly exists to catch (see "Load-bearing findings" below).
- **Events and `index.jsonc`** (machine-only, write-once or fully derived, never hand-edited, never re-mutated): **always canonical `JSON.stringify`**. There is nothing to preserve and no reason to pay `modify()`'s complexity or risk.

This matches the plan's own fallback framing ("comments read-tolerated, writes canonical") but sharpens it: canonical-only is the *floor*, not the whole answer — surgical writes are worth attempting for ticket/session files because they demonstrably work for the common cases (see below), and the fallback makes the risky case safe rather than silently corrupt.

---

## Package health

| Check | Result |
|---|---|
| Latest npm version | `3.3.1`, published 2024-06-24 (stable/`latest` tag) |
| Weekly downloads | 53,535,019 (last week of data, 2026-07-16 → 07-22) |
| TypeScript types | Bundled natively (`typings` field, `.d.ts` ships in the package) — no `@types/*` needed |
| GitHub repo | `microsoft/node-jsonc-parser`, 750 stars, **not archived**, last push 2026-07-21 (2 days before this spike) |
| Maintenance | Active — dependabot merges + a real bugfix PR (#120, "Fix off-by-one error in `modify()` when removing last array element") merged 2026-05-04 |
| Caveat | That bugfix is **only in the unreleased `next` dist-tag (`4.0.0-next.2`)**, not yet in `latest`. Installing plain `jsonc-parser` (or `bun add jsonc-parser`) gets you `3.3.1`, which **still has the bug**. See below. |

Recommendation: pin `jsonc-parser@3.3.1` (stable) for v0, not `next` — a 4.0.0 prerelease isn't something to build a project's persistence layer on. The write-side safety net (below) exists specifically because of this version's known bug, so pinning stable is safe. Revisit once 4.x graduates to `latest`.

---

## Load-bearing empirical findings

All of this was run against a hand-authored fixture ticket file with comments in 7 places (file header, a block comment above a key, an inline `/* */`, an inline trailing `//`, a comment on an empty-array line, a comment attached to an array element, and a comment above a nested object) — modeling a real `slop edit`-touched ticket.

### 1. Read tolerance — comments, trailing commas, malformed input

`parse()` **never throws**. It always returns a best-effort value; the *only* signal of trouble is the `errors[]` array you pass in.

```ts
const errors: jsonc.ParseError[] = [];
const value = jsonc.parse(text, errors, { allowTrailingComma: true });
```

- Comments: tolerated by default (`disallowComments` defaults to `false`).
- Trailing commas: **not** tolerated by default — you must pass `allowTrailingComma: true`, otherwise every trailing comma produces `ValueExpected`/`PropertyNameExpected` errors (though the parser still recovers a best-effort value).
- Empty files: need `allowEmptyContent: true` or you get a `ValueExpected` error on an `undefined` result — `.slop/db/` files should never legitimately be empty, so leaving this `false` (default) and treating it as an error is correct.
- Errors give exactly what A3 needs — offset + length + a `ParseErrorCode` you turn into text via `printParseErrorCode()`:

```
error: CloseBraceExpected at offset 16 len 0   (missing `}`)
error: CommaExpected at offset 9 len 3         (missing `,` between properties)
error: InvalidSymbol at offset 2 len 1         (unquoted key)
error: UnexpectedEndOfString at offset 7 len 13
error: InvalidEscapeCharacter at offset 7 len 15   (`\x` is not a valid JSON escape)
```

Offset/length are enough to compute line/column for a `slop`-style "file.jsonc:12:4: unexpected comma" error message.

- **Gap:** duplicate keys are **silently accepted**, no error raised — `{"a":1,"a":2}` parses to `{"a":2}` with `errors.length === 0`. If a human hand-corrupts a file by duplicating a key, `parse()` will not flag it. A3's "clear errors for hand-corrupted files" goal can't lean on `errors[]` for this case; if it matters, it needs a hand-rolled duplicate-key scan over `parseTree()`. Flagged as a known gap, not fixed here.

### 2. Comment preservation through `modify()` + `applyEdits()`

Baseline fixture: 7 comments. Tested every hard case named in the brief, counting comments before/after:

| Case | Comments before → after | Verdict |
|---|---|---|
| Edit a scalar deep in a nested object (`spec.summary`) | 7 → 7 | preserved |
| Add a new top-level key (default insertion point) | 7 → 7 | preserved, **appended at file end** |
| Add a key inside a nested, currently-empty object (`spec.meta.estimate_pts`) | 7 → 7 | preserved |
| **Remove a key with a comment attached above it** (`provenance`, preceded by `// provenance block`) | 7 → 6 | **comment destroyed** — deleted along with the property |
| **Remove an array element with a trailing inline comment** (`labels[1]`, `"type:feature" // second label`) | 7 → 6 | **comment destroyed** |
| Edit an array element (`spec.acceptance[0]`) | 7 → 7 | preserved |
| Append to an array (`labels`, `isArrayInsertion: true`) | 7 → 7 | preserved, but **comment visually migrates** — see below |
| Multi-line markdown string edit (`spec.details_md`, backslashes/quotes/tabs/code fences) | 7 → 7 | preserved; reparsed value `===` the exact string written (`true`) |

Two of these deserve the actual bytes:

**Comment destroyed on delete** — expected/acceptable (the comment "belongs" to what got deleted), but worth documenting so nobody is surprised:
```
// before: "// provenance block" sits directly above "provenance": {...}
// after modify(text, ["provenance"], undefined, {}):
"comment text still present in output? false
```

**Comment migration on append** — cosmetic surprise, not data loss. Original:
```jsonc
"labels": [
    "area:auth",
    "type:feature" // second label
  ],
```
After `modify(text, ["labels", -1], "priority:p2", { isArrayInsertion: true })`:
```jsonc
"labels": [
    "area:auth",
    "type:feature",
    "priority:p2" // second label
  ],
```
The comment stayed at the same *offset* in the file, but the new element was inserted before it, so it now visually trails the wrong item. Worth knowing when reading a diff; not a correctness problem.

**Markdown string round-trip** — the one place escaping could plausibly break, and it didn't:
```
round-trip errors: 0
details_md exact match after round-trip: true
```

### 3. Formatting stability / idempotency

Fully idempotent under repeated `modify()`+`applyEdits()` cycles with fixed `FormattingOptions`:

- Setting the same value 5x in a row → byte-identical output every round.
- Alternating between two values 6x → round 0 === round 2 === round 4 (and same for the odd rounds). No drift.
- 20 rounds of set/revert on two different fields → final text is **byte-identical** to the original (`text === orig` → `true`).
- Single-field edits touch **exactly one line** of a 41-line file (verified for both a `priority` edit and an `owner` edit) — this is the property the whole git-merge story depends on.

One nuance, not drift: running `format()` (full-document reformat, which we do **not** use in the write path — only `modify()`, which formats only what it touches) on our hand-authored fixture found 3 edits: it collapsed a human-inlined `"path": [...]` array onto multiple lines and dropped the final trailing newline. That's `format()` normalizing a file that wasn't already in canonical shape, not evidence of `modify()` drifting over repeated cycles — the idempotency tests above used only `modify()`+`applyEdits()`, never `format()`, and were perfectly stable. Related: the first time `modify()` touches an array that a human wrote inline, it **does** reflow it to one-element-per-line (verified directly) — a one-time normalization diff on first touch, then stable forever after, not repeated drift.

### 4. Whole-file canonical rewrite (`JSON.stringify(x, null, 2)`)

Destroys all comments unconditionally — trivially true, but measured precisely: our 7-comment, 41-line fixture becomes a 39-line comment-free file. Once *in* canonical form, however, subsequent single-field edits via parse→mutate-plain-object→stringify are just as diff-minimal as `modify()`: changing `priority` changed exactly 1 of 39 lines. So the cost of canonical rewrite isn't "noisier diffs" — diff size is a wash — the cost is **100% comment loss on every write**, which for a machine-only file (events) is free, and for a human-facing ticket file is the whole reason this spike exists.

### 5. Merge-friendliness — actual `git merge-file` runs

Simulated two clones editing *different* fields of the same ticket, for both candidate write strategies, plus a mixed agent/human case, plus a sanity-check real conflict to prove the test harness discriminates correctly.

```
$ git merge-file a.merged.jsonc base.jsonc b.jsonc     # JSONC surgical: priority (agent A) vs owner (agent B)
exit code: 0                                            # clean merge
  "priority": 3,
  "owner": "sam",                                        # both changes present, all 7 comments intact

$ git merge-file a.merged.json base.json b.json         # canonical JSON: same two fields
exit code: 0                                            # clean merge, both changes present

$ git merge-file c-a.merged.jsonc c-base.jsonc c-b.jsonc  # agent edits priority via modify(),
exit code: 0                                              # human hand-edits a comment concurrently
  // spec block: structured JSON with markdown inside (D10) -- see docs/spec.md   (human's edit kept)
  "priority": 3,                                                                   (agent's edit kept)

$ git merge-file conflict-a.merged.jsonc conflict-base.jsonc conflict-b.jsonc   # sanity check: SAME field,
exit code: 1                                                                     # different values (3 vs 0)
<<<<<<< conflict-a.merged.jsonc
  "priority": 3,
=======
  "priority": 0,
>>>>>>> conflict-b.jsonc                                                        # real conflict, correctly detected
```

**Conclusion: merge-friendliness is not the differentiator between the two write strategies.** Both produce line-localized diffs by construction, so `git merge-file`'s line-based three-way merge handles non-overlapping field edits cleanly either way — and the harness correctly reports a conflict when edits actually collide on the same line, confirming the clean-merge results above aren't a test artifact. The real differentiator is comment survival (favors surgical) versus a concrete correctness bug (favors canonical, or a safety net around surgical) — see below.

### Bug found: `modify()` corrupts inline arrays when removing the last element (stable `3.3.1`)

Not asked for explicitly, but surfaced while probing case 2/5 — a documented-but-unreleased upstream fix (commit "Fix off-by-one error in `modify()` when removing last array element", merged into `next` 2026-05-04) turned out to describe a bug that **reproduces cleanly and matters directly for this project**:

```ts
const doc = `{ "labels": ["a", "b", "c"] }`;   // human hand-wrote this inline in $EDITOR
const out = applyEdits(doc, modify(doc, ["labels", 2], undefined, { formattingOptions: FMT })); // remove last elem
// out = "{\n  \"labels\": [\n    \"a\",\n    \"b\"\"] }"     <-- malformed
// reparse: 4 parse errors, value becomes {"labels":["a","b","] }"]}   <-- silent data corruption
```

Precise trigger: an array written **inline** (all on one line, as a human commonly does by hand) with **≥2 elements**, when `modify()` removes the **last** element specifically. Confirmed **not** to happen when: the array is already multi-line (our own canonical formatting produces this, so a machine-only round-trip never hits it), the removal drops the array to zero elements, or a middle element is removed. Confirmed fixed in the unreleased `4.0.0-next.2`:

```ts
// same repro against jsonc-parser@4.0.0-next.2:
[inline 3-elem remove last (4.0.0-next.2)] errors=0  out="{\n  \"labels\": [\n    \"a\",\n    \"b\"\n  ]\n}"
```

This is directly reachable in v0: `slop edit` opens ticket files in `$EDITOR`, and nothing stops a human from writing `"labels": ["a", "b"]` inline; the very next `slop update --label -y` (removing the last label) — or dropping the last `spec.acceptance[]`/`spec.context[]` entry — would silently corrupt the file. This finding is why the write strategy below includes a mandatory validation step rather than trusting `modify()`'s output directly.

Also found while probing deletion behavior: `modify()` **throws a synchronous exception** (not a soft error, not an empty edit list) when asked to delete a path whose parent doesn't exist — e.g. an out-of-range array index, or a nested path where an intermediate key is missing — with the confusing message `"Can not delete in empty document"` even when the document isn't empty. Deleting a *nonexistent top-level* key, by contrast, is a silent no-op (`edits = []`, no throw). A3 must wrap every `modify()` call in `try/catch`; "no exception" is not a reliable success signal on its own.

---

## Consequences for A2

### Recommended API

```ts
import * as jsonc from "jsonc-parser";

const FMT: jsonc.FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n",
  insertFinalNewline: true,
};

/** Tolerant parse. Never throws. Always check `errors`. */
function parseJsonc<T>(text: string): { value: T; errors: jsonc.ParseError[] } {
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(text, errors, {
    allowTrailingComma: true,
    allowEmptyContent: false,
  });
  return { value, errors };
}

/** Human-readable error lines for A3's corrupted-file errors, e.g. "file.jsonc:12:4: CommaExpected". */
function formatParseErrors(file: string, text: string, errors: jsonc.ParseError[]): string[];

/** New file, or any machine-only file (events/, index.jsonc). No existing doc to preserve. */
function writeCanonical<T>(value: T): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/**
 * Update an existing human-facing file (ticket/session), preserving comments where possible.
 * `patch` is applied as a sequence of modify()+applyEdits() calls (value === undefined => delete).
 * `expectedAfter` is the domain object the patch is supposed to produce — used purely as a
 * validation oracle, never trusted blindly.
 *
 * Safety net (this is the point of the function, not an afterthought):
 *   1. If any single patch entry deletes the LAST element of an array, skip modify() for that
 *      write entirely and go straight to canonical (known 3.3.1 bug, see spike).
 *   2. Otherwise attempt the surgical patch via modify()+applyEdits(), wrapped in try/catch
 *      (modify() can throw on deleting nonexistent nested paths).
 *   3. Reparse the result. If errors.length > 0, OR the reparsed value doesn't deep-equal
 *      `expectedAfter`, discard the surgical result and fall back to writeCanonical(expectedAfter).
 *   4. Only ever write the surgical result to disk if it passed step 3 untouched.
 */
function writeUpdate<T>(
  existingText: string,
  patch: { path: jsonc.JSONPath; value: unknown }[],
  expectedAfter: T,
): string;
```

### What the round-trip property test can honestly assert

```
parse(write(x)).value  deepEquals  x       // ALWAYS — both writeCanonical and writeUpdate paths,
                                            // because writeUpdate's own safety net guarantees it
```
This is unconditional: `writeUpdate` never returns a result that fails its own reparse+deep-equal check, by construction (it falls back to `writeCanonical` if the surgical attempt doesn't pass). So A2's round-trip test can assert data-level equality with no caveats.

**Comment survival is conditional, and should be tested as such, not assumed:**
- Assert comments survive for: creating from an empty/no-existing-comments doc, editing an existing scalar (top-level or nested), adding a new key, editing an array element, appending to an array (note: a trailing comment on the previous last element may end up trailing the new element instead — test for comment *presence*, not exact line attachment).
- Assert comments are **expected to be lost** (don't assert survival) for: deleting a key or array element that has an attached comment (destroyed with it, expected), and any write that trips the validation fallback (rare, but by design silently degrades to canonical for that one write rather than corrupting the file).

### Documented limitation

Comment preservation on `writeUpdate` is **best-effort, not guaranteed** — every write funnels through a correctness check first, and correctness always wins over comment preservation. In the (expected to be rare) case a surgical patch fails validation, that write's comments are lost for that operation, but the file itself is never left malformed. This should be stated in user-facing docs for `slop edit` / hand-editing so nobody is surprised that an occasional edit silently loses a comment rather than corrupting data.

---

## Recommended `FormattingOptions`

```ts
{ tabSize: 2, insertSpaces: true, eol: "\n", insertFinalNewline: true }
```
Use this **exact object, shared as a single constant, in every writer in the codebase** — verified idempotent across repeated cycles only when the same options are used consistently (mixing `tabSize`/`eol` between writers would itself be a drift source, distinct from anything jsonc-parser does). Pair with a `.gitattributes` entry (`*.jsonc text eol=lf`) so a non-Linux clone can't reintroduce CRLF noise — not tested directly in this single-platform sandbox, but standard practice given how much the merge story depends on stable line endings.

---

## Known limitations / edge cases for A3

1. **Data-corruption bug in `modify()`@3.3.1**: removing the last element of an inline (single-line) array with ≥2 elements produces malformed JSON. Root-caused, reproduced, and confirmed fixed upstream in unreleased `4.0.0-next.2`. Mitigated by `writeUpdate`'s mandatory reparse-and-fallback (and the last-element special case) — but A3 should know this is *why* that safety net exists, not treat it as defensive boilerplate.
2. **`modify()` throws** on deleting a path through a missing intermediate object/array or an out-of-range array index (misleading `"Can not delete in empty document"` message). Deleting a nonexistent *top-level* key is a silent no-op instead. Always wrap `modify()` in `try/catch`; don't infer success from the absence of a thrown error alone.
3. **Duplicate keys are not a parse error.** `parse()` silently keeps the last occurrence. A hand-corrupted file with a duplicated key parses "cleanly." If this needs to be caught, it requires a hand-written check over `parseTree()` — not built in this spike, flagged as a gap.
4. **New keys are appended at file end**, not inserted in schema-declaration order, by `modify()`'s default insertion behavior. Cosmetic only, but means on-disk field order can drift from the zod schema's declared order as optional fields get backfilled onto older tickets over time.
5. **First programmatic touch to a hand-inlined array reflows it to multi-line.** One-time normalization diff, not repeated drift (verified: subsequent touches are idempotent) — but worth knowing so "why did this diff touch formatting I didn't ask for" has a documented answer.
6. **Comments attached to deleted content are destroyed with it** (both a leading standalone comment above a deleted key, and a trailing inline comment on a deleted array element) — reasonable behavior, but should be stated in `slop edit` docs.
7. `.jsonc` extension itself has no special git diff/merge driver configured anywhere in this spike — the clean merges above rely purely on line-based diffing behaving well because writes are diff-minimal by construction, not because git or `jsonc-parser` understand JSON structurally. Nothing to build here for v0, just don't assume git is doing anything JSON-aware.
