# Studio Name Trimming Design

## Goal

Prevent leading or trailing whitespace in configured studio names from breaking the exact-name match with calendar events.

## Behavior

- When the studio-name input loses focus, trim leading and trailing whitespace before updating application state.
- The trimmed name is the only name used by the immediate cached-event reparse and calendar synchronization.
- Also trim studio keys during config load and save so manually edited or older YAML files are normalized.
- Preserve whitespace inside a studio name.
- Reject a name that is empty after trimming.
- Reject a trimmed name that duplicates another configured studio name.
- Show an inline error beside the studio-name input for empty or duplicate names. Keep the existing studio key unchanged until the user enters a valid name.

## Components

### Config normalization

Add a focused studio-record normalization step in `validateConfig`. It trims each studio key before constructing `AppConfig.studios`, rejects empty keys, and detects collisions before assigning normalized keys. This protects both config loading and saving.

### Rename interaction

Extract a pure rename helper from the Rates tab. It accepts the studio record, old name, and proposed name, then returns one of:

- `{ ok: true, name, studios, changed }` with the normalized name and resulting record.
- `{ ok: false, error }` without a changed record.

The helper trims the proposed name and validates empty and duplicate cases. A proposed name that trims to the old name is a successful no-op (`changed: false`), not a duplicate.

On blur, `StudioCard` calls its rename callback and handles the result. On success it replaces the draft with the normalized name and clears any stale error. The parent calls `onUpdate` only when `changed` is true. On failure it keeps the existing studio key and displays the returned error inline; no config update or calendar synchronization occurs.

The rename updates in-memory config immediately. Existing React dependencies then reparse cached events and trigger calendar synchronization using the normalized key; Save remains responsible only for persistence.

## Error handling

- Empty: `Studio name cannot be empty.`
- Duplicate: `A studio named "<name>" already exists.`
- Invalid YAML studio keys fail config validation with the same specific cause rather than silently overwriting another studio.

## Tests

- Config validation trims a studio key.
- Config validation rejects an all-whitespace studio key.
- Config validation rejects two keys that become identical after trimming.
- A serialization round trip validates first and proves that the normalized studio key is written to YAML.
- The rename helper trims leading/trailing whitespace.
- The rename helper preserves internal whitespace.
- The rename helper rejects empty and duplicate names without changing the studio record.
- The rename helper treats the normalized current name as a successful no-op.
- Component coverage verifies blur normalization, unchanged config on failure, inline errors, and error clearing after a subsequent valid rename.
- Tauri E2E coverage verifies that a whitespace-padded rename is normalized on blur and persists after Save.
- Existing unit, TypeScript, and Tauri E2E suites remain green. The E2E suite is required because the studio-name input behavior changes.

## Non-goals

- Trimming teacher, bank, address, e-mail, calendar, or invoice-number fields.
- Changing calendar event parsing or making studio matching whitespace-insensitive.
- Changing when calendar synchronization runs.
