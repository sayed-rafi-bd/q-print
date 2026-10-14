# Plan: custom templates + per-template data generators

Status: proposal · Repo: `q-print` (Tauri 2 + React + pdfme)

## 1. Goal

Today the app ships two fixed labels (`shipping`, `product`). Each has a bundled pdfme template and a
hard-coded Rust function that makes random data for it. The user can *edit* those two templates but cannot
add a third, and cannot change what random data they get.

After this work the user can:

1. Create, duplicate, rename and delete their own templates (any page size).
2. Define, per template, how each field is filled with random data, without writing or compiling code.
3. Preview the result, print it, and move template and generator together to another device (desktop → Android).

Non-goals: custom fonts, multi-page templates with different data per page, scripting/JS in generators,
cloud sync.

## 2. What exists now (and why it blocks this)

| Concern | Where | Problem for this feature |
|---|---|---|
| Label list | `LABELS` array in `src/labels.ts`, `LabelId = 'shipping' \| 'product'` | Fixed at build time; id is a closed union type |
| Label id validation | `LABEL_IDS` + `label_id()` in `src-tauri/src/lib.rs` | Second hard-coded copy of the list; also guards file names |
| Data generators | `generate_shipping_data`, `generate_product_data`, matched in `generate_random_data` | Rust code, one struct per label; users can't add or edit |
| Template storage | `load_template` / `save_template` / `reset_template`, one file per label in `app_data_dir` (`label-template.json`, `label-template-product.json`) | Stores an *override* of a built-in only; no concept of a user-created label |
| Page size | `widthMm` / `heightMm` hard-coded in `LABELS`, used by `PrintPage` | Goes stale if the Designer changes the size of the template |
| Field ↔ data link | pdfme field **name** must equal a key of the generated row | This convention is good and stays; there is just no UI to manage it |
| Transfer | `TemplateTransfer.tsx` moves only the pdfme template JSON | Would lose the generator on export |

Also hard-coded in the generators: dates like `2026/10/..` and `2610..`. These go stale and should become
relative to today.

## 3. Design decisions

### 3.1 Generators are data, not code

A user-defined generator cannot be Rust (it would need a rebuild) and should not be arbitrary JS (security,
and Android WebView portability). So each template gets a **declarative generator spec**: a JSON document
with one rule per template field, interpreted by one generic engine.

### 3.2 The engine runs in TypeScript

- Works identically on Windows, Linux and Android with no Rust change per rule type.
- Easy to unit test (pure function, injectable RNG and clock).
- Rows are consumed in TS anyway (`printLabels` passes them to pdfme `generate`).

The built-in Rust generators get re-expressed as specs (Phase 2) so "duplicate a built-in" copies a real,
editable generator. Once parity is verified, the Rust generators and `LABEL_IDS` are deleted.

### 3.3 One file per custom label, holding everything

A custom label is a single JSON file (template + generator + metadata), written atomically. This avoids
template and generator drifting apart and makes export/import trivial.

Built-ins keep their current override files (`label-template*.json`), so nobody's existing saved
template is touched. No migration is required.

### 3.4 Label size comes from the template

`widthMm`/`heightMm` are derived from `template.basePdf` instead of being stored separately. This also fixes
the existing staleness for built-ins that were resized in the Designer.

## 4. Data model

```ts
// src/labels.ts
export type LabelId = string;            // was a union; now slug, e.g. "shipping", "my-parcel-2"

export type LabelMeta = {
  id: LabelId;
  name: string;
  builtin: boolean;
  widthMm: number;                       // derived from template.basePdf at load time
  heightMm: number;
};

// File format for a custom label and for export/import ("bundle")
export type LabelBundle = {
  format: 'q-print-label';
  version: 1;
  name: string;
  template: Template;                    // pdfme
  generator: GeneratorSpec;
};
```

### Generator spec (v1)

```ts
export type GeneratorSpec = {
  version: 1;
  /** Correlated data: one row is chosen per page, so zip and address always match. */
  tables?: Record<string, { columns: string[]; rows: string[][] }>;
  /** key = pdfme field name in the template */
  fields: Record<string, FieldRule>;
};

type Common = { prefix?: string; suffix?: string; transforms?: ('digits-only' | 'upper' | 'lower')[] };

export type FieldRule = Common & (
  | { kind: 'fixed';    value: string }
  | { kind: 'digits';   length: number }                                  // "0123456789012"
  | { kind: 'int';      min: number; max: number; step?: number; format?: 'plain' | 'thousands' | 'yen' }
  | { kind: 'pick';     values: string[] }                                // random one of N
  | { kind: 'table';    table: string; column: string }                   // same row for the whole page
  | { kind: 'date';     offsetDays: [number, number]; format: string }    // relative to today
  | { kind: 'pattern';  pattern: string }                                 // "A{d12}A", "{D3}-{d4}"
  | { kind: 'sequence'; start: number; step?: number; pad?: number }
  | { kind: 'copy';     from: string }                                    // derived from another field
);
```

How the current Rust data maps onto this (proves the spec is expressive enough):

| Current Rust behaviour | Rule |
|---|---|
| `zip` = `"〒" + zip`, `address` from the same `DESTINATIONS` row | `table` rule on column `zip` with `prefix: "〒"`, `table` rule on column `address` |
| `zipBarcode` = zip with `-` removed | `table` column `zip` with `transforms: ['digits-only']` |
| `tel` = `"TEL:0" + 10 digits` | `digits` length 10 with `prefix: "TEL:0"` |
| `recipient` = random name + `様` | `pick` with `suffix: "様"` |
| `inquiryNo` = `A` + 12 digits + `A` | `pattern: "A{d12}A"` |
| `amount` = `¥` + hundreds up to 3,900 | `int` min 100, max 3900, step 100, format `yen` |
| `shipDate` / `deliveryDate` (+2 days) | `date` `[0,0]` and `[2,2]` — see note below |
| `trackingText` = same as `trackingBarcode` | `copy` from `trackingBarcode` |
| `warehouse`, `operator`, `senderName` … | `fixed` |

Note: `shipDate` and `deliveryDate` are independent `date` rules, so a delivery date can't be tied to the
exact same random ship date. If that matters, add `{ kind: 'date', relativeTo: '<field>', offsetDays }` in v1.1.

Rules for the engine:

- Evaluated in dependency order (`copy` → its source first); cycles are a validation error.
- Unknown pattern tokens, empty `pick`/`table`, missing table/column, `min > max` are validation errors with a
  message naming the field.
- Signature: `generateRows(spec, count, { now = new Date(), rng = Math.random })` so tests can be deterministic.
- Hard limits: `count` ≤ 10 000, tables ≤ 5 000 rows, spec ≤ 1 MB.

## 5. User-facing behaviour

### Designer tab

- **Label picker** lists built-ins and custom labels (custom ones marked).
- Next to it: **New**, **Duplicate**, **Rename**, **Delete** (delete asks for confirmation; built-ins can only be
  *reset*, not deleted).
- **New template dialog:** name · size (presets such as 110×86, 190×160, A6, plus custom mm) · start from
  *Blank* or *Copy of…* (copies template **and** generator).
- Designer area gets two sub-tabs: **Layout** (today's pdfme designer) and **Data** (new generator editor).
- Single **Save** button saves layout and data together. The "unsaved changes" indicator covers both.

### Data tab (generator editor)

- One row per template field that can receive data (all non-`readOnly` pdfme fields). Each row: field name,
  its type (text / barcode / qr), rule picker, rule parameters, and a live sample value.
- **Auto-scaffold:** when a field appears in the Layout and has no rule, a row is added with a sensible default
  (`pick` with placeholder values for text, `digits` for barcodes) and highlighted as "new".
- **Orphaned rules:** if a field is renamed or deleted in the Layout, its rule is not silently dropped. It moves
  to an "Unused rules" list with *Reassign to…* and *Delete*.
- **Tables:** simple grid editor (add column, add row, paste from clipboard / import CSV).
- **Preview data** button generates one row. **Preview label** renders it using `@pdfme/ui`'s `Viewer`
  (already a dependency) so the user sees the real result before printing.
- Validation messages shown inline, with Save disabled while the spec is invalid.

### Barcode safety

pdfme throws if barcode content is invalid for its type (for example non-digits in `nw7`/`ean13`, wrong length
for `ean13`), and that would fail a whole print job. So:

- Each barcode field shows the constraint for its type next to the rule.
- On Save and on Preview, run `generate()` once with a sample row; a failure is reported as
  "Field `itemBarcode` (code128): <reason>" instead of failing at print time.
- Optional later rule: `{ kind: 'checkdigit', scheme: 'ean13' | 'jan13', from }`.

### Print tab

- Label list includes custom labels; remembered last label falls back to the default if it was deleted.
- Page size shown comes from the template (see 3.4).
- The result summary already says which template source was used; custom labels show as "custom label".

### Transfer (desktop → phone)

- Export now produces a **bundle** (`format: "q-print-label"`, template + generator + name).
- Import accepts a bundle (creates or updates a custom label) **and** a plain pdfme template (current behaviour:
  replaces the selected label's template, keeps its generator).
- Phones can't use the Designer, but they can print any custom label that was imported.

## 6. Storage and Rust changes

Location: `app_data_dir()/labels/<id>.json` for custom labels. Built-in override files stay where they are.

New Rust commands (replacing the label-specific parts of `lib.rs`):

| Command | Purpose |
|---|---|
| `list_custom_labels() -> Vec<LabelFileSummary>` | id + name for the registry; skips unreadable files and reports them instead of failing |
| `load_custom_label(id) -> String` | bundle JSON |
| `save_custom_label(id, json) -> String` | validate JSON, atomic write (temp file + rename) |
| `delete_custom_label(id)` | remove file |

Changes to existing commands:

- `label_id()` / `LABEL_IDS` → generic `validate_id(&str)`: `^[a-z0-9][a-z0-9-]{0,39}$`. Needed because the id becomes
  a file name (path traversal). For built-ins the two known ids keep their legacy file names.
- `generate_random_data` and the two generator functions are removed at the end of Phase 2.
- No new Cargo dependencies. No capability/permission changes (all commands are in-process).

## 7. TypeScript changes

| File | Change |
|---|---|
| `src/labels.ts` | Static `LABELS` → async **label registry** (`listLabels`, `getLabel`, `createLabel`, `duplicateLabel`, `renameLabel`, `deleteLabel`). `LabelId` becomes `string`. Keep `loadLastLabel` / `rememberLabel`. |
| `src/templateStore.ts` | `getTemplate` resolves built-in (override or default) or custom. Gains `getGenerator`, `saveLabel(bundle)`. `withFont` stays. |
| `src/generator/engine.ts` (new) | `generateRows`, `validateSpec`, `scaffoldSpec(template)`. Pure, no Tauri imports. |
| `src/generator/builtins.ts` (new) | Specs equivalent to the current Rust generators. |
| `src/printApi.ts` | `printLabels` calls `generateRows` instead of `invoke('generate_random_data')`. Rest unchanged. |
| `src/DesignerPage.tsx` | Label management buttons, Layout/Data sub-tabs, combined dirty state, orphan detection on `onChangeTemplate`, preview. The component is already ~265 lines, so split out `LabelToolbar`, `DataEditor`, `PreviewDialog`. |
| `src/PrintPage.tsx` | Use registry list; page size from template; handle "label deleted" state. |
| `src/TemplateTransfer.tsx` | Bundle export/import with backward-compatible plain-template import. |
| `README.md` | Replace the "To add another label…" paragraph with the new workflow; document the bundle format and rule types. |

## 8. Phases

Each phase leaves the app working and shippable.

### Phase 0 — Test harness (½ day)
- Add `vitest` (there are no tests today) and a `test` script; add a Rust `#[cfg(test)]` module for id validation.
- **Done when:** `pnpm test`, `pnpm typecheck`, `cargo test` pass in CI/locally.

### Phase 1 — Label registry and storage (1–1.5 days)
- Rust CRUD commands, `validate_id`, atomic write.
- TS registry; `LabelId` → `string`; Designer/Print use the registry; built-ins still use the Rust generators.
- **Done when:** behaviour is identical to today with only built-ins; a hand-placed file in `labels/` appears in the
  picker and prints (using a temporary hard-coded generator).
- **Risks:** touching every `LabelId` usage; the Android file path (`app_data_dir`) differs, so test there.

### Phase 2 — Generator engine and built-in specs (2 days)
- Implement all rule kinds, dependency ordering, validation, limits, with unit tests (deterministic RNG).
- Write specs for `shipping` and `product`. Parity tests: for each field, generated values match the same
  pattern the Rust version produced (regex per field), and every barcode field is valid.
- Switch `printLabels` and the Designer to the TS engine; delete the Rust generators and `generate_random_data`.
- **Done when:** both built-ins print as before; no `generate_random_data` references remain; dates are relative to today.

### Phase 3 — Create/duplicate/rename/delete (1.5 days)
- Label toolbar and New-template dialog; duplicate copies template and generator.
- Custom label gets `scaffoldSpec(template)` generator by default.
- **Done when:** a user can create a blank 100×50 label, add two text fields and a barcode in the Layout, and print
  it with scaffolded data, all without touching code.

### Phase 4 — Data editor and preview (3–4 days) — largest phase
- Rule editors per kind; table grid editor with CSV import and paste; orphaned-rule handling; live sample values.
- Preview using pdfme `Viewer`; barcode validation on Save/Preview.
- Combined dirty tracking and unsaved-changes prompts when switching labels.
- **Done when:** the user can recreate the *shipping* generator from scratch in the UI, and invalid specs cannot be saved.

### Phase 5 — Transfer, Android, docs (1–1.5 days)
- Bundle export/import with legacy plain-template import.
- Print tab list/size updates; verify on a phone (import + print) and tablet (Designer).
- README and RELEASE notes.
- **Done when:** a label made on desktop, exported, imported on Android, prints with the same layout and generated data.

Rough total: **9–11 working days**. Phases 1–3 deliver "custom templates + auto data"; Phase 4 delivers
"my own generator".

## 9. Testing

- **Unit (vitest):** every rule kind (boundaries, formats, prefix/suffix/transforms), `copy` ordering and
  cycles, table row consistency within a page, deterministic output with a seeded RNG, validation errors,
  `scaffoldSpec` for each pdfme field type, bundle parse/serialise round trip.
- **Rust:** `validate_id` rejects `../x`, empty, uppercase, >40 chars; atomic write leaves the old file intact
  if the write fails; corrupt file in `labels/` doesn't break `list_custom_labels`.
- **Manual matrix** (Windows, Linux, Android phone, Android tablet): create → save → restart app → still there;
  duplicate built-in; rename field in Layout → orphaned rule appears; invalid barcode content → message, not a
  failed print; delete selected label; import legacy plain template JSON; large job (>50 pages, which uses the raw
  path in `printLabels`) with a custom label.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rule UI grows into a mini-programming language | Fixed small rule set; `pattern` + `table` + `copy` cover most real needs; no scripting in v1 |
| Invalid barcode data breaks printing | Validate with a trial `generate()` on Save/Preview; per-type hints |
| User renames a field and silently loses its rule | Orphaned-rule list with reassign |
| Path traversal via label id | Strict slug validation in Rust; ids never taken from user text directly (derived slug + uniqueness suffix) |
| Corrupt or hostile imported bundle | Size cap (e.g. 5 MB), schema check, `validateSpec`, no code execution anywhere |
| Behaviour change when built-ins move to relative dates | Intentional; call it out in `RELEASE.md` |
| `DesignerPage` becomes unmanageable | Split into three components in Phase 3/4 before adding features |
| Android differences (storage path, tablet-only Designer) | Test each phase on device; phones only import/print |

## 11. Open questions (decide before Phase 2)

1. **Sequence persistence:** should `sequence` restart at `start` on every print job (simple, proposed), or continue
   across jobs (needs a stored counter per label)?
2. **Real data instead of random:** do you also want "import a CSV and print one label per row"? It reuses the
   `table` machinery and would be a small add-on, but changes the Print tab (no page count) — proposed as a
   follow-up, not in this plan.
3. **Built-ins:** keep them undeletable (proposed), or allow hiding/deleting them once users have their own?
4. **Deterministic runs:** is an optional "seed" field useful for repeatable test prints?
5. **Rule coverage:** are there generator types from your real labels not covered by section 4 (for example a
   checksummed tracking number, or weighted choices)?
