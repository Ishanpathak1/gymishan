// GYMISHAN – Cardio proof app (camera-only)
// Data is stored locally in localStorage. No uploads.

const DEFAULT_MACHINES = ["Elliptical", "Treadmill"];

// Utility
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const formatMMSS = (totalSeconds) => {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

// Local storage keys
const LS_KEYS = {
  MACHINES: "gymishan_machines",
  CALENDAR: "gymishan_calendar", // { 'YYYY-MM-DD': 'done' | 'missed' }
  SESSION: "gymishan_session", // in-progress session snapshot
  ENROLL: "gymishan_enroll", // { [machineName]: { hash: string, size: [w,h] } }
};

// Session state (in-memory)
let state = {
  plan: [], // [{ machine: string, minutes: number }]
  currentIndex: 0,
  slackMinutes: 1,
  totalMinutes: 60,
  segmentStartAt: null, // epoch ms when current segment timer started
  // Capture windows are relative to segment start (or previous capture)
  windowStartSec: 0, // earliest allowed seconds
  windowEndSec: 0, // latest allowed seconds
  cameraStream: null,
};

// DOM elements
const totalInput = $("#total-mins");
const slackInput = $("#slack-mins");
const machinesList = $("#machines-list");
const newMachineInput = $("#new-machine");
const addMachineBtn = $("#add-machine-btn");
const generateBtn = $("#generate-plan");
const resetBtn = $("#reset-plan");
const planSection = $("#plan-section");
const planList = $("#plan-list");
const startSessionBtn = $("#start-session");
const sessionSection = $("#session-section");
const segmentTitle = $("#segment-title");
const countdownEl = $("#countdown");
const windowLabel = $("#window-label");
const statusLabel = $("#status-label");
const openCameraBtn = $("#open-camera");
const captureBtn = $("#capture-btn");
const closeCameraBtn = $("#close-camera");
const videoEl = $("#camera-stream");
const canvasEl = $("#capture-canvas");
const doneSection = $("#done-section");
const newPlanBtn = $("#new-plan");
// Auth UI
const signInBtn = $("#sign-in");
const signOutBtn = $("#sign-out");
const userBadge = $("#user-badge");

// Calendar
const calendarGrid = $("#calendar-grid");
const monthLabel = $("#month-label");
const prevMonthBtn = $("#prev-month");
const nextMonthBtn = $("#next-month");

let currentMonth = new Date();

// Enrollment DOM
const enrollSection = $("#enroll-section");
const enrollLabel = $("#enroll-machine-label");
const enrollVideo = $("#enroll-video");
const enrollCanvas = $("#enroll-canvas");
const enrollOpenBtn = $("#enroll-open");
const enrollCaptureBtn = $("#enroll-capture");
const enrollCloseBtn = $("#enroll-close");
const enrollDoneBtn = $("#enroll-done");
let enrollStream = null;
let enrollingMachine = null;

// Storage helpers
function loadMachines() {
  try {
    const raw = localStorage.getItem(LS_KEYS.MACHINES);
    if (!raw) return DEFAULT_MACHINES.slice();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_MACHINES.slice();
    return arr;
  } catch {
    return DEFAULT_MACHINES.slice();
  }
}

function saveMachines(arr) {
  localStorage.setItem(LS_KEYS.MACHINES, JSON.stringify(arr));
}

function getEnrollMap() {
  try {
    const raw = localStorage.getItem(LS_KEYS.ENROLL);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setEnroll(machineName, payload) {
  const map = getEnrollMap();
  map[machineName] = payload; // { hash, size:[w,h] }
  localStorage.setItem(LS_KEYS.ENROLL, JSON.stringify(map));
}

function deleteEnroll(machineName) {
  const map = getEnrollMap();
  delete map[machineName];
  localStorage.setItem(LS_KEYS.ENROLL, JSON.stringify(map));
}

function setCalendarDay(dateStr, status) {
  const map = getCalendarMap();
  map[dateStr] = status; // 'done' | 'missed'
  localStorage.setItem(LS_KEYS.CALENDAR, JSON.stringify(map));
}

function getCalendarMap() {
  try {
    const raw = localStorage.getItem(LS_KEYS.CALENDAR);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSessionSnapshot() {
  localStorage.setItem(LS_KEYS.SESSION, JSON.stringify({
    plan: state.plan,
    currentIndex: state.currentIndex,
    slackMinutes: state.slackMinutes,
    totalMinutes: state.totalMinutes,
    segmentStartAt: state.segmentStartAt,
    windowStartSec: state.windowStartSec,
    windowEndSec: state.windowEndSec,
  }));
}

function clearSessionSnapshot() {
  localStorage.removeItem(LS_KEYS.SESSION);
}

function maybeHydrateSession() {
  try {
    const raw = localStorage.getItem(LS_KEYS.SESSION);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || !Array.isArray(snap.plan) || snap.plan.length === 0) return false;
    state.plan = snap.plan;
    state.currentIndex = snap.currentIndex || 0;
    state.slackMinutes = snap.slackMinutes || 1;
    state.totalMinutes = snap.totalMinutes || 60;
    state.segmentStartAt = snap.segmentStartAt || null;
    state.windowStartSec = snap.windowStartSec || 0;
    state.windowEndSec = snap.windowEndSec || 0;
    return true;
  } catch {
    return false;
  }
}

// UI helpers
function renderMachinesChips() {
  const machines = loadMachines();
  machinesList.innerHTML = "";
  machines.forEach((name, idx) => {
    const el = document.createElement("span");
    el.className = "chip";
    const enrolled = !!getEnrollMap()[name];
    const badge = enrolled ? "✅" : "⚠";
    el.innerHTML = `${name} <small style="opacity:.7">${badge}</small> <button class="btn ghost" data-enroll="${idx}">Enroll</button> <span class="x" data-idx="${idx}" aria-label="remove">✕</span>`;
    machinesList.appendChild(el);
  });
}

function randomSplit(totalMinutes, items) {
  // For now: two segments only if exactly two machines selected.
  // If more machines in future, distribute by random weights.
  if (items.length === 1) return [{ machine: items[0], minutes: totalMinutes }];
  if (items.length === 2) {
    const minEach = Math.max(5, Math.floor(totalMinutes * 0.2));
    const maxEach = totalMinutes - minEach;
    const first = clamp(Math.floor(Math.random() * (maxEach - minEach + 1)) + minEach, 5, totalMinutes - 5);
    const second = totalMinutes - first;
    // Shuffle which machine gets which chunk
    const shuffled = Math.random() < 0.5 ? [items[0], items[1]] : [items[1], items[0]];
    return [
      { machine: shuffled[0], minutes: first },
      { machine: shuffled[1], minutes: second },
    ];
  }
  // 3+ machines: proportional random
  const weights = items.map(() => Math.random());
  const sum = weights.reduce((a, b) => a + b, 0);
  const segments = items.map((m, i) => ({ machine: m, minutes: Math.max(5, Math.round((weights[i] / sum) * totalMinutes)) }));
  // normalize to exact total
  const diff = totalMinutes - segments.reduce((a, s) => a + s.minutes, 0);
  if (diff !== 0) segments[0].minutes += diff;
  return segments;
}

function renderPlan() {
  planList.innerHTML = "";
  state.plan.forEach((seg, i) => {
    const li = document.createElement("li");
    li.textContent = `${i + 1}. ${seg.machine} – ${seg.minutes} min`;
    planList.appendChild(li);
  });
}

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

function setButtonsDuringSession(disabled) {
  totalInput.disabled = disabled;
  slackInput.disabled = disabled;
  addMachineBtn.disabled = disabled;
  generateBtn.disabled = disabled;
  resetBtn.disabled = disabled;
}

function startSegmentTimer(nowMs) {
  state.segmentStartAt = nowMs;
  const seg = state.plan[state.currentIndex];
  const targetSec = seg.minutes * 60;
  state.windowStartSec = Math.max(0, targetSec - state.slackMinutes * 60);
  state.windowEndSec = targetSec + state.slackMinutes * 60;
  saveSessionSnapshot();
}

let rafId = null;
function tick() {
  if (!state.segmentStartAt) return;
  const now = Date.now();
  const elapsedSec = Math.floor((now - state.segmentStartAt) / 1000);
  const seg = state.plan[state.currentIndex];
  const targetSec = seg.minutes * 60;
  const remaining = Math.max(0, targetSec - elapsedSec);
  countdownEl.textContent = formatMMSS(remaining);
  windowLabel.textContent = `Window: ${formatMMSS(state.windowStartSec)} to ${formatMMSS(state.windowEndSec)}`;

  if (elapsedSec < state.windowStartSec) {
    statusLabel.textContent = `Too early. Wait ${formatMMSS(state.windowStartSec - elapsedSec)}.`;
    captureBtn.disabled = true;
  } else if (elapsedSec > state.windowEndSec) {
    statusLabel.textContent = `Too late. Segment failed.`;
    captureBtn.disabled = true;
  } else {
    statusLabel.textContent = `Within window. Capture allowed.`;
    captureBtn.disabled = !state.cameraStream;
  }

  rafId = requestAnimationFrame(tick);
}

async function openCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    state.cameraStream = stream;
    videoEl.srcObject = stream;
    openCameraBtn.disabled = true;
    closeCameraBtn.hidden = false;
    captureBtn.disabled = false;
  } catch (e) {
    alert("Camera permission is required. Please enable it in your browser settings.");
  }
}

function closeCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  videoEl.srcObject = null;
  openCameraBtn.disabled = false;
  closeCameraBtn.hidden = true;
  captureBtn.disabled = true;
}

function getTodayStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderCalendar(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  monthLabel.textContent = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  calendarGrid.innerHTML = "";
  const first = new Date(year, month, 1);
  const startDay = first.getDay(); // 0..6
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const calMap = getCalendarMap();
  const todayStr = getTodayStr(new Date());

  for (let i = 0; i < startDay; i++) {
    const filler = document.createElement("div");
    filler.className = "day future";
    filler.style.visibility = "hidden";
    calendarGrid.appendChild(filler);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement("div");
    const dateObj = new Date(year, month, d);
    const dateStr = getTodayStr(dateObj);
    const status = calMap[dateStr];
    cell.className = "day";
    if (dateStr === todayStr) cell.classList.add("today");
    if (status === "done" || status === "missed") {
      cell.classList.add(status);
    } else {
      if (dateStr < todayStr) {
        cell.classList.add("missed");
      } else {
        cell.classList.add("future");
      }
    }
    cell.innerHTML = `<div>${d}</div><div class="marker"></div>`;
    calendarGrid.appendChild(cell);
  }
}

function bindEvents() {
  addMachineBtn.addEventListener("click", () => {
    const name = (newMachineInput.value || "").trim();
    if (!name) return;
    const list = loadMachines();
    if (!list.includes(name)) {
      list.push(name);
      saveMachines(list);
      renderMachinesChips();
      newMachineInput.value = "";
    }
  });

  machinesList.addEventListener("click", (e) => {
    const enrollBtn = e.target.closest("button[data-enroll]");
    if (enrollBtn) {
      const idx = Number(enrollBtn.dataset.enroll);
      const list = loadMachines();
      enrollingMachine = list[idx];
      enrollLabel.textContent = `Enrolling: ${enrollingMachine}`;
      show(enrollSection);
      window.scrollTo({ top: enrollSection.offsetTop - 8, behavior: "smooth" });
      return;
    }
    const x = e.target.closest(".x");
    if (x) {
      const idx = Number(x.dataset.idx);
      const list = loadMachines();
      if (list.length <= 1) return; // keep at least one
      deleteEnroll(list[idx]);
      list.splice(idx, 1);
      saveMachines(list);
      renderMachinesChips();
    }
  });

  generateBtn.addEventListener("click", () => {
    const total = clamp(parseInt(totalInput.value || "60", 10), 5, 240);
    const slack = clamp(parseInt(slackInput.value || "1", 10), 0, 5);
    const machines = loadMachines();
    const picked = machines.filter(Boolean);
    if (picked.length === 0) {
      alert("Please keep at least one machine.");
      return;
    }
    state.totalMinutes = total;
    state.slackMinutes = slack;
    state.plan = randomSplit(total, picked);
    state.currentIndex = 0;
    renderPlan();
    show(planSection);
    resetBtn.disabled = false;
    saveSessionSnapshot();
  });

  resetBtn.addEventListener("click", () => {
    state = {
      plan: [],
      currentIndex: 0,
      slackMinutes: clamp(parseInt(slackInput.value || "1", 10), 0, 5),
      totalMinutes: clamp(parseInt(totalInput.value || "60", 10), 5, 240),
      segmentStartAt: null,
      windowStartSec: 0,
      windowEndSec: 0,
      cameraStream: null,
    };
    hide(planSection);
    hide(sessionSection);
    hide(doneSection);
    setButtonsDuringSession(false);
    clearSessionSnapshot();
    closeCamera();
  });

  startSessionBtn.addEventListener("click", () => {
    if (!state.plan.length) return;
    // Ensure enrollment exists for each segment machine
    const enrollMap = getEnrollMap();
    const missing = state.plan.find((s) => !enrollMap[s.machine]);
    if (missing) {
      alert(`Please enroll reference for ${missing.machine} before starting.`);
      return;
    }
    setButtonsDuringSession(true);
    show(sessionSection);
    hide(doneSection);
    state.currentIndex = 0;
    segmentTitle.textContent = `Segment ${state.currentIndex + 1}/${state.plan.length}: ${state.plan[state.currentIndex].machine} – ${state.plan[state.currentIndex].minutes} min`;
    startSegmentTimer(Date.now());
    if (rafId) cancelAnimationFrame(rafId);
    tick();
  });

  openCameraBtn.addEventListener("click", openCamera);
  closeCameraBtn.addEventListener("click", closeCamera);

  captureBtn.addEventListener("click", () => {
    if (!state.cameraStream || !state.segmentStartAt) return;
    const now = Date.now();
    const elapsedSec = Math.floor((now - state.segmentStartAt) / 1000);
    if (elapsedSec < state.windowStartSec || elapsedSec > state.windowEndSec) {
      alert("Capture outside allowed window.");
      return;
    }
    // Check machine via perceptual hash
    const segMachine = state.plan[state.currentIndex].machine;
    const enrollMap = getEnrollMap();
    const ref = enrollMap[segMachine];
    if (!ref) {
      alert(`No reference enrolled for ${segMachine}.`);
      return;
    }
    // Capture a frame to ensure it's from the camera stream. Not stored.
    const vw = videoEl.videoWidth || 720;
    const vh = videoEl.videoHeight || 1280;
    canvasEl.width = vw;
    canvasEl.height = vh;
    const ctx = canvasEl.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, vw, vh);
    const liveHash = computeDHash(canvasEl, 9, 8); // 8x8 dHash
    const distance = hammingDistanceHex(liveHash, ref.hash);
    const threshold = 12; // tune as needed
    if (distance > threshold) {
      alert("Machine does not match enrolled reference. Align and try again.");
      return;
    }

    // Mark segment as completed; start next segment timer now (time-gated start)
    state.currentIndex += 1;
    if (state.currentIndex >= state.plan.length) {
      // Done! Mark calendar as done for today
      setCalendarDay(getTodayStr(new Date()), "done");
      renderCalendar(currentMonth);
      hide(sessionSection);
      show(doneSection);
      setButtonsDuringSession(false);
      clearSessionSnapshot();
      closeCamera();
      if (rafId) cancelAnimationFrame(rafId);
      return;
    }
    // Start next segment now
    segmentTitle.textContent = `Segment ${state.currentIndex + 1}/${state.plan.length}: ${state.plan[state.currentIndex].machine} – ${state.plan[state.currentIndex].minutes} min`;
    startSegmentTimer(Date.now());
  });

  newPlanBtn.addEventListener("click", () => {
    hide(doneSection);
    hide(sessionSection);
    show(planSection);
    setButtonsDuringSession(false);
  });

  prevMonthBtn.addEventListener("click", () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    renderCalendar(currentMonth);
  });
  nextMonthBtn.addEventListener("click", () => {
    currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    renderCalendar(currentMonth);
  });

  // Enrollment controls
  enrollOpenBtn.addEventListener("click", async () => {
    try {
      enrollStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      enrollVideo.srcObject = enrollStream;
      enrollOpenBtn.disabled = true;
      enrollCloseBtn.hidden = false;
      enrollCaptureBtn.disabled = false;
    } catch (e) {
      alert("Camera permission is required.");
    }
  });
  enrollCloseBtn.addEventListener("click", () => {
    if (enrollStream) {
      enrollStream.getTracks().forEach((t) => t.stop());
      enrollStream = null;
    }
    enrollVideo.srcObject = null;
    enrollOpenBtn.disabled = false;
    enrollCloseBtn.hidden = true;
    enrollCaptureBtn.disabled = true;
  });
  enrollCaptureBtn.addEventListener("click", () => {
    if (!enrollStream || !enrollingMachine) return;
    const vw = enrollVideo.videoWidth || 720;
    const vh = enrollVideo.videoHeight || 1280;
    enrollCanvas.width = vw;
    enrollCanvas.height = vh;
    const ctx = enrollCanvas.getContext("2d");
    ctx.drawImage(enrollVideo, 0, 0, vw, vh);
    const hash = computeDHash(enrollCanvas, 9, 8);
    setEnroll(enrollingMachine, { hash, size: [vw, vh] });
    renderMachinesChips();
    alert(`Reference saved for ${enrollingMachine}.`);
  });
  enrollDoneBtn.addEventListener("click", () => {
    hide(enrollSection);
    enrollingMachine = null;
    if (enrollStream) {
      enrollStream.getTracks().forEach((t) => t.stop());
      enrollStream = null;
      enrollVideo.srcObject = null;
    }
  });
}

function initFromSnapshotIfAny() {
  const restored = maybeHydrateSession();
  if (!restored) return;
  // Restore UI fields
  slackInput.value = String(state.slackMinutes);
  totalInput.value = String(state.totalMinutes);
  renderPlan();
  show(planSection);

  if (state.segmentStartAt) {
    setButtonsDuringSession(true);
    show(sessionSection);
    segmentTitle.textContent = `Segment ${state.currentIndex + 1}/${state.plan.length}: ${state.plan[state.currentIndex].machine} – ${state.plan[state.currentIndex].minutes} min`;
    if (rafId) cancelAnimationFrame(rafId);
    tick();
  }
}

function boot() {
  renderMachinesChips();
  renderCalendar(currentMonth);
  bindEvents();
  initFromSnapshotIfAny();
  initFirebaseAuth();
}

document.addEventListener("DOMContentLoaded", boot);

// Firebase minimal integration (auth + Firestore). Configure in firebase-config.js
async function initFirebaseAuth() {
  if (!window.firebaseConfig) return; // skip if not configured
  const {
    initializeApp
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const {
    getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const {
    getFirestore, doc, getDoc, setDoc
  } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

  const app = initializeApp(window.firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  signInBtn.hidden = false;
  signOutBtn.hidden = true;
  userBadge.hidden = true;

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      userBadge.textContent = user.displayName || user.email;
      userBadge.hidden = false;
      signInBtn.hidden = true;
      signOutBtn.hidden = false;
      // Load cloud data (machines, enroll, calendar)
      await hydrateFromCloud(user.uid, db);
    } else {
      userBadge.hidden = true;
      signInBtn.hidden = false;
      signOutBtn.hidden = true;
    }
  });

  signInBtn.addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      alert("Sign-in failed.");
    }
  });
  signOutBtn.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (e) {
      // ignore
    }
  });

  // Persist to cloud on key changes
  async function hydrateFromCloud(uid, db) {
    try {
      const snapshot = await getDoc(doc(db, "users", uid));
      if (snapshot.exists()) {
        const data = snapshot.data() || {};
        if (Array.isArray(data.machines) && data.machines.length) {
          saveMachines(data.machines);
          renderMachinesChips();
        }
        if (data.enroll && typeof data.enroll === "object") {
          localStorage.setItem(LS_KEYS.ENROLL, JSON.stringify(data.enroll));
          renderMachinesChips();
        }
        if (data.calendar && typeof data.calendar === "object") {
          localStorage.setItem(LS_KEYS.CALENDAR, JSON.stringify(data.calendar));
          renderCalendar(currentMonth);
        }
      }
    } catch (e) {
      // ignore; offline or first time
    }
  }

  async function persistCloud(partial) {
    const user = auth.currentUser;
    if (!user) return;
    const existing = {};
    try {
      const snapshot = await getDoc(doc(db, "users", user.uid));
      Object.assign(existing, snapshot.exists() ? snapshot.data() : {});
    } catch {
      // ignore
    }
    const next = { ...existing, ...partial };
    try {
      await setDoc(doc(db, "users", user.uid), next, { merge: true });
    } catch {
      // offline errors ignored, try later
    }
  }

  // Hook local writes -> cloud
  const origSaveMachines = saveMachines;
  saveMachines = function(arr) {
    origSaveMachines(arr);
    persistCloud({ machines: arr });
  };
  const origSetEnroll = setEnroll;
  setEnroll = function(machine, payload) {
    origSetEnroll(machine, payload);
    const enrollMap = getEnrollMap();
    persistCloud({ enroll: enrollMap });
  };
  const origSetCalendarDay = setCalendarDay;
  setCalendarDay = function(dateStr, status) {
    origSetCalendarDay(dateStr, status);
    persistCloud({ calendar: getCalendarMap() });
  };
}

// Perceptual hash (dHash)
function computeDHash(canvas, widthPlusOne, height) {
  const w = widthPlusOne;
  const h = height;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(canvas, 0, 0, w, h);
  const img = tctx.getImageData(0, 0, w, h).data;
  const gray = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = img[i], g = img[i + 1], b = img[i + 2];
      gray[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  const bits = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = gray[y * w + x];
      const b = gray[y * w + x + 1];
      bits.push(a > b ? 1 : 0);
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

function hammingDistanceHex(a, b) {
  const len = Math.max(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    const x = parseInt(a[i] || "0", 16);
    const y = parseInt(b[i] || "0", 16);
    let v = x ^ y;
    v = v - ((v >> 1) & 0x5);
    v = (v & 0x3) + ((v >> 2) & 0x3);
    dist += v;
  }
  return dist;
}

