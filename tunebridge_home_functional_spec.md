# TuneBridge Home — Functional Specification & UI Guideline

## Document purpose

This document defines the proposed **Home** feature for TuneBridge. It is intended to guide product design, UX design, and implementation.

The goal of Home is to give TuneBridge users a personalised landing experience that helps them:

- resume listening quickly
- rediscover their own library
- see what is new in their collection
- receive transparent recommendations
- understand their listening habits over time

This specification is based on the current TuneBridge direction and existing feature set.

---

## 1. Feature overview

### Feature name
**Home**

### Product intent
TuneBridge Home should act as the default landing page when a user opens the app. It should feel useful immediately, even before the user starts browsing deeper into Artists, Albums, Songs, Playlists, Favourites, or Insights.

Unlike streaming app homepages, TuneBridge Home should be built around the user’s **local library**, **listening history**, and **audiophile workflows**.

### Core product promise
TuneBridge Home helps users:

1. **Resume** what they were listening to
2. **Rediscover** relevant content in their own library
3. **Understand** their listening habits and trends
4. **Act quickly** on common TuneBridge workflows

---

## 2. Goals

### Primary goal
Create a personalised app home that makes TuneBridge feel alive, useful, and immediately relevant every time the user opens it.

### Secondary goals
- Increase repeat engagement with the library
- Surface value from existing TuneBridge features
- Improve discoverability of albums, playlists, and insights
- Create a premium first screen that reflects TuneBridge’s identity
- Introduce lightweight personalisation without making the app feel like a streaming platform clone

### Non-goals
Home should **not**:
- replace Albums, Artists, Songs, or Playlists screens
- become a dense analytics dashboard
- become a second Now Playing screen
- become an editorial/news feed
- rely on cloud catalogues or external music services

---

## 3. Design principles

TuneBridge Home should feel:

- **Personal** — built from the user’s own collection and behaviour
- **Calm** — not noisy, cluttered, or promotional
- **Fast** — useful within seconds of opening the app
- **Transparent** — recommendations should feel explainable
- **Premium** — aligned with TuneBridge’s polished, audiophile-first identity
- **Consistent** — interactions should match the rest of TuneBridge

---

## 4. Proposed Home structure

Recommended top-to-bottom layout:

1. Header / Welcome Strip
2. Continue Listening
3. Top Picks For You
4. Recently Added
5. Listening Stats
6. Rediscover
7. Quick Actions
8. Audio Snapshot

This order prioritises fast re-entry first, then recommendations, then freshness, then insights and utility.

---

## 5. Functional modules

## 5.1 Header / Welcome Strip

### Purpose
Orient the user and provide fast access to high-value actions.

### Content
- App/page title: **Home**
- Optional greeting or contextual subheading
- Library summary snippet
- Last scan status
- Global search entry point
- Quick utility actions

### Suggested content examples
- “Your library at a glance”
- “2,814 albums • 126 playlists”
- “Last scanned 2 hours ago”

### Actions
- Search
- Re-scan library
- Resume last session
- Open Insights
- Open latest playlist
- Optional future: export to DAP

### Behaviour
- Should remain compact
- Should not push the main content too far down
- Must feel like an app header, not a dashboard widget

---

## 5.2 Continue Listening

### Purpose
Allow the user to quickly return to the albums or playlists they have recently engaged with.

### Requirement
Show the **last 10 albums or playlists listened to**.

### Display format
Horizontal card rail.

### Each card should show
- cover art
- title
- album artist or playlist type/name
- last played timestamp or relative label
- optional progress indicator
- play/resume affordance

### Behaviour rules
- Clicking the card opens the relevant album or playlist detail page
- Clicking play resumes playback immediately
- Right click opens the standard TuneBridge context menu
- If progress data exists, resume from current track or last playback context
- If progress data does not exist, start from track 1 or playlist order start

### Qualification rules
An item should count as “recently listened” only if there was meaningful interaction. Suggested qualification:
- at least one track played past a play threshold, or
- multiple tracks played in one session, or
- total listening time exceeds a minimum threshold

This avoids noise from accidental taps.

### Empty state
- “Nothing here yet”
- “Start listening and your recent albums and playlists will appear here”

---

## 5.3 Top Picks For You

### Purpose
Surface a small number of personalised recommendations derived from the user’s local library and listening habits.

### Requirement
Show **Top 5 picks** for the user based on listening habits.

### Display format
Five-card row or compact grid.

### Each card should show
- cover art
- title
- album artist or playlist descriptor
- one-line recommendation reason
- play action
- optional save/favourite action if supported consistently across TuneBridge

### Recommendation explanation examples
- “Because you often replay vocal jazz albums”
- “Matches your recent warm, bass-led listening”
- “Similar to albums you’ve been revisiting lately”
- “You added this recently and may enjoy returning to it”

### Recommendation inputs
Top Picks should be based on a blend of:
- recent listening affinity
- long-term affinity
- similarity to frequently played items
- novelty / freshness
- metadata relationships
- optional future library-cluster similarity

### Recommendation guardrails
- avoid duplicates from Continue Listening
- avoid overloading with one artist only
- avoid repeating the exact same picks too often
- diversify across albums and playlists where possible
- prefer owned content, never external content

### Cold start behaviour
If there is not enough listening history:
- use metadata-based recommendations instead
- use favourite artists, genres, recently added items, or library similarity
- show a subtle message like:  
  “Listen more to unlock smarter picks”

---

## 5.4 Recently Added

### Purpose
Help the user revisit the newest additions to their library.

### Requirement
Show the **last 10 albums or playlists added to the library**.

### Display format
Horizontal card rail.

### Each card should show
- cover art
- title
- album artist or playlist label
- date added
- optional “new” badge for very recent items

### Behaviour
- Clicking opens the album or playlist detail page
- Clicking play starts playback from the beginning
- Right click opens the standard context menu

### Sorting rule
Sort by **library added/imported date**, not release date.

### Empty state
- “No recent additions yet”
- “Import music or create playlists to see them here”

---

## 5.5 Listening Stats

### Purpose
Give users a lightweight but meaningful view of their listening behaviour.

### Requirement
Provide listening stats with filter options:
- last week
- last month
- last year
- all time

### Positioning
This should feel like a compact summary panel, not a full analytics page.

### Suggested metrics for summary card
- total listening time
- tracks played
- albums played
- artists played
- top artist
- top album
- top track
- most-played genre
- unique artists count
- average session length

### Suggested visual elements
- filter chips/tabs for time period
- small top list blocks
- simple charts or bars
- one highlighted insight
- button/link to full Insights page

### Example insight callouts
- “You listened 42% more than last month”
- “Your top genre this month was Dream Pop”
- “You revisited 8 albums more than 3 times”
- “Most of your listening happened after 8 pm”

### Behaviour
- Changing filter updates the panel in place
- Stats should load quickly
- The panel should not dominate the page visually
- Clicking deeper metrics can route to Insights in future versions

### Scope note
This should be **similar in spirit** to Spotify Wrapped / Apple Replay, but always available year-round and lighter in presentation.

---

## 5.6 Rediscover

### Purpose
Surface relevant content already in the library that the user may have forgotten or not revisited recently.

### Why it matters
Streaming apps rely on infinite catalogue recommendations. TuneBridge should instead help users rediscover value in the library they already own.

### Suggested logic
Surface items such as:
- previously loved albums not played in a long time
- albums related to recent listening patterns
- playlists that were once heavily used but abandoned
- recently added items not yet explored properly

### Display format
Compact rail of cards.

### Suggested labels
- “Rediscover”
- “Worth revisiting”
- “Back in rotation”
- “Haven’t played in a while”

### Behaviour
- Click opens detail page
- Play starts immediately
- Recommendation reason may be shown on hover or subtitle

---

## 5.7 Quick Actions

### Purpose
Make Home useful as a launchpad, not just a discovery page.

### Recommended actions
- Resume last session
- Shuffle library
- Open latest playlist
- Re-scan library
- Open Insights
- Go to Favourites
- Optional future: export recent playlist to DAP
- Optional future: sync current export set

### Display format
Compact button strip or utility card row.

### Behaviour
- Must be fast and direct
- Must not feel like a settings menu
- Should use familiar TuneBridge iconography and patterns

---

## 5.8 Audio Snapshot

### Purpose
Reinforce TuneBridge’s audiophile identity with a lightweight audio-centric insight card.

### Suggested content
- most-played sample rate this month
- most-used file type
- genre/tonal trend shift
- suggested IEM/headphone pairing
- suggested PEQ profile context
- listening profile summary

### Example copy
- “Your recent listening has leaned warm and vocal-forward”
- “FLAC dominated your listening this month”
- “Your Library Fit currently favours a smooth-neutral set”

### Important note
This should remain compact and optional. It is not the place for a dense technical dashboard.

---

## 6. User flows

## 6.1 Open app and resume listening
1. User launches TuneBridge
2. Home loads by default
3. User sees Continue Listening near the top
4. User clicks the recent album or playlist
5. Playback resumes and detail page opens or Now Playing updates

## 6.2 Revisit recently imported music
1. User imports new albums into TuneBridge
2. User returns to Home later
3. Recently Added surfaces the newest albums
4. User clicks one and starts listening

## 6.3 Discover a recommendation
1. User opens Home
2. Top Picks For You displays 5 items
3. User reads the reason line
4. User clicks play or opens the item
5. Item begins playback or detail page opens

## 6.4 Check recent listening trends
1. User opens Home
2. User navigates to Listening Stats
3. User changes filter from last week to last year
4. Stats update in place
5. User optionally opens full Insights later

## 6.5 Use Home as a productivity hub
1. User opens TuneBridge
2. User uses Quick Actions
3. User re-scans library or opens a recent playlist directly
4. User continues into their next workflow without navigating through multiple pages

---

## 7. Use cases

### Use case 1 — Resume
As a TuneBridge user, I want to quickly return to the albums or playlists I recently listened to, so I can continue without searching manually.

### Use case 2 — Freshness
As a TuneBridge user, I want to see what I recently added to my library, so I can revisit newly imported content quickly.

### Use case 3 — Personal discovery
As a TuneBridge user, I want Home to suggest albums or playlists I am likely to enjoy, so I can discover relevant content without leaving my own library.

### Use case 4 — Insight
As a TuneBridge user, I want to see my listening patterns over different time periods, so I can understand how my habits change over time.

### Use case 5 — Rediscovery
As a TuneBridge user, I want Home to remind me of content I already own but have not played recently, so I can get more value from my collection.

### Use case 6 — Utility
As a TuneBridge user, I want quick access to common actions like rescan, shuffle, or open Insights, so Home becomes a useful launch point.

### Use case 7 — Audiophile context
As a TuneBridge user, I want to see a lightweight audio-focused summary of my listening, so the app feels tailored to serious local-library listeners.

---

## 8. Behavioural data model requirements

To support Home properly, TuneBridge should track enough behaviour to power recent activity, recommendations, and listening stats.

### Required tracked events
- playback started
- playback paused
- playback stopped
- playback completed
- track skip
- album or playlist started
- source screen/context of playback
- timestamp
- duration listened
- completion percentage

### Useful optional data
- listening session boundaries
- time of day
- output device or target
- active headphone/IEM context
- active PEQ profile
- export/sync context

### Suggested play qualification rule
A track should count as “played” when:
- it reaches a minimum listening threshold, or
- it passes a completion threshold

An album or playlist should count as listened to only after meaningful engagement.

---

## 9. Data and logic rules

## 9.1 Continue Listening rules
- source includes albums and playlists only
- sort by last meaningful listen timestamp descending
- max 10 items
- deduplicate repeated recent sessions where appropriate
- preserve progress if available

## 9.2 Recently Added rules
- source includes albums and playlists only
- sort by library add/import timestamp descending
- max 10 items

## 9.3 Top Picks rules
- max 5 items
- should avoid exact repetition across short periods when possible
- should explain why each item was chosen
- should exclude items already visible in Continue Listening if possible

## 9.4 Listening Stats rules
- support week, month, year, all time filters
- should compare against previous equivalent period where relevant
- should update quickly without navigating away
- should degrade gracefully if history is limited

## 9.5 Rediscover rules
- prefer items with historical affinity but low recent plays
- can include albums, playlists, or later tracks if desired
- should feel intentional, not random

---

## 10. UI guideline

## 10.1 Layout style
- desktop-first layout
- vertical page composed of modular sections
- horizontal rails for media-heavy modules
- compact cards
- generous spacing
- premium dark theme alignment with TuneBridge’s existing visual language

## 10.2 Card design
Every album/playlist card on Home should support:
- cover art
- title
- secondary metadata line
- hover state
- play action
- context menu access
- navigation to detail page

### Optional enhancements
- favourite toggle
- quick queue action
- subtle recommendation reason overlay
- progress indicator for in-progress content

## 10.3 Visual hierarchy
Top of page should prioritise:
1. Continue Listening
2. Top Picks
3. Recently Added

Stats and utility should sit lower, unless future testing suggests otherwise.

## 10.4 Tone of UI copy
Use short, confident, human labels.

### Recommended section labels
- Continue Listening
- Top Picks For You
- Recently Added
- Listening Stats
- Rediscover
- Quick Actions
- Audio Snapshot

### Recommendation reason style
Keep reason strings short and informative. Avoid robotic or overly technical language by default.

Good:
- “Because you replayed similar albums recently”
- “Matches your recent late-night listening”
- “You added this recently and may enjoy returning to it”

Avoid:
- “Recommendation confidence score 0.84”
- “Collaborative metadata similarity match”

## 10.5 Motion and interaction
- subtle hover animations only
- immediate feedback on click
- no intrusive auto-rotating carousels
- no excessive animation
- preserve a premium, calm feeling

---

## 11. States and empty states

## 11.1 New user / empty library
Show:
- friendly welcome
- call to import music
- quick explanation of what Home will surface once the library exists

## 11.2 Library exists but no listening history
Show:
- Recently Added
- Quick Actions
- limited recommendations based on metadata
- guidance like: “Start listening to unlock personalised picks and stats”

## 11.3 Mature state
Show the full Home experience with:
- recent listening
- recommendations
- stats
- rediscovery
- audio context

---

## 12. Accessibility and usability notes

- Ensure strong contrast for text and controls
- Keep tap/click targets comfortable
- Avoid hiding primary actions behind hover only where possible
- Ensure keyboard navigation for cards and action buttons
- Ensure Home remains usable with very large libraries
- Avoid overwhelming the user with too many modules at once

---

## 13. Recommended MVP scope

## MVP
Include:
- Header / Welcome Strip
- Continue Listening
- Recently Added
- Top Picks For You
- Listening Stats
- Quick Actions
- Empty and cold-start states

## Phase 2
Add:
- Rediscover
- recommendation explanation refinement
- comparison to previous periods in stats
- Audio Snapshot

## Phase 3
Add:
- shareable recap / yearly replay
- deeper IEM / PEQ / Gear Fit integration
- DAP-aware continuation and quick export shortcuts
- richer listening pattern storytelling

---

## 14. Open product decisions

These items should be resolved during implementation planning:

1. What exact threshold qualifies a track as “played”?
2. How should playback progress for albums/playlists be stored?
3. Should Home be customisable in module order later?
4. Should recommendations prefer albums over playlists by default?
5. Should Audio Snapshot appear in MVP or Phase 2?
6. Should Top Picks include only library content, or also user-created playlists derived from library content?
7. How should cold-start recommendations work when metadata is sparse?

---

## 15. Final recommendation

TuneBridge Home should not copy Spotify or Apple Music directly. Instead, it should borrow the strongest parts of those patterns and reinterpret them for a **local-first, audiophile-focused music app**.

The strongest version of Home is one that:
- gets the user back into music quickly
- respects the value of a personal library
- provides transparent recommendations
- surfaces meaningful listening trends
- reinforces TuneBridge’s identity as more than just a browser

### Final module recommendation
For the ideal Home experience, include:

1. Continue Listening  
2. Top Picks For You  
3. Recently Added  
4. Listening Stats  
5. Rediscover  
6. Quick Actions  
7. Audio Snapshot

This creates a Home screen that feels useful, premium, and clearly aligned with TuneBridge’s long-term direction.
