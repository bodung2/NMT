/* 친구 퀴즈 배틀 — 학생 화면 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });
  const STORE = 'quizBattle.student';
  const TYPE_LABEL = { short: '✍️ 단답형', choice: '🔢 객관식', sentence: '📝 문장형' };

  let saved = load();
  let state = null; // 서버가 보내 준 최신 상태
  let view = 'join';
  let current = null; // 풀고 있는 문제
  let waitingServer = false;
  let needSync = false;
  let qType = 'short';
  let correctChoice = null;

  // ───────── 유틸 ─────────
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }
  function save(v) {
    saved = v;
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* 사생활 보호 모드 */ }
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
  let toastTimer;
  function toast(msg, isError) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = el('div', { class: 'toast' + (isError ? ' error' : ''), text: msg });
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2600);
  }
  function show(v) {
    view = v;
    for (const s of ['join', 'create', 'wait', 'question', 'result', 'end']) $('v-' + s).classList.toggle('hidden', s !== v);
    $('topbar').classList.toggle('hidden', v === 'join');
    if (v !== 'question') stopTimer();
  }
  function renderRank(ol, list) {
    ol.replaceChildren(
      ...list.map((r) =>
        el('li', { class: state && r.id === state.me.id ? 'me' : '' },
          el('span', { class: 'rk', text: ['🥇', '🥈', '🥉'][r.rank - 1] || r.rank }),
          el('span', { class: 'nm', text: r.name }),
          el('span', { class: 'sc', text: r.score.toLocaleString() + '점' })
        )
      )
    );
    if (!list.length) ol.append(el('li', { class: 'muted', text: '아직 순위가 없어요.' }));
  }

  // ───────── 입장 ─────────
  const params = new URLSearchParams(location.search);
  $('join-code').value = params.get('code') || saved.code || '';
  $('join-name').value = saved.name || '';
  if (params.get('code') && saved.code && params.get('code') !== saved.code) save({}); // 다른 방 링크로 들어옴

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('join-code').value.trim();
    const name = $('join-name').value.trim();
    if (!code || !name) return;
    join({ code, name, token: saved.code === code && saved.name === name ? saved.token : undefined });
  });

  function join(data) {
    $('join-error').textContent = '';
    socket.emit('student:join', data, (res) => {
      if (!res?.ok) {
        if (data.token) save({ code: saved.code, name: saved.name });
        $('join-error').textContent = res?.error || '입장하지 못했어요.';
        show('join');
        return;
      }
      save({ code: res.code, name: res.name, token: res.token });
      needSync = true;
      if (view === 'join') show('wait');
    });
  }

  socket.on('connect', () => {
    $('conn').classList.add('hidden');
    if (saved.token && saved.code) join({ code: saved.code, name: saved.name, token: saved.token });
  });
  socket.on('disconnect', () => $('conn').classList.remove('hidden'));
  socket.on('kicked', () => {
    save({});
    state = null;
    show('join');
    $('join-error').textContent = '선생님이 방에서 내보냈어요.';
  });

  // ───────── 서버 상태 ─────────
  socket.on('state', (s) => {
    state = s;
    $('tb-name').textContent = '👤 ' + s.me.name;
    $('tb-score').textContent = s.me.score.toLocaleString() + '점';
    $('tb-streak').classList.toggle('hidden', s.me.streak < 2);
    $('tb-streak').textContent = '🔥 ' + s.me.streak + '연속';

    if (s.phase === 'create') {
      current = null;
      if (view !== 'create') show('create');
      renderCreate();
    } else if (s.phase === 'paused') {
      current = null;
      showWait('⏸️', '잠시 멈췄어요', '선생님이 다시 시작할 때까지 기다려요.');
    } else if (s.phase === 'ended') {
      current = null;
      renderEnd();
    } else if (s.phase === 'play') {
      const busy = view === 'question' || view === 'result' || (view === 'wait' && $('wait-title').dataset.done === '1');
      if ((needSync && view !== 'result') || !busy) requestNext();
      needSync = false;
      if (view === 'result') updateResultRank();
      if (view === 'wait') renderRank($('wait-rank'), s.top);
    }
  });

  function showWait(emoji, title, desc, done) {
    $('wait-emoji').textContent = emoji;
    $('wait-title').textContent = title;
    $('wait-title').dataset.done = done ? '1' : '';
    $('wait-desc').textContent = desc;
    if (state) renderRank($('wait-rank'), state.top);
    show('wait');
  }

  // ───────── 문제 만들기 ─────────
  function setType(t) {
    qType = t;
    document.querySelectorAll('#type-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.type === t));
    document.querySelectorAll('[data-for]').forEach((d) => d.classList.toggle('hidden', d.dataset.for !== t));
    $('q-error').textContent = '';
  }
  document.querySelectorAll('#type-tabs .tab').forEach((b) => b.addEventListener('click', () => setType(b.dataset.type)));

  function buildChoiceEdit() {
    const box = $('choice-edit');
    box.replaceChildren();
    for (let i = 0; i < 4; i++) {
      box.append(
        el('div', { class: 'choice-edit' },
          el('button', { type: 'button', class: 'choice-radio', 'data-i': i, text: i + 1, 'aria-label': `${i + 1}번을 정답으로`, onclick: () => pickChoice(i) }),
          el('input', { type: 'text', maxlength: 60, placeholder: `${i + 1}번 보기`, 'data-choice': i })
        )
      );
    }
  }
  function pickChoice(i) {
    correctChoice = i;
    document.querySelectorAll('.choice-radio').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
  }
  buildChoiceEdit();

  $('q-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const data = { type: qType, text: $('q-text').value };
    if (qType === 'short') data.answer = $('q-short').value;
    if (qType === 'choice') {
      data.choices = [...document.querySelectorAll('[data-choice]')].map((i) => i.value);
      data.answer = correctChoice;
      if (correctChoice == null) return ($('q-error').textContent = '정답 번호(동그라미)를 눌러 주세요.');
    }
    if (qType === 'sentence') {
      data.answer = $('q-sentence').value;
      data.keywords = $('q-keywords').value;
    }
    $('q-submit').disabled = true;
    socket.emit('question:create', data, (res) => {
      $('q-submit').disabled = false;
      if (!res?.ok) return ($('q-error').textContent = res?.error || '문제를 저장하지 못했어요.');
      $('q-error').textContent = '';
      $('q-form').reset();
      correctChoice = null;
      pickChoice(-1);
      correctChoice = null;
      toast('문제를 냈어요! 🎉');
    });
  });

  function renderCreate() {
    const mine = state.myQuestions;
    const max = state.settings.maxQuestions;
    $('q-count').textContent = `${mine.length} / ${max}`;
    const full = mine.length >= max;
    $('q-submit').disabled = full;
    $('q-submit').textContent = full ? '문제를 다 냈어요 👍' : '문제 내기 ✨';
    const ul = $('my-questions');
    ul.replaceChildren(
      ...mine.map((q) =>
        el('li', {},
          el('div', { class: 'row' },
            el('span', { class: 'badge ' + q.type, text: TYPE_LABEL[q.type] }),
            el('span', { class: 'spacer' }),
            el('button', { class: 'link-btn', text: '지우기', onclick: () => {
              if (!confirm('이 문제를 지울까요?')) return;
              socket.emit('question:delete', { id: q.id }, (r) => !r?.ok && toast(r?.error || '지우지 못했어요.', true));
            } })
          ),
          el('div', { style: 'margin:6px 0;font-weight:700', text: q.text }),
          q.type === 'choice'
            ? el('div', { class: 'small muted' }, ...q.choices.map((c, i) => el('div', { text: `${i + 1}. ${c}${i === q.answer ? '  ✅' : ''}` })))
            : el('div', { class: 'small muted', text: '정답: ' + q.answer + (q.keywords ? `  (핵심 단어: ${q.keywords})` : '') })
        )
      )
    );
    if (!mine.length) ul.append(el('li', { class: 'muted', text: '아직 낸 문제가 없어요.' }));
  }

  // ───────── 문제 풀기 ─────────
  function requestNext() {
    if (waitingServer) return;
    waitingServer = true;
    socket.emit('play:next', {}, () => {});
    setTimeout(() => (waitingServer = false), 3000);
  }

  socket.on('question', (q) => {
    waitingServer = false;
    const same = current && current.id === q.id && view === 'question';
    current = { ...q, deadline: Date.now() + q.remainingMs, submitted: false };
    if (same) return; // 같은 문제 다시 받음 (재연결)
    $('qq-type').textContent = TYPE_LABEL[q.type];
    $('qq-type').className = 'badge ' + q.type;
    $('qq-num').textContent = `${q.number}번째 문제 · 남은 문제 ${q.left}개`;
    $('qq-text').textContent = q.text;

    const isChoice = q.type === 'choice';
    $('qq-choice').classList.toggle('hidden', !isChoice);
    $('qq-form').classList.toggle('hidden', isChoice);
    $('qq-input').classList.toggle('hidden', q.type !== 'short');
    $('qq-area').classList.toggle('hidden', q.type !== 'sentence');
    $('qq-input').value = '';
    $('qq-area').value = '';
    if (isChoice) {
      $('qq-choice').replaceChildren(
        ...q.choices.map((c, i) =>
          el('button', { class: 'answer-btn', type: 'button', onclick: () => submit(i) },
            el('span', { class: 'num', text: i + 1 }), el('span', { text: c }))
        )
      );
    }
    show('question');
    startTimer();
    if (!isChoice) setTimeout(() => (q.type === 'short' ? $('qq-input') : $('qq-area')).focus(), 50);
  });

  $('qq-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = current?.type === 'sentence' ? $('qq-area').value : $('qq-input').value;
    if (!v.trim()) return toast('답을 입력해 주세요.', true);
    submit(v);
  });

  function submit(answer, timeout = false) {
    if (!current || current.submitted) return;
    current.submitted = true;
    stopTimer();
    const given = answer;
    socket.emit('play:answer', { qid: current.id, answer, timeout }, (res) => {
      if (!res?.ok) {
        toast(res?.error || '다시 시도해 주세요.', true);
        current = null;
        requestNext();
        return;
      }
      showResult(res.result, given);
    });
  }

  socket.on('result', (r) => showResult(r, null));
  socket.on('done', () => {
    waitingServer = false;
    current = null;
    showWait('🎊', '모든 문제를 풀었어요!', '대단해요! 친구들이 다 풀 때까지 기다려요.', true);
  });

  let raf = null;
  function startTimer() {
    stopTimer();
    const bar = $('qq-timer');
    const tick = () => {
      if (!current) return;
      const left = Math.max(0, current.deadline - Date.now());
      const ratio = left / current.limit;
      bar.firstElementChild.style.width = ratio * 100 + '%';
      bar.classList.toggle('hurry', ratio < 0.5 && ratio >= 0.2);
      bar.classList.toggle('danger', ratio < 0.2);
      $('qq-sec').textContent = Math.ceil(left / 1000) + '초';
      if (left <= 0) return submit(null, true);
      raf = requestAnimationFrame(tick);
    };
    tick();
  }
  function stopTimer() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  // ───────── 결과 ─────────
  function showResult(r, given) {
    waitingServer = false;
    current = null;
    const card = $('rs-card');
    card.className = 'card result ' + (r.correct ? 'good' : 'bad');
    if (r.correct) {
      $('rs-emoji').textContent = r.streak >= 3 ? '🔥' : '🎉';
      $('rs-title').textContent = r.streak >= 2 ? `정답! ${r.streak}연속!` : '정답!';
      const pts = [el('div', { class: 'pt' }, '기본', el('b', { text: '+' + r.points.base }))];
      pts.push(el('div', { class: 'pt' }, `⚡ 스피드 (${r.seconds}초)`, el('b', { text: '+' + r.points.speed })));
      if (r.points.streak) pts.push(el('div', { class: 'pt fire' }, `🔥 ${r.streak}연속`, el('b', { text: '+' + r.points.streak })));
      $('rs-points').replaceChildren(el('div', { class: 'total-points', text: '+' + r.points.total + '점' }), el('div', { class: 'points' }, pts));
    } else {
      $('rs-emoji').textContent = r.timedOut ? '⏰' : '😢';
      $('rs-title').textContent = r.timedOut ? '시간 초과!' : '아쉬워요!';
      $('rs-points').replaceChildren(el('p', { class: 'muted', text: '괜찮아요, 다음 문제에서 만회해요! (연속 정답이 초기화됐어요)' }));
      card.classList.add('shake');
    }
    const ans = $('rs-answer');
    ans.replaceChildren(el('div', {}, el('b', { text: r.type === 'sentence' ? '모범 답안: ' : '정답: ' }), r.answerLabel));
    if (r.keywords) ans.append(el('div', { class: 'small muted', text: '핵심 단어: ' + r.keywords }));
    const mine = r.type === 'choice' ? (given == null && r.given == null ? null : `${(given ?? r.given) + 1}번`) : given ?? r.given;
    if (mine != null && !r.correct) ans.append(el('div', { class: 'small muted', text: '내 답: ' + mine }));
    $('rs-score').textContent = r.score.toLocaleString() + '점';
    updateResultRank();
    show('result');
    $('rs-next').focus();
  }

  function updateResultRank() {
    if (!state) return;
    $('rs-rank').textContent = state.me.rank ? `${state.me.rank}등 / ${state.me.total}명` : '-';
    const left = state.remaining;
    $('rs-next').textContent = left === 0 ? '순위 보기 🏆' : '다음 문제 ▶';
  }

  $('rs-next').addEventListener('click', () => {
    if (state?.phase !== 'play') return;
    requestNext();
  });

  // ───────── 끝 ─────────
  function renderEnd() {
    const me = state.me;
    $('end-emoji').textContent = ['🥇', '🥈', '🥉'][me.rank - 1] || '🏁';
    $('end-me').textContent = `${me.name}님은 ${me.rank}등! (${me.score.toLocaleString()}점)`;
    $('end-detail').textContent = `${me.answered}문제 중 ${me.correct}문제 정답 · 최고 연속 정답 ${me.bestStreak}번`;
    renderRank($('end-rank'), state.top);
    show('end');
  }
})();
