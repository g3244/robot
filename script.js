const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCjrm9kVF9rqscDSYd31hJBjyzJzum_RpA",
  authDomain: "chat-14acb.firebaseapp.com",
  projectId: "chat-14acb",
  storageBucket: "chat-14acb.firebasestorage.app",
  messagingSenderId: "1001984050835",
  appId: "1:1001984050835:web:559cfada07ef9ea865af66",
  measurementId: "G-1JX6487N9T"
};

let db = null, auth = null, storage = null, firebaseReady = false;
try{
  const hasRealKey = !!FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.trim() !== "" && !FIREBASE_CONFIG.apiKey.includes("YOUR_");
  if(hasRealKey){
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    storage = firebase.storage();
    firebaseReady = true;
  } else {
    console.error("Firebase config is missing a real apiKey — fill in FIREBASE_CONFIG with your project's values.");
  }
}catch(e){ console.error("Firebase init failed:", e); }

/* ------------------------------------------------------------------ */
/* Shared state                                                        */
/* ------------------------------------------------------------------ */
let currentUser = null;          // { uid, id, name, bio, photoURL, blocked:[] }
let activeChatPeer = null;       // { id, name, photoURL }
let activeChatId = null;
let msgUnsub = null, chatListUnsub = null, chatDocUnsub = null;
let chatDocExistsForActive = false; // does the currently-open chat's Firestore doc actually exist right now?
let activeChatDocData = null;       // latest known data of the currently-open chat doc (for lastMessage* fields)
let peerIsTyping = false;           // is the OTHER person in the open chat currently typing? (see showPeerTypingIndicator)
let frozenChatListPreview = null;   // snapshot of {lastMessage,lastMessageSenderId,lastMessageStatus} taken the moment
                                     // a chat is opened — the chat-list keeps showing THIS for that chat, instead of
                                     // live-updating, while it's the one you have open
const peerCache = {};            // id -> {id,name,photoURL}
let visibleChatPeerIds = [];     // peer ids that currently have a non-deleted chat in my chat list

/* ---- message extras: reply / pin / context menu state ---- */
let messagesData = {};           // messageId -> message data, for the open chat only
/* tempId -> the actual DOM node for a bubble that's still "sending"
   (typed text, or a voice note still uploading to Storage). The messages
   onSnapshot handler below wipes and rebuilds #messages from scratch on
   every change, which would otherwise throw these away mid-flight (e.g.
   while a voice note is still uploading and some unrelated change, like
   the other side's read receipt, fires the listener first) — so it puts
   any node still in here back after every rebuild. Entries are removed
   the moment their real Firestore doc is written (success) or the send
   fails (see removePendingMessageBubble). */
let pendingBubbleNodes = new Map();
let replyingTo = null;           // {id, senderId, text} snippet of the message being replied to
let currentPinnedId = null;      // id of the currently pinned message in the open chat
let contextMenuMsgId = null;     // message the right-click / long-press menu currently targets
let deleteTargetIds = [];        // message id(s) awaiting the delete-for-me / delete-for-everyone choice
let lastDeletedForMeId = null;   // message id the thin "deleted for me" bar above the composer can undo
let lastDeletedForMeChatId = null;
let deletedForMeBarTimer = null;

/* ---- pinning: up to 4 messages at once, each with a required expiry ---- */
const MAX_PINNED_MESSAGES = 4;
let pinnedMessagesList = [];     // live (non-expired) {id,text,senderId,pinnedUntil} entries for the open chat
let currentPinnedIds = new Set();// same list, just the ids — used for badges/toggling
let pinnedFocusIndex = 0;        // which pinned entry the banner is currently showing
let pendingPinTargetId = null;   // message awaiting a duration choice from the pin-duration modal
let pinnedExpiryTimer = null;    // fires the moment the soonest-expiring pin actually runs out

/* ---- touch "selection mode" (long-press on phone/tablet) — replaces the
   small popup menu with a WhatsApp-style header toolbar + highlighted
   bubbles, since a tiny floating menu doesn't work well with a finger ---- */
let selectedMsgIds = new Set();

/* ---- chat-list selection: right-click (desktop) opens a small floating
   menu targeting a single chat; long-press (phone) instead opens a top
   toolbar and supports selecting more than one chat at once ---- */
let contextMenuChatPeerId = null; // peer targeted by the right-click chat-list menu
let chatListSelectedIds = new Set(); // peerIds selected via long-press toolbar mode
let chatListSelectionActive = false;
let chatLongPressFired = false;

const ACCENTS = ["#f2b134","#5eead4","#f472b6","#93c5fd","#4ade80","#fb923c","#c084fc","#fb7185","#60a5fa","#facc15","#34d399","#a78bfa"];
const WALLPAPERS = [
  {id:"none",  css:"none"},
  {id:"dots",  css:"radial-gradient(currentColor 1px, transparent 1px)", size:"16px 16px", tint:true},
  {id:"grid",  css:"linear-gradient(currentColor 1px, transparent 1px),linear-gradient(90deg,currentColor 1px,transparent 1px)", size:"22px 22px", tint:true},
  {id:"waves", css:"repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 22px)", tint:true},
  {id:"warm",  css:"radial-gradient(1000px 600px at 20% 0%, rgba(242,177,52,.10), transparent)"},
  {id:"cool",  css:"radial-gradient(1000px 600px at 80% 0%, rgba(94,234,212,.10), transparent)"},
  {id:"diagonal", css:"repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 18px)", tint:true},
  {id:"cross", css:"repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 16px),repeating-linear-gradient(-45deg, currentColor 0 1px, transparent 1px 16px)", tint:true},
  {id:"bubbles", css:"radial-gradient(currentColor 2px, transparent 2px)", size:"28px 28px", tint:true},
  {id:"herringbone", css:"repeating-linear-gradient(60deg, currentColor 0 2px, transparent 2px 14px),repeating-linear-gradient(-60deg, currentColor 0 2px, transparent 2px 14px)", tint:true},
  {id:"sunset", css:"radial-gradient(900px 500px at 50% 100%, rgba(251,146,60,.14), transparent)"},
  {id:"midnight", css:"radial-gradient(900px 500px at 50% 0%, rgba(96,165,250,.12), transparent)"},
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function toast(msg, isError=false){
  const t = $("#toast");
  t.textContent = msg;
  t.style.borderColor = isError ? "var(--error)" : "var(--card-border)";
  t.style.color = isError ? "var(--error)" : "var(--ink)";
  t.classList.remove("hidden");
  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=> t.classList.add("hidden"), 2600);
}

function initials(name){ return (name||"؟").trim().charAt(0).toUpperCase(); }

function setAvatarNode(node, name, photoURL){
  const span = node.querySelector("span");
  const img = node.querySelector("img");
  if(photoURL){
    img.src = photoURL; img.classList.remove("hidden");
    if(span) span.classList.add("hidden");
  } else {
    if(img) img.classList.add("hidden");
    if(span){ span.textContent = initials(name); span.classList.remove("hidden"); }
  }
}

function resizeImageFile(file, maxSize=220, quality=0.72){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxSize / Math.max(w,h));
        w = Math.round(w*scale); h = Math.round(h*scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img,0,0,w,h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function genId(){
  let s = String(1 + Math.floor(Math.random()*9));
  for(let i=0;i<10;i++) s += Math.floor(Math.random()*10);
  return s;
}

function chatIdFor(a,b){ return [a,b].sort().join("_"); }

/* ---- unsent-composer drafts (WhatsApp-style "Draft: ..." in the chat
   list) — purely local, per device, keyed by chat id, never touches
   Firestore since it's nobody's business but mine ---- */
function draftKey(chatId){ return "wasla_draft_" + chatId; }
function getDraftText(chatId){
  if(!chatId) return "";
  try{ return localStorage.getItem(draftKey(chatId)) || ""; }catch(e){ return ""; }
}
function setDraftText(chatId, text){
  if(!chatId) return;
  try{
    if(text && text.trim()) localStorage.setItem(draftKey(chatId), text);
    else localStorage.removeItem(draftKey(chatId));
  }catch(e){}
}
/* patches just one chat-list row in place (cheap) instead of a full
   renderChatList on every keystroke; falls back to a full re-render
   only when the draft is cleared, so the real last-message/tick comes
   back correctly */
function refreshChatItemDraft(peerId){
  const item = document.querySelector(`#chatList .chat-item[data-peer-id="${peerId}"]`);
  if(!item) return;
  const isOpenRightNow = activeChatPeer && activeChatPeer.id === peerId;
  const draft = isOpenRightNow ? "" : getDraftText(chatIdFor(currentUser.id, peerId));
  if(draft){
    const lastWrap = item.querySelector(".ci-last-wrap");
    if(lastWrap) lastWrap.innerHTML = `<span class="ci-draft-label">مسودة: </span><span class="ci-last draft">${escapeHtml(draft)}</span>`;
    const tick = item.querySelector(".ci-tick-standalone");
    if(tick) tick.classList.add("hidden");
  } else if(lastChatListSnapDocs.length){
    renderChatList(lastChatListSnapDocs);
  }
}

/* Copy text to clipboard in a way that also works on mobile browsers,
   where navigator.clipboard is often missing or blocked (non-HTTPS,
   older webviews, etc). Falls back to a hidden textarea + execCommand. */
function copyText(text){
  if(navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext){
    return navigator.clipboard.writeText(text).catch(()=> legacyCopy(text));
  }
  return legacyCopy(text);
}
function legacyCopy(text){
  return new Promise((resolve, reject)=>{
    try{
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if(ok) resolve(); else reject(new Error("execCommand copy failed"));
    }catch(e){ reject(e); }
  });
}

/* Turn a raw Firebase/network error into a clear Arabic message so the
   user knows whether the problem is their internet connection, or an
   actual setup/config issue. */
function friendlyErrorMessage(err){
  const code = err && err.code ? err.code : "";
  const msg = (err && err.message ? err.message : "").toLowerCase();

  const isNetworkIssue =
    code === "auth/network-request-failed" ||
    code === "unavailable" ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("err_timed_out") ||
    msg.includes("err_socket_not_connected") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_connection") ||
    msg.includes("failed to fetch");

  if(isNetworkIssue){
    return "المشكلة في الاتصال بالإنترنت عندك، مش في الموقع. تأكد إن النت شغّال كويس وجرّب تاني.";
  }
  if(code === "permission-denied"){
    return "الصلاحيات على قاعدة البيانات مش مظبوطة صح (Firestore Rules).";
  }
  if(code === "auth/too-many-requests"){
    return "محاولات كتير في وقت قصير، استنى شوية وجرّب تاني.";
  }
  return "حصل خطأ أثناء التسجيل. جرّب تاني.";
}

function fmtTime(ts){
  if(!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("ar-EG", {hour:"2-digit", minute:"2-digit"});
}

/* =====================================================================
   1) GATE — multi-challenge verification
   3 random challenge types (text code / shape order / drag piece).
   Wrong answer -> next round needs more CONSECUTIVE correct answers
   (1 -> 2 -> 3 -> 4, capped at 4). State persists across refresh.
   ===================================================================== */
(function initGate(){
  const gate = $("#gate");
  const challengeArea = $("#challengeArea");
  const statusRow = $("#statusRow");
  const gateHeader = $("#gateHeader");
  const successView = $("#successView");
  const progressWrap = $("#gateProgress");
  const progressFill = $("#gateProgressFill");
  const progressLabel = $("#gateProgressLabel");

  /* ---- safety net: if this device already passed verification, never
     build or show this gate's own challenge, no matter what ---- */
  try{
    if(localStorage.getItem("wasla_device_verified") === "1"){
      gate.classList.add("hidden");
      return;
    }
  }catch(e){}

  const STORAGE_KEY = "wasla_gate_state";
  const MAX_REQUIRED = 4;

  /* ---------------- streak state (persisted) ---------------- */
  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return { required:1, streak:0 };
      const s = JSON.parse(raw);
      let required = Number(s.required), streak = Number(s.streak);
      if(!Number.isFinite(required)) required = 1;
      if(!Number.isFinite(streak)) streak = 0;
      required = Math.min(Math.max(1, required), MAX_REQUIRED);
      streak = Math.min(Math.max(0, streak), required);
      return { required, streak };
    }catch(e){ return { required:1, streak:0 }; }
  }
  function saveState(s){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }catch(e){} }

  let state = loadState();

  function updateProgressUI(){
    const pct = state.required ? Math.round((state.streak/state.required)*100) : 0;
    progressFill.style.width = pct + "%";
    progressLabel.textContent = `${state.streak} / ${state.required}`;
  }
  function setStatus(text, type){
    statusRow.textContent = text || "";
    statusRow.className = "status-row" + (type ? " " + type : "");
  }

  /* ---------------- shape bank: 20 shape types × 12 colors = 240 combos ---------------- */
  const SHAPE_TYPES = ["triangle","square","pentagon","hexagon","heptagon","octagon","diamond",
    "star4","star5","star6","cross","arrowUp","arrowDown","arrowLeft","arrowRight",
    "heart","drop","moon","ring","semicircle"];

  function polygonPath(cx,cy,r,sides,rotationDeg=-90){
    const pts=[];
    for(let i=0;i<sides;i++){
      const a = (rotationDeg + i*360/sides) * Math.PI/180;
      pts.push(`${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`);
    }
    return "M"+pts.join(" L")+" Z";
  }
  function starPath(cx,cy,rOuter,rInner,points,rotationDeg=-90){
    const pts=[];
    for(let i=0;i<points*2;i++){
      const r = i%2===0 ? rOuter : rInner;
      const a = (rotationDeg + i*360/(points*2)) * Math.PI/180;
      pts.push(`${(cx+r*Math.cos(a)).toFixed(1)},${(cy+r*Math.sin(a)).toFixed(1)}`);
    }
    return "M"+pts.join(" L")+" Z";
  }
  function arrowPath(cx,cy,r,dir){
    const w=r*0.9, h=r*1.6;
    const base = [[0,-h/2],[w/2,0],[w/5,0],[w/5,h/2],[-w/5,h/2],[-w/5,0],[-w/2,0]];
    let rot=0;
    if(dir==="down") rot=180; else if(dir==="left") rot=-90; else if(dir==="right") rot=90;
    const rad = rot*Math.PI/180;
    const pts = base.map(([x,y])=>{
      const rx = x*Math.cos(rad)-y*Math.sin(rad);
      const ry = x*Math.sin(rad)+y*Math.cos(rad);
      return `${(cx+rx).toFixed(1)},${(cy+ry).toFixed(1)}`;
    });
    return "M"+pts.join(" L")+" Z";
  }
  function heartPath(cx,cy,r){
    return `M ${cx} ${(cy+r*0.3).toFixed(1)} C ${(cx-r).toFixed(1)} ${(cy-r*0.6).toFixed(1)} ${(cx-r*1.4).toFixed(1)} ${(cy+r*0.5).toFixed(1)} ${cx} ${(cy+r*1.3).toFixed(1)} C ${(cx+r*1.4).toFixed(1)} ${(cy+r*0.5).toFixed(1)} ${(cx+r).toFixed(1)} ${(cy-r*0.6).toFixed(1)} ${cx} ${(cy+r*0.3).toFixed(1)} Z`;
  }
  function dropPath(cx,cy,r){
    return `M ${cx} ${(cy-r).toFixed(1)} C ${(cx+r*0.9).toFixed(1)} ${(cy-r*0.1).toFixed(1)} ${(cx+r*0.7).toFixed(1)} ${(cy+r).toFixed(1)} ${cx} ${(cy+r).toFixed(1)} C ${(cx-r*0.7).toFixed(1)} ${(cy+r).toFixed(1)} ${(cx-r*0.9).toFixed(1)} ${(cy-r*0.1).toFixed(1)} ${cx} ${(cy-r).toFixed(1)} Z`;
  }
  function moonPath(cx,cy,r){
    return `M ${(cx+r*0.35).toFixed(1)} ${(cy-r).toFixed(1)} A ${r} ${r} 0 1 0 ${(cx+r*0.35).toFixed(1)} ${(cy+r).toFixed(1)} A ${(r*0.72).toFixed(1)} ${(r*0.72).toFixed(1)} 0 1 1 ${(cx+r*0.35).toFixed(1)} ${(cy-r).toFixed(1)} Z`;
  }
  function crossPath(cx,cy,r){
    const t=r*0.38;
    return `M ${(cx-t).toFixed(1)} ${(cy-r).toFixed(1)} H ${(cx+t).toFixed(1)} V ${(cy-t).toFixed(1)} H ${(cx+r).toFixed(1)} V ${(cy+t).toFixed(1)} H ${(cx+t).toFixed(1)} V ${(cy+r).toFixed(1)} H ${(cx-t).toFixed(1)} V ${(cy+t).toFixed(1)} H ${(cx-r).toFixed(1)} V ${(cy-t).toFixed(1)} H ${(cx-t).toFixed(1)} Z`;
  }
  function semicirclePath(cx,cy,r){
    return `M ${(cx-r).toFixed(1)} ${cy} A ${r} ${r} 0 0 1 ${(cx+r).toFixed(1)} ${cy} Z`;
  }

  function shapePathFor(type, cx, cy, r){
    switch(type){
      case "triangle": return polygonPath(cx,cy,r,3);
      case "square": return polygonPath(cx,cy,r*0.92,4,-45);
      case "pentagon": return polygonPath(cx,cy,r,5);
      case "hexagon": return polygonPath(cx,cy,r,6);
      case "heptagon": return polygonPath(cx,cy,r,7);
      case "octagon": return polygonPath(cx,cy,r,8);
      case "diamond": return polygonPath(cx,cy,r,4,0);
      case "star4": return starPath(cx,cy,r,r*0.42,4);
      case "star5": return starPath(cx,cy,r,r*0.42,5);
      case "star6": return starPath(cx,cy,r,r*0.5,6);
      case "cross": return crossPath(cx,cy,r);
      case "arrowUp": return arrowPath(cx,cy,r,"up");
      case "arrowDown": return arrowPath(cx,cy,r,"down");
      case "arrowLeft": return arrowPath(cx,cy,r,"left");
      case "arrowRight": return arrowPath(cx,cy,r,"right");
      case "heart": return heartPath(cx,cy,r*0.85);
      case "drop": return dropPath(cx,cy,r*0.85);
      case "moon": return moonPath(cx,cy,r*0.85);
      case "ring": return polygonPath(cx,cy,r*0.78,28);
      case "semicircle": return semicirclePath(cx,cy,r*0.85);
      default: return polygonPath(cx,cy,r,20);
    }
  }

  function shapeMarkup(type, color, size){
    const r = size/2 - 2, cx = size/2, cy = size/2;
    let inner;
    if(type === "ring"){
      inner = `<circle cx="${cx}" cy="${cy}" r="${(r*0.72).toFixed(1)}" fill="none" stroke="${color}" stroke-width="${Math.max(4,size*0.14).toFixed(1)}"/>`;
    } else {
      inner = `<path d="${shapePathFor(type,cx,cy,r)}" fill="${color}"/>`;
    }
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${inner}</svg>`;
  }

  function randomShapeCombo(){
    const type = SHAPE_TYPES[Math.floor(Math.random()*SHAPE_TYPES.length)];
    const color = ACCENTS[Math.floor(Math.random()*ACCENTS.length)];
    return { type, color, key: type+"|"+color };
  }
  function uniqueShapeCombos(n){
    const map = new Map();
    while(map.size < n){
      const c = randomShapeCombo();
      map.set(c.key, c);
    }
    return [...map.values()];
  }

  /* ---------------- 1) text captcha ---------------- */
  const TEXT_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no O/0, I/l/1 confusion
  function genTextCode(len=6){
    let out = "";
    const used = new Set();
    while(out.length < len){
      const c = TEXT_CHARS[Math.floor(Math.random()*TEXT_CHARS.length)];
      if(used.has(c)) continue; // no repeated characters
      used.add(c); out += c;
    }
    return out;
  }
  function drawCaptcha(canvas, code){
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    const grad = ctx.createLinearGradient(0,0,w,h);
    grad.addColorStop(0,"#141c30"); grad.addColorStop(1,"#0a0f1c");
    ctx.fillStyle = grad; ctx.fillRect(0,0,w,h);
    for(let i=0;i<6;i++){
      ctx.strokeStyle = ACCENTS[Math.floor(Math.random()*ACCENTS.length)] + "50";
      ctx.lineWidth = 1 + Math.random()*1.5;
      ctx.beginPath();
      ctx.moveTo(Math.random()*w, Math.random()*h);
      ctx.bezierCurveTo(Math.random()*w,Math.random()*h,Math.random()*w,Math.random()*h,Math.random()*w,Math.random()*h);
      ctx.stroke();
    }
    for(let i=0;i<35;i++){
      ctx.fillStyle = "rgba(255,255,255,"+(Math.random()*0.15).toFixed(2)+")";
      ctx.beginPath(); ctx.arc(Math.random()*w, Math.random()*h, Math.random()*1.6, 0, Math.PI*2); ctx.fill();
    }
    const cellW = w/code.length;
    for(let i=0;i<code.length;i++){
      ctx.save();
      ctx.translate(cellW*i + cellW/2, h/2 + (Math.random()*10-5));
      ctx.rotate((Math.random()*34-17)*Math.PI/180);
      ctx.font = `700 ${Math.round(h*0.5)}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = ACCENTS[i % ACCENTS.length];
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(code[i], 0, 0);
      ctx.restore();
    }
  }
  function renderTextChallenge(){
    const code = genTextCode(6);
    challengeArea.innerHTML = `
      <div class="challenge challenge-text">
        <div class="captcha-frame"><canvas id="captchaCanvas" height="96"></canvas></div>
        <p class="challenge-hint">اكتب الكود اللي شايفه بالظبط (بحروفه الكبيرة والصغيرة)</p>
        <input type="text" id="captchaInput" class="challenge-input" autocomplete="off" maxlength="6" placeholder="اكتب الكود هنا">
        <button type="button" class="primary-btn challenge-submit" id="captchaSubmit">تأكيد</button>
      </div>`;
    const canvas = $("#captchaCanvas");
    canvas.width = Math.round(Math.min(340, Math.max(240, challengeArea.clientWidth || 320)));
    drawCaptcha(canvas, code);
    const input = $("#captchaInput");
    const submit = $("#captchaSubmit");
    input.addEventListener("input", ()=> setStatus("",""));
    input.addEventListener("keydown", e=>{ if(e.key === "Enter"){ e.preventDefault(); submit.click(); } });
    submit.addEventListener("click", ()=>{
      const val = input.value.trim();
      if(!val){ setStatus("اكتب الكود الأول", "error"); return; }
      if(val === code) handleResult(true);
      else handleResult(false, "الكود مش مطابق، جرّب تاني");
    });
    setTimeout(()=> input.focus(), 60);
  }

  /* ---------------- 2) shape order challenge ---------------- */
  function renderShapeChallenge(){
    const targets = uniqueShapeCombos(4);
    const distractors = [];
    while(distractors.length < 2){
      const c = randomShapeCombo();
      if(!targets.find(t=>t.key===c.key) && !distractors.find(d=>d.key===c.key)) distractors.push(c);
    }
    const pool = [...targets, ...distractors].sort(()=> Math.random()-0.5);

    challengeArea.innerHTML = `
      <div class="challenge challenge-shapes">
        <p class="challenge-hint">احفظ ترتيب الأشكال دي</p>
        <div class="shape-reference" id="shapeReference"></div>
        <p class="challenge-hint">دلوقتي دوس عليهم بنفس الترتيب من اللي تحت</p>
        <div class="shape-answer-slots" id="shapeAnswerSlots"></div>
        <div class="shape-pool" id="shapePool"></div>
        <button type="button" class="secondary-btn challenge-reset" id="shapeReset">إعادة الاختيار</button>
        <button type="button" class="primary-btn challenge-submit" id="shapeSubmit">تأكيد</button>
      </div>`;

    const refBox = $("#shapeReference");
    targets.forEach(t=> refBox.insertAdjacentHTML("beforeend", `<div class="shape-chip">${shapeMarkup(t.type,t.color,44)}</div>`));

    const slotsBox = $("#shapeAnswerSlots");
    for(let i=0;i<4;i++) slotsBox.insertAdjacentHTML("beforeend", `<div class="shape-slot" data-slot="${i}"></div>`);
    const slotEls = $$(".shape-slot", slotsBox);

    const poolBox = $("#shapePool");
    let answer = [];
    function renderSlots(){
      slotEls.forEach((slot,i)=>{ slot.innerHTML = answer[i] ? shapeMarkup(answer[i].type, answer[i].color, 40) : ""; });
    }
    poolBox.innerHTML = "";
    pool.forEach(s=>{
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "shape-pool-btn"; btn.dataset.key = s.key;
      btn.innerHTML = shapeMarkup(s.type, s.color, 52);
      btn.addEventListener("click", ()=>{
        if(btn.classList.contains("used") || answer.length >= 4) return;
        answer.push(s);
        btn.classList.add("used");
        renderSlots();
        setStatus("","");
      });
      poolBox.appendChild(btn);
    });

    $("#shapeReset").addEventListener("click", ()=>{
      answer = [];
      $$(".shape-pool-btn", poolBox).forEach(b=> b.classList.remove("used"));
      renderSlots();
      setStatus("","");
    });

    $("#shapeSubmit").addEventListener("click", ()=>{
      if(answer.length < 4){ setStatus("اختار الأربعة أشكال الأول", "error"); return; }
      const ok = answer.every((a,i)=> a.key === targets[i].key);
      if(ok) handleResult(true);
      else handleResult(false, "الترتيب مش صح، جرّب تاني");
    });
  }

  /* ---------------- 3) drag-piece-into-outline challenge ---------------- */
  function renderPieceChallenge(){
    challengeArea.innerHTML = `
      <div class="challenge challenge-piece">
        <p class="challenge-hint">اسحب الشكل وحطه جوه المكان المنقط، وبعدين دوس تأكيد</p>
        <div class="piece-board" id="pieceBoard"></div>
        <button type="button" class="primary-btn challenge-submit" id="pieceSubmit">تأكيد</button>
      </div>`;

    const board = $("#pieceBoard");
    const boardW = Math.round(Math.min(380, Math.max(240, (challengeArea.clientWidth || 320) - 4)));
    const boardH = Math.round(boardW * 0.56);
    board.style.width = boardW + "px";
    board.style.height = boardH + "px";

    const combo = randomShapeCombo();
    const pieceSize = Math.round(boardW * 0.17);
    const margin = pieceSize/2 + 8;
    const targetX = margin + Math.random()*(boardW - margin*2);
    const targetY = margin + Math.random()*(boardH - margin*2);
    let startX = margin + Math.random()*(boardW - margin*2);
    let startY = margin + Math.random()*(boardH - margin*2);
    let guard = 0;
    while(Math.hypot(startX-targetX, startY-targetY) < pieceSize*1.4 && guard < 20){
      startX = margin + Math.random()*(boardW - margin*2);
      startY = margin + Math.random()*(boardH - margin*2);
      guard++;
    }

    board.innerHTML = `
      <svg class="piece-board-bg" viewBox="0 0 ${boardW} ${boardH}">
        <defs><linearGradient id="pgrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#141c30"/><stop offset="1" stop-color="#0a0f1c"/>
        </linearGradient></defs>
        <rect width="${boardW}" height="${boardH}" fill="url(#pgrad)"/>
        <path d="${shapePathFor(combo.type, targetX, targetY, pieceSize/2-4)}" fill="none" stroke="${combo.color}" stroke-width="2.5" stroke-dasharray="5,4" opacity=".85"/>
      </svg>
      <div class="piece-drag" id="pieceDrag" style="width:${pieceSize}px; height:${pieceSize}px; left:${startX-pieceSize/2}px; top:${startY-pieceSize/2}px;">
        ${shapeMarkup(combo.type, combo.color, pieceSize)}
      </div>`;

    const drag = $("#pieceDrag");
    const TOLERANCE = pieceSize * 0.34;
    let dragging = false, offX = 0, offY = 0, curX = startX, curY = startY;

    function pointFromEvent(e){
      const rect = board.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - rect.left, y: p.clientY - rect.top };
    }
    function down(e){ dragging = true; const p = pointFromEvent(e); offX = p.x-curX; offY = p.y-curY; }
    function move(e){
      if(!dragging) return;
      const p = pointFromEvent(e);
      curX = Math.min(boardW-4, Math.max(4, p.x-offX));
      curY = Math.min(boardH-4, Math.max(4, p.y-offY));
      drag.style.left = (curX-pieceSize/2)+"px";
      drag.style.top = (curY-pieceSize/2)+"px";
    }
    function up(){ dragging = false; }

    drag.addEventListener("mousedown", down);
    drag.addEventListener("touchstart", down, {passive:true});
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, {passive:true});
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);

    $("#pieceSubmit").addEventListener("click", ()=>{
      const dist = Math.hypot(curX-targetX, curY-targetY);
      if(dist <= TOLERANCE) handleResult(true);
      else handleResult(false, "القطعة مش في مكانها، جرّب تاني");
    });
  }

  /* ---------------- orchestration ---------------- */
  const RENDERERS = [renderTextChallenge, renderShapeChallenge, renderPieceChallenge];
  function renderRandomChallenge(){
    setStatus("","");
    RENDERERS[Math.floor(Math.random()*RENDERERS.length)]();
    updateProgressUI();
  }

  function handleResult(correct, failMsg){
    if(correct){
      state.streak += 1;
      saveState(state);
      updateProgressUI();
      if(state.streak >= state.required){
        setStatus("تمام! جاري الدخول...", "success");
        finishGate();
      } else {
        setStatus("صح! كمّل كده", "success");
        setTimeout(renderRandomChallenge, 550);
      }
    } else {
      state.required = Math.min(state.required + 1, MAX_REQUIRED);
      state.streak = 0;
      saveState(state);
      updateProgressUI();
      setStatus(failMsg || "إجابة غلط، جرّب تاني", "error");
      setTimeout(renderRandomChallenge, 700);
    }
  }

  function finishGate(){
    setTimeout(()=>{
      gateHeader.style.display = "none";
      challengeArea.style.display = "none";
      statusRow.style.display = "none";
      progressWrap.style.display = "none";
      successView.style.display = "flex";
    }, 250);
    setTimeout(()=>{
      gate.classList.add("hidden");
      saveState({ required:1, streak:0 }); // fresh start if this gate is ever reached again
      try{ localStorage.setItem("wasla_device_verified", "1"); }catch(e){}
      onGateSuccess();
    }, 1350);
  }

  updateProgressUI();
  renderRandomChallenge();
})();

/* =====================================================================
   2) AUTH FLOW
   ===================================================================== */
function onGateSuccess(){
  if(!firebaseReady){
    $("#authScreen").classList.remove("hidden");
    $("#authError").textContent = "⚠️ لازم تربط الموقع بمشروع Firebase الأول (شوف script.js وملف README.txt).";
    return;
  }
  auth.onAuthStateChanged(async (user)=>{
    if(user){
      try{
        const snap = await db.collection("users").doc(user.uid).get();
        if(snap.exists){
          currentUser = { uid:user.uid, ...snap.data() };
          if(!Array.isArray(currentUser.savedContacts)) currentUser.savedContacts = [];
          enterApp();
        } else {
          $("#authScreen").classList.remove("hidden");
        }
      }catch(err){
        console.error(err);
        $("#authScreen").classList.remove("hidden");
        $("#authError").textContent = friendlyErrorMessage(err);
      }
    } else {
      $("#authScreen").classList.remove("hidden");
    }
  });
}

/* ---------------- auth tabs (register / login) ---------------- */
$$(".auth-tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    $$(".auth-tab-btn").forEach(b=>b.classList.remove("active"));
    $$(".auth-pane").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active");
    $("#authPane-"+btn.dataset.authTab).classList.add("active");
    $("#authError").textContent = "";
  });
});

/* Firebase Auth needs *some* email under the hood, but the person never
   sees or types one — it's derived straight from their generated ID, so
   all they ever deal with is "ID + password". */
function syntheticEmailForId(id){ return `id${id}@wasla-app.local`; }

/* avatar picking on the registration screen */
let pendingPhoto = "";
$("#avatarInput").addEventListener("change", async (e)=>{
  const file = e.target.files[0]; if(!file) return;
  pendingPhoto = await resizeImageFile(file);
  $("#avatarImg").src = pendingPhoto;
  $("#avatarImg").classList.remove("hidden");
  $("#avatarInitial").classList.add("hidden");
});
$("#nameInput").addEventListener("input", (e)=>{
  if(!pendingPhoto) $("#avatarInitial").textContent = initials(e.target.value);
});

$("#registerBtn").addEventListener("click", async ()=>{
  const name = $("#nameInput").value.trim();
  const bio = $("#bioInput").value.trim();
  const password = $("#passwordInput").value.trim();
  const errEl = $("#authError");
  errEl.textContent = "";
  if(!name){ errEl.textContent = "من فضلك اكتب اسمك."; return; }
  if(!password || password.length < 6){ errEl.textContent = "كلمة السر لازم تكون 6 أحرف على الأقل."; return; }
  if(!firebaseReady){ errEl.textContent = "الموقع مش متصل بـ Firebase لسه."; return; }

  const btn = $("#registerBtn");
  btn.disabled = true; btn.textContent = "جاري التسجيل...";
  try{
    /* sign in anonymously first (needed so the ID-uniqueness lookup below
       is allowed by Firestore rules), then link a real password
       credential to that SAME uid — so the account becomes permanent
       without us ever having to show/ask for an email */
    if(auth.currentUser && !auth.currentUser.isAnonymous){ try{ await auth.signOut(); }catch(e){} }
    if(!auth.currentUser){ await auth.signInAnonymously(); }

    let id = genId(), tries = 0;
    while(tries < 8){
      const dup = await db.collection("users").where("id","==",id).limit(1).get();
      if(dup.empty) break;
      id = genId(); tries++;
    }

    const emailCred = firebase.auth.EmailAuthProvider.credential(syntheticEmailForId(id), password);
    const userCred = await auth.currentUser.linkWithCredential(emailCred);
    const uid = userCred.user.uid;

    const profile = {
      id, name, bio: bio || "", photoURL: pendingPhoto || "",
      blocked: [], pinnedChats: [], savedContacts: [], lastSeenPrivacy: "everyone", readReceipts: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection("users").doc(uid).set(profile);
    currentUser = { uid, ...profile, blocked: [], pinnedChats: [], savedContacts: [] };
    enterApp();
  }catch(err){
    console.error(err);
    if(err && err.code === "auth/weak-password") errEl.textContent = "كلمة السر ضعيفة، اختار كلمة سر أقوى.";
    else if(err && err.code === "auth/credential-already-in-use") errEl.textContent = "حصل تعارض في إنشاء الحساب، جرّب تاني.";
    else errEl.textContent = friendlyErrorMessage(err);
  }finally{
    btn.disabled = false; btn.textContent = "ابدأ الدردشة";
  }
});

$("#loginIdInput").addEventListener("input", e=>{ e.target.value = e.target.value.replace(/\D/g,""); });

$("#loginBtn").addEventListener("click", async ()=>{
  const id = $("#loginIdInput").value.trim();
  const password = $("#loginPasswordInput").value.trim();
  const errEl = $("#authError");
  errEl.textContent = "";
  if(id.length !== 11){ errEl.textContent = "رقم التعريف لازم يكون 11 رقم."; return; }
  if(!password){ errEl.textContent = "اكتب كلمة السر."; return; }
  if(!firebaseReady){ errEl.textContent = "الموقع مش متصل بـ Firebase لسه."; return; }

  const btn = $("#loginBtn");
  btn.disabled = true; btn.textContent = "جاري الدخول...";
  try{
    if(auth.currentUser){ try{ await auth.signOut(); }catch(e){} }
    await auth.signInWithEmailAndPassword(syntheticEmailForId(id), password);
    /* onAuthStateChanged (registered below in onGateSuccess) picks this
       up automatically and calls enterApp() once the profile loads */
  }catch(err){
    console.error(err);
    if(err && (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential")) errEl.textContent = "كلمة السر غلط.";
    else if(err && err.code === "auth/user-not-found") errEl.textContent = "الحساب ده مش موجود.";
    else if(err && err.code === "auth/too-many-requests") errEl.textContent = "محاولات كتير في وقت قصير، استنى شوية وجرّب تاني.";
    else errEl.textContent = friendlyErrorMessage(err);
  }finally{
    btn.disabled = false; btn.textContent = "دخول";
  }
});

/* ---------------- logout ---------------- */
function resetUIAfterAuthEnd(){
  currentUser = null; activeChatPeer = null; activeChatId = null;
  closePeerProfile();
  closeLightbox();

  $("#settingsOverlay").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#app").classList.remove("chat-open");
  $("#chatActive").classList.add("hidden");
  $("#chatPlaceholder").classList.remove("hidden");

  $$(".auth-tab-btn").forEach(b=> b.classList.toggle("active", b.dataset.authTab === "login"));
  $$(".auth-pane").forEach(p=> p.classList.toggle("active", p.id === "authPane-login"));
  $("#loginIdInput").value = ""; $("#loginPasswordInput").value = "";
  $("#authError").textContent = "";

  /* also clear the register pane so a brand-new account never inherits
     the previous account's name/bio/password/photo */
  pendingPhoto = "";
  $("#nameInput").value = "";
  $("#bioInput").value = "";
  $("#passwordInput").value = "";
  $("#avatarImg").src = "";
  $("#avatarImg").classList.add("hidden");
  $("#avatarInitial").textContent = "؟";
  $("#avatarInitial").classList.remove("hidden");

  $("#authScreen").classList.remove("hidden");
}

async function logout(){
  try{
    await setPresence(false);
    stopPresenceTracking();
    if(chatListUnsub){ chatListUnsub(); chatListUnsub = null; }
    if(msgUnsub){ msgUnsub(); msgUnsub = null; }
    unwatchAllPeers();
    if(auth) await auth.signOut();
  }catch(e){ console.error(e); }

  resetUIAfterAuthEnd();
  toast("تم تسجيل الخروج");
}
$("#logoutBtn").addEventListener("click", ()=>{
  if(confirm("متأكد إنك عايز تسجل خروج؟")) logout();
});

/* =====================================================================
   2.1) PERMANENT ACCOUNT DELETION (asks for the password first, then
   wipes the Firestore user doc + every chat/message they're part of,
   then deletes the Firebase Auth account itself — irreversible)
   ===================================================================== */
$("#deleteAccountBtn").addEventListener("click", ()=>{
  $("#deleteAccountPasswordInput").value = "";
  $("#deleteAccountMsg").textContent = "";
  $("#deleteAccountOverlay").classList.remove("hidden");
  $("#deleteAccountPasswordInput").focus();
});
$("#cancelDeleteAccountBtn").addEventListener("click", ()=>{
  $("#deleteAccountOverlay").classList.add("hidden");
  $("#deleteAccountPasswordInput").value = "";
  $("#deleteAccountMsg").textContent = "";
});
$("#deleteAccountOverlay").addEventListener("click", (e)=>{
  if(e.target.id === "deleteAccountOverlay") $("#cancelDeleteAccountBtn").click();
});

$("#confirmDeleteAccountBtn").addEventListener("click", async ()=>{
  const password = $("#deleteAccountPasswordInput").value;
  const msgEl = $("#deleteAccountMsg");
  msgEl.textContent = "";
  if(!password){ msgEl.textContent = "اكتب كلمة السر الأول."; return; }
  if(!currentUser || !auth.currentUser){ msgEl.textContent = "حصل خطأ، جرّب تسجل دخول تاني."; return; }

  const btn = $("#confirmDeleteAccountBtn");
  btn.disabled = true; btn.textContent = "جاري الحذف...";
  try{
    /* re-verify the password before touching anything — this is the
       "type the password, then it deletes" step */
    const cred = firebase.auth.EmailAuthProvider.credential(syntheticEmailForId(currentUser.id), password);
    await auth.currentUser.reauthenticateWithCredential(cred);

    const uid = currentUser.uid, myId = currentUser.id;

    /* wipe every chat (and its messages) this account is part of, on
       both sides, so nothing orphaned is left behind for the other
       person either */
    const chatsSnap = await db.collection("chats").where("participants","array-contains", myId).get();
    for(const chatDoc of chatsSnap.docs){
      const msgsSnap = await chatDoc.ref.collection("messages").get();
      const batch = db.batch();
      msgsSnap.forEach(m=> batch.delete(m.ref));
      batch.delete(chatDoc.ref);
      await batch.commit();
    }

    await db.collection("users").doc(uid).delete();
    await auth.currentUser.delete();

    if(chatListUnsub){ chatListUnsub(); chatListUnsub = null; }
    if(msgUnsub){ msgUnsub(); msgUnsub = null; }
    stopPresenceTracking();
    unwatchAllPeers();

    $("#deleteAccountOverlay").classList.add("hidden");
    $("#deleteAccountPasswordInput").value = "";
    resetUIAfterAuthEnd();
    toast("اتحذف الحساب خالص");
  }catch(err){
    console.error(err);
    if(err && (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential")) msgEl.textContent = "كلمة السر غلط.";
    else msgEl.textContent = friendlyErrorMessage(err);
  }finally{
    btn.disabled = false; btn.textContent = "حذف الحساب نهائيًا";
  }
});

/* =====================================================================
   3) ENTER APP
   ===================================================================== */
function enterApp(){
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");

  $("#myName").textContent = currentUser.name;
  $("#myIdDisplay").textContent = "ID: " + currentUser.id;
  setAvatarNode($("#myAvatar"), currentUser.name, currentUser.photoURL);

  loadLocalPrefs();
  buildColorGrid();
  buildWallpaperGrid();
  renderBlockedList();
  listenChatList();
  startPresenceTracking();
  /* NOTE: no auto-reopen of the last chat here on purpose — a refresh
     (or logging back in, on any device) should always land on the
     chat list / placeholder screen, and the person picks which
     conversation to open themselves, instead of it jumping straight
     back into whoever they last talked to. */
}

/* =====================================================================
   3.1) ONLINE / LAST-SEEN PRESENCE (WhatsApp-style "last seen today at
   3:45 PM" text shown under the peer's name when they aren't online)
   ===================================================================== */
let presenceHeartbeatTimer = null;

async function setPresence(online){
  if(!currentUser || !currentUser.uid) return;
  try{
    await db.collection("users").doc(currentUser.uid).set({
      online, lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
  }catch(e){ /* best-effort only — a failed presence write shouldn't break anything */ }
}
function handlePresenceVisibility(){
  setPresence(document.visibilityState === "visible");
}
function handlePresenceHide(){
  setPresence(false);
}
function startPresenceTracking(){
  setPresence(true);
  if(presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  /* re-stamp lastSeen every so often while the tab is actually visible,
     so if the browser ever closes without firing pagehide (crash, force
     quit, phone killing the tab) the "last seen" shown to others is
     still reasonably close to the truth instead of stuck forever */
  presenceHeartbeatTimer = setInterval(()=>{
    if(document.visibilityState === "visible") setPresence(true);
  }, 25000);
  document.addEventListener("visibilitychange", handlePresenceVisibility);
  window.addEventListener("pagehide", handlePresenceHide);
  window.addEventListener("beforeunload", handlePresenceHide);
}
function stopPresenceTracking(){
  if(presenceHeartbeatTimer){ clearInterval(presenceHeartbeatTimer); presenceHeartbeatTimer = null; }
  document.removeEventListener("visibilitychange", handlePresenceVisibility);
  window.removeEventListener("pagehide", handlePresenceHide);
  window.removeEventListener("beforeunload", handlePresenceHide);
}

/* "آخر ظهور النهارده الساعة 3:45 م" / "امبارح" / day name / full date,
   exactly like WhatsApp's last-seen line */
function formatLastSeen(ts){
  if(!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const now = new Date();
  const timeStr = d.toLocaleTimeString("ar-EG", {hour:"numeric", minute:"2-digit"});
  const sameDay = (a,b)=> a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  if(sameDay(d, now)) return `آخر ظهور النهاردة الساعة ${timeStr}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate()-1);
  if(sameDay(d, yesterday)) return `آخر ظهور إمبارح الساعة ${timeStr}`;
  const daysAgo = Math.floor((now - d) / (24*60*60*1000));
  if(daysAgo < 7) return `آخر ظهور يوم ${d.toLocaleDateString("ar-EG", {weekday:"long"})} الساعة ${timeStr}`;
  return `آخر ظهور ${d.toLocaleDateString("ar-EG", {day:"numeric", month:"long"})} الساعة ${timeStr}`;
}

/* Kept only so other code (delete-chat, openChat) can clear/set it without
   extra checks. No longer read back on load — see the note in enterApp()
   above about refresh always landing on the chat list, not auto-reopening
   whoever was last open. */
function saveLastChat(peerId){
  try{ localStorage.setItem(prefKey("lastChatPeerId"), peerId || ""); }catch(e){}
}

/* ------------------------ per-user local prefs (theme/colors/wallpaper) --- */
function prefKey(k){ return `wasla_${k}_${currentUser.uid}`; }
function loadLocalPrefs(){
  const theme = localStorage.getItem(prefKey("theme")) || "dark";
  const accent = localStorage.getItem(prefKey("accent")) || "#f2b134";
  const wallpaper = localStorage.getItem(prefKey("wallpaper")) || "";
  const layoutMode = localStorage.getItem(prefKey("layoutMode")) || "auto";
  applyTheme(theme);
  applyAccent(accent);
  applyWallpaper(wallpaper);
  applyLayoutMode(layoutMode);
}
function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(prefKey("theme"), theme);
  $$(".theme-opt[data-theme-choice]").forEach(b=> b.classList.toggle("active", b.dataset.themeChoice === theme));
}
/* "auto" = normal split view (sidebar + chat) on wide screens like
   iPad, same as it's always been. "single" forces the phone-style
   single-pane layout even on those wide screens, for people who'd
   rather have the chat take over the whole screen on iPad too. Just
   a CSS attribute switch — the actual open/close logic already works
   the same underneath either way. */
function applyLayoutMode(mode){
  document.documentElement.setAttribute("data-layout-mode", mode);
  localStorage.setItem(prefKey("layoutMode"), mode);
  $$(".theme-opt[data-layout-choice]").forEach(b=> b.classList.toggle("active", b.dataset.layoutChoice === mode));
}
function applyAccent(hex){
  document.documentElement.style.setProperty("--chat-accent", hex);
  localStorage.setItem(prefKey("accent"), hex);
  $$(".color-swatch").forEach(s=> s.classList.toggle("active", s.dataset.color === hex));
  const customInput = $("#customColorInput"), customSwatch = $("#customColorSwatch");
  if(customInput) customInput.value = hex;
  if(customSwatch) customSwatch.style.background = hex;
}
function applyWallpaper(value){
  const el = $("#messages");
  localStorage.setItem(prefKey("wallpaper"), value || "");
  if(!el) { pendingWallpaperCSS = value; return; }
  setWallpaperCSS(el, value);
}
let pendingWallpaperCSS = "";
function setWallpaperCSS(el, value){
  if(!value || value === "none"){ el.style.background = ""; return; }
  if(value.startsWith("data:")){
    el.style.background = `url(${value}) center/cover no-repeat`;
    return;
  }
  const preset = WALLPAPERS.find(w=>w.id===value);
  if(preset){
    el.style.color = "var(--card-border)";
    el.style.backgroundImage = preset.css;
    el.style.backgroundSize = preset.size || "auto";
  }
}

/* =====================================================================
   4) SEARCH BY ID
   ===================================================================== */
$("#searchIdBtn").addEventListener("click", searchById);
$("#searchIdInput").addEventListener("keydown", e=>{ if(e.key==="Enter") searchById(); });
$("#searchIdInput").addEventListener("input", e=>{
  e.target.value = e.target.value.replace(/\D/g,"");
  /* an emptied input means whatever result (found person or "no user"
     message) is currently showing no longer refers to anything typed —
     clear it instead of leaving it stuck on screen */
  if(!e.target.value){
    const box = $("#searchResult");
    box.classList.add("hidden");
    box.innerHTML = "";
  }
});

async function searchById(){
  const id = $("#searchIdInput").value.trim();
  const box = $("#searchResult");
  if(id.length !== 11){ toast("رقم التعريف لازم يكون 11 رقم", true); return; }
  if(id === currentUser.id){ toast("ده رقمك أنت 🙂", true); return; }
  box.classList.remove("hidden");
  box.innerHTML = `<span class="hint-text">جاري البحث...</span>`;
  try{
    const snap = await db.collection("users").where("id","==",id).limit(1).get();
    if(snap.empty){
      box.className = "search-result empty";
      box.innerHTML = `<span>مفيش مستخدم برقم التعريف ده</span>`;
      return;
    }
    const peer = snap.docs[0].data();
    peer.uid = snap.docs[0].id;
    peerCache[peer.id] = peer;
    box.className = "search-result";
    box.innerHTML = `
      <div class="avatar sm" id="srAvatar"><span></span><img class="hidden"></div>
      <div class="sr-info"><strong>${escapeHtml(peer.name)}</strong><span>${peer.id}</span></div>
      <button id="srOpenBtn">دردشة</button>`;
    setAvatarNode($("#srAvatar"), peer.name, peer.photoURL);
    $("#srOpenBtn").addEventListener("click", ()=> openChat(peer));
  }catch(err){
    console.error(err);
    box.className = "search-result empty";
    box.innerHTML = `<span>حصل خطأ في البحث</span>`;
  }
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* =====================================================================
   5) CHAT LIST (realtime)
   ===================================================================== */
const MAX_PINNED_CHATS = 3;
let lastChatListSnapDocs = []; // cached docs from the last chats snapshot, so toggling a pin can re-render instantly without waiting on Firestore

function listenChatList(){
  if(chatListUnsub) chatListUnsub();
  /* NOTE: intentionally no .orderBy("updatedAt") here — combining an
     array-contains where() with an orderBy() needs a composite index to
     be created manually in the Firebase console first. Until that's
     done, Firestore fails the WHOLE listener silently (console-only
     error), which looked exactly like "the other person's chat list
     never updates". Sorting the small chat list client-side avoids
     needing that index at all. */
  chatListUnsub = db.collection("chats")
    .where("participants","array-contains", currentUser.id)
    .onSnapshot(async (snap)=>{
      lastChatListSnapDocs = snap.docs;
      await renderChatList(snap.docs);
    }, err=> console.error("chat list error", err));
}

async function renderChatList(rawDocs){
  const list = $("#chatList");
  const empty = $("#chatListEmpty");

  const pinnedIds = Array.isArray(currentUser.pinnedChats) ? currentUser.pinnedChats : [];

  /* a chat I've soft-deleted (see the delete-chat handler) carries my id
     in deletedFor — that must make it vanish from MY list entirely,
     while the other person's copy is completely untouched. It only
     comes back for me once someone actually sends a new message in it
     (handled in the composer submit handler, which clears deletedFor
     for both sides again). */
  const visibleDocs = rawDocs.filter(d=>{
    const df = d.data().deletedFor;
    return !(Array.isArray(df) && df.includes(currentUser.id));
  });

  if(!visibleDocs.length){ empty.classList.remove("hidden"); }
  else empty.classList.add("hidden");

  const docs = visibleDocs.slice().sort((a,b)=>{
    const aData = a.data(), bData = b.data();
    const aPeerId = aData.participants.find(p=>p!==currentUser.id);
    const bPeerId = bData.participants.find(p=>p!==currentUser.id);
    const aPinned = pinnedIds.includes(aPeerId);
    const bPinned = pinnedIds.includes(bPeerId);
    if(aPinned !== bPinned) return aPinned ? -1 : 1;
    if(aPinned && bPinned) return pinnedIds.indexOf(aPeerId) - pinnedIds.indexOf(bPeerId);
    const at = aData.updatedAt ? aData.updatedAt.toMillis() : 0;
    const bt = bData.updatedAt ? bData.updatedAt.toMillis() : 0;
    return bt - at;
  });

  list.querySelectorAll(".chat-item").forEach(n=>n.remove());
  const seenPeerIds = [];
  for(const doc of docs){
    const data = doc.data();
    const peerId = data.participants.find(p=>p!==currentUser.id);
    if(!peerId) continue;
    seenPeerIds.push(peerId);
    let peer = peerCache[peerId];
    if(!peer || !peer.uid){
      const s = await db.collection("users").where("id","==",peerId).limit(1).get();
      peer = s.empty ? {id:peerId, name:"مستخدم", photoURL:""} : { ...s.docs[0].data(), uid: s.docs[0].id };
      peerCache[peerId] = peer;
    }
    const unread = (data.unreadCounts && data.unreadCounts[currentUser.id]) || 0;
    const isOpenRightNow = activeChatPeer && activeChatPeer.id === peerId;
    const draftText = isOpenRightNow ? "" : getDraftText(chatIdFor(currentUser.id, peerId));
    const previewSource = (isOpenRightNow && frozenChatListPreview && frozenChatListPreview.peerId === peerId)
      ? frozenChatListPreview
      : data;
    let lastTickHtml = "";
    if(!draftText && previewSource.lastMessage && previewSource.lastMessageSenderId === currentUser.id){
      const st = displayStatus(previewSource.lastMessageStatus || "sent");
      const cls = st === "read" ? "read" : (st === "delivered" ? "delivered" : "");
      lastTickHtml = `<span class="msg-ticks ci-tick${cls ? " "+cls : ""}">${st === "sent" ? TICK_SINGLE : TICK_DOUBLE}</span>`;
    }
    const isPinned = pinnedIds.includes(peerId);
    const item = document.createElement("div");
    item.className = "chat-item" + (activeChatPeer && activeChatPeer.id===peerId ? " active" : "") + (isPinned ? " pinned" : "") + (chatListSelectedIds.has(peerId) || contextMenuChatPeerId === peerId ? " selected" : "");
    item.dataset.peerId = peerId;
    const previewHtml = draftText
      ? `<span class="ci-draft-label">مسودة: </span><span class="ci-last draft">${escapeHtml(draftText)}</span>`
      : `<span class="ci-last">${escapeHtml(previewSource.lastMessage || "")}</span>`;
    item.innerHTML = `
      <div class="ci-avatar-wrap">
        <div class="avatar" id="ci-${peerId}"><span></span><img class="hidden"></div>
        <span class="ci-select-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></span>
      </div>
      ${lastTickHtml ? `<span class="ci-tick-standalone">${lastTickHtml}</span>` : ""}
      <div class="ci-info">
        <div class="ci-top">
          <strong>${escapeHtml(chatListDisplayName(peer))}</strong>
          <span class="ci-top-right">
            <button type="button" class="pin-toggle-btn${isPinned ? " active" : ""}" data-pin-peer="${peerId}" title="${isPinned ? "شيل من المثبتين" : "ثبّت الشخص ده"}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="${isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1z"/></svg>
            </button>
            <span class="ci-time">${fmtTime(data.updatedAt)}</span>
          </span>
        </div>
        <div class="ci-bottom">
          <span class="ci-last-wrap">${previewHtml}</span>
          ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
        </div>
      </div>`;
    setAvatarNode(item.querySelector(`#ci-${peerId}`), chatListDisplayName(peer), peer.photoURL);
    item.addEventListener("click", ()=>{
      /* swallow the synthetic click that follows a long-press on touch
         devices, same idea as the message bubbles' long-press handling */
      if(chatLongPressFired){ chatLongPressFired = false; return; }
      if(isChatListSelectionMode()){ toggleChatListSelection(peerId); return; }
      openChat(peer);
    });
    item.querySelector(".pin-toggle-btn").addEventListener("click", (e)=>{
      e.stopPropagation();
      togglePinChat(peerId);
    });
    list.appendChild(item);
    watchPeer(peer);

    /* my chat list just refreshed, which means I'm online right now
       and have received this chat's data — that's the moment a
       "sent" message from the peer counts as "delivered" (single
       check -> double gray check), same idea as a real chat app. */
    markMessagesDeliveredForChat(doc.id, peerId, data);
  }
  visibleChatPeerIds = seenPeerIds.slice();
  if(!$("#friendsOverlay").classList.contains("hidden")) renderFriendsPage();

  /* stop watching peers that dropped out of the list entirely (e.g. a
     deleted chat) so we don't leak realtime listeners forever */
  Object.keys(peerDocUnsubs).forEach(id=>{
    if(!seenPeerIds.includes(id) && !(activeChatPeer && activeChatPeer.id===id)) unwatchPeer(id);
  });
}

/* =====================================================================
   5.1) PIN A PERSON TO THE TOP OF THE CHAT LIST (up to 3, like WhatsApp's
   pinned chats — this pins the PERSON/conversation itself, not a single
   message inside a chat, which is a separate existing feature)
   ===================================================================== */
async function togglePinChat(peerId){
  const current = Array.isArray(currentUser.pinnedChats) ? currentUser.pinnedChats.slice() : [];
  const isPinned = current.includes(peerId);
  if(!isPinned && current.length >= MAX_PINNED_CHATS){
    toast(`متقدرش تثبت أكتر من ${MAX_PINNED_CHATS} أشخاص، شيل حد الأول`, true);
    return;
  }
  const next = isPinned ? current.filter(id=> id!==peerId) : [...current, peerId];
  try{
    await db.collection("users").doc(currentUser.uid).update({ pinnedChats: next });
    currentUser.pinnedChats = next;
    toast(isPinned ? "تم الشيل من المثبتين" : "تم التثبيت");
    await renderChatList(lastChatListSnapDocs);
  }catch(err){ console.error(err); toast("حصل خطأ", true); }
}

/* =====================================================================
   5.2) SAVE / UNSAVE A PERSON AS A FRIEND
   Saved contacts are stored as an array of {id, alias, familyName}
   objects on my own user doc (currentUser.savedContacts), completely
   separate from the chats collection. That's on purpose: soft-deleting
   a chat (see deleteChatBtn below) only touches the chat doc's
   deletedFor array, so a saved friend must keep showing up here no
   matter what happens to the chat itself.
   "alias" is the name I chose for them when saving (defaults to
   whatever their profile name was at that moment, editable), and
   "familyName" is the optional extra family-name field from the same
   save screen.
   ===================================================================== */
function findSavedContact(peerId){
  return Array.isArray(currentUser.savedContacts) ? currentUser.savedContacts.find(c=> c.id===peerId) : null;
}
function isSavedContact(peerId){
  return !!findSavedContact(peerId);
}
/* Whenever we display a peer's "name" anywhere (chat header, chat list,
   profile modal), a saved contact's custom name (alias + family name)
   takes priority over their raw account name — that's the whole point
   of saving someone under a name I chose. */
function resolveDisplayName(peerId, rawName){
  if(peerId === AI_PEER_ID) return AI_PEER.name;
  const entry = findSavedContact(peerId);
  if(entry && entry.alias) return [entry.alias, entry.familyName].filter(Boolean).join(" ");
  return rawName;
}
/* Sidebar chat list: only ONE line of text per chat (no separate ID
   field next to it), so that single line has to carry the "ID unless
   I've saved them" rule directly — show the saved alias/name if I've
   saved this person as a contact, otherwise show their ID instead of
   their own profile name. */
function chatListDisplayName(peer){
  if(!peer) return "";
  if(peer.id === AI_PEER_ID) return peer.name;
  const entry = findSavedContact(peer.id);
  if(!entry) return peer.id;
  if(entry.alias) return [entry.alias, entry.familyName].filter(Boolean).join(" ");
  return peer.name || peer.id;
}
/* Open-chat header (and reply/quote labels, confirm dialogs): the
   header already shows the ID *and* the name side by side in two
   separate elements (#peerName / #peerId), with CSS flipping which
   one is bold depending on whether I've saved them — so this just
   resolves the actual name/alias. Only falls back to the ID if the
   peer genuinely has no account at all. */
function peerDisplayName(peer){
  if(!peer) return "";
  if(!peer.uid) return peer.id;
  return resolveDisplayName(peer.id, peer.name);
}
async function persistSavedContacts(next){
  await db.collection("users").doc(currentUser.uid).update({ savedContacts: next });
  currentUser.savedContacts = next;
  if(!$("#friendsOverlay").classList.contains("hidden")) renderFriendsPage();
}
async function unsaveContact(peerId){
  const current = Array.isArray(currentUser.savedContacts) ? currentUser.savedContacts.slice() : [];
  const next = current.filter(c=> c.id!==peerId);
  try{
    await persistSavedContacts(next);
    toast("تم إلغاء الحفظ");
    updatePeerProfileSaveUI(peerId);
    refreshSavedNameEverywhere(peerId);
  }catch(err){ console.error(err); toast("حصل خطأ", true); }
}

/* ---- save-friend naming modal: shown when tapping "حفظ" ---- */
let saveFriendTargetId = null;
function openSaveFriendModal(peer){
  saveFriendTargetId = peer.id;
  const existing = findSavedContact(peer.id);
  $("#saveFriendNameInput").value = (existing && existing.alias) ? existing.alias : (peer.name || "");
  $("#saveFriendFamilyInput").value = (existing && existing.familyName) ? existing.familyName : "";
  $("#saveFriendOverlay").classList.remove("hidden");
  $("#saveFriendNameInput").focus();
}
function closeSaveFriendModal(){
  saveFriendTargetId = null;
  $("#saveFriendOverlay").classList.add("hidden");
}
$("#cancelSaveFriendBtn").addEventListener("click", closeSaveFriendModal);
$("#saveFriendOverlay").addEventListener("click", e=>{
  if(e.target.id === "saveFriendOverlay") closeSaveFriendModal();
});
$("#confirmSaveFriendBtn").addEventListener("click", async ()=>{
  if(!saveFriendTargetId) return;
  const id = saveFriendTargetId;
  const alias = $("#saveFriendNameInput").value.trim();
  const familyName = $("#saveFriendFamilyInput").value.trim();
  if(!alias){ toast("لازم تكتب اسم", true); return; }
  const current = Array.isArray(currentUser.savedContacts) ? currentUser.savedContacts.filter(c=> c.id!==id) : [];
  const next = [...current, { id, alias, familyName }];
  try{
    await persistSavedContacts(next);
    toast("اتحفظ في الأصدقاء");
    updatePeerProfileSaveUI(id);
    refreshSavedNameEverywhere(id);
    closeSaveFriendModal();
  }catch(err){ console.error(err); toast("حصل خطأ", true); }
});
/* Pushes the freshly-saved custom name into every place that peer is
   currently shown, without waiting for a Firestore round-trip. */
function refreshSavedNameEverywhere(id){
  const rawName = (peerCache[id] && peerCache[id].name) || (activeChatPeer && activeChatPeer.id===id ? activeChatPeer.name : "") || "";
  const shownName = resolveDisplayName(id, rawName);
  const saved = isSavedContact(id);
  if(activeChatPeer && activeChatPeer.id === id){
    $("#peerName").textContent = shownName;
    $("#peerProfileTrigger").classList.toggle("peer-saved", saved);
  }
  if(peerProfileOpenId === id){
    $("#peerProfileName").textContent = shownName;
    $("#peerProfileOverlay").classList.toggle("peer-saved", saved);
  }
  const ciInfo = document.querySelector(`#ci-${id}`);
  if(ciInfo){
    const strongEl = ciInfo.parentElement && ciInfo.parentElement.querySelector(".ci-info strong");
    if(strongEl) strongEl.textContent = shownName;
  }
  const fiInfo = document.querySelector(`#fi-${id}`);
  if(fiInfo){
    const strongEl = fiInfo.parentElement && fiInfo.parentElement.querySelector(".fi-info strong");
    if(strongEl) strongEl.textContent = shownName;
  }
}

/* Updates the save/unsave button's own state. The big-name-vs-big-ID
   swap is handled separately in refreshPeerUI, based on whether the
   peer has actually registered — not whether I've saved them. */
function updatePeerProfileSaveUI(id){
  if(peerProfileOpenId !== id) return;
  const saved = isSavedContact(id);
  const btn = $("#saveContactBtn");
  btn.classList.toggle("saved", saved);
  $("#saveContactBtnLabel").textContent = saved ? "إلغاء الحفظ" : "حفظ";
}
$("#saveContactBtn").addEventListener("click", ()=>{
  if(!peerProfileOpenId) return;
  if(peerProfileOpenId === AI_PEER_ID) return; // Wasla-AI can't be renamed/saved
  const peer = peerCache[peerProfileOpenId] || (activeChatPeer && activeChatPeer.id===peerProfileOpenId ? activeChatPeer : null);
  if(!peer) return;
  if(isSavedContact(peerProfileOpenId)){
    unsaveContact(peerProfileOpenId);
  } else {
    openSaveFriendModal({ id: peerProfileOpenId, name: peer.name });
  }
});

/* =====================================================================
   5.3) FRIENDS PAGE
   Main list = saved contacts who currently also have a live (non-
   deleted) chat in my chat list. The "show everyone registered with
   me" toggle underneath reveals the FULL saved list regardless of
   chat-deletion status, since a saved friend must never disappear
   just because I deleted our chat — only unsaving removes them.
   ===================================================================== */
async function lookupUserById(id){
  if(peerCache[id] && peerCache[id].uid) return peerCache[id];
  try{
    const s = await db.collection("users").where("id","==",id).limit(1).get();
    const data = s.empty ? {id, name:"مستخدم", photoURL:""} : { ...s.docs[0].data(), uid: s.docs[0].id, id };
    peerCache[id] = data;
    return data;
  }catch(e){ console.error(e); return {id, name:"مستخدم", photoURL:""}; }
}
function buildFriendItem(peer, entry){
  const item = document.createElement("div");
  item.className = "friend-item";
  /* Not-yet-registered peers only have a placeholder name, so just show
     the ID — it's the only useful info. Once they register, show just
     the name instead. */
  const isRegistered = !!peer.uid;
  const displayName = [entry && entry.alias ? entry.alias : peer.name, entry && entry.familyName].filter(Boolean).join(" ");
  const shownText = isRegistered ? displayName : peer.id;
  item.innerHTML = `
    <div class="avatar sm" id="fi-${peer.id}"><span></span><img class="hidden"></div>
    <div class="fi-info">
      <strong>${escapeHtml(shownText)}</strong>
    </div>`;
  setAvatarNode(item.querySelector(`#fi-${peer.id}`), peer.name, peer.photoURL);
  item.addEventListener("click", ()=>{
    closeFriendsPage();
    openChat({ id: peer.id, name: peer.name, photoURL: peer.photoURL, uid: peer.uid });
  });
  return item;
}
async function renderFriendsPage(){
  /* This page shows exactly one list: everyone saved from their profile.
     (Previously there were two overlapping lists here — one filtered to
     only currently-visible chats, one showing every saved contact — which
     just looked like duplicates. Now there's a single source of truth.) */
  const saved = Array.isArray(currentUser.savedContacts) ? currentUser.savedContacts : [];

  const mainList = $("#friendsList");
  mainList.querySelectorAll(".friend-item").forEach(n=>n.remove());
  $("#friendsEmpty").classList.toggle("hidden", saved.length > 0);
  for(const entry of saved){
    mainList.appendChild(buildFriendItem(await lookupUserById(entry.id), entry));
  }
}
function openFriendsPage(){
  $("#friendsOverlay").classList.remove("hidden");
  renderFriendsPage();
}
function closeFriendsPage(){
  $("#friendsOverlay").classList.add("hidden");
}
$("#openFriends").addEventListener("click", openFriendsPage);
$("#closeFriendsBtn").addEventListener("click", closeFriendsPage);
$("#friendsOverlay").addEventListener("click", e=>{
  if(e.target.id === "friendsOverlay") closeFriendsPage();
});

/* =====================================================================
   5.5) REALTIME PEER WATCHING
   Keeps a live Firestore listener on every peer currently visible (chat
   list items + the open chat), so name/photo/bio stay in sync and so we
   can detect "they blocked me" changes without needing a refresh.
   When a peer blocks me, their profile photo is hidden from my side of
   the app ~3s after the block happens (chat list avatar, chat header
   avatar, and the profile modal), mirroring how WhatsApp does it.
   ===================================================================== */
const peerDocUnsubs = {};   // peerId -> Firestore unsubscribe fn
const peerBlockTimers = {}; // peerId -> pending setTimeout handle
const peerBlockHidden = {}; // peerId -> true once photo should be hidden
let peerProfileOpenId = null;

function watchPeer(peer){
  if(!peer || !peer.id || !peer.uid || peerDocUnsubs[peer.id]) return;
  peerDocUnsubs[peer.id] = db.collection("users").doc(peer.uid).onSnapshot(snap=>{
    if(!snap.exists) return;
    const data = { ...snap.data(), id: peer.id, uid: snap.id };
    peerCache[peer.id] = data;
    const blockedMe = Array.isArray(data.blocked) && data.blocked.includes(currentUser.id);
    handleBlockedVisibility(peer.id, blockedMe);
    refreshPeerUI(peer.id, data);
  }, err=> console.error("peer watch error", err));
}
function unwatchPeer(id){
  if(peerDocUnsubs[id]){ peerDocUnsubs[id](); delete peerDocUnsubs[id]; }
  if(peerBlockTimers[id]){ clearTimeout(peerBlockTimers[id]); delete peerBlockTimers[id]; }
  delete peerBlockHidden[id];
}
function unwatchAllPeers(){
  Object.keys(peerDocUnsubs).forEach(unwatchPeer);
}

/* Delays hiding the photo by ~3s after a block is detected, and restores
   it immediately the moment the block is lifted. */
function handleBlockedVisibility(id, blockedMe){
  if(blockedMe){
    if(!peerBlockHidden[id] && !peerBlockTimers[id]){
      peerBlockTimers[id] = setTimeout(()=>{
        peerBlockHidden[id] = true;
        peerBlockTimers[id] = null;
        const p = peerCache[id];
        if(p) refreshPeerUI(id, p);
      }, 3000);
    }
  } else {
    if(peerBlockTimers[id]){ clearTimeout(peerBlockTimers[id]); peerBlockTimers[id] = null; }
    if(peerBlockHidden[id]){ delete peerBlockHidden[id]; }
  }
}

/* Pushes fresh peer data (name / photo / bio / blocked) into every place
   that peer is currently shown: their chat-list row, the open chat
   header (if it's them), and the profile modal (if it's open on them). */
function refreshPeerUI(id, data){
  const hidePhoto = !!peerBlockHidden[id];
  const displayPhoto = hidePhoto ? "" : (data.photoURL || "");

  const ciNode = document.querySelector(`#ci-${id}`);
  if(ciNode) setAvatarNode(ciNode, chatListDisplayName(data), displayPhoto);
  const ciStrong = ciNode && ciNode.parentElement && ciNode.parentElement.querySelector(".ci-info strong");
  if(ciStrong) ciStrong.textContent = chatListDisplayName(data);

  if(activeChatPeer && activeChatPeer.id === id){
    activeChatPeer.name = data.name;
    activeChatPeer.bio = data.bio;
    activeChatPeer.photoURL = data.photoURL;
    activeChatPeer.blocked = data.blocked || [];
    activeChatPeer.uid = data.uid;
    $("#peerName").textContent = resolveDisplayName(id, data.name);
    setAvatarNode($("#peerAvatar"), data.name, displayPhoto);
    /* Chat header: a stranger I haven't saved -> ID big/primary, name
       small underneath. Once I save them (with my own name for them)
       -> that name flips up to be the big/primary line. */
    $("#peerProfileTrigger").classList.toggle("peer-saved", isSavedContact(id));
    updateBlockBanner();

    const statusEl = $("#peerStatus");
    const privacy = data.lastSeenPrivacy || "everyone";
    /* "contacts only" = someone I've actually exchanged at least one
       real message with, not just anyone who opened an empty chat */
    const isContact = !!(activeChatDocData && activeChatDocData.lastMessage);
    const canSeeStatus = privacy === "everyone" || (privacy === "contacts" && isContact);
    if(canSeeStatus && data.online){
      statusEl.textContent = "متصل الآن";
      statusEl.classList.remove("hidden");
    } else if(canSeeStatus && data.lastSeen){
      statusEl.textContent = formatLastSeen(data.lastSeen);
      statusEl.classList.remove("hidden");
    } else {
      statusEl.textContent = "";
      statusEl.classList.add("hidden");
    }
  }

  if(peerProfileOpenId === id){
    $("#peerProfileName").textContent = resolveDisplayName(id, data.name);
    $("#peerProfileId").textContent = data.id;
    $("#peerProfileBio").textContent = (data.bio && data.bio.trim()) ? data.bio : "مفيش نبذة";
    setAvatarNode($("#peerProfileAvatarBig"), data.name, displayPhoto);
    /* Stranger (not saved) -> ID is the useful line, shown big on top.
       Saved -> my chosen name flips up to be the big/primary line. */
    $("#peerProfileOverlay").classList.toggle("peer-saved", isSavedContact(id));
    updatePeerProfileSaveUI(id);
    /* Wasla-AI isn't a contact you save/rename — it just has its fixed
       name and description, so hide the save/rename button entirely */
    $("#saveContactBtn").classList.toggle("hidden", id === AI_PEER_ID);
  }
}

/* ---------------- peer profile modal ---------------- */
$("#peerProfileTrigger").addEventListener("click", ()=>{
  if(!activeChatPeer) return;
  peerProfileOpenId = activeChatPeer.id;
  const data = peerCache[activeChatPeer.id] || activeChatPeer;
  refreshPeerUI(activeChatPeer.id, data);
  updatePeerProfileSaveUI(activeChatPeer.id);
  $("#peerProfileOverlay").classList.remove("hidden");
});
function closePeerProfile(){
  peerProfileOpenId = null;
  $("#peerProfileOverlay").classList.add("hidden");
  $("#peerProfileOverlay").classList.remove("peer-saved");
}
$("#closePeerProfile").addEventListener("click", closePeerProfile);
$("#peerProfileOverlay").addEventListener("click", e=>{
  if(e.target.id === "peerProfileOverlay") closePeerProfile();
});

/* ---------------- copy peer ID button ---------------- */
$("#copyPeerIdBtn").addEventListener("click", async (e)=>{
  e.stopPropagation();
  if(!peerProfileOpenId) return;
  try{
    await navigator.clipboard.writeText(peerProfileOpenId);
  }catch(err){
    try{
      const ta = document.createElement("textarea");
      ta.value = peerProfileOpenId;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }catch(err2){ console.error(err2); toast("مقدرش أنسخ الأيدي", true); return; }
  }
  toast("اتنسخ الأيدي");
});

/* ---------------- fullscreen image lightbox ---------------- */
function openLightbox(src){
  if(!src) return;
  $("#lightboxImg").src = src;
  $("#imageLightbox").classList.remove("hidden");
}
function closeLightbox(){
  $("#imageLightbox").classList.add("hidden");
  $("#lightboxImg").src = "";
}
$("#peerProfileAvatarBig").addEventListener("click", ()=>{
  const img = $("#peerProfileAvatarImg");
  if(!img.classList.contains("hidden") && img.src) openLightbox(img.src);
});
$("#closeLightbox").addEventListener("click", closeLightbox);
$("#imageLightbox").addEventListener("click", e=>{
  if(e.target.id === "imageLightbox") closeLightbox();
});

/* =====================================================================
   6) OPEN / SEND MESSAGES
   ===================================================================== */
const TICK_SINGLE = `<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5 5.5 10 14 2"/></svg>`;
const TICK_DOUBLE = `<svg viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5 4.5 10 13 2"/><path d="M7 6.5 10.5 10 19 2"/></svg>`;
/* "no entry" icon shown on a "this message was deleted" bubble — same
   glyph as the block button, so the app reads as one consistent
   "not allowed" symbol */
const NO_ENTRY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>`;
const VOICE_PLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>`;
const VOICE_PAUSE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;
/* mm:ss for voice-note timers/durations — used both while recording (live
   elapsed time) and when rendering a sent voice message's fixed length */
function fmtDuration(totalSeconds){
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ":" + String(r).padStart(2, "0");
}

/* =====================================================================
   6.0) WASLA AI — a reserved "peer" that isn't a real Firebase Auth
   user. It rides the exact same chat pipeline as a real conversation
   (same chatIdFor, same chats/{id}/messages collection, same onSnapshot
   render loop) so it looks and behaves identically to messaging a real
   person — the AI's replies land in the same collection as anyone
   else's messages and render through the same code path.
   The only different step is sending: right after the composer submit
   handler writes MY message (below), it also calls requestAiReply(),
   which hits a small Cloudflare Worker (see worker.js) that holds the
   real Gemini key server-side, then writes the reply back into this
   same messages subcollection itself. Nothing AI-specific happens
   anywhere else — not in rendering, not in read receipts, not in the
   chat list — it's all inherited for free from the normal chat code.
   ===================================================================== */
const AI_PEER_ID = "wasla-ai";
/* small inline SVG standing in for the app's own logo-dot (accent
   circle + soft glow) — used as this peer's avatar photo everywhere
   avatars normally render (chat list row, chat header, profile modal)
   so it's never just a plain letter fallback */
const AI_AVATAR_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<circle cx="32" cy="32" r="26" fill="rgba(242,177,52,.18)"/>` +
  `<circle cx="32" cy="32" r="11" fill="#f2b134"/>` +
  `</svg>`
)}`;
const AI_PEER_DESCRIPTION = "المساعد الذكي بتاع وصلة، بيرد على أسئلتك ويساعدك في أي حاجة محتاجها جوه التطبيق.";
const AI_PEER = { id: AI_PEER_ID, uid: AI_PEER_ID, name: "Wasla-AI", bio: AI_PEER_DESCRIPTION, photoURL: AI_AVATAR_SVG };
/* seed the cache immediately (not just after opening it once this
   session) — renderChatList looks the peer up here first, and only
   falls back to a Firestore "users" query (which finds nothing for
   this reserved id) when it's missing. Without this, a page refresh
   after already having an AI conversation going would show it in the
   chat list as a generic "مستخدم" instead of "Wasla AI" until you
   opened it again through the friends-list button. */
peerCache[AI_PEER_ID] = AI_PEER;
/* fill this in after deploying worker.js to Cloudflare — see the
   instructions at the top of that file. Looks like:
   "https://wasla-ai.YOUR-SUBDOMAIN.workers.dev" */
const AI_WORKER_URL = "https://wasla-ai.github9822.workers.dev";
const AI_HISTORY_LIMIT = 20;

/* Called right after a message is sent in the Wasla AI chat. Reads
   recent history, calls the Cloudflare Worker (which is the only
   place that ever sees the real Gemini key), then writes the reply
   straight into the same messages subcollection — so it shows up via
   the exact same onSnapshot listener as a message from a real person,
   with no separate render path needed for it. */
async function requestAiReply(chatId, forUserId){
  const chatRef = db.collection("chats").doc(chatId);
  try{
    await chatRef.set({ aiTyping: true }, {merge:true});

    const histSnap = await chatRef.collection("messages").orderBy("ts","desc").limit(AI_HISTORY_LIMIT).get();
    const history = histSnap.docs.reverse()
      .filter(d=> !d.data().deletedForEveryone && d.data().text)
      .map(d=>{
        const m = d.data();
        return { role: m.senderId === AI_PEER_ID ? "model" : "user", parts:[{ text: m.text }] };
      });

    const res = await fetch(AI_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history })
    });
    if(!res.ok) throw new Error("AI worker HTTP " + res.status);
    const data = await res.json();
    const replyText = (data && data.reply && String(data.reply).trim()) || "معلش، مش قادر أرد دلوقتي.";

    await chatRef.collection("messages").add({
      senderId: AI_PEER_ID, text: replyText, status: "sent",
      ts: firebase.firestore.FieldValue.serverTimestamp()
    });
    await chatRef.set({
      participants: [forUserId, AI_PEER_ID],
      lastMessage: replyText, lastMessageSenderId: AI_PEER_ID, lastMessageStatus: "sent",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      aiTyping: false,
      unreadCounts: { [forUserId]: firebase.firestore.FieldValue.increment(1) },
      deletedFor: firebase.firestore.FieldValue.arrayRemove(forUserId, AI_PEER_ID)
    }, {merge:true});
  }catch(err){
    console.error("Wasla AI reply failed:", err);
    await chatRef.set({ aiTyping: false }, {merge:true}).catch(()=>{});
    await chatRef.collection("messages").add({
      senderId: AI_PEER_ID, text: "معلش، حصل خطأ وأنا بحاول أرد. جرب تبعت تاني كمان شوية.",
      status: "sent", ts: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(()=>{});
  }
}
const THUMBS_UP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>`;
const THUMBS_DOWN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>`;

/* Floating circular Wasla AI shortcut on the chat-list page. Shows a
   small "new" dot the very first time it appears; once the person taps
   it (anywhere, this button or the one in the friends page), the dot is
   gone for good — flag is saved per-device in localStorage. */
const AI_FLOAT_SEEN_KEY = "wasla_ai_float_seen";
function markAiFloatSeen(){
  try{ localStorage.setItem(AI_FLOAT_SEEN_KEY, "1"); }catch(e){}
  $("#aiFloatBadge").classList.add("hidden");
}
(function initAiFloatBadge(){
  let seen = false;
  try{ seen = localStorage.getItem(AI_FLOAT_SEEN_KEY) === "1"; }catch(e){}
  $("#aiFloatBadge").classList.toggle("hidden", seen);
})();
$("#openAiChatBtn").addEventListener("click", ()=>{
  markAiFloatSeen();
  closeFriendsPage();
  openChat({ ...AI_PEER });
});
$("#openAiChatFloatBtn").addEventListener("click", ()=>{
  markAiFloatSeen();
  openChat({ ...AI_PEER });
});
/* small pin badge shown next to the time on a pinned message bubble */
const PIN_BADGE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1z"/></svg>`;

/* mark every message sent BY the peer TO me as "read" once I have them
   open in front of me — this is what turns the sender's ticks blue */
async function markMessagesDeliveredForChat(chatId, peerId, chatData){
  /* if I've blocked this peer, their messages must never advance past
     "sent" on their end — that single grey check forever is the whole
     illusion (it just looks like their internet is down) */
  if(Array.isArray(currentUser.blocked) && currentUser.blocked.includes(peerId)) return;
  /* only bother checking when the last message actually came from the
     peer and is still sitting at "sent" — avoids a Firestore read on
     every single chat-list refresh */
  if(!chatData || chatData.lastMessageSenderId !== peerId || chatData.lastMessageStatus !== "sent") return;
  try{
    const snap = await db.collection("chats").doc(chatId).collection("messages")
      .where("senderId","==",peerId).where("status","==","sent").get();
    if(snap.empty) return;
    const batch = db.batch();
    snap.forEach(doc=> batch.update(doc.ref, { status: "delivered" }));
    batch.set(db.collection("chats").doc(chatId), { lastMessageStatus: "delivered" }, {merge:true});
    await batch.commit();
  }catch(e){ console.error("mark delivered failed", e); }
}

/* mirror of the sender-side gate in markPeerMessagesRead: even if a
   peer's message genuinely reached "read" in Firestore, my own ticks
   and chat-list preview must not show that blue double-check to me
   when I've turned read receipts off myself — same "it works both
   ways" rule WhatsApp uses. */
function displayStatus(status){
  if(status === "read" && currentUser && currentUser.readReceipts === false) return "delivered";
  return status;
}

async function markPeerMessagesRead(snapDocs, peerId){
  if(Array.isArray(currentUser.blocked) && currentUser.blocked.includes(peerId)) return;
  /* "الرسائل المقروءة" toggle in settings — off means my client must
     never flip a peer's messages to "read", so their tick just sits at
     "delivered" forever on their end (same illusion as being blocked,
     but only for the read step). Defaults to true for old accounts
     that don't have the field yet. */
  if(currentUser.readReceipts === false) return;
  const unread = snapDocs.filter(doc=>{
    const m = doc.data();
    return m.senderId === peerId && m.status !== "read";
  });
  if(!unread.length) return;
  try{
    const batch = db.batch();
    unread.forEach(doc=> batch.update(doc.ref, { status: "read" }));
    await batch.commit();
    /* if the peer's message was also the chat's last message, flip the
       chat-list tick (on their side) to blue/read too */
    if(chatDocExistsForActive && activeChatId && activeChatDocData && activeChatDocData.lastMessageSenderId === peerId){
      db.collection("chats").doc(activeChatId).set({
        lastMessageStatus: "read"
      }, {merge:true}).catch(()=>{});
    }
  }catch(e){
    console.error("mark read failed", e);
    if(e && e.code === "permission-denied"){
      toast("علامة القراءة متقدرتش تتحدث، الصلاحيات على قاعدة البيانات (Firestore Rules) مش سامحة إني أعدّل رسايل الشخص التاني.", true);
    }
  }
}

async function openChat(peer){
  /* already sitting in this exact conversation — closeActiveChat() (the
     mobile back button) is what actually tears down the listeners and
     nulls activeChatPeer, so if it's still set to this same peer, we're
     genuinely already open and there's nothing to do. Without this,
     re-clicking the same person in the list unsubscribed + resubscribed
     both listeners and wiped/rebuilt the whole message list from
     scratch for no reason, flashing the "جاري تحميل الرسائل..." loader
     over a chat that was already fully loaded. */
  if(activeChatPeer && activeChatPeer.id === peer.id) return;
  closePeerProfile();
  const previousPeerId = activeChatPeer ? activeChatPeer.id : null;
  if(!peer.uid){
    try{
      const s = await db.collection("users").where("id","==",peer.id).limit(1).get();
      if(!s.empty) peer.uid = s.docs[0].id;
    }catch(e){ console.error(e); }
  }
  activeChatPeer = peer;
  if(previousPeerId && previousPeerId !== peer.id) refreshChatItemDraft(previousPeerId);
  activeChatId = chatIdFor(currentUser.id, peer.id);
  peerCache[peer.id] = peer;
  watchPeer(peer);
  saveLastChat(peer.id);
  $("#messageInput").value = getDraftText(activeChatId);
  $("#messageInput").style.height = "";
  $("#messageInput").style.overflowY = "hidden";
  updateSendButtonIcon();
  if(typeof closeEmojiPanel === "function") closeEmojiPanel();

  $("#chatPlaceholder").classList.add("hidden");
  $("#chatActive").classList.remove("hidden");
  $("#app").classList.add("chat-open");
  $("#peerName").textContent = peerDisplayName(peer);
  $("#peerId").textContent = peer.id;
  $("#peerProfileTrigger").classList.toggle("peer-saved", isSavedContact(peer.id));
  $("#peerStatus").textContent = "";
  $("#peerStatus").classList.add("hidden");
  setAvatarNode($("#peerAvatar"), peerDisplayName(peer), peer.photoURL);
  setWallpaperCSS($("#messages"), localStorage.getItem(prefKey("wallpaper")) || "");

  $$(".chat-item").forEach(n=>n.classList.remove("active"));

  /* Wasla AI can't be blocked — it's not a real user, so the block
     button has no meaning here and is hidden entirely */
  $("#blockBtn").classList.toggle("hidden", peer.id === AI_PEER_ID);

  updateBlockBanner();

  /* Just OPENING a chat must never create/resurrect its Firestore doc.
     It used to always write the doc here (even for one that doesn't
     exist), which meant a chat you'd deleted would silently pop right
     back into the list the instant you (or the app auto-restoring your
     last-open chat on login) merely looked at it again — with nothing
     ever having been sent. Now we only reset MY unread count if the doc
     is already there; if it isn't (brand new conversation, or one that
     was deleted), we leave it alone. The doc only gets created for real
     the moment an actual message is sent (see the composer submit
     handler below), exactly like a real chat app. */
  chatDocExistsForActive = false;
  activeChatDocData = null;
  const chatRef = db.collection("chats").doc(activeChatId);
  const chatSnap = await chatRef.get();
  if(chatSnap.exists){
    chatDocExistsForActive = true;
    await chatRef.set({
      participants:[currentUser.id, peer.id],
      unreadCounts: { [currentUser.id]: 0 }
    }, {merge:true});
  }
  frozenChatListPreview = {
    peerId: peer.id,
    lastMessage: chatSnap.exists ? (chatSnap.data().lastMessage || "") : "",
    lastMessageSenderId: chatSnap.exists ? (chatSnap.data().lastMessageSenderId || null) : null,
    lastMessageStatus: chatSnap.exists ? (chatSnap.data().lastMessageStatus || "sent") : "sent"
  };

  clearReplyState();
  hideDeletedForMeBar();
  messagesData = {};
  pendingBubbleNodes.clear();
  exitSelectionMode();

  if(chatDocUnsub) chatDocUnsub();
  chatDocUnsub = db.collection("chats").doc(activeChatId).onSnapshot(csnap=>{
    chatDocExistsForActive = csnap.exists;
    activeChatDocData = csnap.exists ? csnap.data() : null;
    renderPinnedBanner(csnap.data());
    if(peer.id === AI_PEER_ID){
      const typing = !!(csnap.exists && csnap.data().aiTyping);
      $("#peerStatus").textContent = typing ? "بيكتب..." : "";
      $("#peerStatus").classList.toggle("hidden", !typing);
    }else{
      /* real person on the other end: their typing status is written
         to their own "typing_<theirId>" field on this same chat doc
         (see notifyTyping below) — show/hide the dots bubble to match.
         Same "it works both ways" rule as read receipts above: if I've
         turned my own read/typing status off, I don't get to see
         theirs either. Also cached in peerIsTyping so the messages
         listener below can re-add the bubble after it wipes #messages
         to redraw. */
      peerIsTyping = currentUser.readReceipts !== false && !!(csnap.exists && csnap.data()[`typing_${peer.id}`]);
      if(peerIsTyping) showPeerTypingIndicator(); else removePeerTypingIndicator();
    }
  }, err=> console.error("chat doc watch error", err));

  if(msgUnsub) msgUnsub();
  const msgsBox = $("#messages");
  msgsBox.innerHTML = `<p class="hint-text" style="text-align:center;">جاري تحميل الرسائل...</p>`;
  $("#scrollToBottomBtn").classList.remove("hidden", "stbb-show");
  /* every snapshot rebuilds ALL bubbles from scratch (see below), so
     without this, any unrelated change anywhere in the chat (someone
     else's message arriving, a read-receipt tick updating, etc.) would
     make every single reaction badge in the whole conversation replay
     its pop-in animation together. This remembers what each message's
     reactions looked like last time, so only the one that actually
     changed gets to animate on the next redraw. */
  let reactionsRenderCache = {};
  msgUnsub = db.collection("chats").doc(activeChatId).collection("messages")
    .orderBy("ts","asc")
    .onSnapshot(snap=>{
      /* "smart scroll": remember how far from the bottom the person was
         BEFORE we wipe+rebuild the list below, so someone who's scrolled
         up reading old messages doesn't get yanked back down every time
         a status tick or a new message comes in — only auto-follow the
         bottom if they were already basically there. */
      const distanceFromBottomBefore = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight;
      const wasNearBottom = msgsBox.children.length === 0 || distanceFromBottomBefore < 120;
      msgsBox.innerHTML = "";
      messagesData = {};
      let lastDay = "";
      snap.forEach(doc=>{
        const m = doc.data();
        /* messages "deleted for me" stay in Firestore for the other side,
           but must never render on my screen again */
        if(Array.isArray(m.deletedFor) && m.deletedFor.includes(currentUser.id)) return;
        messagesData[doc.id] = m;
        const d = m.ts ? (m.ts.toDate ? m.ts.toDate() : new Date(m.ts)) : new Date();
        const dayStr = d.toLocaleDateString("ar-EG", {day:"numeric", month:"long"});
        if(dayStr !== lastDay){
          const sep = document.createElement("div");
          sep.className = "day-sep"; sep.textContent = dayStr;
          msgsBox.appendChild(sep);
          lastDay = dayStr;
        }
        const isOut = m.senderId === currentUser.id;
        const bubble = document.createElement("div");
        bubble.className = "msg " + (isOut ? "out" : "in") + (m.deletedForEveryone ? " deleted" : "") + (selectedMsgIds.has(doc.id) || contextMenuMsgId === doc.id ? " selected" : "");
        bubble.dataset.id = doc.id;
        const pinBadge = currentPinnedIds.has(doc.id) ? `<span class="msg-pin-badge">${PIN_BADGE_ICON}</span>` : "";
        let inner = "";
        if(m.deletedForEveryone){
          /* "deleted for everyone" — same placeholder bubble on both
             sides, same icon, only the wording differs (I vs they) */
          inner += `<span class="msg-deleted-icon">${NO_ENTRY_ICON}</span>`;
          inner += `<span class="msg-deleted-text">${isOut ? "قمت بحذف هذه الرسالة" : "تم حذف هذه الرسالة"}</span>`;
          inner += `<span class="msg-meta">${pinBadge}<time>${fmtTime(m.ts)}</time></span>`;
        } else {
          if(m.replyTo){
            const quotedIsMine = m.replyTo.senderId === currentUser.id;
            const quotedName = quotedIsMine ? "انت" : (activeChatPeer ? peerDisplayName(activeChatPeer) : "");
            inner += `<div class="msg-reply-quote" data-goto="${m.replyTo.id}"><strong>${escapeHtml(quotedName)}</strong><span>${escapeHtml(m.replyTo.text || "")}</span></div>`;
          }
          if(m.type === "voice"){
            inner += `<div class="msg-voice" data-duration="${m.duration||0}">
              <button type="button" class="voice-play-btn" data-url="${escapeHtml(m.audioUrl||"")}">${VOICE_PLAY_ICON}</button>
              <div class="voice-track"><div class="voice-track-fill"></div></div>
              <span class="voice-time">${fmtDuration(m.duration||0)}</span>
            </div>`;
          } else {
            inner += `<span class="msg-text">${escapeHtml(m.text)}</span>`;
          }
          inner += `<span class="msg-meta">${pinBadge}<time>${fmtTime(m.ts)}</time>`;
          if(isOut){
            const status = displayStatus(m.status || "sent");
            if(status === "read"){
              inner += `<span class="msg-ticks read">${TICK_DOUBLE}</span>`;
            } else if(status === "delivered"){
              inner += `<span class="msg-ticks delivered">${TICK_DOUBLE}</span>`;
            } else {
              inner += `<span class="msg-ticks">${TICK_SINGLE}</span>`;
            }
          }
          inner += `</span>`;
        }
        bubble.innerHTML = inner;
        if(!m.deletedForEveryone){
          const reactionsSig = m.reactions ? JSON.stringify({r: m.reactions, o: m.reactionOrder || null}) : null;
          const reactionsChanged = reactionsRenderCache[doc.id] !== reactionsSig;
          reactionsRenderCache[doc.id] = reactionsSig;
          const reactionsBadge = reactionsBadgeHTML(m, doc.id, reactionsChanged);
          if(reactionsBadge){
            bubble.insertAdjacentHTML("beforeend", reactionsBadge);
            bubble.classList.add("has-reactions");
          }
        }
        msgsBox.appendChild(bubble);

        if(m.senderId === AI_PEER_ID && !m.deletedForEveryone && !hasGivenAiOpinion()){
          const fbRow = document.createElement("div");
          fbRow.className = "ai-feedback-row";
          fbRow.dataset.id = doc.id;
          fbRow.innerHTML = `
            <button type="button" class="ai-feedback-btn${m.feedback === "like" ? " active" : ""}" data-fb="like" title="عجبتني">${THUMBS_UP_ICON}</button>
            <button type="button" class="ai-feedback-btn${m.feedback === "dislike" ? " active" : ""}" data-fb="dislike" title="محتاجة تحسين">${THUMBS_DOWN_ICON}</button>`;
          msgsBox.appendChild(fbRow);
        }
      });
      /* same problem as the typing indicator below: the rebuild above
         just wiped #messages including any bubble that's still "sending"
         (typed text still writing to Firestore, or — much more likely to
         actually be caught mid-flight — a voice note still uploading to
         Storage). Put those back too, or a slow voice upload can get
         wiped by any unrelated update to this chat (a read receipt, a
         reaction, the other person's message) before it ever gets the
         chance to be replaced by its real bubble, making it look like
         the message vanished into thin air. */
      pendingBubbleNodes.forEach(node=> msgsBox.appendChild(node));
      /* the rebuild above just wiped #messages including the typing
         bubble (if it was there) — put it straight back, no animation
         needed since it was already visible a moment ago */
      if(peerIsTyping){
        const node = document.createElement("div");
        node.className = "msg in typing-indicator ti-show";
        node.id = "peerTypingIndicator";
        node.innerHTML = `<span class="ti-dot"></span><span class="ti-dot"></span><span class="ti-dot"></span>`;
        msgsBox.appendChild(node);
      }
      if(wasNearBottom){
        msgsBox.scrollTop = msgsBox.scrollHeight;
      }else{
        /* keep the person at roughly the same spot they were reading,
           instead of resetting to the top just because we rebuilt everything */
        msgsBox.scrollTop = msgsBox.scrollHeight - msgsBox.clientHeight - distanceFromBottomBefore;
      }
      updateScrollToBottomBtn();
      if(isSelectionMode()) updateSelectionUI();
      markPeerMessagesRead(snap.docs, peer.id);
      /* keep my own unread badge for this chat at 0 while I'm actively
         looking at it, in case a new message lands while it's open —
         but only touch the doc if it actually exists, otherwise this
         alone would recreate a deleted chat with nothing sent */
      if(chatDocExistsForActive){
        db.collection("chats").doc(activeChatId).set({
          unreadCounts: { [currentUser.id]: 0 }
        }, {merge:true}).catch(()=>{});
      }
    }, err=> console.error("messages error", err));
}

/* clicking a quoted "replying to" block inside a bubble jumps to the
   original message if it's still loaded on screen */
$("#messages").addEventListener("click", (e)=>{
  const quote = e.target.closest(".msg-reply-quote");
  if(quote) scrollToMessage(quote.dataset.goto);
});

/* like / dislike under a Wasla AI reply — clicking the already-active
   one clears it, clicking the other switches to it. Purely a client
   write to that message doc; nothing here calls Gemini again. */
$("#messages").addEventListener("click", async (e)=>{
  const btn = e.target.closest(".ai-feedback-btn");
  if(!btn || !activeChatId) return;
  /* while messages are selected, tapping like/dislike must do nothing —
     same idea as the selection-tap handler further below ignoring this
     button entirely, this just also blocks the reaction itself */
  if(isSelectionMode()) return;
  const row = btn.closest(".ai-feedback-row");
  const msgId = row.dataset.id;
  const type = btn.dataset.fb;
  const current = messagesData[msgId] && messagesData[msgId].feedback;
  const next = current === type ? null : type;
  row.querySelectorAll(".ai-feedback-btn").forEach(b=> b.classList.toggle("active", b.dataset.fb === next));
  try{
    await db.collection("chats").doc(activeChatId).collection("messages").doc(msgId)
      .set({ feedback: next }, {merge:true});
  }catch(err){ console.error(err); toast("تعذر تسجيل رأيك", true); }
  /* the very first time someone reacts (like or dislike) to an AI
     reply, ask them for their opinion — only once, ever, per device */
  if(next && !hasGivenAiOpinion()) openAiOpinionModal(next, msgId);
});

/* =====================================================================
   WASLA AI OPINION MODAL — asked once, the first time someone reacts to
   an AI reply. Answers are saved to a top-level "aiFeedback" collection
   (one doc per user, keyed by their id) and read back on the blank
   admin page at /#ai-feedback-table.
   ===================================================================== */
const AI_OPINION_SEEN_KEY = "wasla_ai_opinion_given";
let pendingAiReaction = null;
let pendingAiReactionMsgId = null;
function hasGivenAiOpinion(){
  try{ return localStorage.getItem(AI_OPINION_SEEN_KEY) === "1"; }catch(e){ return false; }
}
function openAiOpinionModal(reaction, msgId){
  pendingAiReaction = reaction;
  pendingAiReactionMsgId = msgId || null;
  $("#aiOpinionForm").classList.remove("hidden");
  $("#aiOpinionSuccess").classList.add("hidden");
  $("#aiOpinionInput").value = "";
  $("#aiOpinionTipsInput").value = "";
  $("#aiOpinionOverlay").classList.remove("hidden");
}
function closeAiOpinionModal(){
  $("#aiOpinionOverlay").classList.add("hidden");
}
/* "مش دلوقتي" — the thumb icons stay exactly where they are (so the
   person can still react later), only the color/active state that was
   just set gets undone, both on screen and in Firestore */
$("#skipAiOpinionBtn").addEventListener("click", async ()=>{
  const msgId = pendingAiReactionMsgId;
  if(msgId){
    if(messagesData[msgId]) messagesData[msgId].feedback = null;
    const row = $(`.ai-feedback-row[data-id="${msgId}"]`);
    if(row) row.querySelectorAll(".ai-feedback-btn").forEach(b=> b.classList.remove("active"));
    if(activeChatId){
      try{
        await db.collection("chats").doc(activeChatId).collection("messages").doc(msgId)
          .set({ feedback: null }, {merge:true});
      }catch(err){ console.error(err); }
    }
  }
  closeAiOpinionModal();
});
$("#submitAiOpinionBtn").addEventListener("click", async ()=>{
  const opinion = $("#aiOpinionInput").value.trim();
  const tips = $("#aiOpinionTipsInput").value.trim();
  try{
    await db.collection("aiFeedback").doc(currentUser.id).set({
      id: currentUser.id,
      name: currentUser.name || "",
      reaction: pendingAiReaction,
      opinion, tips,
      ts: firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
  }catch(err){ console.error(err); toast("تعذر إرسال رأيك، حاول تاني", true); return; }
  /* checkmark + never ask again, and the like/dislike row disappears
     from under every AI message from now on */
  try{ localStorage.setItem(AI_OPINION_SEEN_KEY, "1"); }catch(e){}
  $("#aiOpinionForm").classList.add("hidden");
  $("#aiOpinionSuccess").classList.remove("hidden");
  $$(".ai-feedback-row").forEach(n=> n.remove());
  setTimeout(closeAiOpinionModal, 1400);
});

/* ---- Blank admin page: table of everyone's Wasla AI opinion ---- */
async function renderAiFeedbackTable(){
  const body = $("#aiFeedbackTableBody");
  body.innerHTML = "";
  try{
    const snap = await db.collection("aiFeedback").orderBy("ts","desc").get();
    $("#aiFeedbackEmpty").classList.toggle("hidden", !snap.empty);
    snap.forEach(doc=>{
      const d = doc.data();
      const tr = document.createElement("tr");
      const reactionIcon = d.reaction === "like" ? "👍" : d.reaction === "dislike" ? "👎" : "—";
      tr.innerHTML = `
        <td class="fb-id">${escapeHtml(d.id || doc.id)}</td>
        <td class="fb-reaction">${reactionIcon}</td>
        <td>${escapeHtml(d.opinion || "—")}</td>
        <td>${escapeHtml(d.tips || "—")}</td>`;
      body.appendChild(tr);
    });
  }catch(err){
    console.error("Failed to load AI feedback table:", err);
    $("#aiFeedbackEmpty").classList.remove("hidden");
    $("#aiFeedbackEmpty").textContent = "تعذر تحميل الجدول.";
  }
}
function syncAiFeedbackPageWithHash(){
  const isFeedbackPage = location.hash === "#ai-feedback-table";
  $("#aiFeedbackPage").classList.toggle("hidden", !isFeedbackPage);
  if(isFeedbackPage) renderAiFeedbackTable();
}
window.addEventListener("hashchange", syncAiFeedbackPageWithHash);
syncAiFeedbackPageWithHash();

/* Fully closes whichever chat is open: stops its Firestore listeners
   (so nothing from it can silently mark messages "read" anymore) and
   clears its state. Used by the mobile back button — just hiding the
   chat panel with CSS wasn't enough, since the message listener kept
   running in the background and would still flip new messages to
   "read" the instant they arrived, even though the person was just
   sitting on the chat list, not actually looking at that conversation. */
function closeActiveChat(){
  if(msgUnsub){ msgUnsub(); msgUnsub = null; }
  if(chatDocUnsub){ chatDocUnsub(); chatDocUnsub = null; }
  activeChatPeer = null; activeChatId = null;
  chatDocExistsForActive = false; activeChatDocData = null;
  messagesData = {}; currentPinnedId = null; pinnedFocusIndex = 0; pinnedMessagesList = [];
  clearTimeout(pinnedExpiryTimer);
  clearReplyState();
  hideDeletedForMeBar();
  exitSelectionMode();
  $("#pinnedBanner").classList.add("hidden");
  $("#messageInput").value = "";
  updateSendButtonIcon();
  stopTypingNow();
  removePeerTypingIndicator();
  peerIsTyping = false;
  $("#scrollToBottomBtn").classList.add("hidden");
  $("#scrollToBottomBtn").classList.remove("stbb-show");
  saveLastChat("");
  $("#app").classList.remove("chat-open");
  $("#chatActive").classList.add("hidden");
  $("#chatPlaceholder").classList.remove("hidden");
  if(lastChatListSnapDocs.length) renderChatList(lastChatListSnapDocs);
}
$("#backBtn").addEventListener("click", ()=>{
  /* pressing back while messages are selected should just cancel the
     selection (same as the toolbar's cancel button) — not leave the
     whole chat. A second press, once nothing's selected, goes back to
     the chat list as normal. */
  if(isSelectionMode()){ exitSelectionMode(); return; }
  closeActiveChat();
});

/* =====================================================================
   6.1) PINNED MESSAGE BANNER — up to MAX_PINNED_MESSAGES messages at once,
   stored as chatData.pinnedMessages (array of {id,text,senderId,pinnedUntil}).
   The banner shows one at a time with small WhatsApp-style dashes; tapping
   it jumps to the one currently shown and advances to the next.
   ===================================================================== */
/* keeps the little pin badge (next to the time) in sync on message
   bubbles that are already on screen, right when a message gets
   pinned/unpinned — without needing to wait for the messages list
   itself to re-render for some unrelated reason */
function syncPinBadgesOnBubbles(){
  $$(".msg .msg-meta").forEach(meta=>{
    const bubble = meta.closest(".msg");
    if(!bubble) return;
    const id = bubble.dataset.id;
    const shouldHaveBadge = currentPinnedIds.has(id);
    const existingBadge = meta.querySelector(".msg-pin-badge");
    if(shouldHaveBadge && !existingBadge){
      meta.insertAdjacentHTML("afterbegin", `<span class="msg-pin-badge">${PIN_BADGE_ICON}</span>`);
    } else if(!shouldHaveBadge && existingBadge){
      existingBadge.remove();
    }
  });
}

function renderPinnedBanner(chatData){
  const banner = $("#pinnedBanner");
  const textEl = $("#pinnedBannerText");
  const dashesEl = $("#pinnedBannerDashes");
  clearTimeout(pinnedExpiryTimer);

  const now = Date.now();
  const raw = (chatData && Array.isArray(chatData.pinnedMessages)) ? chatData.pinnedMessages : [];
  const live = raw.filter(p => !p.pinnedUntil || p.pinnedUntil > now);

  if(activeChatId && live.length !== raw.length){
    /* one or more pins actually ran out — clear them in Firestore so they
       don't keep showing as expired to everyone who opens this chat */
    db.collection("chats").doc(activeChatId).set({ pinnedMessages: live }, {merge:true}).catch(()=>{});
  }

  pinnedMessagesList = live;
  currentPinnedIds = new Set(live.map(p => p.id));
  syncPinBadgesOnBubbles();

  if(!live.length){
    currentPinnedId = null;
    pinnedFocusIndex = 0;
    banner.classList.add("hidden");
    textEl.textContent = "";
    if(dashesEl){ dashesEl.innerHTML = ""; dashesEl.classList.add("hidden"); }
    return;
  }

  if(pinnedFocusIndex >= live.length) pinnedFocusIndex = 0;
  const current = live[pinnedFocusIndex];
  currentPinnedId = current.id;
  textEl.textContent = current.text || "";
  banner.classList.remove("hidden");

  if(dashesEl){
    dashesEl.classList.toggle("hidden", live.length < 2);
    dashesEl.innerHTML = live.map((_, i)=>
      `<span class="pin-dash${i === pinnedFocusIndex ? " active" : ""}"></span>`
    ).join("");
  }

  /* real, automatic expiry: schedule a re-render for the exact moment the
     soonest-expiring pin runs out, so it disappears on its own without
     needing a click, a message, or a refresh */
  const expiries = live.map(p => p.pinnedUntil).filter(Boolean);
  if(expiries.length){
    const wait = Math.max(1000, Math.min(...expiries) - now + 200);
    pinnedExpiryTimer = setTimeout(()=>{
      if(activeChatId) renderPinnedBanner(activeChatDocData);
    }, wait);
  }
}

function scrollToMessage(id){
  const el = document.querySelector(`.msg[data-id="${id}"]`);
  if(!el){ toast("الرسالة مش ظاهرة على الشاشة دلوقتي"); return; }
  el.scrollIntoView({behavior:"smooth", block:"center"});
  el.classList.add("pinned-flash");

  /* stays lit while the person is still looking at it — only clears
     once they scroll the messages list again or tap somewhere else,
     with a generous fallback timeout just so it never gets stuck lit
     forever if neither of those happens */
  const clear = ()=>{
    el.classList.remove("pinned-flash");
    messagesEl.removeEventListener("scroll", onInteract);
    messagesEl.removeEventListener("touchstart", onInteract);
    messagesEl.removeEventListener("click", onInteract);
    clearTimeout(fallback);
  };
  const messagesEl = $("#messages");
  let onInteract;
  /* the smooth-scroll from scrollIntoView itself fires scroll events,
     so wait a beat before listening or it'd clear itself instantly */
  setTimeout(()=>{
    onInteract = clear;
    messagesEl.addEventListener("scroll", onInteract, {passive:true});
    messagesEl.addEventListener("touchstart", onInteract, {passive:true});
    messagesEl.addEventListener("click", onInteract);
  }, 700);
  const fallback = setTimeout(clear, 8000);
}

/* "does this device actually have a mouse" — used everywhere below to
   decide between desktop-style interactions (right-click menus, double-
   click reply) and touch-style ones (long-press), instead of checking
   window width. An iPad is physically just as capable of being as wide
   as a laptop but should still act like a touch device, and a laptop
   browser window shrunk down to phone width is still a real mouse and
   should still get right-click — width alone can't tell these apart. */
const isMouseDevice = ()=> window.matchMedia("(hover: hover) and (pointer: fine)").matches;

let pinnedBannerLongPressFired = false;
$("#pinnedBanner").addEventListener("click", (e)=>{
  if(pinnedBannerLongPressFired){ pinnedBannerLongPressFired = false; return; }
  if(!pinnedMessagesList.length) return;
  /* jump to the one currently shown, then advance the banner to the next
     pin (wrapping back to the first after the last) — same pattern as
     WhatsApp's pinned-message dashes */
  scrollToMessage(pinnedMessagesList[pinnedFocusIndex].id);
  pinnedFocusIndex = (pinnedFocusIndex + 1) % pinnedMessagesList.length;
  renderPinnedBanner(activeChatDocData);
});

/* no more little "x" on the banner itself — right-click (desktop) or a
   long-press (touch) on the pinned banner opens a tiny menu with the
   single "unpin" option, same interaction pattern as a message */
async function unpinCurrentMessage(){
  if(!activeChatId || !currentPinnedId) return;
  try{
    const ref = db.collection("chats").doc(activeChatId);
    const snap = await ref.get();
    const list = (snap.exists && Array.isArray(snap.data().pinnedMessages)) ? snap.data().pinnedMessages : [];
    await ref.set({ pinnedMessages: list.filter(p => p.id !== currentPinnedId) }, {merge:true});
    toast("تم إلغاء تثبيت الرسالة");
  }catch(err){ console.error(err); toast("تعذر إلغاء التثبيت", true); }
}
function openPinnedMenu(x, y){
  if(!currentPinnedId) return;
  const menu = $("#pinnedMenu");
  menu.classList.remove("hidden");
  const { width: menuW, height: menuH } = menu.getBoundingClientRect();
  let left = x, top = y;
  if(left + menuW > window.innerWidth) left = window.innerWidth - menuW - 10;
  if(top + menuH > window.innerHeight) top = window.innerHeight - menuH - 10;
  menu.style.left = Math.max(10, left) + "px";
  menu.style.top = Math.max(10, top) + "px";
}
function closePinnedMenu(){ $("#pinnedMenu").classList.add("hidden"); }
document.addEventListener("click", (e)=>{
  if(!e.target.closest("#pinnedMenu")) closePinnedMenu();
});
document.addEventListener("scroll", closePinnedMenu, true);

$("#pinnedBanner").addEventListener("contextmenu", (e)=>{
  if(!currentPinnedId) return;
  e.preventDefault();
  /* same reasoning as the messages context menu below: gate this on
     "does this device actually have a mouse" rather than screen width,
     so a real computer still gets the right-click menu even if its
     window is narrowed down to phone size, while a touch device (which
     also fires this native contextmenu event on long-press) keeps using
     its own dedicated long-press handler below instead, regardless of
     how wide its screen is (e.g. an iPad) */
  if(!isMouseDevice()) return;
  openPinnedMenu(e.clientX, e.clientY);
});

let pinnedLongPressTimer = null;
$("#pinnedBanner").addEventListener("touchstart", (e)=>{
  if(!currentPinnedId) return;
  const t = e.touches[0];
  const x = t.clientX, y = t.clientY;
  clearTimeout(pinnedLongPressTimer);
  pinnedLongPressTimer = setTimeout(()=>{
    pinnedBannerLongPressFired = true;
    if(navigator.vibrate) navigator.vibrate(15);
    openPinnedMenu(x, y);
  }, 480);
}, {passive:true});
$("#pinnedBanner").addEventListener("touchmove", ()=> clearTimeout(pinnedLongPressTimer), {passive:true});
$("#pinnedBanner").addEventListener("touchend", ()=> clearTimeout(pinnedLongPressTimer));
$("#pinnedBanner").addEventListener("touchcancel", ()=> clearTimeout(pinnedLongPressTimer));

$("#pinnedMenu").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-action='unpin']");
  closePinnedMenu();
  if(!btn) return;
  unpinCurrentMessage();
});

async function togglePin(id, m, durationMs){
  if(!activeChatId) return;
  try{
    const ref = db.collection("chats").doc(activeChatId);
    const snap = await ref.get();
    const now = Date.now();
    let list = (snap.exists && Array.isArray(snap.data().pinnedMessages)) ? snap.data().pinnedMessages.slice() : [];
    list = list.filter(p => !p.pinnedUntil || p.pinnedUntil > now); // drop anything already expired

    const existingIndex = list.findIndex(p => p.id === id);
    if(existingIndex !== -1){
      list.splice(existingIndex, 1);
      await ref.set({ pinnedMessages: list }, {merge:true});
      toast("تم إلغاء تثبيت الرسالة");
    } else {
      if(list.length >= MAX_PINNED_MESSAGES){
        toast(`متقدرش تثبت أكتر من ${MAX_PINNED_MESSAGES} رسائل، شيل واحدة الأول`, true);
        return;
      }
      list.push({
        id,
        text: (m.text || "").slice(0,140),
        senderId: m.senderId,
        pinnedUntil: now + (durationMs || 604800000)
      });
      await ref.set({ pinnedMessages: list }, {merge:true});
      toast("تم تثبيت الرسالة");
    }
  }catch(err){ console.error(err); toast("تعذر تثبيت الرسالة", true); }
}

/* ---- pin-duration modal — opened from the selection-mode "more" menu,
   lets the person choose how long the pin should last (like WhatsApp) ---- */
function closePinDurationModal(){
  pendingPinTargetId = null;
  $("#pinDurationOverlay").classList.add("hidden");
}
$("#cancelPinDurationBtn").addEventListener("click", closePinDurationModal);
$("#pinDurationOverlay").addEventListener("click", (e)=>{
  if(e.target.id === "pinDurationOverlay") closePinDurationModal();
});
$$("#pinDurationOverlay button[data-duration]").forEach(btn=>{
  btn.addEventListener("click", async ()=>{
    const id = pendingPinTargetId;
    const durationMs = parseInt(btn.dataset.duration, 10);
    closePinDurationModal();
    if(!id) return;
    const m = messagesData[id];
    if(!m) return;
    await togglePin(id, m, durationMs);
    exitSelectionMode();
  });
});

/* =====================================================================
   6.2) REPLY-TO-MESSAGE (composer preview bar)
   ===================================================================== */
function setReplyTo(id){
  const m = messagesData[id];
  if(!m) return;
  const isOut = m.senderId === currentUser.id;
  replyingTo = { id, senderId: m.senderId, text: (m.text || "").slice(0,300) };
  $("#replyPreviewName").textContent = isOut ? "انت" : (activeChatPeer ? peerDisplayName(activeChatPeer) : "");
  $("#replyPreviewText").textContent = m.text || "";
  $("#replyPreview").classList.remove("hidden");
  $("#messageInput").focus();
}
function clearReplyState(){
  replyingTo = null;
  $("#replyPreview").classList.add("hidden");
  $("#replyPreviewName").textContent = "";
  $("#replyPreviewText").textContent = "";
}
$("#cancelReplyBtn").addEventListener("click", clearReplyState);

/* =====================================================================
   6.2b) GENERIC YES/NO CONFIRM MODAL — a centered in-app message that
   replaces the browser's native confirm() popup. Used by the chat-level
   delete actions (header's "delete messages" button, and "delete chat"
   from the chat-list menu / selection toolbar). Returns a promise that
   resolves true/false depending on which button the person taps.
   ===================================================================== */
let simpleConfirmResolve = null;
function askConfirm(title, text){
  return new Promise(resolve=>{
    simpleConfirmResolve = resolve;
    $("#simpleConfirmTitle").textContent = title;
    $("#simpleConfirmText").textContent = text;
    $("#simpleConfirmOverlay").classList.remove("hidden");
  });
}
function closeSimpleConfirm(result){
  $("#simpleConfirmOverlay").classList.add("hidden");
  if(simpleConfirmResolve){ simpleConfirmResolve(result); simpleConfirmResolve = null; }
}
$("#simpleConfirmYesBtn").addEventListener("click", ()=> closeSimpleConfirm(true));
$("#simpleConfirmNoBtn").addEventListener("click", ()=> closeSimpleConfirm(false));
$("#simpleConfirmOverlay").addEventListener("click", (e)=>{
  if(e.target.id === "simpleConfirmOverlay") closeSimpleConfirm(false);
});

/* =====================================================================
   6.3) DELETE-CHOICE MODAL (delete for me / delete for everyone)
   Accepts an array of ids so the same modal covers both a single
   right-clicked message and a multi-select bulk delete.
   ===================================================================== */
function openDeleteModal(ids, isOut){
  deleteTargetIds = ids;
  const many = ids.length > 1;
  $("#deleteModalTitle").textContent = many ? "حذف الرسائل" : "حذف الرسالة";
  $("#deleteModalText").textContent = many ? `عايز تحذف الـ ${ids.length} رسائل دي منين؟` : "عايز تحذفها منين؟";
  $("#deleteForEveryoneBtn").classList.toggle("hidden", !isOut);
  $("#deleteOverlay").classList.remove("hidden");
}
function closeDeleteModal(){
  deleteTargetIds = [];
  $("#deleteOverlay").classList.add("hidden");
  if(isSelectionMode()) exitSelectionMode();
}
$("#cancelDeleteBtn").addEventListener("click", closeDeleteModal);
$("#deleteOverlay").addEventListener("click", (e)=>{
  if(e.target.id === "deleteOverlay") closeDeleteModal();
});
$("#deleteForMeBtn").addEventListener("click", async ()=>{
  if(!deleteTargetIds.length || !activeChatId) return;
  const ids = deleteTargetIds;
  const chatId = activeChatId;
  closeDeleteModal();
  try{
    if(ids.length === 1){
      const id = ids[0];
      await db.collection("chats").doc(chatId).collection("messages").doc(id).set({
        deletedFor: firebase.firestore.FieldValue.arrayUnion(currentUser.id)
      }, {merge:true});
      showDeletedForMeBar(id, chatId);
    } else {
      const batch = db.batch();
      ids.forEach(id=>{
        const ref = db.collection("chats").doc(chatId).collection("messages").doc(id);
        batch.set(ref, { deletedFor: firebase.firestore.FieldValue.arrayUnion(currentUser.id) }, {merge:true});
      });
      await batch.commit();
      toast("اتمسحت الرسائل من عندك");
    }
  }catch(err){ console.error(err); toast("تعذر حذف الرسائل", true); }
});

/* ---- thin "message deleted for me" bar above the composer, with undo ---- */
function showDeletedForMeBar(id, chatId){
  clearTimeout(deletedForMeBarTimer);
  lastDeletedForMeId = id;
  lastDeletedForMeChatId = chatId;
  $("#deletedForMeBar").classList.remove("hidden");
  deletedForMeBarTimer = setTimeout(hideDeletedForMeBar, 4000);
}
function hideDeletedForMeBar(){
  clearTimeout(deletedForMeBarTimer);
  $("#deletedForMeBar").classList.add("hidden");
  lastDeletedForMeId = null;
  lastDeletedForMeChatId = null;
}
$("#undoDeleteForMeBtn").addEventListener("click", async ()=>{
  const id = lastDeletedForMeId, chatId = lastDeletedForMeChatId;
  hideDeletedForMeBar();
  if(!id || !chatId) return;
  try{
    await db.collection("chats").doc(chatId).collection("messages").doc(id).update({
      deletedFor: firebase.firestore.FieldValue.arrayRemove(currentUser.id)
    });
  }catch(err){ console.error(err); toast("تعذر التراجع عن الحذف", true); }
});
$("#deleteForEveryoneBtn").addEventListener("click", async ()=>{
  if(!deleteTargetIds.length || !activeChatId) return;
  const ids = deleteTargetIds;
  const chatId = activeChatId;
  closeDeleteModal();
  try{
    /* soft-delete: keep the doc, wipe its content, flag it — this is
       what lets both sides render the "you/they deleted this message"
       placeholder bubble instead of the message just vanishing */
    if(ids.length === 1){
      const id = ids[0];
      await db.collection("chats").doc(chatId).collection("messages").doc(id).set({
        deletedForEveryone: true,
        text: "",
        replyTo: firebase.firestore.FieldValue.delete(),
        deletedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, {merge:true});
    } else {
      const batch = db.batch();
      ids.forEach(id=>{
        const ref = db.collection("chats").doc(chatId).collection("messages").doc(id);
        batch.set(ref, {
          deletedForEveryone: true,
          text: "",
          replyTo: firebase.firestore.FieldValue.delete(),
          deletedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, {merge:true});
      });
      await batch.commit();
      toast("اتمسحت الرسائل من عندكم الاتنين");
    }
    const pinnedAmongThese = ids.filter(id=> currentPinnedIds.has(id));
    if(pinnedAmongThese.length){
      db.collection("chats").doc(chatId).get().then(snap=>{
        const list = (snap.exists && Array.isArray(snap.data().pinnedMessages)) ? snap.data().pinnedMessages : [];
        return db.collection("chats").doc(chatId).set({ pinnedMessages: list.filter(p=> !pinnedAmongThese.includes(p.id)) }, {merge:true});
      }).catch(()=>{});
    }
  }catch(err){ console.error(err); toast("تعذر حذف الرسائل", true); }
});

/* =====================================================================
   6.3b) MESSAGE REACTIONS — a small emoji picker that pops up above the
   press point on a long-press (phone/iPad) or fixed above the context
   menu on a right-click (desktop). One reaction per person per message,
   stored as { [userId]: emoji } on the message doc; tapping the same
   emoji you already picked removes it again.
   ===================================================================== */
const QUICK_REACTIONS = ["👍","❤️","😂","😮","😢","🙏"];
const EXTRA_REACTIONS = ["🥲","😡","🎉","🔥","👏","😍","🤔","😴","🙌","💯","🤦","🥳","😬","🤝","😱","👀","🙄","💔","😅","🤩","😭","🫶","🥸","👌"];

let reactionBarMsgId = null;

function reactionsBadgeHTML(m, id, animate){
  if(!m.reactions) return "";
  const entries = Object.entries(m.reactions);
  if(!entries.length) return "";
  const counts = {};
  entries.forEach(([, emo])=>{ counts[emo] = (counts[emo] || 0) + 1; });
  /* reactionOrder holds user ids from oldest → most-recent action (see
     setReaction); walking it backwards and keeping the first time we
     see each emoji puts whichever emoji was reacted with most recently
     — by anyone — first in the chip list. Older docs saved before this
     field existed just fall back to whatever order Object.entries gives. */
  const recencyIds = Array.isArray(m.reactionOrder) && m.reactionOrder.length
    ? m.reactionOrder
    : entries.map(([uid])=>uid);
  const order = [];
  const seen = new Set();
  for(let i = recencyIds.length - 1; i >= 0; i--){
    const emo = m.reactions[recencyIds[i]];
    if(!emo || seen.has(emo)) continue;
    seen.add(emo);
    order.push(emo);
  }
  const mine = m.reactions[currentUser.id];
  const chips = order.map(emo=> emo + (counts[emo] > 1 ? `<span class="msg-reactions-count">${counts[emo]}</span>` : "")).join("");
  return `<div class="msg-reactions${mine ? " mine" : ""}${animate ? " reaction-pop" : ""}" data-id="${id}">${chips}</div>`;
}

/* positions a floating panel so its BOTTOM sits just above (anchorX,
   anchorY) — e.g. above the exact spot a finger pressed, or above the
   context menu's top edge — flipping to appear below instead if there
   isn't enough room above, and clamped so it never runs off-screen */
function positionFloatingEl(el, anchorX, anchorY){
  const rect = el.getBoundingClientRect();
  let left = anchorX - rect.width / 2;
  let top = anchorY - rect.height - 10;
  if(left < 8) left = 8;
  if(left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  if(top < 8) top = anchorY + 10;
  /* the flip-to-below case above didn't check the bottom edge, so on a
     short/narrow browser window the panel could still spill past the
     bottom (or, after the left/right clamp ran before top was decided,
     past the right/left edge too). Re-clamp both axes against the
     actual window size so the panel always stays fully inside the
     visible browser viewport. */
  if(top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
  if(left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
}

function openReactionBar(msgId, anchorX, anchorY){
  const m = messagesData[msgId];
  if(!m || m.deletedForEveryone) return;
  reactionBarMsgId = msgId;
  closeReactionGrid();
  const bar = $("#reactionBar");
  const mine = m.reactions && m.reactions[currentUser.id];
  $$(".reaction-bar-emoji", bar).forEach(b=> b.classList.toggle("active", b.dataset.emoji === mine));
  bar.classList.remove("hidden");
  positionFloatingEl(bar, anchorX, anchorY);
}
function closeReactionGrid(){ $("#reactionGrid").classList.add("hidden"); }
function closeReactionBar(){
  $("#reactionBar").classList.add("hidden");
  closeReactionGrid();
  reactionBarMsgId = null;
  if(emojiPanelReactionMode) closeEmojiPanel();
}

async function setReaction(msgId, emoji){
  if(!activeChatId) return;
  const m = messagesData[msgId];
  if(!m || m.deletedForEveryone) return;
  const current = m.reactions && m.reactions[currentUser.id];
  const ref = db.collection("chats").doc(activeChatId).collection("messages").doc(msgId);
  /* drop any earlier occurrence of me from the order first — for the
     "add/change" case below I then get re-added at the end (= most
     recent reactor); for the "remove" case I just stay out of it.
     Computed locally so the whole reaction change is ONE write instead
     of several — several separate awaited writes each fire their own
     snapshot update, which was making the badge flicker (pop away,
     pop back) a few times before settling on its final state. */
  const restOfOrder = Array.isArray(m.reactionOrder) ? m.reactionOrder.filter(uid=> uid !== currentUser.id) : [];
  try{
    if(current === emoji){
      await ref.update({
        [`reactions.${currentUser.id}`]: firebase.firestore.FieldValue.delete(),
        reactionOrder: restOfOrder
      });
    } else {
      await ref.set({
        reactions: { [currentUser.id]: emoji },
        reactionOrder: [...restOfOrder, currentUser.id]
      }, {merge:true});
    }
  }catch(err){ console.error(err); toast("تعذر إضافة الريأكشن", true); }
}

async function applyReaction(msgId, emoji){
  await setReaction(msgId, emoji);
  closeReactionBar();
  if(contextMenuMsgId === msgId) closeMsgMenu();
  if(isSelectionMode()) exitSelectionMode();
}

$("#reactionBar").addEventListener("click", (e)=>{
  const btn = e.target.closest(".reaction-bar-emoji");
  if(!btn || !reactionBarMsgId) return;
  applyReaction(reactionBarMsgId, btn.dataset.emoji);
});

$("#reactionBarMore").addEventListener("click", (e)=>{
  e.stopPropagation();
  if(!reactionBarMsgId) return;
  closeMsgMenu();

  /* tapping "+" again while the picker it opened is still up just
     closes it back down, the same toggle feel the old small grid had */
  if(emojiPanelOpen && emojiPanelReactionMode){
    closeEmojiPanel();
    closeReactionBar();
    return;
  }

  /* same full emoji picker the composer's own emoji button uses
     (search + category tabs + all emoji), on both phone and desktop —
     on phone this also closes the keyboard and hides the composer
     input while it's up; on desktop it's the same side popover next
     to the composer, in its usual fixed spot */
  if(window.innerWidth < 768 && document.activeElement && document.activeElement !== document.body){
    document.activeElement.blur();
  }
  $("#reactionBar").classList.add("hidden");
  openEmojiPanel(true);
});

$("#reactionGrid").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-emoji]");
  if(!btn || !reactionBarMsgId) return;
  applyReaction(reactionBarMsgId, btn.dataset.emoji);
  bumpQuickReaction(btn.dataset.emoji);
});

/* tapping an existing reaction badge on a bubble re-opens the picker
   right above it, so a reaction can be changed without a fresh
   long-press/right-click */
$("#messages").addEventListener("click", (e)=>{
  if(isSelectionMode()) return;
  const badge = e.target.closest(".msg-reactions");
  if(!badge) return;
  const rect = badge.getBoundingClientRect();
  openReactionBar(badge.dataset.id, rect.left + rect.width / 2, rect.top);
});

/* capture phase, and bail on longPressFired, so the synthetic click a
   touch browser fires right after the touchend that ended a long-press
   doesn't immediately close the reaction bar that same long-press just
   opened — capture runs before the #messages bubble handler further
   below gets a chance to reset that flag back to false */
document.addEventListener("click", (e)=>{
  if(longPressFired) return;
  if(e.target.closest("#reactionBar") || e.target.closest("#reactionGrid") || e.target.closest(".msg-reactions")) return;
  if(emojiPanelReactionMode && e.target.closest("#emojiPanel")) return;
  closeReactionBar();
}, true);
document.addEventListener("scroll", closeReactionBar, true);

/* =====================================================================
   6.4) MESSAGE CONTEXT MENU — right-click on desktop, long-press on touch
   Options: reply / copy / pin-unpin / delete
   ===================================================================== */
function openMsgMenu(id, x, y){
  const m = messagesData[id];
  if(!m) return;
  closeMsgMenu(); // clear any previously right-clicked bubble's highlight first
  contextMenuMsgId = id;
  const menu = $("#msgMenu");
  const isDeleted = !!m.deletedForEveryone;
  $("#msgMenuReply").classList.toggle("hidden", isDeleted);
  $("#msgMenuCopy").classList.toggle("hidden", isDeleted);
  $("#msgMenuPin").classList.toggle("hidden", isDeleted);
  const isPinned = currentPinnedIds.has(id);
  const pinLabel = $("#msgMenuPin .lbl");
  if(pinLabel) pinLabel.textContent = isPinned ? "إلغاء التثبيت" : "تثبيت";
  menu.classList.remove("hidden");
  /* same accent-colored highlight the mobile selection mode uses, so a
     right-clicked message on desktop is clearly marked while its menu
     is open */
  const bubble = document.querySelector(`.msg[data-id="${id}"]`);
  if(bubble) bubble.classList.add("selected");
  const { width: menuW, height: menuH } = menu.getBoundingClientRect();
  let left = x, top = y;
  if(left + menuW > window.innerWidth) left = window.innerWidth - menuW - 10;
  if(top + menuH > window.innerHeight) top = window.innerHeight - menuH - 10;
  menu.style.left = Math.max(10, left) + "px";
  menu.style.top = Math.max(10, top) + "px";
}
function closeMsgMenu(){
  $("#msgMenu").classList.add("hidden");
  if(contextMenuMsgId){
    const bubble = document.querySelector(`.msg[data-id="${contextMenuMsgId}"]`);
    if(bubble) bubble.classList.remove("selected");
  }
  contextMenuMsgId = null;
}
document.addEventListener("click", (e)=>{
  if(!e.target.closest("#msgMenu")) closeMsgMenu();
});
document.addEventListener("scroll", closeMsgMenu, true);

$("#messages").addEventListener("contextmenu", (e)=>{
  const bubble = e.target.closest(".msg");
  if(!bubble) return;
  e.preventDefault();
  /* while a multi-select is already in progress, right-click shouldn't
     pop the single-message floating menu on top of the selection
     toolbar — the toolbar's delete button is the only action offered
     here, so a right-click on desktop during selection mode does
     nothing rather than opening a second, conflicting menu */
  if(isSelectionMode()) return;
  /* gate this on "does this device actually have a mouse" rather than
     screen width: a touch device (phone or iPad) already opens the
     same menu (or the phone toolbar) via our own touchstart timer
     below, and Android also fires this native "contextmenu" event on
     long-press regardless — so a touch device should never fall
     through to here. A real computer, meanwhile, should always get
     this menu on right-click no matter how narrow its window is. */
  if(!isMouseDevice()) return;
  /* belt-and-suspenders for the rare hybrid device (touchscreen
     laptop) that matches isMouseDevice() but just fired a real touch
     long-press — don't pop a second copy of the menu on top */
  if(longPressFired) return;
  openMsgMenu(bubble.dataset.id, e.clientX, e.clientY);
  /* the reaction bar stays fixed above the context menu itself on
     desktop (not above the cursor), per how the person wants it */
  const menuRect = $("#msgMenu").getBoundingClientRect();
  openReactionBar(bubble.dataset.id, menuRect.left + menuRect.width / 2, menuRect.top);
});

/* double-click reply is a desktop/mouse convenience — gated the same
   way, on real mouse presence rather than window width */
$("#messages").addEventListener("dblclick", (e)=>{
  if(!isMouseDevice()) return;
  if(isSelectionMode()) return;
  const bubble = e.target.closest(".msg");
  if(!bubble || bubble.classList.contains("deleted")) return;
  setReplyTo(bubble.dataset.id);
});

$("#msgMenu").addEventListener("click", async (e)=>{
  const btn = e.target.closest("button[data-action]");
  if(!btn || !contextMenuMsgId) return;
  const id = contextMenuMsgId;
  const action = btn.dataset.action;
  const m = messagesData[id];
  closeMsgMenu();
  closeReactionBar();
  if(!m) return;
  if(action === "reply"){
    setReplyTo(id);
  } else if(action === "copy"){
    copyText(m.text || "").then(()=> toast("تم نسخ الرسالة")).catch(()=> toast("تعذر نسخ الرسالة، انسخها يدويًا", true));
  } else if(action === "pin"){
    if(currentPinnedIds.has(id)){
      await togglePin(id, m);
    } else {
      pendingPinTargetId = id;
      $("#pinDurationOverlay").classList.remove("hidden");
    }
  } else if(action === "delete"){
    openDeleteModal([id], m.senderId === currentUser.id && !m.deletedForEveryone);
  } else if(action === "select"){
    enterSelectionMode(id);
  }
});

/* =====================================================================
   6.4b) TOUCH SELECTION MODE — WhatsApp-style. A long-press on a phone
   or tablet no longer opens the small floating menu; instead it
   highlights the bubble (tinted with the user's own chat accent color)
   and swaps the header for a toolbar with cancel / count / reply /
   delete / more. Tapping other bubbles while in this mode adds them to
   the selection too. Reply/pin/copy only make sense for exactly one
   selected message, so those stay hidden/disabled otherwise.
   ===================================================================== */
/* a dedicated flag rather than deriving "am I selecting?" from
   selectedMsgIds.size — deselecting a bubble down to zero (tapping the
   only selected message again) should keep the toolbar open with an
   empty selection, not read as "selection mode never started" */
let selectionModeActive = false;
function isSelectionMode(){ return selectionModeActive; }

/* the actual phone/browser back button (or a swipe-back gesture) isn't
   an element we can attach a click listener to — it fires history
   navigation instead. So while a selection is active we push one
   history entry for it; back() then just pops straight back to here
   (no real navigation happened, so nothing else moves) and popstate
   below reads that as "cancel the selection", exactly like the
   toolbar's own cancel button. selectionHistoryPushed makes sure we
   only ever push one entry per selection session (not one per tapped
   message), and exitingViaPopstate stops exitSelectionMode from
   calling history.back() a second time when it was the back button
   that got us here in the first place. */
let selectionHistoryPushed = false, exitingViaPopstate = false;

function pushSelectionHistoryIfNeeded(){
  if(selectionHistoryPushed) return;
  history.pushState({waslaSelection:true}, "");
  selectionHistoryPushed = true;
}

window.addEventListener("popstate", ()=>{
  if(!isSelectionMode()) return;
  exitingViaPopstate = true;
  exitSelectionMode();
  exitingViaPopstate = false;
});

function updateSelectionUI(){
  $$(".msg").forEach(el=> el.classList.toggle("selected", selectedMsgIds.has(el.dataset.id)));
  $("#selectionCount").textContent = String(selectedMsgIds.size);
  $(".chat-header").classList.add("hidden");
  $("#selectionToolbar").classList.remove("hidden");
  /* Reply/More only make sense on a touch device (phone or iPad) with
     exactly one, non-deleted message selected. Gated on real mouse
     presence rather than screen width — an iPad is often just as wide
     as a desktop window, so a width check was wrongly treating it as
     desktop and leaving it with a delete-only toolbar. On an actual
     desktop/mouse device, selection mode stays delete-only, full stop —
     no reply/more, regardless of how many (or which) messages are
     picked. A deleted placeholder in the mix also forces delete-only on
     any device, since you can't reply/copy/pin something that's gone. */
  const isDesktop = isMouseDevice();
  const hasDeleted = [...selectedMsgIds].some(id=> messagesData[id] && messagesData[id].deletedForEveryone);
  const single = selectedMsgIds.size === 1 && !hasDeleted && !isDesktop;
  $("#selectionReplyBtn").classList.toggle("hidden", !single);
  $("#selectionMoreBtn").classList.toggle("hidden", !single);
}

function enterSelectionMode(id){
  selectionModeActive = true;
  selectedMsgIds.clear();
  selectedMsgIds.add(id);
  updateSelectionUI();
  pushSelectionHistoryIfNeeded();
}

function toggleMsgSelection(id){
  if(selectedMsgIds.has(id)) selectedMsgIds.delete(id);
  else selectedMsgIds.add(id);
  updateSelectionUI();
  pushSelectionHistoryIfNeeded();
  /* a plain tap changing the selection makes any open reaction bar
     stale (it was for whichever message the last long-press opened it
     on) — the long-press timer below reopens it fresh when relevant */
  closeReactionBar();
}

function exitSelectionMode(){
  const wasSelecting = isSelectionMode();
  selectionModeActive = false;
  selectedMsgIds.clear();
  /* always clear any lingering highlight, even if selectedMsgIds was
     already empty by the time this runs (e.g. toggling off the last
     selected message empties the set before calling this) — otherwise
     that bubble's accent-color tint stayed stuck on screen forever */
  $$(".msg.selected").forEach(el=> el.classList.remove("selected"));
  $(".chat-header").classList.remove("hidden");
  $("#selectionToolbar").classList.add("hidden");
  closeSelectionMoreMenu();
  closeReactionBar();
  if(wasSelecting && selectionHistoryPushed){
    selectionHistoryPushed = false;
    if(!exitingViaPopstate) history.back();
  }
}

$("#selectionCancelBtn").addEventListener("click", exitSelectionMode);

$("#selectionReplyBtn").addEventListener("click", ()=>{
  if(selectedMsgIds.size !== 1) return;
  const id = [...selectedMsgIds][0];
  setReplyTo(id);
  exitSelectionMode();
});

$("#selectionDeleteBtn").addEventListener("click", async ()=>{
  const ids = [...selectedMsgIds];
  if(ids.length === 0) return;
  if(ids.length === 1){
    const id = ids[0];
    const m = messagesData[id];
    if(!m) return;
    /* opens the existing delete-for-me/delete-for-everyone modal;
       closeDeleteModal() (below) exits selection mode once it's done */
    openDeleteModal([id], m.senderId === currentUser.id && !m.deletedForEveryone);
    return;
  }

  /* bulk delete: whether "delete for everyone" is even offered depends
     on who sent what's selected —
     - every selected message is mine → offer the normal choice
       (delete for me / delete for both), same modal as a single message
     - the selection includes anything from the other person → there's
       no "for everyone" option at all here (can't delete their message
       for them), so this just deletes for me directly, no modal */
  const allMine = ids.every(id=>{
    const m = messagesData[id];
    return m && m.senderId === currentUser.id && !m.deletedForEveryone;
  });

  if(allMine){
    openDeleteModal(ids, true);
    return;
  }

  /* mixed selection (includes at least one of their messages, or a
     deleted placeholder) — only "delete for me" is even possible, so
     reuse the same modal instead of a native confirm() popup; passing
     isOut=false hides the "delete for everyone" button and leaves just
     the one option, matching the single-message delete-for-me flow */
  openDeleteModal(ids, false);
});

function openSelectionMoreMenu(){
  if(selectedMsgIds.size !== 1) return;
  const id = [...selectedMsgIds][0];
  const m = messagesData[id];
  if(!m) return;
  const menu = $("#selectionMoreMenu");
  const isPinned = currentPinnedIds.has(id);
  const pinLabel = $("#selectionMorePin .lbl");
  if(pinLabel) pinLabel.textContent = isPinned ? "إلغاء التثبيت" : "تثبيت";
  menu.classList.remove("hidden");
  const btn = $("#selectionMoreBtn");
  const rect = btn.getBoundingClientRect();
  const { width: menuW, height: menuH } = menu.getBoundingClientRect();
  let left = rect.right - menuW;
  let top = rect.bottom + 6;
  if(left < 10) left = 10;
  if(left + menuW > window.innerWidth) left = window.innerWidth - menuW - 10;
  if(top + menuH > window.innerHeight) top = rect.top - menuH - 6;
  if(top < 10) top = 10;
  menu.style.left = Math.max(10, left) + "px";
  menu.style.top = Math.max(10, top) + "px";
}
function closeSelectionMoreMenu(){
  $("#selectionMoreMenu").classList.add("hidden");
}
document.addEventListener("click", (e)=>{
  if(!e.target.closest("#selectionMoreMenu") && !e.target.closest("#selectionMoreBtn")) closeSelectionMoreMenu();
});
document.addEventListener("scroll", closeSelectionMoreMenu, true);

$("#selectionMoreBtn").addEventListener("click", (e)=>{
  e.stopPropagation();
  openSelectionMoreMenu();
});

$("#selectionMoreMenu").addEventListener("click", async (e)=>{
  const btn = e.target.closest("button[data-action]");
  if(!btn || selectedMsgIds.size !== 1) { closeSelectionMoreMenu(); return; }
  const id = [...selectedMsgIds][0];
  const m = messagesData[id];
  const action = btn.dataset.action;
  closeSelectionMoreMenu();
  if(!m) return;
  if(action === "copy"){
    copyText(m.text || "").then(()=> toast("تم نسخ الرسالة")).catch(()=> toast("تعذر نسخ الرسالة، انسخها يدويًا", true));
    exitSelectionMode();
  } else if(action === "pin"){
    if(currentPinnedIds.has(id)){
      await togglePin(id, m);
      exitSelectionMode();
    } else {
      /* ask how long the pin should last, like WhatsApp */
      pendingPinTargetId = id;
      $("#pinDurationOverlay").classList.remove("hidden");
    }
  }
});

/* Selection-mode tap rules, per how the person wants this to feel:
   - tapping a message that's NOT yet selected adds it to the selection
   - tapping a message that IS already selected does nothing at all —
     it stays selected, exactly as if nothing happened
   - tapping anywhere that isn't a message (empty space in the messages
     panel) exits selection mode entirely
   On desktop, Ctrl/Cmd+click also works to START selection mode (or
   add to it) without needing the right-click menu's "select" option */
$("#messages").addEventListener("click", (e)=>{
  if(e.target.closest(".ai-feedback-btn")) return;
  if(longPressFired){
    /* this click is the synthetic one mobile browsers fire right after
       the touchend that ended the long-press — the long-press already
       did its job (selecting/toggling the message), so this extra
       click must be swallowed, otherwise it immediately toggles the
       same message back off and the toolbar flashes and disappears */
    longPressFired = false;
    return;
  }
  const bubble = e.target.closest(".msg");

  if(isSelectionMode()){
    if(!bubble){
      /* on desktop, bubbles are narrow (~52% width) with a lot of open
         space beside them — treating every stray click out there as
         "exit selection mode" made it very easy to accidentally wipe
         an in-progress multi-select while reaching for a message
         further down. Only touch gets that convenience; on desktop,
         the toolbar's cancel button is the deliberate way out. */
      if(!isMouseDevice()) exitSelectionMode();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    /* deleted placeholders can be selected too (delete-for-me still
       applies to them) — so no "deleted" exclusion here anymore.
       Tapping/clicking any selected bubble again deselects it, on
       both desktop and phone — only the long-press gesture (below)
       is add-only, since that's what starts/grows a selection. */
    toggleMsgSelection(bubble.dataset.id);
    return;
  }

  if(!bubble) return;
  if((e.ctrlKey || e.metaKey) && isMouseDevice()){
    e.preventDefault();
    e.stopPropagation();
    enterSelectionMode(bubble.dataset.id);
  }
}, true);

/* ---- mobile: long-press opens the same context menu, swipe-right replies ---- */
let longPressTimer = null, longPressFired = false;
let touchBubbleEl = null, touchTargetId = null, touchStartX = 0, touchStartY = 0, swipeIcon = null;
const LONG_PRESS_MS = 480, SWIPE_TRIGGER = 60, SWIPE_MAX = 80;

$("#messages").addEventListener("touchstart", (e)=>{
  const bubble = e.target.closest(".msg");
  if(!bubble) return;
  touchBubbleEl = bubble;
  touchTargetId = bubble.dataset.id;
  const t = e.touches[0];
  touchStartX = t.clientX; touchStartY = t.clientY;
  longPressFired = false;
  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(()=>{
    longPressFired = true;
    if(navigator.vibrate) navigator.vibrate(15);
    if(isSelectionMode()){
      if(!selectedMsgIds.has(touchTargetId)) toggleMsgSelection(touchTargetId);
    } else {
      /* any real touch device — phone or iPad — long-press starts the
         same toolbar-based multi-select, regardless of screen width */
      enterSelectionMode(touchTargetId);
    }
    /* the reaction bar shows above the exact spot pressed, not
       necessarily above the whole bubble — on a tall message it stays
       pinned over the finger's position rather than the message's top */
    openReactionBar(touchTargetId, touchStartX, touchStartY);
  }, LONG_PRESS_MS);
}, {passive:true});

$("#messages").addEventListener("touchmove", (e)=>{
  if(!touchBubbleEl || touchBubbleEl.classList.contains("deleted") || isSelectionMode()) return;
  const t = e.touches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  /* a still finger naturally drifts a few px during a ~half-second
     hold — only treat this as "the person actually moved, this isn't
     a long-press anymore" past a more forgiving threshold, otherwise
     that tiny drift was cancelling the long-press timer AND kicking
     off the swipe-reply icon below, which then never reached
     SWIPE_TRIGGER and got reset on release — visually just a quick
     flash for nothing */
  if(Math.abs(dx) > 18 || Math.abs(dy) > 18) clearTimeout(longPressTimer);
  if(dx > 18 && Math.abs(dy) < 40){
    const clamped = Math.min(dx, SWIPE_MAX);
    touchBubbleEl.style.transform = `translateX(${clamped}px)`;
    if(!swipeIcon){
      swipeIcon = document.createElement("div");
      swipeIcon.className = "swipe-reply-icon";
      swipeIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>`;
      document.body.appendChild(swipeIcon);
    }
    const rect = touchBubbleEl.getBoundingClientRect();
    swipeIcon.style.left = (rect.left - 36) + "px";
    swipeIcon.style.top = (rect.top + rect.height/2 - 15) + "px";
    swipeIcon.style.opacity = Math.min(clamped / SWIPE_TRIGGER, 1);
  }
}, {passive:true});

$("#messages").addEventListener("touchend", ()=>{
  clearTimeout(longPressTimer);
  if(touchBubbleEl){
    const style = touchBubbleEl.style.transform;
    const match = /translateX\(([\-0-9.]+)px\)/.exec(style || "");
    const dx = match ? parseFloat(match[1]) : 0;
    touchBubbleEl.style.transform = "";
    if(!longPressFired && dx >= SWIPE_TRIGGER) setReplyTo(touchTargetId);
  }
  if(swipeIcon){ swipeIcon.remove(); swipeIcon = null; }
  touchBubbleEl = null; touchTargetId = null;
});
$("#messages").addEventListener("touchcancel", ()=>{
  clearTimeout(longPressTimer);
  if(touchBubbleEl) touchBubbleEl.style.transform = "";
  if(swipeIcon){ swipeIcon.remove(); swipeIcon = null; }
  touchBubbleEl = null; touchTargetId = null;
});

/* ---- mouse-held-down long-press, only for the rare device that has
   no real mouse (isMouseDevice() false) but also isn't emitting real
   touch events for some reason — e.g. DevTools' device toolbar in some
   configurations. A real computer must NEVER fall into this path: it
   already gets right-click above, and that has to keep working no
   matter how narrow the window is, so this no longer checks width at
   all. Reuses the same longPressFired flag as the touch path above, so
   the click handler still correctly swallows the follow-up click once
   this fires. A real touchscreen already handles everything through
   the touch* events above; this skips itself entirely whenever a touch
   sequence is active, so the two paths can't double-fire on an actual
   touch device. */
let mouseLongPressTimer = null, mouseDownId = null, touchSequenceActive = false;
$("#messages").addEventListener("touchstart", ()=>{ touchSequenceActive = true; }, {passive:true, capture:true});
$("#messages").addEventListener("touchend", ()=>{ touchSequenceActive = false; }, {capture:true});
$("#messages").addEventListener("touchcancel", ()=>{ touchSequenceActive = false; }, {capture:true});

$("#messages").addEventListener("mousedown", (e)=>{
  if(touchSequenceActive || isMouseDevice() || e.button !== 0) return;
  const bubble = e.target.closest(".msg");
  if(!bubble) return;
  mouseDownId = bubble.dataset.id;
  longPressFired = false;
  clearTimeout(mouseLongPressTimer);
  mouseLongPressTimer = setTimeout(()=>{
    longPressFired = true;
    if(isSelectionMode()){
      if(!selectedMsgIds.has(mouseDownId)) toggleMsgSelection(mouseDownId);
    }
    else enterSelectionMode(mouseDownId);
    openReactionBar(mouseDownId, e.clientX, e.clientY);
  }, LONG_PRESS_MS);
});
document.addEventListener("mouseup", ()=> clearTimeout(mouseLongPressTimer));
$("#messages").addEventListener("mouseleave", ()=> clearTimeout(mouseLongPressTimer), true);

/* =====================================================================
   6.4c) CHAT-LIST SELECTION — right-click on desktop targets a single
   chat with a small floating menu (delete chat / block person); a
   long-press on phone instead opens a top toolbar (no dropdown) that
   supports selecting more than one chat, with the same two actions.
   ===================================================================== */
function isChatListSelectionMode(){ return chatListSelectionActive; }

function openChatListMenu(peerId, x, y){
  closeChatListMenu();
  contextMenuChatPeerId = peerId;
  const menu = $("#chatListMenu");
  $("#chatListMenuBlock").classList.toggle("hidden", peerId === AI_PEER_ID);
  const item = document.querySelector(`.chat-item[data-peer-id="${peerId}"]`);
  if(item) item.classList.add("selected");
  menu.classList.remove("hidden");
  const { width: menuW, height: menuH } = menu.getBoundingClientRect();
  let left = x, top = y;
  if(left + menuW > window.innerWidth) left = window.innerWidth - menuW - 10;
  if(top + menuH > window.innerHeight) top = window.innerHeight - menuH - 10;
  menu.style.left = Math.max(10, left) + "px";
  menu.style.top = Math.max(10, top) + "px";
}
function closeChatListMenu(){
  $("#chatListMenu").classList.add("hidden");
  if(contextMenuChatPeerId){
    const item = document.querySelector(`.chat-item[data-peer-id="${contextMenuChatPeerId}"]`);
    if(item && !chatListSelectedIds.has(contextMenuChatPeerId)) item.classList.remove("selected");
  }
  contextMenuChatPeerId = null;
}
document.addEventListener("click", (e)=>{
  if(!e.target.closest("#chatListMenu")) closeChatListMenu();
});
document.addEventListener("scroll", closeChatListMenu, true);

$("#chatList").addEventListener("contextmenu", (e)=>{
  const item = e.target.closest(".chat-item");
  if(!item) return;
  e.preventDefault();
  if(isChatListSelectionMode()) return; // phone toolbar already covers this
  if(!isMouseDevice()) return;   // touch devices (phone or iPad) get long-press instead
  openChatListMenu(item.dataset.peerId, e.clientX, e.clientY);
});

$("#chatListMenu").addEventListener("click", async (e)=>{
  const btn = e.target.closest("button[data-action]");
  if(!btn || !contextMenuChatPeerId) return;
  const peerId = contextMenuChatPeerId;
  const action = btn.dataset.action;
  closeChatListMenu();
  if(action === "delete"){
    const ok1 = await askConfirm("حذف الشات", "هل تريد حذف الشات؟");
    if(!ok1) return;
    const ok = await deleteChatForPeer(peerId);
    if(ok) toast("اتمسح الشات");
  } else if(action === "block"){
    if(peerId === AI_PEER_ID) return;
    await blockId(peerId);
    toast("تم حظر المستخدم");
  }
});

function updateChatListSelectionUI(){
  $$(".chat-item").forEach(el=> el.classList.toggle("selected", chatListSelectedIds.has(el.dataset.peerId)));
  $("#chatListSelectionCount").textContent = String(chatListSelectedIds.size);
  $(".sidebar-header").classList.toggle("hidden", chatListSelectedIds.size > 0);
  $("#chatListSelectionToolbar").classList.toggle("hidden", chatListSelectedIds.size === 0);
  /* blocking only makes sense targeting exactly one real person */
  const ids = [...chatListSelectedIds];
  const singleId = ids.length === 1 ? ids[0] : null;
  $("#chatListSelectionBlockBtn").classList.toggle("hidden", !singleId || singleId === AI_PEER_ID);
}
function enterChatListSelection(peerId){
  chatListSelectionActive = true;
  chatListSelectedIds.clear();
  chatListSelectedIds.add(peerId);
  updateChatListSelectionUI();
}
function toggleChatListSelection(peerId){
  if(chatListSelectedIds.has(peerId)) chatListSelectedIds.delete(peerId);
  else chatListSelectedIds.add(peerId);
  if(chatListSelectedIds.size === 0){ exitChatListSelection(); return; }
  updateChatListSelectionUI();
}
function exitChatListSelection(){
  chatListSelectionActive = false;
  chatListSelectedIds.clear();
  $$(".chat-item.selected").forEach(el=> el.classList.remove("selected"));
  $(".sidebar-header").classList.remove("hidden");
  $("#chatListSelectionToolbar").classList.add("hidden");
}
$("#chatListSelectionCancelBtn").addEventListener("click", exitChatListSelection);

$("#chatListSelectionBlockBtn").addEventListener("click", async ()=>{
  const ids = [...chatListSelectedIds];
  if(ids.length !== 1 || ids[0] === AI_PEER_ID) return;
  await blockId(ids[0]);
  toast("تم حظر المستخدم");
  exitChatListSelection();
});

$("#chatListSelectionDeleteBtn").addEventListener("click", async ()=>{
  const ids = [...chatListSelectedIds];
  if(!ids.length) return;
  const ok1 = await askConfirm("حذف الشات", "هل تريد حذف الشات؟");
  if(!ok1) return;
  for(const peerId of ids) await deleteChatForPeer(peerId);
  exitChatListSelection();
});

/* long-press on a phone: same 480ms hold used for messages, just
   targeting chat-list rows and with no swipe gesture to worry about */
let chatLongPressTimer = null, chatTouchTargetId = null, chatTouchSequenceActive = false;
$("#chatList").addEventListener("touchstart", (e)=>{
  const item = e.target.closest(".chat-item");
  chatTouchSequenceActive = true;
  if(!item) return;
  chatTouchTargetId = item.dataset.peerId;
  chatLongPressFired = false;
  clearTimeout(chatLongPressTimer);
  chatLongPressTimer = setTimeout(()=>{
    chatLongPressFired = true;
    if(navigator.vibrate) navigator.vibrate(15);
    if(isChatListSelectionMode()) toggleChatListSelection(chatTouchTargetId);
    else enterChatListSelection(chatTouchTargetId);
  }, LONG_PRESS_MS);
}, {passive:true, capture:true});
$("#chatList").addEventListener("touchmove", ()=> clearTimeout(chatLongPressTimer), {passive:true});
$("#chatList").addEventListener("touchend", ()=>{ clearTimeout(chatLongPressTimer); chatTouchSequenceActive = false; });
$("#chatList").addEventListener("touchcancel", ()=>{ clearTimeout(chatLongPressTimer); chatTouchSequenceActive = false; });

/* mouse-held-down fallback, same reasoning as the messages panel: only
   for a device with no real mouse — a real computer must always keep
   its right-click menu instead, no matter how narrow the window is */
let chatMouseLongPressTimer = null, chatMouseDownId = null;
$("#chatList").addEventListener("mousedown", (e)=>{
  if(chatTouchSequenceActive || isMouseDevice() || e.button !== 0) return;
  const item = e.target.closest(".chat-item");
  if(!item) return;
  chatMouseDownId = item.dataset.peerId;
  chatLongPressFired = false;
  clearTimeout(chatMouseLongPressTimer);
  chatMouseLongPressTimer = setTimeout(()=>{
    chatLongPressFired = true;
    if(isChatListSelectionMode()) toggleChatListSelection(chatMouseDownId);
    else enterChatListSelection(chatMouseDownId);
  }, LONG_PRESS_MS);
});
document.addEventListener("mouseup", ()=> clearTimeout(chatMouseLongPressTimer));
$("#chatList").addEventListener("mouseleave", ()=> clearTimeout(chatMouseLongPressTimer), true);

/* =====================================================================
   6.5) DELETE WHOLE CHAT — "delete for me" only. This never touches the
   other person's copy: it stamps my id onto the chat doc's deletedFor
   (so the conversation disappears from MY list) and onto every existing
   message's deletedFor (so even if I reopen it directly, none of the
   old history shows up for me again) — reusing the exact same
   deletedFor mechanism the single-message "delete for me" feature
   already uses. The other person keeps the chat and every message
   exactly as they were; nothing is actually deleted from Firestore.
   The saved contact itself (currentUser.savedContacts) is completely
   untouched by this either way — deleting a chat never deletes the
   person, which is also why the button's icon is a plain circle-minus
   rather than a trash can. ===================================================================== */
async function deleteChatForPeer(peerId, opts={}){
  const keepOpen = !!opts.keepOpen;
  const chatId = chatIdFor(currentUser.id, peerId);
  try{
    const msgsSnap = await db.collection("chats").doc(chatId).collection("messages").get();
    const docsToTag = msgsSnap.docs;
    /* batches are capped at 500 writes, so chunk just in case a
       conversation has a huge history */
    for(let i=0; i<docsToTag.length; i+=450){
      const chunk = docsToTag.slice(i, i+450);
      const batch = db.batch();
      chunk.forEach(d=> batch.update(d.ref, {
        deletedFor: firebase.firestore.FieldValue.arrayUnion(currentUser.id)
      }));
      await batch.commit();
    }
    if(!keepOpen){
      await db.collection("chats").doc(chatId).set({
        deletedFor: firebase.firestore.FieldValue.arrayUnion(currentUser.id)
      }, {merge:true});

      if(Array.isArray(currentUser.pinnedChats) && currentUser.pinnedChats.includes(peerId)){
        const next = currentUser.pinnedChats.filter(id=> id!==peerId);
        currentUser.pinnedChats = next;
        db.collection("users").doc(currentUser.uid).update({ pinnedChats: next }).catch(()=>{});
      }
    }

    /* if the chat being deleted is the one currently open... */
    if(activeChatPeer && activeChatPeer.id === peerId){
      if(keepOpen){
        /* stay right where we are, as if starting a fresh conversation
           with this person — the messages listener is still running and
           will simply stop rendering anything now that every message is
           tagged deletedFor me, so the thread just goes empty in place */
        currentPinnedId = null; pinnedFocusIndex = 0; pinnedMessagesList = [];
        clearTimeout(pinnedExpiryTimer);
        clearReplyState();
        $("#pinnedBanner").classList.add("hidden");
      } else {
        /* close it out entirely, exactly like the header's delete
           button always has */
        if(msgUnsub){ msgUnsub(); msgUnsub = null; }
        if(chatDocUnsub){ chatDocUnsub(); chatDocUnsub = null; }
        activeChatPeer = null; activeChatId = null;
        messagesData = {}; currentPinnedId = null; pinnedFocusIndex = 0; pinnedMessagesList = [];
        clearTimeout(pinnedExpiryTimer);
        clearReplyState();
        $("#pinnedBanner").classList.add("hidden");
        saveLastChat("");
        $("#app").classList.remove("chat-open");
        $("#chatActive").classList.add("hidden");
        $("#chatPlaceholder").classList.remove("hidden");
      }
    }
    return true;
  }catch(err){ console.error(err); toast("تعذر حذف المحادثة", true); return false; }
}
$("#deleteChatBtn").addEventListener("click", async ()=>{
  if(!activeChatPeer || !activeChatId) return;
  const ok1 = await askConfirm("حذف الرسائل", "هل تريد حذف الرسائل كلها؟");
  if(!ok1) return;
  const peerId = activeChatPeer.id;
  const ok = await deleteChatForPeer(peerId, { keepOpen:true });
  if(ok) toast("اتمسحت الرسائل");
});

/* Adds a temporary "sending" bubble immediately, so the message feels
   instant instead of waiting on the round-trip to the server. It gets
   wiped away and replaced by the real bubble the moment the messages
   listener receives the confirmed message (which Firestore normally
   delivers from the local write queue almost instantly). */
function appendPendingMessageBubble(tempId, text, replySnapshot){
  const msgsBox = $("#messages");
  const bubble = document.createElement("div");
  bubble.className = "msg out pending";
  bubble.dataset.id = tempId;
  let inner = "";
  if(replySnapshot){
    inner += `<div class="msg-reply-quote"><strong>انت</strong><span>${escapeHtml(replySnapshot.text || "")}</span></div>`;
  }
  inner += `<span class="msg-text">${escapeHtml(text)}</span>`;
  inner += `<span class="msg-meta"><time>${fmtTime(new Date())}</time><span class="msg-ticks">${TICK_SINGLE}</span></span>`;
  bubble.innerHTML = inner;
  msgsBox.appendChild(bubble);
  pendingBubbleNodes.set(tempId, bubble);
  msgsBox.scrollTop = msgsBox.scrollHeight;
}
function removePendingMessageBubble(tempId){
  pendingBubbleNodes.delete(tempId);
  const node = $(`.msg[data-id="${tempId}"]`, $("#messages"));
  if(node) node.remove();
}
/* Call once the real Firestore doc for a pending send has been written
   successfully — stops the bubble from being resurrected after the next
   rebuild (the real message will render in its place instead). Unlike
   removePendingMessageBubble this does NOT touch the DOM: the temp node
   stays on screen exactly as-is until the listener's next rebuild swaps
   it for the real bubble, so there's no flicker. */
function resolvePendingMessageBubble(tempId){
  pendingBubbleNodes.delete(tempId);
}

/* Same idea as appendPendingMessageBubble but for a voice note still
   uploading — shows a disabled player at the final duration right away,
   then gets swapped for the real bubble once the messages listener
   picks up the confirmed Firestore doc (or removed on upload failure). */
function appendPendingVoiceBubble(tempId, durationSec){
  const msgsBox = $("#messages");
  const bubble = document.createElement("div");
  bubble.className = "msg out pending";
  bubble.dataset.id = tempId;
  bubble.innerHTML = `
    <div class="msg-voice" data-duration="${durationSec}">
      <button type="button" class="voice-play-btn" disabled>${VOICE_PLAY_ICON}</button>
      <div class="voice-track"><div class="voice-track-fill"></div></div>
      <span class="voice-time">${fmtDuration(durationSec)}</span>
    </div>
    <span class="msg-meta"><time>${fmtTime(new Date())}</time><span class="msg-ticks">${TICK_SINGLE}</span></span>`;
  msgsBox.appendChild(bubble);
  pendingBubbleNodes.set(tempId, bubble);
  msgsBox.scrollTop = msgsBox.scrollHeight;
}

/* =====================================================================
   Voice-note PLAYBACK — one shared <audio> at a time so starting a new
   voice message pauses whichever one was already playing, like WhatsApp.
   ===================================================================== */
let activeVoiceAudio = null, activeVoiceBtn = null;
function toggleVoicePlayback(btn){
  const url = btn.dataset.url;
  if(!url) return;
  const wrap = btn.closest(".msg-voice");
  const fill = wrap.querySelector(".voice-track-fill");
  const timeEl = wrap.querySelector(".voice-time");
  const totalLabel = fmtDuration(+wrap.dataset.duration || 0);

  if(activeVoiceAudio && activeVoiceBtn === btn){
    if(activeVoiceAudio.paused){ activeVoiceAudio.play(); btn.classList.add("playing"); btn.innerHTML = VOICE_PAUSE_ICON; }
    else { activeVoiceAudio.pause(); btn.classList.remove("playing"); btn.innerHTML = VOICE_PLAY_ICON; }
    return;
  }
  if(activeVoiceAudio){
    activeVoiceAudio.pause();
    if(activeVoiceBtn){ activeVoiceBtn.classList.remove("playing"); activeVoiceBtn.innerHTML = VOICE_PLAY_ICON; }
    const prevWrap = activeVoiceBtn ? activeVoiceBtn.closest(".msg-voice") : null;
    if(prevWrap){
      prevWrap.querySelector(".voice-track-fill").style.width = "0%";
      prevWrap.querySelector(".voice-time").textContent = fmtDuration(+prevWrap.dataset.duration || 0);
    }
  }

  const audio = new Audio(url);
  activeVoiceAudio = audio; activeVoiceBtn = btn;
  btn.classList.add("playing"); btn.innerHTML = VOICE_PAUSE_ICON;
  audio.addEventListener("timeupdate", ()=>{
    if(audio.duration) fill.style.width = (audio.currentTime / audio.duration * 100) + "%";
    timeEl.textContent = fmtDuration(audio.currentTime);
  });
  audio.addEventListener("ended", ()=>{
    btn.classList.remove("playing"); btn.innerHTML = VOICE_PLAY_ICON;
    fill.style.width = "0%";
    timeEl.textContent = totalLabel;
    activeVoiceAudio = null; activeVoiceBtn = null;
  });
  audio.play().catch(err=>{
    console.error(err);
    toast("تعذر تشغيل الرسالة الصوتية", true);
    btn.classList.remove("playing"); btn.innerHTML = VOICE_PLAY_ICON;
    activeVoiceAudio = null; activeVoiceBtn = null;
  });
}
$("#messages").addEventListener("click", (e)=>{
  const btn = e.target.closest(".voice-play-btn");
  if(!btn || btn.disabled) return;
  toggleVoicePlayback(btn);
});

/* =====================================================================
   Voice-note RECORDING — press-and-hold on a phone or click on desktop,
   both driven off the SAME #sendBtn that already doubles as the mic/send
   icon. Which gesture applies is decided per-interaction from the real
   pointerType (touch vs mouse/pen) rather than screen size or device
   type, so the exact same code behaves correctly on a phone, a mouse-
   driven desktop, AND a hybrid device (e.g. a touchscreen laptop) that
   can use either input at different moments.

   Phone (pointerType "touch"): press and hold to record. Sliding the
   finger up past a small threshold "arms" the × cancel button (it turns
   red) — recording keeps going hands-free after that, and now only an
   explicit tap on × discards it. Lifting the finger BEFORE arming sends
   immediately (classic hold-and-release). Losing the touch entirely
   (e.g. an incoming call) always cancels.

   Desktop (mouse/pen): a single click starts recording and immediately
   shows the × cancel button plus turns #sendBtn into a ✔ — click × to
   discard, click ✔ (the same button) to stop and send.
   ===================================================================== */
let voiceStream = null, voiceRecorder = null, voiceChunks = [];
let voiceRecording = false, voiceCancelArmed = false, voicePointerType = null;
let voiceStartTime = 0, voiceStartY = 0, voiceTimerInt = null;
const VOICE_CANCEL_THRESHOLD = 60; // px slid upward before the × arms (touch only)
const VOICE_MIN_MS = 700;          // shorter than this and we discard it silently, like WhatsApp

function pickVoiceMime(){
  if(!window.MediaRecorder) return "";
  const candidates = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/aac","audio/ogg;codecs=opus"];
  for(const c of candidates){
    try{ if(MediaRecorder.isTypeSupported(c)) return c; }catch(e){}
  }
  return "";
}
function stopVoiceStreamTracks(){
  if(voiceStream){ voiceStream.getTracks().forEach(t=>t.stop()); voiceStream = null; }
}
function cleanupVoicePointerListeners(){
  window.removeEventListener("pointermove", onVoicePointerMove);
  window.removeEventListener("pointerup", onVoicePointerUp);
  window.removeEventListener("pointercancel", onVoicePointerCancelForce);
}
function resetVoiceUI(){
  clearInterval(voiceTimerInt);
  voiceTimerInt = null;
  cleanupVoicePointerListeners();
  $("#composer").classList.remove("is-recording", "cancel-armed");
  $("#messageInput").disabled = false;
  voiceRecording = false;
  voiceCancelArmed = false;
  voicePointerType = null;
}

async function startVoiceRecording(pointerType, startY){
  if(voiceRecording || !activeChatPeer) return;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
    toast("جهازك أو المتصفح مش بيدعم تسجيل الصوت", true);
    return;
  }
  /* getUserMedia only works on a "secure context" — https, or localhost
     while testing. On plain http (or a file:// preview) the browser
     refuses it outright and every attempt lands in the catch below
     looking exactly like a permission problem, even once the person HAS
     allowed the mic — so we check this specific case first and say so
     plainly instead of telling them to grant a permission that isn't
     actually the issue. */
  if(!window.isSecureContext){
    toast("لازم الموقع يشتغل على HTTPS عشان تقدر تسجل صوت", true);
    return;
  }
  try{
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio:true });
  }catch(err){
    console.error("getUserMedia failed:", err.name, err.message);
    let msg = "تعذر الوصول للمايكروفون";
    if(err.name === "NotAllowedError" || err.name === "PermissionDeniedError"){
      msg = "لازم توافق على إذن المايكروفون من إعدادات المتصفح";
    } else if(err.name === "NotFoundError" || err.name === "DevicesNotFoundError"){
      msg = "مفيش مايكروفون متصل بالجهاز ده";
    } else if(err.name === "NotReadableError" || err.name === "TrackStartError"){
      msg = "المايكروفون مستخدم في برنامج تاني دلوقتي";
    } else if(err.name === "SecurityError"){
      msg = "لازم الموقع يشتغل على HTTPS عشان تقدر تسجل صوت";
    }
    toast(msg, true);
    return;
  }
  const mime = pickVoiceMime();
  try{
    voiceRecorder = mime ? new MediaRecorder(voiceStream, { mimeType:mime }) : new MediaRecorder(voiceStream);
  }catch(err){
    console.error(err);
    toast("تعذر بدء التسجيل", true);
    stopVoiceStreamTracks();
    return;
  }
  voiceChunks = [];
  voiceRecorder.addEventListener("dataavailable", (e)=>{ if(e.data && e.data.size > 0) voiceChunks.push(e.data); });
  voiceRecording = true;
  voiceCancelArmed = false;
  voicePointerType = pointerType;
  voiceStartTime = Date.now();
  voiceStartY = startY || 0;
  voiceRecorder.start();

  $("#messageInput").disabled = true;
  $("#composer").classList.add("is-recording");
  $("#recordingHint").textContent = pointerType === "touch"
    ? "اسحب لأعلى أو دوس × للإلغاء"
    : "دوس × للإلغاء، أو ✔ للإرسال";
  $("#recordingTimer").textContent = "0:00";
  voiceTimerInt = setInterval(()=>{
    $("#recordingTimer").textContent = fmtDuration((Date.now() - voiceStartTime) / 1000);
  }, 200);

  if(pointerType === "touch"){
    window.addEventListener("pointermove", onVoicePointerMove);
    window.addEventListener("pointerup", onVoicePointerUp);
    window.addEventListener("pointercancel", onVoicePointerCancelForce);
  }
}
function onVoicePointerMove(e){
  if(!voiceRecording || voicePointerType !== "touch" || voiceCancelArmed) return;
  if((voiceStartY - e.clientY) > VOICE_CANCEL_THRESHOLD) armVoiceCancel();
}
function armVoiceCancel(){
  voiceCancelArmed = true;
  $("#composer").classList.add("cancel-armed");
  $("#recordingHint").textContent = "هتفضل تسجل... دوس × عشان تلغي";
}
function onVoicePointerUp(){
  if(!voiceRecording || voicePointerType !== "touch") return;
  if(voiceCancelArmed) return; // armed -> only an explicit tap on × cancels now
  stopAndSendVoice();
}
function onVoicePointerCancelForce(){
  if(voiceRecording) cancelVoiceRecording();
}

function cancelVoiceRecording(){
  if(!voiceRecording) return;
  const recorder = voiceRecorder;
  resetVoiceUI();
  try{ if(recorder && recorder.state !== "inactive") recorder.stop(); }catch(e){}
  stopVoiceStreamTracks();
  voiceChunks = [];
  toast("اتلغى التسجيل");
}

async function stopAndSendVoice(){
  if(!voiceRecording) return;
  const durationMs = Date.now() - voiceStartTime;
  const recorder = voiceRecorder;
  const mimeType = (recorder && recorder.mimeType) ? recorder.mimeType : "audio/webm";
  resetVoiceUI();

  const blob = await new Promise((resolve)=>{
    recorder.addEventListener("stop", ()=> resolve(new Blob(voiceChunks, { type: mimeType })), { once:true });
    try{ if(recorder.state !== "inactive") recorder.stop(); else resolve(new Blob(voiceChunks, { type: mimeType })); }
    catch(e){ resolve(new Blob(voiceChunks, { type: mimeType })); }
  });
  stopVoiceStreamTracks();
  voiceChunks = [];

  if(durationMs < VOICE_MIN_MS){
    toast("سجّل شوية زيادة عشان تقدر تبعت");
    return;
  }
  if(!activeChatPeer || !activeChatId) return;

  const durationSec = Math.round(durationMs / 1000);
  const tempId = "pending-voice-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  appendPendingVoiceBubble(tempId, durationSec);

  try{
    if(!storage) throw new Error("Firebase Storage غير مهيأ");
    const ext = mimeType.includes("mp4") ? "m4a" : (mimeType.includes("ogg") ? "ogg" : "webm");
    const ref = storage.ref(`voice/${activeChatId}/${tempId}.${ext}`);
    await ref.put(blob, { contentType: mimeType });
    const url = await ref.getDownloadURL();

    const isAiChat = activeChatPeer.id === AI_PEER_ID;
    const msgPayload = {
      senderId: currentUser.id, type:"voice", audioUrl:url, duration:durationSec,
      status: isAiChat ? "read" : "sent",
      ts: firebase.firestore.FieldValue.serverTimestamp()
    };
    await db.collection("chats").doc(activeChatId).collection("messages").add(msgPayload);
    resolvePendingMessageBubble(tempId);
    await db.collection("chats").doc(activeChatId).set({
      participants:[currentUser.id, activeChatPeer.id],
      lastMessage: "🎤 رسالة صوتية",
      lastMessageSenderId: currentUser.id,
      lastMessageStatus: isAiChat ? "read" : "sent",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      unreadCounts: { [activeChatPeer.id]: firebase.firestore.FieldValue.increment(1) },
      deletedFor: firebase.firestore.FieldValue.arrayRemove(currentUser.id, activeChatPeer.id)
    }, { merge:true });
    chatDocExistsForActive = true;
  }catch(err){
    console.error(err);
    removePendingMessageBubble(tempId);
    toast("تعذر إرسال الرسالة الصوتية", true);
  }
}

/* Both gestures start from the very same button — pointerdown decides,
   per-interaction, whether this is "start recording" (mic mode, no text
   yet) or just a normal tap that should fall through to the form's
   ordinary submit-to-send-text behavior (has-text mode, untouched). */
$("#sendBtn").addEventListener("pointerdown", (e)=>{
  if($("#sendBtn").classList.contains("has-text")) return;
  e.preventDefault();
  if(voiceRecording){ stopAndSendVoice(); return; } // armed/desktop tap-to-send
  startVoiceRecording(e.pointerType === "touch" ? "touch" : "mouse", e.clientY);
});
$("#sendBtn").addEventListener("click", (e)=>{
  if(!$("#sendBtn").classList.contains("has-text")) e.preventDefault();
});
$("#voiceCancelBtn").addEventListener("click", ()=> cancelVoiceRecording());
window.addEventListener("beforeunload", ()=>{ if(voiceRecording) cancelVoiceRecording(); });

/* =====================================================================
   Peer typing indicator — a little 3-dot bubble that appears on MY
   screen, at the very end/bottom of the messages list (right above the
   composer, like the newest incoming message would sit), whenever the
   OTHER person is actively typing in the SAME chat on their end. It's
   driven purely by a boolean field on the shared chat doc, so it works
   the same regardless of which side is "me" — see notifyTyping /
   stopTypingNow below for the side that WRITES that field.
   ===================================================================== */
function showPeerTypingIndicator(){
  const msgsBox = $("#messages");
  if(!msgsBox) return;
  let node = $("#peerTypingIndicator", msgsBox);
  const wasNearBottom = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight < 80;
  if(!node){
    node = document.createElement("div");
    node.className = "msg in typing-indicator";
    node.id = "peerTypingIndicator";
    node.innerHTML = `<span class="ti-dot"></span><span class="ti-dot"></span><span class="ti-dot"></span>`;
    msgsBox.appendChild(node);
    void node.offsetWidth; // force reflow so the slide-up-in transition actually plays
  }
  node.classList.add("ti-show");
  if(wasNearBottom) msgsBox.scrollTop = msgsBox.scrollHeight;
}
function removePeerTypingIndicator(){
  const node = $("#peerTypingIndicator");
  if(!node) return;
  node.classList.remove("ti-show");
  setTimeout(()=> node.remove(), 300);
}

/* ---- floating "jump to latest" button — shown only once the person
   has scrolled up far enough from the bottom of the open chat ---- */
function updateScrollToBottomBtn(){
  const msgsBox = $("#messages");
  const btn = $("#scrollToBottomBtn");
  if(!msgsBox || !btn) return;
  const distanceFromBottom = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight;
  btn.classList.toggle("stbb-show", distanceFromBottom > 150);
}
$("#messages").addEventListener("scroll", updateScrollToBottomBtn);
$("#scrollToBottomBtn").addEventListener("click", ()=>{
  const msgsBox = $("#messages");
  if(!msgsBox) return;
  msgsBox.scrollTo({ top: msgsBox.scrollHeight, behavior:"smooth" });
});

/* Writes MY typing status onto the shared chat doc so the OTHER person
   sees the bubble above. Only fires for real chats that already exist
   (never for the AI chat, which has its own separate aiTyping flow, and
   never before a chat doc actually exists yet — see the "never
   create/resurrect a chat doc just by opening it" note above). Also
   reuses the same "الرسائل المقروءة" privacy toggle that already hides
   the read tick — turning that off hides BOTH your read status and
   your typing status from the other person, same idea, one switch.
   The "true" write only happens once per typing burst; after that we
   just keep pushing the 2s "stop" timer back on every further keystroke. */
let iAmTyping = false;
let stopTypingTimer = null;
function notifyTyping(){
  if(!activeChatId || !activeChatPeer || activeChatPeer.id === AI_PEER_ID) return;
  if(!chatDocExistsForActive) return;
  if(currentUser.readReceipts === false) return;
  const chatRef = db.collection("chats").doc(activeChatId);
  if(!iAmTyping){
    iAmTyping = true;
    chatRef.set({ [`typing_${currentUser.id}`]: true }, {merge:true}).catch(()=>{});
  }
  clearTimeout(stopTypingTimer);
  stopTypingTimer = setTimeout(stopTypingNow, 2000);
}
function stopTypingNow(){
  clearTimeout(stopTypingTimer);
  if(!iAmTyping) return;
  iAmTyping = false;
  if(activeChatId && activeChatPeer && activeChatPeer.id !== AI_PEER_ID && chatDocExistsForActive){
    db.collection("chats").doc(activeChatId).set({ [`typing_${currentUser.id}`]: false }, {merge:true}).catch(()=>{});
  }
}

/* ---- composer textarea grows with the text, up to the CSS max-height
   (then it scrolls internally, same as the reference design).
   overflow-y stays "hidden" while it's still short so no scrollbar ever
   flashes on a one-liner — it only flips to "auto" once the content has
   actually grown past max-height and truly needs an internal scroll. ---- */
function autoResizeComposer(){
  const ta = $("#messageInput");
  const maxHeight = parseFloat(getComputedStyle(ta).maxHeight) || 140;
  ta.style.height = "auto";
  const needsScroll = ta.scrollHeight > maxHeight;
  ta.style.height = (needsScroll ? maxHeight : ta.scrollHeight) + "px";
  ta.style.overflowY = needsScroll ? "auto" : "hidden";
  updateSendButtonIcon();
}

/* ---- send button starts out looking like a mic (nothing to send yet)
   and morphs into the send-arrow the moment there's actual text in the
   box, morphing back the instant it's emptied again — this runs off
   autoResizeComposer, which already fires after every place the
   composer's value changes (typing, emoji insert, draft restore, send,
   a failed send restoring the text, etc.), so it never needs its own
   separate wiring. ---- */
function updateSendButtonIcon(){
  const hasText = $("#messageInput").value.trim() !== "";
  $("#sendBtn").classList.toggle("has-text", hasText);
}

/* ---- collapses the composer back to the plain single-line "input"
   look (the CSS default height) — only while it's empty, so we never
   clip text the person actually typed ---- */
function collapseComposerIfEmpty(){
  const ta = $("#messageInput");
  if(ta.value.trim() !== "") return;
  ta.style.height = "";
  ta.style.overflowY = "hidden";
}

/* starts as a plain compact input; clicking in expands it into the
   growing textarea, and it collapses back once empty + unfocused.
   Focusing it while messages are selected also cancels that selection
   first — the composer is for typing a new message, not for acting on
   a picked one, so jumping into it reads as "never mind, forget the
   selection" same as tapping empty space in the messages list does. */
$("#messageInput").addEventListener("focus", ()=>{
  if(isSelectionMode()) exitSelectionMode();
  autoResizeComposer();
});
$("#messageInput").addEventListener("blur", collapseComposerIfEmpty);

/* ---- save an unsent draft as the person types, WhatsApp-style ---- */
let draftSaveTimer = null;
$("#messageInput").addEventListener("input", (e)=>{
  autoResizeComposer();
  if(!activeChatId) return;
  const val = e.target.value;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(()=>{
    setDraftText(activeChatId, val);
  }, 150);
});

/* ---- broadcast MY typing status to the other person (see the
   notifyTyping/stopTypingNow definitions + the chat-doc listener
   further down for the side that RENDERS it on their screen) ---- */
$("#messageInput").addEventListener("input", (e)=>{
  if(e.target.value.trim() !== "") notifyTyping();
  else stopTypingNow();
});

/* Enter sends the message (like a normal chat composer); Shift+Enter
   inserts a real line break instead, since it's now a growing textarea
   and would otherwise just add a newline on every Enter press */
$("#messageInput").addEventListener("keydown", (e)=>{
  if(e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});

/* =====================================================================
   Emoji picker — tapping the emoji button hides the keyboard (on phone/
   tablet) and opens a panel to pick from instead; tapping it again (now
   showing a keyboard icon) or tapping back into the message box brings
   the keyboard back. On desktop it's just a floating popover next to
   the button, no keyboard involved.
   ===================================================================== */
const EMOJI_ICON_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>`;
const KEYBOARD_ICON_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6"/></svg>`;

const EMOJI_DATA = {
  recent:   { label:"الأخيرة", icon:"🕐", items:[] },
  smileys:  { label:"وجوه", icon:"😊", items:["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🥵","🥶","🥴","😵","🤯","🥳","😎","🥺","😢","😭","😤","😠","😡","🤬","😳","🥱","😨","😰","😥","😓","🤗"] },
  gestures: { label:"إيدين", icon:"👋", items:["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🙏","💪","🦾","🖤","❤️","🤝","💅","🤳"] },
  people:   { label:"أشخاص", icon:"🧑", items:["👶","🧒","👦","👧","🧑","👨","👩","🧓","👴","👵","😎","🤓","🧕","👳","👲","🤰","👼","🎅","🦸","🦹","🧙","🧚","🧛","🧟","💆","💇","🚶","🧍","🧎","🏃","💃","🕺","👫","👬","👭","💑","💏","👪"] },
  animals:  { label:"حيوانات", icon:"🐶", items:["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐢","🐍","🦖","🐙","🦀","🐬","🐳","🐘","🦒","🦓","🐄","🐑","🐕","🐈"] },
  food:     { label:"أكل وشرب", icon:"🍔", items:["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑","🥦","🌽","🥕","🌶️","🥐","🍞","🥖","🧀","🥚","🍳","🥞","🥓","🍔","🍟","🍕","🌭","🥪","🌮","🌯","🥗","🍿","🍗","🍖","🍤","🍱","🍣","🍦","🍩","🍪","🎂","🍫","🍬","🍭","☕","🍵","🥤","🧃","🍺","🍷"] },
  activity: { label:"أنشطة", icon:"⚽", items:["⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥊","🥋","⛳","🎣","🎽","🎿","🏋️","🚴","🏊","🧘","🎮","🎲","🎯","🎳","🎸","🎹","🎤","🎧","🎨","🎭","🎬","🏆","🥇","🥈","🥉"] },
  travel:   { label:"سفر وأماكن", icon:"🚗", items:["🚗","🚕","🚙","🚌","🏎️","🚓","🚑","🚒","🚚","🚲","🛵","🏍️","✈️","🚀","🚁","⛵","🚢","⛽","🚦","🗺️","🗽","🗼","🏰","🕌","🕋","⛺","🏖️","🏝️","🏔️","🌋","🌅","🌇","🌃","🌆","🌉","🌌","☀️","🌙","⭐","☁️","🌧️","⛈️","❄️","🔥","🌈"] },
  objects:  { label:"أدوات", icon:"💡", items:["⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","📷","📸","🎥","📞","☎️","📺","📻","🔋","🔌","💡","🔦","🕯️","📚","📖","✏️","🖊️","📌","📎","✂️","🔑","🔒","🔓","🔨","🛠️","💰","💵","💳","🎁","📦","✉️","📩","📅","📁","📊","📈","🔔","🔕","🎵","🎶"] },
  symbols:  { label:"رموز", icon:"❤️", items:["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💯","✅","❌","❗","❓","⚠️","♻️","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","🔺","🔻","💠","♠️","♥️","♦️","♣️"] },
  flags:    { label:"أعلام", icon:"🏁", items:["🏳️","🏴","🏁","🚩","🎌","🇪🇬","🇸🇦","🇦🇪","🇰🇼","🇶🇦","🇧🇭","🇴🇲","🇯🇴","🇱🇧","🇸🇾","🇮🇶","🇲🇦","🇹🇳","🇩🇿","🇱🇾","🇸🇩","🇾🇪","🇵🇸","🇹🇷","🇺🇸","🇬🇧","🇫🇷","🇩🇪"] }
};

/* very small keyword map so search has something to match against —
   not exhaustive, just covers the common ones people actually search */
const EMOJI_KEYWORDS = {
  "😀":"مبسوط سعيد smile happy","😂":"ضحك جامد لول lol laugh","🤣":"ضحك لول","😍":"حب عيون قلب love","😘":"بوسه قبلة kiss",
  "😭":"عياط بكاء cry","😢":"زعلان حزين sad","😡":"زعلان غضب angry","🥰":"حب هابي love","😎":"كول cool شمسيه",
  "👍":"تمام لايك like ok حلو","👎":"وحش dislike","🙏":"دعاء صلاة please thanks","👏":"تصفيق clap","💪":"قوة قوي strong",
  "❤️":"قلب حب heart love","💔":"قلب مكسور broken heart","🔥":"نار fire حلو جامد","🎉":"مبروك احتفال party","✅":"تمام صح ok done",
  "❌":"غلط لا خطأ wrong no","😴":"نايم نعسان sleep tired","🤔":"تفكير think","😅":"ضحك عصبي","🙄":"زهقان bored",
  "🎂":"عيد ميلاد birthday كيكة","☕":"قهوة coffee","🍕":"بيتزا pizza","🚗":"عربية car","✈️":"طيارة سفر travel plane",
  "🐶":"كلب dog","🐱":"قطة cat","⚽":"كورة فوتبول football","🎮":"جيمز بلايستيشن game","💰":"فلوس money","🎁":"هدية gift"
};

let emojiPanelOpen = false;
/* true while the panel was opened from the reaction "+" button on phone
   instead of from the composer's own emoji button — in this mode
   tapping an emoji applies a reaction instead of typing it, and closing
   the panel restores the composer instead of refocusing it */
let emojiPanelReactionMode = false;
let activeEmojiCat = "recent";
const RECENT_EMOJI_KEY = "wasla_recent_emojis";

function loadRecentEmojis(){
  try{
    const raw = localStorage.getItem(RECENT_EMOJI_KEY);
    EMOJI_DATA.recent.items = raw ? JSON.parse(raw) : [];
  }catch(e){ EMOJI_DATA.recent.items = []; }
}
function saveRecentEmoji(emoji){
  const list = EMOJI_DATA.recent.items.filter(e=>e!==emoji);
  list.unshift(emoji);
  EMOJI_DATA.recent.items = list.slice(0, 32);
  try{ localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(EMOJI_DATA.recent.items)); }catch(e){}
}

/* ---- quick-react bar (the 6 always-visible icons + "+") ----
   Picking one of these 6 directly never changes their order — the row
   has to stay put while someone's actively tapping it. Picking a
   reaction from the full emoji page (or the desktop extra-emoji grid)
   instead moves that emoji to the front of this row (bumping the
   oldest one out), so the quick bar drifts toward whatever a person
   actually reaches for beyond the default set, over time. */
const QUICK_REACTIONS_DEFAULT = ["👍","❤️","😂","😮","😢","🙏"];
const QUICK_REACTIONS_KEY = "wasla_quick_reactions";
let quickReactions = QUICK_REACTIONS_DEFAULT.slice();
function renderQuickReactions(){
  $("#reactionBarQuick").innerHTML = quickReactions.map(em=>
    `<button type="button" class="reaction-bar-emoji" data-emoji="${em}">${em}</button>`
  ).join("");
}
function loadQuickReactions(){
  try{
    const raw = localStorage.getItem(QUICK_REACTIONS_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    quickReactions = Array.isArray(saved) && saved.length ? saved : QUICK_REACTIONS_DEFAULT.slice();
  }catch(e){ quickReactions = QUICK_REACTIONS_DEFAULT.slice(); }
  renderQuickReactions();
}
function bumpQuickReaction(emoji){
  const list = quickReactions.filter(e=> e !== emoji);
  list.unshift(emoji);
  quickReactions = list.slice(0, 6);
  try{ localStorage.setItem(QUICK_REACTIONS_KEY, JSON.stringify(quickReactions)); }catch(e){}
  renderQuickReactions();
}

/* remembers where the cursor was in the message box, so emojis still
   land in the right place even after we've blurred it to hide the
   keyboard */
let composerLastSelection = {start:0, end:0};
$("#messageInput").addEventListener("blur", (e)=>{
  composerLastSelection.start = e.target.selectionStart;
  composerLastSelection.end = e.target.selectionEnd;
});
$("#messageInput").addEventListener("keyup", (e)=>{
  composerLastSelection.start = e.target.selectionStart;
  composerLastSelection.end = e.target.selectionEnd;
});
$("#messageInput").addEventListener("click", (e)=>{
  composerLastSelection.start = e.target.selectionStart;
  composerLastSelection.end = e.target.selectionEnd;
});

function insertEmojiIntoComposer(emoji){
  const ta = $("#messageInput");
  const focused = document.activeElement === ta;
  const start = focused ? ta.selectionStart : composerLastSelection.start;
  const end = focused ? ta.selectionEnd : composerLastSelection.end;
  const val = ta.value;
  ta.value = val.slice(0, start) + emoji + val.slice(end);
  const newPos = start + emoji.length;
  if(focused){ ta.selectionStart = ta.selectionEnd = newPos; }
  composerLastSelection.start = composerLastSelection.end = newPos;
  autoResizeComposer();
  if(activeChatId){
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(()=>{ setDraftText(activeChatId, ta.value); }, 150);
  }
  saveRecentEmoji(emoji);
  if(activeEmojiCat === "recent") renderEmojiCategory("recent");
}

function renderEmojiTabs(){
  const tabs = $("#emojiPanelTabs");
  tabs.innerHTML = Object.keys(EMOJI_DATA).map(key=>{
    const cat = EMOJI_DATA[key];
    return `<button type="button" data-cat="${key}" class="${key===activeEmojiCat?"active":""}" title="${cat.label}">${cat.icon}</button>`;
  }).join("");
}

function renderEmojiCategory(key){
  activeEmojiCat = key;
  const body = $("#emojiPanelBody");
  const cat = EMOJI_DATA[key];
  if(!cat.items.length){
    body.innerHTML = `<p class="emoji-panel-empty">${key==="recent" ? "لسه معملتش اختيار لأي إيموجي" : "مفيش إيموجي هنا"}</p>`;
  }else{
    body.innerHTML = `
      <div class="emoji-panel-section-title">${cat.label}</div>
      <div class="emoji-panel-grid">${cat.items.map(e=>`<button type="button" data-emoji="${e}">${e}</button>`).join("")}</div>
    `;
  }
  document.querySelectorAll(".emoji-panel-tabs button").forEach(b=> b.classList.toggle("active", b.dataset.cat === key));
}

function renderEmojiSearch(query){
  const q = query.trim().toLowerCase();
  const body = $("#emojiPanelBody");
  if(!q){ renderEmojiCategory(activeEmojiCat); return; }
  const seen = new Set();
  const matches = [];
  Object.values(EMOJI_DATA).forEach(cat=>{
    cat.items.forEach(e=>{
      if(seen.has(e)) return;
      const kw = EMOJI_KEYWORDS[e] || "";
      if(kw.toLowerCase().includes(q)){ seen.add(e); matches.push(e); }
    });
  });
  body.innerHTML = matches.length
    ? `<div class="emoji-panel-grid">${matches.map(e=>`<button type="button" data-emoji="${e}">${e}</button>`).join("")}</div>`
    : `<p class="emoji-panel-empty">مفيش نتايج لـ "${query}"</p>`;
}

function openEmojiPanel(reactionMode){
  emojiPanelOpen = true;
  emojiPanelReactionMode = !!reactionMode;
  $("#emojiPanel").classList.add("open");
  $("#emojiPanel").classList.toggle("reaction-mode", emojiPanelReactionMode);
  if(emojiPanelReactionMode){
    /* full-page-style picker standing in for the reaction grid: hide the
       composer entirely (not just lift it) so it reads like the phone's
       own emoji keyboard, the way it does in the reference screenshot */
    $("#composer").classList.add("reaction-emoji-active");
  } else {
    $("#emojiBtn").innerHTML = KEYBOARD_ICON_SVG;
  }
  $("#emojiSearchInput").value = "";
  renderEmojiTabs();
  renderEmojiCategory(EMOJI_DATA.recent.items.length ? "recent" : "smileys");
  if(!emojiPanelReactionMode) applyMobileComposerLift();
}
function closeEmojiPanel(){
  emojiPanelOpen = false;
  $("#emojiPanel").classList.remove("open", "reaction-mode");
  if(!emojiPanelReactionMode) $("#emojiBtn").innerHTML = EMOJI_ICON_SVG;
  $("#composer").classList.remove("reaction-emoji-active");
  clearMobileComposerLift();
  emojiPanelReactionMode = false;
}

/* on phone (single-pane view) the emoji panel is a fixed bottom sheet
   that would otherwise sit right on top of (and hide) the composer —
   this lifts the composer to sit visibly just above the panel instead,
   so the emoji/attach/send buttons and the message box stay usable
   while picking. Tablet & desktop (768px+, already split into the
   two-pane view) use a small floating popover instead and don't
   need this. */
function applyMobileComposerLift(){
  if(window.innerWidth >= 768) return;
  const h = $("#emojiPanel").getBoundingClientRect().height;
  $("#composer").style.marginBottom = h + "px";
}
function clearMobileComposerLift(){
  $("#composer").style.marginBottom = "";
}
window.addEventListener("resize", ()=>{
  if(emojiPanelOpen && !emojiPanelReactionMode) applyMobileComposerLift();
});

loadRecentEmojis();
loadQuickReactions();

$("#emojiBtn").addEventListener("click", ()=>{
  if(emojiPanelOpen){
    closeEmojiPanel();
    $("#messageInput").focus();
  }else{
    $("#messageInput").blur();
    openEmojiPanel();
  }
});

/* tapping back into the message box always brings the keyboard back */
$("#messageInput").addEventListener("focus", ()=>{
  if(emojiPanelOpen) closeEmojiPanel();
});

$("#emojiPanelHandle").addEventListener("click", ()=>{
  const wasReactionMode = emojiPanelReactionMode;
  closeEmojiPanel();
  if(wasReactionMode) closeReactionBar();
  else $("#messageInput").focus();
});

$("#emojiPanelTabs").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-cat]");
  if(!btn) return;
  $("#emojiSearchInput").value = "";
  renderEmojiCategory(btn.dataset.cat);
});

$("#emojiPanelBody").addEventListener("click", (e)=>{
  const btn = e.target.closest("button[data-emoji]");
  if(!btn) return;
  if(emojiPanelReactionMode){
    if(reactionBarMsgId) applyReaction(reactionBarMsgId, btn.dataset.emoji);
    saveRecentEmoji(btn.dataset.emoji);
    bumpQuickReaction(btn.dataset.emoji);
    return;
  }
  insertEmojiIntoComposer(btn.dataset.emoji);
});

$("#emojiSearchInput").addEventListener("input", (e)=>{
  renderEmojiSearch(e.target.value);
});

/* tapping anywhere else outside the panel/button closes it, like a
   normal dropdown (mainly matters on desktop's floating popover) */
document.addEventListener("click", (e)=>{
  if(!emojiPanelOpen) return;
  if(e.target.closest("#emojiPanel") || e.target.closest("#emojiBtn")) return;
  const wasReactionMode = emojiPanelReactionMode;
  closeEmojiPanel();
  if(wasReactionMode) closeReactionBar();
}, true);


$("#composer").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const input = $("#messageInput");
  const text = input.value.trim();
  if(!text || !activeChatPeer) return;

  /* Both block checks now read from state that's already kept live in
     memory (watchPeer keeps activeChatPeer.blocked in sync in real
     time), instead of firing an extra Firestore query before every
     single send — that round trip was the main reason the very first
     message in a chat felt slow to go out. */
  /* I blocked THEM -> composer is hidden already (see updateBlockBanner),
     but keep this as a safety net in case the handler fires anyway. */
  if(Array.isArray(currentUser.blocked) && currentUser.blocked.includes(activeChatPeer.id)){
    toast("انت حاظر المستخدم ده، شيل الحظر الأول عشان تبعت", true);
    return;
  }
  /* THEY blocked me -> intentionally NOT checked here. The send proceeds
     completely normally from my point of view (message appears, single
     grey check), exactly like it would if I just had no internet —
     nothing here reveals that a block happened. The message quietly
     never advances past "sent" because markMessagesDeliveredForChat /
     markPeerMessagesRead both skip updating status for someone I've
     blocked, and by the same logic here, someone who has blocked ME
     never lets my message's status move past sent either — see those
     two functions below. */

  input.value = "";
  autoResizeComposer();
  stopTypingNow();
  clearTimeout(draftSaveTimer);
  setDraftText(activeChatId, "");
  if(activeChatPeer) refreshChatItemDraft(activeChatPeer.id);
  const replySnapshot = replyingTo;
  clearReplyState();

  const tempId = "pending-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  appendPendingMessageBubble(tempId, text, replySnapshot);

  try{
    /* Wasla AI isn't a real user with presence, so it never goes through
       markMessagesDeliveredForChat/markPeerMessagesRead — without this,
       a message sent to it would sit on a single grey check forever.
       Since the AI always "reads" it right away, mark it read on arrival
       so the double tick shows up blue immediately, like WhatsApp. */
    const isAiChat = activeChatPeer.id === AI_PEER_ID;
    const msgPayload = {
      senderId: currentUser.id, text, status: isAiChat ? "read" : "sent",
      ts: firebase.firestore.FieldValue.serverTimestamp()
    };
    if(replySnapshot){
      msgPayload.replyTo = { id: replySnapshot.id, senderId: replySnapshot.senderId, text: replySnapshot.text };
    }
    await db.collection("chats").doc(activeChatId).collection("messages").add(msgPayload);
    resolvePendingMessageBubble(tempId);
    await db.collection("chats").doc(activeChatId).set({
      participants:[currentUser.id, activeChatPeer.id],
      lastMessage: text,
      lastMessageSenderId: currentUser.id,
      lastMessageStatus: isAiChat ? "read" : "sent",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      unreadCounts: { [activeChatPeer.id]: firebase.firestore.FieldValue.increment(1) },
      /* a real new message means the conversation is active again — bring
         it back into the list for whichever side(s) had deleted it */
      deletedFor: firebase.firestore.FieldValue.arrayRemove(currentUser.id, activeChatPeer.id)
    }, {merge:true});
    chatDocExistsForActive = true;
    if(activeChatPeer.id === AI_PEER_ID) requestAiReply(activeChatId, currentUser.id);
  }catch(err){
    console.error(err);
    removePendingMessageBubble(tempId);
    input.value = text;
    autoResizeComposer();
    toast("تعذر إرسال الرسالة", true);
  }
});

/* =====================================================================
   7) BLOCK / UNBLOCK
   ===================================================================== */
$("#blockBtn").addEventListener("click", async ()=>{
  if(!activeChatPeer) return;
  const isBlocked = (currentUser.blocked || []).includes(activeChatPeer.id);
  if(isBlocked){
    if(!confirm(`تلغي حظر ${peerDisplayName(activeChatPeer)}؟`)) return;
    await unblockId(activeChatPeer.id);
  } else {
    if(!confirm(`متأكد إنك عايز تحظر ${peerDisplayName(activeChatPeer)}؟`)) return;
    await blockId(activeChatPeer.id);
  }
});

async function blockId(id){
  if(id === currentUser.id){ toast("متقدرش تحظر نفسك", true); return; }
  try{
    await db.collection("users").doc(currentUser.uid).update({
      blocked: firebase.firestore.FieldValue.arrayUnion(id)
    });
    if(!currentUser.blocked.includes(id)) currentUser.blocked.push(id);
    renderBlockedList();
    updateBlockBanner();
    toast("تم الحظر");
  }catch(err){ console.error(err); toast("حصل خطأ أثناء الحظر", true); }
}
async function unblockId(id){
  try{
    await db.collection("users").doc(currentUser.uid).update({
      blocked: firebase.firestore.FieldValue.arrayRemove(id)
    });
    currentUser.blocked = currentUser.blocked.filter(x=>x!==id);
    renderBlockedList();
    updateBlockBanner();
    toast("تم إلغاء الحظر");
  }catch(err){ console.error(err); toast("حصل خطأ", true); }
}

/* Shows/hides a banner in the open chat instead of the composer whenever
   either side has blocked the other, and restores the composer the
   moment the block is lifted. */
function updateBlockBanner(){
  const banner = $("#blockBanner");
  const composerEl = $("#composer");
  if(!banner || !composerEl) return;
  if(!activeChatPeer){
    banner.classList.add("hidden");
    composerEl.classList.remove("hidden");
    return;
  }
  const iBlockedThem = (currentUser.blocked || []).includes(activeChatPeer.id);

  if(iBlockedThem){
    banner.className = "block-banner";
    banner.innerHTML = `<span>الرقم ده محظور من طرفك، مش هتقدروا تتبادلوا رسائل</span><button type="button" id="unblockFromChat">إلغاء الحظر</button>`;
    $("#unblockFromChat", banner).addEventListener("click", async ()=>{
      await unblockId(activeChatPeer.id);
    });
    composerEl.classList.add("hidden");
  } else {
    /* covers both "no block at all" and "they blocked me" — in the second
       case the composer stays open and sending looks completely normal
       on purpose (no banner, no error), so nothing here gives away that
       a block happened. The messages still quietly never arrive (see the
       composer submit handler + markMessagesDeliveredForChat), so all
       the sender ever sees is a single grey check, like a connectivity
       issue, exactly like a real chat app hides this from the blocked
       person. */
    banner.classList.add("hidden");
    banner.innerHTML = "";
    composerEl.classList.remove("hidden");
  }
}

$("#blockIdBtn").addEventListener("click", async ()=>{
  const id = $("#blockIdInput").value.trim();
  const msg = $("#blockMsg");
  if(id.length !== 11){ msg.textContent = "رقم التعريف لازم يكون 11 رقم"; return; }
  msg.textContent = "";
  await blockId(id);
  $("#blockIdInput").value = "";
});
$("#blockIdInput").addEventListener("input", e=>{ e.target.value = e.target.value.replace(/\D/g,""); });

function renderBlockedList(){
  const box = $("#blockedList");
  const list = currentUser.blocked || [];
  if(!list.length){ box.innerHTML = `<p class="hint-text">مفيش حد محظور حاليًا</p>`; return; }
  box.innerHTML = "";
  list.forEach(id=>{
    const row = document.createElement("div");
    row.className = "blocked-item";
    row.innerHTML = `<span>${escapeHtml(id)}</span><button>إلغاء الحظر</button>`;
    row.querySelector("button").addEventListener("click", ()=> unblockId(id));
    box.appendChild(row);
    /* Not-yet-registered users only have a placeholder profile, so keep
       showing the ID for them — once they register, swap in their name. */
    lookupUserById(id).then(peer=>{
      if(peer && peer.uid){
        row.querySelector("span").textContent = peer.name;
      }
    });
  });
}

/* =====================================================================
   8) SETTINGS PANEL
   ===================================================================== */
$("#openSettings").addEventListener("click", openSettings);
$("#openMyProfile").addEventListener("click", openSettings);
$("#closeSettings").addEventListener("click", ()=> $("#settingsOverlay").classList.add("hidden"));

function openSettings(){
  $("#settingsOverlay").classList.remove("hidden");
  $("#settingsNameInput").value = currentUser.name;
  $("#settingsBioInput").value = currentUser.bio || "";
  $("#settingsIdText").textContent = currentUser.id;
  setAvatarNode($("#settingsAvatarPreview"), currentUser.name, currentUser.photoURL);
  renderLastSeenPrivacyUI();
  $("#readReceiptsToggle").checked = currentUser.readReceipts !== false;
}

$$(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    $$(".tab-btn").forEach(b=>b.classList.remove("active"));
    $$(".settings-pane").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active");
    $("#pane-"+btn.dataset.tab).classList.add("active");
  });
});

/* -- profile pane -- */
let pendingSettingsPhoto = null;
$("#settingsAvatarInput").addEventListener("change", async e=>{
  const file = e.target.files[0]; if(!file) return;
  pendingSettingsPhoto = await resizeImageFile(file);
  setAvatarNode($("#settingsAvatarPreview"), currentUser.name, pendingSettingsPhoto);
});
$("#settingsCopyId").addEventListener("click", ()=>{
  copyText(currentUser.id).then(()=> toast("تم نسخ الرقم التعريفي")).catch(()=> toast("تعذر نسخ الرقم، انسخه يدويًا", true));
});
$("#copyIdBtn").addEventListener("click", ()=>{
  copyText(currentUser.id).then(()=> toast("تم نسخ الرقم التعريفي")).catch(()=> toast("تعذر نسخ الرقم، انسخه يدويًا", true));
});
$("#saveProfileBtn").addEventListener("click", async ()=>{
  const name = $("#settingsNameInput").value.trim();
  const bio = $("#settingsBioInput").value.trim();
  const msg = $("#settingsProfileMsg");
  if(!name){ msg.textContent = "الاسم مطلوب"; return; }
  msg.textContent = "";
  const update = { name, bio };
  if(pendingSettingsPhoto) update.photoURL = pendingSettingsPhoto;
  try{
    await db.collection("users").doc(currentUser.uid).update(update);
    Object.assign(currentUser, update);
    $("#myName").textContent = currentUser.name;
    setAvatarNode($("#myAvatar"), currentUser.name, currentUser.photoURL);
    pendingSettingsPhoto = null;
    toast("تم حفظ التغييرات");
  }catch(err){ console.error(err); msg.textContent = "تعذر الحفظ، جرّب تاني"; }
});

/* -- appearance pane -- */
$$(".theme-opt[data-theme-choice]").forEach(btn=>{
  btn.addEventListener("click", ()=> applyTheme(btn.dataset.themeChoice));
});
$$(".theme-opt[data-layout-choice]").forEach(btn=>{
  btn.addEventListener("click", ()=> applyLayoutMode(btn.dataset.layoutChoice));
});
function buildColorGrid(){
  const grid = $("#colorGrid");
  grid.innerHTML = "";
  const current = localStorage.getItem(prefKey("accent")) || "#f2b134";
  ACCENTS.forEach(hex=>{
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch" + (hex===current ? " active" : "");
    sw.style.background = hex;
    sw.dataset.color = hex;
    sw.addEventListener("click", ()=> applyAccent(hex));
    grid.appendChild(sw);
  });
  $("#customColorInput").value = current;
  $("#customColorSwatch").style.background = current;
}
$("#customColorInput").addEventListener("input", (e)=>{
  const hex = e.target.value;
  $("#customColorSwatch").style.background = hex;
  applyAccent(hex);
});

/* -- wallpaper pane -- */
function buildWallpaperGrid(){
  const grid = $("#wallpaperGrid");
  grid.innerHTML = "";
  const current = localStorage.getItem(prefKey("wallpaper")) || "none";
  WALLPAPERS.forEach(w=>{
    const opt = document.createElement("div");
    opt.className = "wallpaper-opt" + (w.id===current ? " active" : "");
    opt.style.background = w.id==="none" ? "var(--input-bg)" : "var(--bg)";
    opt.style.backgroundImage = w.id==="none" ? "" : w.css;
    opt.style.backgroundSize = w.size || "auto";
    opt.style.color = "var(--chat-accent)";
    opt.title = w.id;
    opt.addEventListener("click", ()=>{
      applyWallpaper(w.id);
      $$(".wallpaper-opt").forEach(o=>o.classList.remove("active"));
      opt.classList.add("active");
    });
    grid.appendChild(opt);
  });
}
$("#wallpaperInput").addEventListener("change", async e=>{
  const file = e.target.files[0]; if(!file) return;
  const dataUrl = await resizeImageFile(file, 900, 0.75);
  applyWallpaper(dataUrl);
  $$(".wallpaper-opt").forEach(o=>o.classList.remove("active"));
  toast("تم ضبط الخلفية");
});

/* -- last-seen / online visibility privacy -- */
function renderLastSeenPrivacyUI(){
  const value = (currentUser && currentUser.lastSeenPrivacy) || "everyone";
  $$(".privacy-opt", $("#lastSeenPrivacyGroup")).forEach(b=>{
    b.classList.toggle("active", b.dataset.privacy === value);
  });
}
$$(".privacy-opt", $("#lastSeenPrivacyGroup")).forEach(btn=>{
  btn.addEventListener("click", async ()=>{
    const value = btn.dataset.privacy;
    if(!currentUser || currentUser.lastSeenPrivacy === value) return;
    currentUser.lastSeenPrivacy = value;
    renderLastSeenPrivacyUI();
    try{
      await db.collection("users").doc(currentUser.uid).set({ lastSeenPrivacy: value }, {merge:true});
      toast("تم الحفظ");
    }catch(err){ console.error(err); toast("تعذر الحفظ", true); }
  });
});

/* -- read receipts on/off (also gates the typing-status broadcast, see notifyTyping) -- */
$("#readReceiptsToggle").addEventListener("change", async e=>{
  const value = e.target.checked;
  if(!currentUser) return;
  const prev = currentUser.readReceipts;
  currentUser.readReceipts = value;
  if(!value) stopTypingNow();
  try{
    await db.collection("users").doc(currentUser.uid).set({ readReceipts: value }, {merge:true});
    toast(value ? "اتشغلت علامة القراءة والكتابة" : "اتقفلت علامة القراءة والكتابة");
  }catch(err){
    console.error(err);
    currentUser.readReceipts = prev;
    e.target.checked = prev !== false;
    toast("تعذر الحفظ", true);
  }
});

/* -- privacy pane handled above (blockId/unblockId) -- */

/* =====================================================================
   9) PASSWORD SHOW/HIDE TOGGLE (register + login)
   ===================================================================== */
$$(".password-toggle").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const target = document.getElementById(btn.dataset.target);
    if(!target) return;
    const showing = target.type === "text";
    target.type = showing ? "password" : "text";
    btn.classList.toggle("showing", !showing);
    target.focus();
  });
});

/* =====================================================================
   10) KEYBOARD-AWARE LAYOUT (phone/tablet)
   .app is position:fixed + inset:0, sized to the full window. On phones,
   opening the on-screen keyboard shrinks the *visual* viewport but not
   the window itself, so a fixed-height .app can end up with its bottom
   (where the composer lives) sitting behind the keyboard. Resizing .app
   to match window.visualViewport keeps the composer above the keyboard
   whenever the message box (or anything else) is focused.
   ===================================================================== */
if(window.visualViewport){
  const appEl = document.querySelector(".app");
  const syncViewportHeight = () => {
    if(!appEl) return;
    appEl.style.height = window.visualViewport.height + "px";
  };
  window.visualViewport.addEventListener("resize", syncViewportHeight);
  window.visualViewport.addEventListener("scroll", syncViewportHeight);
  syncViewportHeight();
}
