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
    players: [],       // Array of { id, socketId, name, role, alive, connected }
    phase: 'lobby',    // lobby | roleReveal | night | day | vote | voteResult | gameOver
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

function publicPlayerList(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    connected: p.connected,
    role: (p.role && (!p.alive && room.settings.revealRoleOnDeath)) ? p.role : null,
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

function safeCb(cb, result) {
  if (typeof cb === 'function') cb(result);
}

function assignRoles(room) {
  const count = room.players.length;
  let { mafiaCount, healerCount } = room.settings;

  // Clamp role counts
  mafiaCount = Math.min(mafiaCount, Math.floor(count / 2));
  healerCount = Math.min(healerCount, Math.max(0, count - mafiaCount - 1));

  const rolePool = [];
  for (let i = 0; i < mafiaCount; i++) rolePool.push('mafia');
  for (let i = 0; i < healerCount; i++) rolePool.push('healer');
  while (rolePool.length < count) rolePool.push('villager');

  // Shuffle Fisher-Yates
  for (let i = rolePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
  }

  room.players.forEach((p, idx) => {
    p.role = rolePool[idx];
    p.alive = true;
  });
}

function startNightPhase(room) {
  room.phase = 'night';
  room.round++;
  room.nightActions = {};

  // Check first night kill setting
  if (room.round === 1 && room.settings.firstNightKill === false) {
    // Skip night actions on Night 1 if disabled
    setTimeout(() => {
      startDayPhase(room, { firstNightSkipped: true });
    }, 2000);

    io.to(room.code).emit('phaseChange', {
      phase: 'night',
      round: room.round,
      players: publicPlayerList(room),
      firstNightSkipped: true,
    });
    return;
  }

  io.to(room.code).emit('phaseChange', {
    phase: 'night',
    round: room.round,
    players: publicPlayerList(room),
  });
}

function checkNightComplete(room) {
  const aliveMafia = getAliveByRole(room, 'mafia');
  const aliveHealer = getAliveByRole(room, 'healer');

  const mafiaDone = aliveMafia.length === 0 || room.nightActions.mafia !== undefined;
  const healerDone = aliveHealer.length === 0 || room.nightActions.healer !== undefined;

  if (mafiaDone && healerDone) {
    resolveNight(room);
  }
}

function resolveNight(room) {
  const mafiaTargetId = room.nightActions.mafia;
  const healerTargetId = room.nightActions.healer;

  let killedPlayer = null;
  let savedByHealer = false;

  if (mafiaTargetId) {
    if (mafiaTargetId === healerTargetId) {
      savedByHealer = true;
    } else {
      const target = room.players.find(p => p.id === mafiaTargetId && p.alive);
      if (target) {
        target.alive = false;
        killedPlayer = target;
      }
    }
  }

  const winResult = checkWinCondition(room);
  if (winResult) {
    startGameOverPhase(room, winResult, {
      nightResult: {
        eliminatedPlayer: killedPlayer ? { id: killedPlayer.id, name: killedPlayer.name, role: killedPlayer.role } : null,
        savedByHealer: savedByHealer && room.settings.revealHealerSave,
      }
    });
    return;
  }

  startDayPhase(room, {
    eliminatedPlayer: killedPlayer ? { id: killedPlayer.id, name: killedPlayer.name, role: killedPlayer.role } : null,
    savedByHealer: savedByHealer && room.settings.revealHealerSave,
  });
}

function startDayPhase(room, nightResult = {}) {
  room.phase = 'day';
  room.readyPlayers = new Set();
  room.votes = {};

  io.to(room.code).emit('phaseChange', {
    phase: 'day',
    round: room.round,
    players: publicPlayerList(room),
    nightResult,
    discussionTime: room.settings.discussionTime,
  });
}

function startVotePhase(room) {
  const winResult = checkWinCondition(room);
  if (winResult) {
    startGameOverPhase(room, winResult);
    return;
  }

  room.phase = 'vote';
  room.votes = {};

  io.to(room.code).emit('phaseChange', {
    phase: 'vote',
    round: room.round,
    players: publicPlayerList(room),
  });
}

function checkVoteComplete(room) {
  const aliveCount = getAlivePlayers(room).length;
  const votesCast = Object.keys(room.votes).length;

  // Broadcast live vote progress to all clients
  const voteCounts = {};
  Object.values(room.votes).forEach(targetId => {
    if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  io.to(room.code).emit('voteProgress', {
    votesCast,
    aliveCount,
    voteCounts,
  });

  if (votesCast >= aliveCount) {
    resolveVote(room);
  }
}

function resolveVote(room) {
  const voteCounts = {};
  let totalVotes = 0;

  Object.values(room.votes).forEach(targetId => {
    if (targetId) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      totalVotes++;
    }
  });

  let maxVotes = 0;
  let topTargetId = null;
  let isTie = false;

  for (const [targetId, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) {
      maxVotes = count;
      topTargetId = targetId;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  }

  let eliminatedPlayer = null;
  if (!isTie && topTargetId && maxVotes > 0) {
    const target = room.players.find(p => p.id === topTargetId && p.alive);
    if (target) {
      target.alive = false;
      eliminatedPlayer = target;
    }
  }

  const voteDetail = [];
  room.players.filter(p => p.alive || p === eliminatedPlayer).forEach(voter => {
    const targetId = room.votes[voter.id];
    const target = room.players.find(p => p.id === targetId);
    voteDetail.push({
      voterName: voter.name,
      targetName: target ? target.name : 'Skipped',
    });
  });

  const winResult = checkWinCondition(room);
  if (winResult) {
    startGameOverPhase(room, winResult, { eliminatedPlayer, isTie, voteDetail, voteCounts });
  } else {
    startVoteResultPhase(room, { eliminatedPlayer, isTie, voteDetail, voteCounts });
  }
}

function checkWinCondition(room) {
  const aliveMafia = getAliveByRole(room, 'mafia').length;
  const aliveVillage = getAlivePlayers(room).filter(p => p.role !== 'mafia').length;

  if (aliveMafia === 0) return 'village';
  if (aliveMafia >= aliveVillage) return 'mafia';
  return null;
}

function startVoteResultPhase(room, resultData) {
  room.phase = 'voteResult';
  room.readyPlayers = new Set();

  io.to(room.code).emit('phaseChange', {
    phase: 'voteResult',
    round: room.round,
    players: publicPlayerList(room),
    voteResult: {
      eliminatedPlayer: resultData.eliminatedPlayer ? {
        id: resultData.eliminatedPlayer.id,
        name: resultData.eliminatedPlayer.name,
        role: room.settings.revealRoleOnDeath ? resultData.eliminatedPlayer.role : null,
      } : null,
      isTie: resultData.isTie,
      voteDetail: resultData.voteDetail,
    },
  });
}

function startGameOverPhase(room, winner, gameSummary = {}) {
  room.phase = 'gameOver';
  room.winner = winner;

  io.to(room.code).emit('phaseChange', {
    phase: 'gameOver',
    winner,
    players: publicPlayerListWithRoles(room),
    gameSummary,
  });
}

// ─── Socket.io Events ──────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Create Room
  socket.on('createRoom', ({ playerName }, callback) => {
    const name = (playerName || '').trim();
    if (!name || name.length < 1 || name.length > 20) {
      return safeCb(callback, { success: false, error: 'Name must be 1-20 characters.' });
    }

    const room = createRoom(socket.id);
    const player = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      socketId: socket.id,
      name,
      role: null,
      alive: true,
      connected: true,
    };
    room.players.push(player);
    socket.join(room.code);

    safeCb(callback, { success: true, roomCode: room.code, playerId: player.id, isHost: true });
    io.to(room.code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // Join Room
  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) return safeCb(callback, { success: false, error: 'Room not found.' });

    const name = (playerName || '').trim();
    let player = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());

    if (player) {
      // Player reconnecting
      player.socketId = socket.id;
      player.connected = true;
      socket.join(code);

      if (room.players.length > 0 && room.players[0].id === player.id) {
        room.hostId = socket.id;
      }

      safeCb(callback, { success: true, playerId: player.id, roomCode: code, isHost: room.hostId === socket.id });
      io.to(code).emit('lobbyUpdate', {
        players: publicPlayerList(room),
        settings: room.settings,
      });
      return;
    }

    if (room.phase !== 'lobby') return safeCb(callback, { success: false, error: 'Game already in progress.' });
    if (!name || name.length < 1 || name.length > 20)
      return safeCb(callback, { success: false, error: 'Name must be 1-20 characters.' });

    player = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      socketId: socket.id,
      name,
      role: null,
      alive: true,
      connected: true,
    };

    room.players.push(player);
    socket.join(code);

    safeCb(callback, { success: true, playerId: player.id, roomCode: code, isHost: room.hostId === socket.id });
    io.to(code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // Update Settings (host only)
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

  // Kick Player (host only)
  socket.on('kickPlayer', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;

    const target = room.players.find(p => p.id === targetId);
    if (target && target.socketId !== socket.id) {
      io.to(target.socketId).emit('kicked');
      room.players = room.players.filter(p => p.id !== targetId);
      io.to(room.code).emit('lobbyUpdate', {
        players: publicPlayerList(room),
        settings: room.settings,
      });
    }
  });

  // Start Game (host only)
  socket.on('startGame', (callback) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return safeCb(callback, { success: false, error: 'Not the host.' });
    if (room.phase !== 'lobby') return safeCb(callback, { success: false, error: 'Game already started.' });

    const minPlayers = 4;
    if (room.players.length < minPlayers)
      return safeCb(callback, { success: false, error: `Need at least ${minPlayers} players.` });

    assignRoles(room);
    room.phase = 'roleReveal';
    room.readyPlayers = new Set();

    // Send private role payload to each player
    for (const player of room.players) {
      io.to(player.socketId).emit('roleAssigned', {
        playerId: player.id,
        role: player.role,
        mafiaMembers: player.role === 'mafia'
          ? room.players.filter(p => p.role === 'mafia' && p.id !== player.id).map(p => ({ id: p.id, name: p.name }))
          : [],
      });
    }

    io.to(room.code).emit('phaseChange', {
      phase: 'roleReveal',
      players: publicPlayerList(room),
    });

    safeCb(callback, { success: true });
  });

  // Role Acknowledged
  socket.on('roleAcknowledged', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'roleReveal') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player) return;

    room.readyPlayers.add(player.id);
    const ackCount = room.readyPlayers.size;
    const totalCount = room.players.length;

    io.to(room.code).emit('roleAckProgress', { acknowledgedCount: ackCount, totalCount });

    if (ackCount >= totalCount) {
      startNightPhase(room);
    }
  });

  // Night Action (Mafia target / Healer target)
  socket.on('nightAction', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'night') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;

    const target = room.players.find(p => p.id === targetId && p.alive);
    if (!target) return;

    if (player.role === 'mafia') {
      room.nightActions.mafia = targetId;
      // Broadcast live sync to all mafia members
      room.players.filter(p => p.role === 'mafia').forEach(m => {
        io.to(m.socketId).emit('mafiaTargetSync', { targetId, targetName: target.name });
      });
      checkNightComplete(room);
    } else if (player.role === 'healer') {
      if (!room.settings.allowHealerSelfHeal && targetId === player.id) return;
      room.nightActions.healer = targetId;
      checkNightComplete(room);
    }
  });

  // Ready To Vote (Day phase)
  socket.on('readyToVote', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'day') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;

    room.readyPlayers.add(player.id);
    const alivePlayers = getAlivePlayers(room);
    const readyCount = room.readyPlayers.size;
    const totalCount = alivePlayers.length;

    const waitingNames = alivePlayers.filter(p => !room.readyPlayers.has(p.id)).map(p => p.name);

    io.to(room.code).emit('dayReadyProgress', {
      readyCount,
      totalCount,
      waitingForNames: waitingNames,
    });

    if (readyCount >= totalCount) {
      startVotePhase(room);
    }
  });

  // Force Vote Phase (Host only)
  socket.on('forceVotePhase', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'day') return;
    startVotePhase(room);
  });

  // Cast Vote
  socket.on('castVote', ({ targetId }) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'vote') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;

    // targetId can be null for skip vote, or a valid alive player ID
    if (targetId) {
      const target = room.players.find(p => p.id === targetId && p.alive);
      if (!target || target.id === player.id) return; // Cannot vote for self
    }

    room.votes[player.id] = targetId || null;
    checkVoteComplete(room);
  });

  // Ready For Night (Vote Result phase)
  socket.on('readyForNight', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== 'voteResult') return;

    const player = getPlayerBySocket(room, socket.id);
    if (!player || !player.alive) return;

    room.readyPlayers.add(player.id);
    const alivePlayers = getAlivePlayers(room);
    const readyCount = room.readyPlayers.size;
    const totalCount = alivePlayers.length;

    const waitingNames = alivePlayers.filter(p => !room.readyPlayers.has(p.id)).map(p => p.name);

    io.to(room.code).emit('voteReadyProgress', {
      readyCount,
      totalCount,
      waitingForNames: waitingNames,
    });

    if (readyCount >= totalCount) {
      startNightPhase(room);
    }
  });

  // Force Night Phase (Host only)
  socket.on('forceNightPhase', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id || room.phase !== 'voteResult') return;
    startNightPhase(room);
  });

  // Play Again (Host reset)
  socket.on('playAgain', () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.round = 0;
    room.winner = null;
    room.nightActions = {};
    room.votes = {};
    room.readyPlayers = new Set();
    room.players.forEach(p => {
      p.role = null;
      p.alive = true;
    });

    io.to(room.code).emit('phaseChange', {
      phase: 'lobby',
    });
    io.to(room.code).emit('lobbyUpdate', {
      players: publicPlayerList(room),
      settings: room.settings,
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const player = getPlayerBySocket(room, socket.id);
    if (player) {
      player.connected = false;
      io.to(room.code).emit('playerDisconnected', { playerId: player.id, playerName: player.name });
    }

    if (room.phase === 'lobby' && player) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      io.to(room.code).emit('lobbyUpdate', {
        players: publicPlayerList(room),
        settings: room.settings,
      });
    }

    if (room.players.length === 0) {
      rooms.delete(room.code);
    }
  });
});

// ─── Start Server ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia Game server running on http://localhost:${PORT}`);
});
