/* 분석 스크랩북 — SQL 실행 결과를 «스냅샷»으로 이 브라우저(IndexedDB)에 보관한다.
 *
 * 연결 지점은 하나: app.js 가 실행에 성공할 때마다 보내는 "msl:result" 이벤트. 실패한 실행은 이벤트가 없으므로 저장할 수 없다.
 * 저장하는 숫자는 저장 순간의 결과 그대로다. 데이터가 바뀌어도 스크랩의 숫자는 바뀌지 않는다(다시 실행한 결과는 따로 표시).
 * 기간·분모 같은 계산 기준은 SQL 글자를 보고 추측하지 않는다 — 준비한 질문(questions.json)에 적힌 값만 채우고 나머지는 사람이 쓴다.
 *
 * 레코드 구조 (schema 1)
 *   { schema, id, title, category, metric: {name, value, cell: {row, col, raw} | null}, target, period, basis,
 *     memo: {meaning, emphasis, followup}, tags: [], favorite, createdAt, updatedAt,
 *     sql, source: {kind: "ask"|"preset", id, no, title}, dataset: {label, coverage, tables, mine},
 *     result: {fields, rows, rowCount, savedRows, truncated},
 *     ai: null }   ← 2차(Gemini 인사이트) 자리. AI 문장은 여기에만 두고 SQL 계산값(result·metric)과 섞지 않는다
 */
const CATEGORIES = [   // 늘릴 때는 여기에 {id, label} 을 더한다. id 는 저장·백업 파일에 쓰이므로 바꾸지 않는다
  { id: "revenue", label: "매출·수익" },
  { id: "ads", label: "광고 성과" },
  { id: "funnel", label: "전환 퍼널" },
  { id: "customer", label: "고객 분석" },
  { id: "hospital", label: "병원별 비교" },
];
const DB_NAME = "msl-scrapbook", STORE = "scraps", DB_VER = 1, SCHEMA = 1;
const MAX_ROWS = 500;            // 스크랩 1건에 저장하는 최대 행
const MAX_CELL = 500;            // 글자 칸 최대 길이
const MAX_BYTES = 1500000;       // 스크랩 1건 결과의 대략적 최대 크기 (JSON 글자 수)
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const DATASET_LABEL = "병의원 마케팅 합성 데이터 (parquet 6개 표)";

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const catLabel = id => (CATEGORIES.find(c => c.id === id) || { label: "기타" }).label;
const norm = s => String(s || "").replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
const pad = n => String(n).padStart(2, "0");
const when = iso => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtCell = v => typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("ko-KR") : String(v)) : v == null ? "" : String(v);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

const SB = { items: [], ready: false, cat: "", q: "", sort: "new", favOnly: false, form: null, reload: null, importPlan: null };

// ── 저장소 (IndexedDB) ──────────────────────────────────
let dbp = null;
function openDB() {
  if (!dbp) {
    dbp = new Promise((ok, no) => {
      let r;
      try { r = indexedDB.open(DB_NAME, DB_VER); } catch (e) { return no(e); }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" }); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
      r.onblocked = () => no(new Error("저장소가 다른 창에서 사용 중입니다"));
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((ok, no) => {
    let t, req;
    try { t = db.transaction(STORE, mode); req = fn(t.objectStore(STORE)); } catch (e) { try { t && t.abort(); } catch (_) { /* 무시 */ } return no(e); }
    t.oncomplete = () => ok(req ? req.result : undefined);
    t.onerror = () => no(t.error);
    t.onabort = () => no(t.error || new Error("저장이 취소되었습니다"));
  });
}
const dbAll = () => tx("readonly", st => st.getAll());
const dbPut = rec => tx("readwrite", st => { st.put(rec); });
const dbPutMany = recs => tx("readwrite", st => { recs.forEach(r => st.put(r)); });
const dbDel = id => tx("readwrite", st => { st.delete(id); });
function storeError(e) {
  const name = (e && e.name) || "";
  if (name === "QuotaExceededError" || /quota/i.test(String(e && e.message)))
    return "브라우저 저장 공간이 부족해 저장하지 못했습니다. 필요 없는 스크랩을 지우거나 JSON으로 백업한 뒤 정리하세요.";
  return `저장소(IndexedDB)를 쓸 수 없어 처리하지 못했습니다${name ? ` (${name})` : ""}. 사생활 보호 모드이거나 브라우저가 사이트 데이터를 막고 있을 수 있습니다.`;
}

async function loadAll() {
  try {
    SB.items = await dbAll();
    SB.ready = true;
    $("#sb-store-msg").hidden = true;
  } catch (e) {
    SB.ready = false;
    $("#sb-store-msg").hidden = false;
    $("#sb-store-msg").textContent = "스크랩북 저장소를 열 수 없습니다 — " + storeError(e);
  }
  renderList();
}

// ── 결과 스냅샷 ─────────────────────────────────────────
function cell(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + "…" : s;
}
function snapshot(fields, rows) {
  let keep = Math.min(rows.length, MAX_ROWS);
  let out = rows.slice(0, keep).map(r => Object.fromEntries(fields.map(f => [f, cell(r[f])])));
  while (keep > 20 && JSON.stringify(out).length > MAX_BYTES) { keep = Math.floor(keep / 2); out = out.slice(0, keep); }
  return { fields: fields.slice(), rows: out, rowCount: rows.length, savedRows: out.length, truncated: out.length < rows.length };
}

// ── «결과 스크랩» 버튼 — 실행 성공 결과에만 붙는다 ───────────
document.addEventListener("msl:result", e => {
  const d = e.detail;
  const head = d.target.querySelector(".res-head");
  if (!head) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "sb-scrap-btn"; b.textContent = "결과 스크랩";
  b.addEventListener("click", () => openForm({ mode: "new", d }));
  head.appendChild(b);
  // 스크랩에서 불러온 SQL 을 사람이 실행한 경우 — 새 결과임을 밝히고 저장 결과와 비교
  if (SB.reload && d.source.kind === "ask" && norm(d.sql) === norm(SB.reload.sql)) {
    const r = SB.reload, now = snapshot(d.fields, d.rows);
    const sameCols = JSON.stringify(now.fields) === JSON.stringify(r.result.fields);
    const n = Math.min(r.result.savedRows, now.rows.length);
    const same = sameCols && now.rowCount === r.result.rowCount && JSON.stringify(now.rows.slice(0, n)) === JSON.stringify(r.result.rows.slice(0, n));
    const note = document.createElement("div");
    note.className = "sb-rerun";
    note.innerHTML = `<b>새로 실행한 결과</b>입니다 — 스크랩 «${esc(r.title)}»에 저장된 결과(${esc(when(r.createdAt))} 저장, ${r.result.rowCount.toLocaleString("ko-KR")}행)와 별개입니다.`
      + ` <span class="${same ? "same" : "diff"}">${same ? "저장된 결과와 같습니다" : `저장된 결과와 다릅니다 (행 수 ${r.result.rowCount.toLocaleString("ko-KR")} → ${now.rowCount.toLocaleString("ko-KR")}${sameCols ? "" : " · 열 구성 다름"})`}</span>`;
    d.target.prepend(note);
  }
});

// ── 저장·수정 폼 ────────────────────────────────────────
function fillCats(sel, value) {
  sel.innerHTML = `<option value="">카테고리 선택</option>` + CATEGORIES.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("");
  sel.value = CATEGORIES.some(c => c.id === value) ? value : "";
}
function pickTable(result, chosen) {
  if (!result.rows.length) return `<p class="fine">결과가 0행이라 고를 숫자가 없습니다. 핵심 결과값은 직접 입력하거나 비워 두세요.</p>`;
  const rows = result.rows.slice(0, 10);
  return `<p class="fine">핵심 결과값 고르기 — 숫자 칸을 누르면 채워집니다 (처음 ${rows.length}행 표시)</p>`
    + `<div class="res"><table><thead><tr>${result.fields.map(f => `<th>${esc(f)}</th>`).join("")}</tr></thead><tbody>`
    + rows.map((r, i) => `<tr>${result.fields.map(f => typeof r[f] === "number"
      ? `<td class="n"><button type="button" class="sb-cell${chosen && chosen.row === i && chosen.col === f ? " on" : ""}" data-row="${i}" data-col="${esc(f)}">${esc(fmtCell(r[f]))}</button></td>`
      : `<td>${esc(fmtCell(r[f]))}</td>`).join("")}</tr>`).join("") + `</tbody></table></div>`;
}
function openForm(ctx) {
  const f = $("#sb-form");
  const isNew = ctx.mode === "new";
  const rec = isNew ? null : ctx.rec;
  const result = isNew ? snapshot(ctx.d.fields, ctx.d.rows) : rec.result;
  SB.form = { ...ctx, result, cell: rec ? rec.metric.cell : null };
  $("#sb-form-title").textContent = isNew ? "결과 스크랩" : "스크랩 수정";
  const src = isNew ? ctx.d.source : rec.source;
  const basis = isNew && src.kind === "preset" ? [src.unit && `단위: ${src.unit}`, src.denominator && `분모: ${src.denominator}`].filter(Boolean).join(" · ") : "";
  $("#sb-f-title").value = rec ? rec.title : (src.kind === "preset" ? `${src.no || ""} ${src.title || ""}`.trim() : "");
  fillCats($("#sb-f-cat"), rec ? rec.category : "");
  $("#sb-f-metric").value = rec ? rec.metric.name : "";
  $("#sb-f-value").value = rec ? rec.metric.value : "";
  $("#sb-f-target").value = rec ? rec.target : "";
  $("#sb-f-period").value = rec ? rec.period : "";
  $("#sb-f-basis").value = rec ? rec.basis : basis;
  $("#sb-f-memo").value = rec ? rec.memo.meaning : "";
  $("#sb-f-emph").value = rec ? rec.memo.emphasis : "";
  $("#sb-f-follow").value = rec ? rec.memo.followup : "";
  $("#sb-f-tags").value = rec ? rec.tags.join(", ") : "";
  $("#sb-f-pick").innerHTML = pickTable(result, SB.form.cell);
  // 안내 — 0행 · 잘림 · 중복 SQL
  const warn = [];
  if (isNew) {
    if (!result.rowCount) warn.push("결과가 <b>0행</b>입니다. 저장하면 «결과 없음»이 그대로 기록됩니다. 그래도 저장하려면 «0행 결과로 저장»을 누르세요.");
    if (result.truncated) warn.push(`결과 ${result.rowCount.toLocaleString("ko-KR")}행 중 <b>처음 ${result.savedRows.toLocaleString("ko-KR")}행만</b> 저장합니다 (브라우저 저장 용량 보호). 전체 결과는 SQL을 다시 실행해 확인하세요.`);
    const dup = SB.items.filter(x => norm(x.sql) === norm(ctx.d.sql));
    if (dup.length) warn.push(`같은 SQL로 저장한 스크랩이 <b>${dup.length}건</b> 있습니다: ${dup.slice(0, 3).map(x => `«${esc(x.title)}»`).join(", ")}${dup.length > 3 ? " 외" : ""}. 별도 분석으로 저장하려면 그대로 저장하세요.`);
  }
  $("#sb-form-warn").innerHTML = warn.map(w => `<span>${w}</span>`).join("");
  $("#sb-form-warn").hidden = !warn.length;
  const ds = isNew ? datasetOf(ctx.d) : rec.dataset;
  $("#sb-f-auto").textContent = isNew
    ? `자동 저장: SQL 원문 · 결과 ${result.rowCount.toLocaleString("ko-KR")}행 × ${result.fields.length}열 스냅샷 · 사용 표 ${ds.tables.join(", ") || "-"} · ${datasetText(ds)} · 저장 시각`
    : "SQL 원문과 저장된 결과(스냅샷)는 수정되지 않습니다. 제목·카테고리·메모 등만 바뀝니다.";
  $("#sb-f-save").textContent = isNew && !result.rowCount ? "0행 결과로 저장" : "저장";
  $("#sb-f-save").disabled = false;
  $("#sb-form-err").hidden = true;
  f.showModal();
  $("#sb-f-title").focus();
}
function datasetOf(d) {
  return { label: DATASET_LABEL, coverage: d.coverage, tables: d.tables, mine: d.mine || {} };
}
function datasetText(ds) {
  const mine = Object.entries(ds.mine || {});
  if (mine.length) return `데이터: 내 파일 (${mine.map(([t, f]) => `${t} ← ${f}`).join(", ")})`;
  return `데이터: ${ds.label}${ds.coverage ? ` · 데이터 범위 ${ds.coverage[0]} ~ ${ds.coverage[1]}` : ""}`;
}
$("#sb-f-pick").addEventListener("click", e => {
  const b = e.target.closest(".sb-cell");
  if (!b) return;
  const row = Number(b.dataset.row), col = b.dataset.col;
  const raw = SB.form.result.rows[row][col];
  SB.form.cell = { row, col, raw };
  $("#sb-f-value").value = fmtCell(raw);
  if (!$("#sb-f-metric").value.trim()) $("#sb-f-metric").value = col;
  $("#sb-f-pick").querySelectorAll(".sb-cell").forEach(x => x.classList.toggle("on", x === b));
});
$("#sb-f-value").addEventListener("input", () => {   // 직접 고치면 표에서 고른 칸과의 연결을 끊는다
  SB.form.cell = null;
  $("#sb-f-pick").querySelectorAll(".sb-cell.on").forEach(x => x.classList.remove("on"));
});
$("#sb-form-el").addEventListener("submit", async e => {
  e.preventDefault();
  const F = SB.form, err = $("#sb-form-err");
  const title = $("#sb-f-title").value.trim(), category = $("#sb-f-cat").value;
  const miss = [!title && "분석 제목", !category && "카테고리"].filter(Boolean);
  if (miss.length) {
    err.textContent = `필수 항목을 입력하세요: ${miss.join(", ")}`; err.hidden = false;
    (title ? $("#sb-f-cat") : $("#sb-f-title")).focus();
    return;
  }
  const now = new Date().toISOString();
  const base = F.mode === "new" ? {
    schema: SCHEMA, id: newId(), favorite: false, createdAt: now, sql: F.d.sql,
    source: { kind: F.d.source.kind, id: F.d.source.id || null, no: F.d.source.no || null, title: F.d.source.title || null },
    dataset: datasetOf(F.d), result: F.result, ai: null,
  } : F.rec;
  const rec = {
    ...base, title, category, updatedAt: now,
    metric: { name: $("#sb-f-metric").value.trim(), value: $("#sb-f-value").value.trim(), cell: F.cell },
    target: $("#sb-f-target").value.trim(), period: $("#sb-f-period").value.trim(), basis: $("#sb-f-basis").value.trim(),
    memo: { meaning: $("#sb-f-memo").value.trim(), emphasis: $("#sb-f-emph").value.trim(), followup: $("#sb-f-follow").value.trim() },
    tags: [...new Set($("#sb-f-tags").value.split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean))].slice(0, 20),
  };
  $("#sb-f-save").disabled = true;
  try {
    await dbPut(rec);
  } catch (ex) {
    err.textContent = storeError(ex); err.hidden = false;   // 실패하면 성공 안내를 띄우지 않는다
    $("#sb-f-save").disabled = false;
    return;
  }
  SB.items = SB.items.filter(x => x.id !== rec.id).concat(rec);
  $("#sb-form").close();
  renderList();
  if ($("#sb-detail").open && SB.detailId === rec.id) openDetail(rec.id);
  toast(F.mode === "new" ? "스크랩북에 저장했습니다" : "스크랩을 수정했습니다");
});

// ── 목록 ────────────────────────────────────────────────
function visible() {
  const q = SB.q.trim().toLowerCase();
  let list = SB.items.filter(x => (!SB.cat || x.category === SB.cat) && (!SB.favOnly || x.favorite)
    && (!q || [x.title, x.memo.meaning, x.memo.emphasis, x.memo.followup].join("\n").toLowerCase().includes(q)));
  const by = { new: (a, b) => b.createdAt.localeCompare(a.createdAt), old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, "ko") }[SB.sort];
  return list.sort(by);
}
function renderList() {
  $("#sb-count").textContent = `${SB.items.length.toLocaleString("ko-KR")}건`;
  const n = id => SB.items.filter(x => x.category === id).length;
  $("#sb-cats").innerHTML = [`<button role="tab" data-cat="" aria-selected="${!SB.cat}">전체 ${SB.items.length}</button>`]
    .concat(CATEGORIES.map(c => `<button role="tab" data-cat="${esc(c.id)}" aria-selected="${SB.cat === c.id}">${esc(c.label)} ${n(c.id)}</button>`)).join("");
  const list = visible();
  if (!SB.items.length) {
    $("#sb-list").innerHTML = `<div class="card sb-empty"><b>아직 저장한 스크랩이 없습니다</b>
      <p class="sub">«직접 묻기»나 «준비한 질문»에서 SQL을 실행한 뒤, 결과 위의 «결과 스크랩»을 누르면 여기에 모입니다.</p>
      <div class="row"><button type="button" class="ghost" data-go="ask">직접 묻기로 가기</button><button type="button" class="ghost" data-go="preset">준비한 질문으로 가기</button></div></div>`;
    return;
  }
  if (!list.length) { $("#sb-list").innerHTML = `<div class="card sb-empty"><b>조건에 맞는 스크랩이 없습니다</b><p class="sub">검색어·카테고리·즐겨찾기 조건을 바꿔 보세요.</p></div>`; return; }
  $("#sb-list").innerHTML = list.map(x => {
    const memo = x.memo.meaning || x.memo.emphasis || x.memo.followup;
    return `<article class="sb-card" data-id="${esc(x.id)}">
      <div class="sb-card-top"><span class="sb-cat">${esc(catLabel(x.category))}</span>
        <button type="button" class="sb-star${x.favorite ? " on" : ""}" data-act="fav" aria-pressed="${x.favorite}" aria-label="즐겨찾기" title="즐겨찾기">${x.favorite ? "★" : "☆"}</button></div>
      <h4><button type="button" class="sb-open" data-act="detail">${esc(x.title)}</button></h4>
      ${x.metric.value || x.metric.name ? `<div class="sb-metric"><span>${esc(x.metric.name || "핵심 결과값")}</span><b>${esc(x.metric.value || "-")}</b></div>`
        : `<div class="sb-metric none"><span>핵심 결과값 없음</span></div>`}
      ${memo ? `<p class="sb-memo">${esc(memo)}</p>` : ""}
      ${x.tags.length ? `<div class="sb-tags">${x.tags.map(t => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="sb-meta">저장 ${esc(when(x.createdAt))} · 결과 ${x.result.rowCount.toLocaleString("ko-KR")}행${x.target ? ` · ${esc(x.target)}` : ""}</div>
      <div class="sb-actions">
        <button type="button" class="btn-icon" data-act="detail">상세</button>
        <button type="button" class="btn-icon" data-act="edit">수정</button>
        <button type="button" class="btn-icon" data-act="copy">보고용 복사</button>
        <button type="button" class="btn-icon" data-act="rerun">SQL 다시 실행</button>
        <button type="button" class="btn-icon danger" data-act="del">삭제</button>
      </div></article>`;
  }).join("");
}
$("#sb-cats").addEventListener("click", e => { const b = e.target.closest("[data-cat]"); if (b) { SB.cat = b.dataset.cat; renderList(); } });
$("#sb-search").addEventListener("input", e => { SB.q = e.target.value; renderList(); });
$("#sb-sort").addEventListener("change", e => { SB.sort = e.target.value; renderList(); });
$("#sb-fav-only").addEventListener("change", e => { SB.favOnly = e.target.checked; renderList(); });
$("#sb-list").addEventListener("click", e => {
  const go = e.target.closest("[data-go]");
  if (go) { document.querySelector(`.tabs [data-tab="${go.dataset.go}"]`).click(); return; }
  const b = e.target.closest("[data-act]"), card = e.target.closest(".sb-card");
  if (b && card) act(b.dataset.act, card.dataset.id);
});
async function act(what, id) {
  const rec = SB.items.find(x => x.id === id);
  if (!rec) return;
  if (what === "detail") return openDetail(id);
  if (what === "edit") return openForm({ mode: "edit", rec });
  if (what === "copy") return copyText(reportText(rec), "보고용 내용을 복사했습니다");
  if (what === "sqlcopy") return copyText(rec.sql, "SQL을 복사했습니다");
  if (what === "load") return toEditor(rec, false);
  if (what === "rerun") return toEditor(rec, true);
  if (what === "fav") {
    const next = { ...rec, favorite: !rec.favorite };
    try { await dbPut(next); } catch (ex) { return toast(storeError(ex), true); }
    SB.items = SB.items.map(x => x.id === id ? next : x);
    renderList();
    if ($("#sb-detail").open && SB.detailId === id) openDetail(id);
    return;
  }
  if (what === "del") {
    if (!confirm(`스크랩 «${rec.title}»을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try { await dbDel(id); } catch (ex) { return toast(storeError(ex), true); }
    SB.items = SB.items.filter(x => x.id !== id);
    if ($("#sb-detail").open && SB.detailId === id) $("#sb-detail").close();
    renderList();
    toast("스크랩을 삭제했습니다");
  }
}

// ── 상세 ────────────────────────────────────────────────
function openDetail(id) {
  const x = SB.items.find(r => r.id === id);
  if (!x) return;
  SB.detailId = id;
  const r = x.result;
  const kv = (k, v) => v ? `<div><span>${k}</span><b>${esc(v)}</b></div>` : "";
  const memo = (k, v) => `<div class="sb-memo-item"><span class="cap">${k}</span><p>${v ? esc(v) : `<span class="muted">비어 있음</span>`}</p></div>`;
  $("#sb-d-title").textContent = x.title;
  $("#sb-d-body").innerHTML = `
    <div class="sb-d-actions" data-id="${esc(x.id)}">
      <button type="button" class="primary" data-act="copy">보고용 복사</button>
      <button type="button" class="ghost" data-act="edit">수정</button>
      <button type="button" class="ghost" data-act="fav">${x.favorite ? "★ 즐겨찾기 해제" : "☆ 즐겨찾기"}</button>
      <button type="button" class="ghost danger" data-act="del">삭제</button>
    </div>
    <section class="sb-sec"><h5>A. 핵심 분석 결과</h5>
      <div class="sb-kv">${kv("카테고리", catLabel(x.category))}${kv("핵심 지표", x.metric.name)}${kv("핵심 결과값", x.metric.value)}
        ${kv("분석 대상", x.target)}${kv("분석 기간", x.period)}${kv("계산 기준·분모", x.basis)}${kv("저장", when(x.createdAt))}
        ${x.updatedAt !== x.createdAt ? kv("마지막 수정", when(x.updatedAt)) : ""}${kv("출처", x.source.kind === "preset" ? `준비한 질문 ${x.source.no || ""}` : "직접 묻기")}</div>
      ${x.metric.cell ? `<p class="fine">핵심 결과값은 저장된 결과 ${x.metric.cell.row + 1}행 «${esc(x.metric.cell.col)}» 칸의 값입니다.</p>` : x.metric.value ? `<p class="fine">핵심 결과값은 사용자가 직접 입력한 값입니다.</p>` : ""}
      ${x.tags.length ? `<div class="sb-tags">${x.tags.map(t => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
    </section>
    <section class="sb-sec"><h5>B. 보고용 메모</h5>
      ${memo("분석 결과의 의미", x.memo.meaning)}${memo("보고 시 강조할 내용", x.memo.emphasis)}${memo("추가 확인이 필요한 사항", x.memo.followup)}
    </section>
    <section class="sb-sec"><h5>C. SQL 원문 <span class="muted">(저장 당시 실행한 SQL)</span></h5>
      <div class="console"><pre class="sql">${esc(x.sql)}</pre>
        <div class="console-actions" data-id="${esc(x.id)}"><button type="button" class="primary" data-act="rerun">SQL 다시 실행</button>
          <button type="button" class="ghost" data-act="load">편집기로 불러오기</button><button type="button" class="ghost" data-act="sqlcopy">SQL 복사</button></div></div>
    </section>
    <section class="sb-sec"><h5>D. 저장된 결과 테이블 <span class="muted">(${esc(when(x.createdAt))} 실행 당시 스냅샷)</span></h5>
      <div class="res-head"><span>저장된 결과 <b>${r.rowCount.toLocaleString("ko-KR")}행</b> · ${r.fields.length}열</span>
        <span class="ms">${r.truncated ? `전체 ${r.rowCount.toLocaleString("ko-KR")}행 중 처음 ${r.savedRows.toLocaleString("ko-KR")}행 저장` : "전체 저장"}</span></div>
      ${r.rows.length ? `<div class="res sb-dtable"><table><thead><tr>${r.fields.map(f => `<th>${esc(f)}</th>`).join("")}</tr></thead><tbody>`
        + r.rows.map((row, i) => `<tr>${r.fields.map(f => `<td class="${typeof row[f] === "number" ? "n" : ""}${x.metric.cell && x.metric.cell.row === i && x.metric.cell.col === f ? " sb-hit" : ""}">${esc(fmtCell(row[f]))}</td>`).join("")}</tr>`).join("")
        + `</tbody></table></div>` : `<p class="fine">저장 당시 결과가 0행이었습니다. 열: ${r.fields.map(esc).join(", ") || "-"}</p>`}
      <p class="fine">${esc(datasetText(x.dataset))} · 사용 표 ${esc((x.dataset.tables || []).join(", ") || "-")}. 데이터가 바뀌어도 위 숫자는 바뀌지 않습니다.</p>
    </section>`;
  if (!$("#sb-detail").open) $("#sb-detail").showModal();
}
$("#sb-d-body").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"), box = e.target.closest("[data-id]");
  if (b && box) act(b.dataset.act, box.dataset.id);
});

// ── 편집기로 불러오기 · 다시 실행 ─────────────────────────
function toEditor(rec, runNow) {
  const ed = $("#sql"), cur = ed.value.trim();
  if (cur && norm(cur) !== norm(rec.sql) && !confirm("SQL 편집기에 작성 중인 SQL이 있습니다. 스크랩의 SQL로 덮어쓸까요?")) return;
  ed.value = rec.sql;
  SB.reload = rec;
  if ($("#sb-detail").open) $("#sb-detail").close();
  document.querySelector('.tabs [data-tab="ask"]').click();
  $("#ask-out").innerHTML = `<div class="sb-rerun">스크랩 «${esc(rec.title)}»의 SQL을 편집기에 불러왔습니다.`
    + (runNow ? " 지금 실행합니다." : " «SQL 실행»을 눌러야 실행됩니다.") + " 새로 실행한 결과는 저장된 결과와 구분해 표시합니다.</div>";
  if (runNow) $("#btn-run").click(); else ed.focus();
}

// ── 보고용 복사 ─────────────────────────────────────────
function reportText(x) {
  const line = (k, v) => v ? `- ${k}: ${v}` : null;
  return [`[${x.title}]`, "",
    line("분석 대상", x.target), line("분석 기간", x.period), line("핵심 지표", x.metric.name), line("분석 결과", x.metric.value),
    line("분석 내용", x.memo.meaning), line("강조할 내용", x.memo.emphasis), line("추가 확인", x.memo.followup),
    line("계산 기준·분모", x.basis),
    `- 근거: SQL 실행 결과 ${x.result.rowCount.toLocaleString("ko-KR")}행 (${when(x.createdAt)} 저장 스냅샷) · ${datasetText(x.dataset).replace(/^데이터: /, "")}`,
  ].filter(v => v !== null).join("\n");
}
async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const t = document.createElement("textarea");
      t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      const ok = document.execCommand("copy"); t.remove();
      if (!ok) throw new Error("copy");
    }
    toast(okMsg);
  } catch (e) { toast("복사하지 못했습니다 — 브라우저가 클립보드 접근을 막았습니다", true); }
}

// ── JSON 백업 ──────────────────────────────────────────
$("#sb-export").addEventListener("click", () => {
  if (!SB.items.length) return toast("내보낼 스크랩이 없습니다", true);
  const data = { app: "marketing-sql-lab", kind: "scrapbook", version: SCHEMA, exportedAt: new Date().toISOString(),
    count: SB.items.length, scraps: SB.items.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  const d = new Date();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  a.download = `marketing-sql-lab-scrapbook-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`스크랩 ${SB.items.length}건을 JSON으로 내보냈습니다`);
});

const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
function validRec(o) {   // 알려진 칸만 골라 새 레코드를 만든다. 형식이 틀리면 null
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (typeof o.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return null;
  const title = str(o.title, 120);
  if (!title || !CATEGORIES.some(c => c.id === o.category)) return null;
  if (typeof o.sql !== "string" || !o.sql.trim() || o.sql.length > 20000) return null;
  if (isNaN(Date.parse(o.createdAt))) return null;
  const r = o.result;
  if (!r || !Array.isArray(r.fields) || !r.fields.every(f => typeof f === "string") || r.fields.length > 300) return null;
  if (!Array.isArray(r.rows) || r.rows.length > MAX_ROWS) return null;
  const prim = v => v === null || ["string", "number", "boolean"].includes(typeof v);
  if (!r.rows.every(row => row && typeof row === "object" && !Array.isArray(row) && Object.values(row).every(prim))) return null;
  const rowCount = Number.isInteger(r.rowCount) && r.rowCount >= r.rows.length ? r.rowCount : r.rows.length;
  const m = o.metric && typeof o.metric === "object" ? o.metric : {};
  const c = m.cell && Number.isInteger(m.cell.row) && typeof m.cell.col === "string" && r.rows[m.cell.row] && m.cell.col in r.rows[m.cell.row]
    ? { row: m.cell.row, col: m.cell.col, raw: r.rows[m.cell.row][m.cell.col] } : null;
  const memo = o.memo && typeof o.memo === "object" ? o.memo : {};
  const src = o.source && typeof o.source === "object" ? o.source : {};
  const ds = o.dataset && typeof o.dataset === "object" ? o.dataset : {};
  return {
    schema: SCHEMA, id: o.id, title, category: o.category,
    metric: { name: str(m.name, 60), value: str(m.value, 60), cell: c },
    target: str(o.target, 80), period: str(o.period, 60), basis: str(o.basis, 200),
    memo: { meaning: str(memo.meaning, 1000), emphasis: str(memo.emphasis, 1000), followup: str(memo.followup, 1000) },
    tags: Array.isArray(o.tags) ? [...new Set(o.tags.map(t => str(t, 30)).filter(Boolean))].slice(0, 20) : [],
    favorite: o.favorite === true, createdAt: new Date(o.createdAt).toISOString(),
    updatedAt: isNaN(Date.parse(o.updatedAt)) ? new Date(o.createdAt).toISOString() : new Date(o.updatedAt).toISOString(),
    sql: o.sql, source: { kind: src.kind === "preset" ? "preset" : "ask", id: str(src.id, 20) || null, no: str(src.no, 20) || null, title: str(src.title, 200) || null },
    dataset: { label: str(ds.label, 120) || DATASET_LABEL, coverage: Array.isArray(ds.coverage) && ds.coverage.length === 2 ? ds.coverage.map(v => str(v, 10)) : null,
      tables: Array.isArray(ds.tables) ? ds.tables.map(t => str(t, 40)).filter(Boolean) : [],
      mine: ds.mine && typeof ds.mine === "object" ? Object.fromEntries(Object.entries(ds.mine).slice(0, 10).map(([k, v]) => [str(k, 40), str(v, 200)])) : {} },
    result: { fields: r.fields.slice(), rows: r.rows.map(row => Object.fromEntries(r.fields.map(f => [f, row[f] === undefined ? null : row[f]]))),
      rowCount, savedRows: r.rows.length, truncated: r.rows.length < rowCount },
    ai: null,   // 1차에서는 AI 내용을 가져오지 않는다
  };
}
$("#sb-import-file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const fail = msg => { SB.importPlan = null; $("#sb-i-body").innerHTML = `<p class="err">${esc(msg)}</p><p class="fine">기존 스크랩은 그대로입니다.</p>`; $("#sb-i-go").hidden = true; $("#sb-import").showModal(); };
  if (file.size > MAX_IMPORT_BYTES) return fail("파일이 너무 큽니다 (20MB 초과).");
  let data;
  try { data = JSON.parse(await file.text()); } catch (ex) { return fail("JSON 파일을 읽을 수 없습니다. 형식이 올바른 JSON이 아닙니다."); }
  if (!data || data.app !== "marketing-sql-lab" || data.kind !== "scrapbook" || !Array.isArray(data.scraps))
    return fail("Marketing SQL Lab 스크랩북 백업 파일이 아닙니다 (app·kind·scraps 항목 확인).");
  if (data.version !== SCHEMA) return fail(`지원하지 않는 백업 버전입니다 (version ${esc(data.version)}).`);
  const valid = [], seen = new Set();
  let bad = 0;
  for (const o of data.scraps) { const r = validRec(o); if (r && !seen.has(r.id)) { valid.push(r); seen.add(r.id); } else bad++; }
  if (!valid.length) return fail(`가져올 수 있는 스크랩이 없습니다 (형식 오류 ${bad}건).`);
  const have = new Map(SB.items.map(x => [x.id, x]));
  const fresh = valid.filter(r => !have.has(r.id)), dup = valid.filter(r => have.has(r.id));
  SB.importPlan = { fresh, dup };
  $("#sb-i-body").innerHTML = `<p>파일 «${esc(file.name)}»에서 스크랩 <b>${valid.length}건</b>을 읽었습니다.</p>
    <ul class="sb-ilist"><li>새 스크랩 <b>${fresh.length}건</b> — 추가합니다</li>
      <li>이미 있는 스크랩(같은 ID) <b>${dup.length}건</b></li>${bad ? `<li class="bad">형식이 틀려 건너뛰는 항목 <b>${bad}건</b></li>` : ""}</ul>
    ${dup.length ? `<fieldset class="sb-ichoice"><legend>같은 ID가 있을 때</legend>
      <label><input type="radio" name="sb-dup" value="skip" checked> 기존 스크랩 유지 (가져온 것은 건너뛰기)</label>
      <label><input type="radio" name="sb-dup" value="overwrite"> 가져온 내용으로 덮어쓰기</label></fieldset>` : ""}
    <p class="fine">가져오기는 한 번에 처리됩니다. 저장에 실패하면 아무것도 바뀌지 않습니다.</p>`;
  $("#sb-i-go").hidden = false;
  $("#sb-import").showModal();
});
$("#sb-i-go").addEventListener("click", async () => {
  const P = SB.importPlan;
  if (!P) return;
  const overwrite = (document.querySelector('input[name="sb-dup"]:checked') || {}).value === "overwrite";
  const recs = P.fresh.concat(overwrite ? P.dup : []);
  if (!recs.length) { $("#sb-import").close(); return toast("새로 가져올 스크랩이 없습니다 (모두 기존 유지)"); }
  $("#sb-i-go").disabled = true;
  try { await dbPutMany(recs); } catch (ex) {
    $("#sb-i-go").disabled = false;
    $("#sb-i-body").insertAdjacentHTML("beforeend", `<p class="err">${esc(storeError(ex))}</p>`);
    return;
  }
  $("#sb-i-go").disabled = false;
  $("#sb-import").close();
  SB.importPlan = null;
  await loadAll();
  toast(`스크랩 ${recs.length}건을 가져왔습니다${overwrite && P.dup.length ? ` (덮어쓰기 ${P.dup.length}건 포함)` : ""}`);
});

// ── 공통 ────────────────────────────────────────────────
document.querySelectorAll(".sb-dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
let toastTimer;
function toast(msg, bad) {
  const t = $("#sb-toast");
  t.textContent = msg; t.classList.toggle("bad", !!bad); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
document.querySelector('.tabs [data-tab="scrap"]').addEventListener("click", renderList);
loadAll();
