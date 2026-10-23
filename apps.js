import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
  GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, getDocs, serverTimestamp, increment,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, OWNER_NAME } from "./config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

// Which page are we on? work keeps the original collections (existing data stays there).
// Each page declares <body data-space="work|life">. Unknown/missing → stop, never touch data.
const SPACES = {
  work: { boards: "boards",      tasks: "tasks" },
  life: { boards: "life_boards", tasks: "life_tasks" },
};
const SPACE = document.body.dataset.space;
if (!SPACES[SPACE]) throw new Error("apps.js: page has no valid data-space");
const BOARDS = SPACES[SPACE].boards;
const TASKS  = SPACES[SPACE].tasks;
document.body.dataset.collections = BOARDS; // visible in devtools, for sanity checks
const isAdminUrl = () => location.hash === "#admin";
window.addEventListener("hashchange", () => renderWho());

let me = null;          // firebase user
let ownerMode = false;  // signed in with Google (rules verify it's really you)
let boards = [];
let tasks = [];
let subscribed = false;

let nick = "";
try { nick = localStorage.getItem("tally-nick") || ""; } catch {}

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n) n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c);
  return n;
}
function showErr(e) {
  console.error(e);
  $("err").textContent = e?.code === "permission-denied"
    ? "Not allowed — that one isn't yours to change."
    : (e?.message || String(e));
  setTimeout(() => ($("err").textContent = ""), 8000);
}
const author = () => ({
  uid: me.uid,
  byOwner: ownerMode,
  name: ownerMode ? OWNER_NAME : (nick.trim().slice(0, 30) || "Anonymous"),
  createdAt: serverTimestamp(),
});
const canManage = (item) => ownerMode || (item.uid === me?.uid && !item.byOwner);

// ---------- auth ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { showErr(e); $("grid").replaceChildren(el("div", { class: "empty" }, "Sign-in failed: " + (e.code || e.message))); }
    return;
  }
  me = user;
  ownerMode = !user.isAnonymous;
  renderWho();
  subscribe();
  render();
});

function renderWho() {
  const who = $("who");
  who.replaceChildren();
  if (ownerMode) {
    who.append(
      el("span", { class: "badge" }, "You (owner)"),
      el("button", { class: "link", onclick: () => signOut(auth) }, "sign out"),
    );
  } else {
    const inp = el("input", {
      value: nick, placeholder: "your name", maxLength: 30,
      oninput: (e) => { nick = e.target.value; try { localStorage.setItem("tally-nick", nick); } catch {} },
    });
    who.append("You are", inp);
    if (isAdminUrl()) {
      who.append(el("button", {
        onclick: () => signInWithPopup(auth, new GoogleAuthProvider()).catch(showErr),
      }, "Owner sign-in"));
    }
  }
}

// ---------- data ----------
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  onSnapshot(query(collection(db, BOARDS), orderBy("createdAt", "asc")),
    (s) => { boards = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, showErr);
  onSnapshot(query(collection(db, TASKS), orderBy("createdAt", "asc")),
    (s) => { tasks = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); }, showErr);
}

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!me) { showErr(new Error("Not signed in yet — is Anonymous sign-in enabled in Firebase?")); return; }
  const title = $("newTitle").value.trim();
  if (!title) return;
  const type = $("newType").value;
  const data = { ...author(), type, title };
  if (type === "counter") data.count = 0;
  try { await addDoc(collection(db, BOARDS), data); $("newTitle").value = ""; }
  catch (err) { showErr(err); }
});

async function deleteBoard(b) {
  if (!confirm(`Delete “${b.title}”?`)) return;
  try {
    const ts = await getDocs(query(collection(db, TASKS), where("boardId", "==", b.id)));
    await Promise.allSettled(ts.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(doc(db, BOARDS, b.id));
  } catch (e) { showErr(e); }
}

// ---------- render ----------
function render() {
  // keep focus/draft of an add-task box across re-renders
  const active = document.activeElement;
  const keep = active?.dataset?.board ? { id: active.dataset.board, v: active.value } : null;

  const grid = $("grid");
  grid.replaceChildren();
  if (!boards.length) {
    grid.append(el("div", { class: "empty" }, me ? "Nothing yet — add the first counter above." : "Loading…"));
    return;
  }
  for (const b of boards) grid.append(b.type === "counter" ? counterCard(b) : listCard(b));

  if (keep) {
    const inp = grid.querySelector(`input[data-board="${keep.id}"]`);
    if (inp) { inp.value = keep.v; inp.focus(); }
  }
  $("foot").textContent = ownerMode
    ? "Owner mode: you can delete or undo anything."
    : "Anyone can add things and tick counters. You can delete only what you added.";
}

function cardShell(b) {
  const card = el("div", { class: "card " + (b.byOwner ? "owner" : "guest") },
    el("h2", {}, b.title),
    el("div", { class: "by" }, b.byOwner ? `by ${OWNER_NAME}` : `added by ${b.name || "Anonymous"}`),
  );
  if (canManage(b)) {
    card.append(el("button", { class: "del", title: "Delete", onclick: () => deleteBoard(b) }, "×"));
  }
  return card;
}

function counterCard(b) {
  const card = cardShell(b);
  const ref = doc(db, BOARDS, b.id);
  const row = el("div", { class: "row" },
    el("button", {
      class: "tick primary",
      onclick: () => updateDoc(ref, { count: increment(1) }).catch(showErr),
    }, "+1  tick"),
  );
  if (ownerMode) {
    row.append(el("button", {
      title: "Undo a tick", disabled: !(b.count > 0),
      onclick: () => updateDoc(ref, { count: increment(-1) }).catch(showErr),
    }, "−1"));
  }
  card.append(el("div", { class: "count" }, String(b.count ?? 0)), row);
  return card;
}

function listCard(b) {
  const card = cardShell(b);
  const ul = el("ul");
  for (const t of tasks.filter((t) => t.boardId === b.id)) {
    const editable = canManage(t);
    const li = el("li", { class: (t.byOwner ? "to" : "tg") + (t.done ? " done" : "") },
      el("label", {},
        el("input", {
          type: "checkbox", checked: !!t.done, disabled: !editable,
          onchange: (e) => updateDoc(doc(db, TASKS, t.id), { done: e.target.checked }).catch(showErr),
        }),
        el("span", {},
          el("span", { class: "t" }, t.text),
          t.byOwner ? null : el("span", { class: "mini" }, `  — ${t.name || "Anonymous"}`),
        ),
      ),
      editable ? el("button", {
        class: "x", title: "Delete",
        onclick: () => deleteDoc(doc(db, TASKS, t.id)).catch(showErr),
      }, "×") : null,
    );
    ul.append(li);
  }
  const input = el("input", { placeholder: "add a task…", maxLength: 280 });
  input.dataset.board = b.id;
  const form = el("form", {
    class: "addtask",
    onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !me) return;
      input.value = "";
      try { await addDoc(collection(db, TASKS), { ...author(), boardId: b.id, text, done: false }); }
      catch (err) { input.value = text; showErr(err); }
    },
  }, input, el("button", {}, "Add"));
  card.append(ul, form);
  return card;
}
