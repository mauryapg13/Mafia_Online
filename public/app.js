const socket = io();

// ── Application State ──
const state = {
  playerId: null,
  playerName: '',
  roomCode: null,
  isHost: false,
  role: null,
  mafiaMembers: [],
  players: [],
  phase: 'welcome',
  round: 1,
  godMode: false,
  selectedTargetId: null,
  votedTargetId: null,
  voteCounts: {},
  voteChips: {},        // targetId -> [voterName, ...]
  pendingDayPhase: false,
  lastProtectedName: null
};

// ── Helper Utilities ──
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showScreen(screenId) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  const screen = $(`#screen-${screenId}`);
  if (screen) screen.classList.add('active');

  state.phase = screenId;
  updateThemeForPhase(screenId);
  updateVillageGridVisibility(screenId);
}

function updateThemeForPhase(phase) {
  if (phase === 'night') {
    document.body.classList.add('night');
    document.body.classList.remove('day');
  } else if (phase === 'day' || phase === 'vote' || phase === 'voteResult') {
    document.body.classList.add('day');
    document.body.classList.remove('night');
  } else {
    document.body.classList.remove('night');
    document.body.classList.remove('day');
  }
}

function updateVillageGridVisibility(phase) {
  const container = $('#village-grid-container');
  if (!container) return;

  const activeGridPhases = ['night', 'day', 'vote', 'voteResult'];
  if (activeGridPhases.includes(phase)) {
    container.style.display = 'block';
    renderVillageGrid();
  } else {
    container.style.display = 'none';
  }
}

// ── Socket State Connection ──
socket.on('connect', () => {
  state.playerId = socket.id;
  console.log('[Client] Connected:', socket.id);
});

socket.on('roomStateUpdate', (roomData) => {
  // If we're in a night→day suspense countdown, don't switch screens mid-countdown
  if (state.pendingDayPhase && roomData.phase === 'day') {
    // Only update player list and state, not screen
    state.players = roomData.players;
    state.round = roomData.round;
    const me = roomData.players.find(p => p.id === state.playerId);
    if (me) { state.isHost = me.isHost; if (me.role) state.role = me.role; }
    updateLobbyUI();
    renderVillageGrid();
    return;
  }

  state.roomCode = roomData.code;
  state.players = roomData.players;
  state.round = roomData.round;

  const me = roomData.players.find(p => p.id === state.playerId);
  if (me) {
    state.isHost = me.isHost;
    if (me.role) state.role = me.role;
  }

  updateLobbyUI();
  renderVillageGrid();
  syncPhase(roomData.phase);
});

function syncPhase(phase) {
  if (phase === 'lobby') {
    showScreen('lobby');
  } else if (phase === 'roleReveal') {
    setupRoleCard();
    showScreen('role');
  } else if (phase === 'night') {
    state.voteChips = {};
    setupNightScreen();
    showScreen('night');
  } else if (phase === 'day') {
    showScreen('day');
    setupDayReadiness();
  } else if (phase === 'vote') {
    showScreen('vote');
  } else if (phase === 'voteResult') {
    showScreen('vote-result');
  } else if (phase === 'gameOver') {
    showScreen('gameover');
  }
}

// ── Step 1 & 2: Onboarding & Lobby ──
function initOnboardingHandlers() {
  const nameNextBtn = $('#btn-name-next');
  const nameInput = $('#input-player-name');

  if (nameNextBtn) {
    nameNextBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) return;
      state.playerName = name;
      $('#welcome-greeting').textContent = `Hello, ${name}!`;
      showScreen('onboarding');
    });
  }

  const createRoomBtn = $('#btn-create-room');
  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => {
      socket.emit('createRoom', { playerName: state.playerName }, (res) => {
        if (res.success) {
          state.roomCode = res.roomCode;
          state.isHost = true;
          showScreen('lobby');
        } else {
          $('#onboarding-error').textContent = res.error;
        }
      });
    });
  }

  const showJoinBtn = $('#btn-show-join');
  if (showJoinBtn) {
    showJoinBtn.addEventListener('click', () => {
      $('#join-form').style.display = 'block';
      $('#input-room-code').focus();
    });
  }

  const joinRoomBtn = $('#btn-join-room');
  if (joinRoomBtn) {
    joinRoomBtn.addEventListener('click', () => {
      const code = $('#input-room-code').value.trim();
      if (!code) return;
      socket.emit('joinRoom', { roomCode: code, playerName: state.playerName }, (res) => {
        if (res.success) {
          state.roomCode = res.roomCode;
          state.isHost = false;
          showScreen('lobby');
        } else {
          $('#onboarding-error').textContent = res.error;
        }
      });
    });
  }
}

function updateLobbyUI() {
  if ($('#lobby-room-code')) $('#lobby-room-code').textContent = state.roomCode || '----';
  if ($('#player-count')) $('#player-count').textContent = state.players.length;

  const listEl = $('#lobby-player-list');
  if (listEl) {
    listEl.innerHTML = state.players.map(p => `
      <div class="lobby-player-pill">
        <span>${escapeHtml(p.name)} ${p.id === state.playerId ? '(You)' : ''}</span>
        ${p.isHost ? '<span class="host-pill">HOST</span>' : ''}
      </div>
    `).join('');
  }

  const startBtn = $('#btn-start-game');
  const waitMsg = $('#lobby-wait-msg');

  if (state.isHost) {
    if (startBtn) startBtn.style.display = 'inline-block';
    if (waitMsg) waitMsg.style.display = 'none';
  } else {
    if (startBtn) startBtn.style.display = 'none';
    if (waitMsg) waitMsg.style.display = 'block';
  }
}

// ── Developer Mode ──
function initDevModeHandlers() {
  const toggleBtn = $('#btn-dev-toggle');
  const addBotsBtn = $('#btn-dev-add-bots');
  const godRolesBtn = $('#btn-dev-god-roles');

  const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      state.godMode = !state.godMode;
      toggleBtn.innerHTML = PENCIL_SVG + (state.godMode ? ' Dev Mode: ON' : ' Dev Mode: OFF');
      if (addBotsBtn) addBotsBtn.style.display = state.godMode ? 'inline-flex' : 'none';
      if (godRolesBtn) godRolesBtn.style.display = state.godMode ? 'inline-flex' : 'none';
    });
  }

  if (addBotsBtn) {
    addBotsBtn.addEventListener('click', () => {
      socket.emit('devAddBots');
    });
  }

  if (godRolesBtn) {
    godRolesBtn.addEventListener('click', () => {
      socket.emit('devGetGodRoles', (res) => {
        if (res && res.success) {
          res.players.forEach(p => {
            const found = state.players.find(sp => sp.id === p.id);
            if (found) found.role = p.role;
          });
          renderVillageGrid();
        }
      });
    });
  }
}

// ── Phase 2: Role Reveal ──
socket.on('yourRole', (data) => {
  state.role = data.role;
  state.mafiaMembers = data.mafiaAllies || [];
  setupRoleCard();
});

function setupRoleCard() {
  const cardImg = $('#role-card-img');
  if (!cardImg) return;

  if ($('#btn-role-ack')) $('#btn-role-ack').style.display = 'inline-block';
  if ($('#role-waiting')) $('#role-waiting').style.display = 'none';

  const role = state.role || 'villager';
  const roleNameEl = $('#role-name');
  const roleTeamEl = $('#role-team');
  const roleDescEl = $('#role-description');
  const roleAlliesEl = $('#role-mafia-allies');
  const alliesBox = $('#role-mafia-allies-box');

  roleNameEl.textContent = role.charAt(0).toUpperCase() + role.slice(1);

  if (role === 'mafia') {
    cardImg.src = '/assets/Mafia.png';
    roleTeamEl.textContent = 'Team Mafia';
    roleTeamEl.className = 'role-team-badge team-mafia';
    roleDescEl.textContent = 'Eliminate the villagers during the night without getting caught during daytime votes.';
    if (alliesBox) alliesBox.style.display = 'block';
    if (state.mafiaMembers && state.mafiaMembers.length > 0) {
      roleAlliesEl.textContent = state.mafiaMembers.map(m => m.name).join(', ');
    } else {
      roleAlliesEl.textContent = 'You are operating as solo Mafia.';
    }
  } else if (role === 'healer') {
    cardImg.src = '/assets/Healer.png';
    roleTeamEl.textContent = 'Team Village';
    roleTeamEl.className = 'role-team-badge team-village';
    roleDescEl.textContent = 'Choose one player each night to protect from Mafia elimination.';
    if (alliesBox) alliesBox.style.display = 'none';
  } else {
    cardImg.src = '/assets/Villager.png';
    roleTeamEl.textContent = 'Team Village';
    roleTeamEl.className = 'role-team-badge team-village';
    roleDescEl.textContent = 'Discuss during daytime to identify and vote out hidden Mafia members.';
    if (alliesBox) alliesBox.style.display = 'none';
  }
}

function initRoleHandlers() {
  const ackBtn = $('#btn-role-ack');
  if (ackBtn) {
    ackBtn.addEventListener('click', () => {
      ackBtn.style.display = 'none';
      if ($('#role-waiting')) $('#role-waiting').style.display = 'block';
      socket.emit('roleAcknowledged');
    });
  }

  const startBtn = $('#btn-start-game');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      socket.emit('startGame', (res) => {
        if (!res.success) {
          $('#lobby-error').textContent = res.error;
        } else {
          $('#lobby-error').textContent = '';
        }
      });
    });
  }
}

// ── Phase 3: Night Action ──
function setupNightScreen() {
  const badge = $('#night-role-badge');
  const title = $('#night-action-title');
  const desc = $('#night-action-desc');
  const chosenPill = $('#night-chosen');
  const roundEl = $('#night-round');
  const nightTitle = $('#night-title');
  const countdownEl = $('#night-countdown');

  if (roundEl) roundEl.textContent = `Round ${state.round}`;
  if (chosenPill) { chosenPill.style.display = 'none'; chosenPill.style.cssText = ''; }
  if (nightTitle) nightTitle.textContent = 'Night Falls on the Village';
  if (countdownEl) countdownEl.style.display = 'none';

  // Reset card opacities
  $$('.village-card').forEach(c => { c.style.opacity = '1'; });

  const role = state.role || 'villager';

  const SVG_TARGET = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="vertical-align:middle;margin-right:4px"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`;
  const SVG_CROSS  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" style="vertical-align:middle;margin-right:4px"><path d="M12 8v8M8 12h8"/><circle cx="12" cy="12" r="9"/></svg>`;
  const SVG_MOON   = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="vertical-align:middle;margin-right:4px"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  if (role === 'mafia') {
    if (badge) badge.innerHTML = SVG_TARGET + 'Mafia Objective';
    if (title) title.textContent = 'Select Night Target';
    if (desc) desc.textContent = 'Click any player card below to select your target for elimination. Fellow Mafia will see your choice in real time.';
  } else if (role === 'healer') {
    if (badge) badge.innerHTML = SVG_CROSS + 'Healer Objective';
    if (title) title.textContent = 'Protect a Player';
    if (desc) desc.textContent = 'Click any player card below to protect them from Mafia elimination tonight.';
  } else {
    if (badge) badge.innerHTML = SVG_MOON + 'Village — Rest Until Morning';
    if (title) title.textContent = 'The village sleeps';
    if (desc) desc.textContent = 'Sit quietly while the night plays out. Dawn will reveal what happened.';
  }
}

socket.on('mafiaTargetUpdate', (data) => {
  if (state.role === 'mafia') {
    const chosenPill = $('#night-chosen');
    if (chosenPill) {
      chosenPill.style.display = 'block';
      chosenPill.textContent = `Mafia consensus: ${data.targetName} (chosen by ${data.chosenBy})`;
    }
  }
});

// ── Common Village Grid Rendering ──
function renderVillageGrid() {
  const grid = $('#village-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const me = state.players.find(p => p.id === state.playerId);

  state.players.forEach(player => {
    const card = document.createElement('div');
    card.className = `village-card ${player.id === state.playerId ? 'is-me' : ''}`;
    card.dataset.id = player.id;

    let canClick = false;
    if (state.phase === 'night' && me && me.alive) {
      if (state.role === 'mafia' && player.role !== 'mafia' && player.alive) canClick = true;
      if (state.role === 'healer' && player.alive) canClick = true;
    } else if (state.phase === 'vote' && me && me.alive && player.alive && player.id !== state.playerId) {
      canClick = true;
    }

    if (canClick) {
      card.classList.add('clickable');
      card.addEventListener('click', () => handleCardClick(player));
    }

    // Eliminated treatment in voteResult phase
    const isEliminated = state.phase === 'voteResult' && !player.alive;
    if (isEliminated) card.classList.add('card-just-eliminated');

    // Role avatar resolution
    let displayRole = 'villager';
    if (player.id === state.playerId) {
      displayRole = state.role || 'villager';
    } else if (state.role === 'mafia' && player.role === 'mafia') {
      displayRole = 'mafia';
    } else if (state.godMode && player.role) {
      displayRole = player.role;
    }

    let imgSrc = '/assets/Villager.png';
    if (!player.alive) {
      imgSrc = '/assets/Dead%20Villager.png';
    } else if (displayRole === 'mafia') {
      imgSrc = '/assets/Mafia.png';
    } else if (displayRole === 'healer') {
      imgSrc = '/assets/Healer.png';
    }

    // Vote count badge (during voting phase)
    let voteBadgeHtml = '';
    if (state.phase === 'vote' && state.voteCounts && state.voteCounts[player.id]) {
      const cnt = state.voteCounts[player.id];
      voteBadgeHtml = `<span class="vote-count-badge">${cnt} ${cnt === 1 ? 'vote' : 'votes'}</span>`;
    }

    // Voter chips (shown on vote result)
    let voterChipsHtml = '';
    if ((state.phase === 'voteResult') && state.voteChips[player.id] && state.voteChips[player.id].length > 0) {
      const chips = state.voteChips[player.id].map(v => `<span class="voter-chip">${escapeHtml(v)}</span>`).join('');
      voterChipsHtml = `<div class="voter-chips">${chips}</div>`;
    }

    // Eliminated overlay
    const eliminatedOverlay = isEliminated
      ? `<div class="eliminated-stamp">EXPELLED</div>`
      : '';

    card.innerHTML = `
      ${voteBadgeHtml}
      ${eliminatedOverlay}
      <div class="card-character-hero">
        <img class="card-hero-img" src="${imgSrc}" alt="${player.name}" />
      </div>
      <div class="card-info-bar">
        <span class="player-name">${escapeHtml(player.name)} ${player.id === state.playerId ? '(You)' : ''}</span>
        <span class="player-status ${player.alive ? 'alive-tag' : 'dead-tag'}">${player.alive ? 'ALIVE' : 'DEAD'}</span>
        ${voterChipsHtml}
      </div>
    `;

    grid.appendChild(card);
  });
}

function handleCardClick(targetPlayer) {
  if (state.phase === 'night') {
    state.selectedTargetId = targetPlayer.id;
    socket.emit('submitNightAction', { targetId: targetPlayer.id });
    const chosenPill = $('#night-chosen');
    if (chosenPill) {
      chosenPill.style.display = 'block';
      if (state.role === 'mafia') {
        chosenPill.textContent = `You will eliminate ${targetPlayer.name} — awaiting dawn`;
        chosenPill.style.background = 'rgba(185,28,47,0.15)';
        chosenPill.style.color = '#E02040';
        chosenPill.style.borderColor = '#B91C2F';
      } else {
        chosenPill.textContent = `You are protecting ${targetPlayer.name} tonight`;
      }
    }
    // Dim unselected cards
    $$('.village-card').forEach(c => {
      c.style.opacity = c.dataset.id === targetPlayer.id ? '1' : '0.45';
      c.classList.remove('clickable');
    });
  } else if (state.phase === 'vote') {
    state.votedTargetId = targetPlayer.id;
    socket.emit('castVote', { targetId: targetPlayer.id });
    $$('.village-card').forEach(c => c.classList.remove('clickable'));
  }
}

// ── Phase 4a: Night Result → 5-second suspense → Day ──
socket.on('nightResult', (data) => {
  state.pendingDayPhase = true;

  // Set the day screen result text (will show once day loads)
  const resultText = $('#day-result-text');
  if (resultText) {
    if (data.eliminatedPlayer) {
      resultText.textContent = `${data.eliminatedPlayer.name} was found dead at dawn.`;
    } else if (data.saved) {
      resultText.textContent = data.protectedName
        ? `The village wakes safely. ${data.protectedName} was protected by the Healer.`
        : `The village wakes safely. The Healer shielded someone in the night.`;
    } else {
      resultText.textContent = `A peaceful night. Everyone survived until morning.`;
    }
  }

  // Reuse night screen for countdown
  const nightTitle = $('#night-title');
  const nightInstCard = $('#night-instruction-card');
  const nightChosen = $('#night-chosen');
  const countdownEl = $('#night-countdown');

  if (nightInstCard) nightInstCard.style.display = 'none';
  if (nightChosen) nightChosen.style.display = 'none';

  let msg = 'The night draws to a close...';
  if (data.eliminatedPlayer) msg = `${data.eliminatedPlayer.name} was eliminated in the night...`;
  else if (data.saved) {
    msg = data.protectedName
      ? `${data.protectedName} was saved by the Healer tonight...`
      : `Someone was saved by the Healer tonight...`;
  }

  if (nightTitle) nightTitle.textContent = msg;

  let secs = 5;
  if (countdownEl) {
    countdownEl.style.display = 'block';
    countdownEl.textContent = `Dawn breaks in ${secs}...`;
  }

  const countdownInterval = setInterval(() => {
    secs--;
    if (countdownEl) {
      countdownEl.textContent = secs > 0 ? `Dawn breaks in ${secs}...` : 'Dawn breaks...';
    }
    if (secs <= 0) {
      clearInterval(countdownInterval);
      state.pendingDayPhase = false;
      if (countdownEl) countdownEl.style.display = 'none';
      if (nightInstCard) nightInstCard.style.display = '';
      showScreen('day');
      setupDayReadiness();
    }
  }, 1000);
});

function setupDayReadiness() {
  const readyVoteBtn = $('#btn-ready-vote');
  if (readyVoteBtn) {
    readyVoteBtn.disabled = false;
    readyVoteBtn.innerHTML = `<svg class="btn-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9,11 12,14 22,4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Ready to Vote`;
  }
  const readinessBar = $('#day-readiness-bar');
  if (readinessBar) readinessBar.style.display = 'none';
  const dayRound = $('#day-round');
  if (dayRound) dayRound.textContent = `Round ${state.round}`;
}

function initDayVoteHandlers() {
  const readyVoteBtn = $('#btn-ready-vote');
  if (readyVoteBtn) {
    readyVoteBtn.addEventListener('click', () => {
      readyVoteBtn.disabled = true;
      readyVoteBtn.innerHTML = `<svg class="btn-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg> Waiting for others...`;
      socket.emit('readyToVote');
    });
  }
}

socket.on('dayReadyProgress', (data) => {
  const bar = $('#day-readiness-bar');
  const fill = $('#day-readiness-fill');
  const text = $('#day-readiness-text');
  if (bar) bar.style.display = 'block';
  if (fill) fill.style.width = `${Math.round((data.readyCount / data.totalCount) * 100)}%`;
  if (text) text.textContent = `${data.readyCount} of ${data.totalCount} players ready to vote`;
});

socket.on('voteCountsUpdate', (counts) => {
  state.voteCounts = counts;
  renderVillageGrid();
});

// ── Phase 4b: Vote Result → chips on cards + host controls ──
socket.on('voteResult', (data) => {
  // Build vote chip map: targetId → [voterName, ...]
  state.voteChips = {};
  if (data.breakdown) {
    data.breakdown.forEach(b => {
      if (!state.voteChips[b.targetId]) state.voteChips[b.targetId] = [];
      state.voteChips[b.targetId].push(b.voterName);
    });
  }
  state.voteCounts = {};
  renderVillageGrid();

  // Compact outcome text
  const outcome = $('#vote-result-outcome');
  if (outcome) {
    if (data.isTie) {
      outcome.textContent = 'A split vote — no one was eliminated today.';
    } else if (data.eliminatedPlayer) {
      outcome.textContent = `By village vote, ${data.eliminatedPlayer.name} has been expelled.`;
    }
  }

  // Host controls
  const hostPanel = $('#host-controls-panel');
  const hostRevealBtn = $('#btn-host-reveal-role');
  const hostProtectionBtn = $('#btn-host-announce-protection');
  const nextBtn = $('#btn-next-phase');
  const waitMsg = $('#vote-result-wait');

  if (state.isHost) {
    if (hostPanel) hostPanel.style.display = 'flex';
    if (waitMsg) waitMsg.style.display = 'none';

    // Reveal eliminated role button
    if (hostRevealBtn) {
      if (data.eliminatedPlayer) {
        hostRevealBtn.style.display = 'inline-flex';
        hostRevealBtn.onclick = () => {
          socket.emit('hostRevealEliminated');
          hostRevealBtn.disabled = true;
          hostRevealBtn.textContent = 'Role Revealed to All';
        };
      } else {
        hostRevealBtn.style.display = 'none';
      }
    }

    // Protection announcement button
    if (hostProtectionBtn) {
      socket.emit('hostGetProtectionInfo', (res) => {
        if (res && res.protectedName) {
          hostProtectionBtn.style.display = 'inline-flex';
          hostProtectionBtn.textContent = `Announce: ${res.protectedName} was protected`;
          hostProtectionBtn.onclick = () => {
            socket.emit('hostAnnounceProtection');
            hostProtectionBtn.disabled = true;
            hostProtectionBtn.textContent = 'Announced';
          };
        } else {
          if (hostProtectionBtn) hostProtectionBtn.style.display = 'none';
        }
      });
    }

    // Next phase button with 4-second countdown
    if (nextBtn) {
      nextBtn.style.display = 'inline-flex';
      nextBtn.disabled = true;
      let secs = 4;
      nextBtn.textContent = `Proceed to Night (${secs}s)`;
      const t = setInterval(() => {
        secs--;
        if (secs > 0) {
          nextBtn.textContent = `Proceed to Night (${secs}s)`;
        } else {
          clearInterval(t);
          nextBtn.innerHTML = `Proceed to Night <svg class="btn-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="vertical-align:middle;margin-left:4px"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
          nextBtn.disabled = false;
        }
      }, 1000);
    }
  } else {
    if (hostPanel) hostPanel.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
    if (waitMsg) waitMsg.style.display = 'block';
  }
});

// Host broadcast events received by all players
socket.on('roleRevealed', (data) => {
  const outcome = $('#vote-result-outcome');
  if (outcome) {
    outcome.textContent = `${data.name} was the ${data.role.toUpperCase()} — the village was ${data.role === 'mafia' ? 'right' : 'wrong'}.`;
  }
});

socket.on('protectionAnnounced', (data) => {
  const resultText = $('#day-result-text');
  if (resultText && data.name) {
    resultText.textContent += ` The Healer protected ${data.name} last night.`;
  }
});

const nextPhaseBtn = $('#btn-next-phase');
if (nextPhaseBtn) {
  nextPhaseBtn.addEventListener('click', () => {
    nextPhaseBtn.disabled = true;
    socket.emit('nextPhaseAfterResult');
  });
}

// ── Phase 5: Game Over & Play Again ──
socket.on('gameOver', (data) => {
  showScreen('gameover');

  const title = $('#gameover-title');
  const banner = $('#gameover-banner');
  const reason = $('#gameover-reason');
  const list = $('#gameover-roles-list');

  if (data.winner === 'mafia') {
    if (title) title.textContent = 'MAFIA VICTORY';
    if (banner) banner.textContent = 'DETECTIVES DEFEATED';
  } else {
    if (title) title.textContent = 'VILLAGE VICTORY';
    if (banner) banner.textContent = 'MAFIA ELIMINATED';
  }

  if (reason) reason.textContent = data.reason;

  if (list && data.players) {
    list.innerHTML = data.players.map(p => `
      <div class="summary-pill">
        <span>${escapeHtml(p.name)}</span>
        <span class="role-badge role-${p.role}">${p.role.toUpperCase()}</span>
      </div>
    `).join('');
  }

  const againBtn = $('#btn-play-again');
  const waitMsg = $('#gameover-wait');

  if (state.isHost) {
    if (againBtn) againBtn.style.display = 'inline-block';
    if (waitMsg) waitMsg.style.display = 'none';
  } else {
    if (againBtn) againBtn.style.display = 'none';
    if (waitMsg) waitMsg.style.display = 'block';
  }
});

const playAgainBtn = $('#btn-play-again');
if (playAgainBtn) {
  playAgainBtn.addEventListener('click', () => {
    socket.emit('playAgain');
  });
}

socket.on('gameResetToLobby', () => {
  state.role = null;
  state.mafiaMembers = [];
  state.selectedTargetId = null;
  state.votedTargetId = null;
  state.voteCounts = {};
  state.voteChips = {};
  state.pendingDayPhase = false;
  showScreen('lobby');
});

// ── Initialization ──
document.addEventListener('DOMContentLoaded', () => {
  initOnboardingHandlers();
  initDevModeHandlers();
  initRoleHandlers();
  initDayVoteHandlers();
  showScreen('welcome');
});
