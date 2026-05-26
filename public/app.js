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
  pollingIntervalId: null,
  countdownIntervalId: null,
  countdownTimeLeft: 0
};

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
  
  btnToggleListening: document.getElementById('btn-toggle-listening'),
  btnText: document.getElementById('btn-text'),
  playIcon: elements => document.querySelector('.play-icon'),
  stopIcon: elements => document.querySelector('.stop-icon'),
  
  systemStatusDot: document.querySelector('.status-dot'),
  statusLabel: document.getElementById('status-label'),
  
  statSyncTime: document.getElementById('stat-sync-time'),
  statCountdown: document.getElementById('stat-countdown'),
  statCommentsCount: document.getElementById('stat-comments-count'),
  
  soundwave: document.getElementById('soundwave-visualizer'),
  commentsFeed: document.getElementById('comments-feed'),
  feedEmpty: document.getElementById('feed-empty'),
  btnClearFeed: document.getElementById('btn-clear-feed')
};

// --- Web Speech API (TTS) Setup ---
const synth = window.speechSynthesis;

function loadVoices() {
  if (!synth) {
    elements.voiceSelect.innerHTML = '<option value="">TTS Not Supported in browser</option>';
    return;
  }
  
  state.voices = synth.getVoices();
  
  // Try to set 'Rishi' from India as the default voice if available on first load
  if (!state.selectedVoiceName && state.voices.length > 0) {
    const rishiVoice = state.voices.find(v => v.name.toLowerCase().includes('rishi'));
    if (rishiVoice) {
      state.selectedVoiceName = rishiVoice.name;
    }
  }
  
  // Render voices in select dropdown
  elements.voiceSelect.innerHTML = '';
  
  if (state.voices.length === 0) {
    // Some browsers load voices asynchronously. Wait for voiceschanged event.
    const opt = document.createElement('option');
    opt.textContent = 'Retrieving system voices...';
    elements.voiceSelect.appendChild(opt);
    return;
  }

  // Group and sort voices (English first, then others)
  const englishVoices = [];
  const otherVoices = [];
  
  state.voices.forEach(voice => {
    if (voice.lang.startsWith('en')) {
      englishVoices.push(voice);
    } else {
      otherVoices.push(voice);
    }
  });

  const sortedVoices = [...englishVoices, ...otherVoices];
  
  sortedVoices.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.name;
    
    // Highlight premium or default voices
    const isDefault = voice.default ? ' [Default]' : '';
    const isLocal = voice.localService ? '' : ' (Cloud)';
    option.textContent = `${voice.name} (${voice.lang})${isDefault}${isLocal}`;
    
    if (voice.name === state.selectedVoiceName || (voice.default && !state.selectedVoiceName)) {
      option.selected = true;
      state.selectedVoiceName = voice.name;
    }
    
    elements.voiceSelect.appendChild(option);
  });
}

// Bind voices changed event
if (synth) {
  if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = loadVoices;
  }
  // Initial load
  loadVoices();
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
  
  const utterance = new SpeechSynthesisUtterance(cleanedText);
  
  // Find selected voice
  const activeVoice = state.voices.find(v => v.name === state.selectedVoiceName);
  if (activeVoice) {
    utterance.voice = activeVoice;
  }
  
  utterance.rate = state.speechRate;
  utterance.pitch = state.speechPitch;
  
  // Visual effects linked to active speech
  utterance.onstart = () => {
    elements.soundwave.classList.add('speaking');
    
    // Highlight the card currently playing
    const activeCard = document.getElementById(`comment-${comment.id}`);
    if (activeCard) {
      activeCard.classList.add('super-popular');
      activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  
  const handleSpeechEnd = () => {
    elements.soundwave.classList.remove('speaking');
    state.commentsSpokenCount++;
    updateStatsDisplay();
    
    const activeCard = document.getElementById(`comment-${comment.id}`);
    if (activeCard) {
      activeCard.classList.remove('super-popular');
    }
    
    // Wait for a pleasant gap (2.0 seconds) before speaking the next comment
    state.speechGapTimeoutId = setTimeout(() => {
      state.isSpeaking = false;
      processSpeechQueue();
    }, 2000);
  };
  
  utterance.onend = handleSpeechEnd;
  
  utterance.onerror = (e) => {
    console.error('Speech synthesis error:', e);
    handleSpeechEnd();
  };
  
  synth.speak(utterance);
}

// --- Play Text-To-Speech (TTS) ---
function speakComment(comment) {
  if (!synth || !state.isListening) return;
  state.speechQueue.push(comment);
  processSpeechQueue();
}

// --- Live Timeline UI Rendering ---
function renderCommentCard(comment) {
  // Hide empty state if present
  elements.feedEmpty.classList.add('hidden');
  
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
  const dateObj = new Date(comment.created_utc * 1000);
  const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  card.innerHTML = `
    <div class="card-header">
      <div class="author-area">
        <div class="author-avatar">${comment.author.substring(0, 2).toUpperCase()}</div>
        <a href="https://reddit.com/user/${comment.author}" target="_blank" class="author-name">u/${comment.author}</a>
      </div>
      <div class="badge-row">
        <span class="time-stamp">${timeStr}</span>
        <div class="upvote-badge">
          <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 14h6v8h4v-8h6L12 4 4 14z"/>
          </svg>
          ${comment.score}
        </div>
      </div>
    </div>
    <div class="card-body">${escapeHTML(comment.body)}</div>
    <div class="card-footer">
      <a href="${comment.permalink}" target="_blank" class="card-action-btn btn-reddit">
        Reddit
      </a>
      <button class="card-action-btn btn-replay" data-id="${comment.id}">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        Replay Audio
      </button>
    </div>
  `;
  
  // Add click handler to replay button
  const replayBtn = card.querySelector('.btn-replay');
  replayBtn.addEventListener('click', () => {
    // Replay speaks independently of current subscription status
    const origUtterance = new SpeechSynthesisUtterance(cleanTextForSpeech(comment.body));
    const activeVoice = state.voices.find(v => v.name === state.selectedVoiceName);
    if (activeVoice) origUtterance.voice = activeVoice;
    origUtterance.rate = state.speechRate;
    origUtterance.pitch = state.speechPitch;
    
    origUtterance.onstart = () => elements.soundwave.classList.add('speaking');
    origUtterance.onend = () => elements.soundwave.classList.remove('speaking');
    
    synth.cancel();
    synth.speak(origUtterance);
  });
  
  // Insert at top of timeline (reverse chronological order)
  elements.commentsFeed.insertBefore(card, elements.commentsFeed.firstChild);
}

// --- Fetch & Process Comments ---
async function fetchMatchComments() {
  if (!state.isListening) return;
  
  updateSyncStatus('Fetching...');
  
  try {
    const response = await fetch(`/api/comments?url=${encodeURIComponent(state.redditUrl)}`);
    
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || `Proxy returned ${response.status}`);
    }
    
    const data = await response.json();
    const incomingComments = data.comments || [];
    
    state.commentsFetchedCount = incomingComments.length;
    
    // Find the newest comment time as a reference to prevent clock drift issues
    const newestComment = incomingComments[0];
    const referenceTime = newestComment ? newestComment.created_utc : Math.floor(Date.now() / 1000);
    const cutoffTime = referenceTime - state.lookupWindow;
    
    // Process comments. Note: Reddit sorting by "new" returns newest comments first.
    // We reverse them to queue the older ones first in our Text-To-Speech engine.
    const commentsToSpeak = [];
    
    incomingComments.slice().reverse().forEach(comment => {
      // 1. Upvote Filter
      if (comment.score < state.upvoteThreshold) return;
      
      // 2. Deduplication Filter
      if (state.playedCommentIds.has(comment.id)) return;
      
      // 3. Time Filter: only process comments posted within the lookup window
      if (comment.created_utc < cutoffTime) return;
      
      // Record comment as seen
      state.playedCommentIds.add(comment.id);
      
      // Render timeline card
      renderCommentCard(comment);
      
      // Queue for speech
      commentsToSpeak.push(comment);
    });
    
    // Add comments to our custom speech queue to play with gaps
    commentsToSpeak.forEach(comment => {
      speakComment(comment);
    });
    
    // Update active visual timestamps
    state.lastSyncTime = new Date();
    updateSyncStatus('Active');
    updateStatsDisplay();
    resetCountdown();
    
  } catch (error) {
    console.error('Fetcher error:', error);
    updateSyncStatus('Error', error.message);
  }
}

// --- Polling and Timers ---
function startPolling() {
  // Set starting timestamp (in UTC seconds)
  state.appStartTimestamp = Math.floor(Date.now() / 1000);
  
  // Clear any existing timers
  clearInterval(state.pollingIntervalId);
  clearInterval(state.countdownIntervalId);
  
  // Perform immediate first fetch
  fetchMatchComments();
  
  // Set recursive polling interval
  state.pollingIntervalId = setInterval(fetchMatchComments, state.refreshInterval * 1000);
  
  // Start countdown visual timer
  resetCountdown();
  state.countdownIntervalId = setInterval(() => {
    if (state.countdownTimeLeft > 0) {
      state.countdownTimeLeft--;
      elements.statCountdown.textContent = `${state.countdownTimeLeft}s`;
    } else {
      elements.statCountdown.textContent = 'Syncing...';
    }
  }, 1000);
}

function stopPolling() {
  clearInterval(state.pollingIntervalId);
  clearInterval(state.countdownIntervalId);
  state.pollingIntervalId = null;
  state.countdownIntervalId = null;
  
  // Clear custom speech queue and active gaps
  state.speechQueue = [];
  state.isSpeaking = false;
  clearTimeout(state.speechGapTimeoutId);
  
  if (synth) {
    synth.cancel(); // Stop playing speech
  }
  
  elements.soundwave.classList.remove('speaking');
  updateSyncStatus('Idle');
}

function resetCountdown() {
  state.countdownTimeLeft = state.refreshInterval;
  elements.statCountdown.textContent = `${state.countdownTimeLeft}s`;
}

// --- UI Sync Display Helpers ---
function updateSyncStatus(status, detail = '') {
  elements.systemStatusDot.className = 'status-dot';
  
  if (status === 'Idle') {
    elements.systemStatusDot.classList.add('status-idle');
    elements.statusLabel.textContent = 'System Idle';
    elements.statSyncTime.textContent = 'Stopped';
  } else if (status === 'Fetching...') {
    elements.systemStatusDot.classList.add('status-active');
    elements.statusLabel.textContent = 'Fetching Comments...';
  } else if (status === 'Active') {
    elements.systemStatusDot.classList.add('status-active');
    elements.statusLabel.textContent = 'Listening Live';
    elements.statSyncTime.textContent = state.lastSyncTime ? state.lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Just now';
  } else if (status === 'Error') {
    elements.systemStatusDot.classList.add('status-idle');
    elements.statusLabel.textContent = `Sync Error: ${detail}`;
    elements.statSyncTime.textContent = 'Error occurred';
  }
}

function updateStatsDisplay() {
  elements.statCommentsCount.textContent = `${state.commentsSpokenCount} / ${state.commentsFetchedCount}`;
}

// --- Input synchronizers & Interactive elements ---

// Upvote slider sync
elements.upvoteThresholdInput.addEventListener('input', (e) => {
  state.upvoteThreshold = parseInt(e.target.value, 10);
  elements.upvoteVal.textContent = state.upvoteThreshold;
});

// Refresh interval slider sync
elements.refreshIntervalInput.addEventListener('input', (e) => {
  state.refreshInterval = parseInt(e.target.value, 10);
  elements.intervalVal.textContent = `${state.refreshInterval}s`;
  
  // If active, reset and update current timer
  if (state.isListening) {
    startPolling();
  }
});

// Lookup window slider sync
elements.lookupWindowInput.addEventListener('input', (e) => {
  state.lookupWindow = parseInt(e.target.value, 10);
  elements.lookupVal.textContent = `${state.lookupWindow}s`;
});

// Voice selectors & settings sync
elements.voiceSelect.addEventListener('change', (e) => {
  state.selectedVoiceName = e.target.value;
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
  if (!synth) return;
  synth.cancel(); // cancel current speech
  
  const testUtterance = new SpeechSynthesisUtterance('Testing Reddit Whisper. Audio engine configured correctly.');
  const activeVoice = state.voices.find(v => v.name === state.selectedVoiceName);
  if (activeVoice) testUtterance.voice = activeVoice;
  
  testUtterance.rate = state.speechRate;
  testUtterance.pitch = state.speechPitch;
  
  testUtterance.onstart = () => elements.soundwave.classList.add('speaking');
  testUtterance.onend = () => elements.soundwave.classList.remove('speaking');
  
  synth.speak(testUtterance);
});

// Clear Feed history
elements.btnClearFeed.addEventListener('click', () => {
  elements.commentsFeed.innerHTML = '';
  // Re-display empty state
  elements.feedEmpty.classList.remove('hidden');
  elements.commentsFeed.appendChild(elements.feedEmpty);
  
  // Reset spoken states
  state.commentsSpokenCount = 0;
  state.playedCommentIds.clear();
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
    elements.btnText.textContent = 'Stop Listening';
    document.querySelector('.play-icon').classList.add('hidden');
    document.querySelector('.stop-icon').classList.remove('hidden');
    
    // Lock critical inputs during subscription
    elements.redditUrlInput.disabled = true;
    elements.btnPaste.disabled = true;
    elements.lookupWindowInput.disabled = true;
    
    // Trigger notification
    if (synth) {
      synth.cancel();
      const startUtterance = new SpeechSynthesisUtterance('Whisperer activated. Subscribing to Reddit thread.');
      const activeVoice = state.voices.find(v => v.name === state.selectedVoiceName);
      if (activeVoice) startUtterance.voice = activeVoice;
      synth.speak(startUtterance);
    }
    
    // Start Scraper Loop
    startPolling();
    
  } else {
    // STOPPING
    state.isListening = false;
    
    // Toggle UI States
    elements.btnToggleListening.classList.remove('listening');
    elements.btnText.textContent = 'Start Listening';
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
