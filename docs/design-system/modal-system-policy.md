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
### Pass 1 (in progress)
- Sync modal
- Core action/form modals next (settings, confirm, DAP, IEM, PEQ, tag editors)

### Pass 2
- Remaining modal families (insight/media/utility)

## Guardrail Enforcement
Run:
```bash
python3 scripts/check_modal_design_system.py
```

Current strict enforcement target:
- `sync-modal`

Other modal families are tracked in migration docs and will become strict once migrated.
