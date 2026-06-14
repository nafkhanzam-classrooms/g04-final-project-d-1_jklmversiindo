/* eslint-disable */
/**
 * public/game.js
 *
 * WordFuse client controller.
 *
 * - Keeps a stable UUID `wordfuse.playerId` in localStorage.
 * - Connects to the Socket.io server on the same hostname, port 3001.
 * - Handles all server -> client events and switches between Join / Game /
 *   Results screens via body class names ("screen-join" | "screen-game" |
 *   "screen-results").
 * - Drives the bomb pulse rate (CSS var --pulse-ms) and color (--remaining-ratio)
 *   from the server-authoritative `timer_tick`.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Persistent identity
  // -------------------------------------------------------------------------
  function ensurePlayerId() {
    var id = null;
    try {
      id = localStorage.getItem('wordfuse.playerId');
    } catch (e) { /* localStorage may be blocked */ }
    if (!id) {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        id = window.crypto.randomUUID();
      } else {
        // Fallback (RFC4122 v4-ish, not crypto-grade but fine for LAN play).
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          var v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
      try { localStorage.setItem('wordfuse.playerId', id); } catch (e) {}
    }
    return id;
  }

  var playerId = ensurePlayerId();

  // -------------------------------------------------------------------------
  // DOM lookups
  // -------------------------------------------------------------------------
  var body = document.body;
  var joinForm = document.getElementById('join-form');
  var nameInput = document.getElementById('name');
  var lobbyList = document.getElementById('lobby-list');
  var startBtn = document.getElementById('start-btn');
  var joinStatus = document.getElementById('join-status');

  var bomb = document.getElementById('bomb');
  var syllableEl = document.getElementById('syllable');
  var timerBar = document.getElementById('timer-bar');
  var timerText = document.getElementById('timer-text');
  var playerListEl = document.getElementById('player-list');
  var lastWordEl = document.getElementById('last-word');
  var wordForm = document.getElementById('word-form');
  var wordInput = document.getElementById('word');
  var wordSubmit = document.getElementById('word-submit');
  var gameStatus = document.getElementById('game-status');

  var winnerBanner = document.getElementById('winner-banner');
  var scoreboardEl = document.getElementById('scoreboard');
  var playAgainBtn = document.getElementById('play-again-btn');

  // --- Chat & confirmation UI mounts ---
  var chatPanel = document.getElementById('chat-panel');
  var chatLog = document.getElementById('chat-log');
  var chatForm = document.getElementById('chat-form');
  var chatInput = document.getElementById('chat-input');
  var chatToggle = document.getElementById('chat-toggle');
  var chatClose = document.getElementById('chat-close');
  var toastStack = document.getElementById('toast-stack');
  var eventBanner = document.getElementById('event-banner');
  var confettiStage = document.getElementById('confetti-stage');

  // -------------------------------------------------------------------------
  // Local state for rendering
  // -------------------------------------------------------------------------
  var roster = []; // last lobby_update / inferred player list
  var rosterByLobby = []; // most recent lobby_update payload
  var activePlayerId = null;
  var currentSyllable = null;
  var currentInitialMs = 10000;
  var lives = {}; // playerId -> lives count

  // -------------------------------------------------------------------------
  // Screen routing
  // -------------------------------------------------------------------------
  function setScreen(name) {
    body.classList.remove('screen-join', 'screen-game', 'screen-results');
    body.classList.add('screen-' + name);
  }

  // -------------------------------------------------------------------------
  // Socket setup
  // -------------------------------------------------------------------------
  if (typeof io !== 'function') {
    joinStatus.textContent = 'Socket.io client did not load.';
    return;
  }

  var socket = io(location.protocol + '//' + location.hostname + ':3001', {
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', function () {
    joinStatus.textContent = 'Connected. Enter a name to join the lobby.';
    socket.emit('rejoin', { playerId: playerId });
  });

  socket.on('connect_error', function (err) {
    joinStatus.textContent = 'Cannot reach the WordFuse server on port 3001.';
    console.warn('socket connect_error:', err && err.message ? err.message : err);
  });

  socket.on('disconnect', function () {
    joinStatus.textContent = 'Disconnected. Trying to reconnect...';
  });

  socket.on('error', function (payload) {
    var msg = payload && payload.message ? payload.message : 'Server error.';
    if (body.classList.contains('screen-join')) {
      joinStatus.textContent = msg;
    } else {
      gameStatus.textContent = msg;
    }
  });

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------
  joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = (nameInput.value || '').trim();
    if (!name) {
      joinStatus.textContent = 'Please enter a name.';
      return;
    }
    socket.emit('join_lobby', { name: name, playerId: playerId });
  });

  startBtn.addEventListener('click', function () {
    socket.emit('start_game');
  });

  socket.on('lobby_update', function (payload) {
    rosterByLobby = (payload && payload.players) || [];
    renderLobby(rosterByLobby);
    setScreen('join');
  });

  function renderLobby(players) {
    lobbyList.innerHTML = '';
    var meIsHost = false;
    players.forEach(function (p) {
      var li = document.createElement('li');
      if (p.isHost) li.classList.add('is-host');
      if (!p.connected) li.classList.add('is-disconnected');
      li.textContent = p.name + (p.isHost ? '  (host)' : '') + (!p.connected ? '  (offline)' : '');
      lobbyList.appendChild(li);
      if (p.id === playerId && p.isHost) meIsHost = true;
    });
    startBtn.hidden = !meIsHost;
  }

  // -------------------------------------------------------------------------
  // Game start / turn
  // -------------------------------------------------------------------------
  socket.on('game_started', function (payload) {
    activePlayerId = payload.firstPlayer;
    currentSyllable = payload.syllable;
    currentInitialMs = payload.timerMs || 10000;
    // Initialize lives = 3 for everyone in the lobby roster.
    lives = {};
    rosterByLobby.forEach(function (p) { lives[p.id] = 3; });
    syllableEl.textContent = currentSyllable;
    setScreen('game');
    updateActiveUi();
    updateBomb(currentInitialMs);
    renderPlayers();
    lastWordEl.textContent = '';
    gameStatus.textContent = '';
  });

  socket.on('word_accepted', function (payload) {
    var prevActive = activePlayerId;
    activePlayerId = payload.nextPlayer;
    currentSyllable = payload.nextSyllable;
    currentInitialMs = payload.timerMs || currentInitialMs;
    var oldSyllable = syllableEl.textContent;
    syllableEl.textContent = currentSyllable;
    triggerSyllablePop();
    var who = nameOf(payload.player) || 'Player';
    lastWordEl.textContent = '✓ ' + who + ' played "' + payload.word + '"';
    // Toast: green, accepted with the matched syllable underlined.
    showAcceptToast(who, payload.word, oldSyllable);
    // Brief flash on the local input if the local player was the submitter.
    if (payload.player === playerId) {
      flashWordInputAccepted();
    }
    wordInput.value = '';
    updateActiveUi();
    updateBomb(currentInitialMs);
    renderPlayers();
    flyBomb(prevActive, payload.nextPlayer);
  });

  socket.on('word_rejected', function (payload) {
    var reason = payload && payload.reason ? payload.reason : 'INVALID';
    var msgId = ({
      EMPTY: 'Empty submission.',
      NOT_IN_DICTIONARY: 'Kata tidak ditemukan dalam kamus',
      MISSING_SYLLABLE: 'Kata tidak mengandung suku kata yang diminta',
    })[reason] || 'Rejected.';
    gameStatus.textContent = msgId;
    wordInput.classList.remove('shake');
    // Force reflow so the animation can replay if it was already applied.
    void wordInput.offsetWidth;
    wordInput.classList.add('shake');
    setTimeout(function () {
      wordInput.classList.remove('shake');
    }, 450);
    showRejectToast(payload.word || '', msgId);
  });

  socket.on('turn_start', function (payload) {
    var prevActive = activePlayerId;
    activePlayerId = payload.activePlayer;
    currentSyllable = payload.syllable;
    currentInitialMs = payload.timerMs || currentInitialMs;
    if (payload.lives && typeof payload.lives === 'object') {
      lives = payload.lives;
    }
    syllableEl.textContent = currentSyllable;
    triggerSyllablePop();
    setScreen('game');
    updateActiveUi();
    updateBomb(currentInitialMs);
    renderPlayers();
    // Bomb flyer animation only when this is a real pass (prev != next).
    if (prevActive && prevActive !== payload.activePlayer) {
      flyBomb(prevActive, payload.activePlayer);
    }
  });

  socket.on('life_lost', function (payload) {
    if (payload && payload.player) {
      lives[payload.player] = payload.livesRemaining;
    }
    var nm = nameOf(payload && payload.player) || 'Player';
    var rem = (payload && typeof payload.livesRemaining === 'number') ? payload.livesRemaining : 0;
    showLifeLostToast(nm, rem);
    flashBombRed();
    renderPlayers();
  });

  socket.on('player_eliminated', function (payload) {
    if (payload && payload.player) {
      lives[payload.player] = 0;
    }
    var nm = nameOf(payload && payload.player) || 'Player';
    showEliminatedBanner(nm);
    renderPlayers();
  });

  socket.on('timer_tick', function (payload) {
    var ms = (payload && typeof payload.remainingMs === 'number') ? payload.remainingMs : 0;
    updateBomb(ms);
  });

  // -------------------------------------------------------------------------
  // Word submission
  // -------------------------------------------------------------------------
  wordForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var w = (wordInput.value || '').trim().toUpperCase();
    if (!w) return;
    socket.emit('submit_word', { word: w });
  });

  // Force-uppercase the visible input as the player types, regardless of
  // caps-lock state. The validator is already case-insensitive, but this
  // removes any ambiguity about whether case matters.
  wordInput.addEventListener('input', function () {
    var caretEnd = wordInput.selectionEnd;
    var prevLen = wordInput.value.length;
    wordInput.value = wordInput.value.toUpperCase();
    // Preserve caret position roughly (length is unchanged by toUpperCase
    // for ASCII letters, so this is safe).
    if (typeof caretEnd === 'number' && wordInput.value.length === prevLen) {
      try { wordInput.setSelectionRange(caretEnd, caretEnd); } catch (e) { /* ignore */ }
    }
  });

  // -------------------------------------------------------------------------
  // Game over
  // -------------------------------------------------------------------------
  socket.on('game_over', function (payload) {
    var winnerId = payload && payload.winner;
    var scores = (payload && payload.scores) || [];
    if (winnerId) {
      var w = scores.find(function (s) { return s.id === winnerId; });
      var winnerName = (w && w.name) || nameOf(winnerId) || 'Winner';
      winnerBanner.textContent = '🏆 ' + winnerName + ' wins!';
    } else {
      winnerBanner.textContent = 'No winner.';
    }
    scoreboardEl.innerHTML = '';
    scores.sort(function (a, b) { return a.finalRank - b.finalRank; });
    scores.forEach(function (s) {
      var li = document.createElement('li');
      var rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = '#' + s.finalRank;
      var nm = document.createElement('span'); nm.textContent = s.name || s.id.slice(0, 6);
      var w = document.createElement('span'); w.className = 'stat'; w.textContent = (s.wordsAccepted | 0) + ' words';
      var l = document.createElement('span'); l.className = 'stat'; l.textContent = (s.livesLost | 0) + ' lives lost';
      li.appendChild(rank); li.appendChild(nm); li.appendChild(w); li.appendChild(l);
      scoreboardEl.appendChild(li);
    });
    setScreen('results');
    // Celebration: pulsing winner banner + confetti.
    winnerBanner.classList.remove('is-celebrating');
    void winnerBanner.offsetWidth;
    winnerBanner.classList.add('is-celebrating');
    if (winnerId) launchConfetti();
  });

  playAgainBtn.addEventListener('click', function () {
    setScreen('join');
    // The server will broadcast `lobby_update` whenever someone connects/joins.
  });

  // -------------------------------------------------------------------------
  // Rendering helpers
  // -------------------------------------------------------------------------
  function nameOf(id) {
    var p = rosterByLobby.find(function (x) { return x.id === id; });
    return p ? p.name : null;
  }

  function renderPlayers() {
    playerListEl.innerHTML = '';
    rosterByLobby.forEach(function (p) {
      var li = document.createElement('li');
      li.setAttribute('data-pid', p.id);
      var lifeCount = (lives[p.id] !== undefined) ? lives[p.id] : 3;
      if (p.id === activePlayerId) li.classList.add('is-active');
      if (lifeCount <= 0) li.classList.add('is-eliminated');
      var label = document.createElement('span');
      label.textContent = p.name + (p.id === playerId ? '  (you)' : '');
      var hearts = document.createElement('span');
      hearts.className = 'lives';
      for (var i = 0; i < 3; i += 1) {
        var h = document.createElement('span');
        h.className = 'heart' + (i >= lifeCount ? ' is-lost' : '');
        hearts.appendChild(h);
      }
      li.appendChild(label);
      li.appendChild(hearts);
      playerListEl.appendChild(li);
    });
  }

  function updateActiveUi() {
    var myTurn = (activePlayerId === playerId);
    wordInput.disabled = !myTurn;
    wordSubmit.disabled = !myTurn;
    if (myTurn) {
      gameStatus.textContent = 'Your turn — type a word containing "' + currentSyllable + '".';
      try { wordInput.focus(); } catch (e) {}
    } else {
      var who = nameOf(activePlayerId) || 'opponent';
      gameStatus.textContent = 'Waiting for ' + who + '...';
    }
  }

  function updateBomb(remainingMs) {
    var ratio = currentInitialMs > 0 ? Math.max(0, Math.min(1, remainingMs / currentInitialMs)) : 0;
    document.documentElement.style.setProperty('--remaining-ratio', String(ratio));
    // Pulse rate: 1000ms when full, down to ~150ms when almost out.
    var pulse = Math.max(150, Math.round(remainingMs / 8));
    document.documentElement.style.setProperty('--pulse-ms', pulse + 'ms');
    timerText.textContent = (remainingMs / 1000).toFixed(1) + 's';
  }

  // -------------------------------------------------------------------------
  // Chat — uses the same Socket.io connection
  // -------------------------------------------------------------------------
  var chatColors = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
  function colorVarFor(pid) {
    if (pid === 'system') return 'var(--chat-system)';
    var idx = rosterByLobby.findIndex(function (p) { return p.id === pid; });
    if (idx < 0) idx = 0;
    var slot = chatColors[idx % chatColors.length];
    return 'var(--chat-' + slot + ')';
  }

  function appendChatMessage(payload) {
    if (!payload || typeof payload.message !== 'string') return;
    var li = document.createElement('li');
    var isSystem = payload.playerId === 'system';
    if (isSystem) {
      li.className = 'is-system';
      li.textContent = payload.message;
      chatLog.appendChild(li);
    } else {
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = payload.name || 'Player';
      who.style.color = colorVarFor(payload.playerId);
      // Eliminated badge if this player has 0 lives.
      if (lives && lives[payload.playerId] === 0) {
        var badge = document.createElement('span');
        badge.className = 'out-badge';
        badge.textContent = '(out)';
        who.appendChild(badge);
      }
      var ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = formatTs(payload.timestamp);
      var msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = payload.message;
      li.appendChild(who);
      li.appendChild(ts);
      li.appendChild(msg);
      chatLog.appendChild(li);
    }
    // Trim to last 200 messages to bound DOM size.
    while (chatLog.children.length > 200) chatLog.removeChild(chatLog.firstChild);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function formatTs(ms) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  socket.on('chat_message', function (payload) {
    appendChatMessage(payload);
  });

  if (chatForm) {
    chatForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = (chatInput.value || '').trim();
      if (!text) return;
      socket.emit('send_chat', { message: text });
      chatInput.value = '';
    });
  }
  if (chatToggle) {
    chatToggle.addEventListener('click', function () {
      body.classList.toggle('chat-open');
    });
  }
  if (chatClose) {
    chatClose.addEventListener('click', function () {
      body.classList.remove('chat-open');
    });
  }

  // -------------------------------------------------------------------------
  // Toast stack
  // -------------------------------------------------------------------------
  var TOAST_MAX = 3;

  function pushToast(node, lifeMs) {
    if (!toastStack) return;
    node.style.setProperty('--toast-life', (lifeMs || 1500) + 'ms');
    toastStack.appendChild(node);
    while (toastStack.children.length > TOAST_MAX) toastStack.removeChild(toastStack.firstChild);
    var total = (lifeMs || 1500) + 320; // matches toastOut duration
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, total);
  }

  function showAcceptToast(name, word, syllable) {
    var t = document.createElement('div');
    t.className = 'toast t-accept';
    var ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = '✅';
    var body = document.createElement('span');
    var who = document.createElement('strong'); who.textContent = name + ' — ';
    var w = document.createElement('span'); w.className = 'word';
    // Underline the matched syllable inside the word (case-insensitive).
    appendWordWithSyllable(w, word, syllable);
    body.appendChild(who); body.appendChild(w);
    t.appendChild(ic); t.appendChild(body);
    pushToast(t, 1500);
  }

  function appendWordWithSyllable(container, word, syllable) {
    var W = String(word || '').toUpperCase();
    var S = String(syllable || '').toUpperCase();
    if (!S || W.indexOf(S) < 0) {
      container.textContent = W;
      return;
    }
    var idx = W.indexOf(S);
    if (idx > 0) container.appendChild(document.createTextNode(W.slice(0, idx)));
    var hit = document.createElement('span');
    hit.className = 'syl-hit';
    hit.textContent = W.slice(idx, idx + S.length);
    container.appendChild(hit);
    if (idx + S.length < W.length) container.appendChild(document.createTextNode(W.slice(idx + S.length)));
  }

  function showRejectToast(word, reason) {
    var t = document.createElement('div');
    t.className = 'toast t-reject';
    var ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = '❌';
    var body = document.createElement('span');
    var w = document.createElement('span'); w.className = 'word';
    w.textContent = '"' + (word || '') + '"';
    var sep = document.createElement('span'); sep.textContent = ' — ' + reason;
    body.appendChild(w); body.appendChild(sep);
    t.appendChild(ic); t.appendChild(body);
    pushToast(t, 1200);
  }

  function showLifeLostToast(name, livesRemaining) {
    var t = document.createElement('div');
    t.className = 'toast t-life';
    var ic = document.createElement('span'); ic.className = 'icon'; ic.textContent = '💔';
    var body = document.createElement('span');
    body.textContent = name + ' kehilangan 1 nyawa! (sisa: ' + (livesRemaining | 0) + ')';
    t.appendChild(ic); t.appendChild(body);
    pushToast(t, 1500);
  }

  function showEliminatedBanner(name) {
    if (!eventBanner) return;
    eventBanner.textContent = '💀 ' + name + ' telah gugur!';
    eventBanner.classList.add('is-visible');
    setTimeout(function () {
      eventBanner.classList.remove('is-visible');
    }, 2500);
  }

  // -------------------------------------------------------------------------
  // Visual flourishes: input flash, syllable pop, bomb flyer & flash, confetti
  // -------------------------------------------------------------------------
  function flashWordInputAccepted() {
    if (!wordInput) return;
    wordInput.classList.remove('flash-accept');
    void wordInput.offsetWidth;
    wordInput.classList.add('flash-accept');
    setTimeout(function () { wordInput.classList.remove('flash-accept'); }, 420);
  }

  function triggerSyllablePop() {
    if (!syllableEl) return;
    syllableEl.classList.remove('pop');
    void syllableEl.offsetWidth;
    syllableEl.classList.add('pop');
  }

  function flashBombRed() {
    if (!bomb) return;
    bomb.classList.remove('flash-red');
    void bomb.offsetWidth;
    bomb.classList.add('flash-red');
    setTimeout(function () { bomb.classList.remove('flash-red'); }, 540);
  }

  function flyBomb(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    if (!playerListEl) return;
    var fromLi = playerListEl.querySelector('li[data-pid="' + cssEscape(fromId) + '"]');
    var toLi = playerListEl.querySelector('li[data-pid="' + cssEscape(toId) + '"]');
    if (!fromLi || !toLi) return;
    var fromRect = fromLi.getBoundingClientRect();
    var toRect = toLi.getBoundingClientRect();
    var flyer = document.createElement('div');
    flyer.className = 'bomb-flyer';
    flyer.textContent = '💣';
    flyer.style.left = (fromRect.left + fromRect.width / 2 - 12) + 'px';
    flyer.style.top = (fromRect.top + fromRect.height / 2 - 14) + 'px';
    document.body.appendChild(flyer);
    var dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    var dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    requestAnimationFrame(function () {
      flyer.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.2)';
      flyer.style.opacity = '0.0';
    });
    setTimeout(function () {
      if (flyer.parentNode) flyer.parentNode.removeChild(flyer);
      toLi.classList.remove('bomb-incoming');
      void toLi.offsetWidth;
      toLi.classList.add('bomb-incoming');
    }, 520);
  }

  // Minimal CSS.escape polyfill for older browsers.
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function launchConfetti() {
    if (!confettiStage) return;
    confettiStage.innerHTML = '';
    var colors = ['#00e0c6', '#ffd84d', '#ff7eb6', '#6cb4ff', '#b6ff7e', '#ffa84d'];
    var count = 80;
    for (var i = 0; i < count; i += 1) {
      var piece = document.createElement('span');
      piece.className = 'confetti-piece';
      var color = colors[i % colors.length];
      piece.style.background = color;
      piece.style.left = (Math.random() * 100) + '%';
      piece.style.setProperty('--fall-dur', (2.4 + Math.random() * 2.0) + 's');
      piece.style.animationDelay = (Math.random() * 0.6) + 's';
      confettiStage.appendChild(piece);
    }
    setTimeout(function () { if (confettiStage) confettiStage.innerHTML = ''; }, 5500);
  }

  // Initial screen
  setScreen('join');
})();
