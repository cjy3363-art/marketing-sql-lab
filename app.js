/* 데이터에 묻는 창 — 화면.
 *
 * DuckDB-WASM 이 브라우저 안에서 parquet 을 읽는다. 표는 SQL에 나오는 것만 그때그때 받는다.
 * AI(api/sql)에는 질문 문장과 표 설명만 보낸다. 데이터는 보내지 않는다.
 * 실행하는 SQL은 전부 «읽기 전용» 검사를 거친다 — AI가 쓴 것이든 사람이 쓴 것이든.
 */
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";

const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const S = { db: null, conn: null, loaded: new Set(), schema: null, questions: [], files: [], mine: {} };

// ── 엔진 ─────────────────────────────────────────────
async function startEngine() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  S.db = db;
  S.conn = await db.connect();
}

async function ensureTables(sql) {
  const names = Object.keys(S.schema.tables).filter(t => new RegExp(`\\b${t}\\b`, "i").test(sql));
  for (const t of names) {
    if (S.loaded.has(t)) continue;
    $("#engine").textContent = `표 «${t}» 받는 중…`;
    const buf = new Uint8Array(await (await fetch(`data/${t}.parquet`)).arrayBuffer());
    await S.db.registerFileBuffer(`${t}.parquet`, buf);
    await S.conn.query(`CREATE VIEW ${t} AS SELECT * FROM '${t}.parquet'`);
    S.loaded.add(t);
  }
  engineLine();
}

function engineLine() {
  const mine = Object.keys(S.mine);
  $("#engine").textContent = mine.length
    ? `내 파일로 묻는 중 · ${mine.map(t => `${t} ← ${S.mine[t].file}`).join(" · ")}`
    : `준비됨 · 불러온 표 ${S.loaded.size}개 / ${Object.keys(S.schema.tables).length}개`;
  $("#engine").classList.add("ready");
}

// ── 내 파일로 — 엑셀 · CSV 를 이 브라우저 안에서 표로 올린다 ─────────────
// 파일 이름에 questions.json 의 files[].match 가 들어 있으면 그 표를 대신한다.
function tableFor(name) {
  const hit = S.files.find(f => name.includes(f.match));
  return hit ? hit.table : null;
}

async function loadMine(fileList) {
  for (const f of fileList) {
    const table = tableFor(f.name);
    const item = document.createElement("div");
    item.className = "mine";
    $("#mine-list").appendChild(item);
    if (!table) {
      item.innerHTML = `<span class="no">✕</span> ${esc(f.name)} — 이 파일에 맞는 표가 없습니다. 파일 이름에 ${S.files.map(x => `«${esc(x.match)}»`).join(" · ")} 가운데 하나가 들어 있어야 합니다`;
      continue;
    }
    item.innerHTML = `${esc(f.name)} 읽는 중…`;
    const buf = new Uint8Array(await f.arrayBuffer());
    const isCsv = /\.csv$/i.test(f.name);
    const wb = isCsv
      ? XLSX.read(new TextDecoder("utf-8").decode(buf).replace(/^﻿/, ""), { type: "string", raw: true })
      : XLSX.read(buf, { type: "array", cellDates: true });  // 날짜 셀을 날짜로 읽는다(아래 rawNumbers 가 날짜를 일련번호로 바꾸지 않게)
    const ws = wb.Sheets[wb.SheetNames[0]];
    const read = XLSX.utils.sheet_to_json(ws, { defval: "" }).length;
    // 숫자는 표시 서식(천 단위 쉼표 "18,000,000") 대신 원래 값으로 — 쉼표가 있으면 금액 열이 글자(VARCHAR)로 올라간다
    const csv = XLSX.utils.sheet_to_csv(ws, { rawNumbers: true });
    const tmp = `mine_${table}.csv`;
    await S.db.registerFileText(tmp, csv);
    await S.conn.query(`DROP VIEW IF EXISTS ${table}`);
    await S.conn.query(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv('${tmp}', header = true, auto_detect = true)`);
    const n = Number((await S.conn.query(`SELECT count(*) AS n FROM ${table}`)).toArray()[0].n);
    S.loaded.add(table);
    S.mine[table] = { file: f.name, rows: n };
    const ok = n === read;
    item.innerHTML = `<span class="${ok ? "ok" : "no"}">${ok ? "✓" : "✕"}</span> <b>${esc(f.name)}</b> → 표 <code>${table}</code> · `
      + `파일에서 읽은 줄 ${read.toLocaleString("ko-KR")} · 표에 올라간 줄 ${n.toLocaleString("ko-KR")}`
      + (wb.SheetNames.length > 1 ? ` · ⚠ 시트 ${wb.SheetNames.length}개 중 첫 시트만 읽었습니다` : "");
  }
  $("#btn-mine-reset").hidden = !Object.keys(S.mine).length;
  engineLine();
  document.querySelectorAll(".q .out").forEach(o => { o.innerHTML = ""; });
  if (S.dash) refreshDashboard();   // 대시보드도 올린 파일 기준으로 다시 집계
}

// ── 읽기 전용 검사 (api/sql.py 와 같은 규칙) ───────────────
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b/i;
function readOnly(sql) {
  const s = String(sql || "").replace(/--[^\n]*/g, "").trim().replace(/;\s*$/, "").trim();
  if (!s || s.includes(";")) return null;
  if (!/^(select|with)\b/i.test(s)) return null;
  if (FORBIDDEN.test(s.replace(/'[^']*'/g, "''"))) return null;
  return s;
}

// ── 실행 ─────────────────────────────────────────────
async function run(sql) {
  const safe = readOnly(sql);
  if (!safe) throw new Error("읽기(SELECT · WITH)만 실행합니다. 한 문장만, 바꾸는 명령 없이.");
  await ensureTables(safe);
  let t = await S.conn.query(safe);
  // 소수 자리가 정해진 숫자(DECIMAL)는 화면에서 읽기 어려운 모양으로 온다 — 보통 숫자로 바꿔 다시 받는다
  const dec = t.schema.fields.filter(f => String(f.type).startsWith("Decimal"));
  if (dec.length) {
    const cols = t.schema.fields.map(f => dec.includes(f) ? `"${f.name}"::DOUBLE AS "${f.name}"` : `"${f.name}"`);
    t = await S.conn.query(`SELECT ${cols.join(", ")} FROM (${safe})`);
  }
  const fields = t.schema.fields.map(f => f.name);
  // 날짜(DATE)는 Arrow 가 «1970-01-01 부터의 밀리초» 숫자로 준다 — 그대로 두면 1,735,689,600,000 처럼 보인다. YYYY-MM-DD 글자로 바꾼다
  const dates = new Set(t.schema.fields.filter(f => String(f.type).startsWith("Date")).map(f => f.name));
  const rows = t.toArray().map(r => {
    const o = {};
    fields.forEach(f => {
      const v = r[f];
      o[f] = typeof v === "bigint" ? Number(v)
        : dates.has(f) && typeof v === "number" ? new Date(v).toISOString().slice(0, 10)
        : v;
    });
    return o;
  });
  return { fields, rows };
}

function fmt(v) {
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("ko-KR") : String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return esc(v);
}

function render({ fields, rows }, ms) {
  const head = `<tr>${fields.map(f => `<th>${esc(f)}</th>`).join("")}</tr>`;
  const body = rows.slice(0, 50).map(r => `<tr>${fields.map(f =>
    `<td class="${typeof r[f] === "number" ? "n" : ""}">${fmt(r[f])}</td>`).join("")}</tr>`).join("");
  let html = `<div class="res-head"><span>실행 결과 <b>${rows.length.toLocaleString("ko-KR")}행</b> 반환</span>`
    + (ms != null ? `<span class="ms">${Math.round(ms)}ms</span>` : "") + `</div>`;
  html += `<div class="res"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  if (rows.length > 50) html += `<p class="small muted">… ${rows.length}줄 중 50줄만 보여줍니다</p>`;
  // 막대 — 첫 열이 글자이고 마지막 열이 숫자일 때
  const last = fields[fields.length - 1];
  if (rows.length > 1 && rows.length <= 20 && typeof rows[0][fields[0]] === "string" && typeof rows[0][last] === "number") {
    const max = Math.max(...rows.map(r => Math.abs(r[last]))) || 1;
    html += `<div class="bars">` + rows.map(r => `<div class="bar"><span class="l">${esc(r[fields[0]])}</span>`
      + `<span class="t"><i style="width:${(Math.abs(r[last]) / max) * 100}%"></i></span><span class="v">${fmt(r[last])}</span></div>`).join("") + `</div>`;
  }
  return html;
}

function checks(q, res) {
  return `<div class="checks">` + q.check.map(c => {
    const hit = res.rows.find(r => Object.entries(c.where || {}).every(([k, v]) => r[k] === v));
    const got = hit ? hit[c.col] : undefined;
    const ok = typeof got === "number" && Math.abs(got - c.want) < 1e-9;
    const where = Object.values(c.where || {}).join(" ");
    return `<span class="${ok ? "ok" : "no"}">${ok ? "✓" : "✕"} ${esc(where)} ${esc(c.col)} ${fmt(c.want)}</span>`;
  }).join("") + (Object.keys(S.mine).some(t => new RegExp(`\\b${t}\\b`, "i").test(q.sql))
    ? `<span class="muted">← 확인할 값은 목업 데이터의 값입니다. 내 파일에서는 달라도 됩니다</span>`
    : `<span class="muted">← 실측결과와 대조</span>`) + `</div>`;
}

// ── 준비한 질문 ───────────────────────────────────────
const STAGES = ["현황", "비교", "원인 탐색", "처방"];
// 질문 제목의 «[단계] Q번호.» 머리말은 번호·단계 표시로 따로 보여 주므로 본문에서 뺀다 (questions.json 은 그대로)
const titleOf = q => String(q.q).replace(/^\[[^\]]+\]\s*Q[\w-]+\.\s*/, "");

function renderQuestions() {
  const topics = new Set(S.questions.map(q => String(q.no || q.id).split("-")[0])).size;
  const ab = S.questions.some(q => /-[AB]$/.test(q.no || ""));
  $("#topic-bar").innerHTML = `<span>총 ${topics}개 질문 주제 · ${S.questions.length}개 실행 쿼리</span>`
    + (ab ? `<span class="tag">A/B 변형 포함</span>` : "");
  const stages = STAGES.filter(s => S.questions.some(q => q.stage === s));
  $("#stage-tabs").innerHTML = [`<button role="tab" data-stage="" aria-selected="true">전체 ${S.questions.length}</button>`]
    .concat(stages.map(s => `<button role="tab" data-stage="${esc(s)}" aria-selected="false">${esc(s)} ${S.questions.filter(q => q.stage === s).length}</button>`)).join("");
  $("#stage-tabs").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    $("#stage-tabs").querySelectorAll("button").forEach(x => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll("#qlist .q").forEach(el => { el.hidden = !!b.dataset.stage && el.dataset.stage !== b.dataset.stage; });
  }));
  $("#qlist").innerHTML = S.questions.map(q => {
    const causal = q.stage === "처방";
    const meta = [q.unit && `<span>단위 <b>${esc(q.unit)}</b></span>`, q.denominator && `<span>분모 <b>${esc(q.denominator)}</b></span>`,
      q.tables && `<span>사용 표 <b>${q.tables.map(esc).join(", ")}</b></span>`,
      q.expected_rows != null && `<span>예상 <b>${q.expected_rows}행</b></span>`].filter(Boolean).join("");
    return `
    <div class="q" id="q-${q.id}" data-stage="${esc(q.stage || "")}">
      <div class="qhead" data-q="${q.id}">
        <span class="qno">${esc(q.no || q.id)}</span>
        <div class="qtext"><span class="qstage">${esc(q.stage || "")}</span><h4>${esc(titleOf(q))}</h4></div>
        <span class="qchev" aria-hidden="true">▶</span>
      </div>
      <div class="body" hidden>
        ${q.description ? `<p class="qdesc">${esc(q.description)}</p>` : ""}
        ${meta ? `<div class="qmeta">${meta}</div>` : ""}
        <div class="caution${causal ? " causal" : ""}"><span class="cap">${causal ? "인과 검증 유의사항" : "해석 시 주의"}</span><div class="judge">${esc(q.judge)}</div></div>
        <div class="console">
          <div class="console-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(q.id)}.sql</span><span class="console-eng">DuckDB-WASM</span></div>
          <pre class="sql">${esc(q.sql)}</pre>
          <div class="console-actions"><button class="primary" data-run="${q.id}">SQL 실행</button>
            <button class="ghost" data-edit="${q.id}">고쳐서 묻기</button></div>
        </div>
        <div class="out"></div>
      </div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-q]").forEach(h => h.addEventListener("click", () => {
    const item = h.parentElement, b = item.querySelector(".body");
    b.hidden = !b.hidden; item.classList.toggle("open", !b.hidden);
  }));
  document.querySelectorAll("[data-run]").forEach(b => b.addEventListener("click", async () => {
    const q = S.questions.find(x => x.id === b.dataset.run);
    const out = b.closest(".q").querySelector(".out");
    b.disabled = true; b.textContent = "실행 중…";
    const t0 = performance.now();
    try { const res = await run(q.sql); out.innerHTML = render(res, performance.now() - t0) + checks(q, res); out.dataset.done = "1"; }
    catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    b.disabled = false; b.textContent = "SQL 실행";
  }));
  document.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
    $("#sql").value = S.questions.find(x => x.id === b.dataset.edit).sql;
    document.querySelector("[data-tab=ask]").click();
  }));
}

// ── 직접 묻기 ─────────────────────────────────────────
$("#btn-run").addEventListener("click", async () => {
  const b = $("#btn-run");
  b.disabled = true; b.textContent = "실행 중…";
  const t0 = performance.now();
  try { $("#ask-out").innerHTML = render(await run($("#sql").value), performance.now() - t0); }
  catch (e) { $("#ask-out").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  b.disabled = false; b.textContent = "SQL 실행";
});
// Ctrl(⌘)+Enter 로 실행
$("#sql").addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); if (!$("#btn-run").disabled) $("#btn-run").click(); }
});
// 표 이름 버튼 — 그 표를 미리 보는 SQL 을 편집기에 넣는다 (실행은 사람이 누른다)
function renderPills() {
  $("#schema-pills").innerHTML = Object.keys(S.schema.tables).map(t => `<button type="button" data-pill="${esc(t)}">${esc(t)}</button>`).join("");
  $("#schema-pills").querySelectorAll("[data-pill]").forEach(b => b.addEventListener("click", () => {
    $("#sql").value = `SELECT *\nFROM ${b.dataset.pill}\nLIMIT 20`;
    $("#sql").focus();
  }));
}

const AI_OFF = "AI 질문 변환 기능은 현재 비활성화되어 있습니다. 준비한 질문 또는 직접 SQL 입력 기능을 이용해 주세요.";
$("#btn-nl").addEventListener("click", async () => {
  const q = $("#nl").value.trim();
  if (!q) return;
  const b = $("#btn-nl"); b.disabled = true; b.textContent = "AI가 SQL을 쓰는 중…";
  let r;
  try {
    const res = await fetch("api/sql", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, schema: S.schema }) });
    // 404·405·501 = 서버 함수가 없는 환경(정적 서버 등) → AI 기능 비활성으로 본다
    r = res.ok ? await res.json()
      : [404, 405, 501].includes(res.status) ? { sql: null, disabled: true }
      : { sql: null, reason: `서버 함수가 없습니다 (${res.status}) — 배포하면 생깁니다` };
  } catch (e) { r = { sql: null, reason: "서버 함수에 닿지 못했습니다" }; }
  $("#nl-msg").hidden = false;
  if (r.sql) {
    $("#sql").value = r.sql;
    $("#nl-msg").textContent = `AI가 쓴 SQL입니다 — ${r.why || ""} · 실행 전에 읽어 보고, 결과 하나는 손으로 검산하십시오.`;
  } else {
    $("#nl-msg").textContent = r.disabled ? AI_OFF
      : `SQL을 만들지 못했습니다 — ${r.reason}. 아래 SQL을 직접 고쳐서 실행할 수 있습니다.`;
  }
  b.disabled = false; b.textContent = "SQL 만들기 (AI)";
});

// ── 표 보기 ───────────────────────────────────────────
function renderTables() {
  $("#schema-note").textContent = S.schema.note;
  const entries = Object.entries(S.schema.tables);
  const fk = i => (i.foreign_keys || []).map(f => `${f.column} → ${f.references}${f.nullable ? " (NULL 허용)" : ""}`).join(", ") || "없음";
  $("#tables").innerHTML = `<div class="chips" role="tablist">` + entries.map(([t, i], k) =>
    `<button type="button" role="tab" data-tbl="${esc(t)}" aria-selected="${k === 0}"><span class="nm">${esc(t)}</span><span class="cnt">${i.rows.toLocaleString("ko-KR")}행</span></button>`).join("") + `</div>`
    + entries.map(([t, i], k) => `
    <div class="tbl" id="tbl-${esc(t)}" ${k === 0 ? "" : "hidden"}>
      <div class="tbl-head"><b>${esc(t)}</b><span class="g">한 줄 = ${esc(i.grain)}</span></div>
      ${i.desc ? `<p class="tbl-desc">${esc(i.desc)}</p>` : ""}
      <div class="tbl-facts">
        <div>행 수<b>${i.rows.toLocaleString("ko-KR")}행</b></div>
        <div>컬럼<b>${i.columns.length}개</b></div>
        <div>기본키<b>${esc((i.primary_key || []).join(" + ") || "-")}</b></div>
        <div>외래키<b>${esc(fk(i))}</b></div>
      </div>
      ${(i.cautions || []).length ? `<ul>${i.cautions.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
      <div class="res"><table class="cols"><thead><tr><th>컬럼</th><th>형식</th><th>NULL</th><th>설명</th></tr></thead><tbody>${i.columns.map(c =>
        `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${c.nullable ? "있음" : "-"}</td><td>${esc(c.desc || "")}${c.values ? ` <small>(${c.values.map(esc).join("·")})</small>` : ""}</td></tr>`).join("")}</tbody></table></div>
      <div class="tbl-actions"><button class="ghost" type="button" data-preview="${esc(t)}">샘플 5행 미리보기</button></div>
      <div class="tbl-out"></div>
    </div>`).join("");
  $("#tables").querySelectorAll("[data-tbl]").forEach(b => b.addEventListener("click", () => {
    $("#tables").querySelectorAll("[data-tbl]").forEach(x => x.setAttribute("aria-selected", x === b));
    $("#tables").querySelectorAll(".tbl").forEach(el => { el.hidden = el.id !== "tbl-" + b.dataset.tbl; });
  }));
  $("#tables").querySelectorAll("[data-preview]").forEach(b => b.addEventListener("click", async () => {
    const out = b.closest(".tbl").querySelector(".tbl-out");
    b.disabled = true;
    const t0 = performance.now();
    try { out.innerHTML = render(await run(`SELECT * FROM ${b.dataset.preview} LIMIT 5`), performance.now() - t0); }
    catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    b.disabled = false;
  }));
}

// ── 탭 — 대시보드 탭은 대시보드 아래에 준비한 질문을 함께 보여 준다 (시안 design01) ──
const VIEWS = { dashboard: ["dashboard", "preset"], preset: ["preset"], ask: ["ask"], tables: ["tables"], mine: ["mine"] };
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  const show = VIEWS[b.dataset.tab] || [b.dataset.tab];
  Object.keys(VIEWS).forEach(k => { $("#tab-" + k).hidden = !show.includes(k); });
  if (show.includes("dashboard") && S.lastChart) drawChart(S.lastChart);   // 숨겨져 있던 동안 너비가 0 이었으므로 다시 그림
}));
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (S.lastChart && !$("#tab-dashboard").hidden) drawChart(S.lastChart); }, 150);
});

// ── 대시보드 — marketing_daily 실제 집계 ─────────────────
// 기준: KPI 정의 (기본 ROAS = 유료광고 채널 귀속 매출 ÷ 광고비, 광고비 0이면 산출 불가). 캠페인×일 1행 = 캠페인 1개 = 병원 1곳이라 campaigns 와 붙여도 행이 늘지 않는다(중복 집계 없음).
// 대시보드 필터는 대시보드에만 적용된다. 준비한 질문의 SQL·확인할 값은 바꾸지 않는다.
const won = v => Math.round(v).toLocaleString("ko-KR");
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;
const monthEnd = ym => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

async function initDashboard() {
  // run() 은 표를 처음 쓸 때 받아 등록하므로 동시에 부르지 않고 차례로 부른다 (같은 표 중복 등록 방지)
  const months = await run("SELECT DISTINCT strftime(report_date, '%Y-%m') AS ym FROM marketing_daily ORDER BY 1");
  const hosp = await run("SELECT hospital_id, hospital_name FROM hospitals ORDER BY hospital_id");
  S.dash = { months: months.rows.map(r => r.ym) };
  const opts = S.dash.months.map(m => `<option value="${m}">${m.replace("-", ".")}</option>`).join("");
  $("#dash-from").innerHTML = opts; $("#dash-to").innerHTML = opts;
  $("#dash-from").value = S.dash.months[0]; $("#dash-to").value = S.dash.months[S.dash.months.length - 1];
  $("#dash-hospital").innerHTML = `<option value="">전체 병원 합산 (${hosp.rows.length}곳)</option>`
    + hosp.rows.map(r => `<option value="${esc(r.hospital_id)}">${esc(r.hospital_id)} · ${esc(r.hospital_name)}</option>`).join("");
  ["#dash-from", "#dash-to", "#dash-hospital"].forEach(id => $(id).addEventListener("change", e => {
    if ($("#dash-from").value > $("#dash-to").value) {   // 시작 > 끝이면 방금 바꾼 쪽에 맞춘다
      if (e.target.id === "dash-from") $("#dash-to").value = $("#dash-from").value; else $("#dash-from").value = $("#dash-to").value;
    }
    refreshDashboard();
  }));
  $("#dash-reset").addEventListener("click", () => {
    $("#dash-from").value = S.dash.months[0]; $("#dash-to").value = S.dash.months[S.dash.months.length - 1];
    $("#dash-hospital").value = ""; refreshDashboard();
  });
  await refreshDashboard();
}

function dashFilter() {
  const from = $("#dash-from").value, to = $("#dash-to").value, hid = $("#dash-hospital").value;
  if (!S.dash.months.includes(from) || !S.dash.months.includes(to)) throw new Error("기간 값이 올바르지 않습니다");
  const where = `d.report_date BETWEEN DATE ${sqlStr(from + "-01")} AND DATE ${sqlStr(monthEnd(to))}`
    + (hid ? ` AND c.hospital_id = ${sqlStr(hid)}` : "");
  return { from, to, hid, where, months: S.dash.months.filter(m => m >= from && m <= to) };
}

async function refreshDashboard() {
  const seq = (S.dashSeq = (S.dashSeq || 0) + 1);
  let f;
  try { f = dashFilter(); } catch (e) { $("#dash-scope").textContent = e.message; return; }
  const base = `FROM marketing_daily d JOIN campaigns c ON c.campaign_id = d.campaign_id WHERE ${f.where}`;
  const kpiSql = `SELECT COUNT(*) AS n_rows,
       COALESCE(SUM(d.spend), 0) AS spend,
       COALESCE(SUM(d.attributed_revenue), 0) AS revenue,
       COALESCE(SUM(CASE WHEN c.channel_group = '유료광고' THEN d.attributed_revenue ELSE 0 END), 0) AS paid_revenue,
       COALESCE(SUM(d.inquiries), 0) AS inquiries, COALESCE(SUM(d.reservations), 0) AS reservations,
       COALESCE(SUM(d.visits), 0) AS visits, COALESCE(SUM(d.conversions), 0) AS conversions
${base}`;
  const monthVals = f.months.map(m => `(${sqlStr(m)})`).join(", ");
  const monthSql = `WITH m(ym) AS (VALUES ${monthVals}),
agg AS (SELECT strftime(d.report_date, '%Y-%m') AS ym, SUM(d.spend) AS spend, SUM(d.attributed_revenue) AS revenue ${base} GROUP BY 1)
SELECT m.ym, COALESCE(agg.spend, 0) AS spend, COALESCE(agg.revenue, 0) AS revenue
FROM m LEFT JOIN agg ON agg.ym = m.ym ORDER BY m.ym`;
  $("#dash-scope").textContent = "집계 중…";
  try {
    const k = await run(kpiSql);
    const mo = await run(monthSql);
    if (seq !== S.dashSeq) return;   // 더 최근 필터 변경이 있으면 이 결과는 버린다
    const r = k.rows[0];
    const unit = { spend: "원", revenue: "원", inquiries: "건", reservations: "건", visits: "건", conversions: "건" };
    Object.keys(unit).forEach(key => {
      $(`[data-kpi="${key}"]`).innerHTML = `${won(r[key])}<small>${unit[key]}</small>`;
    });
    const hname = f.hid ? $("#dash-hospital").selectedOptions[0].textContent : $("#dash-hospital").options[0].textContent.replace(" 합산", "");
    const mine = ["marketing_daily", "campaigns"].filter(t => S.mine[t]);
    $("#dash-scope").textContent = `${hname} · ${f.from.replace("-", ".")} ~ ${f.to.replace("-", ".")} (${f.months.length}개월)`
      + (mine.length ? ` · 내 파일 기준(${mine.join(", ")})` : "");
    $("#chart-sub").textContent = `월별 광고비 대비 귀속 매출 (단위: 백만 원) · ${hname}`;
    drawChart(mo.rows);
    const roas = r.spend > 0 ? (r.paid_revenue * 100 / r.spend).toFixed(1) + "%" : "산출 불가";
    const blended = r.spend > 0 ? (r.revenue * 100 / r.spend).toFixed(1) + "%" : "산출 불가";
    $("#dash-foot").innerHTML = `<span>광고비 합 <b>${won(r.spend)}원</b></span><span>귀속 매출 합 <b class="rev">${won(r.revenue)}원</b></span>`
      + `<span class="roas">기본 ROAS(유료) <b class="roas">${roas}</b></span><span>통합 ROAS(참고) <b>${blended}</b></span>`;
    $("#dash-table").innerHTML = `<table><thead><tr><th>월</th><th>광고비(원)</th><th>귀속 매출(원)</th></tr></thead><tbody>`
      + mo.rows.map(x => `<tr><td>${x.ym}</td><td class="n">${won(x.spend)}</td><td class="n">${won(x.revenue)}</td></tr>`).join("")
      + `<tr><td><b>합계</b></td><td class="n"><b>${won(mo.rows.reduce((a, x) => a + x.spend, 0))}</b></td><td class="n"><b>${won(mo.rows.reduce((a, x) => a + x.revenue, 0))}</b></td></tr></tbody></table>`;
    document.body.dataset.dash = "ready";
  } catch (e) {
    if (seq === S.dashSeq) $("#dash-scope").textContent = "대시보드 집계 실패 — " + e.message;
  }
}

// 차트는 상자의 실제 픽셀 너비로 그린다 — 고정 크기를 줄여 그리면 모바일에서 글자가 5px 처럼 작아진다
function drawChart(rows) {
  S.lastChart = rows;
  const box = $("#dash-chart");
  const W = Math.max(300, Math.round(box.clientWidth - 12));
  const H = W < 520 ? 200 : Math.min(260, Math.max(220, Math.round(W * 0.24)));
  const L = 46, R = 14, T = 14, B = 30;
  const toM = v => v / 1e6;
  const max = Math.max(1, ...rows.map(r => Math.max(toM(r.spend), toM(r.revenue))));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(s => max / s <= 5) || Math.ceil(max / 5);
  const top = Math.ceil(max / step) * step;
  const y = v => T + (H - T - B) * (1 - v / top);
  const n = rows.length, slot = (W - L - R) / Math.max(n, 1), bw = Math.min(34, slot * 0.42);
  const cx = i => L + slot * (i + 0.5);
  let g = "";
  for (let v = 0; v <= top + 1e-9; v += step) {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#c3c6d7" stroke-width="0.6" stroke-dasharray="${v ? "3,3" : ""}"/>`
      + `<text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="#565e74" font-family="Consolas, monospace">${v.toLocaleString("ko-KR")}</text>`;
  }
  rows.forEach((r, i) => {
    const h = Math.max(0, y(0) - y(toM(r.spend)));
    g += `<rect x="${cx(i) - bw / 2}" y="${y(0) - h}" width="${bw}" height="${h}" rx="3" fill="#b4c5ff"><title>${r.ym} 광고비 ${won(r.spend)}원</title></rect>`
      + `<text x="${cx(i)}" y="${H - 10}" text-anchor="middle" font-size="11" font-weight="600" fill="#0b1c30">${Number(r.ym.slice(5))}월</text>`;
  });
  const pts = rows.map((r, i) => `${cx(i)},${y(toM(r.revenue))}`).join(" ");
  if (n > 1) g += `<polyline points="${pts}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  rows.forEach((r, i) => {
    g += `<circle cx="${cx(i)}" cy="${y(toM(r.revenue))}" r="4" fill="#fff" stroke="#2563eb" stroke-width="2"><title>${r.ym} 귀속 매출 ${won(r.revenue)}원</title></circle>`;
  });
  $("#dash-chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
}

// ── 내 파일로 — 넣기 ─────────────────────────────────────
$("#mine-file").addEventListener("change", e => { if (e.target.files.length) loadMine([...e.target.files]); });
const drop = $("#drop");
["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { if (e.dataTransfer.files.length) loadMine([...e.dataTransfer.files]); });
$("#btn-mine-reset").addEventListener("click", () => location.reload());

// ── 시작 ─────────────────────────────────────────────
(async () => {
  const [sch, qs] = await Promise.all([fetch("schema.json").then(r => r.json()), fetch("questions.json").then(r => r.json())]);
  S.schema = sch; S.questions = qs.questions; S.files = qs.files || [];
  renderQuestions(); renderTables(); renderPills();
  $("#mine-rule").textContent = S.files.length
    ? "파일 이름으로 표를 고릅니다 — " + S.files.map(f => `«${f.match}»가 든 파일 → ${f.table}`).join(" · ")
    : "questions.json 에 files 가 없어 내 파일을 받을 수 없습니다";
  try {
    await startEngine();
    $("#engine").textContent = "준비됨 · 표는 질문에 나올 때 받습니다";
    $("#engine").classList.add("ready");
    document.body.dataset.engine = "ready";
  } catch (e) {
    $("#engine").textContent = "데이터 엔진을 불러오지 못했습니다 — 인터넷 연결을 확인하십시오";
    document.body.dataset.engine = "fail";
    $("#dash-scope").textContent = "데이터 엔진이 없어 대시보드를 집계할 수 없습니다";
    return;
  }
  try { await initDashboard(); }
  catch (e) { $("#dash-scope").textContent = "대시보드 집계 실패 — " + e.message; }
})();
