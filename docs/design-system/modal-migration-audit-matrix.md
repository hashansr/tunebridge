# Modal Migration Audit Matrix

Status legend: `done`, `in-progress`, `pending`, `exception`

| Modal ID | Family | Status | Notes |
|---|---|---|---|
| sync-modal | sync | in-progress | Migrated to shared shell + tokenized styling; advanced discrepancy actions preserved |
| confirm-modal | confirm | in-progress | shared shell tier adopted; full token cleanup pending |
| settings-modal | form | in-progress | shared shell tier adopted; inline style cleanup pending |
| dap-modal | form | in-progress | shared shell tier adopted; dense form tokens pending |
| iem-modal | form | in-progress | shared shell tier adopted; dense form tokens pending |
| peq-modal | form | in-progress | shared shell tier adopted; control token cleanup pending |
| tag-editor-modal | form | in-progress | shared shell tier adopted; per-field token cleanup pending |
| album-tag-modal | form | in-progress | shared shell tier adopted; per-field token cleanup pending |
| artist-rename-modal | form | in-progress | shared shell tier adopted; token cleanup pending |
| create-playlist-modal | action | in-progress | shared shell tier adopted; action-row token cleanup pending |
| onboarding-modal | onboarding | exception | full-screen exception by design |
| iem-compare-modal | utility | pending | pass 2 |
| problem-tracks-modal | insights | pending | pass 2 |
| genre-distribution-modal | insights | pending | pass 2 |
| iem-blindspot-modal | insights | pending | pass 2 |
| missing-tags-bulk-modal | insights | pending | pass 2 |
| dup-modal | utility | pending | pass 2 |
| import-modal | utility | pending | pass 2 |
| help-modal | utility | pending | pass 2 |
| rename-modal | utility | pending | pass 2 |
| ml-gen-modal | utility | pending | pass 2 |
| sr-modal | utility | pending | pass 2 |
| ml-ref-modal | utility | pending | pass 2 |
| album-art-modal | media | pending | pass 2 |
| artist-image-modal | media | pending | pass 2 |

## Review Workflow
1. Migrate modal to primitives/tokens.
2. Run `python3 scripts/check_modal_design_system.py`.
3. Verify behavior parity and accessibility.
4. Update this matrix status + changelog entry.
