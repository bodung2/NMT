'use strict';
/**
 * 친구 퀴즈 배틀 — 수업용 실시간 퀴즈 서버
 *
 * 흐름
 *  1) 교사가 /teacher 에서 방을 만든다 → 4자리 입장 코드
 *  2) 학생은 / 에서 코드+이름으로 입장해 문제를 낸다 (단답형 / 객관식 / 문장형)
 *  3) 교사가 PLAY 를 누르면, 학생마다 "다른 친구가 만든 문제"가 랜덤으로 출제된다
 *  4) 맞히면 기본 점수 + 빨리 맞힌 보너스 + 연속 정답 보너스
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { SCORE, normalize, splitList, isCorrect, calcPoints } = require('./lib/grading');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24시간 지난 방은 정리
const GRACE_MS = 1500; // 네트워크 지연 허용 시간

const LIMITS = {
  name: 12,
  text: 200,
  choice: 60,
  answer: 100,
  sentence: 300,
};

const TYPES = ['short', 'choice', 'sentence'];

// ───────── 상태 ─────────
/** @type {Map<string, any>} */
const rooms = new Map();

const uid = (n = 8) => crypto.randomBytes(n).toString('hex');

function newRoomCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Math.floor(10000 + Math.random() * 90000));
}

function createRoom() {
  const room = {
    code: newRoomCode(),
    teacherToken: uid(16),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    phase: 'create', // create | play | paused | ended
    settings: { timeLimit: 20, maxQuestions: 3 },
    players: new Map(),
    questions: new Map(),
  };
  rooms.set(room.code, room);
  return room;
}

// ───────── 저장 / 불러오기 (서버 재시작 대비) ─────────
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const out = [...rooms.values()].map((r) => ({
        ...r,
        players: [...r.players.values()].map((p) => ({ ...p, seen: [...p.seen], connected: false, socketIds: undefined })),
        questions: [...r.questions.values()],
      }));
      fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out));
      fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
    } catch (e) {
      console.error('저장 실패:', e.message);
    }
  }, 1000);
}

function loadRooms() {
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const r of arr) {
      if (Date.now() - (r.touchedAt || r.createdAt) > ROOM_TTL_MS) continue;
      r.players = new Map(r.players.map((p) => [p.id, { ...p, seen: new Set(p.seen), connected: false, socketIds: new Set() }]));
      r.questions = new Map(r.questions.map((q) => [q.id, q]));
      rooms.set(r.code, r);
    }
    console.log(`저장된 방 ${rooms.size}개를 불러왔습니다.`);
  } catch {
    /* 첫 실행 */
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) if (now - r.touchedAt > ROOM_TTL_MS) rooms.delete(code);
}, 60 * 60 * 1000).unref();

function timeLimitFor(room, q) {
  const t = room.settings.timeLimit;
  return (q.type === 'sentence' ? t * 2 : t) * 1000;
}

// ───────── 데이터 → 화면용 ─────────
function leaderboard(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name, 'ko'))
    .map((p, i, arr) => {
      // 동점자는 같은 등수
      let rank = i + 1;
      if (i > 0 && arr[i - 1].score === p.score && arr[i - 1].correct === p.correct) rank = arr[i - 1]._rank;
      p._rank = rank;
      return { id: p.id, name: p.name, score: p.score, correct: p.correct, answered: p.answered, streak: p.streak, bestStreak: p.bestStreak, connected: p.connected, rank };
    });
}

function publicQuestion(q, withAnswer = false) {
  const base = { id: q.id, type: q.type, text: q.text, choices: q.type === 'choice' ? q.choices : undefined };
  if (withAnswer) Object.assign(base, { answer: q.answer, keywords: q.keywords });
  return base;
}

function answerLabel(q) {
  if (q.type === 'choice') return `${q.answer + 1}번. ${q.choices[q.answer]}`;
  return q.answer;
}

function availableFor(room, player) {
  return [...room.questions.values()].filter((q) => q.authorId !== player.id && !player.seen.has(q.id));
}

function studentState(room, player) {
  const lb = leaderboard(room);
  const me = lb.find((x) => x.id === player.id);
  return {
    phase: room.phase,
    code: room.code,
    settings: room.settings,
    me: { id: player.id, name: player.name, score: player.score, streak: player.streak, bestStreak: player.bestStreak, correct: player.correct, answered: player.answered, rank: me?.rank, total: lb.length },
    myQuestions: [...room.questions.values()].filter((q) => q.authorId === player.id).map((q) => ({ ...publicQuestion(q, true), stats: q.stats })),
    remaining: room.phase === 'create' ? null : availableFor(room, player).length,
    top: room.phase === 'ended' ? lb.slice(0, 10) : lb.slice(0, 5),
    scoring: SCORE,
  };
}

function teacherState(room) {
  const players = new Map([...room.players.values()].map((p) => [p.id, p]));
  return {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    scoring: SCORE,
    leaderboard: leaderboard(room),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      questionCount: [...room.questions.values()].filter((q) => q.authorId === p.id).length,
      remaining: availableFor(room, p).length,
    })),
    questions: [...room.questions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((q) => ({ ...publicQuestion(q, true), author: players.get(q.authorId)?.name ?? '(나간 학생)', stats: q.stats })),
  };
}

// ───────── 서버 ─────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/info', (_req, res) => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  }
  res.json({ ips, port: PORT });
});

app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  } catch {
    res.status(500).end();
  }
});

function touch(room) {
  room.touchedAt = Date.now();
  scheduleSave();
}

function emitRoom(room) {
  touch(room);
  io.to(`t:${room.code}`).emit('teacher:state', teacherState(room));
  for (const p of room.players.values()) {
    if (p.socketIds.size) io.to(`p:${p.id}`).emit('state', studentState(room, p));
  }
}

/** 학생에게 다음 문제를 준다. 이미 풀고 있는 문제가 있으면 그 문제를 다시 보낸다. */
function serveNext(room, player) {
  if (room.phase !== 'play') return;
  const now = Date.now();
  if (player.current) {
    const q = room.questions.get(player.current.qid);
    if (q && now <= player.current.issuedAt + player.current.limit + GRACE_MS) {
      io.to(`p:${player.id}`).emit('question', questionPayload(room, player, q));
      return;
    }
    if (q) {
      // 시간 초과로 처리
      const result = grade(room, player, q, null, true);
      io.to(`p:${player.id}`).emit('result', result);
      return;
    }
    player.current = null;
  }
  const pool = availableFor(room, player);
  if (!pool.length) {
    io.to(`p:${player.id}`).emit('done');
    return;
  }
  const q = pool[Math.floor(Math.random() * pool.length)];
  player.current = { qid: q.id, issuedAt: now, limit: timeLimitFor(room, q) };
  player.seen.add(q.id);
  io.to(`p:${player.id}`).emit('question', questionPayload(room, player, q));
}

function questionPayload(room, player, q) {
  const c = player.current;
  return {
    ...publicQuestion(q),
    limit: c.limit,
    remainingMs: Math.max(0, c.issuedAt + c.limit - Date.now()),
    number: player.answered + 1,
    left: availableFor(room, player).length,
  };
}

function grade(room, player, q, input, timedOut = false) {
  const c = player.current;
  const elapsed = Date.now() - c.issuedAt;
  const late = elapsed > c.limit + GRACE_MS;
  const correct = !timedOut && !late && isCorrect(q, input);

  player.answered += 1;
  if (correct) {
    player.streak += 1;
    player.correct += 1;
    player.bestStreak = Math.max(player.bestStreak, player.streak);
  } else {
    player.streak = 0;
  }
  const points = calcPoints(correct, Math.min(elapsed, c.limit), c.limit, player.streak);
  player.score += points.total;
  q.stats.tries += 1;
  if (correct) q.stats.correct += 1;
  player.current = null;

  const result = {
    qid: q.id,
    correct,
    timedOut: timedOut || late,
    points,
    streak: player.streak,
    score: player.score,
    answerLabel: answerLabel(q),
    keywords: q.type === 'sentence' ? q.keywords : undefined,
    type: q.type,
    given: q.type === 'choice' ? (input == null ? null : Number(input)) : input,
    seconds: Math.round(Math.min(elapsed, c.limit) / 100) / 10,
  };
  emitRoom(room);
  return result;
}

function validateQuestion(data) {
  const type = TYPES.includes(data?.type) ? data.type : null;
  if (!type) return { error: '문제 유형을 골라 주세요.' };
  const text = String(data.text ?? '').trim();
  if (!text) return { error: '문제를 입력해 주세요.' };
  if (text.length > LIMITS.text) return { error: `문제는 ${LIMITS.text}자 이내로 써 주세요.` };

  if (type === 'choice') {
    const choices = (Array.isArray(data.choices) ? data.choices : []).slice(0, 4).map((c) => String(c ?? '').trim());
    if (choices.length !== 4 || choices.some((c) => !c)) return { error: '보기 1~4번을 모두 채워 주세요.' };
    if (choices.some((c) => c.length > LIMITS.choice)) return { error: `보기는 ${LIMITS.choice}자 이내로 써 주세요.` };
    if (new Set(choices.map(normalize)).size !== 4) return { error: '보기 4개가 서로 달라야 해요.' };
    const answer = Number(data.answer);
    if (![0, 1, 2, 3].includes(answer)) return { error: '정답 번호를 골라 주세요.' };
    return { q: { type, text, choices, answer } };
  }

  const answer = String(data.answer ?? '').trim();
  if (!answer) return { error: '정답을 입력해 주세요.' };
  if (type === 'short') {
    if (answer.length > LIMITS.answer) return { error: `정답은 ${LIMITS.answer}자 이내로 써 주세요.` };
    return { q: { type, text, answer } };
  }
  if (answer.length > LIMITS.sentence) return { error: `모범 답안은 ${LIMITS.sentence}자 이내로 써 주세요.` };
  const keywords = splitList(data.keywords).join(', ');
  if (!keywords) return { error: '채점에 쓸 핵심 단어를 1개 이상 넣어 주세요.' };
  if (keywords.length > LIMITS.answer) return { error: `핵심 단어는 ${LIMITS.answer}자 이내로 써 주세요.` };
  return { q: { type, text, answer, keywords } };
}

io.on('connection', (socket) => {
  /** @type {{room:any, player?:any, teacher?:boolean} | null} */
  let ctx = null;
  const ack = (cb, payload) => typeof cb === 'function' && cb(payload);

  function detach() {
    if (!ctx?.player) return;
    const p = ctx.player;
    p.socketIds.delete(socket.id);
    socket.leave(`p:${p.id}`);
    if (!p.socketIds.size) {
      p.connected = false;
      emitRoom(ctx.room);
    }
  }

  // ── 교사 ──
  socket.on('teacher:create', (_d, cb) => {
    const room = createRoom();
    ctx = { room, teacher: true };
    socket.join(`t:${room.code}`);
    ack(cb, { ok: true, code: room.code, token: room.teacherToken });
    emitRoom(room);
  });

  socket.on('teacher:join', (d, cb) => {
    const room = rooms.get(String(d?.code ?? ''));
    if (!room || room.teacherToken !== d?.token) return ack(cb, { ok: false, error: '방을 찾을 수 없어요. 새 방을 만들어 주세요.' });
    ctx = { room, teacher: true };
    socket.join(`t:${room.code}`);
    ack(cb, { ok: true, code: room.code });
    socket.emit('teacher:state', teacherState(room));
  });

  const teacherOnly = (fn) => (d, cb) => {
    if (!ctx?.teacher) return ack(cb, { ok: false, error: '교사 권한이 없어요.' });
    fn(ctx.room, d || {}, cb);
  };

  socket.on(
    'teacher:phase',
    teacherOnly((room, d, cb) => {
      const phase = d.phase;
      if (!['create', 'play', 'paused', 'ended'].includes(phase)) return ack(cb, { ok: false });
      if (phase === 'play' && room.questions.size < 2) return ack(cb, { ok: false, error: '문제가 2개 이상 있어야 시작할 수 있어요.' });
      const prev = room.phase;
      room.phase = phase;
      if (phase !== 'play') {
        // 풀던 문제는 벌점 없이 취소 (다시 나올 수 있게)
        for (const p of room.players.values()) {
          if (p.current) {
            p.seen.delete(p.current.qid);
            p.current = null;
          }
        }
      }
      emitRoom(room);
      if (phase === 'play' && prev !== 'play') {
        for (const p of room.players.values()) if (p.connected) serveNext(room, p);
      }
      ack(cb, { ok: true });
    })
  );

  socket.on(
    'teacher:settings',
    teacherOnly((room, d, cb) => {
      const t = Number(d.timeLimit);
      const m = Number(d.maxQuestions);
      if ([10, 15, 20, 30, 45, 60].includes(t)) room.settings.timeLimit = t;
      if (Number.isInteger(m) && m >= 1 && m <= 10) room.settings.maxQuestions = m;
      emitRoom(room);
      ack(cb, { ok: true });
    })
  );

  socket.on(
    'teacher:deleteQuestion',
    teacherOnly((room, d, cb) => {
      room.questions.delete(String(d.id));
      emitRoom(room);
      ack(cb, { ok: true });
    })
  );

  socket.on(
    'teacher:kick',
    teacherOnly((room, d, cb) => {
      const p = room.players.get(String(d.id));
      if (p) {
        io.to(`p:${p.id}`).emit('kicked');
        room.players.delete(p.id);
        for (const q of [...room.questions.values()]) if (q.authorId === p.id) room.questions.delete(q.id);
      }
      emitRoom(room);
      ack(cb, { ok: true });
    })
  );

  socket.on(
    'teacher:resetScores',
    teacherOnly((room, _d, cb) => {
      for (const p of room.players.values()) {
        Object.assign(p, { score: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0, current: null, seen: new Set() });
      }
      for (const q of room.questions.values()) q.stats = { tries: 0, correct: 0 };
      room.phase = 'create';
      emitRoom(room);
      ack(cb, { ok: true });
    })
  );

  // ── 학생 ──
  socket.on('student:join', (d, cb) => {
    const room = rooms.get(String(d?.code ?? '').trim());
    if (!room) return ack(cb, { ok: false, error: '입장 코드를 다시 확인해 주세요.' });
    const name = String(d?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, LIMITS.name);

    detach();
    let player = d?.token ? [...room.players.values()].find((p) => p.token === d.token) : null;
    if (!player) {
      if (!name) return ack(cb, { ok: false, error: '이름을 입력해 주세요.' });
      const same = [...room.players.values()].find((p) => p.name === name);
      if (same && same.connected) return ack(cb, { ok: false, error: '같은 이름의 친구가 이미 있어요. 다른 이름을 써 주세요.' });
      if (same) player = same; // 기기를 바꿔 다시 들어온 경우
    }
    if (!player) {
      player = { id: uid(6), token: uid(16), name, score: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0, current: null, seen: new Set(), connected: true, socketIds: new Set(), joinedAt: Date.now() };
      room.players.set(player.id, player);
    }
    player.socketIds.add(socket.id);
    player.connected = true;
    ctx = { room, player };
    socket.join(`p:${player.id}`);
    ack(cb, { ok: true, token: player.token, code: room.code, name: player.name });
    emitRoom(room);
  });

  const studentOnly = (fn) => (d, cb) => {
    if (!ctx?.player || !ctx.room.players.has(ctx.player.id)) return ack(cb, { ok: false, error: '다시 입장해 주세요.' });
    fn(ctx.room, ctx.player, d || {}, cb);
  };

  socket.on(
    'question:create',
    studentOnly((room, player, d, cb) => {
      if (room.phase !== 'create') return ack(cb, { ok: false, error: '지금은 문제를 낼 수 없어요.' });
      const mine = [...room.questions.values()].filter((q) => q.authorId === player.id).length;
      if (mine >= room.settings.maxQuestions) return ack(cb, { ok: false, error: `문제는 ${room.settings.maxQuestions}개까지 낼 수 있어요.` });
      const v = validateQuestion(d);
      if (v.error) return ack(cb, { ok: false, error: v.error });
      const q = { id: uid(6), authorId: player.id, createdAt: Date.now(), stats: { tries: 0, correct: 0 }, ...v.q };
      room.questions.set(q.id, q);
      emitRoom(room);
      ack(cb, { ok: true, id: q.id });
    })
  );

  socket.on(
    'question:delete',
    studentOnly((room, player, d, cb) => {
      const q = room.questions.get(String(d.id));
      if (!q || q.authorId !== player.id) return ack(cb, { ok: false, error: '내가 낸 문제만 지울 수 있어요.' });
      if (room.phase !== 'create') return ack(cb, { ok: false, error: '게임 중에는 지울 수 없어요.' });
      room.questions.delete(q.id);
      emitRoom(room);
      ack(cb, { ok: true });
    })
  );

  socket.on(
    'play:next',
    studentOnly((room, player, _d, cb) => {
      serveNext(room, player);
      ack(cb, { ok: true });
    })
  );

  socket.on(
    'play:answer',
    studentOnly((room, player, d, cb) => {
      if (room.phase !== 'play') return ack(cb, { ok: false, error: '지금은 게임 중이 아니에요.' });
      if (!player.current || player.current.qid !== d.qid) return ack(cb, { ok: false, error: '이미 답한 문제예요.' });
      const q = room.questions.get(player.current.qid);
      if (!q) {
        player.current = null;
        return ack(cb, { ok: false, error: '선생님이 지운 문제예요. 다음 문제로 넘어가요.' });
      }
      const input = q.type === 'choice' ? d.answer : String(d.answer ?? '').slice(0, LIMITS.sentence);
      const result = grade(room, player, q, d.timeout ? null : input, !!d.timeout);
      ack(cb, { ok: true, result });
    })
  );

  socket.on('disconnect', detach);
});

loadRooms();
server.listen(PORT, () => {
  console.log(`\n친구 퀴즈 배틀 서버가 켜졌어요!  http://localhost:${PORT}`);
  console.log(`교사 화면:  http://localhost:${PORT}/teacher`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) console.log(`같은 와이파이의 학생 접속 주소:  http://${ni.address}:${PORT}`);
  }
});
