/* ==========================================================================
   REDDIT WHISPER - CORE FRONTEND CONTROLLER
   ========================================================================== */

// --- Application State ---
const state = {
  isListening: false,
  redditUrl: '',
  upvoteThreshold: 10,
  refreshInterval: 30, // seconds
  lookupWindow: 300, // past lookup window in seconds (independent from polling refresh interval!)
  
  // Stats
  commentsSpokenCount: 0,
  commentsFetchedCount: 0,
  lastSyncTime: null,
  appStartTimestamp: 0, // UTC seconds
  
  // Speech & Queue
  voices: [],
  selectedVoiceName: '',
  speechRate: 1.0,
  speechPitch: 1.0,
  playedCommentIds: new Set(),
  speechQueue: [], // For managing our own sequenced speech items
  isSpeaking: false,
  speechGapTimeoutId: null,
  currentUtterance: null,
  
  // Timers
  pollingTimeoutId: null,
  countdownIntervalId: null,
  countdownTimeLeft: 0,
  nextPollAt: 0,
  isFetching: false,
  consecutiveErrors: 0,
  fetchSource: '',
  
  // Auto-tune: picks threshold/window per refresh so 1–10 comments are read.
  // upvoteThreshold/lookupWindow stay the user's manual values; these are the effective ones.
  autoTune: true,
  autoThreshold: null,
  autoLookupWindow: null
};

const AUTO_MIN_COMMENTS = 1;
const AUTO_MAX_COMMENTS = 10;
const LOOKUP_WINDOW_MAX = 1800; // Matches the lookup slider's max

// Older cards are pruned so the DOM stays light during multi-hour match threads
const MAX_FEED_CARDS = 150;
const MAX_ERROR_BACKOFF_SEC = 300;

// --- DOM Elements ---
const elements = {
  redditUrlInput: document.getElementById('reddit-url'),
  btnPaste: document.getElementById('btn-paste'),
  
  upvoteThresholdInput: document.getElementById('upvote-threshold'),
  upvoteVal: document.getElementById('upvote-val'),
  
  refreshIntervalInput: document.getElementById('refresh-interval'),
  intervalVal: document.getElementById('interval-val'),
  
  lookupWindowInput: document.getElementById('lookup-window'),
  lookupVal: document.getElementById('lookup-val'),
  lookupWindowGroup: document.getElementById('lookup-window-group'),
  
  voiceSelect: document.getElementById('voice-select'),
  voiceRateInput: document.getElementById('voice-rate'),
  rateVal: document.getElementById('rate-val'),
  voicePitchInput: document.getElementById('voice-pitch'),
  pitchVal: document.getElementById('pitch-val'),
  btnTestVoice: document.getElementById('btn-test-voice'),
  ttsModelStatus: document.getElementById('tts-model-status'),
  
  btnToggleListening: document.getElementById('btn-toggle-listening'),
  btnText: document.getElementById('btn-text'),
  playIcon: elements => document.querySelector('.play-icon'),
  stopIcon: elements => document.querySelector('.stop-icon'),
  
  systemStatusDot: document.querySelector('.status-dot'),
  statusLabel: document.getElementById('status-label'),
  
  statSyncTime: document.getElementById('stat-sync-time'),
  statCountdown: document.getElementById('stat-countdown'),
  statRead: document.getElementById('stat-read'),
  statSeen: document.getElementById('stat-seen'),
  
  nowBoard: document.getElementById('now-board'),
  boardLabel: document.getElementById('board-label'),
  nowMeta: document.getElementById('now-meta'),
  nowText: document.getElementById('now-text'),
  queueList: document.getElementById('queue-list'),
  queueEmpty: document.getElementById('queue-empty'),
  queueCount: document.getElementById('queue-count'),
  
  soundwave: document.getElementById('soundwave-visualizer'),
  commentsFeed: document.getElementById('comments-feed'),
  feedEmpty: document.getElementById('feed-empty'),
  btnClearFeed: document.getElementById('btn-clear-feed'),
  autoTuneInput: document.getElementById('auto-tune'),
  authStatus: document.getElementById('auth-status'),
  authHint: document.getElementById('auth-hint'),
  sessionPaste: document.getElementById('session-paste'),
  sessionForm: document.getElementById('session-form'),
  sessionInput: document.getElementById('session-input'),
  btnSaveSession: document.getElementById('btn-save-session'),
  btnClearSession: document.getElementById('btn-clear-session')
};

// --- Web Speech API (TTS) Setup ---
const synth = window.speechSynthesis;

// --- Kokoro Neural TTS (on-device, WebGPU / Metal) ---
const KOKORO_PREFIX = 'kokoro:';
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_LIB_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'af_nicole', label: 'Nicole (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' }
];
const hasWebGPU = 'gpu' in navigator;

// Kokoro Michael is the default reader; without WebGPU the Samantha system voice is used instead
const DEFAULT_VOICE = KOKORO_PREFIX + 'am_michael';
if (hasWebGPU) state.selectedVoiceName = DEFAULT_VOICE;

const kokoroEngine = {
  tts: null,
  loading: null,
  audioCtx: null,
  currentSource: null,
  playToken: 0 // Incremented on stop so in-flight generations don't start playing afterwards
};

function setModelStatus(text) {
  if (elements.ttsModelStatus) elements.ttsModelStatus.textContent = `Neural model: ${text}`;
}

function isKokoroVoice(name = state.selectedVoiceName) {
  return name.startsWith(KOKORO_PREFIX);
}

async function getKokoro() {
  if (kokoroEngine.tts) return kokoroEngine.tts;
  if (!hasWebGPU) throw new Error('WebGPU is not available in this browser');
  
  kokoroEngine.loading ??= (async () => {
    setModelStatus('downloading… (~330 MB, first time only)');
    const { KokoroTTS } = await import(KOKORO_LIB_URL);
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: 'fp32', device: 'webgpu' });
    setModelStatus('ready (WebGPU)');
    return tts;
  })().catch(err => {
    kokoroEngine.loading = null;
    setModelStatus('failed to load — using system voice');
    throw err;
  });
  
  kokoroEngine.tts = await kokoroEngine.loading;
  return kokoroEngine.tts;
}

function getAudioContext() {
  kokoroEngine.audioCtx ??= new AudioContext();
  if (kokoroEngine.audioCtx.state === 'suspended') kokoroEngine.audioCtx.resume();
  return kokoroEngine.audioCtx;
}

async function generateKokoroAudio(text, voiceName) {
  const tts = await getKokoro();
  return tts.generate(text, { voice: voiceName.slice(KOKORO_PREFIX.length), speed: state.speechRate });
}

function playKokoroAudio(rawAudio, { onStart, onEnd }) {
  const ctx = getAudioContext();
  const buffer = ctx.createBuffer(1, rawAudio.audio.length, rawAudio.sampling_rate);
  buffer.copyToChannel(rawAudio.audio, 0);
  
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.onended = () => {
    if (kokoroEngine.currentSource === source) kokoroEngine.currentSource = null;
    onEnd?.();
  };
  kokoroEngine.currentSource = source;
  source.start();
  onStart?.();
}

function speakWithSystem(text, { onStart, onEnd, voiceName = state.selectedVoiceName } = {}) {
  if (!synth) {
    onEnd?.();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const activeVoice = state.voices.find(v => v.name === voiceName);
  if (activeVoice) utterance.voice = activeVoice;
  utterance.rate = state.speechRate;
  utterance.pitch = state.speechPitch;
  
  utterance.onstart = () => onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = (e) => {
    console.error('Speech synthesis error:', e);
    onEnd?.();
  };
  synth.speak(utterance);
}

// Speaks text with the selected engine. `pendingAudio` may carry a pre-generated Kokoro clip.
async function speakText(text, { onStart, onEnd, pendingAudio } = {}) {
  const voiceName = state.selectedVoiceName;
  if (!isKokoroVoice(voiceName)) {
    speakWithSystem(text, { onStart, onEnd, voiceName });
    return;
  }
  
  const token = kokoroEngine.playToken;
  try {
    const rawAudio = await (pendingAudio ?? generateKokoroAudio(text, voiceName));
    // Stopped while generating: end like a cancelled utterance so queues keep moving
    if (token !== kokoroEngine.playToken) return onEnd?.();
    playKokoroAudio(rawAudio, { onStart, onEnd });
  } catch (err) {
    console.error('Kokoro TTS error, falling back to system voice:', err);
    if (token !== kokoroEngine.playToken) return onEnd?.();
    const fallback = state.voices.find(v => v.name.toLowerCase().includes('samantha')) || state.voices[0];
    speakWithSystem(text, { onStart, onEnd, voiceName: fallback?.name });
  }
}

function stopSpeech() {
  kokoroEngine.playToken++;
  if (synth) synth.cancel();
  // Stopping fires the source's onended, mirroring how synth.cancel() fires onerror/onend
  kokoroEngine.currentSource?.stop();
}

function syncPitchControl() {
  // Kokoro has no pitch control; only speed applies
  elements.voicePitchInput.disabled = isKokoroVoice();
  elements.voicePitchInput.title = isKokoroVoice() ? 'Pitch is not supported by neural voices' : '';
}

function appendKokoroVoices() {
  const group = document.createElement('optgroup');
  group.label = hasWebGPU ? 'Neural · Kokoro (on-device GPU)' : 'Neural · Kokoro (needs WebGPU)';
  
  KOKORO_VOICES.forEach(({ id, label }) => {
    const option = document.createElement('option');
    option.value = KOKORO_PREFIX + id;
    option.textContent = `Kokoro ${label}`;
    option.disabled = !hasWebGPU;
    option.selected = option.value === state.selectedVoiceName;
    group.appendChild(option);
  });
  
  elements.voiceSelect.appendChild(group);
}

function loadVoices() {
  elements.voiceSelect.innerHTML = '';
  appendKokoroVoices();
  
  if (!synth) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'System TTS not supported in browser';
    elements.voiceSelect.appendChild(opt);
    return;
  }
  
  state.voices = synth.getVoices();
  
  // Try to set 'Samantha' from macOS as the default voice if available on first load
  if (!state.selectedVoiceName && state.voices.length > 0) {
    const samanthaVoice = state.voices.find(v => v.name.toLowerCase().includes('samantha'));
    if (samanthaVoice) {
      state.selectedVoiceName = samanthaVoice.name;
    }
  }
  
  if (state.voices.length === 0) {
    // Some browsers load voices asynchronously. Wait for voiceschanged event.
    const opt = document.createElement('option');
    opt.textContent = 'Retrieving system voices...';
    elements.voiceSelect.appendChild(opt);
    return;
  }
  
  const systemGroup = document.createElement('optgroup');
  systemGroup.label = 'System voices';
  elements.voiceSelect.appendChild(systemGroup);

  // Filter voices to keep only:
  // 1. Local macOS voices that are "enhanced" or "premium" (or standard Samantha)
  // 2. English (EN) or Indian (IN) voices from Google/Chrome speech engines
  const filteredVoices = [];
  
  state.voices.forEach(voice => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase();
    const isLocal = voice.localService;
    
    // Condition 1: High-quality local macOS voices
    const isEnhancedOrPremiumLocal = isLocal && (
      name.includes('enhanced') || 
      name.includes('premium') || 
      name.includes('samantha') ||
      name.includes('alex') ||
      name.includes('siri') ||
      name.includes('rishi')
    );
    
    // Condition 2: English or Indian Google/Chrome voices
    const isEnglishOrIndian = lang.startsWith('en') || lang.endsWith('-in') || lang.startsWith('hi') || name.includes('india');
    const isGoogleChrome = name.includes('google') || name.includes('chrome');
    const isGoogleEnOrIn = isGoogleChrome && isEnglishOrIndian;
    
    if (isEnhancedOrPremiumLocal || isGoogleEnOrIn) {
      filteredVoices.push(voice);
    }
  });

  // Sort voices so Samantha (default) is at the top, followed alphabetically by others
  const sortedVoices = filteredVoices.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    if (aName.includes('samantha')) return -1;
    if (bName.includes('samantha')) return 1;
    return aName.localeCompare(bName);
  });
  
  sortedVoices.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.name;
    
    // Add descriptive tags to clearly explain which model is which
    const name = voice.name.toLowerCase();
    let tag = '';
    
    if (voice.localService) {
      if (name.includes('enhanced')) {
        tag = '[macOS Enhanced]';
      } else if (name.includes('premium')) {
        tag = '[macOS Premium]';
      } else {
        tag = '[macOS Local]';
      }
    } else if (name.includes('google') || name.includes('chrome')) {
      tag = '[Chrome Cloud]';
    } else {
      tag = '[Cloud Neural]';
    }
    
    const isDefault = voice.default ? ' [Default]' : '';
    option.textContent = `${voice.name} (${voice.lang}) ${tag}${isDefault}`;
    
    if (voice.name === state.selectedVoiceName || (voice.default && !state.selectedVoiceName)) {
      option.selected = true;
      state.selectedVoiceName = voice.name;
    }
    
    systemGroup.appendChild(option);
  });
}

// Bind voices changed event
if (synth) {
  if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = loadVoices;
  }
  // Initial load
  loadVoices();
} else {
  loadVoices();
}
if (isKokoroVoice()) {
  // Start loading the default neural voice right away so the first comment isn't delayed
  syncPitchControl();
  getKokoro().catch(err => console.error('Kokoro model failed to load:', err));
} else {
  setModelStatus(hasWebGPU ? 'not loaded (pick a Kokoro voice)' : 'unavailable (WebGPU not supported)');
}

// --- Text Cleanup for Speech ---
function cleanTextForSpeech(text) {
  if (!text) return '';
  
  let cleaned = text;
  
  // Remove markdown blockquotes (often used in cricket threads for stats)
  cleaned = cleaned.replace(/^>+.*/gm, '');
  
  // Replace links/URLs with just "link"
  cleaned = cleaned.replace(/https?:\/\/\S+/gi, 'link');
  
  // Remove formatting characters (asterisks, hashtags, underscores, brackets)
  cleaned = cleaned.replace(/[*#_`~\[\]\(\)]/g, '');
  
  // Replace subreddits or user tags with simpler reading
  cleaned = cleaned.replace(/\/r\/([a-zA-Z0-9_]+)/g, 'subreddit $1');
  cleaned = cleaned.replace(/\/u\/([a-zA-Z0-9_-]+)/g, 'user $1');
  
  // Collapse duplicate whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  // Truncate to avoid speech blockages for massive comments
  const maxLength = 220;
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength) + '... comment truncated.';
  }
  
  return cleaned;
}

// --- Custom Speech Queue Processor ---
// Pre-generated Kokoro clip for the next queued comment, so neural voices don't pause to synthesize
let prefetched = null; // { id, voiceName, promise }

function prefetchNextComment() {
  const next = state.speechQueue[0];
  if (!next || !isKokoroVoice() || prefetched?.id === next.id) return;
  
  const text = cleanTextForSpeech(next.body);
  if (!text) return;
  const voiceName = state.selectedVoiceName;
  const promise = generateKokoroAudio(text, voiceName);
  promise.catch(() => {}); // Errors surface when the clip is consumed
  prefetched = { id: next.id, voiceName, promise };
}

function takePrefetched(comment) {
  const hit = prefetched && prefetched.id === comment.id && prefetched.voiceName === state.selectedVoiceName;
  const promise = hit ? prefetched.promise : undefined;
  prefetched = null;
  return promise;
}

function processSpeechQueue() {
  if (state.isSpeaking || state.speechQueue.length === 0 || !state.isListening) {
    return;
  }
  
  state.isSpeaking = true;
  const comment = state.speechQueue.shift();
  
  const cleanedText = cleanTextForSpeech(comment.body);
  if (!cleanedText) {
    state.isSpeaking = false;
    processSpeechQueue();
    return;
  }
  
  // Visual effects linked to active speech
  const handleSpeechStart = () => {
    elements.soundwave.classList.add('speaking');
    
    showOnBoard(comment);
    
    // The card leaves "Up next" and heads the "Read" list while it's on the board
    const activeCard = document.getElementById(`comment-${comment.id}`);
    if (activeCard) {
      moveCardToFeed(activeCard);
      activeCard.classList.add('now-speaking');
    }
    
    prefetchNextComment();
  };
  
  const handleSpeechEnd = () => {
    elements.soundwave.classList.remove('speaking');
    state.commentsSpokenCount++;
    updateStatsDisplay();
    
    const activeCard = document.getElementById(`comment-${comment.id}`);
    if (activeCard) {
      activeCard.classList.remove('now-speaking');
    }
    elements.nowBoard.classList.remove('is-reading');
    elements.boardLabel.textContent = 'Last read';
    
    // Wait for a pleasant gap (2.0 seconds) before speaking the next comment
    state.speechGapTimeoutId = setTimeout(() => {
      state.isSpeaking = false;
      processSpeechQueue();
    }, 2000);
  };
  
  speakText(cleanedText, {
    onStart: handleSpeechStart,
    onEnd: handleSpeechEnd,
    pendingAudio: takePrefetched(comment)
  });
}

// --- Play Text-To-Speech (TTS) ---
function speakComment(comment) {
  if (!state.isListening) return;
  state.speechQueue.push(comment);
  processSpeechQueue();
}

// --- Live Timeline UI Rendering ---
function renderCommentCard(comment) {
  // Check if card already exists
  if (document.getElementById(`comment-${comment.id}`)) return;
  
  const card = document.createElement('article');
  card.id = `comment-${comment.id}`;
  card.className = 'comment-card';
  
  // Add highlight styles depending on popularity (score)
  if (comment.score >= state.upvoteThreshold * 3) {
    card.classList.add('super-popular');
  } else if (comment.score >= state.upvoteThreshold * 1.8) {
    card.classList.add('popular');
  }
  
  // Format readable time
  const timeStr = new Date(comment.created_utc * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const author = escapeHTML(comment.author);
  const permalink = comment.permalink ? escapeHTML(comment.permalink) : null;
  
  card.innerHTML = `
    <div class="card-score" title="${comment.score} upvotes">${comment.score}</div>
    <div class="card-main">
      <div class="card-meta">
        <a href="https://reddit.com/user/${encodeURIComponent(comment.author)}" target="_blank" rel="noopener" class="author-name">u/${author}</a>
        <span>${timeStr}</span>
      </div>
      <p class="card-body">${escapeHTML(comment.body)}</p>
      <div class="card-actions">
        <button class="text-btn btn-replay" type="button" data-id="${escapeHTML(comment.id)}">Replay</button>
        ${permalink ? `<a href="${permalink}" target="_blank" rel="noopener" class="text-btn">Open on Reddit</a>` : ''}
      </div>
    </div>
  `;
  
  // Add click handler to replay button
  const replayBtn = card.querySelector('.btn-replay');
  replayBtn.addEventListener('click', () => {
    // Replay speaks independently of current subscription status
    stopSpeech();
    speakText(cleanTextForSpeech(comment.body), {
      onStart: () => elements.soundwave.classList.add('speaking'),
      onEnd: () => elements.soundwave.classList.remove('speaking')
    });
  });
  
  // New comments wait in "Up next" in reading order
  elements.queueList.appendChild(card);
  updateQueueDisplay();
}

// Moves a card to the top of the "Read" list
function moveCardToFeed(card) {
  elements.feedEmpty.classList.add('hidden');
  elements.commentsFeed.insertBefore(card, elements.commentsFeed.firstChild);
  updateQueueDisplay();
  pruneFeed();
}

function updateQueueDisplay() {
  const waiting = elements.queueList.querySelectorAll('.comment-card').length;
  elements.queueEmpty.classList.toggle('hidden', waiting > 0);
  elements.queueCount.textContent = waiting ? `${waiting} waiting` : '';
}

function showOnBoard(comment) {
  elements.nowBoard.classList.add('is-reading');
  elements.boardLabel.textContent = 'Now reading';
  elements.nowMeta.innerHTML = `u/${escapeHTML(comment.author)}<span class="score" title="Upvotes">${comment.score}</span>`;
  elements.nowText.textContent = comment.body;
  
  // Restart the reveal animation for each new comment
  elements.nowText.classList.remove('reveal');
  void elements.nowText.offsetWidth;
  elements.nowText.classList.add('reveal');
}

function pruneFeed() {
  const cards = elements.commentsFeed.querySelectorAll('.comment-card');
  for (let i = MAX_FEED_CARDS; i < cards.length; i++) {
    // Keep the card that's currently being read aloud
    if (!cards[i].classList.contains('now-speaking')) cards[i].remove();
  }
}

// --- Fetch & Process Comments ---
// Returns the delay (seconds) until the next poll
async function fetchMatchComments() {
  if (!state.isListening) return state.refreshInterval;
  
  updateSyncStatus('Fetching...');
  
  try {
    const response = await fetch(`/api/comments?url=${encodeURIComponent(state.redditUrl)}`);
    const data = await response.json().catch(() => ({}));
    
    if (!response.ok) {
      const error = new Error(data.error || `Proxy returned ${response.status}`);
      error.retryAfter = data.retryAfter;
      throw error;
    }
    
    if (!state.isListening) return state.refreshInterval; // Stopped while the request was in flight
    
    const incomingComments = data.comments || [];
    
    state.commentsFetchedCount = incomingComments.length;
    state.fetchSource = data.stale ? `${data.source}, cached` : data.source || '';
    
    // Use the newest comment time as a reference to prevent clock drift issues.
    // Mirror HTML includes nested replies, so the first item isn't guaranteed to be the newest.
    const referenceTime = incomingComments.length
      ? Math.max(...incomingComments.map(c => c.created_utc))
      : Math.floor(Date.now() / 1000);
    const cutoffTime = referenceTime - state.lookupWindow;
    
    const selected = state.autoTune
      ? autoSelectComments(incomingComments, referenceTime)
      : incomingComments.filter(comment =>
          comment.score >= state.upvoteThreshold &&       // 1. Upvote Filter
          !state.playedCommentIds.has(comment.id) &&      // 2. Deduplication Filter
          comment.created_utc >= cutoffTime                // 3. Time Filter
        );
    
    // Queue older comments first so they're read in chronological order
    const commentsToSpeak = selected.sort((a, b) => a.created_utc - b.created_utc);
    
    commentsToSpeak.forEach(comment => {
      state.playedCommentIds.add(comment.id);
      renderCommentCard(comment);
      speakComment(comment);
    });
    
    // Update active visual timestamps
    state.lastSyncTime = new Date();
    state.consecutiveErrors = 0;
    updateSyncStatus('Active');
    updateStatsDisplay();
    
    // Server is serving cached data because every source is cooling down; wait as long as it asks
    return Math.max(state.refreshInterval, data.retryAfter || 0);
    
  } catch (error) {
    console.error('Fetcher error:', error);
    state.consecutiveErrors++;
    updateSyncStatus('Error', error.message);
    
    // Exponential backoff so repeated failures don't keep hitting Reddit at full rate
    const backoff = state.refreshInterval * 2 ** Math.min(state.consecutiveErrors, 4);
    return Math.min(MAX_ERROR_BACKOFF_SEC, Math.max(backoff, error.retryAfter || 0));
  }
}

// --- Auto-tune Filters ---
// Picks the best 1–10 unread comments for this refresh. Starts from the user's lookup window and
// widens it while the thread is quiet; the threshold becomes the lowest score that made the cut.
function autoSelectComments(comments, referenceTime) {
  const unread = comments.filter(c => !state.playedCommentIds.has(c.id));
  const inWindow = windowSec => unread.filter(c => c.created_utc >= referenceTime - windowSec);
  
  let windowSec = state.lookupWindow;
  let candidates = inWindow(windowSec);
  while (candidates.length < AUTO_MIN_COMMENTS && windowSec < LOOKUP_WINDOW_MAX) {
    windowSec = Math.min(LOOKUP_WINDOW_MAX, Math.ceil((windowSec * 1.5) / 30) * 30);
    candidates = inWindow(windowSec);
  }
  
  // Highest score first; newer wins ties
  const selected = candidates
    .sort((a, b) => b.score - a.score || b.created_utc - a.created_utc)
    .slice(0, AUTO_MAX_COMMENTS);
  
  state.autoLookupWindow = windowSec;
  if (selected.length) state.autoThreshold = selected[selected.length - 1].score;
  renderFilterControls();
  return selected;
}

// Reflects manual vs auto-tuned filter values in the sliders
function renderFilterControls() {
  const auto = state.autoTune;
  const threshold = auto && state.autoThreshold !== null ? state.autoThreshold : state.upvoteThreshold;
  
  elements.upvoteThresholdInput.disabled = auto;
  elements.upvoteThresholdInput.value = Math.min(threshold, Number(elements.upvoteThresholdInput.max));
  elements.upvoteVal.textContent = auto ? (state.autoThreshold === null ? 'Auto' : `Auto · ${threshold}`) : threshold;
  
  const windowSec = auto && state.isListening && state.autoLookupWindow ? state.autoLookupWindow : state.lookupWindow;
  elements.lookupVal.textContent = windowSec !== state.lookupWindow ? `${state.lookupWindow}s → ${windowSec}s` : `${windowSec}s`;
}

// --- Polling and Timers ---
// A poll is only scheduled after the previous one finishes, so slow failovers never overlap
function schedulePoll(delaySec) {
  clearTimeout(state.pollingTimeoutId);
  state.nextPollAt = Date.now() + delaySec * 1000;
  resetCountdown();
  state.pollingTimeoutId = setTimeout(runPoll, delaySec * 1000);
}

async function runPoll() {
  if (!state.isListening || state.isFetching) return;
  state.isFetching = true;
  const nextDelay = await fetchMatchComments();
  state.isFetching = false;
  if (state.isListening) schedulePoll(nextDelay);
}

function startPolling() {
  // Set starting timestamp (in UTC seconds)
  state.appStartTimestamp = Math.floor(Date.now() / 1000);
  state.consecutiveErrors = 0;
  
  // Clear any existing timers
  clearTimeout(state.pollingTimeoutId);
  clearInterval(state.countdownIntervalId);
  
  // Perform immediate first fetch
  runPoll();
  
  // Start countdown visual timer
  state.countdownIntervalId = setInterval(() => {
    if (state.isFetching) {
      elements.statCountdown.textContent = 'Syncing...';
      return;
    }
    state.countdownTimeLeft = Math.max(0, Math.ceil((state.nextPollAt - Date.now()) / 1000));
    elements.statCountdown.textContent = `${state.countdownTimeLeft}s`;
  }, 1000);
}

function stopPolling() {
  clearTimeout(state.pollingTimeoutId);
  clearInterval(state.countdownIntervalId);
  state.pollingTimeoutId = null;
  state.countdownIntervalId = null;
  
  // Clear custom speech queue and active gaps
  state.speechQueue = [];
  state.isSpeaking = false;
  clearTimeout(state.speechGapTimeoutId);
  
  prefetched = null;
  stopSpeech();
  
  // Anything still waiting won't be read now; keep it visible under "Read" as skipped
  [...elements.queueList.querySelectorAll('.comment-card')].reverse().forEach(card => {
    card.classList.add('skipped');
    moveCardToFeed(card);
  });
  elements.commentsFeed.querySelectorAll('.now-speaking').forEach(card => card.classList.remove('now-speaking'));
  elements.nowBoard.classList.remove('is-reading');
  if (state.commentsSpokenCount) elements.boardLabel.textContent = 'Last read';
  
  elements.soundwave.classList.remove('speaking');
  updateSyncStatus('Idle');
  renderFilterControls();
}

function resetCountdown() {
  state.countdownTimeLeft = Math.max(0, Math.ceil((state.nextPollAt - Date.now()) / 1000));
  elements.statCountdown.textContent = `${state.countdownTimeLeft}s`;
}

// --- UI Sync Display Helpers ---
function updateSyncStatus(status, detail = '') {
  elements.systemStatusDot.className = 'status-dot';
  
  if (status === 'Idle') {
    elements.systemStatusDot.classList.add('status-idle');
    elements.statusLabel.textContent = 'Not listening';
    elements.statCountdown.textContent = '–';
  } else if (status === 'Fetching...') {
    elements.systemStatusDot.classList.add('status-active');
    elements.statusLabel.textContent = 'Checking for new comments…';
  } else if (status === 'Active') {
    elements.systemStatusDot.classList.add('status-active');
    elements.statusLabel.textContent = state.fetchSource ? `Listening via ${state.fetchSource}` : 'Listening';
    elements.statSyncTime.textContent = state.lastSyncTime ? state.lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–';
  } else if (status === 'Error') {
    elements.systemStatusDot.classList.add('status-idle');
    elements.statusLabel.textContent = `Couldn't fetch comments: ${detail}`;
  }
}

function updateStatsDisplay() {
  elements.statRead.textContent = state.commentsSpokenCount;
  elements.statSeen.textContent = state.commentsFetchedCount;
}

// --- Input synchronizers & Interactive elements ---

// Auto-tune toggle
elements.autoTuneInput.addEventListener('change', (e) => {
  state.autoTune = e.target.checked;
  state.autoThreshold = null;
  state.autoLookupWindow = null;
  renderFilterControls();
});
state.autoTune = elements.autoTuneInput.checked;
renderFilterControls();

// Upvote slider sync
elements.upvoteThresholdInput.addEventListener('input', (e) => {
  state.upvoteThreshold = parseInt(e.target.value, 10);
  elements.upvoteVal.textContent = state.upvoteThreshold;
});

// Refresh interval slider sync
elements.refreshIntervalInput.addEventListener('input', (e) => {
  state.refreshInterval = parseInt(e.target.value, 10);
  elements.intervalVal.textContent = `${state.refreshInterval}s`;
});

// Reschedule on release only (not every drag tick) and never fire an extra immediate request
elements.refreshIntervalInput.addEventListener('change', () => {
  if (!state.isListening || state.isFetching || state.consecutiveErrors > 0) return;
  const elapsedSec = state.lastSyncTime ? (Date.now() - state.lastSyncTime.getTime()) / 1000 : 0;
  schedulePoll(Math.max(5, state.refreshInterval - elapsedSec));
});

// Lookup window slider sync
elements.lookupWindowInput.addEventListener('input', (e) => {
  state.lookupWindow = parseInt(e.target.value, 10);
  renderFilterControls();
});

// Voice selectors & settings sync
elements.voiceSelect.addEventListener('change', (e) => {
  state.selectedVoiceName = e.target.value;
  syncPitchControl();
  
  // Start downloading/compiling the neural model as soon as it's picked
  if (isKokoroVoice()) {
    getKokoro().catch(err => console.error('Kokoro model failed to load:', err));
  }
});

elements.voiceRateInput.addEventListener('input', (e) => {
  state.speechRate = parseFloat(e.target.value);
  elements.rateVal.textContent = state.speechRate.toFixed(1);
});

elements.voicePitchInput.addEventListener('input', (e) => {
  state.speechPitch = parseFloat(e.target.value);
  elements.pitchVal.textContent = state.speechPitch.toFixed(1);
});

// Clipboard paste helper
elements.btnPaste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    elements.redditUrlInput.value = text;
    elements.redditUrlInput.focus();
  } catch (err) {
    console.warn('Unable to access clipboard. Paste manually.', err);
  }
});

// Test Voice settings
elements.btnTestVoice.addEventListener('click', () => {
  stopSpeech();
  if (isKokoroVoice()) getAudioContext(); // Unlock audio during the user gesture
  
  speakText('Testing Reddit Whisper. Audio engine configured correctly.', {
    onStart: () => elements.soundwave.classList.add('speaking'),
    onEnd: () => elements.soundwave.classList.remove('speaking')
  });
});

// Clear Feed history
elements.btnClearFeed.addEventListener('click', () => {
  // Clears the "Read" list; anything in "Up next" stays queued
  elements.commentsFeed.querySelectorAll('.comment-card:not(.now-speaking)').forEach(card => card.remove());
  elements.feedEmpty.classList.toggle('hidden', elements.commentsFeed.querySelector('.comment-card') !== null);
  
  // Reset the counter; already-read comments stay remembered so they aren't read again
  state.commentsSpokenCount = 0;
  updateStatsDisplay();
});

// Toggle subscription (Start/Stop)
elements.btnToggleListening.addEventListener('click', () => {
  const urlValue = elements.redditUrlInput.value.trim();
  
  if (!state.isListening) {
    // STARTING
    if (!urlValue) {
      alert('Please enter a valid Reddit match thread or post URL to begin.');
      elements.redditUrlInput.focus();
      return;
    }
    
    // Save configurations
    state.redditUrl = urlValue;
    state.isListening = true;
    
    // Toggle UI States
    elements.btnToggleListening.classList.add('listening');
    elements.btnText.textContent = 'Stop listening';
    document.querySelector('.play-icon').classList.add('hidden');
    document.querySelector('.stop-icon').classList.remove('hidden');
    
    // Lock critical inputs during subscription
    elements.redditUrlInput.disabled = true;
    elements.btnPaste.disabled = true;
    elements.lookupWindowInput.disabled = true;
    
    // Trigger notification
    stopSpeech();
    if (isKokoroVoice()) getAudioContext(); // Unlock audio during the user gesture
    speakText('Whisperer activated. Subscribing to Reddit thread.');
    
    // Start Scraper Loop
    startPolling();
    
  } else {
    // STOPPING
    state.isListening = false;
    
    // Toggle UI States
    elements.btnToggleListening.classList.remove('listening');
    elements.btnText.textContent = 'Start listening';
    document.querySelector('.play-icon').classList.remove('hidden');
    document.querySelector('.stop-icon').classList.add('hidden');
    
    // Unlock critical inputs
    elements.redditUrlInput.disabled = false;
    elements.btnPaste.disabled = false;
    elements.lookupWindowInput.disabled = false;
    
    // Stop Scraper Loop
    stopPolling();
  }
});

// --- Simple Utility HTML Escaper ---
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Reddit Access (login session) ---
// The header marks requests from this page; the server rejects auth calls without it
const AUTH_HEADERS = { 'X-Reddit-Whisper': '1' };

function renderAuthStatus({ mode, user }) {
  const labels = {
    session: user ? `Logged in as u/${user}` : 'Logged in (session saved)',
    anonymous: 'Anonymous (likely blocked)'
  };
  elements.authStatus.textContent = labels[mode] || 'Unknown';
  elements.authStatus.className = `auth-pill ${mode === 'session' ? 'auth-pill-ok' : 'auth-pill-warn'}`;
  elements.btnClearSession.hidden = mode !== 'session';
  // Pasting the cookie is the only way to log in, so keep it visible until a session exists
  if (mode === 'anonymous') elements.sessionPaste.open = true;
}

async function loadAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', { headers: AUTH_HEADERS });
    renderAuthStatus(await res.json());
  } catch {
    elements.authStatus.textContent = 'Status unavailable';
  }
}

async function postSession(body) {
  const res = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { ...AUTH_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Saving failed (${res.status})`);
  return data;
}

elements.sessionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const session = elements.sessionInput.value.trim();
  if (!session) {
    elements.sessionInput.focus();
    return;
  }
  
  elements.btnSaveSession.disabled = true;
  elements.btnSaveSession.textContent = 'Checking…';
  try {
    const data = await postSession({ session });
    elements.sessionInput.value = '';
    renderAuthStatus(data);
    elements.authHint.textContent = data.verified
      ? 'Login saved to .env and active now.'
      : "Saved, but Reddit didn't confirm the login. If fetching still fails, the cookie may be expired; copy it again after logging in.";
    if (data.verified) elements.sessionPaste.open = false;
  } catch (err) {
    elements.authHint.textContent = err.message;
  } finally {
    elements.btnSaveSession.disabled = false;
    elements.btnSaveSession.textContent = 'Save';
  }
});

elements.btnClearSession.addEventListener('click', async () => {
  try {
    renderAuthStatus(await postSession({ clear: true }));
    elements.authHint.textContent = 'Saved login removed.';
  } catch (err) {
    elements.authHint.textContent = err.message;
  }
});

loadAuthStatus();
