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

// Each page declares <body data-space="work|life|late">. Unknown/missing → stop, never touch data.
const SPACES = {
  work: { kind: "boards", boards: "boards",      tasks: "tasks" },
  life: { kind: "boards", boards: "life_boards", tasks: "life_tasks" },
  late: { kind: "late",   entries: "late" },
};
const SPACE = document.body.dataset.space;
const CFG = SPACES[SPACE];
if (!CFG) throw new Error("apps.js: page has no valid data-space");

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const isAdminUrl = () => location.hash === "#admin";
window.addEventListener("hashchange", () => renderWho());

let me = null;          // firebase user
let ownerMode = false;  // signed in with Google (rules verify it's really you)
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
const snapDocs = (s) => s.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));

// ---------- auth ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) { showErr(e); }
    return;
  }
  me = user;
  ownerMode = !user.isAnonymous;
  renderWho();
  if (!subscribed) { subscribed = true; CFG.kind === "late" ? Late.subscribe() : Boards.subscribe(); }
  render();
});

function renderWho() {
  const who = $("who");
  if (!who) return;
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

const render = () => (CFG.kind === "late" ? Late.render() : Boards.render());

// =====================================================================
// WORK / LIFE: counters and to-do lists
// =====================================================================
const Boards = (() => {
  const BOARDS = CFG.boards, TASKS = CFG.tasks;
  let boards = [], tasks = [];

  function subscribe() {
    onSnapshot(query(collection(db, BOARDS), orderBy("createdAt", "asc")),
      (s) => { boards = snapDocs(s); render(); }, showErr);
    onSnapshot(query(collection(db, TASKS), orderBy("createdAt", "asc")),
      (s) => { tasks = snapDocs(s); render(); }, showErr);
  }

  if (CFG.kind === "boards") {
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
  }

  async function deleteBoard(b) {
    if (!confirm(`Delete “${b.title}”?`)) return;
    try {
      const ts = await getDocs(query(collection(db, TASKS), where("boardId", "==", b.id)));
      await Promise.allSettled(ts.docs.map((d) => deleteDoc(d.ref)));
      await deleteDoc(doc(db, BOARDS, b.id));
    } catch (e) { showErr(e); }
  }

  function render() {
    const active = document.activeElement;
    const keep = active?.dataset?.board ? { id: active.dataset.board, v: active.value } : null;
    const grid = $("grid");
    grid.replaceChildren();
    if (!boards.length) {
      grid.append(el("div", { class: "empty" }, me ? "Nothing yet — add the first counter above." : "Loading…"));
    } else {
      for (const b of boards) grid.append(b.type === "counter" ? counterCard(b) : listCard(b));
    }
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
    if (canManage(b)) card.append(el("button", { class: "del", title: "Delete", onclick: () => deleteBoard(b) }, "×"));
    return card;
  }

  function counterCard(b) {
    const card = cardShell(b);
    const ref = doc(db, BOARDS, b.id);
    const row = el("div", { class: "row" },
      el("button", { class: "tick primary", onclick: () => updateDoc(ref, { count: increment(1) }).catch(showErr) }, "+1  tick"),
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
      ul.append(el("li", { class: (t.byOwner ? "to" : "tg") + (t.done ? " done" : "") },
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
        editable ? el("button", { class: "x", title: "Delete", onclick: () => deleteDoc(doc(db, TASKS, t.id)).catch(showErr) }, "×") : null,
      ));
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

  return { subscribe, render };
})();

// =====================================================================
// LATE: one big counter + total minutes + excuse log
// =====================================================================
const Late = (() => {
  const COL = CFG.entries;
  let entries = [];
  let loaded = false;

  function subscribe() {
    onSnapshot(query(collection(db, COL), orderBy("createdAt", "desc")),
      (s) => { entries = snapDocs(s); loaded = true; render(); }, showErr);
  }

  if (CFG.kind === "late") {
    $("lateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!me) { showErr(new Error("Not signed in yet, try again in a second.")); return; }
      const raw = $("minutes").value.trim();
      let minutes = null;
      if (raw !== "") {
        minutes = Math.round(Number(raw));
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
          showErr(new Error("Minutes must be between 1 and 1440 (or leave it empty).")); return;
        }
      }
      const comment = $("comment").value.trim().slice(0, 280);
      const btn = $("lateBtn");
      btn.disabled = true;
      try {
        await addDoc(collection(db, COL), { ...author(), minutes, comment });
        $("minutes").value = ""; $("comment").value = "";
      } catch (err) { showErr(err); }
      finally { btn.disabled = false; }
    });
  }

  const fmtTotal = (m) => {
    const h = Math.floor(m / 60), r = m % 60;
    return h ? `${h} h ${r} min` : `${r} min`;
  };
  const fmtDate = (ts) => {
    const d = ts?.toDate ? ts.toDate() : null;
    return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }) : "";
  };

  function render() {
    const total = entries.reduce((s, x) => s + (Number.isFinite(x.minutes) ? x.minutes : 0), 0);
    const unknown = entries.filter((x) => !Number.isFinite(x.minutes)).length;
    $("count").textContent = loaded ? String(entries.length) : "…";
    $("countLabel").textContent = entries.length === 1 ? "time late" : "times late";
    $("total").textContent = fmtTotal(total);
    $("unknown").textContent = unknown ? ` (+ ${unknown} unknown)` : "";

    const log = $("log");
    log.replaceChildren();
    if (loaded && !entries.length) log.append(el("li", { class: "empty" }, "Clean record… for now."));
    for (const x of entries) {
      const li = el("li", { class: x.byOwner ? "o" : "g" },
        el("span", { class: "date" }, fmtDate(x.createdAt)),
        el("span", { class: "min" }, Number.isFinite(x.minutes) ? `${x.minutes} min` : "? min"),
        el("span", { class: "body" },
          x.comment ? el("span", { class: "cmt" }, `“${x.comment}”`) : null,
          el("span", { class: "by" }, `— ${x.byOwner ? OWNER_NAME : (x.name || "Anonymous")}`),
        ),
        canManage(x) ? el("button", {
          class: "x", title: "Delete",
          onclick: () => { if (confirm("Delete this entry?")) deleteDoc(doc(db, COL, x.id)).catch(showErr); },
        }, "×") : null,
      );
      log.append(li);
    }
  }

  return { subscribe, render };
})();
