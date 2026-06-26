const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Store rooms in memory
const rooms = {};

function broadcast(roomCode, data, excludeId = null) {
  const room = rooms[roomCode];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach((client, id) => {
    if (id !== excludeId && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  });
}

function broadcastAll(roomCode, data) {
  broadcast(roomCode, data, null);
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;
  return {
    players: Object.fromEntries(
      [...room.clients.entries()].map(([id, c]) => [id, { name: c.name, score: c.score }])
    ),
    phase: room.phase,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    timeLimit: room.timeLimit,
    currentLetter: room.currentLetter,
    hostId: room.hostId,
  };
}

wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        const code = Math.random().toString(36).substr(2, 6).toUpperCase();
        playerId = msg.playerId;
        roomCode = code;
        rooms[code] = {
          hostId: playerId,
          phase: 'lobby',
          clients: new Map([[playerId, { ws, name: msg.name, score: 0 }]]),
          currentRound: 0,
          totalRounds: 5,
          timeLimit: 90,
          currentLetter: '',
          usedLetters: [],
          answers: {},
          stoppedBy: null,
          timerTimeout: null,
        };
        sendTo(ws, { type: 'room_created', roomCode: code, playerId });
        sendTo(ws, { type: 'room_state', ...getRoomState(code) });
        break;
      }

      case 'join_room': {
        const code = msg.roomCode.toUpperCase();
        if (!rooms[code]) { sendTo(ws, { type: 'error', msg: 'Sala no encontrada' }); return; }
        if (rooms[code].phase !== 'lobby') { sendTo(ws, { type: 'error', msg: 'La partida ya comenzó' }); return; }

        playerId = msg.playerId;
        roomCode = code;
        rooms[code].clients.set(playerId, { ws, name: msg.name, score: 0 });

        sendTo(ws, { type: 'joined', roomCode: code, playerId });
        sendTo(ws, { type: 'room_state', ...getRoomState(code) });
        broadcastAll(code, { type: 'room_state', ...getRoomState(code) });
        break;
      }

      case 'set_config': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;
        if (msg.totalRounds) room.totalRounds = msg.totalRounds;
        if (msg.timeLimit) room.timeLimit = msg.timeLimit;
        broadcastAll(roomCode, { type: 'room_state', ...getRoomState(roomCode) });
        break;
      }

      case 'start_game': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;

        const letters = 'ABCDEFGHIJLMNOPRSTV'.split('');
        const avail = letters.filter(l => !room.usedLetters.includes(l));
        const letter = avail[Math.floor(Math.random() * avail.length)];
        room.usedLetters.push(letter);
        room.currentLetter = letter;
        room.currentRound = 1;
        room.phase = 'playing';
        room.answers = {};
        room.stoppedBy = null;
        const startedAt = Date.now();

        broadcastAll(roomCode, {
          type: 'round_start',
          letter,
          round: room.currentRound,
          totalRounds: room.totalRounds,
          timeLimit: room.timeLimit,
          startedAt,
        });

        // Auto-stop timer
        room.timerTimeout = setTimeout(() => autoStop(roomCode), room.timeLimit * 1000);
        break;
      }

      case 'call_stop': {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'playing') return;
        if (room.stoppedBy) return;
        room.stoppedBy = playerId;
        room.phase = 'collecting';
        clearTimeout(room.timerTimeout);
        const stopperName = room.clients.get(playerId)?.name || '?';
        broadcastAll(roomCode, { type: 'stop_called', stoppedBy: playerId, stopperName });
        break;
      }

      case 'submit_answers': {
        const room = rooms[roomCode];
        if (!room) return;
        room.answers[playerId] = msg.answers;

        // Check if all answered
        const allIds = [...room.clients.keys()];
        const allAnswered = allIds.every(id => room.answers[id]);
        if (allAnswered) {
          calculateResults(roomCode);
        }
        break;
      }

      case 'next_round': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;

        const letters = 'ABCDEFGHIJLMNOPRSTV'.split('');
        const avail = letters.filter(l => !room.usedLetters.includes(l));
        const letter = (avail.length ? avail : letters)[Math.floor(Math.random() * (avail.length || letters.length))];
        room.usedLetters.push(letter);
        room.currentLetter = letter;
        room.currentRound += 1;
        room.phase = 'playing';
        room.answers = {};
        room.stoppedBy = null;
        const startedAt = Date.now();

        broadcastAll(roomCode, {
          type: 'round_start',
          letter,
          round: room.currentRound,
          totalRounds: room.totalRounds,
          timeLimit: room.timeLimit,
          startedAt,
        });

        room.timerTimeout = setTimeout(() => autoStop(roomCode), room.timeLimit * 1000);
        break;
      }

      case 'end_game': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;
        room.phase = 'final';
        const finalScores = {};
        room.clients.forEach((c, id) => { finalScores[id] = c.score; });
        const players = {};
        room.clients.forEach((c, id) => { players[id] = { name: c.name, score: c.score }; });
        broadcastAll(roomCode, { type: 'game_over', scores: finalScores, players });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!roomCode || !rooms[roomCode]) return;
    rooms[roomCode].clients.delete(playerId);
    if (rooms[roomCode].clients.size === 0) {
      clearTimeout(rooms[roomCode].timerTimeout);
      delete rooms[roomCode];
    } else {
      broadcastAll(roomCode, { type: 'room_state', ...getRoomState(roomCode) });
    }
  });
});

function autoStop(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'playing') return;
  room.stoppedBy = 'timeout';
  room.phase = 'collecting';
  broadcastAll(roomCode, { type: 'stop_called', stoppedBy: 'timeout', stopperName: 'el tiempo' });
  // Give 3s for answers to arrive, then force calculate
  setTimeout(() => {
    const room = rooms[roomCode];
    if (!room) return;
    room.clients.forEach((_, id) => {
      if (!room.answers[id]) room.answers[id] = {};
    });
    calculateResults(roomCode);
  }, 3000);
}

function calculateResults(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const CATEGORIES = ['nombre','apellido','animal','fruta','pais','ciudad','color','comida','objeto','profesion'];
  const letter = room.currentLetter;
  const answers = room.answers;
  const roundScores = {};

  room.clients.forEach((_, id) => { roundScores[id] = 0; });

  CATEGORIES.forEach(cat => {
    const validAnswers = {};
    room.clients.forEach((_, id) => {
      const val = (answers[id]?.[cat] || '').trim();
      if (val && val[0].toUpperCase() === letter) {
        validAnswers[id] = val.toLowerCase();
      }
    });

    const counts = {};
    Object.values(validAnswers).forEach(v => { counts[v] = (counts[v] || 0) + 1; });

    Object.entries(validAnswers).forEach(([id, v]) => {
      roundScores[id] += counts[v] === 1 ? 10 : 5;
    });
  });

  // Add to cumulative scores
  room.clients.forEach((client, id) => {
    client.score = (client.score || 0) + (roundScores[id] || 0);
  });

  const scores = {};
  const players = {};
  room.clients.forEach((c, id) => {
    scores[id] = c.score;
    players[id] = { name: c.name, score: c.score };
  });

  room.phase = 'results';

  broadcastAll(roomCode, {
    type: 'round_results',
    letter,
    round: room.currentRound,
    totalRounds: room.totalRounds,
    answers,
    roundScores,
    scores,
    players,
    stoppedBy: room.stoppedBy,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Tutti Frutti server running on port ${PORT}`));
