const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room & Game Storage ───────────────────────────────────────────────

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    settings: {
      mafiaCount: 1,
      healerCount: 1,
      discussionTime: 120,
      firstNightKill: true,
      revealRoleOnDeath: true,
      allowHealerSelfHeal: false,
      revealHealerSave: true,
    },
    players: [],       // { id, socketId, name, role, alive, connected }
    phase: 'lobby',    // lobby | roleReveal | night | day | vote | gameOver
    round: 0,
    nightActions: {},  // { mafia: targetId, healer: targetId }
    votes: {},         // { voterId: targetId }
    readyPlayers: new Set(),
    eliminationLog: [],
    lastHealerTarget: null,
    winner: null,
  };
  rooms.set(code, room);
  return room;
}

function findRoomBySocket(socketId) {
  for (const [, room] of rooms) {
    if (room.hostId === socketId) return room;
    if (room.players.some(p => p.socketId === socketId)) return room;
  }
  return null;
}

function getPlayerBySocket(room, socketId) {
  return room.players.find(p => p.socketId === socketId);
}

function getAlivePlayers(room) {
  return room.players.filter(p => p.alive);
}

function getAliveByRole(room, role) {
  return room.players.filter(p => p.alive && p.role === role);
}

// ─── Role Assignment ───────────────────────────────────────────────────

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignRoles(room) {
  const { mafiaCount, healerCount } = room.settings;
  const indices = shuffleArray(room.players.map((_, i) => i));
  let assigned = 0;

  for (let i = 0; i < mafiaCount && assigned < indices.length; i++, assigned++) {
    room.players[indices[assigned]].role = 'mafia';
  }
  for (let i = 0; i < healerCount && assigned < indices.length; i++, assigned++) {
    room.players[indices[assigned]].role = 'healer';
  }
  for (; assigned < indices.length; assigned++) {
    room.players[indices[assigned]].role = 'villager';
  }
}

// ─── Night Resolution ──────────────────────────────────────────────────

function resolveNight(room) {
  const mafiaTarget = room.nightActions.mafia || null;
  const healerTarget = room.nightActions.healer || null;

  let eliminated = null;
  let saved = false;

  if (mafiaTarget) {
    if (mafiaTarget === healerTarget) {
      saved = true;
    } else {
      const target = room.players.find(p => p.id === mafiaTarget);
      if (target && target.alive) {
        target.alive = false;
        eliminated = target;
        room.eliminationLog.push({
          round: room.round,
          phase: 'night',
          playerId: target.id,
          playerName: target.name,
          role: target.role,
        });
      }
    }
  }

  // Track healer target for consecutive-night restriction
  room.lastHealerTarget = healerTarget;

  return { eliminated, saved, mafiaTarget, healerTarget };
}

// ─── Vote Resolution ───────────────────────────────────────────────────

function resolveVotes(room) {
  const tally = {};
  const voters = Object.keys(room.votes);

  for (const voterId of voters) {
    const targetId = room.votes[voterId];
    if (targetId === 'skip') continue;
    tally[targetId] = (tally[targetId] || 0) + 1;
  }

  let maxVotes = 0;
  let maxTargets = [];
  for (const [targetId, count] of Object.entries(tally)) {
    if (count > maxVotes) {
      maxVotes = count;
      maxTargets = [targetId];
    } else if (count === maxVotes) {
      maxTargets.push(targetId);
    }
  }

  // Tie or no votes = no elimination
  if (maxTargets.length !== 1 || maxVotes === 0) {
    return { eliminated: null, tally, tie: maxTargets.length > 1 };
  }

  const target = room.players.find(p => p.id === maxTargets[0]);
  if (target && target.alive) {
    target.alive = false;
    room.eliminationLog.push({
      round: room.round,
      phase: 'day',
      playerId: target.id,
      playerName: target.name,
      role: target.role,
    });
    return { eliminated: target, tally, tie: false };
  }
  return { eliminated: null, tally, tie: false };
}

// ─── Win Condition ─────────────────────────────────────────────────────

function checkWin(room) {
  const alive = getAlivePlayers(room);
  const mafiaAlive = alive.filter(p => p.role === 'mafia').length;
  const villageAlive = alive.filter(p => p.role !== 'mafia').length;

  if (mafiaAlive === 0) return 'village';
  if (mafiaAlive >= villageAlive) return 'mafia';
  return null;
}

// ─── Sanitized Data Helpers ────────────────────────────────────────────

function publicPlayerList(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    connected: p.connected,
  }));
}

function publicPlayerListWithRoles(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    role: p.role,
  }));
}

// ─── Socket.io Events ──────────────────────────────────────────────────

io.on('connection', (socket) => {

  // ── Create Room ──
  socket.on('createRoom', ({ playerName }, callback) => {
    if (!playerName || playerName.trim().length < 1 || playerName.trim().length > 20) {
      return callback({ success: false, error: 'Name must be 1-20 characters.' });
    }

    const room = createRoom(socket.id);
    
    const player = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      socketId: socket.id,
      name: playerName.trim(),
      role: null,
      alive: true,
      connected: true,
    };
    room.players.push(player);
    socket.join(room.code);
    callback({ success: true, roomCode: room.code, playerId: player.id });
  });

  // ── Join Room ──
  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) return callback({ success: false, error: 'Room not found.' });
    if (room.phase !== 'lobby') return callback({ success: false, error: 'Game already in progress.' });
    if (room.players.some(p => p.name.toLowerCase() === playerName.trim().toLowerCase()))
      return callback({ success: false, error: 'Name already taken.' });
    if (playerName.trim().length < 1 || playerName.trim().length > 20)
      return callback({ success: false, error: 'Name must be 1-20 characters.' });

    const player = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      socketId: socket.id,
      name: playerName.trim(),
      role: null,
      alive: true,
      connected: true,
    };

    room.players.push(player);
    socket.join(code);

    callback({ success: true, playerId: player.id, roomCode: code });
    io.to(code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // ── Update Settings (host only) ──
  socket.on('updateSettings', (newSettings) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;

    const s = room.settings;
    if (newSettings.mafiaCount !== undefined) s.mafiaCount = Math.max(1, Math.min(3, Number(newSettings.mafiaCount)));
    if (newSettings.healerCount !== undefined) s.healerCount = Math.max(0, Math.min(2, Number(newSettings.healerCount)));
    if (newSettings.discussionTime !== undefined) s.discussionTime = Math.max(30, Math.min(300, Number(newSettings.discussionTime)));
    if (newSettings.firstNightKill !== undefined) s.firstNightKill = Boolean(newSettings.firstNightKill);
    if (newSettings.revealRoleOnDeath !== undefined) s.revealRoleOnDeath = Boolean(newSettings.revealRoleOnDeath);
    if (newSettings.allowHealerSelfHeal !== undefined) s.allowHealerSelfHeal = Boolean(newSettings.allowHealerSelfHeal);
    if (newSettings.revealHealerSave !== undefined) s.revealHealerSave = Boolean(newSettings.revealHealerSave);

    io.to(room.code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // ── Start Game (host only) ──
  socket.on('startGame', (callback) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return callback({ success: false, error: 'Not the host.' });
    if (room.phase !== 'lobby') return callback({ success: false, error: 'Game already started.' });

    const minPlayers = 4;
    if (room.players.length < minPlayers)
      return callback({ success: false, error: `Need at least ${minPlayers} players.` });

    const { mafiaCount, healerCount } = room.settings;
    if (mafiaCount + healerCount >= room.players.length)
      return callback({ success: false, error: 'Too many special roles for the number of players.' });

    assignRoles(room);
    room.phase = 'roleReveal';

    // Send each player their role privately
    for (const player of room.players) {
      const sock = io.sockets.sockets.get(player.socketId);
      if (sock) {
        sock.emit('roleAssigned', {
          playerId: player.id,
          role: player.role,
          // Mafia members see each other
          mafiaMembers: player.role === 'mafia'
            ? room.players.filter(p => p.role === 'mafia' && p.id !== player.id).map(p => ({ id: p.id, name: p.name }))
            : [],
        });
      }
    }

    // Tell host too
    io.to(room.code).emit('phaseChange', {
      phase: 'roleReveal',
      players: publicPlayerList(room),
    });

    callback({ success: true });
  });

  // ── Role Acknowledged ──
  socket.on('roleAcknowledged', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'roleReveal') return;

    const player = getPlayerBySocket(room, socket.id);
    if (player) player._roleAcked = true;

    // Check if all players have acknowledged
    const allAcked = room.players.every(p => p._roleAcked);
    if (allAcked) {
      startNight(room);
    }
  });

  // ── Night Action ──
  socket.on('nightAction', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'night') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;

    if (player.role === 'mafia') {
      // Validate target is alive and not mafia
      const target = room.players.find(p => p.id === targetId && p.alive && p.role !== 'mafia');
      if (!target) return;
      room.nightActions.mafia = targetId;

      // Notify other mafia about the selection
      const mafiaPlayers = getAliveByRole(room, 'mafia');
      for (const m of mafiaPlayers) {
        const sock = io.sockets.sockets.get(m.socketId);
        if (sock) sock.emit('mafiaSelection', { selectedBy: player.name, targetId });
      }
    }

    if (player.role === 'healer') {
      // Validate target is alive
      const target = room.players.find(p => p.id === targetId && p.alive);
      if (!target) return;

      // Check self-heal restriction
      if (targetId === player.id && !room.settings.allowHealerSelfHeal) return;

      // Check consecutive-night restriction
      if (targetId === room.lastHealerTarget) return;

      room.nightActions.healer = targetId;
    }

    // Check if all night actions are in
    checkNightComplete(room);
  });

  // ── Day Vote ──
  socket.on('castVote', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'vote') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;

    // Validate target (or 'skip')
    if (targetId !== 'skip') {
      const target = room.players.find(p => p.id === targetId && p.alive && p.id !== player.id);
      if (!target) return;
    }

    room.votes[player.id] = targetId;

    // Broadcast vote tally dynamically
    io.to(room.code).emit('voteProgress', { 
      votes: room.votes, 
      voteCount: voteCount, 
      totalVoters: aliveCount 
    });

    // All votes in?
    if (voteCount >= aliveCount) {
      resolveVotePhase(room);
    }
  });

  // ── Readiness Check ──
  socket.on('playerReady', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    
    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;
    
    room.readyPlayers.add(player.id);
    
    const alivePlayers = getAlivePlayers(room);
    const readyCount = room.readyPlayers.size;
    const totalAlive = alivePlayers.length;
    
    // Find who is not ready
    const waitingFor = alivePlayers.filter(p => !room.readyPlayers.has(p.id)).map(p => p.name);
    
    io.to(room.code).emit('readinessProgress', {
      readyCount,
      totalCount: totalAlive,
      waitingFor
    });
    
    if (readyCount >= totalAlive) {
      // All ready, transition based on current phase
      if (room.phase === 'day') {
        startVotePhase(room);
      } else if (room.phase === 'voteResult' || room.phase === 'dayResult') {
        startNight(room);
      }
    }
  });

  // ── Host: Force Start Vote Phase ──
  socket.on('startVote', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'day') return;
    startVotePhase(room);
  });

  // ── Host: Force Proceed to Next Night ──
  socket.on('proceedToNight', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'day' && room.phase !== 'dayResult' && room.phase !== 'voteResult') return;
    startNight(room);
  });

  // ── Kick Player (host, lobby only) ──
  socket.on('kickPlayer', ({ playerId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;

    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) return;

    const kicked = room.players.splice(idx, 1)[0];
    const kickedSocket = io.sockets.sockets.get(kicked.socketId);
    if (kickedSocket) {
      kickedSocket.emit('kicked');
      kickedSocket.leave(room.code);
    }

    io.to(room.code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // ── Play Again ──
  socket.on('playAgain', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;

    // Reset game state but keep players
    room.phase = 'lobby';
    room.round = 0;
    room.nightActions = {};
    room.votes = {};
    room.eliminationLog = [];
    room.lastHealerTarget = null;
    room.winner = null;
    room.readyPlayers.clear();
    for (const p of room.players) {
      p.role = null;
      p.alive = true;
      p._roleAcked = false;
    }

    io.to(room.code).emit('phaseChange', { phase: 'lobby' });
    io.to(room.code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const player = getPlayerBySocket(room, socket.id);
    if (player) {
      player.connected = false;
      io.to(room.code).emit('playerDisconnected', { playerId: player.id, playerName: player.name });
    }

    // If lobby, remove the player
    if (room.phase === 'lobby' && player) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      io.to(room.code).emit('lobbyUpdate', {
        players: publicPlayerList(room),
        settings: room.settings,
      });
    }

    // Clean up empty rooms
    if (room.players.length === 0 && room.hostId === socket.id) {
      rooms.delete(room.code);
    }
  });
});

// ─── Phase Transition Helpers ──────────────────────────────────────────

function startNight(room) {
  room.round++;
  room.phase = 'night';
  room.nightActions = {};
  room.readyPlayers.clear();

  const alivePlayers = publicPlayerList(room);

  // Send night prompts
  for (const player of room.players) {
    if (!player.alive) continue;
    const sock = io.sockets.sockets.get(player.socketId);
    if (!sock) continue;

    if (player.role === 'mafia') {
      const targets = room.players.filter(p => p.alive && p.role !== 'mafia').map(p => ({ id: p.id, name: p.name }));
      // On first night, check firstNightKill setting
      if (room.round === 1 && !room.settings.firstNightKill) {
        sock.emit('nightPrompt', { role: 'mafia', targets: [], skipNight: true, round: room.round });
      } else {
        sock.emit('nightPrompt', { role: 'mafia', targets, skipNight: false, round: room.round });
      }
    } else if (player.role === 'healer') {
      let targets = room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name }));
      // Filter out self if not allowed
      if (!room.settings.allowHealerSelfHeal) {
        targets = targets.filter(t => t.id !== player.id);
      }
      // Filter out last healer target (consecutive restriction)
      if (room.lastHealerTarget) {
        targets = targets.filter(t => t.id !== room.lastHealerTarget);
      }
      sock.emit('nightPrompt', { role: 'healer', targets, skipNight: false, round: room.round });
    } else {
      sock.emit('nightPrompt', { role: 'villager', targets: [], skipNight: false, round: room.round });
    }
  }

  io.to(room.code).emit('phaseChange', {
    phase: 'night',
    round: room.round,
    players: alivePlayers,
  });
}

function startVotePhase(room) {
  room.phase = 'vote';
  room.votes = {};
  room.readyPlayers.clear();
  io.to(room.code).emit('phaseChange', {
    phase: 'vote',
    players: publicPlayerList(room),
  });
}

function checkNightComplete(room) {
  const aliveMafia = getAliveByRole(room, 'mafia');
  const aliveHealers = getAliveByRole(room, 'healer');

  const mafiaActed = room.nightActions.mafia !== undefined ||
    (room.round === 1 && !room.settings.firstNightKill);
  const healerActed = room.nightActions.healer !== undefined || aliveHealers.length === 0;

  if (mafiaActed && healerActed) {
    // Small delay for dramatic effect
    setTimeout(() => {
      const result = resolveNight(room);
      room.phase = 'day';

      const savedPlayer = result.saved ? room.players.find(p => p.id === result.healerTarget) : null;

      const dayData = {
        phase: 'day',
        round: room.round,
        players: publicPlayerList(room),
        nightResult: {
          eliminated: result.eliminated ? {
            id: result.eliminated.id,
            name: result.eliminated.name,
            role: room.settings.revealRoleOnDeath ? result.eliminated.role : null,
          } : null,
          saved: result.saved,
          savedName: (result.saved && room.settings.revealHealerSave && savedPlayer) ? savedPlayer.name : null,
          firstNightSkipped: room.round === 1 && !room.settings.firstNightKill,
        },
        discussionTime: room.settings.discussionTime,
      };

      // Check win after night
      const winner = checkWin(room);
      if (winner) {
        room.winner = winner;
        room.phase = 'gameOver';
        io.to(room.code).emit('phaseChange', {
          phase: 'gameOver',
          winner,
          players: publicPlayerListWithRoles(room),
          eliminationLog: room.eliminationLog,
        });
      } else {
        room.readyPlayers.clear();
        io.to(room.code).emit('phaseChange', dayData);
      }
    }, 1500);
  }
}

function resolveVotePhase(room) {
  const result = resolveVotes(room);
  room.phase = 'dayResult';

  const resultData = {
    eliminated: result.eliminated ? {
      id: result.eliminated.id,
      name: result.eliminated.name,
      role: room.settings.revealRoleOnDeath ? result.eliminated.role : null,
    } : null,
    tally: result.tally,
    tie: result.tie,
  };

  // Check win after vote
  const winner = checkWin(room);
  if (winner) {
    room.winner = winner;
    room.phase = 'gameOver';
    io.to(room.code).emit('voteResult', resultData);
    setTimeout(() => {
      io.to(room.code).emit('phaseChange', {
        phase: 'gameOver',
        winner,
        players: publicPlayerListWithRoles(room),
        eliminationLog: room.eliminationLog,
      });
    }, 3000);
  } else {
    room.phase = 'voteResult';
    room.readyPlayers.clear();
    io.to(room.code).emit('voteResult', resultData);
  }
}

// ─── Start Server ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia Game server running on http://localhost:${PORT}`);
});
