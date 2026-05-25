// TuneBridge Confirmation Dialog System
// ────────────────────────────────────────────────────────────────────────────
// A focused subsystem of the modal language for *decisions* (delete, discard,
// unsaved-changes, "already exists", and informational prompts). Confirmation
// dialogs are not forms — they're a single question with one clear answer.
//
// Design principles
// ─────────────────
// 1. UNIFORM SIZE. Every confirmation is exactly 420px wide. The body sets
//    the height; we do not stretch. (Long-form prompts get `wide` = 480px.)
// 2. UNIFORM TYPE. Title 15px / 600 / -0.01em. Body 13px / 1.5 / textSub.
//    Context strip 12px / textMuted. No exceptions.
// 3. UNIFORM ICON. A single 28×28 rounded tile, tinted by kind. Same stroke
//    weight (1.7) across every icon. Never the bare emoji-ish glyph from the
//    legacy dialogs.
// 4. UNIFORM FOOTER. macOS button order — Cancel on the left (ghost), the
//    committing action on the right (primary or destructive). Default-action
//    is keyboard-affordant via a focus ring.
// 5. NO ROW DIVIDER under the body. The footer is the only hairline; if the
//    dialog needs a "context" line about the affected item, it sits inside
//    the body as a quoted strip, never as a Group row.
// ────────────────────────────────────────────────────────────────────────────

// All icons live on a 24×24 grid and use `currentColor` so the kind sets the
// hue. User-supplied set: trash / warning / alert / info / checkmark. Drawn
// at the full tile size with no surrounding plate — just the tinted glyph.
const ICONS = {
  trash: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5V2.5H3C2.44772 2.5 2 2.94772 2 3.5V4.5C2 5.05228 2.44772 5.5 3 5.5H21C21.5523 5.5 22 5.05228 22 4.5V3.5C22 2.94772 21.5523 2.5 21 2.5H16V1.5C16 0.947715 15.5523 0.5 15 0.5H9C8.44772 0.5 8 0.947715 8 1.5Z"/>
      <path d="M3.9231 7.5H20.0767L19.1344 20.2216C19.0183 21.7882 17.7135 23 16.1426 23H7.85724C6.28636 23 4.98148 21.7882 4.86544 20.2216L3.9231 7.5Z"/>
    </svg>
  ),
  warning: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M9.82664 2.22902C10.7938 0.590326 13.2063 0.590325 14.1735 2.22902L23.6599 18.3024C24.6578 19.9933 23.3638 22 21.4865 22H2.51362C0.63634 22 -0.657696 19.9933 0.340215 18.3024L9.82664 2.22902ZM10.0586 7.05547C10.0268 6.48227 10.483 6 11.0571 6H12.9429C13.517 6 13.9732 6.48227 13.9414 7.05547L13.5525 14.0555C13.523 14.5854 13.0847 15 12.554 15H11.446C10.9153 15 10.477 14.5854 10.4475 14.0555L10.0586 7.05547ZM14 18C14 19.1046 13.1046 20 12 20C10.8954 20 10 19.1046 10 18C10 16.8954 10.8954 16 12 16C13.1046 16 14 16.8954 14 18Z"/>
    </svg>
  ),
  alert: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12C23 18.0751 18.0751 23 12 23C5.92487 23 1 18.0751 1 12ZM10.0586 6.05547C10.0268 5.48227 10.483 5 11.0571 5H12.9429C13.517 5 13.9732 5.48227 13.9414 6.05547L13.5525 13.0555C13.523 13.5854 13.0847 14 12.554 14H11.446C10.9153 14 10.477 13.5854 10.4475 13.0555L10.0586 6.05547ZM14 17C14 18.1046 13.1046 19 12 19C10.8954 19 10 18.1046 10 17C10 15.8954 10.8954 15 12 15C13.1046 15 14 15.8954 14 17Z"/>
    </svg>
  ),
  info: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12C23 18.0751 18.0751 23 12 23C5.92487 23 1 18.0751 1 12ZM10.25 11C10.25 10.4477 10.6977 10 11.25 10H12.75C13.3023 10 13.75 10.4477 13.75 11V18C13.75 18.5523 13.3023 19 12.75 19H11.25C10.6977 19 10.25 18.5523 10.25 18V11ZM14 7C14 5.89543 13.1046 5 12 5C10.8954 5 10 5.89543 10 7C10 8.10457 10.8954 9 12 9C13.1046 9 14 8.10457 14 7Z"/>
    </svg>
  ),
  checkmark: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M1 12C1 5.92487 5.92487 1 12 1C18.0751 1 23 5.92487 23 12C23 18.0751 18.0751 23 12 23C5.92487 23 1 18.0751 1 12ZM18.4158 9.70405C18.8055 9.31268 18.8041 8.67952 18.4127 8.28984L17.7041 7.58426C17.3127 7.19458 16.6796 7.19594 16.2899 7.58731L10.5183 13.3838L7.19723 10.1089C6.80398 9.72117 6.17083 9.7256 5.78305 10.1189L5.08092 10.8309C4.69314 11.2241 4.69758 11.8573 5.09083 12.2451L9.82912 16.9174C10.221 17.3039 10.8515 17.301 11.2399 16.911L18.4158 9.70405Z"/>
    </svg>
  ),
};

const KIND = {
  danger:  { tint: '#ffb3b5', icon: ICONS.trash     },
  warning: { tint: '#f0b429', icon: ICONS.warning   },
  prompt:  { tint: '#adc6ff', icon: ICONS.alert     },
  info:    { tint: '#adc6ff', icon: ICONS.info      },
  success: { tint: '#53e16f', icon: ICONS.checkmark },
};

// ── Icon glyph ───────────────────────────────────────────────────────────────
// Bare tinted glyph — no plate, no border. 24px box; the SVG fills it.
function KindTile({ kind = 'info' }) {
  const k = KIND[kind] || KIND.info;
  return (
    <div style={{
      width: 24, height: 24,
      flexShrink: 0,
      color: k.tint,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{k.icon}</div>
  );
}

// ── Context strip ───────────────────────────────────────────────────────────
// Sits inside the body as a quiet ledger row about the affected object —
// e.g. song name, playlist name, file path. Replaces the inconsistent
// "title — subtitle" line some legacy dialogs had.
function ContextStrip({ primary, secondary, swatch, mono = false }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 11px',
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: 7,
      minWidth: 0,
    }}>
      {swatch && (
        <div style={{
          width: 24, height: 24, borderRadius: 4, flexShrink: 0,
          background: swatch,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
        }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{
          fontSize: 12.5, color: T.text, fontWeight: 500,
          fontFamily: mono ? T.fontMono : 'inherit',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{primary}</div>
        {secondary && (
          <div style={{
            fontSize: 11.5, color: T.textMuted,
            fontFamily: mono ? T.fontMono : 'inherit',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{secondary}</div>
        )}
      </div>
    </div>
  );
}

// ── Confirmation dialog shell ────────────────────────────────────────────────
//
// Props
//   kind          'danger' | 'warning' | 'prompt' | 'info' | 'success'
//   title         short imperative or question. ends in "?" only if a question.
//   body          paragraph(s) explaining consequences. plain text or node.
//   context       optional <ContextStrip> describing the affected item.
//   confirmLabel  text for the committing button (e.g. "Delete", "Save").
//   confirmTone   'danger' | 'primary' | 'secondary'. Tone of the right button.
//   cancelLabel   defaults to "Cancel". Pass "" to hide the cancel button.
//   altLabel      optional 3rd action (e.g. "Discard" alongside Save/Cancel).
//                 placed leftmost; ghost style.
//   onConfirm     handler for right-most button.
//   onCancel      handler for cancel.
//   onAlt         handler for the third action.
//   onClose       handler for the × glyph. Defaults to onCancel.
//   wide          if true, dialog is 480px wide (for long-form prompts).
//   showClose     if false, hides the × in the title bar. Default true.
//
// Composition: <Confirm /> is a complete dialog. For one-off variants you can
// still compose ModalHeader + body + footer from modal-system.jsx directly.
function Confirm({
  kind = 'info',
  title,
  body,
  context,
  confirmLabel,
  confirmTone,
  cancelLabel = 'Cancel',
  altLabel,
  onConfirm,
  onCancel,
  onAlt,
  onClose,
  wide = false,
  showClose = true,
}) {
  // Default the right-button tone from the kind so calling code rarely needs
  // to specify it. Danger kinds get the danger tone; everything else uses the
  // accent primary.
  const tone = confirmTone || (kind === 'danger' ? 'danger' : 'primary');
  const close = onClose || onCancel;

  const Btn = tone === 'danger'
    ? (props) => <BtnDanger {...props} />
    : tone === 'secondary'
      ? (props) => <BtnSecondary {...props} />
      : (props) => <BtnPrimary {...props} />;

  return (
    <div style={{
      width: wide ? 480 : 420,
      fontFamily: T.font,
      color: T.text,
      background: '#1d1d1f',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12,
      boxShadow: '0 24px 56px rgba(0,0,0,0.5), 0 4px 10px rgba(0,0,0,0.35)',
      display: 'flex', flexDirection: 'column',
      overflow: 'visible',
    }}>
      {/* HEADER — icon tile + title + close */}
      <div style={{
        padding: '18px 18px 0',
        display: 'flex', alignItems: 'flex-start', gap: 12,
      }}>
        <KindTile kind={kind} />
        <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
          <div style={{
            fontSize: 15, fontWeight: 600, color: T.text,
            letterSpacing: '-0.01em', lineHeight: 1.3,
          }}>{title}</div>
        </div>
        {showClose && (
          <div style={{ marginTop: 2 }}>
            <CloseBtn onClick={close} />
          </div>
        )}
      </div>

      {/* BODY — copy + optional context strip. Flush-left so the body anchors
          under the icon, not under the title; avoids a dead "L" of whitespace
          on the left edge below the icon. */}
      <div style={{
        padding: '10px 18px 16px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        {body && (
          <div style={{
            fontSize: 13, color: T.textSub, lineHeight: 1.55,
          }}>{body}</div>
        )}
        {context}
      </div>

      {/* FOOTER — actions */}
      <div style={{
        padding: '11px 14px 13px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {altLabel ? (
          <BtnGhost onClick={onAlt}>{altLabel}</BtnGhost>
        ) : null}
        <div style={{ flex: 1 }} />
        {cancelLabel ? (
          <BtnSecondary onClick={onCancel}>{cancelLabel}</BtnSecondary>
        ) : null}
        <Btn onClick={onConfirm} autoFocus>{confirmLabel}</Btn>
      </div>
    </div>
  );
}

// ── Acknowledgement dialog ──────────────────────────────────────────────────
// One-button variant for purely informational moments (e.g. "Sync complete").
// Same shell, single primary button.
function Acknowledge({
  kind = 'success',
  title,
  body,
  context,
  buttonLabel = 'OK',
  onClose,
  wide = false,
}) {
  return (
    <Confirm
      kind={kind}
      title={title}
      body={body}
      context={context}
      confirmLabel={buttonLabel}
      cancelLabel=""
      onConfirm={onClose}
      onClose={onClose}
      wide={wide}
    />
  );
}

Object.assign(window, { Confirm, Acknowledge, ContextStrip, KindTile, KIND });
