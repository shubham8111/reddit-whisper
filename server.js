import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';

// Load credentials from .env if present (Node 20.12+/21.7+)
try {
  process.loadEnvFile?.();
} catch {
  // No .env file; anonymous mode
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Helper to normalize and sanitize Reddit thread URL to public JSON feed
function normalizeRedditUrl(inputUrl) {
  try {
    let cleanUrl = inputUrl.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    
    const parsedUrl = new URL(cleanUrl);
    
    // Validate domain
    if (parsedUrl.hostname !== 'reddit.com' && !parsedUrl.hostname.endsWith('.reddit.com')) {
      throw new Error('Not a valid Reddit URL');
    }
    
    let pathname = parsedUrl.pathname;
    
    // Ensure trailing slash is removed before appending .json
    if (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    
    // Append .json if not already present
    if (!pathname.endsWith('.json')) {
      pathname += '.json';
    }
    
    parsedUrl.pathname = pathname;
    
    // We force sorting by 'new' to get the latest comments immediately
    parsedUrl.searchParams.set('sort', 'new');
    parsedUrl.searchParams.set('raw_json', '1');
    
    // Remove unnecessary tracking parameters
    parsedUrl.searchParams.delete('utm_source');
    parsedUrl.searchParams.delete('utm_medium');
    parsedUrl.searchParams.delete('utm_name');
    
    return parsedUrl.toString();
  } catch (error) {
    throw new Error('Invalid Reddit URL format. Please provide a valid Reddit thread URL.');
  }
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
];

const DEFAULT_REDLIB_MIRRORS = [
  'https://redlib.catsarch.com',
  'https://redlib.perennialte.ch',
  'https://redlib.r4fo.com',
  'https://red.artemislena.eu',
  'https://redlib.cow.rip',
  'https://redlib.privacyredirect.com',
  'https://redlib.privadency.com'
];

// Public mirrors come and go; REDLIB_MIRRORS="https://a.example,https://b.example" puts your own first
const REDLIB_MIRRORS = [...new Set([
  ...(process.env.REDLIB_MIRRORS || '').split(',').map(m => m.trim().replace(/\/$/, '')).filter(Boolean),
  ...DEFAULT_REDLIB_MIRRORS
])];

const FETCH_TIMEOUT_MS = 10000;      // Dead mirrors otherwise hang a poll for a long time
const CACHE_TTL_MS = 4000;            // Below the 5s minimum refresh; still merges simultaneous polls (Test, multiple tabs)
const STALE_CACHE_MAX_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_POLL = 5;      // Failing sources cool down, so a wide fan-out only happens once per cooldown
const MAX_COOLDOWN_MS = 30 * 60 * 1000;

const DIRECT_SOURCE = 'reddit';

// --- Source health (circuit breaker) ---
// key -> { failures, cooldownUntil }. A failing source is skipped until its cooldown expires,
// so a blocked Reddit IP or a dead mirror isn't hit again on every poll.
const sourceHealth = new Map();
let preferredSource = null; // Last source that worked; tried first on the next poll
let userAgentIndex = 0;

function cooldownRemaining(key) {
  const health = sourceHealth.get(key);
  return health ? Math.max(0, health.cooldownUntil - Date.now()) : 0;
}

function parseRetryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function markFailure(key, { status, retryAfter } = {}) {
  const health = sourceHealth.get(key) || { failures: 0, cooldownUntil: 0 };
  health.failures++;
  
  // 401/403/login redirect = blocked or bad credentials (won't clear soon), 429 = rate limited, anything else = flaky/dead
  const baseMs = [401, 403, 'login-required'].includes(status) ? 10 * 60 * 1000 : status === 429 ? 60 * 1000 : 2 * 60 * 1000;
  const backoffMs = baseMs * 2 ** (health.failures - 1);
  const cooldownMs = Math.min(MAX_COOLDOWN_MS, Math.max(backoffMs, parseRetryAfterMs(retryAfter) ?? 0));
  
  health.cooldownUntil = Date.now() + cooldownMs;
  sourceHealth.set(key, health);
  if (preferredSource === key) preferredSource = null;
  console.warn(`[Proxy] ${key} failed (${status ?? 'error'}); cooling down for ${Math.round(cooldownMs / 1000)}s`);
}

function markSuccess(key) {
  sourceHealth.delete(key);
  preferredSource = key;
}

// Preferred source first, then direct Reddit, then mirrors; skipping anything cooling down
function orderedAvailableSources() {
  const all = [DIRECT_SOURCE, ...REDLIB_MIRRORS];
  const ordered = preferredSource ? [preferredSource, ...all.filter(s => s !== preferredSource)] : all;
  return ordered.filter(key => cooldownRemaining(key) === 0);
}

// --- Reddit authentication ---
// Reddit now redirects anonymous .json requests to a login page or answers 403, so reliable direct access needs
// REDDIT_SESSION: your logged-in reddit_session cookie (pasted in the app or set in .env), sent like a normal browser tab.
// Without it, direct fetches are attempted anonymously and mirrors are the fallback.
let redditSession = process.env.REDDIT_SESSION?.trim() || undefined; // Can be replaced at runtime from the UI
const authMode = () => redditSession ? 'session' : 'anonymous';

// Sets or replaces KEY=value in the project's .env (owner-only permissions; .env is gitignored)
function saveEnvValue(envPath, key, value) {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
  const entry = `${key}=${value}`;
  const index = lines.findIndex(line => line.startsWith(`${key}=`));
  
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (index === -1) lines.push(entry);
  else lines[index] = entry;
  
  fs.writeFileSync(envPath, lines.join('\n').replace(/^\n+/, '').replace(/\n*$/, '\n'), { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function buildDirectRequest(targetUrl) {
  const headers = {
    'User-Agent': USER_AGENTS[userAgentIndex++ % USER_AGENTS.length],
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.reddit.com/'
  };
  if (redditSession) headers['Cookie'] = `reddit_session=${redditSession}`;
  return { url: targetUrl, headers };
}

function rateLimitResetHeader(res) {
  // Reddit's API reports remaining quota; treat an exhausted quota like a Retry-After
  return res.headers.get('retry-after') || (res.status === 429 ? res.headers.get('x-ratelimit-reset') : null);
}

async function fetchFromRedditDirect(targetUrl) {
  // One attempt per poll: a block applies to the whole connection, so retrying with other user agents only multiplies requests
  const { url, headers } = buildDirectRequest(targetUrl);
  // A redirect means Reddit is bouncing us to its login page (anonymous access refused)
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers, redirect: 'manual' });
  
  if (res.status >= 300 && res.status < 400) return { error: { status: 'login-required' } };
  if (!res.ok) return { error: { status: res.status, retryAfter: rateLimitResetHeader(res) } };
  
  const data = await res.json();
  
  // Reddit comment feed is returning an array of two Listings:
  // data[0] contains the post itself
  // data[1] contains the comments tree
  const children = Array.isArray(data) ? data[1]?.data?.children : null;
  if (!Array.isArray(children)) return { error: { status: 'bad-json' } };
  
  // Extract and clean comments
  const comments = children
    .filter(child => child.kind === 't1' && child.data) // t1 refers to comments
    .map(child => {
      const d = child.data;
      return {
        id: d.id,
        author: d.author || '[deleted]',
        body: d.body || '[no content]',
        score: d.score ?? 0,
        created_utc: d.created_utc || Math.floor(Date.now() / 1000),
        permalink: d.permalink ? `https://reddit.com${d.permalink}` : null
      };
    });
  return { comments };
}

async function fetchFromMirror(mirror, pathname) {
  const cleanPathname = pathname.replace(/\.json$/, '');
  const res = await fetch(`${mirror}${cleanPathname}?sort=new`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return { error: { status: res.status, retryAfter: res.headers.get('retry-after') } };
  
  const comments = parseRedlibHtml(await res.text());
  // 0 comments usually means a bot-challenge page rather than an empty thread
  if (comments.length === 0) return { error: { status: 'empty' } };
  return { comments };
}

async function fetchFromSource(key, targetUrl, pathname) {
  try {
    return key === DIRECT_SOURCE ? await fetchFromRedditDirect(targetUrl) : await fetchFromMirror(key, pathname);
  } catch (e) {
    return { error: { status: e.name === 'TimeoutError' ? 'timeout' : 'network' } };
  }
}

// Tries a few healthy sources in order and returns the first successful result
async function fetchThreadComments(targetUrl, pathname) {
  const candidates = orderedAvailableSources().slice(0, MAX_ATTEMPTS_PER_POLL);
  
  for (const key of candidates) {
    const result = await fetchFromSource(key, targetUrl, pathname);
    if (result.comments) {
      markSuccess(key);
      return { comments: result.comments, source: key };
    }
    markFailure(key, result.error);
  }
  return null;
}

// Per-thread response cache and in-flight request de-duplication
const threadCache = new Map(); // pathname -> { at, comments, source }
const inFlight = new Map();    // pathname -> Promise

function sourceLabel(key) {
  if (key !== DIRECT_SOURCE) return new URL(key).hostname;
  return authMode() === 'session' ? 'reddit.com (logged in)' : 'reddit.com';
}

function soonestRecoveryMs() {
  const all = [DIRECT_SOURCE, ...REDLIB_MIRRORS].map(cooldownRemaining);
  return Math.min(...all);
}

// Helper function to parse Redlib HTML comments
function parseRedlibHtml(html) {
  const commentBlocks = html.split('<div id="');
  const comments = [];
  
  for (let i = 1; i < commentBlocks.length; i++) {
    const block = commentBlocks[i];
    const idMatch = block.match(/^([a-zA-Z0-9]+)"\s+class="comment"/);
    if (!idMatch) continue;
    const commentId = idMatch[1];

    const authorMatch = block.match(/class="comment_author[^"]*"\s+href="\/user\/([^"]+)"/);
    const author = authorMatch ? authorMatch[1] : '[deleted]';

    const scoreMatch = block.match(/class="comment_score"\s+title="([^"]+)"/);
    let score = 0;
    if (scoreMatch) {
      const titleVal = scoreMatch[1];
      if (titleVal !== 'Hidden' && !isNaN(titleVal)) {
        score = parseInt(titleVal, 10);
      }
    }

    const permalinkMatch = block.match(/<a\s+href="([^"]+)"\s+class="created"/);
    const permalink = permalinkMatch ? `https://reddit.com${permalinkMatch[1]}` : null;

    const createdMatch = block.match(/class="created"\s+title="([^"]+)"/);
    let created_utc = Math.floor(Date.now() / 1000);
    if (createdMatch) {
      const dateStr = createdMatch[1];
      const parsedDate = Date.parse(dateStr);
      if (!isNaN(parsedDate)) {
        created_utc = Math.floor(parsedDate / 1000);
      }
    }

    const bodyStartIndex = block.indexOf('<div class="comment_body "><div class="md">');
    let body = '[no content]';
    if (bodyStartIndex !== -1) {
      const contentStart = bodyStartIndex + '<div class="comment_body "><div class="md">'.length;
      const bodyEndIndex = block.indexOf('</div>', contentStart);
      if (bodyEndIndex !== -1) {
        const rawBody = block.substring(contentStart, bodyEndIndex);
        body = rawBody.replace(/<[^>]*>/g, '').trim();
        body = body
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&#039;/g, "'");
      }
    }

    comments.push({
      id: commentId,
      author,
      score,
      permalink,
      created_utc,
      body
    });
  }
  
  return comments;
}

// Proxy endpoint to fetch comments
app.get('/api/comments', async (req, res) => {
  const threadUrl = req.query.url;
  
  if (!threadUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  }
  
  let targetUrl;
  try {
    targetUrl = normalizeRedditUrl(threadUrl);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  
  try {
    const pathname = new URL(targetUrl).pathname;
    const cached = threadCache.get(pathname);
    
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return res.json({ comments: cached.comments, source: sourceLabel(cached.source), cached: true });
    }
    
    if (!inFlight.has(pathname)) {
      inFlight.set(pathname, fetchThreadComments(targetUrl, pathname).finally(() => inFlight.delete(pathname)));
    }
    const result = await inFlight.get(pathname);
    
    if (result) {
      threadCache.set(pathname, { at: Date.now(), ...result });
      console.log(`[Proxy] ${result.comments.length} comments via ${sourceLabel(result.source)}`);
      return res.json({ comments: result.comments, source: sourceLabel(result.source) });
    }
    
    // Every source is failing or cooling down. Tell the client when to retry instead of hammering.
    const retryAfterSec = Math.max(30, Math.ceil(soonestRecoveryMs() / 1000));
    res.set('Retry-After', String(retryAfterSec));
    
    if (cached && Date.now() - cached.at < STALE_CACHE_MAX_MS) {
      console.warn(`[Proxy] All sources unavailable; serving cached comments (retry in ${retryAfterSec}s)`);
      return res.json({ comments: cached.comments, source: sourceLabel(cached.source), stale: true, retryAfter: retryAfterSec });
    }
    
    const hint = authMode() === 'anonymous'
      ? ' Reddit now blocks anonymous access; paste your Reddit login under "Reddit Access" in the app (see README).'
      : '';
    const errorMsg = `Reddit and all mirrors are blocking or rate-limiting right now. Retrying in ${retryAfterSec}s.${hint}`;
    console.error(`[Error] ${errorMsg}`);
    return res.status(503).json({ error: errorMsg, retryAfter: retryAfterSec });
    
  } catch (error) {
    console.error('[Proxy Error]', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// --- Reddit access (auth) endpoints ---
// These touch your Keychain and Reddit login, so only this machine and this app's own page may call them
// (blocks other devices on the network and cross-site requests from other websites).
function isLocalAppRequest(req) {
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const origin = req.get('origin');
  const sameOrigin = !origin || origin === `${req.protocol}://${req.get('host')}`;
  return isLoopback && sameOrigin && req.get('x-reddit-whisper') === '1';
}

let sessionUser = null; // Username verified for the current session cookie

// Confirms a session cookie is logged in; returns the username or null
async function verifyRedditSession(session) {
  try {
    const res = await fetch('https://www.reddit.com/api/me.json', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
      headers: { 'Cookie': `reddit_session=${session}`, 'User-Agent': USER_AGENTS[0], 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.name || data?.name || null;
  } catch {
    return null;
  }
}

// Look up the username for a session loaded from .env (one request at startup)
if (redditSession) verifyRedditSession(redditSession).then(user => { sessionUser = user; });

app.get('/api/auth/status', (req, res) => {
  if (!isLocalAppRequest(req)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ mode: authMode(), user: authMode() === 'session' ? sessionUser : null });
});

// Activates a session immediately and persists it to .env (empty value = sign out)
function applySession(value, user) {
  redditSession = value || undefined;
  sessionUser = value ? user : null;
  saveEnvValue(path.join(__dirname, '.env'), 'REDDIT_SESSION', value || '');
  
  // Give direct Reddit a fresh chance on the next poll
  sourceHealth.delete(DIRECT_SOURCE);
  if (preferredSource === DIRECT_SOURCE) preferredSource = null;
  threadCache.clear();
}

// Accepts a reddit_session value pasted from the browser. Also tolerates "reddit_session=..." or a whole Cookie header.
function parsePastedSession(input) {
  const text = String(input ?? '').trim();
  const fromCookieHeader = text.match(/(?:^|;\s*)reddit_session=([^;\s]+)/);
  const value = (fromCookieHeader ? fromCookieHeader[1] : text).replace(/^"|"$/g, '');
  return /^[A-Za-z0-9._~%+\/=-]{20,4096}$/.test(value) ? value : null;
}

app.post('/api/auth/session', async (req, res) => {
  if (!isLocalAppRequest(req)) return res.status(403).json({ error: 'Forbidden' });
  
  if (req.body?.clear) {
    applySession('', null);
    console.log('[Auth] Reddit session cleared');
    return res.json({ mode: authMode(), user: null });
  }
  
  const value = parsePastedSession(req.body?.session);
  if (!value) {
    return res.status(400).json({ error: "That doesn't look like a reddit_session value. Copy the Value column of the reddit_session cookie." });
  }
  
  const user = await verifyRedditSession(value);
  applySession(value, user);
  console.log(`[Auth] Saved pasted Reddit session${user ? ` (u/${user})` : ' (could not verify login)'}`);
  res.json({ mode: authMode(), user, verified: Boolean(user) });
});

// Start Express server on available port
function startServer(port) {
  app.listen(port, () => {
    const localUrl = `http://localhost:${port}`;
    console.log(`==================================================`);
    console.log(`🚀 Reddit Whisper is running at: ${localUrl}`);
    console.log(`🔑 Reddit access: ${{ session: 'logged-in session cookie', anonymous: 'anonymous + mirrors (likely blocked; see README)' }[authMode()]}`);
    console.log(`==================================================`);
    
    // Open in browser (set NO_OPEN=1 to skip)
    if (!process.env.NO_OPEN) open(localUrl).catch(err => {
      console.warn(`[Warning] Could not automatically open browser: ${err.message}`);
    });
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️  Port ${port} is in use, trying port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('[Server Error]', err);
    }
  });
}

startServer(DEFAULT_PORT);
