import * as db from "./db.js";

const $ = (id) => document.getElementById(id);
let snaps = [], events = [], selected = new Set(), current = null, tab = "questions";

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  kids.flat().forEach((k) => el.append(k?.nodeType ? k : document.createTextNode(k ?? "")));
  return el;
}

// ---------- aggregation ----------
function uniqueQuestions() {
  const map = new Map();
  for (const s of snaps) {
    for (const q of s.questions || []) {
      const key = [q.type, q.prompt, (q.options || []).map((o) => o.label).join("¦")].join("|");
      const hit = map.get(key);
      if (hit) { hit.seenInSnapshots++; continue; }
      map.set(key, {
        type: q.type,
        prompt: q.prompt,
        label: q.label,
        options: (q.options || []).map((o) => o.label),
        selector: q.selector || q.container,
        optionSelectors: (q.options || []).map((o) => o.selector).filter(Boolean),
        required: q.required,
        firstSeen: { snapshotId: s.id, url: s.url, time: s.iso },
        seenInSnapshots: 1,
      });
    }
  }
  return [...map.values()];
}

// ---------- rendering ----------
async function load() {
  [snaps, events] = await Promise.all([db.getAll("snapshots"), db.getAll("events")]);
  snaps.sort((a, b) => a.id - b.id);
  selected = new Set([...selected].filter((id) => snaps.some((s) => s.id === id)));
  render();
}

function render() {
  const f = $("filter").value.toLowerCase();
  const list = snaps.filter((s) => !f || (s.url + " " + (s.title || "")).toLowerCase().includes(f));
  $("stats").textContent = `${snaps.length} snapshots · ${events.length} events · ${new Set(snaps.map((s) => s.url)).size} unique URLs`;

  const rows = $("rows");
  rows.replaceChildren();
  for (const s of list) {
    const tr = h("tr", { className: "row" + (current?.id === s.id ? " sel" : "") },
      h("td", {}, String(s.id)),
      h("td", { className: "dim" }, new Date(s.t).toLocaleTimeString()),
      h("td", { className: "url", title: s.url }, (s.frame?.isTop ? "" : "[frame] ") + (s.title || s.url)),
      h("td", { className: "dim" }, s.reason),
      h("td", {}, String(s.questionCount || 0))
    );
    tr.onclick = () => { current = s; render(); renderDetail(); };
    tr.ondblclick = () => { selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id); tr.style.outline = selected.has(s.id) ? "1px solid #b58900" : ""; };
    rows.append(tr);
  }

  const uq = uniqueQuestions();
  const byType = {};
  uq.forEach((q) => (byType[q.type] = (byType[q.type] || 0) + 1));
  $("typeSummary").replaceChildren(
    ...(Object.keys(byType).length
      ? Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => h("span", { className: "tag t" }, `${t} × ${n}`))
      : [h("span", { className: "dim" }, "No questions detected yet.")]),
    h("div", { className: "dim", style: "margin-top:6px" }, "Tip: double-click rows to multi-select for deletion.")
  );
}

async function renderDetail() {
  const box = $("detail");
  if (!current) return;
  $("detailTitle").textContent = `Snapshot #${current.id} — ${current.title || current.url}`;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  box.className = "";
  box.replaceChildren();
  if (tab === "questions") {
    if (!current.questions.length) box.append(h("div", { className: "dim" }, "No questions detected in this snapshot."));
    current.questions.forEach((q) =>
      box.append(
        h("div", { className: "q" },
          h("span", { className: "tag t" }, q.type), q.visible === false ? h("span", { className: "tag" }, "hidden") : "",
          h("div", {}, q.prompt || q.label || "(no prompt text found)"),
          q.options?.length ? h("ul", {}, q.options.map((o) => h("li", {}, (o.checked ? "● " : "○ ") + (o.label || o.value || "")))) : "",
          h("div", { className: "dim" }, q.selector || q.container || "")
        )
      )
    );
  } else if (tab === "elements") {
    box.append(h("pre", {}, JSON.stringify(current.elements.slice(0, 300), null, 2) + (current.elements.length > 300 ? `\n… ${current.elements.length - 300} more (in export)` : "")));
  } else if (tab === "text") {
    box.append(h("pre", {}, current.visibleText || "(not recorded)"));
  } else if (tab === "html") {
    const html = await db.getHtml(current.id);
    box.append(h("pre", {}, html.slice(0, 200000) + (html.length > 200000 ? "\n… truncated in viewer (full in export)" : "")));
  } else if (tab === "events") {
    const evs = events.filter((e) => e.sessionId === current.sessionId && e.tabId === current.tabId && e.url === current.url).slice(-200);
    box.append(h("pre", {}, evs.length ? JSON.stringify(evs, null, 2) : "No events for this URL."));
  }
}

// ---------- export ----------
function download(blob, name) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const slug = (s) => s.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 60);

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) { // store-only zip, UTF-8 names
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const csize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, csize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

async function exportZip() {
  $("expZip").textContent = "Building…";
  const files = [];
  const index = [];
  for (const s of snaps) {
    const base = `snapshots/${String(s.id).padStart(4, "0")}-${slug(s.url)}${s.frame?.isTop ? "" : "-frame"}`;
    const html = await db.getHtml(s.id);
    files.push({ name: base + ".html", data: html });
    files.push({ name: base + ".summary.json", data: JSON.stringify(s, null, 2) });
    const { elements, questions, visibleText, ...light } = s;
    index.push({ ...light, file: base + ".html", summary: base + ".summary.json" });
  }
  files.unshift({ name: "index.json", data: JSON.stringify(index, null, 2) });
  files.push({ name: "questions.json", data: JSON.stringify(uniqueQuestions(), null, 2) });
  files.push({ name: "events.json", data: JSON.stringify(events, null, 2) });
  download(makeZip(files), `dom-recording-${stamp()}.zip`);
  $("expZip").textContent = "Export ZIP";
}

async function exportJson() {
  const out = [];
  for (const s of snaps) out.push({ ...s, html: await db.getHtml(s.id) });
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), snapshots: out, questions: uniqueQuestions(), events }, null, 2)], { type: "application/json" });
  download(blob, `dom-recording-${stamp()}.json`);
}

// ---------- wiring ----------
$("filter").oninput = render;
$("refresh").onclick = load;
$("expZip").onclick = exportZip;
$("expJson").onclick = exportJson;
$("delSel").onclick = async () => {
  const ids = selected.size ? [...selected] : current ? [current.id] : [];
  if (!ids.length || !confirm(`Delete ${ids.length} snapshot(s)?`)) return;
  await db.deleteSnapshots(ids);
  selected.clear();
  current = null;
  $("detail").textContent = "Select a snapshot.";
  load();
};
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderDetail(); }));

load();
setInterval(() => { if (document.visibilityState === "visible") load(); }, 4000);
