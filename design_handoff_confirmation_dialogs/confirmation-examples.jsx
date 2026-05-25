// Confirmation dialog examples — anatomy, kinds, and the 5 rebuilt dialogs.

// ── Anatomy diagram ─────────────────────────────────────────────────────────
function ConfirmAnatomy() {
  const labelStyle = {
    position: 'absolute', fontSize: 10, fontWeight: 700,
    letterSpacing: '0.1em', textTransform: 'uppercase',
    color: '#adc6ff', whiteSpace: 'nowrap',
  };
  return (
    <div style={{ position: 'relative', padding: '32px 220px 32px 28px' }}>
      <Confirm
        kind="warning"
        title="Already in Playlist"
        body={'"Slice of Heaven" by Dave Dobbyn is already in "80s Hits Essentials".'}
        context={<ContextStrip primary="Slice of Heaven" secondary="Dave Dobbyn · 80s Hits Essentials" swatch="linear-gradient(135deg,#5a6b9b,#2e3a5f)" />}
        cancelLabel="Add Anyway"
        confirmLabel="Skip"
        confirmTone="primary"
      />
      <div style={{ ...labelStyle, top: 50, right: 28 }}>① Icon · 24px</div>
      <div style={{ ...labelStyle, top: 84, right: 28 }}>② Title · 15 / 600</div>
      <div style={{ ...labelStyle, top: 130, right: 28 }}>③ Body · 13 / sub</div>
      <div style={{ ...labelStyle, top: 178, right: 28 }}>④ Context strip</div>
      <div style={{ ...labelStyle, top: 250, right: 28 }}>⑤ Footer hairline</div>
      <div style={{ ...labelStyle, top: 282, right: 28 }}>⑥ Cancel · primary</div>
    </div>
  );
}

// ── Kinds gallery — the five tints side-by-side ─────────────────────────────
function KindsGallery() {
  const tiles = ['danger', 'warning', 'prompt', 'info', 'success'];
  const meta = {
    danger:  { label: 'Danger',  use: 'Irreversible removals — delete playlist, delete DAP, clear library.' },
    warning: { label: 'Warning', use: '"Already exists" or operations with notable side effects.' },
    prompt:  { label: 'Prompt',  use: 'Unsaved-changes / leave-without-saving questions.' },
    info:    { label: 'Info',    use: 'General confirmations & informational asks (e.g. support).' },
    success: { label: 'Success', use: 'Post-action acknowledgement ("Sync complete").' },
  };
  return (
    <div style={{
      padding: 28,
      display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 18,
      color: T.text, fontFamily: T.font,
    }}>
      {tiles.map(k => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <KindTile kind={k} />
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{meta[k].label}</div>
          <div style={{ fontSize: 11.5, color: T.textMuted, lineHeight: 1.5 }}>{meta[k].use}</div>
          <code style={{
            fontFamily: T.fontMono, fontSize: 10.5, color: KIND[k].tint,
            background: 'rgba(255,255,255,0.04)', padding: '2px 7px', borderRadius: 4,
          }}>kind=&quot;{k}&quot;</code>
        </div>
      ))}
    </div>
  );
}

// ── Button-tone reference ───────────────────────────────────────────────────
function FooterPatterns() {
  const Row = ({ label, sub, children }) => (
    <div style={{
      display: 'grid', gridTemplateColumns: '180px 1fr', gap: 20,
      padding: '14px 0',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      alignItems: 'center',
    }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{label}</div>
        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 3, lineHeight: 1.4 }}>{sub}</div>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: '#1d1d1f',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 10,
        padding: '10px 12px',
      }}>
        {children}
      </div>
    </div>
  );
  return (
    <div style={{ padding: '20px 28px 28px', color: T.text, fontFamily: T.font }}>
      <Row label="Destructive" sub="Cancel left · danger right. Cancel is the safe default — visually heavier than Delete.">
        <div style={{ flex: 1 }} />
        <BtnSecondary>Cancel</BtnSecondary>
        <BtnDanger>Delete</BtnDanger>
      </Row>
      <Row label="Affirmative" sub="Cancel left · primary right. Default action gets focus ring.">
        <div style={{ flex: 1 }} />
        <BtnSecondary>Cancel</BtnSecondary>
        <BtnPrimary>Save</BtnPrimary>
      </Row>
      <Row label="Three-option (prompt)" sub="Alt-action ghost left · Cancel · Primary right. Use sparingly — unsaved-changes only.">
        <BtnGhost>Discard</BtnGhost>
        <div style={{ flex: 1 }} />
        <BtnSecondary>Cancel</BtnSecondary>
        <BtnPrimary>Save</BtnPrimary>
      </Row>
      <Row label="Either-or (no destructive)" sub='Two equal-weight options. Use Secondary + Primary.'>
        <div style={{ flex: 1 }} />
        <BtnSecondary>Add Anyway</BtnSecondary>
        <BtnPrimary>Skip</BtnPrimary>
      </Row>
      <Row label="Acknowledge" sub="Single button. For purely informational moments.">
        <div style={{ flex: 1 }} />
        <BtnPrimary>OK</BtnPrimary>
      </Row>
    </div>
  );
}

// ── Type & spacing ruler ────────────────────────────────────────────────────
function SpacingRuler() {
  const Tok = ({ label, value, sample }) => (
    <div style={{
      display: 'grid', gridTemplateColumns: '140px 88px 1fr', gap: 16,
      padding: '10px 0',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      alignItems: 'baseline',
    }}>
      <div style={{ fontSize: 12, color: T.textMuted, fontFamily: T.fontMono }}>{label}</div>
      <div style={{ fontSize: 12, color: T.textSub, fontFamily: T.fontMono }}>{value}</div>
      <div>{sample}</div>
    </div>
  );
  return (
    <div style={{ padding: '20px 28px 28px', color: T.text, fontFamily: T.font }}>
      <Tok label="title" value="15 / 600 / -1%" sample={<span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Delete Playlist</span>} />
      <Tok label="body" value="13 / 1.55"     sample={<span style={{ fontSize: 13, color: T.textSub }}>"00s Essential Hits" will be permanently deleted.</span>} />
      <Tok label="context · primary"   value="12.5 / 500" sample={<span style={{ fontSize: 12.5, color: T.text, fontWeight: 500 }}>Slice of Heaven</span>} />
      <Tok label="context · secondary" value="11.5 / muted" sample={<span style={{ fontSize: 11.5, color: T.textMuted }}>Dave Dobbyn · 80s Hits Essentials</span>} />
      <Tok label="button"  value="13 / 600"    sample={<BtnPrimary compact>Save</BtnPrimary>} />
      <Tok label="width"   value="420 · 480"   sample={<span style={{ fontSize: 12, color: T.textMuted }}>Compact (default) · Wide (long-form copy)</span>} />
      <Tok label="radius"  value="12 · 8 · 7" sample={<span style={{ fontSize: 12, color: T.textMuted }}>shell · icon tile · button</span>} />
      <Tok label="icon" value="24 / bare" sample={<div style={{ display: 'flex', gap: 10 }}>{['danger','warning','prompt','info','success'].map(k => <KindTile key={k} kind={k} />)}</div>} />
    </div>
  );
}

// ── Rebuilt examples (the five in the screenshots) ──────────────────────────

function ExAlreadyInPlaylist() {
  return (
    <Confirm
      kind="warning"
      title="Already in Playlist"
      body={<>&ldquo;Slice of Heaven&rdquo; is already in <b style={{ color: T.text, fontWeight: 600 }}>80s Hits Essentials</b>. Add it a second time, or skip?</>}
      context={
        <ContextStrip
          primary="Slice of Heaven"
          secondary="Dave Dobbyn · 1986"
          swatch="linear-gradient(135deg,#7c8bb8,#3b4870)"
        />
      }
      cancelLabel="Add Anyway"
      confirmLabel="Skip"
      confirmTone="primary"
    />
  );
}

function ExDeleteDAP() {
  return (
    <Confirm
      kind="danger"
      title="Delete DAP?"
      body="This DAP and all its export history will be removed. The device files on disk are untouched."
      context={
        <ContextStrip
          primary="HiBy R6 III"
          secondary="/Volumes/HIBY_R6 · 412 exports"
        />
      }
      confirmLabel="Delete"
    />
  );
}

function ExDeletePlaylist() {
  return (
    <Confirm
      kind="danger"
      title="Delete Playlist?"
      body={<>&ldquo;00s Essential Hits&rdquo; will be permanently deleted. Tracks remain in your library.</>}
      confirmLabel="Delete"
    />
  );
}

function ExSaveCustomEQ() {
  return (
    <Confirm
      kind="prompt"
      title="Save Custom EQ?"
      body="You have unsaved changes to the Custom PEQ. Save to keep the live edits, or discard to leave without them."
      altLabel="Discard"
      cancelLabel="Cancel"
      confirmLabel="Save"
    />
  );
}

function ExSupportTuneBridge() {
  return (
    <Confirm
      kind="info"
      title="Support TuneBridge"
      body={
        <>
          TuneBridge is free and built by one person. If it has made your music library easier to enjoy, a small donation helps keep the app alive and funds the next round of improvements.
        </>
      }
      cancelLabel="Maybe later"
      confirmLabel={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6.2h8v4.6a2.4 2.4 0 01-2.4 2.4H5.4A2.4 2.4 0 013 10.8V6.2z"/>
            <path d="M11 7.4h1.4a1.6 1.6 0 010 3.2H11"/>
            <path d="M5.4 4.5c0-.8.5-1.2.5-1.8s-.5-1-.5-1.7M7.6 4.5c0-.8.5-1.2.5-1.8s-.5-1-.5-1.7"/>
          </svg>
          Support on Ko-fi
        </span>
      }
      wide
    />
  );
}

// ── A few more variants to round out the system ─────────────────────────────

function ExClearQueue() {
  return (
    <Confirm
      kind="warning"
      title="Clear Queue?"
      body="The 42 tracks waiting in the queue will be cleared. The currently-playing track will keep playing."
      confirmLabel="Clear"
      confirmTone="primary"
    />
  );
}

function ExSyncComplete() {
  return (
    <Acknowledge
      kind="success"
      title="Sync Complete"
      body="312 tracks copied to HiBy R6 III in 4m 12s. 0 errors, 0 skipped."
      context={<ContextStrip primary="HiBy R6 III" secondary="48.2 GB used · 11.8 GB free" />}
      buttonLabel="Done"
    />
  );
}

function ExOverwriteExport() {
  return (
    <Confirm
      kind="warning"
      title="Overwrite Existing Export?"
      body="An export already exists at this path. Replacing it will discard the previous artwork and metadata adjustments."
      context={
        <ContextStrip
          primary="/Volumes/AP80/MUSIC/Pearl Jam — Ten"
          mono
        />
      }
      cancelLabel="Cancel"
      confirmLabel="Replace"
      confirmTone="primary"
    />
  );
}

Object.assign(window, {
  ConfirmAnatomy, KindsGallery, FooterPatterns, SpacingRuler,
  ExAlreadyInPlaylist, ExDeleteDAP, ExDeletePlaylist, ExSaveCustomEQ, ExSupportTuneBridge,
  ExClearQueue, ExSyncComplete, ExOverwriteExport,
});
