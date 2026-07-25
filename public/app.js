// ─── Mafia Online — Client Application ─────────────────────────────────

const socket = io();

// Client State
const state = {
  playerId: null,
  roomCode: null,
  isHost: false,
  role: null,
  phase: 'welcome',
  players: [],
  settings: {
    mafiaCount: 1,
    healerCount: 1,
    discussionTime: 120,
    firstNightKill: true,
    revealRoleOnDeath: true,
    allowHealerSelfHeal: false,
    revealHealerSave: true,
  },
  selectedTarget: null,
  roleAcknowledged: false,
  readyForVote: false,
  readyForNight: false,
};

// DOM Helpers
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// ── Screen Router ──
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

  const activeGridPhases = ['night', 'day', 'vote', 'voteResult', 'vote-result'];
  if (activeGridPhases.includes(phase)) {
    container.style.display = 'block';
    renderVillageGrid();
  } else {
    container.style.display = 'none';
  }
}

// ── Village Grid Renderer ──
function renderVillageGrid() {
  const grid = $('#village-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const me = state.players.find(p => p.id === state.playerId);
  const isMeAlive = me ? me.alive : false;

  state.players.forEach(player => {
    const card = document.createElement('div');
    card.className = `village-card ${player.alive ? 'is-alive' : 'is-dead'}`;
    if (player.id === state.playerId) card.classList.add('is-me');

    // Check target selection state
    if (state.selectedTarget === player.id) {
      card.classList.add('selected');
    }

    // Determine interactivity
    let canClick = false;

    if (state.phase === 'night' && isMeAlive && player.alive) {
      if (state.role === 'mafia' && player.role !== 'mafia') {
        canClick = true;
      } else if (state.role === 'healer') {
        if (state.settings.allowHealerSelfHeal || player.id !== state.playerId) {
          canClick = true;
        }
      }
    } else if (state.phase === 'vote' && isMeAlive && player.alive && player.id !== state.playerId) {
      canClick = true;
    }

    if (canClick) {
      card.classList.add('clickable');
      card.addEventListener('click', () => handleGridCardClick(player));
    } else if (state.phase === 'night' || state.phase === 'vote') {
      card.classList.add('disabled');
    }

    // Determine avatar role to display
    let displayRole = 'villager';
    if (player.id === state.playerId) {
      displayRole = state.role || 'villager';
    } else if (state.role === 'mafia' && player.role === 'mafia') {
      displayRole = 'mafia';
    }

    // Live vote count badge
    let voteBadgeHtml = '';
    if (state.phase === 'vote' && state.voteCounts && state.voteCounts[player.id]) {
      const cnt = state.voteCounts[player.id];
      voteBadgeHtml = `<span class="vote-count-badge">${cnt} ${cnt === 1 ? 'vote' : 'votes'}</span>`;
    }

    card.innerHTML = `
      ${voteBadgeHtml}
      <div class="player-avatar">${getCharacterAvatarSvg(displayRole, player.alive)}</div>
      <span class="player-name">${escapeHtml(player.name)} ${player.id === state.playerId ? '(You)' : ''}</span>
      <span class="player-status ${player.alive ? 'alive-tag' : 'dead-tag'}">${player.alive ? 'ALIVE' : 'ELIMINATED'}</span>
    `;

    grid.appendChild(card);
  });
}

function handleGridCardClick(player) {
  if (state.phase === 'night') {
    state.selectedTarget = player.id;
    socket.emit('nightAction', { targetId: player.id });
    
    if ($('#night-chosen')) {
      $('#night-chosen').style.display = 'block';
      $('#night-chosen').textContent = `Target selected: ${player.name}`;
    }
    renderVillageGrid();
  } else if (state.phase === 'vote') {
    state.selectedTarget = player.id;
    socket.emit('castVote', { targetId: player.id });
    
    if ($('#vote-chosen')) {
      $('#vote-chosen').style.display = 'block';
      $('#vote-chosen').textContent = `You voted to eliminate: ${player.name}`;
    }
    renderVillageGrid();
  }
}

function setupNightScreen(roundData) {
  state.selectedTarget = null;
  const me = state.players.find(p => p.id === state.playerId);
  const isMeAlive = me ? me.alive : false;

  if ($('#night-round')) $('#night-round').textContent = `Round ${roundData.round || 1}`;

  if (roundData.firstNightSkipped) {
    $('#night-sleep').style.display = 'none';
    $('#night-choose').style.display = 'none';
    $('#night-skip').style.display = 'block';
    return;
  }
  $('#night-skip').style.display = 'none';

  if (!isMeAlive || state.role === 'villager') {
    $('#night-sleep').style.display = 'block';
    $('#night-choose').style.display = 'none';
  } else {
    $('#night-sleep').style.display = 'none';
    $('#night-choose').style.display = 'block';

    const prompt = $('#night-prompt');
    if (state.role === 'mafia') {
      prompt.textContent = 'Select a village player to eliminate tonight:';
    } else if (state.role === 'healer') {
      prompt.textContent = 'Select a player to protect tonight:';
    }
  }

  renderVillageGrid();
}

let dayTimerInterval = null;

function setupDayScreen(data) {
  if ($('#day-round')) $('#day-round').textContent = `Round ${data.round || 1}`;

  const resText = $('#day-result-text');
  if (resText) {
    if (data.nightResult?.eliminatedPlayer) {
      const p = data.nightResult.eliminatedPlayer;
      resText.textContent = `${p.name} was eliminated during the night.`;
    } else if (data.nightResult?.savedByHealer) {
      resText.textContent = `Someone was attacked, but protected by the Healer! No one died.`;
    } else {
      resText.textContent = `The village slept peacefully. No one was harmed.`;
    }
  }

  // Reset readiness controls
  state.readyForVote = false;
  const readyBtn = $('#btn-ready-vote');
  if (readyBtn) {
    readyBtn.style.display = 'inline-block';
    readyBtn.disabled = false;
    readyBtn.textContent = 'Ready to vote';
  }

  if ($('#day-readiness-bar')) $('#day-readiness-bar').style.display = 'none';
  if ($('#day-readiness-text')) $('#day-readiness-text').style.display = 'none';

  if ($('#btn-force-vote')) {
    $('#btn-force-vote').style.display = state.isHost ? 'inline-block' : 'none';
  }

  // Start discussion countdown timer
  startDayTimer(data.discussionTime || 120);
  renderVillageGrid();
}

function startDayTimer(seconds) {
  if (dayTimerInterval) clearInterval(dayTimerInterval);

  let remaining = seconds;
  const total = seconds;
  const textEl = $('#timer-text');
  const fillEl = $('#timer-progress');

  const circumference = 2 * Math.PI * 54; // r=54 in SVG
  if (fillEl) fillEl.style.strokeDasharray = `${circumference}`;

  function update() {
    if (textEl) textEl.textContent = `${remaining}s`;
    if (fillEl) {
      const offset = circumference - (remaining / total) * circumference;
      fillEl.style.strokeDashoffset = offset;
    }

    if (remaining <= 0) {
      clearInterval(dayTimerInterval);
      if (state.isHost && state.phase === 'day') {
        socket.emit('forceVotePhase');
      }
    }
    remaining--;
  }

  update();
  dayTimerInterval = setInterval(update, 1000);
}

function setupVoteScreen(data) {
  if (dayTimerInterval) clearInterval(dayTimerInterval);
  state.selectedTarget = null;
  state.voteCounts = {};

  if ($('#vote-chosen')) $('#vote-chosen').style.display = 'none';
  if ($('#vote-progress-text')) $('#vote-progress-text').textContent = 'Cast your vote on the village grid cards below.';

  renderVillageGrid();
}

function setupVoteResultScreen(data) {
  const vr = data.voteResult || {};
  const resText = $('#vote-result-text');

  if (resText) {
    if (vr.isTie) {
      resText.textContent = `The vote ended in a tie! No one was eliminated by the village.`;
    } else if (vr.eliminatedPlayer) {
      const p = vr.eliminatedPlayer;
      const roleStr = p.role ? ` (${p.role.toUpperCase()})` : '';
      resText.textContent = `${p.name}${roleStr} was eliminated by the village vote!`;
    } else {
      resText.textContent = `The village chose to skip voting. No one was eliminated.`;
    }
  }

  // Render Formatted Vote Tally Chips
  const tallyEl = $('#vote-tally');
  if (tallyEl && vr.voteDetail) {
    let html = '<div class="tally-card"><h4>Vote Breakdown</h4><div class="tally-grid">';
    vr.voteDetail.forEach(v => {
      html += `
        <div class="tally-chip">
          <span class="tally-voter">${escapeHtml(v.voterName)}</span>
          <span class="tally-arrow">➔</span>
          <span class="tally-target ${v.targetName === 'Skipped' ? 'is-skipped' : ''}">${escapeHtml(v.targetName)}</span>
        </div>`;
    });
    html += '</div></div>';
    tallyEl.innerHTML = html;
  }

  // Reset readiness controls
  state.readyForNight = false;
  const readyBtn = $('#btn-ready-night');
  if (readyBtn) {
    readyBtn.style.display = 'inline-block';
    readyBtn.disabled = false;
    readyBtn.textContent = 'Ready for night';
  }

  if ($('#vote-readiness-bar')) $('#vote-readiness-bar').style.display = 'none';
  if ($('#vote-readiness-text')) $('#vote-readiness-text').style.display = 'none';

  if ($('#btn-force-night')) {
    $('#btn-force-night').style.display = state.isHost ? 'inline-block' : 'none';
  }

  renderVillageGrid();
}

function setupGameOverScreen(data) {
  if (dayTimerInterval) clearInterval(dayTimerInterval);

  const titleEl = $('#gameover-title');
  const subEl = $('#gameover-subtitle');

  if (data.winner === 'village') {
    if (titleEl) {
      titleEl.textContent = 'VILLAGE VICTORY!';
      titleEl.className = 'gameover-title winner-village';
    }
    if (subEl) subEl.textContent = 'All Mafia members have been eliminated. The village is safe!';
  } else {
    if (titleEl) {
      titleEl.textContent = 'MAFIA VICTORY!';
      titleEl.className = 'gameover-title winner-mafia';
    }
    if (subEl) subEl.textContent = 'The Mafia has taken over the village!';
  }

  // Populate formatted roles table with mini character avatars
  const tbody = $('#gameover-table tbody');
  if (tbody && data.players) {
    tbody.innerHTML = '';
    data.players.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="player-cell">
          <div class="mini-avatar-wrap">${getCharacterAvatarSvg(p.role, p.alive)}</div>
          <strong>${escapeHtml(p.name)}</strong>
        </td>
        <td><span class="role-badge role-${p.role}">${(p.role || '').toUpperCase()}</span></td>
        <td>${p.alive ? '<span class="status-alive">ALIVE</span>' : '<span class="status-dead">ELIMINATED</span>'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  if ($('#btn-play-again')) {
    $('#btn-play-again').style.display = state.isHost ? 'inline-block' : 'none';
  }
  if ($('#gameover-wait')) {
    $('#gameover-wait').style.display = state.isHost ? 'none' : 'block';
  }

  renderVillageGrid();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ── Welcome Screen Handlers ──
function initWelcomeHandlers() {
  const stepName = $('#welcome-step-name');
  const stepAction = $('#welcome-step-action');
  const nameInput = $('#input-player-name');
  const errorEl = $('#welcome-error');

  const goToStepAction = () => {
    const name = nameInput.value.trim();
    if (!name) {
      if (errorEl) errorEl.textContent = 'Please enter your name.';
      return;
    }
    if (errorEl) errorEl.textContent = '';
    if ($('#greeting-name')) $('#greeting-name').textContent = name;
    if (stepName) stepName.style.display = 'none';
    if (stepAction) stepAction.style.display = 'flex';
  };

  const goToStepName = () => {
    if (errorEl) errorEl.textContent = '';
    if (stepAction) stepAction.style.display = 'none';
    if (stepName) stepName.style.display = 'flex';
  };

  if ($('#btn-name-next')) {
    $('#btn-name-next').addEventListener('click', goToStepAction);
  }

  if (nameInput) {
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') goToStepAction();
    });
  }

  if ($('#btn-back-to-name')) {
    $('#btn-back-to-name').addEventListener('click', goToStepName);
  }

  $('#btn-create-room').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      goToStepName();
      if (errorEl) errorEl.textContent = 'Please enter your name.';
      return;
    }

    socket.emit('createRoom', { playerName: name }, (res) => {
      if (res.success) {
        state.isHost = true;
        state.playerId = res.playerId;
        state.roomCode = res.roomCode;
        enterLobby();
      } else {
        if (errorEl) errorEl.textContent = res.error;
      }
    });
  });

  $('#btn-join-room').addEventListener('click', () => {
    const code = $('#input-room-code').value.trim();
    const name = nameInput.value.trim();

    if (!name) {
      goToStepName();
      if (errorEl) errorEl.textContent = 'Please enter your name.';
      return;
    }

    if (!code) {
      if (errorEl) errorEl.textContent = 'Please enter a valid 4-letter room code.';
      return;
    }

    socket.emit('joinRoom', { roomCode: code, playerName: name }, (res) => {
      if (res.success) {
        state.isHost = Boolean(res.isHost);
        state.playerId = res.playerId;
        state.roomCode = res.roomCode;
        enterLobby();
      } else {
        if (errorEl) errorEl.textContent = res.error;
      }
    });
  });
}

function enterLobby() {
  showScreen('lobby');
  $('#lobby-room-code').textContent = state.roomCode;

  if (state.isHost) {
    $('#lobby-host-actions').style.display = 'block';
    $('#lobby-player-wait').style.display = 'none';
  } else {
    $('#lobby-host-actions').style.display = 'none';
    $('#lobby-player-wait').style.display = 'block';
  }
}

// ── Socket Event Listeners ──
socket.on('lobbyUpdate', (data) => {
  state.players = data.players;
  state.settings = data.settings;
  renderPlayerList();
  renderSettings();
});

socket.on('kicked', () => {
  alert('You have been kicked from the room.');
  showScreen('welcome');
});

function renderPlayerList() {
  const list = $('#player-list');
  if (!list) return;
  list.innerHTML = '';

  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.id === state.playerId ? ' (You)' : '');

    if (state.isHost && p.id !== state.playerId) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'btn-kick';
      kickBtn.textContent = 'Kick';
      kickBtn.addEventListener('click', () => {
        socket.emit('kickPlayer', { targetId: p.id });
      });
      li.appendChild(kickBtn);
    }
    list.appendChild(li);
  });

  $('#player-count').textContent = `${state.players.length} players in the room`;
}

function renderSettings() {
  const s = state.settings;
  if ($('#setting-mafia-count')) $('#setting-mafia-count').textContent = s.mafiaCount;
  if ($('#setting-healer-count')) $('#setting-healer-count').textContent = s.healerCount;
  if ($('#setting-discussion-time')) $('#setting-discussion-time').textContent = `${s.discussionTime}s`;

  updateToggle('#setting-first-night-kill', s.firstNightKill);
  updateToggle('#setting-reveal-role', s.revealRoleOnDeath);
  updateToggle('#setting-self-heal', s.allowHealerSelfHeal);
  updateToggle('#setting-reveal-healer', s.revealHealerSave);
}

function updateToggle(selector, val) {
  const btn = $(selector);
  if (!btn) return;
  if (val) {
    btn.classList.add('active');
    btn.textContent = 'Yes';
  } else {
    btn.classList.remove('active');
    btn.textContent = 'No';
  }
}

function initSettingsHandlers() {
  $$('.btn-step').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.isHost) return;
      const setting = btn.dataset.setting;
      const dir = Number(btn.dataset.dir);
      const current = state.settings[setting] || 0;

      let nextVal = current + dir;
      if (setting === 'mafiaCount') nextVal = Math.max(1, Math.min(3, nextVal));
      if (setting === 'healerCount') nextVal = Math.max(0, Math.min(2, nextVal));
      if (setting === 'discussionTime') nextVal = Math.max(30, Math.min(300, nextVal));

      socket.emit('updateSettings', { [setting]: nextVal });
    });
  });

  $$('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.isHost) return;
      const setting = btn.dataset.setting;
      const current = state.settings[setting];
      socket.emit('updateSettings', { [setting]: !current });
    });
  });
}

// ── Phase 3: Start Game & Role Reveal Handlers ──

socket.on('roleAssigned', (data) => {
  state.role = data.role;
  state.mafiaMembers = data.mafiaMembers || [];
  setupRoleCard();
});

socket.on('phaseChange', (data) => {
  state.players = data.players || state.players;

  if (data.phase === 'lobby') {
    state.role = null;
    state.selectedTarget = null;
    state.voteCounts = {};
    showScreen('lobby');
    renderPlayerList();
    renderSettings();
  } else if (data.phase === 'roleReveal') {
    showScreen('role');
  } else if (data.phase === 'night') {
    showScreen('night');
    setupNightScreen(data);
  } else if (data.phase === 'day') {
    showScreen('day');
    setupDayScreen(data);
  } else if (data.phase === 'vote') {
    showScreen('vote');
    setupVoteScreen(data);
  } else if (data.phase === 'voteResult') {
    showScreen('vote-result');
    setupVoteResultScreen(data);
  } else if (data.phase === 'gameOver') {
    showScreen('gameover');
    setupGameOverScreen(data);
  }
});

socket.on('roleAckProgress', (data) => {
  if ($('#role-waiting')) {
    $('#role-waiting').textContent = `Waiting for other players... (${data.acknowledgedCount}/${data.totalCount})`;
  }
});

function getCharacterAvatarSvg(role, alive = true) {
  if (!alive) {
    return `
      <svg class="avatar-svg dead-ghost-svg" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 40C12 24 16 12 24 12C32 12 36 24 36 40H12Z" fill="currentColor" opacity="0.3"/>
        <path d="M14 38C14 26 18 14 24 14C30 14 34 26 34 38H14Z" stroke="currentColor" stroke-width="2.5" fill="none"/>
        <path d="M19 22L23 26M23 22L19 26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M25 22L29 26M29 22L25 26" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <path d="M20 32C22 30 26 30 28 32" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  if (role === 'mafia') {
    return `
      <svg class="avatar-svg mafia-avatar-svg" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="28" r="14" fill="currentColor" opacity="0.15"/>
        <path d="M10 26C10 26 16 24 24 24C32 24 38 26 38 26C41 26 42 27.5 42 29C42 30.5 39 32 33 32C27 32 18 32 15 32C9 32 6 30.5 6 29C6 27.5 7 26 10 26Z" fill="currentColor"/>
        <path d="M15 24L17 12C17 12 19 9 24 9C29 9 31 12 31 12L33 24H15Z" fill="currentColor"/>
        <rect x="15" y="21" width="18" height="3" fill="#FF0052"/>
        <path d="M14 33H22V37H14V33Z" fill="currentColor"/>
        <path d="M26 33H34V37H26V33Z" fill="currentColor"/>
        <line x1="22" y1="35" x2="26" y2="35" stroke="currentColor" stroke-width="2"/>
      </svg>`;
  }

  if (role === 'healer') {
    return `
      <svg class="avatar-svg healer-avatar-svg" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="26" r="14" fill="currentColor" opacity="0.15"/>
        <path d="M14 22C14 16 18 12 24 12C30 12 34 16 34 22H14Z" fill="#00C68D"/>
        <rect x="22" y="15" width="4" height="10" fill="#FFFFFF"/>
        <rect x="19" y="18" width="10" height="4" fill="#FFFFFF"/>
        <circle cx="24" cy="28" r="12" stroke="currentColor" stroke-width="2.5"/>
        <circle cx="19" cy="27" r="1.5" fill="currentColor"/>
        <circle cx="29" cy="27" r="1.5" fill="currentColor"/>
        <path d="M20 33C22 35 26 35 28 33" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }

  return `
    <svg class="avatar-svg villager-avatar-svg" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="26" r="14" fill="currentColor" opacity="0.15"/>
      <path d="M12 24C12 18 16 14 24 14C32 14 36 18 36 24H12Z" fill="#0055DA"/>
      <path d="M8 24C8 24 14 22 24 22C34 22 40 24 40 24" stroke="#0055DA" stroke-width="3" stroke-linecap="round"/>
      <circle cx="24" cy="28" r="12" stroke="currentColor" stroke-width="2.5"/>
      <circle cx="19" cy="27" r="1.5" fill="currentColor"/>
      <circle cx="29" cy="27" r="1.5" fill="currentColor"/>
      <path d="M19 33C22 36 26 36 29 33" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
}

function setupRoleCard() {
  const card = $('#role-card');
  if (!card) return;

  card.classList.remove('flipped');
  $('#btn-role-ack').style.display = 'none';
  $('#role-waiting').style.display = 'none';

  const role = state.role || 'villager';
  const roleNameEl = $('#role-name');
  const roleTeamEl = $('#role-team');
  const roleDescEl = $('#role-description');
  const roleAlliesEl = $('#role-mafia-allies');
  const roleIconEl = $('#role-icon');

  roleNameEl.textContent = role.charAt(0).toUpperCase() + role.slice(1);
  roleNameEl.className = `role-name ${role}`;

  if (roleIconEl) {
    roleIconEl.className = `role-icon role-${role}`;
    roleIconEl.innerHTML = getCharacterAvatarSvg(role, true);
  }

  if (role === 'mafia') {
    roleTeamEl.textContent = 'Team Mafia';
    roleDescEl.textContent = 'Eliminate the villagers without getting caught.';
    if (state.mafiaMembers.length > 0) {
      roleAlliesEl.textContent = 'Fellow Mafia: ' + state.mafiaMembers.map(m => m.name).join(', ');
    } else {
      roleAlliesEl.textContent = 'You are the solo Mafia.';
    }
  } else if (role === 'healer') {
    roleTeamEl.textContent = 'Team Village';
    roleDescEl.textContent = 'Protect one player each night from elimination.';
    roleAlliesEl.textContent = '';
  } else {
    roleTeamEl.textContent = 'Team Village';
    roleDescEl.textContent = 'Find and eliminate the Mafia in daytime discussions.';
    roleAlliesEl.textContent = '';
  }
}

function initRoleScreenHandlers() {
  const card = $('#role-card');
  if (card) {
    card.addEventListener('click', () => {
      card.classList.toggle('flipped');
      if (card.classList.contains('flipped')) {
        $('#btn-role-ack').style.display = 'inline-block';
      }
    });
  }

  const ackBtn = $('#btn-role-ack');
  if (ackBtn) {
    ackBtn.addEventListener('click', () => {
      ackBtn.style.display = 'none';
      $('#role-waiting').style.display = 'block';
      $('#role-waiting').textContent = 'Waiting for other players...';
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

// ── Phase 5: Day, Voting, Vote Result & Game Over Handlers ──

socket.on('dayReadyProgress', (data) => {
  const bar = $('#day-readiness-bar');
  const fill = $('#day-readiness-fill');
  const text = $('#day-readiness-text');

  if (bar) bar.style.display = 'block';
  if (fill) fill.style.width = `${(data.readyCount / data.totalCount) * 100}%`;
  if (text) {
    text.style.display = 'block';
    if (data.waitingForNames && data.waitingForNames.length > 0) {
      text.textContent = `Waiting for: ${data.waitingForNames.join(', ')}`;
    } else {
      text.textContent = 'All players ready!';
    }
  }
});

socket.on('voteProgress', (data) => {
  state.voteCounts = data.voteCounts || {};
  if ($('#vote-progress-text')) {
    $('#vote-progress-text').textContent = `Votes cast: ${data.votesCast} / ${data.aliveCount}`;
  }
  renderVillageGrid();
});

socket.on('voteReadyProgress', (data) => {
  const bar = $('#vote-readiness-bar');
  const fill = $('#vote-readiness-fill');
  const text = $('#vote-readiness-text');

  if (bar) bar.style.display = 'block';
  if (fill) fill.style.width = `${(data.readyCount / data.totalCount) * 100}%`;
  if (text) {
    text.style.display = 'block';
    if (data.waitingForNames && data.waitingForNames.length > 0) {
      text.textContent = `Waiting for: ${data.waitingForNames.join(', ')}`;
    } else {
      text.textContent = 'All players ready!';
    }
  }
});

function initGameHandlers() {
  const btnReadyVote = $('#btn-ready-vote');
  if (btnReadyVote) {
    btnReadyVote.addEventListener('click', () => {
      btnReadyVote.disabled = true;
      btnReadyVote.textContent = 'Waiting for others...';
      socket.emit('readyToVote');
    });
  }

  const btnForceVote = $('#btn-force-vote');
  if (btnForceVote) {
    btnForceVote.addEventListener('click', () => {
      socket.emit('forceVotePhase');
    });
  }

  const btnSkipVote = $('#btn-skip-vote');
  if (btnSkipVote) {
    btnSkipVote.addEventListener('click', () => {
      state.selectedTarget = null;
      socket.emit('castVote', { targetId: null });
      if ($('#vote-chosen')) {
        $('#vote-chosen').style.display = 'block';
        $('#vote-chosen').textContent = 'You chose to skip your vote.';
      }
      renderVillageGrid();
    });
  }

  const btnReadyNight = $('#btn-ready-night');
  if (btnReadyNight) {
    btnReadyNight.addEventListener('click', () => {
      btnReadyNight.disabled = true;
      btnReadyNight.textContent = 'Waiting for others...';
      socket.emit('readyForNight');
    });
  }

  const btnForceNight = $('#btn-force-night');
  if (btnForceNight) {
    btnForceNight.addEventListener('click', () => {
      socket.emit('forceNightPhase');
    });
  }

  const btnPlayAgain = $('#btn-play-again');
  if (btnPlayAgain) {
    btnPlayAgain.addEventListener('click', () => {
      socket.emit('playAgain');
    });
  }
}

// ── Initialize App ──
document.addEventListener('DOMContentLoaded', () => {
  initWelcomeHandlers();
  initSettingsHandlers();
  initRoleScreenHandlers();
  initGameHandlers();
  showScreen('welcome');
});
