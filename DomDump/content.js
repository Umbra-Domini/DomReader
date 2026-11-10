(() => {
  if (window.__domRecorder) return; // guard against double injection
  window.__domRecorder = true;

  const IS_TOP = window.top === window;
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const STRIP = new Set(["script", "style", "noscript"]);
  const LITE_ATTRS = new Set(["id", "name", "type", "for", "href", "role"]);
  const INTERACTIVE = "a, button, input, select, textarea, summary, [role], [tabindex], [contenteditable]:not([contenteditable='false']), [draggable='true'], [onclick]";
  const NOTABLE =
    INTERACTIVE +
    ", h1, h2, h3, h4, h5, h6, label, legend, option, fieldset, form, table, canvas, audio, video, img[alt], [aria-label], [aria-live]," +
    " [class*='question' i], [class*='answer' i], [class*='option' i], [class*='choice' i], [class*='quiz' i], [class*='prompt' i]," +
    " [id*='question' i], [id*='answer' i], [id*='quiz' i]";
  const CUSTOM_OPT = ":not(option):is([class*='option' i], [class*='choice' i], [class*='answer' i], [class*='alternative' i])";
  const SENSITIVE_AC = /^(cc-|one-time-code|current-password|new-password)/;

  let opts = {
    recordEvents: true, captureStateChanges: true, includeShadow: true, stripScripts: true, stripSvg: true,
    includeVisibleText: true, settleMs: 700, maxWaitMs: 4000, maxSnapshotsPerUrl: 80, maxElements: 4000, maxTextLength: 160,
  };
  let recording = false;
  let observer = null;
  let observedRoots = new WeakSet();
  let timer = null, firstPending = 0, pendingReason = "mutation";
  let lastHash = "", lastHref = location.href, firstCapture = true;
  const perUrl = new Map();
  let evBuf = [], evTimer = null;
  const inputTimers = new WeakMap();
  const uids = new WeakMap();
  let uidN = 0;
  const uid = (o) => (o ? uids.get(o) ?? (uids.set(o, ++uidN), uidN) : 0);

  // ---------- helpers ----------
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => (alive() ? chrome.runtime.sendMessage(msg).catch(() => null) : Promise.resolve(null));
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const txt = (el, n = 200) => clean(el.innerText ?? el.textContent).slice(0, n);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escA = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const shadowOf = (el) => {
    try { return chrome.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot || null; } catch { return el.shadowRoot || null; }
  };
  function hash(str) { // cyrb53
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const isSensitive = (el) =>
    el.type === "password" || SENSITIVE_AC.test(el.getAttribute?.("autocomplete") || "");
  const safeValue = (el) => (isSensitive(el) ? "[masked]" : String(el.value ?? ""));
  function isVisible(el) {
    try {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch {}
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------- selectors ----------
  function sel(el) {
    if (!el || el.nodeType !== 1) return "";
    const root = el.getRootNode();
    const scope = root instanceof ShadowRoot ? root : document;
    const unique = (s) => { try { return scope.querySelectorAll(s).length === 1; } catch { return false; } };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      let part = node.localName;
      if (node.id) {
        const s = "#" + CSS.escape(node.id);
        if (unique(s)) { parts.unshift(s); break; }
        part += s;
      } else {
        const tidAttr = ["data-testid", "data-test", "data-id"].find((a) => node.hasAttribute(a));
        if (tidAttr) part += `[${tidAttr}="${CSS.escape(node.getAttribute(tidAttr))}"]`;
        else if (node.getAttribute("name")) part += `[name="${CSS.escape(node.getAttribute("name"))}"]`;
        const classes = [...node.classList].slice(0, 2);
        if (classes.length) part += "." + classes.map((c) => CSS.escape(c)).join(".");
        const sibs = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) break;
    }
    return parts.join(" > ");
  }

  // ---------- 1. HTML serialization ----------
  function ser(node, depth, out, lite) {
    const pad = lite ? "" : "  ".repeat(depth);
    const nl = lite ? "" : "\n";
    if (node.nodeType === 3) {
      const t = node.textContent.replace(/\s+/g, " ").trim();
      if (t) out.push(pad + esc(t) + nl);
      return;
    }
    if (node.nodeType !== 1) return;
    const lower = node.localName;
    const upper = node.tagName;
    if (opts.stripScripts && STRIP.has(lower)) { out.push(`${pad}<${lower}><!-- stripped --></${lower}>${nl}`); return; }
    if (opts.stripSvg && lower === "svg") { out.push(`${pad}<svg${lite ? "" : ` class="${escA(node.getAttribute("class") || "")}"`}><!-- stripped --></svg>${nl}`); return; }

    let attrs = "";
    for (const a of node.attributes) {
      if (lite && !LITE_ATTRS.has(a.name)) continue;
      let v = a.value;
      if (v.length > 600) v = v.slice(0, 600) + `…[+${v.length - 600}]`;
      attrs += ` ${a.name}="${escA(v)}"`;
    }
    if (!lite) {
      if (upper === "INPUT" || upper === "TEXTAREA" || upper === "SELECT") attrs += ` data-live-value="${escA(safeValue(node))}"`;
      if (node.checked) attrs += ` data-live-checked="true"`;
      if (upper === "OPTION" && node.selected) attrs += ` data-live-selected="true"`;
    }
    if (VOID.has(lower)) { out.push(`${pad}<${lower}${attrs}>${nl}`); return; }

    out.push(`${pad}<${lower}${attrs}>${nl}`);
    node.childNodes.forEach((c) => ser(c, depth + 1, out, lite));
    const sr = opts.includeShadow ? shadowOf(node) : null;
    if (sr) {
      out.push(`${pad}  <shadow-root>${nl}`);
      sr.childNodes.forEach((c) => ser(c, depth + 2, out, lite));
      out.push(`${pad}  </shadow-root>${nl}`);
    }
    if (upper === "IFRAME") {
      out.push(`${pad}  <!-- iframe src=${escA(node.src || "")} : recorded separately by its own frame -->${nl}`);
    }
    out.push(`${pad}</${lower}>${nl}`);
  }
  const buildHtml = (lite) => { const out = []; ser(document.documentElement, 0, out, lite); return out.join(""); };

  // ---------- 2. Roots / elements ----------
  function collect() {
    const roots = [document];
    const all = [];
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      root.querySelectorAll("*").forEach((el) => {
        all.push({ el, root });
        if (opts.includeShadow) {
          const sr = shadowOf(el);
          if (sr) roots.push(sr);
        }
      });
    }
    return { roots, all };
  }

  function controlLabel(el) {
    const byId = (id) => {
      const n = el.getRootNode().getElementById?.(id) || document.getElementById(id);
      return n ? txt(n, 200) : "";
    };
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = clean(lb.split(/\s+/).map(byId).join(" ")); if (t) return t; }
    const al = el.getAttribute("aria-label");
    if (al) return clean(al);
    if (el.labels?.length) { const t = clean([...el.labels].map((l) => txt(l, 200)).join(" ")); if (t) return t; }
    const wrap = el.closest?.("label");
    if (wrap) { const t = txt(wrap, 200); if (t) return t; }
    if (el.type === "radio" || el.type === "checkbox") {
      let n = el.nextSibling;
      while (n && n.nodeType === 3 && !n.textContent.trim()) n = n.nextSibling;
      if (n) { const t = n.nodeType === 3 ? clean(n.textContent) : txt(n, 200); if (t) return t; }
      const p = el.parentElement && txt(el.parentElement, 200);
      if (p && p.length < 120) return p;
    }
    return clean(el.placeholder || el.title || "");
  }

  function describe(el, root) {
    const data = {};
    for (const a of el.attributes) if (a.name.startsWith("data-")) data[a.name] = a.value.slice(0, 200);
    const tag = el.localName;
    const r = el.getBoundingClientRect();
    const rec = {
      selector: sel(el),
      tag,
      id: el.id || undefined,
      classes: el.classList.length ? [...el.classList] : undefined,
      role: el.getAttribute("role") || undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      label: ["input", "select", "textarea"].includes(tag) ? controlLabel(el) || undefined : undefined,
      type: el.getAttribute("type") || undefined,
      name: el.getAttribute("name") || undefined,
      value: ["input", "textarea", "select"].includes(tag) ? safeValue(el) : undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      checked: el.checked || undefined,
      ariaChecked: el.getAttribute("aria-checked") || el.getAttribute("aria-pressed") || el.getAttribute("aria-selected") || undefined,
      disabled: el.disabled || undefined,
      readOnly: el.readOnly || undefined,
      required: el.required || undefined,
      min: el.getAttribute("min") || undefined,
      max: el.getAttribute("max") || undefined,
      step: el.getAttribute("step") || undefined,
      pattern: el.getAttribute("pattern") || undefined,
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      href: el.getAttribute("href")?.slice(0, 300) || undefined,
      src: el.getAttribute("src") ? (el.getAttribute("src").startsWith("data:") ? "data:…" : el.getAttribute("src").slice(0, 300)) : undefined,
      alt: el.getAttribute("alt") || undefined,
      title: el.getAttribute("title") || undefined,
      draggable: el.getAttribute("draggable") === "true" || undefined,
      contentEditable: el.isContentEditable && el.getAttribute("contenteditable") !== null ? true : undefined,
      tabindex: el.getAttribute("tabindex") || undefined,
      dataAttrs: Object.keys(data).length ? data : undefined,
      text: txt(el, opts.maxTextLength) || undefined,
      visible: isVisible(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      shadowHost: root !== document ? sel(root.host) : undefined,
    };
    if (tag === "select") {
      rec.multiple = el.multiple || undefined;
      rec.options = [...el.options].map((o) => ({ value: o.value, text: clean(o.text), selected: o.selected || undefined, disabled: o.disabled || undefined }));
    }
    return rec;
  }

  function summarize(all) {
    const out = [];
    for (const { el, root } of all) {
      if (out.length >= opts.maxElements) break;
      let interesting = !!el.id || el.matches(NOTABLE);
      if (!interesting) for (const a of el.attributes) if (a.name.startsWith("data-")) { interesting = true; break; }
      if (interesting) out.push(describe(el, root));
    }
    return out;
  }

  // ---------- 3. Question detection ----------
  function commonAncestor(els) {
    if (els.length === 1) return els[0].parentElement || els[0];
    let a = els[0].parentElement;
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a || els[0];
  }

  // Walk up from `start` until the container has some text beyond the options themselves.
  function findPrompt(start, labels, countInside, limit) {
    let el = start;
    for (let i = 0; i < 4 && el && el !== document.body && el !== document.documentElement; i++) {
      if (el.matches?.("fieldset")) {
        const lg = el.querySelector(":scope > legend");
        if (lg) return { text: txt(lg, 400), el };
      }
      const al = el.getAttribute?.("aria-label");
      if (al && el.matches("[role=group],[role=radiogroup],fieldset")) return { text: clean(al), el };
      if (countInside(el) > limit) break;
      let t = txt(el, 2000);
      for (const l of labels) if (l) t = t.replace(l, "");
      t = clean(t);
      if (t.length >= 3) return { text: t.slice(0, 500), el };
      el = el.parentElement;
    }
    return { text: "", el: start };
  }

  const controlCount = (el) => el.querySelectorAll("input:not([type=hidden]), select, textarea").length;

  function detectQuestions(roots) {
    const qs = [];
    const q = (s) => roots.flatMap((r) => [...r.querySelectorAll(s)]);
    const groupBy = (arr, keyFn) => {
      const m = new Map();
      arr.forEach((x) => { const k = keyFn(x); (m.get(k) || m.set(k, []).get(k)).push(x); });
      return [...m.values()];
    };

    // radios + checkboxes
    for (const kind of ["radio", "checkbox"]) {
      const inputs = q(`input[type=${kind}]`);
      const groups = groupBy(inputs, (el) =>
        el.name ? `n:${el.name}:${uid(el.form || el.getRootNode())}` : `p:${uid(el.parentElement)}`
      );
      for (const g of groups) {
        const labels = g.map(controlLabel);
        const p = findPrompt(commonAncestor(g), labels, controlCount, g.length);
        qs.push({
          type: kind === "radio" ? "single-choice" : g.length > 1 ? "multiple-choice" : "checkbox",
          prompt: p.text,
          container: sel(p.el),
          name: g[0].name || undefined,
          required: g.some((i) => i.required) || undefined,
          visible: isVisible(g[0]),
          options: g.map((i, k) => ({ label: labels[k], value: i.value, checked: i.checked, disabled: i.disabled || undefined, selector: sel(i) })),
        });
      }
    }

    // single controls
    q("input, select, textarea, [contenteditable]:not([contenteditable='false'])").forEach((el) => {
      const tag = el.localName;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (tag === "input" && ["radio", "checkbox", "hidden", "submit", "button", "reset", "image", "password"].includes(type)) return;
      if (tag !== "input" && tag !== "select" && tag !== "textarea" && el.closest("input, textarea")) return;
      const label = tag === "input" || tag === "select" || tag === "textarea" ? controlLabel(el) : clean(el.getAttribute("aria-label") || "");
      let kind;
      if (tag === "select") kind = el.multiple ? "multi-select" : "dropdown";
      else if (tag === "textarea") kind = "long-text";
      else if (tag !== "input") kind = "rich-text";
      else if (type === "number") kind = "number";
      else if (type === "range") kind = "slider";
      else if (type === "file") kind = "file-upload";
      else if (["date", "time", "datetime-local", "month", "week"].includes(type)) kind = "date-time";
      else if (type === "color") kind = "color";
      else kind = "short-text";
      const p = findPrompt(el.parentElement || el, [label], (c) => controlCount(c) + c.querySelectorAll("[contenteditable]").length, 1);
      const rec = { type: kind, prompt: p.text, label: label || undefined, container: sel(p.el), selector: sel(el), name: el.getAttribute("name") || undefined, required: el.required || undefined, visible: isVisible(el) };
      if (tag === "select") rec.options = [...el.options].map((o) => ({ value: o.value, label: clean(o.text), checked: o.selected }));
      if (type === "range" || type === "number") { rec.min = el.min; rec.max = el.max; rec.step = el.step; }
      qs.push(rec);
    });

    // ARIA radio groups / listboxes without native inputs
    q("[role=radiogroup], [role=listbox]").forEach((g) => {
      const items = [...g.querySelectorAll("[role=radio], [role=option]")];
      if (items.length < 2 || g.querySelector("input[type=radio]")) return;
      const labels = items.map((i) => txt(i, 200));
      const p = findPrompt(g, labels, (c) => c.querySelectorAll("[role=radio], [role=option]").length, items.length);
      qs.push({
        type: g.getAttribute("role") === "listbox" ? "listbox" : "single-choice-aria",
        prompt: clean(g.getAttribute("aria-label") || "") || p.text,
        container: sel(g),
        visible: isVisible(g),
        options: items.map((i, k) => ({ label: labels[k], checked: i.getAttribute("aria-checked") === "true" || i.getAttribute("aria-selected") === "true", selector: sel(i) })),
      });
    });

    // drag & drop (ordering / matching)
    groupBy(q("[draggable='true']"), (el) => uid(el.parentElement)).forEach((g) => {
      if (g.length < 2) return;
      const labels = g.map((i) => txt(i, 150));
      const p = findPrompt(commonAncestor(g), labels, (c) => c.querySelectorAll("[draggable='true']").length, g.length);
      qs.push({ type: "drag-drop", prompt: p.text, container: sel(p.el), visible: isVisible(g[0]), options: g.map((i, k) => ({ label: labels[k], selector: sel(i) })) });
    });

    // div/button-based choices (custom quiz markup): leaf-most "option/choice/answer" elements grouped by parent
    const cands = q(CUSTOM_OPT).filter(
      (el) => !el.closest("select") && !el.querySelector("input, select, textarea") && !el.querySelector(CUSTOM_OPT)
    );
    groupBy(cands, (el) => uid(el.parentElement)).forEach((g) => {
      if (g.length < 2) return;
      const labels = g.map((i) => txt(i, 200));
      const p = findPrompt(commonAncestor(g), labels, (c) => c.querySelectorAll(CUSTOM_OPT).length, g.length);
      qs.push({
        type: "custom-choice",
        prompt: p.text,
        container: sel(p.el),
        visible: isVisible(g[0]),
        options: g.map((i, k) => ({
          label: labels[k],
          selector: sel(i),
          classes: [...i.classList],
          ariaState: i.getAttribute("aria-checked") || i.getAttribute("aria-pressed") || i.getAttribute("aria-selected") || undefined,
        })),
      });
    });
    return qs;
  }

  // ---------- 4. Capture ----------
  async function capture(reason, force = false) {
    if (!alive() || !document.documentElement) return;
    if (!force && !recording) return;
    if (!force && !IS_TOP && !(document.body && document.body.children.length)) return;
    const href = location.href;
    if (!force && (perUrl.get(href) || 0) >= opts.maxSnapshotsPerUrl) return;

    let body = null, fp;
    if (opts.captureStateChanges) { body = buildHtml(false); fp = hash(body); }
    else fp = hash(buildHtml(true));
    if (!force && fp === lastHash) return;
    if (body === null) body = buildHtml(false);

    const { roots, all } = collect();
    if (observer) roots.forEach(observeRoot);
    const elements = summarize(all);
    const questions = detectQuestions(roots);
    const t = Date.now();
    const meta = {
      key: href + "|" + fp,
      t,
      iso: new Date(t).toISOString(),
      reason: firstCapture && reason !== "manual" ? "load" : reason,
      url: href,
      title: document.title,
      frame: { isTop: IS_TOP, name: window.name || undefined, referrer: IS_TOP ? undefined : document.referrer || undefined },
      hash: fp,
      viewport: { w: innerWidth, h: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), docH: document.documentElement.scrollHeight },
      elementCount: all.length,
      summarizedCount: elements.length,
      questionCount: questions.length,
      questionTypes: [...new Set(questions.map((x) => x.type))],
      questions,
      elements,
      visibleText: opts.includeVisibleText ? (document.body?.innerText || "").slice(0, 30000) : undefined,
    };
    const html = `<!-- Source: ${href} -->\n<!-- Captured: ${meta.iso} (${meta.reason}) -->\n<!doctype html>\n` + body;
    firstCapture = false;
    lastHash = fp;
    perUrl.set(href, (perUrl.get(href) || 0) + 1);
    await send({ type: "snapshot", meta, html, force });
  }

  function schedule(reason = "mutation") {
    if (!recording) return;
    if (reason === "navigation" || pendingReason !== "navigation") pendingReason = reason;
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(timer);
    const wait = now - firstPending > opts.maxWaitMs ? 0 : opts.settleMs;
    timer = setTimeout(() => {
      const r = pendingReason;
      firstPending = 0;
      pendingReason = "mutation";
      capture(r);
    }, wait);
  }

  // ---------- 5. Observing ----------
  function observeRoot(root) {
    if (!observer || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root === document ? document.documentElement : root, {
      subtree: true, childList: true, characterData: true, attributes: !!opts.captureStateChanges,
    });
  }
  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(() => schedule("mutation"));
    observeRoot(document);
  }
  function stopObserving() {
    observer?.disconnect();
    observer = null;
    observedRoots = new WeakSet();
    clearTimeout(timer);
  }

  function checkUrl() {
    if (location.href === lastHref) return;
    pushEvent("navigate", null, { from: lastHref, to: location.href });
    lastHref = location.href;
    schedule("navigation");
  }
  setInterval(checkUrl, 500);
  addEventListener("popstate", checkUrl);
  addEventListener("hashchange", checkUrl);

  // ---------- 6. Interaction log ----------
  function brief(el) {
    if (!el || el.nodeType !== 1) return {};
    return {
      selector: sel(el), tag: el.localName, id: el.id || undefined,
      classes: el.classList.length ? [...el.classList].slice(0, 4) : undefined,
      name: el.getAttribute("name") || undefined, inputType: el.getAttribute("type") || undefined,
      text: txt(el, 80) || undefined,
    };
  }
  function pushEvent(type, el, extra) {
    if (!recording || !opts.recordEvents) return;
    evBuf.push({ t: Date.now(), type, url: location.href, frame: IS_TOP ? "top" : location.href, ...brief(el), ...extra });
    if (evBuf.length >= 30) flushEvents();
    else if (!evTimer) evTimer = setTimeout(flushEvents, 1000);
  }
  function flushEvents() {
    clearTimeout(evTimer);
    evTimer = null;
    if (!evBuf.length) return;
    const events = evBuf;
    evBuf = [];
    send({ type: "events", events });
  }
  const target = (e) => { const t = e.composedPath?.()[0] || e.target; return t?.nodeType === 1 ? t : t?.parentElement; };
  const valueInfo = (el) => ({
    value: "value" in el ? safeValue(el) : undefined,
    checked: "checked" in el ? el.checked : undefined,
    selected: el.localName === "select" ? [...el.selectedOptions].map((o) => clean(o.text)) : undefined,
  });

  addEventListener("click", (e) => {
    const t = target(e);
    if (!t) return;
    const el = t.closest("a, button, label, input, select, textarea, summary, [role], [onclick], [draggable='true']") || t;
    pushEvent("click", el, { x: Math.round(e.clientX), y: Math.round(e.clientY), ...(el.matches("input, select, textarea") ? valueInfo(el) : {}) });
  }, true);
  addEventListener("change", (e) => { const t = target(e); if (t) { pushEvent("change", t, valueInfo(t)); if (opts.captureStateChanges) schedule("state"); } }, true);
  addEventListener("input", (e) => {
    const t = target(e);
    if (!t || !recording || !opts.recordEvents) return;
    clearTimeout(inputTimers.get(t));
    inputTimers.set(t, setTimeout(() => pushEvent("input", t, valueInfo(t)), 500));
  }, true);
  addEventListener("submit", (e) => { const t = target(e); pushEvent("submit", t, { action: t?.action }); }, true);
  addEventListener("keydown", (e) => {
    if (/^(Enter|Escape|Tab|Arrow\w+|Page\w+| )$/.test(e.key)) pushEvent("key", target(e), { key: e.key === " " ? "Space" : e.key });
  }, true);
  addEventListener("dragstart", (e) => pushEvent("dragstart", target(e)), true);
  addEventListener("drop", (e) => pushEvent("drop", target(e)), true);
  addEventListener("pagehide", flushEvents);

  // ---------- 7. State sync ----------
  async function refresh() {
    const r = await send({ type: "hello" });
    if (!r) return;
    opts = { ...opts, ...r.options };
    const was = recording;
    recording = !!r.record;
    if (recording) {
      stopObserving();
      startObserving();
      if (!was) schedule(firstCapture ? "load" : "start");
    } else {
      stopObserving();
      flushEvents();
    }
  }

  if (alive()) {
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type === "refresh") refresh();
      if (m.type === "snapshot-now") refresh().then(() => capture("manual", true));
    });
  }
  refresh();
})();
