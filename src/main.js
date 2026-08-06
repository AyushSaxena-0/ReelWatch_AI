import './style.css';

const DEFAULTS = { enabled: true, swipeThreshold: 20, sessionTimeout: 45, volume: 0.8, snoozeUntil: 0 };
const DB_NAME = 'reelwatchai-wellbeing';
const SWIPE_WINDOW = 120000;
const CONTINUOUS_LIMIT = 300000;

const app = document.querySelector('#app');
let settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('reelwatchai-settings') || '{}') };
let session = freshSession();
let db;
let stream;
let detectorTimer;
let lastHandY;
let lastGestureAt = 0;
let overlayTimer;
let activeEventId;

function freshSession() { return { startedAt: 0, lastSwipeAt: 0, swipes: [], alertShown: false }; }
function persistSettings() { localStorage.setItem('reelwatchai-settings', JSON.stringify(settings)); }
function fmtTime(seconds) { const m = Math.floor(seconds / 60); const s = seconds % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function durationMs() { return session.startedAt ? Math.max(0, Date.now() - session.startedAt) : 0; }
function activeSwipes() { const now = Date.now(); return session.swipes.filter(t => now - t <= SWIPE_WINDOW); }
function stateText() {
  if (!settings.enabled) return ['Monitoring paused', 'Alerts are switched off'];
  if (settings.snoozeUntil > Date.now()) return ['Alerts snoozed', `Back at ${new Date(settings.snoozeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`];
  if (!session.startedAt) return ['Ready to monitor', 'Waiting for intentional swipes'];
  return ['Monitoring session', `${session.swipes.length} swipes · ${fmtTime(Math.floor(durationMs() / 1000))}`];
}

function render() {
  const [title, sub] = stateText();
  const count = session.swipes.length;
  const elapsed = Math.floor(durationMs() / 1000);
  const today = new Date().toISOString().slice(0, 10);
  app.innerHTML = `
    <main>
      <header><div class="brand"><span class="mark">R</span><span>ReelWatchAI</span></div><span class="local">● Local-only</span></header>
      <section class="hero">
        <div><p class="eyebrow">DIGITAL WELLBEING</p><h1>Make every scroll<br><em>more intentional.</em></h1><p class="lede">A private, on-device nudge when short-form scrolling starts taking over.</p></div>
        <div class="status-card"><span class="status-dot"></span><div><strong id="state-title">${title}</strong><p id="state-sub">${sub}</p></div></div>
      </section>
      <section class="grid">
        <article class="camera-card" id="camera-card">
          <div class="card-top"><div><p class="eyebrow">GESTURE SENSOR</p><h2>Webcam preview</h2></div><span id="camera-state" class="pill">Camera off</span></div>
          <div class="camera-wrap"><video id="webcam" autoplay muted playsinline></video><div id="camera-placeholder" class="camera-placeholder"><span>⌁</span><p>Enable your camera to detect<br>upward swipe gestures.</p><button id="camera-button">Enable camera</button></div><div class="scanline"></div></div>
          <p class="hint">Detection processes video in this browser only. Nothing is uploaded or shared.</p>
        </article>
        <article class="metrics-card"><div class="card-top"><div><p class="eyebrow">CURRENT SESSION</p><h2>Your rhythm</h2></div><button class="text-button" id="test-swipe">Test swipe</button></div>
          <div class="metrics"><div><span id="swipe-count">${count}</span><p>total swipes</p></div><div><span id="swipe-rate">${rate()}<small>/min</small></span><p>average pace</p></div><div><span id="session-time">${fmtTime(elapsed)}</span><p>session time</p></div></div>
          <div class="progress-label"><span>${count} / ${settings.swipeThreshold + 1} swipe threshold</span><span>${Math.min(100, Math.round(count / (settings.swipeThreshold + 1) * 100))}%</span></div><div class="progress"><i style="width:${Math.min(100, count / (settings.swipeThreshold + 1) * 100)}%"></i></div>
          <div class="next-alert"><span>⌁</span><p>Alert triggers after <strong>${settings.swipeThreshold + 1} swipes in 2 minutes</strong> or <strong>5 minutes of continuous scrolling.</strong></p></div>
        </article>
      </section>
      <section class="lower-grid">
        <article class="panel settings"><div class="panel-heading"><div><p class="eyebrow">PREFERENCES</p><h2>Set your boundaries</h2></div><label class="switch"><input id="enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}><i></i></label></div>
          <div class="setting-row"><div><strong>Swipe threshold</strong><p>Swipes within a two-minute window</p></div><label><input id="threshold" type="range" min="5" max="60" value="${settings.swipeThreshold}"><output id="threshold-output">${settings.swipeThreshold + 1} swipes</output></label></div>
          <div class="setting-row"><div><strong>Session timeout</strong><p>New session after inactivity</p></div><label><select id="timeout"><option value="30">30 seconds</option><option value="45">45 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option></select></label></div>
          <div class="setting-row"><div><strong>Alert volume</strong><p>Warning sound level</p></div><label><input id="volume" type="range" min="0" max="1" step="0.1" value="${settings.volume}"></label></div>
        </article>
        <article class="panel report"><div class="panel-heading"><div><p class="eyebrow">WELLBEING REPORT</p><h2>Today, ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}</h2></div><button class="text-button" id="weekly-report">View week</button></div>
          <div class="report-stats"><div><span id="today-alerts">0</span><p>alerts</p></div><div><span id="today-swipe-total">0</span><p>swipes at alert</p></div><div><span id="today-minutes">0m</span><p>scroll time</p></div></div>
          <div id="event-list" class="events"><p class="empty">No wellbeing alerts today. Keep it intentional.</p></div>
        </article>
      </section>
      <p class="privacy">For personal wellbeing and productivity only. ReelWatchAI never contacts anyone or sends an emergency alert.</p>
    </main>
    <div id="alert-overlay" class="alert-overlay" aria-hidden="true"><div class="alert-box"><span class="alert-icon">!</span><p class="eyebrow">A GENTLE CHECK-IN</p><h2>You've been scrolling for a while.</h2><p>Consider taking a short break. Your attention deserves room to breathe.</p><div class="snoozes"><button data-snooze="5">Snooze 5 min</button><button data-snooze="10">10 min</button><button data-snooze="30">30 min</button></div><button id="dismiss-alert" class="dismiss">I’ll take a break</button></div></div>
    <dialog id="weekly-dialog"><button class="close-dialog">×</button><p class="eyebrow">WEEKLY WELLBEING REPORT</p><h2>Your last 7 days</h2><div id="weekly-content"></div></dialog>
  `;
  bindUI();
  updateReports(today);
}

function rate() { const d = durationMs(); return d ? Math.round(session.swipes.length / (d / 60000)) : 0; }
function updateUI() {
  const [t, s] = stateText();
  document.querySelector('#state-title').textContent = t; document.querySelector('#state-sub').textContent = s;
  document.querySelector('#swipe-count').textContent = session.swipes.length;
  document.querySelector('#swipe-rate').innerHTML = `${rate()}<small>/min</small>`;
  document.querySelector('#session-time').textContent = fmtTime(Math.floor(durationMs() / 1000));
}

function bindUI() {
  document.querySelector('#camera-button')?.addEventListener('click', startCamera);
  document.querySelector('#test-swipe').addEventListener('click', registerSwipe);
  document.querySelector('#enabled').addEventListener('change', e => { settings.enabled = e.target.checked; persistSettings(); updateUI(); });
  document.querySelector('#threshold').addEventListener('input', e => { settings.swipeThreshold = Number(e.target.value); document.querySelector('#threshold-output').textContent = `${settings.swipeThreshold + 1} swipes`; persistSettings(); });
  document.querySelector('#timeout').value = String(settings.sessionTimeout);
  document.querySelector('#timeout').addEventListener('change', e => { settings.sessionTimeout = Number(e.target.value); persistSettings(); });
  document.querySelector('#volume').addEventListener('input', e => { settings.volume = Number(e.target.value); persistSettings(); });
  document.querySelectorAll('[data-snooze]').forEach(b => b.addEventListener('click', () => snooze(Number(b.dataset.snooze))));
  document.querySelector('#dismiss-alert').addEventListener('click', dismissAlert);
  document.querySelector('#weekly-report').addEventListener('click', showWeekly);
  document.querySelector('.close-dialog').addEventListener('click', () => document.querySelector('#weekly-dialog').close());
}

function registerSwipe() {
  const now = Date.now();
  if (session.lastSwipeAt && now - session.lastSwipeAt > settings.sessionTimeout * 1000) session = freshSession();
  if (!session.startedAt) session.startedAt = now;
  session.lastSwipeAt = now; session.swipes.push(now); session.swipes = activeSwipes();
  updateUI();
  if (settings.enabled && !session.alertShown && settings.snoozeUntil <= now && (session.swipes.length > settings.swipeThreshold || durationMs() > CONTINUOUS_LIMIT)) triggerAlert(session.swipes.length > settings.swipeThreshold ? 'Swipe threshold exceeded' : 'Continuous scrolling exceeded 5 minutes');
}

function tick() { if (session.lastSwipeAt && Date.now() - session.lastSwipeAt > settings.sessionTimeout * 1000) session = freshSession(); updateUI(); if (settings.enabled && session.startedAt && !session.alertShown && settings.snoozeUntil <= Date.now() && durationMs() > CONTINUOUS_LIMIT) triggerAlert('Continuous scrolling exceeded 5 minutes'); }

function triggerAlert(reason) { session.alertShown = true; playTone(); const card = document.querySelector('#camera-card'); card?.classList.add('warning'); const overlay = document.querySelector('#alert-overlay'); overlay.classList.add('visible'); overlay.setAttribute('aria-hidden', 'false'); logEvent({ timestamp: Date.now(), sessionDuration: durationMs(), swipeCount: session.swipes.length, swipeRate: rate(), reason, alertDuration: 0 }).then(id => activeEventId = id); overlayTimer = Date.now(); }
function dismissAlert() { if (activeEventId && overlayTimer) updateAlertDuration(activeEventId, Date.now() - overlayTimer); activeEventId = undefined; overlayTimer = undefined; const overlay = document.querySelector('#alert-overlay'); overlay.classList.remove('visible'); overlay.setAttribute('aria-hidden', 'true'); document.querySelector('#camera-card')?.classList.remove('warning'); session = freshSession(); updateUI(); }
function snooze(minutes) { settings.snoozeUntil = Date.now() + minutes * 60000; persistSettings(); dismissAlert(); }
function playTone() { try { const ctx = new AudioContext(); const gain = ctx.createGain(); gain.gain.value = settings.volume; gain.connect(ctx.destination); [0, .28, .56].forEach(offset => { const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(gain); o.start(ctx.currentTime + offset); o.stop(ctx.currentTime + offset + .18); }); } catch {} }

async function startCamera() { try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false }); const video = document.querySelector('#webcam'); video.srcObject = stream; document.querySelector('#camera-placeholder').hidden = true; document.querySelector('#camera-state').textContent = 'Camera on'; document.querySelector('#camera-state').classList.add('on'); startMotionDetection(video); } catch (error) { document.querySelector('#camera-placeholder p').textContent = 'Camera access was unavailable. You can still test the detection manually.'; } }
function startMotionDetection(video) { const canvas = document.createElement('canvas'); const c = canvas.getContext('2d', { willReadFrequently: true }); let previous = null; detectorTimer = setInterval(() => { if (video.readyState < 2) return; canvas.width = 80; canvas.height = 60; c.drawImage(video, 0, 0, 80, 60); const data = c.getImageData(0, 0, 80, 60).data; if (previous) { let weightedY = 0, motion = 0; for (let y = 5; y < 55; y++) for (let x = 15; x < 65; x++) { const i = (y * 80 + x) * 4; const diff = Math.abs(data[i] - previous[i]) + Math.abs(data[i+1] - previous[i+1]) + Math.abs(data[i+2] - previous[i+2]); if (diff > 120) { weightedY += y * diff; motion += diff; } } if (motion > 18000) { const y = weightedY / motion; if (lastHandY && y < lastHandY - 7 && Date.now() - lastGestureAt > 700) { lastGestureAt = Date.now(); registerSwipe(); } lastHandY = y; } } previous = data; }, 120); }

function openDB() { return new Promise((resolve, reject) => { const req = indexedDB.open(DB_NAME, 1); req.onupgradeneeded = () => req.result.createObjectStore('alerts', { keyPath: 'id', autoIncrement: true }); req.onsuccess = () => { db = req.result; resolve(); }; req.onerror = () => reject(req.error); }); }
function logEvent(event) { const tx = db.transaction('alerts', 'readwrite'); const request = tx.objectStore('alerts').add(event); tx.oncomplete = () => updateReports(new Date().toISOString().slice(0, 10)); return new Promise(resolve => request.onsuccess = () => resolve(request.result)); }
function updateAlertDuration(id, alertDuration) { const tx = db.transaction('alerts', 'readwrite'); const store = tx.objectStore('alerts'); const request = store.get(id); request.onsuccess = () => { const event = request.result; if (event) { event.alertDuration = alertDuration; store.put(event); } }; tx.oncomplete = () => updateReports(new Date().toISOString().slice(0, 10)); }
function allEvents() { return new Promise(resolve => { if (!db) return resolve([]); const req = db.transaction('alerts').objectStore('alerts').getAll(); req.onsuccess = () => resolve(req.result || []); }); }
async function updateReports(today) { const items = await allEvents(); const todays = items.filter(e => new Date(e.timestamp).toISOString().slice(0, 10) === today); document.querySelector('#today-alerts').textContent = todays.length; document.querySelector('#today-swipe-total').textContent = todays.reduce((n, e) => n + e.swipeCount, 0); document.querySelector('#today-minutes').textContent = `${Math.round(todays.reduce((n, e) => n + e.sessionDuration, 0) / 60000)}m`; document.querySelector('#event-list').innerHTML = todays.length ? todays.slice().reverse().map(e => `<div class="event"><span class="event-dot"></span><div><strong>${e.reason}</strong><p>${new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${e.swipeCount} swipes · ${fmtTime(Math.round(e.sessionDuration / 1000))}</p></div></div>`).join('') : '<p class="empty">No wellbeing alerts today. Keep it intentional.</p>'; }
async function showWeekly() { const items = await allEvents(); const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); const key = d.toISOString().slice(0, 10); return { label: d.toLocaleDateString([], { weekday: 'short' }), value: items.filter(e => new Date(e.timestamp).toISOString().slice(0, 10) === key).length }; }); const max = Math.max(1, ...days.map(d => d.value)); document.querySelector('#weekly-content').innerHTML = `<div class="week-chart">${days.map(d => `<div><i style="height:${d.value / max * 120}px"></i><span>${d.value}</span><small>${d.label}</small></div>`).join('')}</div><p class="dialog-note">${items.filter(e => e.timestamp > Date.now() - 6048e5).length} wellbeing alerts in the last 7 days. Your data stays on this device.</p>`; document.querySelector('#weekly-dialog').showModal(); }

render(); openDB().then(() => updateReports(new Date().toISOString().slice(0, 10))); setInterval(tick, 1000);
