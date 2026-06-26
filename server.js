const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const CATEGORIES = ['nombre','apellido','animal','fruta','pais','ciudad','color','comida','objeto','profesion'];

function broadcastAll(roomCode, data) {
  const room = rooms[roomCode];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(c => { if (c.ws.readyState === 1) c.ws.send(msg); });
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getRoomState(code) {
  const r = rooms[code];
  if (!r) return null;
  return {
    players: Object.fromEntries([...r.clients.entries()].map(([id,c]) => [id, { name: c.name, score: c.score }])),
    phase: r.phase, currentRound: r.currentRound, totalRounds: r.totalRounds,
    timeLimit: r.timeLimit, currentLetter: r.currentLetter, hostId: r.hostId,
    isPublic: r.isPublic, roomName: r.roomName,
  };
}

function getPublicRooms() {
  return Object.entries(rooms)
    .filter(([,r]) => r.isPublic && r.phase === 'lobby')
    .map(([code,r]) => ({
      code, roomName: r.roomName, playerCount: r.clients.size,
      totalRounds: r.totalRounds, timeLimit: r.timeLimit,
      hostName: r.clients.get(r.hostId)?.name || '?',
    }));
}

function broadcastPublicRooms() {
  const list = getPublicRooms();
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && ws._wantsPublic)
      ws.send(JSON.stringify({ type: 'public_rooms', rooms: list }));
  });
}

function calculateResults(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const letter = room.currentLetter;
  const answers = room.answers;
  const roundScores = {};
  room.clients.forEach((_, id) => { roundScores[id] = 0; });

  CATEGORIES.forEach(cat => {
    const valid = {};
    room.clients.forEach((_, id) => {
      const val = (answers[id]?.[cat] || '').trim();
      if (val && val[0].toUpperCase() === letter) valid[id] = val.toLowerCase();
    });
    const counts = {};
    Object.values(valid).forEach(v => { counts[v] = (counts[v]||0)+1; });
    Object.entries(valid).forEach(([id,v]) => { roundScores[id] += counts[v] === 1 ? 10 : 5; });
  });

  room.clients.forEach((c, id) => { c.score = (c.score||0) + (roundScores[id]||0); });

  const scores = {}, players = {};
  room.clients.forEach((c,id) => { scores[id] = c.score; players[id] = { name: c.name, score: c.score }; });
  room.phase = 'results';

  broadcastAll(roomCode, {
    type: 'round_results', letter, round: room.currentRound,
    totalRounds: room.totalRounds, answers, roundScores, scores, players,
    stoppedBy: room.stoppedBy,
  });
}

function autoStop(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'playing') return;
  room.stoppedBy = 'timeout';
  room.phase = 'collecting';
  broadcastAll(roomCode, { type: 'stop_called', stoppedBy: 'timeout', stopperName: 'el tiempo' });
  setTimeout(() => {
    const r = rooms[roomCode];
    if (!r) return;
    r.clients.forEach((_, id) => { if (!r.answers[id]) r.answers[id] = {}; });
    calculateResults(roomCode);
  }, 3000);
}

wss.on('connection', (ws) => {
  let playerId = null, roomCode = null;
  ws._wantsPublic = false;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'watch_public':
        ws._wantsPublic = true;
        sendTo(ws, { type: 'public_rooms', rooms: getPublicRooms() });
        break;

      case 'create_room': {
        const code = Math.random().toString(36).substr(2,6).toUpperCase();
        playerId = msg.playerId; roomCode = code;
        rooms[code] = {
          hostId: playerId, phase: 'lobby',
          clients: new Map([[playerId, { ws, name: msg.name, score: 0 }]]),
          currentRound: 0, totalRounds: 5, timeLimit: 90,
          currentLetter: '', usedLetters: [], answers: {},
          stoppedBy: null, timerTimeout: null,
          isPublic: msg.isPublic !== false,
          roomName: msg.roomName || `Sala de ${msg.name}`,
        };
        sendTo(ws, { type: 'room_created', roomCode: code, playerId });
        sendTo(ws, { type: 'room_state', ...getRoomState(code) });
        broadcastPublicRooms();
        break;
      }

      case 'join_room': {
        const code = msg.roomCode.toUpperCase();
        if (!rooms[code]) { sendTo(ws, { type: 'error', msg: 'Sala no encontrada ❌' }); return; }
        if (rooms[code].phase !== 'lobby') { sendTo(ws, { type: 'error', msg: 'La partida ya comenzó ⛔' }); return; }
        playerId = msg.playerId; roomCode = code;
        rooms[code].clients.set(playerId, { ws, name: msg.name, score: 0 });
        sendTo(ws, { type: 'joined', roomCode: code, playerId });
        broadcastAll(code, { type: 'room_state', ...getRoomState(code) });
        broadcastPublicRooms();
        break;
      }

      case 'set_config': {
        const r = rooms[roomCode];
        if (!r || r.hostId !== playerId) return;
        if (msg.totalRounds) r.totalRounds = msg.totalRounds;
        if (msg.timeLimit) r.timeLimit = msg.timeLimit;
        if (msg.isPublic !== undefined) r.isPublic = msg.isPublic;
        if (msg.roomName) r.roomName = msg.roomName;
        broadcastAll(roomCode, { type: 'room_state', ...getRoomState(roomCode) });
        broadcastPublicRooms();
        break;
      }

      case 'start_game': {
        const r = rooms[roomCode];
        if (!r || r.hostId !== playerId) return;
        const letters = 'ABCDEFGHIJLMNOPRSTV'.split('');
        const avail = letters.filter(l => !r.usedLetters.includes(l));
        const letter = avail[Math.floor(Math.random()*avail.length)];
        r.usedLetters.push(letter); r.currentLetter = letter;
        r.currentRound = 1; r.phase = 'playing';
        r.answers = {}; r.stoppedBy = null;
        const startedAt = Date.now();
        broadcastAll(roomCode, { type: 'round_start', letter, round: 1, totalRounds: r.totalRounds, timeLimit: r.timeLimit, startedAt });
        r.timerTimeout = setTimeout(() => autoStop(roomCode), r.timeLimit * 1000);
        broadcastPublicRooms();
        break;
      }

      case 'call_stop': {
        const r = rooms[roomCode];
        if (!r || r.phase !== 'playing' || r.stoppedBy) return;
        r.stoppedBy = playerId; r.phase = 'collecting';
        clearTimeout(r.timerTimeout);
        broadcastAll(roomCode, { type: 'stop_called', stoppedBy: playerId, stopperName: r.clients.get(playerId)?.name || '?' });
        break;
      }

      case 'submit_answers': {
        const r = rooms[roomCode];
        if (!r) return;
        r.answers[playerId] = msg.answers;
        if ([...r.clients.keys()].every(id => r.answers[id])) calculateResults(roomCode);
        break;
      }

      case 'next_round': {
        const r = rooms[roomCode];
        if (!r || r.hostId !== playerId) return;
        const letters = 'ABCDEFGHIJLMNOPRSTV'.split('');
        const avail = letters.filter(l => !r.usedLetters.includes(l));
        const pool = avail.length ? avail : letters;
        const letter = pool[Math.floor(Math.random()*pool.length)];
        r.usedLetters.push(letter); r.currentLetter = letter;
        r.currentRound += 1; r.phase = 'playing';
        r.answers = {}; r.stoppedBy = null;
        const startedAt = Date.now();
        broadcastAll(roomCode, { type: 'round_start', letter, round: r.currentRound, totalRounds: r.totalRounds, timeLimit: r.timeLimit, startedAt });
        r.timerTimeout = setTimeout(() => autoStop(roomCode), r.timeLimit * 1000);
        break;
      }

      case 'end_game': {
        const r = rooms[roomCode];
        if (!r || r.hostId !== playerId) return;
        r.phase = 'final';
        const scores = {}, players = {};
        r.clients.forEach((c,id) => { scores[id] = c.score; players[id] = { name: c.name, score: c.score }; });
        broadcastAll(roomCode, { type: 'game_over', scores, players });
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
    broadcastPublicRooms();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Tutti Frutti server on port ${PORT}`));
