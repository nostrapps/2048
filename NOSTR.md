# Nostr Integration for 2048

This document outlines how high scores and authentication will work using Nostr.

## Overview

The game will use two NIPs:
- **NIP-07**: Browser extension signing for authentication
- **NIP-133 (Gamestr)**: Game score events for leaderboards

## NIP-07: Authentication

Users authenticate via browser extensions (Alby, nos2x, etc.) that expose `window.nostr`.

### Required Methods

```javascript
// Get user's public key
const pubkey = await window.nostr.getPublicKey()

// Sign an event
const signedEvent = await window.nostr.signEvent(event)
```

### Implementation

```javascript
async function login() {
  if (!window.nostr) {
    alert('Please install a Nostr extension (Alby, nos2x, etc.)')
    return null
  }

  try {
    const pubkey = await window.nostr.getPublicKey()
    return pubkey
  } catch (err) {
    console.error('Login failed:', err)
    return null
  }
}
```

## NIP-133: Game Scores (Kind 33334)

High scores are stored as **kind 33334** events (parameterized replaceable).

### Event Structure

```json
{
  "kind": 33334,
  "content": "2048",
  "tags": [
    ["d", "2048-game"]
  ],
  "created_at": <unix timestamp>,
  "pubkey": "<user's public key>",
  "id": "<event id>",
  "sig": "<signature>"
}
```

### Fields

| Field | Description |
|-------|-------------|
| `kind` | 33334 (game score event) |
| `content` | Score as a string (e.g., "2048") |
| `d` tag | Game identifier: `2048-game` |

### Why Kind 33334?

- **Parameterized Replaceable**: Each user can only have one score per game (identified by `d` tag)
- **Self-reported**: User signs their own score
- **Queryable**: Easy to fetch all scores for a game from relays

## Implementation Plan

### 1. Save High Score

```javascript
async function saveHighScore(score) {
  if (!window.nostr) return false

  const event = {
    kind: 33334,
    content: String(score),
    tags: [["d", "2048-game"]],
    created_at: Math.floor(Date.now() / 1000)
  }

  try {
    const signedEvent = await window.nostr.signEvent(event)
    // Publish to relays
    await publishToRelays(signedEvent)
    return true
  } catch (err) {
    console.error('Failed to save score:', err)
    return false
  }
}
```

### 2. Fetch Leaderboard

```javascript
async function fetchLeaderboard() {
  const filter = {
    kinds: [33334],
    "#d": ["2048-game"],
    limit: 100
  }

  // Query relays for all 2048 scores
  const events = await queryRelays(filter)

  // Sort by score (highest first)
  return events
    .map(e => ({ pubkey: e.pubkey, score: parseInt(e.content) }))
    .sort((a, b) => b.score - a.score)
}
```

### 3. Recommended Relays

```javascript
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.snort.social'
]
```

## UI Considerations

1. **Login Button**: Show "Login with Nostr" → changes to truncated npub when logged in
2. **Leaderboard**: Display top 10 scores with npub/profile name
3. **Save Prompt**: After game over, prompt to save score if logged in
4. **Profile Pictures**: Optionally fetch kind 0 metadata for avatars

## Security Notes

- Scores are self-reported (users sign their own scores)
- No server-side verification (trust model inherent to Nostr)
- Consider adding game state hash for future verification

## Dependencies

No external libraries required. Can use:
- Raw WebSocket for relay communication
- Or lightweight library like `nostr-tools`

## References

- [NIP-07: window.nostr](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-133: Gamestr](https://github.com/nosdav/gamestr)
- [Awesome Nostr - Browser Extensions](https://github.com/aljazceru/awesome-nostr#nip-07-browser-extensions)
