/* 친구 퀴즈 배틀 — 교사 대시보드 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });
  const STORE = 'quizBattle.teacher';
  const TYPE_LABEL = { short: '✍️ 단답형', choice: '🔢 객관식', sentence: '📝 문장형' };
  const PHASE_LABEL = { create: '✏️ 문제 만드는 중', play: '▶️ 게임 중', paused: '⏸️ 일시정지', ended: '🏁 게임 끝' };

  let saved = load();
  let state = null;
  let tab = 'students';
  let lastPhase = null;
  let baseUrl = location.origin;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  function save(v) {
    saved = v;
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* 무시 */ }
  }
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c);
    return n;
  }
  function toast(msg, isError) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = el('div', { class: 'toast' + (isError ? ' error' : ''), text: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }
  const send = (ev, data = {}) =>
    new Promise((resolve) => socket.emit(ev, data, (res) => {
      if (!res?.ok && res?.error) toast(res.error, true);
      resolve(res);
    }));

  // 선생님이 localhost 로 열었으면, 학생용 주소는 같은 와이파이의 IP 로 보여준다.
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
    fetch('/api/info').then((r) => r.json()).then((info) => {
      if (info.ips?.length) {
        baseUrl = `${location.protocol}//${info.ips[0]}:${location.port || info.port}`;
        if (state) renderJoin();
      }
    }).catch(() => {});
  }

  // ───────── 방 ─────────
  function showDash(on) {
    $('v-start').classList.toggle('hidden', on);
    $('v-dash').classList.toggle('hidden', !on);
    $('phase-badge').classList.toggle('hidden', !on);
  }

  function createRoom() {
    socket.emit('teacher:create', {}, (res) => {
      if (!res?.ok) return ($('start-error').textContent = '방을 만들지 못했어요.');
      save({ code: res.code, token: res.token });
      showDash(true);
    });
  }
  $('create-room').addEventListener('click', createRoom);
  $('new-room').addEventListener('click', () => {
    if (!confirm('새 방을 만들면 지금 방의 학생들은 새 코드로 다시 들어와야 해요. 계속할까요?')) return;
    state = null;
    lastPhase = null;
    createRoom();
  });

  socket.on('connect', () => {
    $('conn').classList.add('hidden');
    if (saved.code && saved.token) {
      socket.emit('teacher:join', saved, (res) => {
        if (!res?.ok) {
          save({});
          showDash(false);
          $('start-error').textContent = res?.error || '';
        } else showDash(true);
      });
    }
  });
  socket.on('disconnect', () => $('conn').classList.remove('hidden'));

  // ───────── 상태 ─────────
  socket.on('teacher:state', (s) => {
    state = s;
    showDash(true);
    if (s.phase !== lastPhase) {
      if (s.phase === 'play' || s.phase === 'ended') setTab('ranking');
      else if (s.phase === 'create' && lastPhase) setTab('students');
      lastPhase = s.phase;
    }
    render();
  });

  function render() {
    const s = state;
    renderJoin();
    $('phase-badge').className = 'phase-badge phase-' + s.phase;
    $('phase-badge').textContent = PHASE_LABEL[s.phase];
    $('st-players').textContent = s.players.length;
    $('st-online').textContent = s.players.filter((p) => p.connected).length;
    $('st-questions').textContent = s.questions.length;
    $('set-time').value = String(s.settings.timeLimit);
    $('set-max').value = String(s.settings.maxQuestions);
    renderControls();
    renderStudents();
    renderQuestions();
    renderRanking();
    $('score-rules').replaceChildren(
      el('li', { text: `정답: 기본 ${s.scoring.base}점` }),
      el('li', { text: `빨리 맞히면: 남은 시간만큼 최대 +${s.scoring.speedMax}점` }),
      el('li', { text: `연속 정답: 2연속부터 1회마다 +${s.scoring.streakStep}점 (최대 +${s.scoring.streakMax}점)` }),
      el('li', { text: '틀리거나 시간이 지나면 0점, 연속 기록 초기화' }),
      el('li', { text: '자기가 낸 문제는 자기에게 나오지 않아요' })
    );
  }

  function renderJoin() {
    const url = `${baseUrl}/?code=${state.code}`;
    $('code').textContent = state.code;
    $('join-url').textContent = url.replace(/^https?:\/\//, '');
    const qrSrc = '/qr.svg?text=' + encodeURIComponent(url);
    if ($('qr').getAttribute('src') !== qrSrc) $('qr').src = qrSrc;
  }

  function renderControls() {
    const s = state;
    const box = $('controls');
    const btn = (label, cls, onclick, disabled) => el('button', { class: `btn big block ${cls}`, onclick, ...(disabled ? { disabled: '' } : {}) }, label);
    const phase = (p) => () => send('teacher:phase', { phase: p });
    const canPlay = s.questions.length >= 2;
    let hint = '';
    if (s.phase === 'create') {
      box.replaceChildren(btn('▶ PLAY', 'good', phase('play'), !canPlay));
      hint = canPlay ? '문제가 충분히 모이면 PLAY를 누르세요. 학생마다 다른 친구의 문제가 랜덤으로 나와요.' : '문제가 2개 이상 모이면 시작할 수 있어요.';
    } else if (s.phase === 'play') {
      box.replaceChildren(btn('⏸ 일시정지', 'warn', phase('paused')), btn('🏁 게임 끝내기', 'bad', () => confirm('게임을 끝내고 최종 순위를 보여줄까요?') && send('teacher:phase', { phase: 'ended' })));
      const playing = s.players.filter((p) => p.connected && p.remaining > 0).length;
      hint = `아직 풀 문제가 남은 학생: ${playing}명`;
    } else if (s.phase === 'paused') {
      box.replaceChildren(btn('▶ 다시 시작', 'good', phase('play')), btn('✏️ 문제 더 만들기', 'ghost', phase('create')), btn('🏁 게임 끝내기', 'bad', phase('ended')));
      hint = '풀던 문제는 점수 변화 없이 취소돼요.';
    } else {
      box.replaceChildren(btn('▶ 이어서 하기', 'good', phase('play')), btn('✏️ 문제 더 만들기', 'ghost', phase('create')));
      hint = '점수를 0부터 다시 시작하려면 아래 "점수 초기화"를 누르세요.';
    }
    $('control-hint').textContent = hint;
  }

  function renderStudents() {
    const s = state;
    const list = [...s.players].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    $('students').replaceChildren(
      ...list.map((p) =>
        el('span', { class: 'chip' + (p.connected ? '' : ' off'), title: p.connected ? '접속 중' : '접속 끊김' },
          el('span', { class: 'dot' + (p.connected ? ' on' : '') }),
          p.name,
          el('span', { class: 'n' + (p.questionCount ? '' : ' zero'), text: p.questionCount })
        )
      )
    );
    if (!list.length) $('students').append(el('p', { class: 'muted', text: '아직 들어온 학생이 없어요. 입장 코드를 알려 주세요!' }));
    $('kick-list').replaceChildren(
      ...list.map((p) =>
        el('button', { class: 'btn sm ghost', type: 'button', onclick: () => confirm(`${p.name} 학생을 내보낼까요?`) && send('teacher:kick', { id: p.id }) }, '✕ ' + p.name)
      )
    );
  }

  function renderQuestions() {
    const tb = $('questions');
    tb.replaceChildren(
      ...state.questions.map((q) => {
        const answer = q.type === 'choice'
          ? el('div', {}, ...q.choices.map((c, i) => el('div', { class: i === q.answer ? '' : 'muted small', style: i === q.answer ? 'font-weight:700;color:var(--good)' : '', text: `${i + 1}. ${c}${i === q.answer ? ' ✅' : ''}` })))
          : el('div', {}, el('div', { text: q.answer }), q.keywords ? el('div', { class: 'small muted', text: '핵심 단어: ' + q.keywords }) : null);
        const rate = q.stats.tries ? `${Math.round((q.stats.correct / q.stats.tries) * 100)}% (${q.stats.correct}/${q.stats.tries})` : '-';
        return el('tr', {},
          el('td', { class: 'nowrap' }, el('span', { class: 'badge ' + q.type, text: TYPE_LABEL[q.type] })),
          el('td', { style: 'font-weight:700', text: q.text }),
          el('td', {}, answer),
          el('td', { class: 'nowrap', text: q.author }),
          el('td', { class: 'nowrap', text: rate }),
          el('td', { class: 'nowrap' }, el('button', { class: 'link-btn', text: '삭제', onclick: () => confirm('이 문제를 지울까요?') && send('teacher:deleteQuestion', { id: q.id }) }))
        );
      })
    );
    if (!state.questions.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: '아직 만든 문제가 없어요.' })));
  }

  function renderRanking() {
    const lb = state.leaderboard;
    const podium = $('podium');
    if (state.phase === 'ended' && lb.length) {
      const order = [lb[1], lb[0], lb[2]];
      podium.replaceChildren(
        el('h2', { class: 'center', text: '🎉 최종 순위 🎉' }),
        el('div', { class: 'podium' },
          ...order.map((p, i) => p ? el('div', { class: 'p p' + [2, 1, 3][i] },
            el('div', { class: 'nm', text: p.name }),
            el('div', { class: 'sc', text: p.score.toLocaleString() + '점' }),
            el('div', { class: 'bar', text: ['🥈', '🥇', '🥉'][i] })
          ) : el('div', { class: 'p' })))
      );
    } else {
      podium.replaceChildren(el('h2', { text: state.phase === 'play' ? '🏆 실시간 순위' : '🏆 순위' }));
    }
    $('ranking').replaceChildren(
      ...lb.map((r) =>
        el('li', {},
          el('span', { class: 'rk', text: ['🥇', '🥈', '🥉'][r.rank - 1] || r.rank }),
          el('span', { class: 'nm', text: r.name }),
          el('span', { class: 'small muted', text: `${r.correct}/${r.answered} 정답` }),
          r.streak >= 2 ? el('span', { class: 'fire small', text: `🔥${r.streak}` }) : null,
          el('span', { class: 'sc', text: r.score.toLocaleString() + '점' })
        )
      )
    );
    if (!lb.length) $('ranking').append(el('li', { class: 'muted', text: '아직 학생이 없어요.' }));
  }

  // ───────── 탭 / 설정 ─────────
  function setTab(t) {
    tab = t;
    document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    for (const name of ['students', 'questions', 'ranking']) $('tab-' + name).classList.toggle('hidden', name !== t);
  }
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  $('fullscreen').addEventListener('click', () => {
    const target = $('tab-' + tab);
    target.classList.add('projector');
    if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.querySelectorAll('.projector').forEach((n) => n.classList.remove('projector'));
  });

  for (let i = 1; i <= 10; i++) $('set-max').append(el('option', { value: i, text: i + '개' }));
  $('set-time').addEventListener('change', (e) => send('teacher:settings', { timeLimit: Number(e.target.value) }));
  $('set-max').addEventListener('change', (e) => send('teacher:settings', { maxQuestions: Number(e.target.value) }));
  $('reset-scores').addEventListener('click', () => {
    if (confirm('모든 학생의 점수와 푼 기록을 지우고 "문제 만들기" 단계로 돌아갈까요? (문제는 그대로 남아요)')) send('teacher:resetScores');
  });
})();
