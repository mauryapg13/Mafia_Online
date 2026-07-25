const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms[code] ? generateRoomCode() : code;
}

function assignRoles(players) {
  const count = players.length;
  let mafiaCount = 1;
  let healerCount = 1;

  if (count >= 7) {
    mafiaCount = 2;
  } else if (count >= 10) {
    mafiaCount = 3;
  }

  const rolePool = [];
  for (let i = 0; i < mafiaCount; i++) rolePool.push('mafia');
  for (let i = 0; i < healerCount; i++) rolePool.push('healer');
  while (rolePool.length < count) rolePool.push('villager');

  // Shuffle roles
  for (let i = rolePool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rolePool[i], rolePool[j]] = [rolePool[j], rolePool[i]];
  }

  players.forEach((p, idx) => {
    p.role = rolePool[idx];
    p.alive = true;
    p.acknowledgedRole = false;
    p.readyToVote = false;
    p.votedFor = null;
    p.nightTarget = null;
  });
}

function checkWinCondition(room) {
  const living = room.players.filter(p => p.alive);
  const mafiaLiving = living.filter(p => p.role === 'mafia');
  const villageLiving = living.filter(p => p.role !== 'mafia');

  if (mafiaLiving.length === 0) {
    return { isOver: true, winner: 'village', reason: 'All Mafia members have been eliminated!' };
  }
  if (mafiaLiving.length >= villageLiving.length) {
    return { isOver: true, winner: 'mafia', reason: 'Mafia has achieved majority control of the village!' };
  }
  return { isOver: false };
}

function getSanitizedRoom(room, socketId = null) {
  const player = room.players.find(p => p.id === socketId);
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      isBot: p.isBot || false,
      alive: p.alive,
      role: (socketId && (p.id === socketId || (player && player.role === 'mafia' && p.role === 'mafia'))) ? p.role : undefined
    }))
  };
}

function broadcastRoomState(room) {
  room.players.forEach(p => {
    if (!p.isBot) {
      io.to(p.id).emit('roomStateUpdate', getSanitizedRoom(room, p.id));
    }
  });
}

function autoProcessBotNightActions(room) {
  const livingBots = room.players.filter(p => p.isBot && p.alive);
  const livingPlayers = room.players.filter(p => p.alive);

  livingBots.forEach(bot => {
    if (bot.role === 'mafia') {
      const targets = livingPlayers.filter(p => p.role !== 'mafia');
      if (targets.length > 0) {
        bot.nightTarget = targets[Math.floor(Math.random() * targets.length)].id;
      }
    } else if (bot.role === 'healer') {
      bot.nightTarget = livingPlayers[Math.floor(Math.random() * livingPlayers.length)].id;
    }
  });

  checkNightCompletion(room);
}

function checkNightCompletion(room) {
  const livingMafia = room.players.filter(p => p.alive && p.role === 'mafia');
  const livingHealer = room.players.filter(p => p.alive && p.role === 'healer');

  const mafiaDone = livingMafia.every(p => p.nightTarget !== null);
  const healerDone = livingHealer.every(p => p.nightTarget !== null);

  if (mafiaDone && healerDone) {
    resolveNightPhase(room);
  }
}

function resolveNightPhase(room) {
  const livingMafia = room.players.filter(p => p.alive && p.role === 'mafia');
  const livingHealer = room.players.filter(p => p.alive && p.role === 'healer');

  // Compute mafia target choice
  const mafiaVotes = {};
  livingMafia.forEach(m => {
    if (m.nightTarget) {
      mafiaVotes[m.nightTarget] = (mafiaVotes[m.nightTarget] || 0) + 1;
    }
  });

  let topMafiaTarget = null;
  let maxVotes = 0;
  Object.keys(mafiaVotes).forEach(tid => {
    if (mafiaVotes[tid] > maxVotes) {
      maxVotes = mafiaVotes[tid];
      topMafiaTarget = tid;
    }
  });

  const healedTarget = (livingHealer.length > 0 && livingHealer[0].nightTarget) ? livingHealer[0].nightTarget : null;

  let killedPlayer = null;
  if (topMafiaTarget && topMafiaTarget !== healedTarget) {
    const targetP = room.players.find(p => p.id === topMafiaTarget);
    if (targetP && targetP.alive) {
      targetP.alive = false;
      killedPlayer = targetP;
    }
  }

  // Clear night targets
  room.players.forEach(p => p.nightTarget = null);

  const winCheck = checkWinCondition(room);
  if (winCheck.isOver) {
    room.phase = 'gameOver';
    room.winner = winCheck.winner;
    room.winReason = winCheck.reason;
    io.to(room.code).emit('gameOver', {
      winner: winCheck.winner,
      reason: winCheck.reason,
      players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }))
    });
    broadcastRoomState(room);
  } else {
    room.phase = 'day';
    io.to(room.code).emit('nightResult', {
      eliminatedPlayer: killedPlayer ? { id: killedPlayer.id, name: killedPlayer.name } : null,
      saved: topMafiaTarget && topMafiaTarget === healedTarget
    });
    broadcastRoomState(room);
  }
}

function autoProcessBotVotes(room) {
  const livingBots = room.players.filter(p => p.isBot && p.alive);
  const livingPlayers = room.players.filter(p => p.alive);

  livingBots.forEach(bot => {
    const validTargets = livingPlayers.filter(p => p.id !== bot.id);
    if (validTargets.length > 0) {
      bot.votedFor = validTargets[Math.floor(Math.random() * validTargets.length)].id;
    }
  });

  checkVoteCompletion(room);
}

function checkVoteCompletion(room) {
  const living = room.players.filter(p => p.alive);
  const allVoted = living.every(p => p.votedFor !== null);

  if (allVoted) {
    resolveVotingPhase(room);
  }
}

function resolveVotingPhase(room) {
  const living = room.players.filter(p => p.alive);

  const tally = {};
  const breakdown = [];

  living.forEach(voter => {
    const target = room.players.find(p => p.id === voter.votedFor);
    if (target) {
      tally[target.id] = (tally[target.id] || 0) + 1;
      breakdown.push({ voterName: voter.name, targetName: target.name });
    }
  });

  let maxVotes = 0;
  let eliminated = null;
  let isTie = false;

  Object.keys(tally).forEach(tid => {
    if (tally[tid] > maxVotes) {
      maxVotes = tally[tid];
      eliminated = room.players.find(p => p.id === tid);
      isTie = false;
    } else if (tally[tid] === maxVotes) {
      isTie = true;
    }
  });

  if (isTie) {
    eliminated = null;
  } else if (eliminated) {
    eliminated.alive = false;
  }

  // Clear vote selections
  room.players.forEach(p => {
    p.votedFor = null;
    p.readyToVote = false;
  });

  const winCheck = checkWinCondition(room);

  room.phase = 'voteResult';
  io.to(room.code).emit('voteResult', {
    eliminatedPlayer: eliminated ? { id: eliminated.id, name: eliminated.name, role: eliminated.role } : null,
    isTie,
    tally,
    breakdown,
    gameOverInfo: winCheck.isOver ? { winner: winCheck.winner, reason: winCheck.reason } : null
  });

  if (winCheck.isOver) {
    room.phase = 'gameOver';
    room.winner = winCheck.winner;
    room.winReason = winCheck.reason;
    setTimeout(() => {
      io.to(room.code).emit('gameOver', {
        winner: winCheck.winner,
        reason: winCheck.reason,
        players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }))
      });
      broadcastRoomState(room);
    }, 3000);
  } else {
    broadcastRoomState(room);
  }
}

// ── Socket Connection Handlers ──
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.on('createRoom', ({ playerName }, callback) => {
    if (!playerName || !playerName.trim()) {
      return callback({ success: false, error: 'Please enter your name.' });
    }
    const code = generateRoomCode();
    const player = { id: socket.id, name: playerName.trim(), isHost: true, isBot: false, alive: true };
    rooms[code] = {
      code,
      hostId: socket.id,
      phase: 'lobby',
      round: 1,
      players: [player]
    };

    socket.join(code);
    socket.roomCode = code;
    callback({ success: true, roomCode: code, player });
    broadcastRoomState(rooms[code]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms[code];

    if (!room) {
      return callback({ success: false, error: 'Room code not found.' });
    }
    if (room.phase !== 'lobby') {
      return callback({ success: false, error: 'Game is already in progress.' });
    }
    if (!playerName || !playerName.trim()) {
      return callback({ success: false, error: 'Please enter your name.' });
    }

    const player = { id: socket.id, name: playerName.trim(), isHost: false, isBot: false, alive: true };
    room.players.push(player);
    socket.join(code);
    socket.roomCode = code;

    callback({ success: true, roomCode: code, player });
    broadcastRoomState(room);
  });

  socket.on('devAddBots', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'lobby') return;

    const botNames = ['Bot Alex', 'Bot Sam', 'Bot Chris', 'Bot Morgan', 'Bot Taylor'];
    let added = 0;

    for (const name of botNames) {
      if (room.players.length >= 8) break;
      if (!room.players.some(p => p.name === name)) {
        room.players.push({
          id: `bot_${Date.now()}_${added}`,
          name,
          isHost: false,
          isBot: true,
          alive: true
        });
        added++;
      }
    }
    broadcastRoomState(room);
  });

  socket.on('devGetGodRoles', (callback) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room) return callback({ success: false });

    callback({
      success: true,
      players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }))
    });
  });

  socket.on('startGame', (callback) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) {
      return callback({ success: false, error: 'Only the host can start the game.' });
    }
    if (room.players.length < 4) {
      return callback({ success: false, error: 'Minimum 4 players required to start!' });
    }

    room.phase = 'roleReveal';
    room.round = 1;
    assignRoles(room.players);

    // Auto-acknowledge bots
    room.players.filter(p => p.isBot).forEach(b => b.acknowledgedRole = true);

    callback({ success: true });
    broadcastRoomState(room);

    // Send individual secret roles to human players
    room.players.forEach(p => {
      if (!p.isBot) {
        const mafiaAllies = p.role === 'mafia' ? room.players.filter(m => m.role === 'mafia' && m.id !== p.id).map(m => ({ id: m.id, name: m.name })) : [];
        io.to(p.id).emit('yourRole', { role: p.role, mafiaAllies });
      }
    });
  });

  socket.on('roleAcknowledged', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'roleReveal') return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.acknowledgedRole = true;

    const ackCount = room.players.filter(p => p.acknowledgedRole).length;
    io.to(code).emit('roleAckProgress', { acknowledgedCount: ackCount, totalCount: room.players.length });

    if (room.players.every(p => p.acknowledgedRole)) {
      room.phase = 'night';
      broadcastRoomState(room);
      autoProcessBotNightActions(room);
    }
  });

  socket.on('submitNightAction', ({ targetId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'night') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;

    player.nightTarget = targetId;

    if (player.role === 'mafia') {
      const mafiaTargetName = room.players.find(p => p.id === targetId)?.name || 'None';
      const mafiaMembers = room.players.filter(p => p.role === 'mafia');
      mafiaMembers.forEach(m => {
        if (!m.isBot) {
          io.to(m.id).emit('mafiaTargetUpdate', { targetId, targetName: mafiaTargetName, chosenBy: player.name });
        }
      });
    }

    checkNightCompletion(room);
  });

  socket.on('readyToVote', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'day') return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.readyToVote = true;

    const living = room.players.filter(p => p.alive);
    const readyCount = living.filter(p => p.readyToVote).length;
    io.to(code).emit('dayReadyProgress', { readyCount, totalCount: living.length });

    if (living.every(p => p.readyToVote)) {
      room.phase = 'vote';
      broadcastRoomState(room);
    } else {
      // Auto-ready bots AFTER human's state is committed (small delay so broadcast arrives first)
      setTimeout(() => {
        if (room.phase !== 'day') return;
        room.players.filter(p => p.isBot && p.alive).forEach(b => b.readyToVote = true);
        const livingNow = room.players.filter(p => p.alive);
        const readyNow = livingNow.filter(p => p.readyToVote).length;
        io.to(code).emit('dayReadyProgress', { readyCount: readyNow, totalCount: livingNow.length });
        if (livingNow.every(p => p.readyToVote)) {
          room.phase = 'vote';
          broadcastRoomState(room);
        }
      }, 400);
    }
  });


  socket.on('forceVotePhase', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'vote';
    broadcastRoomState(room);
  });

  socket.on('castVote', ({ targetId }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.phase !== 'vote') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;

    player.votedFor = targetId;

    const living = room.players.filter(p => p.alive);
    const voteCounts = {};
    living.forEach(p => {
      if (p.votedFor) {
        voteCounts[p.votedFor] = (voteCounts[p.votedFor] || 0) + 1;
      }
    });

    io.to(code).emit('voteCountsUpdate', voteCounts);

    autoProcessBotVotes(room);
  });

  socket.on('nextPhaseAfterResult', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;

    const winCheck = checkWinCondition(room);
    if (winCheck.isOver) {
      room.phase = 'gameOver';
      room.winner = winCheck.winner;
      room.winReason = winCheck.reason;
      io.to(room.code).emit('gameOver', {
        winner: winCheck.winner,
        reason: winCheck.reason,
        players: room.players.map(p => ({ id: p.id, name: p.name, role: p.role, alive: p.alive }))
      });
      broadcastRoomState(room);
    } else {
      room.round++;
      room.phase = 'night';
      broadcastRoomState(room);
      autoProcessBotNightActions(room);
    }
  });

  socket.on('playAgain', () => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.round = 1;
    room.players.forEach(p => {
      p.alive = true;
      p.role = undefined;
      p.acknowledgedRole = false;
      p.readyToVote = false;
      p.votedFor = null;
      p.nightTarget = null;
    });

    io.to(code).emit('gameResetToLobby');
    broadcastRoomState(room);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    const code = socket.roomCode;
    if (code && rooms[code]) {
      const room = rooms[code];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        if (room.hostId === socket.id) {
          const firstHuman = room.players.find(p => !p.isBot);
          room.hostId = firstHuman ? firstHuman.id : room.players[0].id;
        }
        broadcastRoomState(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia Game server running on http://localhost:${PORT}`);
});
