(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const KEY = 'booth-teacher-key';
  let filter = 'queue';
  let data = null;
  let seen = null; // 처음 불러온 뒤 새로 들어온 작품 강조
  let settingsDirty = false;

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', 'x-teacher-key': localStorage.getItem(KEY) || '' },
      body: opts.body ? JSON.stringify(opts.body) : opts.method === 'POST' ? '{}' : undefined,
    });
    let d = {};
    try {
      d = await res.json();
    } catch {
      /* */
    }
    if (res.status === 401) {
      showLogin(d.error);
      throw new Error(d.error);
    }
    if (!res.ok) throw new Error(d.error || '서버 오류');
    return d;
  }

  function note(el, text, kind) {
    el.innerHTML = text ? `<div class="notice ${kind}"></div>` : '';
    if (text) el.firstChild.textContent = text;
  }

  function showLogin(err) {
    $('#main').classList.add('hidden');
    $('#login').classList.remove('hidden');
    if (err && localStorage.getItem(KEY)) note($('#loginMsg'), err, 'bad');
  }

  $('#loginBtn').addEventListener('click', () => {
    localStorage.setItem(KEY, $('#pw').value);
    note($('#loginMsg'), '', '');
    refresh(true);
  });
  $('#pw').addEventListener('keydown', (e) => e.key === 'Enter' && $('#loginBtn').click());

  function pill(el, text, kind) {
    el.textContent = text;
    el.className = 'pill ' + kind;
  }

  function fillSettings(s, styles) {
    $('#sTitle').value = s.title;
    $('#sBoard').value = s.boardId;
    $('#sPadletOn').checked = s.padletOn;
    $('#sTries').value = s.maxTries;
    $('#sStyles').innerHTML = '';
    for (const st of styles) {
      const l = document.createElement('label');
      l.innerHTML = `<input type="checkbox" value="${st.id}" /> <span></span>`;
      l.querySelector('input').checked = s.enabledStyles.includes(st.id);
      l.querySelector('span').textContent = `${st.emoji} ${st.name}`;
      $('#sStyles').appendChild(l);
    }
  }
  document.querySelector('aside').addEventListener('input', (e) => {
    if (e.target.closest('.card') && e.target.closest('.card').contains($('#saveSettings'))) settingsDirty = true;
  });

  function renderStatus(st, s) {
    pill($('#stAi'), st.ai === 'ready' ? '연결됨' : st.ai === 'mock' ? '연습 모드(원본 그대로)' : '키 없음', st.ai === 'ready' ? 'ok' : st.ai === 'mock' ? 'mid' : 'no');
    pill($('#stPKey'), st.padletKey ? '있음' : '없음', st.padletKey ? 'ok' : 'no');
    pill(
      $('#stPadlet'),
      !s.padletOn ? '꺼짐(앱 안에만 저장)' : st.padletReady ? '켜짐' : '보드 ID/키 필요',
      !s.padletOn ? 'mid' : st.padletReady ? 'ok' : 'no'
    );
    pill($('#stQueue'), `${st.queue.active} / ${st.queue.waiting}`, st.queue.waiting > 3 ? 'mid' : '');
    $('#studentUrl').textContent = st.studentUrl;
    $('#ovUrl').textContent = st.studentUrl;
    note(
      $('#urlWarn'),
      st.privateUrl && s.padletOn
        ? '지금 주소는 학교 안에서만 열리는 주소라서, 패들렛에 그림이 안 보일 수 있어요. 인터넷 주소(Render 등)로 배포해서 쓰세요.'
        : '',
      'warn'
    );
  }

  const time = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  function filtered(items) {
    if (filter === 'queue') return items.filter((x) => x.sent && !x.printed).sort((a, b) => a.sentAt - b.sentAt);
    if (filter === 'sent') return items.filter((x) => x.sent);
    if (filter === 'error') return items.filter((x) => x.sent && x.padlet.status === 'error');
    return items;
  }

  function padletBadge(p) {
    if (p.status === 'ok') return ['패들렛 ✅', 'ok'];
    if (p.status === 'error') return ['패들렛 실패', 'no'];
    if (p.status === 'off') return ['패들렛 꺼짐', 'mid'];
    return ['', ''];
  }

  function renderGallery() {
    const items = filtered(data.items);
    const g = $('#gallery');
    if (!items.length) {
      g.innerHTML = `<div class="empty"><div class="big-emoji">${filter === 'queue' ? '🖨️' : '🎨'}</div>${
        filter === 'queue' ? '인쇄를 기다리는 작품이 없어요.' : '아직 작품이 없어요.'
      }</div>`;
      return;
    }
    g.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'g-item' + (seen && !seen.has(it.id) ? ' new' : '');
      el.innerHTML = `
        <div class="g-imgs"><img class="main" loading="lazy" /><img class="orig" loading="lazy" /></div>
        <div class="g-body">
          <div class="g-title"></div>
          <div class="muted small meta"></div>
          <div class="row badges"></div>
          <div class="muted small err"></div>
          <div class="g-actions">
            <button class="print">🖨️ 인쇄</button>
            <button class="ghost resend">📤 패들렛</button>
            <button class="ghost dl">💾</button>
            <button class="ghost del">🗑️</button>
          </div>
        </div>`;
      el.querySelector('.main').src = it.resultUrl;
      el.querySelector('.orig').src = it.originalUrl;
      el.querySelector('.g-title').textContent = it.charName ? `${it.charName} · ${it.name}` : it.name;
      el.querySelector('.meta').textContent = `${it.styleEmoji} ${it.styleName} · ${time(it.sentAt || it.createdAt)}${it.intro ? ' · ' + it.intro : ''}`;
      const badges = el.querySelector('.badges');
      const add = (t, k) => {
        if (!t) return;
        const s = document.createElement('span');
        s.className = 'pill ' + k;
        s.textContent = t;
        badges.appendChild(s);
      };
      add(it.sent ? '' : '미전송', 'mid');
      add(...padletBadge(it.padlet));
      add(it.printed ? `인쇄 ${it.printed}회` : '', 'ok');
      if (it.padlet.status === 'error') el.querySelector('.err').textContent = it.padlet.error;
      el.querySelector('.print').addEventListener('click', () => printItem(it));
      el.querySelector('.resend').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const r = await api(`/api/teacher/items/${it.id}/resend`, { method: 'POST' });
          if (!r.ok) alert('패들렛 전송 실패: ' + (r.padlet.error || ''));
        } catch (err) {
          alert(err.message);
        }
        refresh();
      });
      el.querySelector('.dl').addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = it.resultUrl;
        a.download = `${it.name}-${it.styleName}.${it.resultUrl.split('.').pop()}`;
        a.click();
      });
      el.querySelector('.del').addEventListener('click', async () => {
        if (!confirm(`${it.name}의 작품을 지울까요? (패들렛에 올라간 글은 패들렛에서 따로 지워야 해요)`)) return;
        await api(`/api/teacher/items/${it.id}`, { method: 'DELETE' });
        refresh();
      });
      g.appendChild(el);
    }
  }

  function printItem(it) {
    const q = new URLSearchParams({
      id: it.id,
      size: $('#pSize').value,
      orig: $('#pOrig').checked ? '1' : '0',
      text: $('#pText').checked ? '1' : '0',
    });
    window.open('/print?' + q, '_blank', 'width=600,height=800');
  }
  // 인쇄 창에서 인쇄가 끝나면 알려 줌
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data && e.data.type === 'printed') refresh();
  });

  for (const id of ['pSize', 'pOrig', 'pText']) {
    const el = $('#' + id);
    const saved = localStorage.getItem('booth-print-' + id);
    if (saved !== null) el.type === 'checkbox' ? (el.checked = saved === '1') : (el.value = saved);
    el.addEventListener('change', () => localStorage.setItem('booth-print-' + id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value));
  }

  async function refresh(first = false) {
    try {
      data = await api('/api/teacher/state');
    } catch {
      return;
    }
    $('#login').classList.add('hidden');
    $('#main').classList.remove('hidden');
    $('#tTitle').textContent = data.settings.title;
    $('#ovTitle').textContent = data.settings.title;
    const sent = data.items.filter((x) => x.sent).length;
    const queue = data.items.filter((x) => x.sent && !x.printed).length;
    $('#tStats').textContent = `만든 작품 ${data.items.length}개 · 보낸 작품 ${sent}개 · 인쇄 대기 ${queue}개`;
    if (first || !settingsDirty) fillSettings(data.settings, data.allStyles);
    renderStatus(data.status, data.settings);
    renderGallery();
    if (!seen) seen = new Set(data.items.map((x) => x.id));
    if (first && !data.status.passwordSet) {
      note($('#setMsg'), '선생님 비밀번호(TEACHER_PASSWORD)가 설정되지 않아 누구나 이 화면을 열 수 있어요. 행사 전에 꼭 설정하세요.', 'warn');
    }
  }

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    seen = new Set(data.items.map((x) => x.id));
    renderGallery();
  });

  $('#saveSettings').addEventListener('click', async () => {
    try {
      await api('/api/teacher/settings', {
        body: {
          title: $('#sTitle').value,
          boardId: $('#sBoard').value,
          padletOn: $('#sPadletOn').checked,
          maxTries: Number($('#sTries').value),
          enabledStyles: [...document.querySelectorAll('#sStyles input:checked')].map((x) => x.value),
        },
      });
      settingsDirty = false;
      note($('#setMsg'), '저장했어요!', 'good');
      refresh(true);
    } catch (e) {
      note($('#setMsg'), e.message, 'bad');
    }
  });

  $('#testPadlet').addEventListener('click', async () => {
    note($('#testMsg'), '확인 중…', 'warn');
    try {
      const r = await api('/api/teacher/padlet-test', { method: 'POST' });
      note($('#testMsg'), `연결 성공! 보드 이름: ${r.title}`, 'good');
    } catch (e) {
      note($('#testMsg'), '연결 실패: ' + e.message, 'bad');
    }
  });

  $('#resetTries').addEventListener('click', async () => {
    if (!confirm('모든 학생의 변신 횟수를 0으로 되돌릴까요?')) return;
    await api('/api/teacher/reset-tries', { method: 'POST' });
    alert('초기화했어요.');
  });

  $('#clearAll').addEventListener('click', async () => {
    if (prompt('작품과 사진을 모두 지워요. 지우려면 "지우기"를 입력하세요.') !== '지우기') return;
    await api('/api/teacher/clear-all', { method: 'POST' });
    refresh();
  });

  $('#download').addEventListener('click', () => {
    location.href = '/api/teacher/download.zip?key=' + encodeURIComponent(localStorage.getItem(KEY) || '');
  });

  $('#bigQr').addEventListener('click', () => $('#qrOverlay').classList.remove('hidden'));
  $('#closeQr').addEventListener('click', () => $('#qrOverlay').classList.add('hidden'));

  refresh(true);
  setInterval(() => document.visibilityState === 'visible' && refresh(), 4000);
})();
