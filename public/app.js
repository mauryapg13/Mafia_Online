/* ═══════════════════════════════════════════════════════════════════════
   Mafia Game — Client
   Socket.io-powered client controller for all game screens.
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const socket = io();

  // ─── State ─────────────────────────────────────────────────────────
  let state = {
    isHost: false,
    roomCode: null,
    playerId: null,
    role: null,
    mafiaMembers: [],
    phase: 'welcome',
    settings: {},
    players: [],
    discussionTimer: null,
    hasVoted: false,
    hasActed: false,
  };

  // ─── DOM Helpers ───────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function showScreen(screenId) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const screen = $(`#screen-${screenId}`);
    if (screen) screen.classList.add('active');
  }

  function setNightMode(on) {
    document.body.classList.toggle('night', on);
  }

  // ─── Role Info ─────────────────────────────────────────────────────

  const ROLE_INFO = {
    mafia: {
      name: 'Mafia',
      team: 'Mafia',
      description: 'Each night, you and your allies secretly choose someone to eliminate. During the day, blend in and deflect suspicion.',
      iconClass: 'role-mafia',
      iconSvg: '<svg viewBox="0 0 32 32" fill="none"><path d="M16 4L8 14L4 28H28L24 14L16 4Z" stroke="#F5F0E8" stroke-width="2" fill="none"/><circle cx="12" cy="18" r="2" fill="#F5F0E8"/><circle cx="20" cy="18" r="2" fill="#F5F0E8"/></svg>',
    },
    healer: {
      name: 'Healer',
      team: 'Village',
      description: 'Each night, choose one player to protect from the Mafia. You cannot protect the same person two nights in a row.',
      iconClass: 'role-healer',
      iconSvg: '<svg viewBox="0 0 32 32" fill="none"><path d="M16 6V26M6 16H26" stroke="#F5F0E8" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="16" r="12" stroke="#F5F0E8" stroke-width="2" fill="none"/></svg>',
    },
    villager: {
      name: 'Villager',
      team: 'Village',
      description: 'You have no special power at night. Use the day to discuss, observe, and vote wisely. Your judgment is your weapon.',
      iconClass: 'role-villager',
      iconSvg: '<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="12" r="6" stroke="#2D2438" stroke-width="2" fill="none"/><path d="M6 28C6 22 10 18 16 18C22 18 26 22 26 28" stroke="#2D2438" stroke-width="2" fill="none"/></svg>',
    },
  };

  // ─── Welcome Screen ───────────────────────────────────────────────

  $('#btn-create-room').addEventListener('click', () => {
    const name = $('#input-player-name').value.trim();
    if (!name) {
      $('#welcome-error').textContent = 'Please enter your name first.';
      return;
    }

    socket.emit('createRoom', { playerName: name }, (res) => {
      if (res.success) {
        state.isHost = true;
        state.playerId = res.playerId;
        state.roomCode = res.roomCode;
        enterLobby();
      } else {
        $('#welcome-error').textContent = res.error;
      }
    });
  });

  $('#btn-join-room').addEventListener('click', () => {
    const code = $('#input-room-code').value.trim();
    const name = $('#input-player-name').value.trim();

    if (!code || !name) {
      $('#welcome-error').textContent = 'Please enter both a room code and your name.';
      return;
    }

    socket.emit('joinRoom', { roomCode: code, playerName: name }, (res) => {
      if (res.success) {
        state.isHost = false;
        state.playerId = res.playerId;
        state.roomCode = res.roomCode;
        enterLobby();
      } else {
        $('#welcome-error').textContent = res.error;
      }
    });
  });

  // Allow enter key on inputs
  $('#input-player-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join-room').click();
  });
  $('#input-room-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#input-player-name').focus();
  });

  // ─── Lobby ─────────────────────────────────────────────────────────

  function enterLobby() {
    showScreen('lobby');
    $('#lobby-room-code').textContent = state.roomCode;

    if (state.isHost) {
      $('#lobby-host-actions').style.display = 'block';
      $('#lobby-player-wait').style.display = 'none';
      $('#settings-panel').classList.remove('settings-readonly');
    } else {
      $('#lobby-host-actions').style.display = 'none';
      $('#lobby-player-wait').style.display = 'block';
      $('#settings-panel').classList.add('settings-readonly');
    }
  }

  // Settings step buttons
  document.querySelectorAll('.btn-step').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.isHost) return;
      const setting = btn.dataset.setting;
      const dir = parseInt(btn.dataset.dir, 10);
      const current = state.settings[setting] || 0;
      const newVal = current + dir;
      socket.emit('updateSettings', { [setting]: newVal });
    });
  });

  // Settings toggle buttons
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.isHost) return;
      const setting = btn.dataset.setting;
      const current = state.settings[setting];
      socket.emit('updateSettings', { [setting]: !current });
    });
  });

  // Start game
  $('#btn-start-game').addEventListener('click', () => {
    socket.emit('startGame', (res) => {
      if (!res.success) {
        $('#lobby-error').textContent = res.error;
      } else {
        $('#lobby-error').textContent = '';
      }
    });
  });

  // Lobby update handler
  socket.on('lobbyUpdate', (data) => {
    state.players = data.players;
    state.settings = data.settings;
    renderPlayerList();
    renderSettings();
  });

  function renderPlayerList() {
    const list = $('#player-list');
    list.innerHTML = '';

    state.players.forEach((p, i) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'player-name';
      nameSpan.textContent = p.name;
      li.appendChild(nameSpan);

      if (i === 0 && state.isHost) {
        // First player could be indicated, but host is separate
      }

      if (state.isHost) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn-kick';
        kickBtn.textContent = 'Remove';
        kickBtn.addEventListener('click', () => {
          socket.emit('kickPlayer', { playerId: p.id });
        });
        li.appendChild(kickBtn);
      }

      list.appendChild(li);
    });

    const count = state.players.length;
    $('#player-count').textContent = `${count} player${count !== 1 ? 's' : ''} in the room`;
  }

  function renderSettings() {
    const s = state.settings;
    $('#setting-mafia-count').textContent = s.mafiaCount;
    $('#setting-healer-count').textContent = s.healerCount;
    $('#setting-discussion-time').textContent = s.discussionTime + 's';

    const fnk = $('#setting-first-night-kill');
    fnk.classList.toggle('active', s.firstNightKill);
    fnk.textContent = s.firstNightKill ? 'Yes' : 'No';

    const rr = $('#setting-reveal-role');
    rr.classList.toggle('active', s.revealRoleOnDeath);
    rr.textContent = s.revealRoleOnDeath ? 'Yes' : 'No';

    const sh = $('#setting-self-heal');
    sh.classList.toggle('active', s.allowHealerSelfHeal);
    sh.textContent = s.allowHealerSelfHeal ? 'Yes' : 'No';
  }

  // ─── Role Reveal ──────────────────────────────────────────────────

  socket.on('roleAssigned', (data) => {
    state.playerId = state.playerId || data.playerId;
    state.role = data.role;
    state.mafiaMembers = data.mafiaMembers || [];
  });

  socket.on('phaseChange', (data) => {
    state.phase = data.phase;

    switch (data.phase) {
      case 'roleReveal':
        state.players = data.players;
        showRoleReveal();
        break;
      case 'night':
        state.players = data.players;
        state.hasActed = false;
        setNightMode(true);
        showScreen('night');
        $('#night-round').textContent = `Round ${data.round}`;
        break;
      case 'day':
        setNightMode(false);
        state.players = data.players;
        state.hasVoted = false;
        showDayScreen(data);
        break;
      case 'vote':
        state.players = data.players;
        state.hasVoted = false;
        showVoteScreen();
        break;
      case 'gameOver':
        setNightMode(false);
        showGameOver(data);
        break;
      case 'lobby':
        setNightMode(false);
        state.role = null;
        state.hasVoted = false;
        state.hasActed = false;
        enterLobby();
        break;
    }
  });

  function showRoleReveal() {
    showScreen('role');
    setNightMode(false);

    const card = $('#role-card');
    card.classList.remove('flipped');
    $('#btn-role-ack').style.display = 'none';
    $('#role-waiting').style.display = 'none';

    const info = ROLE_INFO[state.role];
    if (!info) return;

    const icon = $('#role-icon');
    icon.className = 'role-icon ' + info.iconClass;
    icon.innerHTML = info.iconSvg;

    $('#role-name').textContent = info.name;
    $('#role-name').className = 'role-name ' + state.role;
    $('#role-team').textContent = 'Team ' + info.team;
    $('#role-description').textContent = info.description;

    if (state.role === 'mafia' && state.mafiaMembers.length > 0) {
      const names = state.mafiaMembers.map(m => m.name).join(', ');
      $('#role-mafia-allies').textContent = 'Your allies: ' + names;
      $('#role-mafia-allies').style.display = 'block';
    } else {
      $('#role-mafia-allies').style.display = 'none';
    }

    // Tap to flip
    card.addEventListener('click', function flipHandler() {
      card.classList.add('flipped');
      card.removeEventListener('click', flipHandler);
      setTimeout(() => {
        $('#btn-role-ack').style.display = 'inline-flex';
      }, 800);
    });
  }

  $('#btn-role-ack').addEventListener('click', () => {
    socket.emit('roleAcknowledged');
    $('#btn-role-ack').style.display = 'none';
    $('#role-waiting').style.display = 'block';
  });

  // ─── Night ─────────────────────────────────────────────────────────

  socket.on('nightPrompt', (data) => {
    showScreen('night');
    setNightMode(true);
    $('#night-round').textContent = `Round ${data.round}`;

    // Hide all sub-areas
    $('#night-sleep').style.display = 'none';
    $('#night-choose').style.display = 'none';
    $('#night-skip').style.display = 'none';
    $('#night-chosen').style.display = 'none';

    if (data.role === 'villager') {
      $('#night-sleep').style.display = 'block';
      $('#night-title').textContent = 'Night falls';
      return;
    }

    if (data.skipNight) {
      $('#night-skip').style.display = 'block';
      $('#night-title').textContent = 'First night';
      // Auto-signal that mafia skipped
      if (data.role === 'mafia') {
        socket.emit('nightAction', { targetId: null });
      }
      return;
    }

    $('#night-choose').style.display = 'block';

    if (data.role === 'mafia') {
      $('#night-title').textContent = 'The Mafia awakens';
      $('#night-prompt').textContent = 'Choose your target.';
    } else if (data.role === 'healer') {
      $('#night-title').textContent = 'The Healer awakens';
      $('#night-prompt').textContent = 'Choose someone to protect tonight.';
    }

    renderNightTargets(data.targets);
  });

  function renderNightTargets(targets) {
    const grid = $('#night-targets');
    grid.innerHTML = '';

    targets.forEach(t => {
      const card = document.createElement('div');
      card.className = 'target-card';
      card.textContent = t.name;
      card.dataset.id = t.id;

      card.addEventListener('click', () => {
        if (state.hasActed) return;
        state.hasActed = true;

        // Highlight selection
        grid.querySelectorAll('.target-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        socket.emit('nightAction', { targetId: t.id });
        $('#night-chosen').textContent = 'Your choice has been made. Waiting for others...';
        $('#night-chosen').style.display = 'block';

        // Disable further clicks
        grid.querySelectorAll('.target-card').forEach(c => {
          if (!c.classList.contains('selected')) c.classList.add('disabled');
        });
      });

      grid.appendChild(card);
    });
  }

  // Mafia sees other mafia selections in real time
  socket.on('mafiaSelection', (data) => {
    // Could highlight the target card — for now just visual feedback
    const grid = $('#night-targets');
    const cards = grid.querySelectorAll('.target-card');
    cards.forEach(c => {
      if (c.dataset.id === data.targetId) {
        c.classList.add('selected');
      }
    });
  });

  // ─── Day ───────────────────────────────────────────────────────────

  function showDayScreen(data) {
    showScreen('day');
    $('#day-round').textContent = `Round ${data.round}`;

    // Build result text
    const nr = data.nightResult;
    const resultEl = $('#day-result-text');

    if (nr.firstNightSkipped) {
      resultEl.innerHTML = 'The first night passed peacefully. No one was harmed.';
    } else if (nr.saved) {
      resultEl.innerHTML = 'The Healer was vigilant last night. <span class="saved-text">Someone was saved</span> from the Mafia\'s attempt.';
    } else if (nr.eliminated) {
      let roleText = '';
      if (nr.eliminated.role) {
        roleText = ` They were a <span class="role-tag tag-${nr.eliminated.role}">${capitalize(nr.eliminated.role)}</span>.`;
      }
      resultEl.innerHTML = `<span class="victim-name">${escapeHtml(nr.eliminated.name)}</span> did not survive the night.${roleText}`;
    } else {
      resultEl.innerHTML = 'The night passed without incident.';
    }

    // Discussion timer
    startDiscussionTimer(data.discussionTime);
  }

  let timerInterval = null;

  function startDiscussionTimer(seconds) {
    if (timerInterval) clearInterval(timerInterval);

    const circumference = 2 * Math.PI * 54; // r=54
    const progress = $('#timer-progress');
    const timerText = $('#timer-text');

    let remaining = seconds;
    progress.style.strokeDasharray = circumference;
    progress.style.strokeDashoffset = 0;
    progress.classList.remove('warning');
    timerText.classList.remove('warning');

    function updateTimer() {
      const fraction = remaining / seconds;
      progress.style.strokeDashoffset = circumference * (1 - fraction);
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      timerText.textContent = `${min}:${sec.toString().padStart(2, '0')}`;

      if (remaining <= 15) {
        progress.classList.add('warning');
        timerText.classList.add('warning');
      }

      if (remaining <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        // Auto-proceed to vote
        socket.emit('startVote');
      }

      remaining--;
    }

    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  }

  $('#btn-start-vote').addEventListener('click', () => {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    socket.emit('startVote');
  });

  // ─── Vote ──────────────────────────────────────────────────────────

  function showVoteScreen() {
    showScreen('vote');
    $('#vote-chosen').style.display = 'none';
    $('#vote-progress-text').textContent = '';

    const grid = $('#vote-targets');
    grid.innerHTML = '';

    const alivePlayers = state.players.filter(p => p.alive && p.id !== state.playerId);

    alivePlayers.forEach(p => {
      const card = document.createElement('div');
      card.className = 'target-card';
      card.textContent = p.name;
      card.dataset.id = p.id;

      card.addEventListener('click', () => {
        if (state.hasVoted) return;
        state.hasVoted = true;

        grid.querySelectorAll('.target-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');

        socket.emit('castVote', { targetId: p.id });
        $('#vote-chosen').textContent = 'Vote cast. Waiting for others...';
        $('#vote-chosen').style.display = 'block';
        $('#btn-skip-vote').style.display = 'none';

        grid.querySelectorAll('.target-card').forEach(c => {
          if (!c.classList.contains('selected')) c.classList.add('disabled');
        });
      });

      grid.appendChild(card);
    });

    // Check if this player is already dead
    const me = state.players.find(p => p.id === state.playerId);
    if (me && !me.alive) {
      grid.innerHTML = '';
      $('#btn-skip-vote').style.display = 'none';
      $('#vote-chosen').textContent = 'You are no longer among the living. Watching the vote...';
      $('#vote-chosen').style.display = 'block';
    }
  }

  $('#btn-skip-vote').addEventListener('click', () => {
    if (state.hasVoted) return;
    state.hasVoted = true;
    socket.emit('castVote', { targetId: 'skip' });
    $('#vote-chosen').textContent = 'You chose to skip. Waiting for others...';
    $('#vote-chosen').style.display = 'block';
    $('#btn-skip-vote').style.display = 'none';
    $('#vote-targets').querySelectorAll('.target-card').forEach(c => c.classList.add('disabled'));
  });

  socket.on('voteProgress', (data) => {
    $('#vote-progress-text').textContent = `${data.voteCount} of ${data.totalVoters} votes cast`;
  });

  // ─── Vote Result ───────────────────────────────────────────────────

  socket.on('voteResult', (data) => {
    showScreen('vote-result');

    const resultText = $('#vote-result-text');
    if (data.eliminated) {
      let roleText = '';
      if (data.eliminated.role) {
        roleText = ` They were a <span class="role-tag tag-${data.eliminated.role}">${capitalize(data.eliminated.role)}</span>.`;
      }
      resultText.innerHTML = `<span class="victim-name">${escapeHtml(data.eliminated.name)}</span> has been eliminated by the village.${roleText}`;
    } else if (data.tie) {
      resultText.innerHTML = 'The vote was tied. No one is eliminated.';
    } else {
      resultText.innerHTML = 'The village could not reach a decision. No one is eliminated.';
    }

    // Render tally
    const tallyContainer = $('#vote-tally');
    tallyContainer.innerHTML = '';

    if (data.tally && Object.keys(data.tally).length > 0) {
      const sorted = Object.entries(data.tally).sort((a, b) => b[1] - a[1]);
      sorted.forEach(([targetId, count]) => {
        const player = state.players.find(p => p.id === targetId);
        if (!player) return;
        const row = document.createElement('div');
        row.className = 'vote-tally-row';
        if (data.eliminated && data.eliminated.id === targetId) {
          row.classList.add('eliminated');
        }
        row.innerHTML = `<span class="tally-name">${escapeHtml(player.name)}</span><span class="tally-count">${count} vote${count !== 1 ? 's' : ''}</span>`;
        tallyContainer.appendChild(row);
      });
    }

    // Host can proceed
    if (state.isHost) {
      $('#btn-proceed-night').style.display = 'inline-flex';
      $('#vote-result-wait').style.display = 'none';
    } else {
      $('#btn-proceed-night').style.display = 'none';
      $('#vote-result-wait').style.display = 'block';
    }
  });

  $('#btn-proceed-night').addEventListener('click', () => {
    socket.emit('proceedToNight');
  });

  // ─── Game Over ─────────────────────────────────────────────────────

  function showGameOver(data) {
    showScreen('gameover');

    const title = $('#gameover-title');
    const subtitle = $('#gameover-subtitle');

    if (data.winner === 'village') {
      title.textContent = 'The Village Prevails';
      title.className = 'gameover-title village-wins';
      subtitle.textContent = 'The Mafia has been rooted out. Peace returns to the village.';
    } else {
      title.textContent = 'The Mafia Wins';
      title.className = 'gameover-title mafia-wins';
      subtitle.textContent = 'The village has fallen under the shadow of the Mafia.';
    }

    // Roles table
    const tbody = $('#gameover-table').querySelector('tbody');
    tbody.innerHTML = '';

    data.players.forEach(p => {
      const tr = document.createElement('tr');
      const roleCls = `tag-${p.role}`;
      tr.innerHTML = `
        <td>${escapeHtml(p.name)}</td>
        <td><span class="role-tag ${roleCls}">${capitalize(p.role)}</span></td>
        <td class="${p.alive ? 'fate-alive' : 'fate-eliminated'}">${p.alive ? 'Survived' : 'Eliminated'}</td>
      `;
      tbody.appendChild(tr);
    });

    if (state.isHost) {
      $('#btn-play-again').style.display = 'inline-flex';
      $('#gameover-wait').style.display = 'none';
    } else {
      $('#btn-play-again').style.display = 'none';
      $('#gameover-wait').style.display = 'block';
    }
  }

  $('#btn-play-again').addEventListener('click', () => {
    socket.emit('playAgain');
  });

  // ─── Disconnect Handling ───────────────────────────────────────────

  socket.on('playerDisconnected', (data) => {
    // Could show a toast — for now just update the player list
    const player = state.players.find(p => p.id === data.playerId);
    if (player) player.connected = false;
    renderPlayerList();
  });

  socket.on('kicked', () => {
    state = {
      isHost: false, roomCode: null, playerId: null, role: null,
      mafiaMembers: [], phase: 'welcome', settings: {},
      players: [], discussionTimer: null, hasVoted: false, hasActed: false,
    };
    setNightMode(false);
    showScreen('welcome');
    $('#welcome-error').textContent = 'You were removed from the room.';
  });

  // ─── Utility ───────────────────────────────────────────────────────

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

})();
