/**
 * Nostr module for 2048 game
 * Handles authentication, event signing, and relay communication
 */

// Relays for publishing and fetching scores
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band'
]

// Game identifier for d tag
const GAME_ID = '2048-nostrapps'

// Current user state
let currentUser = null
let privateKeyHex = null

// secp256k1 curve parameters
const CURVE = {
  P: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
  N: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  Gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  Gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n
}

// Modular arithmetic helpers
function mod(a, b = CURVE.P) {
  const result = a % b
  return result >= 0n ? result : b + result
}

function modInverse(a, m = CURVE.P) {
  let [old_r, r] = [a, m]
  let [old_s, s] = [1n, 0n]
  while (r !== 0n) {
    const q = old_r / r
    ;[old_r, r] = [r, old_r - q * r]
    ;[old_s, s] = [s, old_s - q * s]
  }
  return mod(old_s, m)
}

// Point operations on secp256k1
function pointAdd(p1, p2) {
  if (!p1) return p2
  if (!p2) return p1
  const [x1, y1] = p1
  const [x2, y2] = p2
  if (x1 === x2 && y1 !== y2) return null
  const m = x1 === x2
    ? mod((3n * x1 * x1) * modInverse(2n * y1))
    : mod((y2 - y1) * modInverse(x2 - x1))
  const x3 = mod(m * m - x1 - x2)
  const y3 = mod(m * (x1 - x3) - y1)
  return [x3, y3]
}

function pointMultiply(k, point = [CURVE.Gx, CURVE.Gy]) {
  let result = null
  let addend = point
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend)
    addend = pointAdd(addend, addend)
    k >>= 1n
  }
  return result
}

// Hex encoding/decoding
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function bigintToBytes(n, length = 32) {
  const hex = n.toString(16).padStart(length * 2, '0')
  return hexToBytes(hex)
}

function bytesToBigint(bytes) {
  return BigInt('0x' + bytesToHex(bytes))
}

// SHA-256 hash
async function sha256(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return new Uint8Array(hash)
}

// Get public key from private key
function getPublicKey(privKeyHex) {
  const privKey = BigInt('0x' + privKeyHex)
  const point = pointMultiply(privKey)
  return bytesToHex(bigintToBytes(point[0]))
}

// Create schnorr signature (BIP-340)
async function schnorrSign(messageHash, privKeyHex) {
  const d = BigInt('0x' + privKeyHex)
  const P = pointMultiply(d)
  const px = P[0]

  // Negate d if P.y is odd
  const dNeg = P[1] % 2n === 0n ? d : CURVE.N - d

  // Generate k deterministically
  const aux = crypto.getRandomValues(new Uint8Array(32))
  const t = bigintToBytes(dNeg ^ bytesToBigint(aux))
  const kHash = await sha256(new Uint8Array([...t, ...bigintToBytes(px), ...messageHash]))
  let k = mod(bytesToBigint(kHash), CURVE.N)
  if (k === 0n) throw new Error('Invalid k')

  const R = pointMultiply(k)
  if (R[1] % 2n !== 0n) k = CURVE.N - k

  const rx = bigintToBytes(R[0])
  const eHash = await sha256(new Uint8Array([...rx, ...bigintToBytes(px), ...messageHash]))
  const e = mod(bytesToBigint(eHash), CURVE.N)
  const s = mod(k + e * dNeg, CURVE.N)

  return bytesToHex(new Uint8Array([...rx, ...bigintToBytes(s)]))
}

// Create event ID (SHA-256 of serialized event)
async function getEventId(event) {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
  const hash = await sha256(serialized)
  return bytesToHex(hash)
}

// Sign event with private key
async function signEventWithPrivkey(event, privKeyHex) {
  event.pubkey = getPublicKey(privKeyHex)
  event.id = await getEventId(event)
  event.sig = await schnorrSign(hexToBytes(event.id), privKeyHex)
  return event
}

// Sign event with extension (NIP-07)
async function signEventWithExtension(event) {
  if (!window.nostr) throw new Error('No Nostr extension found')
  return await window.nostr.signEvent(event)
}

/**
 * Login with Nostr extension (NIP-07)
 */
export async function loginWithExtension() {
  if (!window.nostr) {
    throw new Error('No Nostr extension found. Please install Alby or nos2x.')
  }

  try {
    const pubkey = await window.nostr.getPublicKey()
    currentUser = { pubkey, method: 'extension' }
    privateKeyHex = null
    return pubkey
  } catch (err) {
    throw new Error('Extension login failed: ' + err.message)
  }
}

/**
 * Login with private key (hex or nsec)
 */
export async function loginWithPrivkey(key) {
  let hex = key.trim()

  // Convert nsec to hex if needed
  if (hex.startsWith('nsec1')) {
    hex = bech32ToHex(hex)
  }

  // Validate hex
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Invalid private key. Must be 64 hex characters or nsec.')
  }

  privateKeyHex = hex.toLowerCase()
  const pubkey = getPublicKey(privateKeyHex)
  currentUser = { pubkey, method: 'privkey' }
  return pubkey
}

/**
 * Bech32 decode (simplified for nsec)
 */
function bech32ToHex(bech32) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const data = bech32.slice(5) // Remove 'nsec1' prefix
  const decoded = []

  for (const char of data) {
    const idx = CHARSET.indexOf(char)
    if (idx === -1) throw new Error('Invalid bech32 character')
    decoded.push(idx)
  }

  // Convert 5-bit to 8-bit
  let acc = 0
  let bits = 0
  const bytes = []

  for (const value of decoded.slice(0, -6)) { // Remove checksum
    acc = (acc << 5) | value
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }

  return bytesToHex(new Uint8Array(bytes))
}

/**
 * Logout
 */
export function logout() {
  currentUser = null
  privateKeyHex = null
}

/**
 * Get current user
 */
export function getCurrentUser() {
  return currentUser
}

/**
 * Check if extension is available
 */
export function hasExtension() {
  return typeof window !== 'undefined' && !!window.nostr
}

/**
 * Publish score to relays
 */
export async function publishScore(score) {
  if (!currentUser) throw new Error('Not logged in')

  const event = {
    kind: 33334,
    content: String(score),
    tags: [['d', GAME_ID]],
    created_at: Math.floor(Date.now() / 1000)
  }

  // Sign event
  let signedEvent
  try {
    if (currentUser.method === 'extension') {
      signedEvent = await signEventWithExtension(event)
    } else {
      signedEvent = await signEventWithPrivkey(event, privateKeyHex)
    }
    console.log('Event signed:', signedEvent)
  } catch (err) {
    console.error('Signing failed:', err)
    throw new Error('Failed to sign event: ' + err.message)
  }

  // Publish to relays
  const results = await Promise.allSettled(
    RELAYS.map(url => publishToRelay(url, signedEvent))
  )

  console.log('Relay results:', results)

  const success = results.some(r => r.status === 'fulfilled')
  if (!success) {
    const errors = results.map(r => r.reason?.message || 'Unknown').join(', ')
    throw new Error('Failed to publish: ' + errors)
  }

  return signedEvent
}

/**
 * Publish event to a single relay
 */
function publishToRelay(url, event) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Timeout'))
    }, 5000)

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', event]))
    }

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data)
      if (data[0] === 'OK') {
        clearTimeout(timeout)
        ws.close()
        if (data[2]) resolve(data)
        else reject(new Error(data[3] || 'Rejected'))
      }
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Connection failed'))
    }
  })
}

/**
 * Fetch leaderboard from relays
 */
export async function fetchLeaderboard(limit = 50) {
  const filter = {
    kinds: [33334],
    '#d': [GAME_ID],
    limit: limit * 3 // Fetch more to account for duplicates
  }

  // Query all relays
  const results = await Promise.allSettled(
    RELAYS.map(url => queryRelay(url, filter))
  )

  // Merge results and dedupe by pubkey (keep highest score)
  const scoreMap = new Map()

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const event of result.value) {
      const score = parseInt(event.content)
      if (isNaN(score)) continue

      const existing = scoreMap.get(event.pubkey)
      if (!existing || score > existing.score) {
        scoreMap.set(event.pubkey, {
          pubkey: event.pubkey,
          score,
          created_at: event.created_at
        })
      }
    }
  }

  // Sort by score descending
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Query a single relay
 */
function queryRelay(url, filter) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const events = []
    const subId = Math.random().toString(36).slice(2)

    const timeout = setTimeout(() => {
      ws.close()
      resolve(events) // Return what we have
    }, 5000)

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, filter]))
    }

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data)
      if (data[0] === 'EVENT' && data[1] === subId) {
        events.push(data[2])
      } else if (data[0] === 'EOSE') {
        clearTimeout(timeout)
        ws.close()
        resolve(events)
      }
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Connection failed'))
    }
  })
}

/**
 * Format pubkey for display (truncated)
 */
export function formatPubkey(pubkey) {
  return pubkey.slice(0, 8) + '...' + pubkey.slice(-4)
}

/**
 * Convert pubkey to did:nostr format
 */
export function pubkeyToDid(pubkey) {
  return `did:nostr:${pubkey.toLowerCase()}`
}

/**
 * Format DID for display (truncated)
 */
export function formatDid(pubkey) {
  return `did:nostr:${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`
}

/**
 * Convert pubkey to npub (bech32)
 */
export function pubkeyToNpub(pubkey) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  const bytes = hexToBytes(pubkey)

  // Convert 8-bit to 5-bit
  const data = []
  let acc = 0
  let bits = 0

  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      data.push((acc >> bits) & 0x1f)
    }
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 0x1f)

  // Add checksum (simplified - not full bech32m)
  const hrp = 'npub'
  let result = hrp + '1'
  for (const d of data) {
    result += CHARSET[d]
  }

  // Add placeholder checksum (6 chars)
  result += CHARSET[0].repeat(6)

  return result.slice(0, 20) + '...'
}
