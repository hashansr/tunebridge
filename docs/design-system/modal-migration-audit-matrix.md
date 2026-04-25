# Modal Migration Audit Matrix

Status legend: `done`, `in-progress`, `pending`, `exception`

| Modal ID | Family | Status | Notes |
|---|---|---|---|
| sync-modal | sync | done | Shared shell, tokenized visuals, bottom step rail, and advanced discrepancy workflows preserved |
| confirm-modal | confirm | done | Shared shell + size tier standardized |
| settings-modal | form | done | Shared shell + size tier standardized |
| dap-modal | form | done | Shared shell + size tier standardized |
| iem-modal | form | done | Shared shell + size tier standardized |
| peq-modal | form | done | Shared shell + size tier standardized |
| tag-editor-modal | form | done | Shared shell + size tier standardized |
| album-tag-modal | form | done | Shared shell + size tier standardized |
| artist-rename-modal | form | done | Shared shell + size tier standardized |
| create-playlist-modal | action | done | Shared shell + size tier standardized |
| onboarding-modal | onboarding | exception | full-screen exception by design |
| iem-compare-modal | utility | exception | custom compare dialog layout retained; root overlay standardized |
| problem-tracks-modal | insights | done | Shared shell + size tier standardized |
| genre-distribution-modal | insights | done | Shared shell + size tier standardized |
| iem-blindspot-modal | insights | done | Shared shell + size tier standardized |
| missing-tags-bulk-modal | insights | done | Shared shell + size tier standardized |
| dup-modal | utility | done | Shared shell + size tier standardized |
| import-modal | utility | done | Shared shell + size tier standardized |
| help-modal | utility | done | Shared shell + size tier standardized |
| rename-modal | utility | done | Shared shell + size tier standardized |
| ml-gen-modal | utility | done | Shared shell + size tier standardized |
| sr-modal | utility | done | Shared shell + size tier standardized |
| ml-ref-modal | utility | done | Shared shell + size tier standardized |
| album-art-modal | media | done | Shared shell + size tier standardized |
| artist-image-modal | media | done | Shared shell + size tier standardized |

## Review Workflow
1. Migrate modal to primitives/tokens.
2. Run `python3 scripts/check_modal_design_system.py`.
3. Verify behavior parity and accessibility.
4. Update this matrix status + changelog entry.
