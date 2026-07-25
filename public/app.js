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

function getCharacterAvatarSvg(role, alive = true, name = '') {
  if (!alive) {
    // Rich Ghost / Tombstone Avatar
    return `
      <svg class="avatar-svg dead-ghost-svg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="30" fill="#141522" stroke="#473472" stroke-width="2"/>
        <ellipse cx="32" cy="12" rx="10" ry="3" stroke="#FFD400" stroke-width="2.5" fill="none"/>
        <path d="M20 48C18 36 18 22 32 22C46 22 46 36 44 48C42 50 40 46 37 49C34 52 32 46 29 49C26 52 24 46 20 48Z" fill="#D6F4ED" opacity="0.85"/>
        <path d="M24 29L28 33M28 29L24 33" stroke="#473472" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M36 29L40 33M40 29L36 33" stroke="#473472" stroke-width="2.5" stroke-linecap="round"/>
        <ellipse cx="32" cy="38" rx="3" ry="4" fill="#473472"/>
      </svg>`;
  }

  if (role === 'mafia') {
    // Rich Mafia Detective Avatar
    return `
      <svg class="avatar-svg mafia-avatar-svg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="30" fill="#20132B" stroke="#473472" stroke-width="2"/>
        <path d="M16 54L26 42H38L48 54V60H16V54Z" fill="#111320"/>
        <path d="M28 42L32 50L36 42H28Z" fill="#FF0052"/>
        <ellipse cx="32" cy="36" rx="14" ry="16" fill="#F4D3C2"/>
        <path d="M18 28C18 28 25 31 32 31C39 31 46 28 46 28V33C46 33 39 36 32 36C25 36 18 33 18 33V28Z" fill="rgba(0,0,0,0.15)"/>
        <path d="M19 32H29V37C29 39.2 27.2 41 25 41H23C20.8 41 19 39.2 19 37V32Z" fill="#111320"/>
        <path d="M35 32H45V37C45 39.2 43.2 41 41 41H39C36.8 41 35 39.2 35 37V32Z" fill="#111320"/>
        <line x1="29" y1="34" x2="35" y2="34" stroke="#111320" stroke-width="3"/>
        <path d="M21 34L26 34" stroke="#FFF" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
        <path d="M37 34L42 34" stroke="#FFF" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
        <path d="M28 46C30 47.5 34 47.5 36 46" stroke="#473472" stroke-width="2" stroke-linecap="round"/>
        <path d="M8 27C8 27 18 24 32 24C46 24 56 27 56 27C58 27 59 29 57 30.5C54.5 32 46 33 32 33C18 33 9.5 32 7 30.5C5 29 6 27 8 27Z" fill="#161824"/>
        <path d="M20 25L23 9C23 9 26 6 32 6C38 6 41 9 41 9L44 25H20Z" fill="#161824"/>
        <path d="M20 22H44V25H20V22Z" fill="#FF0052"/>
      </svg>`;
  }

  if (role === 'healer') {
    // Rich Medical Healer Avatar
    return `
      <svg class="avatar-svg healer-avatar-svg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="30" fill="#112C28" stroke="#00C68D" stroke-width="2"/>
        <path d="M14 54L24 40H40L50 54V60H14V54Z" fill="#00C68D"/>
        <path d="M27 40L32 46L37 40" stroke="#D6F4ED" stroke-width="3"/>
        <path d="M20 42C20 48 44 48 44 42" stroke="#87BAC3" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="32" cy="34" rx="14" ry="15" fill="#F4D3C2"/>
        <path d="M18 26C18 18 24 14 32 14C40 14 46 18 46 26V28H18V26Z" fill="#FFFFFF"/>
        <rect x="28" y="17" width="8" height="8" rx="2" fill="#00C68D"/>
        <path d="M32 19V23M30 21H34" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>
        <circle cx="26" cy="33" r="2" fill="#112C28"/>
        <circle cx="38" cy="33" r="2" fill="#112C28"/>
        <path d="M27 39C29 41.5 35 41.5 37 39" stroke="#112C28" stroke-width="2" stroke-linecap="round"/>
        <circle cx="23" cy="36" r="2" fill="#FF8B9A" opacity="0.5"/>
        <circle cx="41" cy="36" r="2" fill="#FF8B9A" opacity="0.5"/>
      </svg>`;
  }

  // Rich Villager Avatar
  return `
    <svg class="avatar-svg villager-avatar-svg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="30" fill="#1A243D" stroke="#53629E" stroke-width="2"/>
      <path d="M14 54L24 40H40L50 54V60H14V54Z" fill="#53629E"/>
      <path d="M28 40L32 45L36 40" fill="#87BAC3"/>
      <ellipse cx="32" cy="34" rx="14" ry="15" fill="#FCE0D4"/>
      <path d="M16 28C16 18 23 11 32 11C41 11 48 18 48 28H16Z" fill="#87BAC3"/>
      <rect x="14" y="25" width="36" height="5" rx="2.5" fill="#53629E"/>
      <circle cx="32" cy="9" r="4" fill="#53629E"/>
      <circle cx="26" cy="33" r="2.5" fill="#1A243D"/>
      <circle cx="38" cy="33" r="2.5" fill="#1A243D"/>
      <path d="M26 39C29 42 35 42 38 39" stroke="#1A243D" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M23 29C25 28 28 29 28 29" stroke="#1A243D" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M36 29C36 29 39 28 41 29" stroke="#1A243D" stroke-width="1.5" stroke-linecap="round"/>
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
