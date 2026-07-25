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
  voteCounts: {}
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
  } else {
    document.body.classList.remove('night');
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
    setupNightScreen();
    showScreen('night');
  } else if (phase === 'day') {
    showScreen('day');
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

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      state.godMode = !state.godMode;
      toggleBtn.textContent = state.godMode ? '✏️ Dev Mode: ON' : '✏️ Dev Mode: OFF';
      if (addBotsBtn) addBotsBtn.style.display = state.godMode ? 'inline-block' : 'none';
      if (godRolesBtn) godRolesBtn.style.display = state.godMode ? 'inline-block' : 'none';
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
    roleTeamEl.textContent = 'Team Mafia 🕵️';
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
    roleTeamEl.textContent = 'Team Village 🩺';
    roleTeamEl.className = 'role-team-badge team-village';
    roleDescEl.textContent = 'Choose one player each night to protect from Mafia elimination.';
    if (alliesBox) alliesBox.style.display = 'none';
  } else {
    cardImg.src = '/assets/Villager.png';
    roleTeamEl.textContent = 'Team Village 👨‍🌾';
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

  if (roundEl) roundEl.textContent = `Round ${state.round}`;
  if (chosenPill) chosenPill.style.display = 'none';

  const role = state.role || 'villager';

  if (role === 'mafia') {
    if (badge) badge.textContent = '🕵️ Mafia Objective';
    if (title) title.textContent = 'Select Night Target';
    if (desc) desc.textContent = 'Click any player card below to select your target for elimination. Fellow Mafia will see your choice in real time.';
  } else if (role === 'healer') {
    if (badge) badge.textContent = '🩺 Healer Objective';
    if (title) title.textContent = 'Protect a Player';
    if (desc) desc.textContent = 'Click any player card below to protect them from Mafia elimination tonight.';
  } else {
    if (badge) badge.textContent = '🌙 Village Sleep';
    if (title) title.textContent = 'Rest Until Morning';
    if (desc) desc.textContent = 'The village is asleep. Rest quietly until dawn breaks.';
  }
}

socket.on('mafiaTargetUpdate', (data) => {
  if (state.role === 'mafia') {
    const chosenPill = $('#night-chosen');
    if (chosenPill) {
      chosenPill.style.display = 'block';
      chosenPill.textContent = `Mafia target selected: ${data.targetName} (by ${data.chosenBy})`;
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

    // Vote count badge
    let voteBadgeHtml = '';
    if (state.phase === 'vote' && state.voteCounts && state.voteCounts[player.id]) {
      const cnt = state.voteCounts[player.id];
      voteBadgeHtml = `<span class="vote-count-badge">${cnt} ${cnt === 1 ? 'vote' : 'votes'}</span>`;
    }

    card.innerHTML = `
      ${voteBadgeHtml}
      <div class="card-character-hero">
        <img class="card-hero-img" src="${imgSrc}" alt="${player.name}" />
      </div>
      <div class="card-info-bar">
        <span class="player-name">${escapeHtml(player.name)} ${player.id === state.playerId ? '(You)' : ''}</span>
        <span class="player-status ${player.alive ? 'alive-tag' : 'dead-tag'}">${player.alive ? 'ALIVE' : 'ELIMINATED'}</span>
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
      chosenPill.textContent = `Action submitted: Target ${targetPlayer.name}`;
    }
  } else if (state.phase === 'vote') {
    state.votedTargetId = targetPlayer.id;
    socket.emit('castVote', { targetId: targetPlayer.id });
  }
}

// ── Phase 4: Day & Voting ──
socket.on('nightResult', (data) => {
  const resultText = $('#day-result-text');
  if (resultText) {
    if (data.eliminatedPlayer) {
      resultText.textContent = `💀 Tragedy strikes! ${data.eliminatedPlayer.name} was eliminated during the night.`;
    } else if (data.saved) {
      resultText.textContent = `🩺 A miraculous night! The Healer successfully protected the target!`;
    } else {
      resultText.textContent = `🌅 A peaceful night. Everyone survived!`;
    }
  }
});

function initDayVoteHandlers() {
  const readyVoteBtn = $('#btn-ready-vote');
  if (readyVoteBtn) {
    readyVoteBtn.addEventListener('click', () => {
      readyVoteBtn.disabled = true;
      readyVoteBtn.textContent = 'Waiting for others...';
      socket.emit('readyToVote');
    });
  }
}

socket.on('voteCountsUpdate', (counts) => {
  state.voteCounts = counts;
  renderVillageGrid();
});

socket.on('voteResult', (data) => {
  const outcome = $('#vote-result-outcome');
  const list = $('#vote-breakdown-list');

  if (outcome) {
    if (data.isTie) {
      outcome.textContent = '🤝 The vote ended in a tie! No player was eliminated today.';
    } else if (data.eliminatedPlayer) {
      outcome.textContent = `⚖️ By village vote, ${data.eliminatedPlayer.name} (${data.eliminatedPlayer.role.toUpperCase()}) has been eliminated!`;
    }
  }

  if (list && data.breakdown) {
    list.innerHTML = data.breakdown.map(b => `
      <div class="breakdown-item">
        <span>${escapeHtml(b.voterName)}</span>
        <span>voted for ➔ <strong>${escapeHtml(b.targetName)}</strong></span>
      </div>
    `).join('');
  }

  const nextBtn = $('#btn-next-phase');
  const waitMsg = $('#vote-result-wait');

  if (state.isHost) {
    if (nextBtn) nextBtn.style.display = 'inline-block';
    if (waitMsg) waitMsg.style.display = 'none';
  } else {
    if (nextBtn) nextBtn.style.display = 'none';
    if (waitMsg) waitMsg.style.display = 'block';
  }
});

const nextPhaseBtn = $('#btn-next-phase');
if (nextPhaseBtn) {
  nextPhaseBtn.addEventListener('click', () => {
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
