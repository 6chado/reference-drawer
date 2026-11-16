/* Reference Drawer storage on the signed-in person's own Google Drive.
   Provides the same small API the page already uses (claude.use("db" | "assets" | "user")),
   so the rest of the site works unchanged. Pictures live as files in a "레퍼런스 서랍" folder,
   tags/links/drawers live in one data.json file in that folder. */
(() => {
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const API = "https://www.googleapis.com/drive/v3", UP = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER = "레퍼런스 서랍";

  /* ---------- sign-in ---------- */
  let tok = "", exp = 0, tokenClient = null, waiters = [];
  try { const t = JSON.parse(localStorage.getItem("rd_tok") || "null"); if (t && t.exp > Date.now() + 60000){ tok = t.token; exp = t.exp; } } catch {}
  const valid = () => tok && Date.now() < exp;
  const pushToSW = () => { try { navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type:"token", token:tok }); } catch {} };

  const loadGIS = () => new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.oauth2) return res();
    const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error("gis")); document.head.appendChild(s);
  });
  async function client(){
    await loadGIS();
    if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: window.GOOGLE_CLIENT_ID, scope: SCOPE,
      callback: r => {
        if (r && r.access_token){
          tok = r.access_token; exp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
          try { localStorage.setItem("rd_tok", JSON.stringify({ token:tok, exp })); } catch {}
          pushToSW(); waiters.splice(0).forEach(w => w.res());
        } else waiters.splice(0).forEach(w => w.rej(r));
      },
      error_callback: e => waiters.splice(0).forEach(w => w.rej(e))
    });
    return tokenClient;
  }

  /* login screen (first visit, or when the 1-hour sign-in runs out) */
  let gate = null;
  function showGate(again){
    if (gate) return gate.p;
    const el = document.createElement("div");
    el.id = "rdGate";
    el.innerHTML = `<div class="rd-card">
      <div class="rd-t">${again ? "다시 로그인해 주세요" : "레퍼런스 서랍"}</div>
      <p>${again ? "로그인 시간이 지났어요. 버튼을 누르면 하던 작업이 이어져요." : "그림과 링크는 내 구글 드라이브의 '레퍼런스 서랍' 폴더에 저장돼요. 다른 사람은 볼 수 없어요."}</p>
      <button type="button" class="rd-btn">구글로 로그인</button>
      <p class="rd-err" hidden></p></div>`;
    document.body.appendChild(el);
    const btn = el.querySelector(".rd-btn"), err = el.querySelector(".rd-err");
    let resolve; const p = new Promise(r => resolve = r);
    btn.onclick = async () => {
      err.hidden = true; btn.disabled = true;
      try {
        const c = await client();
        await new Promise((res, rej) => { waiters.push({ res, rej }); c.requestAccessToken({ prompt: again ? "" : "" }); });
        el.remove(); gate = null; resolve();
      } catch (e) {
        err.textContent = "로그인하지 못했어요. 팝업이 막혀 있지 않은지 확인하고 다시 눌러 주세요."; err.hidden = false;
      }
      btn.disabled = false;
    };
    gate = { p };
    return p;
  }
  const style = document.createElement("style");
  style.textContent = `#rdGate{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:color-mix(in srgb,var(--bg,#f3efe7) 92%,transparent);padding:24px}
  #rdGate .rd-card{max-width:360px;width:100%;background:var(--surface,#fff);border:1px solid var(--line,#ddd);border-radius:16px;padding:24px;text-align:center;color:var(--ink,#222)}
  #rdGate .rd-t{font-size:20px;font-weight:600;margin-bottom:8px}#rdGate p{font-size:14px;line-height:1.6;color:var(--muted,#666);margin:0 0 16px}
  #rdGate .rd-btn{height:44px;padding:0 20px;border-radius:10px;border:0;background:var(--accent,#c4502a);color:var(--accent-ink,#fff);font:inherit;font-weight:600;cursor:pointer}
  #rdGate .rd-err{color:#c0392b!important;margin:12px 0 0!important}`;
  document.head.appendChild(style);

  async function api(url, opt = {}, retry = true){
    if (!valid()) await showGate(!!tok);
    const r = await fetch(url, { ...opt, headers:{ ...(opt.headers || {}), Authorization:"Bearer " + tok } });
    if (r.status === 401 && retry){ tok = ""; await showGate(true); return api(url, opt, false); }
    if (!r.ok) throw new Error("drive " + r.status);
    return r;
  }
  const multipart = (meta, blob) => {
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify(meta)], { type:"application/json" }));
    fd.append("file", blob);
    return api(`${UP}/files?uploadType=multipart&fields=id,size,modifiedTime`, { method:"POST", body:fd }).then(r => r.json());
  };

  /* ---------- data.json ---------- */
  let folderId = "", dataId = "", docs = {}, lastMod = "", dirty = false, saving = null, saveT = 0;
  async function find(q){ const r = await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,modifiedTime)&spaces=drive&pageSize=1`).then(r => r.json()); return r.files && r.files[0]; }
  async function bootDrive(){
    let f = await find(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    if (!f) f = await api(`${API}/files?fields=id`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ name:FOLDER, mimeType:"application/vnd.google-apps.folder" }) }).then(r => r.json());
    folderId = f.id;
    const d = await find(`name='data.json' and '${folderId}' in parents and trashed=false`);
    if (d){ dataId = d.id; lastMod = d.modifiedTime; docs = await api(`${API}/files/${dataId}?alt=media`).then(r => r.json()).catch(() => ({})); }
  }
  async function flush(){
    if (saving) { await saving; if (!dirty) return; }
    dirty = false;
    const body = new Blob([JSON.stringify(docs)], { type:"application/json" });
    saving = (async () => {
      if (!dataId){ const r = await multipart({ name:"data.json", parents:[folderId] }, body); dataId = r.id; lastMod = r.modifiedTime; }
      else { const r = await api(`${UP}/files/${dataId}?uploadType=media&fields=modifiedTime`, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body }).then(r => r.json()); lastMod = r.modifiedTime; }
    })().catch(e => { dirty = true; console.warn(e); }).finally(() => { saving = null; });
    await saving;
  }
  const scheduleSave = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(flush, 700); };
  addEventListener("beforeunload", e => { if (dirty || saving){ flush(); e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden){ if (dirty) flush(); return; }
    if (!dataId || dirty || saving || !valid()) return;
    try {   // pick up changes made on another device
      const m = await api(`${API}/files/${dataId}?fields=modifiedTime`).then(r => r.json());
      if (m.modifiedTime !== lastMod){ docs = await api(`${API}/files/${dataId}?alt=media`).then(r => r.json()); lastMod = m.modifiedTime; emit(); }
    } catch {}
  });

  /* ---------- the db / assets / user the page asks for ---------- */
  let listeners = [], emitT = 0;
  const snap = p => ({ metadata:{ fromCache:false }, docs: Object.keys(docs).filter(k => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map(k => ({ id:k.slice(p.length + 1), data:() => docs[k] })) });
  function emit(){ clearTimeout(emitT); emitT = setTimeout(() => listeners.forEach(l => l.fn(snap(l.p))), 0); }
  const changed = () => { emit(); scheduleSave(); };
  const copy = o => JSON.parse(JSON.stringify(o));
  const db = {
    doc: p => ({
      set: async d => { docs[p] = copy(d); changed(); },
      update: async d => { if (!docs[p]) throw Object.assign(new Error("not-found"), { code:"not-found" }); docs[p] = { ...docs[p], ...copy(d) }; changed(); },
      delete: async () => { delete docs[p]; changed(); },
      get: async () => ({ exists: !!docs[p], data: () => docs[p] })
    }),
    collection: p => ({
      doc: id => db.doc(p + "/" + id),
      onSnapshot(fn){ const l = { p, fn }; listeners.push(l); setTimeout(() => fn(snap(p)), 0); return () => { listeners = listeners.filter(x => x !== l); }; }
    })
  };
  const assets = {
    upload: async blob => {
      const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const r = await multipart({ name:`img_${Date.now()}.${ext}`, parents:[folderId] }, blob);
      return { id:r.id, url:"_blob/" + r.id, sizeBytes:Number(r.size || blob.size), contentType:blob.type };
    },
    delete: id => api(`${API}/files/${id}`, { method:"DELETE" }).catch(() => {}),
    list: async () => {
      const q = await api(`${API}/about?fields=storageQuota`).then(r => r.json());
      return { assets:[], usage:{ bytes:Number(q.storageQuota.usage || 0), maxBytes:Number(q.storageQuota.limit || 0) } };
    }
  };
  const user = { id: async () => "me", isOwner: async () => false, canEdit: () => true, can: () => true };

  /* ---------- start ---------- */
  async function serviceWorker(){
    if (!("serviceWorker" in navigator)) return;
    await navigator.serviceWorker.register("sw.js");
    if (!navigator.serviceWorker.controller){
      await Promise.race([new Promise(r => navigator.serviceWorker.addEventListener("controllerchange", r, { once:true })), new Promise(r => setTimeout(r, 4000))]);
      if (!navigator.serviceWorker.controller){ location.reload(); return new Promise(() => {}); }
    }
    navigator.serviceWorker.addEventListener("controllerchange", pushToSW);
  }
  const ready = (async () => {
    if (!window.GOOGLE_CLIENT_ID || /여기에/.test(window.GOOGLE_CLIENT_ID)) throw new Error("config.js에 구글 클라이언트 ID를 넣어 주세요");
    await new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r, { once:true }) : r());
    await serviceWorker();
    if (!valid()) await showGate(false);
    pushToSW();
    await bootDrive();
  })();
  ready.catch(e => { console.error(e); const s = document.getElementById("status"); if (s){ s.hidden = false; s.textContent = "시작하지 못했어요: " + (e.message || e); } });

  window.claude = { use: async n => {
    try { await ready; } catch { return null; }
    return n === "db" ? db : n === "assets" ? assets : n === "user" ? user : null;
  } };
})();
