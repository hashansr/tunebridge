// TuneBridge Modal System — Mac/iOS-flavoured primitives
// ────────────────────────────────────────────────────────────────────────────
// Visual direction:
//   • macOS sheet — soft obsidian gradient, 1px highlight rim, soft ambient shadow.
//   • Title row reads like a Finder/System Settings sheet: compact title + sub +
//     close affordance. No giant accent icon unless content demands it.
//   • Grouped inset cards (NSTableView "inset grouped" / iOS Settings) hold the
//     fields. Internal hairlines, sentence-case row labels left, controls right.
//   • Section headers are small uppercase eyebrows sitting *above* a group.
//   • Form controls are styled to feel like AppKit popup-buttons, segmented
//     controls, steppers, and iOS-style toggles — not browser defaults.
//   • Spacing is tighter than a typical web modal; nothing floats orphaned.
// ────────────────────────────────────────────────────────────────────────────

const { useState, useRef, useEffect, useLayoutEffect } = React;

const T = {
  // Surface — flat, matte. No gradient, no glass.
  modalBg:        '#1d1d1f',
  modalBorder:    '1px solid rgba(255,255,255,0.07)',
  modalRing:      'none',
  modalShadow:    '0 24px 56px rgba(0,0,0,0.5), 0 4px 10px rgba(0,0,0,0.35)',

  // Section/group: transparent containers, no boxes
  groupBg:        'transparent',
  groupBgInset:   'transparent',
  groupBorder:    'none',
  rowDivider:     '1px solid rgba(255,255,255,0.06)',

  fieldBg:        '#2a2a2c',
  fieldBgHover:   '#303032',
  fieldBorder:    '1px solid rgba(255,255,255,0.07)',
  fieldShadow:    'none',
  fieldFocusRing: '0 0 0 3px rgba(173,198,255,0.22), 0 0 0 1px rgba(173,198,255,0.75) inset',

  // Text
  text:           '#e8e6e5',
  textSub:        '#c1c6d7',
  textMuted:      '#8a8a96',
  textDim:        '#6b6b7b',

  // Accent
  accent:         '#adc6ff',
  accentInk:      '#0a1f47',
  accentDim:      'rgba(173,198,255,0.14)',
  success:        '#53e16f',
  warn:           '#f0b429',
  danger:         '#ffb3b5',

  font: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
  fontMono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

// ── Modal shell ──────────────────────────────────────────────────────────────
function Modal({ width = 560, children, chrome = 'compact', style }) {
  return (
    <div style={{
      width, fontFamily: T.font, color: T.text,
      background: T.modalBg,
      border: T.modalBorder,
      borderRadius: 12,
      boxShadow: T.modalShadow,
      overflow: 'visible',
      display: 'flex', flexDirection: 'column',
      ...style,
    }}>
      {chrome === 'traffic' && <TrafficLights />}
      {children}
    </div>
  );
}

function TrafficLights() {
  return (
    <div style={{
      display: 'flex', gap: 8, padding: '11px 14px 0',
      flexShrink: 0,
    }}>
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fc6058', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.2)' }} />
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fec22b', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.2)' }} />
      <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#37c941', boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.2)' }} />
    </div>
  );
}

function ModalHeader({ title, subtitle, onClose, eyebrow, icon }) {
  return (
    <div style={{
      padding: '18px 20px 14px',
      display: 'flex', alignItems: 'flex-start', gap: 10,
      flexShrink: 0,
    }}>
      {icon && (
        <div style={{
          width: 22, height: 22, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: T.accent, marginTop: 2,
        }}>{icon}</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {eyebrow && (
          <div style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em',
            textTransform: 'uppercase', color: T.accent, marginBottom: 4,
          }}>{eyebrow}</div>
        )}
        <div style={{
          fontSize: 17, fontWeight: 600, letterSpacing: '-0.014em',
          color: T.text, lineHeight: 1.25, marginBottom: subtitle ? 3 : 0,
        }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45 }}>{subtitle}</div>
        )}
      </div>
      <CloseBtn onClick={onClose} />
    </div>
  );
}

function CloseBtn({ onClick }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        background: h ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.05)',
        color: h ? T.text : T.textMuted,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', fontFamily: 'inherit', padding: 0,
        transition: 'background 0.12s, color 0.12s',
      }}>
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M2 2l8 8M10 2l-8 8"/>
      </svg>
    </button>
  );
}

function ModalBody({ children, style, scrolly = true }) {
  return (
    <div style={{
      flex: 1, padding: '4px 20px 20px',
      overflowY: scrolly ? 'auto' : 'visible',
      overflowX: 'visible',
      display: 'flex', flexDirection: 'column', gap: 18,
      ...style,
    }}>{children}</div>
  );
}

function ModalFooter({ left, children }) {
  return (
    <div style={{
      padding: '12px 18px 14px',
      display: 'flex', alignItems: 'center', gap: 8,
      flexShrink: 0,
      borderTop: '1px solid rgba(255,255,255,0.06)',
      background: 'transparent',
    }}>
      <div style={{
        flex: 1, minWidth: 0, fontSize: 12, color: T.textMuted,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{left}</div>
      {children}
    </div>
  );
}

// ── Section + Group + Row ────────────────────────────────────────────────────
function Section({ title, hint, action, children }) {
  return (
    <div>
      {(title || hint || action) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 0 6px',
        }}>
          {title && (
            <div style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: T.textMuted,
              flexShrink: 0,
            }}>{title}</div>
          )}
          {hint && (
            <div style={{
              flex: 1, minWidth: 0,
              fontSize: 11.5, color: T.textDim,
              textAlign: action ? 'left' : 'right',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{hint}</div>
          )}
          {action && (
            <div style={{ marginLeft: hint ? 0 : 'auto', flexShrink: 0 }}>{action}</div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function Group({ children, style }) {
  // Flat row stack — no card, no border, no clip. Rows separated by hairlines.
  // First row gets a top hairline; subsequent rows get bottom dividers.
  return (
    <div style={{
      borderTop: '1px solid rgba(255,255,255,0.06)',
      ...style,
    }}>{children}</div>
  );
}

// A single row inside a Group. label sits left, control(s) right.
// When `stacked`, label sits on top and the control fills the row width.
function Row({ label, help, hint, children, stacked = false, last = false, dense = false, align = 'center' }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: stacked ? 'column' : 'row',
      alignItems: stacked ? 'stretch' : align === 'top' ? 'flex-start' : 'center',
      gap: stacked ? 8 : 12,
      padding: dense ? '8px 2px' : stacked ? '12px 2px' : '11px 2px',
      borderBottom: T.rowDivider,
    }}>
      {label && (
        <div style={{
          fontSize: 13, color: T.text,
          flexShrink: 0,
          width: stacked ? 'auto' : 160,
          paddingTop: stacked ? 0 : align === 'top' ? 7 : 0,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{label}</span>
          {help && <HelpDot tip={help} />}
        </div>
      )}
      <div style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {children}
        </div>
        {hint && <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.4 }}>{hint}</div>}
      </div>
    </div>
  );
}

function HelpDot({ tip }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <span style={{
        width: 14, height: 14, borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.18)',
        color: T.textMuted, fontSize: 10, fontWeight: 600,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'help',
      }}>?</span>
      {show && tip && (
        <span style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(20,20,22,0.98)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 6, padding: '6px 9px',
          fontSize: 11, color: T.textSub, whiteSpace: 'nowrap',
          boxShadow: '0 8px 20px rgba(0,0,0,0.4)',
          zIndex: 50,
        }}>{tip}</span>
      )}
    </span>
  );
}

// ── Text field ───────────────────────────────────────────────────────────────
function Field({ value, onChange, placeholder, type = 'text', monospace = false, prefix, suffix, width, autoFocus, multiline = false, rows = 3 }) {
  const [focus, setFocus] = useState(false);
  const baseStyle = {
    width: width || '100%',
    padding: '7px 11px',
    background: T.fieldBg,
    border: T.fieldBorder,
    borderRadius: 7,
    color: T.text,
    fontSize: 13,
    fontFamily: monospace ? T.fontMono : 'inherit',
    outline: 'none',
    boxShadow: focus ? T.fieldFocusRing : 'none',
    transition: 'box-shadow 0.12s, background 0.12s',
  };
  if (multiline) {
    return (
      <textarea rows={rows} value={value || ''}
        placeholder={placeholder}
        onChange={e => onChange && onChange(e.target.value)}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        autoFocus={autoFocus}
        style={{ ...baseStyle, resize: 'vertical', lineHeight: 1.5 }} />
    );
  }
  if (prefix || suffix) {
    return (
      <div style={{
        ...baseStyle,
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 11px',
      }}>
        {prefix && <span style={{ color: T.textMuted, fontSize: 12 }}>{prefix}</span>}
        <input type={type} value={value || ''}
          placeholder={placeholder}
          onChange={e => onChange && onChange(e.target.value)}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          autoFocus={autoFocus}
          style={{
            flex: 1, minWidth: 0, padding: '7px 0',
            background: 'transparent', border: 'none', outline: 'none',
            color: T.text, fontSize: 13,
            fontFamily: monospace ? T.fontMono : 'inherit',
          }} />
        {suffix && <span style={{ color: T.textMuted, fontSize: 12 }}>{suffix}</span>}
      </div>
    );
  }
  return (
    <input type={type} value={value || ''}
      placeholder={placeholder}
      onChange={e => onChange && onChange(e.target.value)}
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      autoFocus={autoFocus}
      style={baseStyle} />
  );
}

// ── Popup button (macOS-style select) ────────────────────────────────────────
// Menu renders into document.body via a portal so it never gets clipped by
// ancestor `overflow: hidden / auto` (e.g. scrolling modal body).
function PopUp({ value, options, onChange, width, accent = false }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const update = () => {
      if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = e => {
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const current = options.find(o => (o.value ?? o) === value);
  const currentLabel = current ? (current.label ?? current) : value;

  // Decide direction (open up if not enough room below)
  let menuTop = 0, menuLeft = 0, menuMinWidth = 0, openUp = false;
  if (rect) {
    const menuMax = Math.min(240, options.length * 30 + 12);
    const spaceBelow = window.innerHeight - rect.bottom;
    openUp = spaceBelow < menuMax + 16 && rect.top > spaceBelow;
    menuTop = openUp ? rect.top - 4 : rect.bottom + 4;
    menuLeft = rect.left;
    menuMinWidth = rect.width;
  }

  return (
    <div ref={btnRef} style={{ position: 'relative', width: width || '100%' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%',
        padding: '7px 8px 7px 11px',
        background: accent
          ? 'linear-gradient(180deg, rgba(173,198,255,0.95), rgba(140,170,235,0.9))'
          : '#2a2a2c',
        border: accent ? '1px solid rgba(173,198,255,0.4)' : '1px solid rgba(255,255,255,0.07)',
        boxShadow: 'none',
        borderRadius: 7,
        color: accent ? T.accentInk : T.text,
        fontSize: 13, fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', gap: 8,
        cursor: 'pointer', textAlign: 'left',
      }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: accent ? 600 : 400 }}>{currentLabel}</span>
        <span style={{
          width: 16, height: 16, borderRadius: 3,
          background: accent ? 'rgba(0,0,0,0.18)' : 'rgba(173,198,255,0.9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: T.accentInk,
          flexShrink: 0,
        }}>
          <svg width="9" height="11" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4l2-2 2 2M3 8l2 2 2-2"/>
          </svg>
        </span>
      </button>
      {open && rect && ReactDOM.createPortal(
        <div ref={menuRef} style={{
          position: 'fixed',
          top: openUp ? 'auto' : menuTop,
          bottom: openUp ? window.innerHeight - menuTop : 'auto',
          left: menuLeft,
          minWidth: menuMinWidth,
          maxWidth: Math.max(menuMinWidth, 420),
          background: '#2a2a2c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
          padding: 4,
          zIndex: 1000,
          maxHeight: 240, overflowY: 'auto',
        }}>
          {options.map((o, i) => {
            const v = o.value ?? o;
            const l = o.label ?? o;
            const sel = v === value;
            return (
              <button key={i} onClick={() => { onChange && onChange(v); setOpen(false); }}
                style={{
                  width: '100%', padding: '6px 9px 6px 24px',
                  background: sel ? 'rgba(173,198,255,0.18)' : 'transparent',
                  border: 'none', borderRadius: 5,
                  color: T.text, fontSize: 13, fontFamily: 'inherit',
                  textAlign: 'left', cursor: 'pointer',
                  position: 'relative',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}
                onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}>
                {sel && (
                  <svg style={{ position: 'absolute', left: 7, top: '50%', transform: 'translateY(-50%)' }}
                    width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={T.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                )}
                {l}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── Segmented control (macOS NSSegmentedControl) ─────────────────────────────
function Segmented({ value, options, onChange, width, fill = false }) {
  return (
    <div style={{
      display: fill ? 'flex' : 'inline-flex',
      background: '#252527',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 7, padding: 2,
      width: width || (fill ? '100%' : 'auto'),
    }}>
      {options.map((o, i) => {
        const v = o.value ?? o;
        const l = o.label ?? o;
        const sel = v === value;
        return (
          <button key={i} onClick={() => onChange && onChange(v)}
            style={{
              flex: 1, minWidth: 0, padding: '5px 10px',
              background: sel ? 'rgba(255,255,255,0.10)' : 'transparent',
              border: 'none',
              borderRadius: 5,
              color: sel ? T.text : T.textMuted,
              fontSize: 12.5, fontFamily: 'inherit',
              fontWeight: sel ? 600 : 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
              transition: 'all 0.12s',
            }}>{l}</button>
        );
      })}
    </div>
  );
}

// ── Toggle (iOS / macOS green toggle) ────────────────────────────────────────
function Toggle({ on, onChange, tint = 'success' }) {
  const tintColor = tint === 'success' ? T.success : T.accent;
  return (
    <button onClick={() => onChange && onChange(!on)} style={{
      width: 34, height: 20, borderRadius: 20,
      background: on ? tintColor : 'rgba(255,255,255,0.12)',
      border: 'none', padding: 0,
      position: 'relative', cursor: 'pointer',
      transition: 'background 0.18s',
      boxShadow: on ? '0 0 0 0.5px rgba(0,0,0,0.15) inset' : 'inset 0 1px 1px rgba(0,0,0,0.2)',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 16 : 2,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
        transition: 'left 0.18s',
      }} />
    </button>
  );
}

// ── Checkbox / Radio ─────────────────────────────────────────────────────────
function Checkbox({ checked, onChange, label }) {
  const box = (
    <span style={{
      width: 16, height: 16, borderRadius: 4,
      background: checked
        ? 'linear-gradient(180deg, rgba(173,198,255,0.95), rgba(140,170,235,0.9))'
        : 'rgba(0,0,0,0.3)',
      border: checked ? '1px solid rgba(173,198,255,0.6)' : '1px solid rgba(255,255,255,0.18)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      boxShadow: checked ? 'none' : 'inset 0 1px 1px rgba(0,0,0,0.25)',
      transition: 'all 0.12s',
    }}>
      {checked && (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke={T.accentInk} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.2l2.4 2.4 4.6-4.8"/>
        </svg>
      )}
    </span>
  );
  if (!label) return (
    <button onClick={() => onChange && onChange(!checked)}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
      {box}
    </button>
  );
  return (
    <button onClick={() => onChange && onChange(!checked)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      background: 'none', border: 'none', padding: 0,
      cursor: 'pointer', color: T.text, fontSize: 13, fontFamily: 'inherit',
    }}>
      {box}
      <span>{label}</span>
    </button>
  );
}

function Radio({ checked, onChange, label }) {
  const dot = (
    <span style={{
      width: 16, height: 16, borderRadius: '50%',
      background: checked
        ? 'radial-gradient(circle at 50% 50%, #ffffff 0 3px, rgba(173,198,255,0.95) 3.5px 100%)'
        : 'rgba(0,0,0,0.3)',
      border: checked ? '1px solid rgba(173,198,255,0.5)' : '1px solid rgba(255,255,255,0.18)',
      flexShrink: 0,
      boxShadow: checked ? 'none' : 'inset 0 1px 1px rgba(0,0,0,0.25)',
      transition: 'all 0.12s',
    }} />
  );
  if (!label) return (
    <button onClick={() => onChange && onChange(true)}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
      {dot}
    </button>
  );
  return (
    <button onClick={() => onChange && onChange(true)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      background: 'none', border: 'none', padding: 0,
      cursor: 'pointer', color: T.text, fontSize: 13, fontFamily: 'inherit',
    }}>
      {dot}<span>{label}</span>
    </button>
  );
}

// ── Stepper (numeric -/+) ────────────────────────────────────────────────────
function Stepper({ value, onChange, min = 0, max = 999, step = 1, suffix }) {
  const set = v => onChange && onChange(Math.max(min, Math.min(max, v)));
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center',
      background: T.fieldBg, border: T.fieldBorder,
      borderRadius: 7,
      overflow: 'hidden',
    }}>
      <input type="text" value={value}
        onChange={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) set(n); }}
        style={{
          width: 56, padding: '7px 10px',
          background: 'transparent', border: 'none', outline: 'none',
          color: T.text, fontSize: 13, fontFamily: T.fontMono,
          textAlign: 'right', fontVariantNumeric: 'tabular-nums',
        }} />
      {suffix && <span style={{ paddingRight: 8, fontSize: 12, color: T.textMuted }}>{suffix}</span>}
      <div style={{ display: 'flex', flexDirection: 'column', borderLeft: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={() => set(value + step)} style={stepBtn}>
          <svg width="8" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M1 5l4-4 4 4"/></svg>
        </button>
        <button onClick={() => set(value - step)} style={{ ...stepBtn, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <svg width="8" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l4 4 4-4"/></svg>
        </button>
      </div>
    </div>
  );
}
const stepBtn = {
  width: 18, height: 13,
  background: 'rgba(255,255,255,0.04)',
  border: 'none', color: T.textSub, cursor: 'pointer', padding: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

// ── Path / file picker ───────────────────────────────────────────────────────
function PathField({ value, onChange, placeholder = 'Choose a path…', monospace = true }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, width: '100%' }}>
      <Field value={value} onChange={onChange} placeholder={placeholder} monospace={monospace} />
      <BtnSecondary compact>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4a1 1 0 011-1h3l1.5 1.5H12a1 1 0 011 1V11a1 1 0 01-1 1H2a1 1 0 01-1-1V4z"/>
          </svg>
          Browse…
        </span>
      </BtnSecondary>
    </div>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────
function BtnPrimary({ children, onClick, disabled, compact, autoFocus }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled} autoFocus={autoFocus}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        padding: compact ? '5px 12px' : '7px 16px',
        borderRadius: 7,
        background: disabled
          ? 'rgba(173,198,255,0.18)'
          : h ? '#c4d5ff' : '#adc6ff',
        color: disabled ? 'rgba(10,31,71,0.45)' : T.accentInk,
        fontWeight: 600, fontSize: 13, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        transition: 'all 0.12s',
      }}>{children}</button>
  );
}

function BtnSecondary({ children, onClick, disabled, compact }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        padding: compact ? '5px 12px' : '7px 14px',
        borderRadius: 7,
        background: h ? '#36363a' : '#2e2e30',
        color: disabled ? T.textDim : T.text,
        fontWeight: 500, fontSize: 13, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: '1px solid rgba(255,255,255,0.07)',
        transition: 'all 0.12s',
      }}>{children}</button>
  );
}

function BtnGhost({ children, onClick, compact }) {
  return (
    <button onClick={onClick} style={{
      padding: compact ? '5px 10px' : '7px 12px',
      borderRadius: 7,
      background: 'transparent', border: 'none',
      color: T.textSub, fontSize: 13, fontFamily: 'inherit', fontWeight: 500,
      cursor: 'pointer',
    }}>{children}</button>
  );
}

function BtnDanger({ children, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '7px 14px', borderRadius: 7,
      background: 'rgba(255,179,181,0.1)', color: T.danger,
      fontSize: 13, fontFamily: 'inherit', fontWeight: 500,
      cursor: 'pointer',
      border: '1px solid rgba(255,179,181,0.22)',
      boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset',
    }}>{children}</button>
  );
}

// Inline icon button (small, used for "delete rule", "add row", etc.)
function IconBtn({ children, onClick, tint = 'default', size = 22 }) {
  const c = tint === 'danger' ? T.danger : T.textMuted;
  return (
    <button onClick={onClick} style={{
      width: size, height: size, borderRadius: 6,
      background: 'transparent', border: '1px solid rgba(255,255,255,0.06)',
      color: c, cursor: 'pointer', padding: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      transition: 'all 0.12s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = tint === 'danger' ? 'rgba(255,179,181,0.1)' : 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
      {children}
    </button>
  );
}

// ── Disclosure (collapsible section) ─────────────────────────────────────────
function Disclosure({ title, hint, defaultOpen = false, children, action }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '0 4px 7px',
        background: 'transparent', border: 'none',
        cursor: 'pointer', color: T.textMuted, fontFamily: 'inherit',
      }}>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M4 2l4 4-4 4"/>
        </svg>
        <span style={{
          fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}>{title}</span>
        {hint && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.textDim, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>{hint}</span>}
        {action && <span style={{ marginLeft: hint ? 8 : 'auto' }} onClick={e => e.stopPropagation()}>{action}</span>}
      </button>
      {open && children}
    </div>
  );
}

// ── Tile (selectable card, e.g. discovery goal) ──────────────────────────────
function Tile({ title, sub, selected, onClick, icon }) {
  // Flatter, radio-card affordance — no heavy border or shadow.
  return (
    <button onClick={onClick} style={{
      textAlign: 'left',
      width: '100%',
      padding: '10px 12px 10px 10px',
      borderRadius: 8,
      background: selected ? 'rgba(173,198,255,0.10)' : 'transparent',
      border: 'none',
      cursor: 'pointer', fontFamily: 'inherit', color: T.text,
      display: 'flex', alignItems: 'flex-start', gap: 10,
      transition: 'background 0.12s',
      position: 'relative',
    }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
      <span style={{
        width: 16, height: 16, borderRadius: '50%',
        marginTop: 2, flexShrink: 0,
        background: selected
          ? 'radial-gradient(circle at 50% 50%, #ffffff 0 3px, rgba(173,198,255,0.95) 3.5px 100%)'
          : 'transparent',
        border: selected ? '1px solid rgba(173,198,255,0.6)' : '1px solid rgba(255,255,255,0.22)',
      }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: selected ? T.text : T.textSub }}>{title}</span>
        <span style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.4 }}>{sub}</span>
      </div>
    </button>
  );
}

// ── Banner / Callout ─────────────────────────────────────────────────────────
function Callout({ kind = 'info', children, title }) {
  const palette = {
    info:    { fg: T.accent,  bg: 'rgba(173,198,255,0.07)',  bd: 'rgba(173,198,255,0.18)' },
    warn:    { fg: T.warn,    bg: 'rgba(240,180,41,0.07)',   bd: 'rgba(240,180,41,0.22)' },
    danger:  { fg: T.danger,  bg: 'rgba(255,179,181,0.07)',  bd: 'rgba(255,179,181,0.22)' },
    success: { fg: T.success, bg: 'rgba(83,225,111,0.07)',   bd: 'rgba(83,225,111,0.2)' },
  }[kind];
  return (
    <div style={{
      padding: '8px 2px',
      background: 'transparent',
      border: 'none',
      display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      <span style={{ color: palette.fg, flexShrink: 0, paddingTop: 1 }}>
        {kind === 'info' && <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7v4M8 5h0"/></svg>}
        {kind === 'warn' && <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 1.5L1 14h14L8 1.5z"/><path d="M8 6v3.5M8 11.5h0"/></svg>}
        {kind === 'danger' && <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>}
        {kind === 'success' && <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l3 3 7-7"/></svg>}
      </span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: T.textSub, lineHeight: 1.5 }}>
        {title && <div style={{ color: palette.fg, fontWeight: 600, marginBottom: 1 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// ── Export to window ─────────────────────────────────────────────────────────
Object.assign(window, {
  T,
  Modal, ModalHeader, ModalBody, ModalFooter,
  Section, Group, Row, HelpDot,
  Field, PopUp, Segmented, Toggle, Checkbox, Radio, Stepper, PathField,
  BtnPrimary, BtnSecondary, BtnGhost, BtnDanger, IconBtn,
  Disclosure, Tile, Callout,
  TrafficLights, CloseBtn,
});
