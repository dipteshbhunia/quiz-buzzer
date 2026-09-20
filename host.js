(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io();
  const STORE = 'qb.host';

  let session = null; // { code, hostToken }
  try { session = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { /* ignore */ }
  let state = null;
  let prev = null;
  let muted = false;
  let audio = null;

  // ------------------------------------------------------------ sound
  function beep(freq, dur, type = 'sine', gain = 0.25) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(gain, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + dur);
    } catch (e) { /* audio not available */ }
  }
  const soundWinner = () => { beep(880, 0.18, 'square'); setTimeout(() => beep(1320, 0.35, 'square'), 140); };
  const soundEarly = () => beep(160, 0.25, 'sawtooth', 0.18);

  // ------------------------------------------------------------ views
  function show(view) {
    $('login').hidden = view !== 'login';
    $('dash').hidden = view !== 'dash';
    if (view === 'login') $('pw').focus();
  }

  function setConn(ok) {
    $('connDot').className = 'dot ' + (ok ? 'on' : 'warn');
    $('connText').textContent = ok ? 'Live' : 'Reconnecting…';
  }

  function clearSession(msg) {
    session = null;
    state = null;
    prev = null;
    localStorage.removeItem(STORE);
    $('loginError').textContent = msg || '';
    show('login');
  }

  // ------------------------------------------------------------ login / resume
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('loginError').textContent = '';
    socket.emit('host:create', { password: $('pw').value }, (res) => {
      if (!res || !res.ok) {
        $('loginError').textContent = (res && res.error) || 'Could not connect.';
        return;
      }
      $('pw').value = '';
      session = { code: res.code, hostToken: res.hostToken };
      localStorage.setItem(STORE, JSON.stringify(session));
      show('dash');
      beep(1, 0.01, 'sine', 0.0001); // unlock audio inside a user gesture
      render(res.state);
    });
  });

  function resume() {
    if (!session) return show('login');
    socket.emit('host:resume', session, (res) => {
      if (!res || !res.ok) return clearSession('Your previous room has ended. Start a new one.');
      show('dash');
      render(res.state);
    });
  }

  socket.on('connect', () => { setConn(true); resume(); });
  socket.on('disconnect', () => setConn(false));
  socket.on('host:state', render);
  socket.on('room:closed', () => clearSession('The session was ended.'));

  // ------------------------------------------------------------ rendering
  function li(cls, parts) {
    const el = document.createElement('li');
    if (cls) el.className = cls;
    parts.forEach((p) => el.appendChild(p));
    return el;
  }
  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }
  const names = (arr) => arr.map((x) => x.name).join(', ');

  function render(s) {
    prev = state;
    state = s;

    // room header / join card
    $('roomCode').textContent = s.code;
    const joinUrl = `${location.origin}/play?room=${s.code}`;
    $('joinUrl').textContent = joinUrl;
    const qr = `/qr.svg?room=${s.code}`;
    if ($('qr').getAttribute('src') !== qr) $('qr').src = qr;
    $('lockoutToggle').checked = !!s.settings.lockoutEarly;

    // stage
    const stage = $('stage');
    stage.dataset.state = s.state;
    if (s.state === 'locked') {
      $('stageLabel').textContent = s.round === 0 ? 'Ready for the first question' : 'Buzzers are locked';
      $('stageHeadline').textContent = 'LOCKED';
      $('stageSub').textContent = s.early.length
        ? `${names(s.early)} pressed early. Not counted.`
        : 'Ask the question, then press Open buzzers.';
    } else if (s.state === 'open') {
      $('stageLabel').textContent = `Question ${s.round}: buzzers are open`;
      $('stageHeadline').textContent = 'GO!';
      $('stageSub').textContent = s.blocked.length
        ? 'Waiting for a buzz. Players who already had a turn are locked out.'
        : 'Waiting for the first buzz…';
    } else {
      const w = s.buzzes[0];
      $('stageLabel').textContent = `Question ${s.round}: first to buzz`;
      $('stageHeadline').textContent = w ? w.name : '';
      const more = s.buzzes.length - 1;
      $('stageSub').textContent = more > 0 ? `${more} more waiting in line.` : 'Nobody else has buzzed yet.';
    }
    $('openBtn').disabled = s.state !== 'locked';
    $('correctBtn').hidden = s.state !== 'buzzed';
    $('wrongBtn').hidden = s.state !== 'buzzed';

    // sounds
    const winnerNow = s.state === 'buzzed' && s.buzzes[0] ? s.buzzes[0].key : null;
    const winnerBefore = prev && prev.state === 'buzzed' && prev.buzzes[0] ? prev.buzzes[0].key : null;
    if (winnerNow && winnerNow !== winnerBefore) soundWinner();
    if (prev && s.early.length > prev.early.length) soundEarly();

    // buzz order
    const bl = $('buzzList');
    bl.replaceChildren(...s.buzzes.map((b, i) =>
      li('', [span('n', String(i + 1)), span('nm', b.name), span('ms', i === 0 ? 'first' : `+${b.delta.toFixed(1)} ms`)])));
    $('buzzEmpty').hidden = s.buzzes.length > 0;

    // early
    const el = $('earlyList');
    el.replaceChildren(...s.early.map((e) => li('', [span('nm', e.name), span('ms', 'not counted')])));
    $('earlyEmpty').hidden = s.early.length > 0;

    renderPlayers(s);
  }

  function renderPlayers(s) {
    $('onlineCount').textContent = `${s.online} online / ${s.players.length} joined`;
    $('playersEmpty').hidden = s.players.length > 0;
    const ul = $('players');
    ul.replaceChildren(...s.players.map((p) => {
      const dot = document.createElement('span');
      dot.className = 'dot ' + (p.connected ? 'on' : 'off');
      dot.title = p.connected ? 'Online' : 'Offline';

      const nm = span('nm', p.name);

      const score = document.createElement('span');
      score.className = 'score';
      const minus = btn('−', `Remove a point from ${p.name}`, () => socket.emit('host:score', { key: p.key, delta: -1 }));
      const val = document.createElement('b');
      val.textContent = p.score;
      const plus = btn('+', `Give a point to ${p.name}`, () => socket.emit('host:score', { key: p.key, delta: 1 }));
      score.append(minus, val, plus);

      const kick = btn('✕', `Remove ${p.name}`, () => {
        if (confirm(`Remove ${p.name} from the room?`)) socket.emit('host:kick', { key: p.key });
      });
      const row = li(p.connected ? '' : 'off', [dot, nm, score, kick]);
      return row;
    }));
  }

  function btn(label, aria, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  }

  // ------------------------------------------------------------ actions
  const open = () => socket.emit('host:open');
  const reset = () => socket.emit('host:reset');
  const wrong = () => socket.emit('host:wrong');
  const correct = () => {
    if (!state || state.state !== 'buzzed' || !state.buzzes[0]) return;
    socket.emit('host:score', { key: state.buzzes[0].key, delta: 1 });
    reset();
  };

  $('openBtn').addEventListener('click', open);
  $('resetBtn').addEventListener('click', reset);
  $('wrongBtn').addEventListener('click', wrong);
  $('correctBtn').addEventListener('click', correct);
  $('lockoutToggle').addEventListener('change', (e) => socket.emit('host:settings', { lockoutEarly: e.target.checked }));

  $('muteBtn').addEventListener('click', (e) => {
    muted = !muted;
    e.target.textContent = muted ? 'Sound off' : 'Sound on';
    e.target.setAttribute('aria-pressed', String(muted));
  });

  $('copyBtn').addEventListener('click', async (e) => {
    const url = $('joinUrl').textContent;
    try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copied'; }
    catch (err) { e.target.textContent = 'Select the link and copy'; }
    setTimeout(() => (e.target.textContent = 'Copy join link'), 1800);
  });

  $('endBtn').addEventListener('click', () => {
    if (!confirm('End this session? Players will be disconnected and the room code will stop working.')) return;
    socket.emit('host:end');
    clearSession('');
  });

  document.addEventListener('keydown', (e) => {
    if ($('dash').hidden || e.ctrlKey || e.metaKey || e.altKey || !state) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input') return;
    if (e.code === 'Space' && tag !== 'button') {
      e.preventDefault();
      if (state.state === 'locked') open();
    } else if (e.key === 'r' || e.key === 'R') reset();
    else if (e.key === 'w' || e.key === 'W') wrong();
    else if (e.key === 'c' || e.key === 'C') correct();
  });
})();
