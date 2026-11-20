'use strict';
/**
 * AI 캐릭터 변신 부스
 *
 * 흐름
 *  1) 학생이 학습지에 자기 캐릭터를 그린다
 *  2) QR로 접속 → 휴대폰 카메라로 그림을 찍는다
 *  3) 변신 스타일(양모펠트, 2D/3D 애니메이션 …)을 고르면 AI(Gemini)가 새 그림을 만든다
 *  4) [패들렛에 보내기] → 패들렛 보드에 글이 올라가고, 교사 화면 인쇄 대기열에 뜬다
 *  5) 교사는 /teacher 에서 포토프린터 크기(10×15cm 등)로 바로 인쇄
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { STYLES, BASE_PROMPT, findStyle } = require('./lib/styles');
const { generateImage, createLimiter, AiError } = require('./lib/gemini');
const padlet = require('./lib/padlet');
const { makeZip } = require('./lib/zip');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMG_DIR = path.join(DATA_DIR, 'img');
const DB_FILE = path.join(DATA_DIR, 'booth.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const PADLET_API_KEY = process.env.PADLET_API_KEY || '';
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || '';
const MOCK_AI = process.env.MOCK_AI === '1';
const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 2000);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

fs.mkdirSync(IMG_DIR, { recursive: true });

// ───────── 저장소 ─────────
const db = {
  settings: {
    title: process.env.BOOTH_TITLE || 'AI 캐릭터 변신 부스',
    boardId: padlet.boardIdFrom(process.env.PADLET_BOARD_ID || ''),
    padletOn: true,
    maxTries: Number(process.env.MAX_TRIES) || 3,
    enabledStyles: STYLES.map((s) => s.id),
  },
  items: [], // 최신이 앞
  tries: {}, // 학생 기기 토큰 → 변신 횟수
};

try {
  const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  Object.assign(db.settings, saved.settings || {});
  db.items = saved.items || [];
  db.tries = saved.tries || {};
  console.log(`저장된 작품 ${db.items.length}개를 불러왔습니다.`);
} catch {
  /* 첫 실행 */
}
if (process.env.PADLET_BOARD_ID && !db.settings.boardId) db.settings.boardId = padlet.boardIdFrom(process.env.PADLET_BOARD_ID);

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    } catch (e) {
      console.error('저장 실패:', e.message);
    }
  }, 500);
}

const uid = (n = 9) => crypto.randomBytes(n).toString('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const runAi = createLimiter(Number(process.env.AI_CONCURRENCY) || 3);

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  return { mime: m[1], buf, b64: m[2] };
}

const extOf = (mime) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg');

function publicBase(req) {
  const fixed = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (fixed) return fixed.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function isPrivateHost(base) {
  try {
    const h = new URL(base).hostname;
    return h === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith('.local');
  } catch {
    return true;
  }
}

function aiStatus() {
  if (MOCK_AI) return 'mock';
  return GEMINI_API_KEY ? 'ready' : 'missing';
}

function padletReady() {
  return Boolean(db.settings.padletOn && PADLET_API_KEY && db.settings.boardId);
}

function itemView(it, base) {
  const style = findStyle(it.styleId);
  return {
    id: it.id,
    name: it.name,
    charName: it.charName,
    intro: it.intro,
    styleId: it.styleId,
    styleName: style ? style.name : it.styleId,
    styleEmoji: style ? style.emoji : '🎨',
    createdAt: it.createdAt,
    sent: it.sent,
    sentAt: it.sentAt || null,
    printed: it.printed || 0,
    padlet: it.padlet,
    originalUrl: `${base}/img/${it.original}`,
    resultUrl: `${base}/img/${it.result}`,
  };
}

async function postToPadlet(it, base) {
  if (!db.settings.padletOn) {
    it.padlet = { status: 'off' };
    return it.padlet;
  }
  if (!PADLET_API_KEY || !db.settings.boardId) {
    it.padlet = { status: 'error', error: '패들렛 API 키 또는 보드 ID가 설정되지 않았어요.' };
    return it.padlet;
  }
  const style = findStyle(it.styleId);
  const who = it.charName ? `${it.charName}` : `${it.name}의 캐릭터`;
  const lines = [
    `만든 친구: ${it.name}`,
    `변신 스타일: ${style ? `${style.emoji} ${style.name}` : it.styleId}`,
    it.intro ? `소개: ${it.intro}` : '',
    `원래 그림: ${base}/img/${it.original}`,
  ].filter(Boolean);
  try {
    const r = await padlet.createPost({
      apiKey: PADLET_API_KEY,
      boardId: db.settings.boardId,
      subject: `${style ? style.emoji : '🎨'} ${who}`,
      body: lines.join('\n'),
      attachmentUrl: `${base}/img/${it.result}`,
      caption: `${who} (${style ? style.name : ''})`,
    });
    it.padlet = { status: 'ok', postId: r.id, url: r.url, at: Date.now() };
  } catch (e) {
    console.error('패들렛 전송 실패:', e.message);
    it.padlet = { status: 'error', error: e.message, at: Date.now() };
  }
  save();
  return it.padlet;
}

// ───────── 앱 ─────────
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use(
  '/img',
  express.static(IMG_DIR, {
    maxAge: '7d',
    immutable: true,
    setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*'),
  })
);

app.get('/teacher', (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
app.get('/wall', (req, res) => res.sendFile(path.join(__dirname, 'public', 'wall.html')));
app.get('/print', (req, res) => res.sendFile(path.join(__dirname, 'public', 'print.html')));

app.get('/qr.svg', async (req, res) => {
  const svg = await QRCode.toString(`${publicBase(req)}/`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// 학생 화면 설정
app.get('/api/config', (req, res) => {
  const token = clean(req.query.token, 40);
  const used = (token && db.tries[token]) || 0;
  res.json({
    title: db.settings.title,
    styles: STYLES.filter((s) => db.settings.enabledStyles.includes(s.id)).map(({ id, emoji, name, desc }) => ({ id, emoji, name, desc })),
    maxTries: db.settings.maxTries,
    triesLeft: Math.max(0, db.settings.maxTries - used),
    aiReady: aiStatus() !== 'missing',
    padletOn: db.settings.padletOn,
  });
});

// 그림 → AI 변신
app.post('/api/generate', async (req, res) => {
  const b = req.body || {};
  const token = clean(b.token, 40);
  const name = clean(b.name, 12);
  const charName = clean(b.charName, 20);
  const intro = clean(b.intro, 80);
  const style = findStyle(b.styleId);
  if (!token || token.length < 8) return res.status(400).json({ error: '페이지를 새로고침해 주세요.' });
  if (!name) return res.status(400).json({ error: '이름(닉네임)을 적어 주세요.' });
  if (!style || !db.settings.enabledStyles.includes(style.id)) return res.status(400).json({ error: '변신 스타일을 골라 주세요.' });
  const img = parseDataUrl(b.image);
  if (!img) return res.status(400).json({ error: '사진을 다시 찍어 주세요. (사진이 없거나 너무 커요)' });

  const used = db.tries[token] || 0;
  if (used >= db.settings.maxTries) {
    return res.status(429).json({ error: `변신은 한 사람당 ${db.settings.maxTries}번까지예요. 마음에 드는 걸 패들렛에 보내 주세요!` });
  }
  if (aiStatus() === 'missing') return res.status(503).json({ error: '선생님이 아직 AI 연결을 안 했어요.' });

  // 같은 학생이 버튼을 연타해도 횟수를 먼저 차감
  db.tries[token] = used + 1;
  save();

  const id = uid();
  const original = `${id}-o.${extOf(img.mime)}`;
  fs.writeFileSync(path.join(IMG_DIR, original), img.buf);

  let out;
  try {
    if (MOCK_AI) {
      await new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
      out = { data: img.b64, mime: img.mime, model: 'mock' };
    } else {
      const prompt = BASE_PROMPT(style, [charName && `name: ${charName}`, intro].filter(Boolean).join('. '));
      out = await runAi(() =>
        generateImage({ apiKey: GEMINI_API_KEY, model: GEMINI_MODEL, prompt, imageB64: img.b64, mime: img.mime })
      );
    }
  } catch (e) {
    // 실패하면 횟수 돌려주기
    db.tries[token] = Math.max(0, (db.tries[token] || 1) - 1);
    save();
    fs.rm(path.join(IMG_DIR, original), () => {});
    console.error('AI 변신 실패:', e.message);
    const status = e instanceof AiError ? e.status : 500;
    return res.status(status).json({ error: e.userMessage || 'AI가 그림을 만들지 못했어요. 다시 해 볼까요?' });
  }

  const result = `${id}-a.${extOf(out.mime)}`;
  fs.writeFileSync(path.join(IMG_DIR, result), Buffer.from(out.data, 'base64'));
  const it = {
    id,
    token,
    name,
    charName,
    intro,
    styleId: style.id,
    model: out.model,
    original,
    result,
    createdAt: Date.now(),
    sent: false,
    printed: 0,
    padlet: { status: 'none' },
  };
  db.items.unshift(it);
  save();
  const base = publicBase(req);
  res.json({ ...itemView(it, base), triesLeft: Math.max(0, db.settings.maxTries - db.tries[token]) });
});

// 패들렛에 보내기 (+ 교사 인쇄 대기열)
app.post('/api/send', async (req, res) => {
  const { token, id } = req.body || {};
  const it = db.items.find((x) => x.id === id);
  if (!it || it.token !== token) return res.status(404).json({ error: '작품을 찾지 못했어요. 다시 만들어 주세요.' });
  const base = publicBase(req);
  if (!it.sent) {
    it.sent = true;
    it.sentAt = Date.now();
    save();
  }
  if (it.padlet.status !== 'ok') await postToPadlet(it, base);
  res.json({ ok: true, padlet: { status: it.padlet.status, url: it.padlet.url || null } });
});

// 전시 벽(패들렛 대신 TV에 띄울 수도 있음)
app.get('/api/wall', (req, res) => {
  const base = publicBase(req);
  res.json({
    title: db.settings.title,
    items: db.items.filter((x) => x.sent).slice(0, 200).map((it) => {
      const v = itemView(it, base);
      return { id: v.id, name: v.name, charName: v.charName, styleName: v.styleName, styleEmoji: v.styleEmoji, resultUrl: v.resultUrl, sentAt: v.sentAt };
    }),
  });
});

// ───────── 교사용 ─────────
function teacherOnly(req, res, next) {
  if (!TEACHER_PASSWORD) return next();
  const key = req.get('x-teacher-key') || '';
  const a = Buffer.from(crypto.createHash('sha256').update(key).digest('hex'));
  const b = Buffer.from(crypto.createHash('sha256').update(TEACHER_PASSWORD).digest('hex'));
  if (crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: '선생님 비밀번호가 맞지 않아요.' });
}

app.get('/api/teacher/state', teacherOnly, (req, res) => {
  const base = publicBase(req);
  res.json({
    settings: db.settings,
    allStyles: STYLES.map(({ id, emoji, name, desc }) => ({ id, emoji, name, desc })),
    status: {
      ai: aiStatus(),
      padletKey: Boolean(PADLET_API_KEY),
      padletReady: padletReady(),
      passwordSet: Boolean(TEACHER_PASSWORD),
      studentUrl: `${base}/`,
      privateUrl: isPrivateHost(base),
      queue: runAi.stats(),
    },
    items: db.items.map((it) => itemView(it, base)),
  });
});

app.post('/api/teacher/settings', teacherOnly, (req, res) => {
  const b = req.body || {};
  const s = db.settings;
  if (typeof b.title === 'string') s.title = clean(b.title, 40) || s.title;
  if (typeof b.boardId === 'string') s.boardId = padlet.boardIdFrom(b.boardId);
  if (typeof b.padletOn === 'boolean') s.padletOn = b.padletOn;
  if (b.maxTries !== undefined) s.maxTries = Math.min(20, Math.max(1, Math.round(Number(b.maxTries)) || 3));
  if (Array.isArray(b.enabledStyles)) {
    const ids = b.enabledStyles.filter((id) => findStyle(id));
    if (ids.length) s.enabledStyles = ids;
  }
  save();
  res.json({ ok: true, settings: s });
});

app.post('/api/teacher/padlet-test', teacherOnly, async (req, res) => {
  if (!PADLET_API_KEY) return res.status(400).json({ error: '서버에 PADLET_API_KEY가 없어요. (README의 설정 방법 참고)' });
  if (!db.settings.boardId) return res.status(400).json({ error: '패들렛 보드 ID를 먼저 저장해 주세요.' });
  try {
    const board = await padlet.getBoard({ apiKey: PADLET_API_KEY, boardId: db.settings.boardId });
    res.json({ ok: true, title: board.title });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function findItem(req, res) {
  const it = db.items.find((x) => x.id === req.params.id);
  if (!it) res.status(404).json({ error: '작품이 없어요.' });
  return it;
}

app.post('/api/teacher/items/:id/resend', teacherOnly, async (req, res) => {
  const it = findItem(req, res);
  if (!it) return;
  it.sent = true;
  it.sentAt = it.sentAt || Date.now();
  const p = await postToPadlet(it, publicBase(req));
  res.json({ ok: p.status === 'ok', padlet: p });
});

app.post('/api/teacher/items/:id/printed', teacherOnly, (req, res) => {
  const it = findItem(req, res);
  if (!it) return;
  it.printed = (it.printed || 0) + 1;
  save();
  res.json({ ok: true, printed: it.printed });
});

app.get('/api/teacher/items/:id', teacherOnly, (req, res) => {
  const it = findItem(req, res);
  if (!it) return;
  res.json({ ...itemView(it, publicBase(req)), title: db.settings.title });
});

app.delete('/api/teacher/items/:id', teacherOnly, (req, res) => {
  const it = findItem(req, res);
  if (!it) return;
  db.items = db.items.filter((x) => x !== it);
  for (const f of [it.original, it.result]) fs.rm(path.join(IMG_DIR, f), () => {});
  save();
  res.json({ ok: true });
});

app.post('/api/teacher/reset-tries', teacherOnly, (req, res) => {
  db.tries = {};
  save();
  res.json({ ok: true });
});

app.post('/api/teacher/clear-all', teacherOnly, (req, res) => {
  for (const it of db.items) for (const f of [it.original, it.result]) fs.rm(path.join(IMG_DIR, f), () => {});
  db.items = [];
  db.tries = {};
  save();
  res.json({ ok: true });
});

// 행사 끝나고 작품 전체 내려받기 (링크로 여니까 비밀번호를 주소에 붙임)
app.get('/api/teacher/download.zip', (req, res, next) => {
  if (!req.get('x-teacher-key') && req.query.key) req.headers['x-teacher-key'] = String(req.query.key);
  next();
}, teacherOnly, (req, res) => {
  const onlySent = req.query.all !== '1';
  const used = new Set();
  const files = [];
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || '이름없음';
  for (const it of db.items) {
    if (onlySent && !it.sent) continue;
    const style = findStyle(it.styleId);
    let stem = `${safe(it.name)}_${safe(it.charName || '캐릭터')}_${safe(style ? style.name : it.styleId)}`;
    for (let n = 2; used.has(stem); n++) stem = stem.replace(/_\d+$/, '') + `_${n}`;
    used.add(stem);
    for (const [file, label] of [[it.result, 'AI'], [it.original, '원본']]) {
      try {
        files.push({ name: `${stem}_${label}.${file.split('.').pop()}`, data: fs.readFileSync(path.join(IMG_DIR, file)) });
      } catch {
        /* 사라진 파일은 건너뜀 */
      }
    }
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`캐릭터부스_${stamp}.zip`)}`);
  res.send(makeZip(files));
});

// 오류 처리
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: '사진이 너무 커요. 다시 찍어 주세요.' });
  console.error(err);
  res.status(500).json({ error: '서버에 문제가 생겼어요.' });
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🎨 AI 캐릭터 변신 부스 실행 중 (포트 ${PORT})`);
    console.log(`  교사 화면: http://localhost:${PORT}/teacher`);
    for (const ip of lanAddresses()) console.log(`  학생 접속: http://${ip}:${PORT}/`);
    console.log(`  AI: ${aiStatus()}  |  패들렛: ${padletReady() ? '연결됨' : '미설정'}\n`);
  });
}

module.exports = { app };
