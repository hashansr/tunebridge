# Modal System Policy (Enforced)

All new or updated TuneBridge modals must use the design-system primitives.

## Mandatory Checklist
- Uses `.tb-modal-shell` and one approved size tier.
- Uses tokenized colors/spacing/radius/shadow.
- Uses shared header/body/footer anatomy.
- Uses shared button/input primitives.
- No inline visual styles in modal markup.
- Keyboard/escape behavior follows existing modal interaction patterns.
- If modal is destructive, includes explicit confirmation UX.

## Migration Strategy
### Pass 1 (done)
- Sync modal
- Core action/form modals (settings, confirm, DAP, IEM, PEQ, tag editors)

### Pass 2 (done with documented exceptions)
- Remaining modal families (insight/media/utility)
- Exceptions: onboarding full-screen modal and custom IEM compare dialog shell

## Guardrail Enforcement
Run:
```bash
python3 scripts/check_modal_design_system.py
```

Strict enforcement targets:
- all modal roots must use `.tb-modal-overlay` (except documented exceptions)
- standardized modal shells must use `.tb-modal-shell` and an approved size tier
- sync-modal family remains under additional tokenization/inline-style checks
