/* =====================================================================
   EduNova — Student Platform shared module (V4)
   Same Firebase project / data model as before. What changed in this
   version:
     - renderNav() replaced by renderShell(): builds the sidebar +
       topbar app frame instead of a single top navbar.
     - A new lightweight exam module (renderExamWidget) replaces the
       old proctored exam.html/welcome.html/result.html flow: no
       fullscreen lock, no tab-switch/disqualification detection, no
       network monitor — just questions, a plain countdown, and a
       result view, embedded directly where the lesson used to be.
   ===================================================================== */
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  setDoc,
  addDoc,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyB6_HkPcbAhyZG8joikJr_kPK-6UACxldg",
  authDomain: "plat-form-97b8d.firebaseapp.com",
  projectId: "plat-form-97b8d",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

export { collection, getDocs, doc, getDoc, setDoc, addDoc, query, where, serverTimestamp };

/* =====================================================================
   COURSES / LECTURES / SECTIONS / CODES / ENROLLMENT
   (unchanged data model — see earlier version's comment block)
   ===================================================================== */

export async function fetchCourses() {
  const snap = await getDocs(collection(db, "courses"));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return list;
}

export async function fetchCourse(courseId) {
  const snap = await getDoc(doc(db, "courses", courseId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function fetchLectures(courseId) {
  const snap = await getDocs(collection(db, "courses", courseId, "lectures"));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  return list;
}

export async function fetchSections(courseId, lectureId) {
  const snap = await getDocs(collection(db, "courses", courseId, "lectures", lectureId, "sections"));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  return list;
}

export async function fetchSection(courseId, lectureId, sectionId) {
  const snap = await getDoc(doc(db, "courses", courseId, "lectures", lectureId, "sections", sectionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function fetchFlatSections(courseId) {
  const lectures = await fetchLectures(courseId);
  const flat = [];
  for (const lecture of lectures) {
    const sections = await fetchSections(courseId, lecture.id);
    for (const s of sections) {
      flat.push({ ...s, lectureId: lecture.id, lectureTitle: lecture.title });
    }
  }
  flat.forEach((s, i) => { s.flatIndex = i; });
  return { lectures, flat };
}

/* ---- Enrollment ---- */
export async function getEnrollment(studentId, courseId) {
  const snap = await getDoc(doc(db, "students", studentId, "enrollments", courseId));
  return snap.exists() ? snap.data() : null;
}

export async function enrollFree(studentId, courseId) {
  await setDoc(doc(db, "students", studentId, "enrollments", courseId), {
    enrolledAt: Date.now(), source: "free",
    completedSections: [], sectionAttempts: {}
  });
}

export async function redeemCode(studentId, rawCode) {
  const codeStr = String(rawCode || "").trim().toUpperCase();
  if (!codeStr) throw new Error("اكتب الكود الأول");

  const snap = await getDocs(query(collection(db, "codes"), where("code", "==", codeStr)));
  if (snap.empty) throw new Error("الكود ده مش موجود");

  const codeDoc = snap.docs[0];
  const data = codeDoc.data();
  if (data.used) throw new Error("الكود ده اتستخدم قبل كده");

  await setDoc(doc(db, "codes", codeDoc.id), {
    used: true, usedBy: studentId, usedAt: Date.now()
  }, { merge: true });

  if (data.type === "subscription") {
    await setDoc(doc(db, "students", studentId, "subscriptions", "all"), {
      grantedAt: Date.now(), code: codeStr
    });
  } else {
    await setDoc(doc(db, "students", studentId, "enrollments", data.courseId), {
      enrolledAt: Date.now(), source: "code", code: codeStr,
      completedSections: [], sectionAttempts: {}
    });
  }
  return data;
}

export async function hasFullSubscription(studentId) {
  const snap = await getDoc(doc(db, "students", studentId, "subscriptions", "all"));
  return snap.exists();
}

export async function canAccessCourse(studentId, course) {
  if (course.isFree) return true;
  if (await hasFullSubscription(studentId)) return true;
  const enr = await getEnrollment(studentId, course.id);
  return !!enr;
}

/* ---- Section progress ---- */
export function isSectionUnlocked(flatSections, enrollment, flatIndex) {
  if (flatIndex === 0) return true;
  const prev = flatSections[flatIndex - 1];
  const completed = enrollment?.completedSections || [];
  return completed.includes(prev.id);
}

export async function markSectionComplete(studentId, courseId, sectionId) {
  const ref = doc(db, "students", studentId, "enrollments", courseId);
  const snap = await getDoc(ref);
  const completed = new Set(snap.exists() ? (snap.data().completedSections || []) : []);
  completed.add(sectionId);
  await setDoc(ref, { completedSections: [...completed] }, { merge: true });
}

export async function bumpSectionAttempts(studentId, courseId, sectionId) {
  const ref = doc(db, "students", studentId, "enrollments", courseId);
  const snap = await getDoc(ref);
  const attempts = snap.exists() ? (snap.data().sectionAttempts || {}) : {};
  const next = (attempts[sectionId] || 0) + 1;
  await setDoc(ref, { sectionAttempts: { ...attempts, [sectionId]: next } }, { merge: true });
  return next;
}

export function sectionAttemptsUsed(enrollment, sectionId) {
  return (enrollment?.sectionAttempts || {})[sectionId] || 0;
}

/* ---- Cloudinary uploads ---- */
export async function uploadToCloudinary(file, resourceType) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", "exam_preset");
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/dd3xs6mqn/${resourceType}/upload`,
    { method: "POST", body: formData }
  );
  const data = await res.json();
  if (!data.secure_url) throw new Error("فشل رفع الملف");
  return { url: data.secure_url, name: file.name, type: file.type || "file" };
}
export const uploadVideo = file => uploadToCloudinary(file, "video");
export const uploadCourseFile = file => uploadToCloudinary(file, "auto");

export function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) {
    if (i === 5) s += "-";
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

/* ---- Custom branded video player (unchanged) ---- */
export function createCustomPlayer(container, videoUrl) {
  container.classList.add("ep-player");
  container.oncontextmenu = () => false;

  container.innerHTML = `
    <video class="ep-video" playsinline disablePictureInPicture
           controlsList="nodownload noremoteplayback noplaybackrate"
           oncontextmenu="return false">
      <source src="${videoUrl}">
    </video>
    <button class="ep-bigplay" type="button" aria-label="تشغيل">▶</button>
    <div class="ep-bar">
      <button class="ep-play" type="button" aria-label="تشغيل/إيقاف">▶</button>
      <span class="ep-time">00:00</span>
      <input class="ep-seek" type="range" min="0" max="100" value="0" step="0.1">
      <span class="ep-dur">00:00</span>
      <button class="ep-mute" type="button" aria-label="صوت">🔊</button>
      <input class="ep-vol" type="range" min="0" max="1" value="1" step="0.05">
      <button class="ep-fs" type="button" aria-label="ملء الشاشة">⛶</button>
    </div>
    <div class="ep-spinner hidden"></div>
  `;

  const video = container.querySelector(".ep-video");
  const bigPlay = container.querySelector(".ep-bigplay");
  const playBtn = container.querySelector(".ep-play");
  const seek = container.querySelector(".ep-seek");
  const timeEl = container.querySelector(".ep-time");
  const durEl = container.querySelector(".ep-dur");
  const muteBtn = container.querySelector(".ep-mute");
  const volSlider = container.querySelector(".ep-vol");
  const fsBtn = container.querySelector(".ep-fs");
  const spinner = container.querySelector(".ep-spinner");

  function fmt(t) {
    if (!isFinite(t)) return "00:00";
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  function togglePlay() { video.paused ? video.play() : video.pause(); }

  bigPlay.onclick = togglePlay;
  playBtn.onclick = togglePlay;
  video.addEventListener("click", togglePlay);

  video.addEventListener("play", () => { bigPlay.classList.add("hidden"); playBtn.textContent = "⏸"; });
  video.addEventListener("pause", () => { bigPlay.classList.remove("hidden"); playBtn.textContent = "▶"; });
  video.addEventListener("waiting", () => spinner.classList.remove("hidden"));
  video.addEventListener("playing", () => spinner.classList.add("hidden"));
  video.addEventListener("loadedmetadata", () => { durEl.textContent = fmt(video.duration); });
  video.addEventListener("timeupdate", () => {
    if (!seek.matches(":active")) seek.value = (video.currentTime / (video.duration || 1)) * 100;
    timeEl.textContent = fmt(video.currentTime);
  });
  seek.addEventListener("input", () => { video.currentTime = (seek.value / 100) * (video.duration || 0); });
  volSlider.addEventListener("input", () => {
    video.volume = volSlider.value;
    muteBtn.textContent = video.volume == 0 ? "🔇" : "🔊";
  });
  muteBtn.onclick = () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? "🔇" : "🔊"; };
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else container.requestFullscreen?.();
  };

  function destroy() { video.pause(); video.removeAttribute("src"); video.load(); }
  return { video, destroy };
}

/* ================= SESSION ================= */
export const SESSION_KEYS = [
  "studentId", "studentName", "studentCode",
  "studentUsername", "studentSessionToken", "studentPhone"
];

export function getStudent() {
  const id = localStorage.getItem("studentId");
  if (!id) return null;
  return {
    id,
    name: localStorage.getItem("studentName") || "",
    code: localStorage.getItem("studentCode") || "",
    username: localStorage.getItem("studentUsername") || "",
    phone: localStorage.getItem("studentPhone") || ""
  };
}

export function requireStudent() {
  const s = getStudent();
  if (!s) { window.location.replace("login.html"); return null; }
  return s;
}

export function logout() {
  SESSION_KEYS.forEach(k => localStorage.removeItem(k));
  window.location.href = "index.html";
}

export async function startSession(studentId, student) {
  const sessionToken =
    (crypto?.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2));

  localStorage.setItem("studentId", studentId);
  localStorage.setItem("studentName", student.name || "");
  localStorage.setItem("studentCode", student.code || "");
  localStorage.setItem("studentUsername", student.username || "");
  localStorage.setItem("studentPhone", student.phone || "");
  localStorage.setItem("studentSessionToken", sessionToken);

  await setDoc(
    doc(db, "students", studentId, "meta", "login"),
    { used: true, time: Date.now(), sessionToken }
  );
}

/* ================= TEXT / PHONE HELPERS ================= */
export function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function toLatinDigits(str) {
  return String(str || "")
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
}

export function normalizePhone(input) {
  let s = toLatinDigits(input).trim().replace(/[\s\-().]/g, "");
  if (!s) return null;

  let international = false;
  if (s.startsWith("+")) { international = true; s = s.slice(1); }
  else if (s.startsWith("00")) { international = true; s = s.slice(2); }

  if (!/^\d+$/.test(s)) return null;

  if (!international) {
    if (/^01[0125]\d{8}$/.test(s)) return "+20" + s.slice(1);
    if (/^1[0125]\d{8}$/.test(s)) return "+20" + s;
    if (/^201[0125]\d{8}$/.test(s)) return "+" + s;
    return null;
  }

  if (s.startsWith("20")) return /^201[0125]\d{8}$/.test(s) ? "+" + s : null;
  return (/^[1-9]\d{7,14}$/.test(s)) ? "+" + s : null;
}

export function looksLikePhone(input) {
  const s = toLatinDigits(input).trim();
  return /^[+\d\s\-().]+$/.test(s) && s.replace(/\D/g, "").length >= 8;
}

export async function isPhoneTaken(phone) {
  const snap = await getDocs(query(collection(db, "students"), where("phone", "==", phone)));
  return !snap.empty;
}

export async function findStudentByPhone(phone) {
  const snap = await getDocs(query(collection(db, "students"), where("phone", "==", phone)));
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

/* ================= PASSWORD ================= */
function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function randomSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return toHex(a);
}
export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ":" + password);
  return toHex(await crypto.subtle.digest("SHA-256", data));
}
export async function checkPassword(student, password) {
  if (student.passwordHash) {
    return (await hashPassword(password, student.passwordSalt || "")) === student.passwordHash;
  }
  return student.password === password;
}

/* ================= USERNAME / CODE ================= */
export const RESERVED_USERNAMES = [
  "admin", "administrator", "superadmin", "root", "system",
  "moderator", "owner", "teacher", "manager",
  "مدير", "ادمن", "أدمن", "الادمن", "الأدمن"
];
export function isReservedUsername(username) {
  return RESERVED_USERNAMES.includes(String(username || "").trim().toLowerCase());
}
const ARABIC_TO_LATIN = {
  "ا":"a","أ":"a","إ":"a","آ":"a","ب":"b","ت":"t","ث":"th","ج":"g","ح":"h",
  "خ":"kh","د":"d","ذ":"th","ر":"r","ز":"z","س":"s","ش":"sh","ص":"s","ض":"d",
  "ط":"t","ظ":"z","ع":"a","غ":"gh","ف":"f","ق":"k","ك":"k","ل":"l","م":"m",
  "ن":"n","ه":"h","و":"w","ي":"y","ى":"a","ة":"a","ء":"","ئ":"y","ؤ":"w"
};
function transliterateName(name) {
  const firstWord = String(name || "").trim().split(/\s+/)[0] || "";
  let out = "";
  for (const ch of firstWord.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (ARABIC_TO_LATIN[ch] !== undefined) out += ARABIC_TO_LATIN[ch];
  }
  return out.slice(0, 12);
}
function randomUsername(name) {
  const base = transliterateName(name) || "student";
  let username = `${base}${Math.floor(100 + Math.random() * 900)}`;
  if (isReservedUsername(username)) username = `st${username}`;
  return username;
}
export async function generateUniqueUsername(name) {
  for (let i = 0; i < 20; i++) {
    const username = randomUsername(name);
    const snap = await getDocs(query(collection(db, "students"), where("username", "==", username)));
    if (snap.empty && !isReservedUsername(username)) return username;
  }
  throw new Error("تعذر توليد اسم مستخدم فريد، حاول مرة أخرى");
}
export async function generateUniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = `EN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const snap = await getDocs(query(collection(db, "students"), where("code", "==", code)));
    if (snap.empty) return code;
  }
  throw new Error("تعذر توليد كود فريد، حاول مرة أخرى");
}

/* ================= EXAMS (list) ================= */
export async function fetchExams() {
  const snap = await getDocs(collection(db, "exams"));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return list;
}

export function safeImageUrl(url) {
  return /^https?:\/\//i.test(String(url || "")) ? url : "";
}

/* =====================================================================
   SIMPLE EXAM WIDGET
   Renders directly inside a container element (used in place of the
   old iframe to welcome.html/exam.html). No fullscreen requirement,
   no tab-switch/disqualification tracking, no network monitor — just
   the questions, a plain non-blocking timer, and a result screen.
   Writes to the SAME Firestore paths the old exam.html used
   (students/{id}/exams/{examName}) so account.html and any existing
   backend grading stay compatible.
   ===================================================================== */
export async function renderExamWidget(container, examId, student, opts = {}) {
  container.innerHTML = `<div class="skeleton" style="min-height:200px;"></div>`;

  const examSnap = await getDoc(doc(db, "exams", examId));
  if (!examSnap.exists()) {
    container.innerHTML = `<div class="empty-state"><div class="big">🔍</div><h3>الامتحان مش موجود</h3></div>`;
    return;
  }
  const examData = examSnap.data();

  const attemptRef = doc(db, "students", student.id, "exams", examData.name);
  const attemptSnap = await getDoc(attemptRef);
  if (attemptSnap.exists() && attemptSnap.data().finished) {
    renderResult(container, attemptSnap.data(), null);
    if (opts.onFinish) opts.onFinish(attemptSnap.data());
    return;
  }

  const qSnap = await getDocs(collection(db, "exams", examId, "questions"));
  const questions = qSnap.docs.map(d => {
    const data = d.data();
    return { id: d.id, ...data, type: data.type === "essay" ? "essay" : "mcq" };
  }).sort((a, b) => (a.order || 0) - (b.order || 0));

  if (!questions.length) {
    container.innerHTML = `<div class="empty-state"><div class="big">📭</div><h3>لسه مفيش أسئلة في الامتحان ده</h3></div>`;
    return;
  }

  const answers = {};
  let timeLeft = (examData.time || 10) * 60;
  let timerHandle = null;

  container.innerHTML = `
    <div class="exam-widget">
      <div class="exam-widget-head">
        <h3>${escapeHtml(examData.name || "امتحان")}</h3>
        ${examData.time ? `<span class="exam-timer" id="examWidgetTimer">--:--</span>` : ""}
      </div>
      <div id="examWidgetQuestions"></div>
      <button class="btn btn-primary btn-block btn-lg" id="examWidgetSubmit">تسليم الامتحان ✅</button>
    </div>
  `;

  const qBox = container.querySelector("#examWidgetQuestions");
  qBox.innerHTML = questions.map((q, i) => questionHtml(q, i)).join("");

  qBox.querySelectorAll(".exam-opt").forEach(opt => {
    opt.addEventListener("click", () => {
      const qi = opt.dataset.q, oi = opt.dataset.o;
      answers[qi] = Number(oi);
      qBox.querySelectorAll(`.exam-opt[data-q="${qi}"]`).forEach(o => o.classList.remove("selected"));
      opt.classList.add("selected");
      qBox.querySelectorAll(`.exam-opt[data-q="${qi}"] input`).forEach(inp => { inp.checked = false; });
      opt.querySelector("input").checked = true;
    });
  });
  qBox.querySelectorAll(".exam-essay textarea").forEach(ta => {
    ta.addEventListener("input", () => { answers[ta.dataset.q] = { answer: ta.value }; });
  });

  if (examData.time) {
    const timerEl = container.querySelector("#examWidgetTimer");
    const tick = () => {
      const m = Math.floor(timeLeft / 60), s = timeLeft % 60;
      timerEl.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      if (timeLeft <= 0) { clearInterval(timerHandle); submit(true); return; }
      timeLeft--;
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  container.querySelector("#examWidgetSubmit").onclick = () => submit(false);

  async function submit(auto) {
    if (timerHandle) clearInterval(timerHandle);
    const btn = container.querySelector("#examWidgetSubmit");
    if (btn) { btn.disabled = true; btn.textContent = "بنحسبلك النتيجة... ⏳"; }

    let correct = 0, wrong = 0, blank = 0, earnedPoints = 0, totalPoints = 0;
    const mcqList = questions.filter(q => q.type === "mcq");
    mcqList.forEach((q, i) => {
      const qi = questions.indexOf(q);
      const pts = Number(q.points ?? 1) || 1;
      totalPoints += pts;
      const a = answers[qi];
      if (a === undefined) blank++;
      else if (a === q.correct) { correct++; earnedPoints += pts; }
      else wrong++;
    });

    const essayList = questions
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => q.type === "essay");
    const hasEssay = essayList.length > 0;
    const essayTotalPoints = essayList.reduce((s, e) => s + Number(e.q.points || 0), 0);
    const percent = hasEssay ? null : (totalPoints ? Math.round((earnedPoints / totalPoints) * 100) : 0);

    const attemptData = {
      examName: examData.name,
      examId,
      correct, wrong, blank,
      mcqEarnedPoints: earnedPoints,
      mcqTotalPoints: totalPoints,
      percent,
      hasEssay,
      essayTotalPoints,
      totalExamPoints: totalPoints + essayTotalPoints,
      totalEarnedPoints: earnedPoints,
      examGradingStatus: hasEssay ? "processing" : "graded",
      answers,
      finished: true,
      autoSubmitted: !!auto,
      submitTime: Date.now()
    };

    try {
      await setDoc(attemptRef, attemptData, { merge: true });
      for (const { q, i } of essayList) {
        const a = answers[i];
        const answerText = (a && typeof a === "object") ? (a.answer || "") : "";
        try {
          await setDoc(
            doc(db, "students", student.id, "exams", examData.name, "essayResults", q.id || String(i)),
            {
              questionId: q.id || String(i), studentId: student.id, examId,
              examName: examData.name, studentAnswer: answerText,
              gradingStatus: "pending", createdAt: Date.now()
            }, { merge: true }
          );
        } catch (e) { /* non-fatal */ }
      }
      renderResult(container, attemptData, questions);
      if (opts.onFinish) opts.onFinish(attemptData);
    } catch (e) {
      console.error(e);
      if (btn) { btn.disabled = false; btn.textContent = "تسليم الامتحان ✅"; }
      showPopup("🔥", "حصلت مشكلة", "تعذر تسليم الامتحان، جرب تاني 🙏");
    }
  }

  function questionHtml(q, i) {
    if (q.type === "essay") {
      return `
        <div class="exam-q exam-essay">
          <div class="q-num">سؤال ${i + 1} (مقالي)</div>
          <div class="q-text">${escapeHtml(q.text || "")}</div>
          ${safeImageUrl(q.image) ? `<img src="${safeImageUrl(q.image)}" alt="">` : ""}
          <textarea data-q="${i}" placeholder="اكتب إجابتك هنا..."></textarea>
        </div>`;
    }
    const opts = q.options || [];
    return `
      <div class="exam-q">
        <div class="q-num">سؤال ${i + 1}</div>
        <div class="q-text">${escapeHtml(q.text || "")}</div>
        ${safeImageUrl(q.image) ? `<img src="${safeImageUrl(q.image)}" alt="">` : ""}
        <div class="exam-opts">
          ${opts.map((o, oi) => `
            <label class="exam-opt" data-q="${i}" data-o="${oi}">
              <input type="radio" name="q${i}">
              <span>${escapeHtml(o)}</span>
            </label>`).join("")}
        </div>
      </div>`;
  }
}

function renderResult(container, attempt, questions) {
  const percent = typeof attempt.percent === "number" ? attempt.percent : null;
  const processing = attempt.hasEssay && attempt.examGradingStatus !== "graded";
  container.innerHTML = `
    <div class="exam-result">
      <div class="percent">${percent === null ? (processing ? "قيد التصحيح" : "—") : percent + "%"}</div>
      <h3>${percent !== null && percent >= 50 ? "مبروك، خلصت الامتحان 🎉" : processing ? "تم تسليم الامتحان" : "خلصت الامتحان"}</h3>
      <p>${processing ? "فيه أسئلة مقالية بتتصحح دلوقتي، النتيجة النهائية هتظهر بعد التصحيح." : "دي نتيجتك في الأسئلة الاختيارية."}</p>
      <div class="exam-result-stats">
        <div><b style="color:var(--success)">${attempt.correct ?? 0}</b><small>صح</small></div>
        <div><b style="color:var(--danger)">${attempt.wrong ?? 0}</b><small>غلط</small></div>
        <div><b style="color:var(--text-muted)">${attempt.blank ?? 0}</b><small>فاضي</small></div>
      </div>
      ${questions ? reviewHtml(attempt, questions) : ""}
    </div>`;
}

function reviewHtml(attempt, questions) {
  const answers = attempt.answers || {};
  const rows = questions.filter(q => q.type === "mcq").map((q) => {
    const i = questions.indexOf(q);
    const a = answers[i];
    const isCorrect = a === q.correct;
    const givenText = a === undefined ? "من غير إجابة" : (q.options?.[a] ?? "—");
    return `
      <div class="exam-review-q ${a === undefined ? "" : isCorrect ? "correct" : "wrong"}">
        <div class="q-text">${escapeHtml(q.text || "")}</div>
        <small class="${isCorrect ? "ok" : "bad"}">إجابتك: ${escapeHtml(givenText)}${!isCorrect ? " — الصح: " + escapeHtml(q.options?.[q.correct] ?? "") : ""}</small>
      </div>`;
  }).join("");
  return rows ? `<div class="exam-review">${rows}</div>` : "";
}

/* ================= APP SHELL (green topbar + blue sidebar) ================= */
const NAV_ITEMS = [
  { key: "home", label: "الرئيسية", href: "home.html", icon: "▦" },
  { key: "courses", label: "الكورسات", href: "courses.html", icon: "📖" },
  { key: "account", label: "حسابي", href: "account.html", icon: "👤" }
];

/* Builds the green topbar + blue sidebar app frame. Expects the page
   body to contain empty #topbar and #sidebar elements. `title` isn't
   shown separately (the topbar mirrors the reference file, which has
   no page-title slot) but is kept as a param for the <title> tag. */
export function renderShell(active) {
  const student = getStudent();
  if (!student) { window.location.replace("login.html"); return; }

  const topbar = document.getElementById("topbar");
  const sidebar = document.getElementById("sidebar");
  if (!topbar || !sidebar) return;

  topbar.innerHTML = `
    <a class="topbar-brand" href="home.html">
      <img src="icon.png" alt="EduNova">EduNova
    </a>
    <div class="search">🔍<span>ابحث هنا</span></div>
    <div class="topbar-spacer"></div>
    <div class="top-actions">
      <button class="icon-btn" title="الوضع الليلي">☾</button>
      <button class="icon-btn" title="الإشعارات">🔔</button>
      <div class="wallet-pill">🪙 0 جنيه</div>
      <div class="topbar-avatar" title="${escapeHtml(student.name || "")}">👨🏻‍🎓</div>
    </div>
  `;

  sidebar.innerHTML = `
    <nav class="side-nav">
      ${NAV_ITEMS.map(item => `
        <a class="side-link ${active === item.key ? "active" : ""}" href="${item.href}">
          <span class="menu-icon">${item.icon}</span><span>${item.label}</span>
        </a>`).join("")}
    </nav>
    <div class="side-note">نحن نحاول أن نجعل تجربة مذاكرتك أسهل وأسرع.</div>
    <div class="side-foot">
      <div class="side-link" id="sideLogout"><span class="menu-icon">⏻</span><span>تسجيل الخروج</span></div>
    </div>
  `;

  document.getElementById("sideLogout").onclick = logout;
}

/* Simple top bar used on the logged-out landing page and auth screens
   (no sidebar there — matches the centered-card auth layout). */
export function renderAuthTopbar() {
  const el = document.getElementById("nav");
  if (!el) return;
  const student = getStudent();
  el.outerHTML = `
    <div class="auth-topbar">
      <a class="auth-brand" href="${student ? "home.html" : "index.html"}">
        <img src="icon.png" alt="EduNova"><b>EduNova</b>
      </a>
      ${student ? "" : `<a class="btn btn-ghost" href="login.html" style="padding:9px 18px;font-size:13px;">تسجيل الدخول</a>`}
    </div>`;
}

/* Percent of a course's flat sections the student has completed. */
export function courseProgressPercent(flat, enrollment) {
  if (!flat.length) return 0;
  const done = (enrollment?.completedSections || []).filter(id => flat.some(s => s.id === id)).length;
  return Math.round((done / flat.length) * 100);
}

/* ================= MODALS ================= */
function ensureModals() {
  if (document.getElementById("pfLoading")) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="modal" id="pfLoading">
      <div class="modal-box glass">
        <img src="icon.png" class="loading-logo" alt="">
        <h2 id="pfLoadingTitle">لحظة واحدة بس... ⏳</h2>
        <div class="wave-loader"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
    </div>
    <div class="modal" id="pfPopup">
      <div class="modal-box glass">
        <div class="icon" id="pfPopupIcon">⚠️</div>
        <h2 id="pfPopupTitle"></h2>
        <p id="pfPopupMsg"></p>
        <button class="btn btn-primary" id="pfPopupBtn" type="button">تمام ✅</button>
      </div>
    </div>`;
  document.body.append(...wrap.children);
}

export function showLoading(text) {
  ensureModals();
  document.getElementById("pfLoadingTitle").innerText = text || "لحظة واحدة بس... ⏳";
  document.getElementById("pfLoading").classList.add("show");
}
export function hideLoading() {
  const m = document.getElementById("pfLoading");
  if (m) m.classList.remove("show");
}
export function showPopup(icon, title, message, onClose) {
  ensureModals();
  document.getElementById("pfPopupIcon").innerText = icon;
  document.getElementById("pfPopupTitle").innerText = title;
  document.getElementById("pfPopupMsg").innerText = message;
  const popup = document.getElementById("pfPopup");
  popup.classList.add("show");
  document.getElementById("pfPopupBtn").onclick = () => {
    popup.classList.remove("show");
    if (onClose) onClose();
  };
}
