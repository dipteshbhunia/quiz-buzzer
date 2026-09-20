(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io();
  const STORE = 'qb.player';

  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);

  let creds = null; // { code, name, token }
  try { creds = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { /* ignore */ }
  // a saved login for a different room is not reusable, but keep the name as a convenience
  let savedName = creds ? creds.name : '';
  if (creds && urlRoom && creds.code !== urlRoom) creds = null;

  let joined = false;
  let joining = false;
  let wakeLock = null;

  // ------------------------------------------------------------ helpers
  let toastTimer;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
  }
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* ignore */ } };

  function showJoin(msg) {
    joined = false;
    $('game').hidden = true;
    $('join').hidden = false;
    $('code').value = urlRoom || (creds ? creds.code : '') || '';
    $('name').value = savedName || '';
    $('joinError').textContent = msg || '';
    (($('code').value ? $('name') : $('code'))).focus();
  }

  function showGame() {
    $('join').hidden = true;
    $('game').hidden = false;
    requestWake();
  }

  async function requestWake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => (wakeLock = null));
      }
    } catch (e) { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && joined) requestWake(); });

  // ------------------------------------------------------------ joining
  function doJoin(code, name, token, manual) {
    if (joining) return;
    joining = true;
    socket.emit('player:join', { code, name, token }, (res) => {
      joining = false;
      if (!res || !res.ok) {
        const msg = (res && res.error) || 'Could not join.';
        if (manual) { $('joinError').textContent = msg; return; }
        // automatic re-join failed (room gone, or ID no longer ours)
        creds = null;
        localStorage.removeItem(STORE);
        showJoin(msg);
        return;
      }
      creds = { code, name: res.name, token: res.token };
      savedName = res.name;
      localStorage.setItem(STORE, JSON.stringify(creds));
      joined = true;
      $('me').textContent = res.name;
      $('roomTag').textContent = 'Room ' + code;
      showGame();
      render(res.state);
    });
  }

  $('code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    $('joinError').textContent = '';
    const code = $('code').value.trim().toUpperCase();
    const name = $('name').value.trim();
    // reuse our token only when re-joining the same room with the same ID
    const token = creds && creds.code === code && creds.name.toLowerCase() === name.toLowerCase() ? creds.token : undefined;
    doJoin(code, name, token, true);
  });

  socket.on('connect', () => {
    $('offline').hidden = true;
    $('dot').className = 'dot on';
    if (creds) doJoin(creds.code, creds.name, creds.token, false); // first load or reconnect
    else if ($('join').hidden && $('game').hidden) showJoin('');
  });
  socket.on('disconnect', () => {
    $('offline').hidden = false;
    $('dot').className = 'dot warn';
  });

  socket.on('player:kicked', () => {
    creds = null; savedName = '';
    localStorage.removeItem(STORE);
    showJoin('The organizer removed you from the room.');
  });
  socket.on('room:closed', () => {
    creds = null;
    localStorage.removeItem(STORE);
    showJoin('The organizer ended this session.');
  });

  $('leave').addEventListener('click', () => {
    if (!confirm('Leave this room?')) return;
    socket.emit('player:leave');
    creds = null; savedName = '';
    localStorage.removeItem(STORE);
    showJoin('');
  });

  // ------------------------------------------------------------ rendering
  const buzzer = $('buzzer');
  function setUI(mode, label, title, text) {
    buzzer.dataset.mode = mode;
    buzzer.textContent = label;
    $('statusTitle').textContent = title;
    $('statusText').textContent = text;
  }

  function render(s) {
    $('me').textContent = s.name;
    $('score').textContent = s.score ? `${s.score} pts` : '';

    if (s.state === 'locked') {
      const text = s.lockedOut
        ? 'You pressed early, so you are locked out of this question.'
        : s.early
          ? 'You pressed early and it did not count. Wait for the go.'
          : 'Wait for the organizer to say go. Pressing now does not count.';
      setUI('wait', 'WAIT', s.round === 0 ? 'Waiting to start' : 'Get ready', text);
    } else if (s.state === 'open') {
      if (s.lockedOut) setUI('blocked', 'OUT', 'Locked out', 'You cannot buzz on this question.');
      else setUI('go', 'BUZZ!', 'Go!', 'Tap the button now.');
    } else {
      if (s.winnerIsMe) setUI('won', 'FIRST!', 'You buzzed first', 'Give your answer.');
      else if (s.position) setUI('queued', '#' + s.position, `${s.winner} buzzed first`, `You are number ${s.position} in line.`);
      else if (s.lockedOut) setUI('blocked', 'OUT', `${s.winner} buzzed first`, 'You cannot buzz on this question.');
      else setUI('lost', 'BUZZ', `${s.winner} buzzed first`, 'Tap to join the line in case they miss.');
    }
  }
  socket.on('player:state', render);

  socket.on('buzz:result', (r) => {
    if (r.status === 'early') {
      vibrate([80, 60, 80]);
      toast(r.lockedOut ? 'Too early! You are locked out of this question.' : 'Too early! That press did not count.', 'bad');
      buzzer.classList.remove('shake');
      void buzzer.offsetWidth;
      buzzer.classList.add('shake');
    } else if (r.status === 'accepted') {
      if (r.first) { vibrate([30, 40, 120]); toast('You buzzed first!', 'good'); }
      else toast(`You are number ${r.position} in line`, '');
    } else if (r.status === 'blocked') {
      toast('You are locked out of this question.', 'bad');
    }
  });

  // ------------------------------------------------------------ the buzzer itself
  function press() {
    if (!joined) return;
    if (!socket.connected) {
      // never queue a press while offline: it would arrive late and unfairly
      toast('No connection. Wait for it to come back.', 'bad');
      return;
    }
    buzzer.classList.add('pressed');
    vibrate(20);
    socket.emit('player:buzz');
  }
  const release = () => buzzer.classList.remove('pressed');

  buzzer.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => buzzer.addEventListener(ev, release));
  buzzer.addEventListener('contextmenu', (e) => e.preventDefault());
  buzzer.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); press(); }
  });
  buzzer.addEventListener('keyup', release);

  // stop iOS pinch / double-tap zoom on the page
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  if (!creds) showJoin('');
})();
