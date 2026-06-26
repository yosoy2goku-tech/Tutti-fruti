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
const CATEGORY_NAMES = {
  nombre:'Nombre de persona', apellido:'Apellido', animal:'Animal',
  fruta:'Fruta o verdura', pais:'País', ciudad:'Ciudad', color:'Color',
  comida:'Comida o plato', objeto:'Objeto', profesion:'Profesión u oficio',
};

// ─── GROQ ────────────────────────────────────────
async function validateWithGroq(answers, letter) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    const result = {};
    CATEGORIES.forEach(cat => {
      const val = answers[cat]?.trim() || '';
      result[cat] = val !== '' && val[0]?.toUpperCase() === letter;
    });
    return result;
  }

  const lines = CATEGORIES
    .filter(cat => answers[cat]?.trim())
    .map(cat => `- ${CATEGORY_NAMES[cat]}: "${answers[cat].trim()}"`)
    .join('\n');

  if (!lines) {
    const result = {};
    CATEGORIES.forEach(cat => { result[cat] = false; });
    return result;
  }

  const prompt = `Eres árbitro del juego Tutti Frutti en español. Letra de la ronda: "${letter}"

Respuestas del jugador:
${lines}

REGLAS para marcar como true (válido):
1. La palabra debe empezar con la letra "${letter}". Las tildes NO importan (letra A acepta Ángel, Águila; letra E acepta Élite).
2. Debe pertenecer a la categoría. Sé GENEROSO: acepta nombres comunes, apellidos, animales, frutas, países, ciudades, colores, comidas, objetos y profesiones conocidas.
3. En caso de duda, marca true. Solo marca false si claramente NO empieza con "${letter}" o no tiene nada que ver con la categoría.

Responde SOLO con JSON sin texto extra: {"nombre":true,"apellido":false,...}
Incluye exactamente estas claves: ${CATEGORIES.join(',')}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3-8b-8192', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 200 }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Groq error:', e.message);
    const result = {};
    CATEGORIES.forEach(cat => {
      const val = answers[cat]?.trim() || '';
      result[cat] = val !== '' && val[0]?.toUpperCase() === letter;
    });
    return result;
  }
}

// ─── HELPERS ─────────────────────────────────────
function broadcastAll(roomCode, data) {
  const room = rooms[roomCode];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => { if (client.ws.readyState === 1) client.ws.send(msg); });
}

function sendTo(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;
  return {
    players: Object.fromEntries([...room.clients.entries()].map(([id, c]) => [id, { name: c.name, score: c.score }])),
    phase: room.phase,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    timeLimit: room.timeLimit,
    currentLetter: room.currentLetter,
    hostId: room.hostId,
    isPublic: room.isPublic,
    roomName: room.roomName,
  };
}

function getPublicRooms() {
  return Object.entries(rooms)
    .filter(([, r]) => r.isPublic && r.phase === 'lobby')
    .map(([code, r]) => ({
      code,
      roomName: r.roomName,
      playerCount: r.clients.size,
      totalRounds: r.totalRounds,
      timeLimit: r.timeLimit,
      hostName: r.clients.get(r.hostId)?.name || '?',
    }));
}

function broadcastPublicRooms() {
  const list = getPublicRooms();
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && ws._wantsPublicList) {
      ws.send(JSON.stringify({ type: 'public_rooms', rooms: list }));
    }
  });
}

// ─── WEBSOCKET ───────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;
  ws._wantsPublicList = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'watch_public': {
        ws._wantsPublicList = true;
        sendTo(ws, { type: 'public_rooms', rooms: getPublicRooms() });
        break;
      }

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
        playerId = msg.playerId;
        roomCode = code;
        rooms[code].clients.set(playerId, { ws, name: msg.name, score: 0 });
        sendTo(ws, { type: 'joined', roomCode: code, playerId });
        broadcastAll(code, { type: 'room_state', ...getRoomState(code) });
        broadcastPublicRooms();
        break;
      }

      case 'set_config': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;
        if (msg.totalRounds) room.totalRounds = msg.totalRounds;
        if (msg.timeLimit) room.timeLimit = msg.timeLimit;
        if (msg.isPublic !== undefined) room.isPublic = msg.isPublic;
        if (msg.roomName) room.roomName = msg.roomName;
        broadcastAll(roomCode, { type: 'room_state', ...getRoomState(roomCode) });
        broadcastPublicRooms();
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
        broadcastAll(roomCode, { type: 'round_start', letter, round: 1, totalRounds: room.totalRounds, timeLimit: room.timeLimit, startedAt });
        room.timerTimeout = setTimeout(() => autoStop(roomCode), room.timeLimit * 1000);
        broadcastPublicRooms();
        break;
      }

      case 'call_stop': {
        const room = rooms[roomCode];
        if (!room || room.phase !== 'playing' || room.stoppedBy) return;
        room.stoppedBy = playerId;
        room.phase = 'collecting';
        clearTimeout(room.timerTimeout);
        broadcastAll(roomCode, { type: 'stop_called', stoppedBy: playerId, stopperName: room.clients.get(playerId)?.name || '?' });
        break;
      }

      case 'submit_answers': {
        const room = rooms[roomCode];
        if (!room) return;
        room.answers[playerId] = msg.answers;
        const allAnswered = [...room.clients.keys()].every(id => room.answers[id]);
        if (allAnswered) calculateResults(roomCode);
        break;
      }

      case 'next_round': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;
        const letters = 'ABCDEFGHIJLMNOPRSTV'.split('');
        const avail = letters.filter(l => !room.usedLetters.includes(l));
        const pool = avail.length ? avail : letters;
        const letter = pool[Math.floor(Math.random() * pool.length)];
        room.usedLetters.push(letter);
        room.currentLetter = letter;
        room.currentRound += 1;
        room.phase = 'playing';
        room.answers = {};
        room.stoppedBy = null;
        const startedAt = Date.now();
        broadcastAll(roomCode, { type: 'round_start', letter, round: room.currentRound, totalRounds: room.totalRounds, timeLimit: room.timeLimit, startedAt });
        room.timerTimeout = setTimeout(() => autoStop(roomCode), room.timeLimit * 1000);
        break;
      }

      case 'end_game': {
        const room = rooms[roomCode];
        if (!room || room.hostId !== playerId) return;
        room.phase = 'final';
        const scores = {}, players = {};
        room.clients.forEach((c, id) => { scores[id] = c.score; players[id] = { name: c.name, score: c.score }; });
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

function autoStop(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'playing') return;
  room.stoppedBy = 'timeout';
  room.phase = 'collecting';
  broadcastAll(roomCode, { type: 'stop_called', stoppedBy: 'timeout', stopperName: 'el tiempo' });
  setTimeout(() => {
    const room = rooms[roomCode];
    if (!room) return;
    room.clients.forEach((_, id) => { if (!room.answers[id]) room.answers[id] = {}; });
    calculateResults(roomCode);
  }, 3000);
}

async function calculateResults(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const letter = room.currentLetter;
  const answers = room.answers;

  broadcastAll(roomCode, { type: 'validating' });

  const validationResults = {};
  await Promise.all(
    [...room.clients.keys()].map(async id => {
      validationResults[id] = await validateWithGroq(answers[id] || {}, letter);
    })
  );

  const roundScores = {};
  room.clients.forEach((_, id) => { roundScores[id] = 0; });

  CATEGORIES.forEach(cat => {
    const validAnswers = {};
    room.clients.forEach((_, id) => {
      const val = (answers[id]?.[cat] || '').trim();
      if (val && validationResults[id]?.[cat] === true) validAnswers[id] = val.toLowerCase();
    });
    const counts = {};
    Object.values(validAnswers).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    Object.entries(validAnswers).forEach(([id, v]) => { roundScores[id] += counts[v] === 1 ? 10 : 5; });
  });

  room.clients.forEach((client, id) => { client.score = (client.score || 0) + (roundScores[id] || 0); });

  const scores = {}, players = {};
  room.clients.forEach((c, id) => { scores[id] = c.score; players[id] = { name: c.name, score: c.score }; });
  room.phase = 'results';

  broadcastAll(roomCode, { type: 'round_results', letter, round: room.currentRound, totalRounds: room.totalRounds, answers, validationResults, roundScores, scores, players, stoppedBy: room.stoppedBy });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Tutti Frutti server on port ${PORT}`));
