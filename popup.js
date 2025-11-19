const recentEl = document.getElementById("recent");
const statusEl = document.getElementById("status");
const pointsEl = document.getElementById("points");
const firedEl = document.getElementById("fired");

const stepsBadge = document.getElementById("stepsBadge");
const stepsMsg = document.getElementById("stepsMsg");
const stepsMeta = document.getElementById("stepsMeta");
const retryBtn = document.getElementById("retrySteps");

function set(el, text) {
  if (el) el.textContent = text;
}
function setHTML(el, html) {
  if (el) el.innerHTML = html;
}
function cls(el, add, remove) {
  if (!el) return;
  if (remove)
    el.classList.remove(...(Array.isArray(remove) ? remove : [remove]));
  if (add) el.classList.add(...(Array.isArray(add) ? add : [add]));
}
function disable(el, v) {
  if (el) el.disabled = !!v;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function limit(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function pretty(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}
function safeToString(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // signals to render as JSON
}
function typeClass(t) {
  const k = (t || "").toLowerCase();
  return [
    "click",
    "dblclick",
    "input",
    "change",
    "submit",
    "navigation",
    "keystroke",
    "keystroke_snapshot",
  ].includes(k)
    ? k
    : "";
}
function orderKeys(obj) {
  const preferred = [
    "type",
    "time",
    "urlParts",
    "url",
    "pageTitle",
    "visible",
    "routeVersion",
    "tag",
    "id",
    "className",
    "selector",
    "role",
    "ariaLabel",
    "dataId",
    "hidden",
    "x",
    "y",
    "vp",
    "isTop",
    "inputType",
    "value",
    "filesCount",
    "files",
    "text",
    "buffer",
    "activeSelector",
    "formInfo",
  ];
  const seen = new Set();
  const ordered = [];
  for (const k of preferred) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      ordered.push(k);
      seen.add(k);
    }
  }
  const rest = Object.keys(obj)
    .filter((k) => !seen.has(k))
    .sort((a, b) => a.localeCompare(b));
  return [...ordered, ...rest];
}

function renderStepsStatusUI(state) {
  if (!state) {
    set(stepsBadge, "Not loaded");
    cls(stepsBadge, ["error"], []);
    set(stepsMsg, "Steps not loaded yet.");
    set(stepsMeta, "");
    disable(retryBtn, false);
    return;
  }
  if (state.ok) {
    set(stepsBadge, "OK");
    cls(stepsBadge, [], ["error"]);
    const parts = [];
    if (typeof state.count === "number") parts.push(`Count: ${state.count}`);
    if (state.lastFetchedISO)
      parts.push(`Fetched: ${new Date(state.lastFetchedISO).toLocaleString()}`);
    if (state.etag) parts.push(`ETag: ${state.etag}`);
    set(stepsMsg, state.message || "Steps loaded");
    set(stepsMeta, parts.join("  •  "));
  } else {
    set(stepsBadge, "ERROR");
    cls(stepsBadge, ["error"], []);
    set(stepsMsg, state.message || "Failed to load steps");
    set(
      stepsMeta,
      state.lastFetchedISO
        ? `Last attempt: ${new Date(state.lastFetchedISO).toLocaleString()}`
        : ""
    );
  }
  disable(retryBtn, false);
}

function renderEventCard(ev, idx) {
  const t = new Date(ev.time || Date.now());
  const time = t.toLocaleTimeString();
  const type = ev.type || "event";
  const path = ev.urlParts?.pathname || (ev.url || "").split("?")[0] || "";
  const badgeCls = typeClass(type);

  const keys = orderKeys(ev);
  const rows = keys
    .map((k) => {
      const v = ev[k];
      const s = safeToString(v);
      if (s !== null) {
        const vv =
          k === "text" || k === "value"
            ? limit(escapeHtml(s), 500)
            : escapeHtml(s);
        const mono =
          k === "url" ||
          k === "selector" ||
          k === "id" ||
          k === "activeSelector"
            ? " mono"
            : "";
        return `<div class="kv"><div class="k">${escapeHtml(
          k
        )}</div><div class="v${mono}">${vv}</div></div>`;
      } else {
        return `<div class="kv"><div class="k">${escapeHtml(
          k
        )}</div><div class="v"><pre class="json mono">${escapeHtml(
          pretty(v)
        )}</pre></div></div>`;
      }
    })
    .join("");

  const shouldOpen = false;
  return `
    <div class="event-card ${shouldOpen ? "open" : ""}" data-idx="${idx}">
      <div class="event-header" data-toggle="${idx}">
        <div class="event-left">
          <span class="badge-type ${badgeCls}">${escapeHtml(type)}</span>
          <div class="header-detail mono">${escapeHtml(time)} • ${escapeHtml(
    path || "/"
  )}</div>
        </div>
        <div class="event-actions">
          <button class="toggle" data-toggle="${idx}">${
    shouldOpen ? "Hide" : "Show"
  }</button>
        </div>
      </div>
      <div class="event-body">${rows}</div>
    </div>
  `;
}

function bindCardToggles(container) {
  container.addEventListener("click", (e) => {
    const t = e.target;
    const id = t && t.getAttribute && t.getAttribute("data-toggle");
    if (!id) return;

    const card = container.querySelector(`.event-card[data-idx="${id}"]`);
    if (!card) return;

    const btn = card.querySelector(".toggle");
    const body = card.querySelector(".event-body");

    const open = card.classList.toggle("open");
    if (btn) btn.textContent = open ? "Hide" : "Show";

    if (open && body) {
      card.scrollIntoView({ block: "nearest", behavior: "smooth" });

      setTimeout(() => {
        // If user scrolls, the nested overflow will work
        // Optionally, we could call body.focus() with tabindex="-1" if needed
      }, 50);
    }
  });
}

function loadStepsStatus() {
  chrome.runtime.sendMessage({ action: "getStepsStatus" }, (res) => {
    const status = res && res.status ? res.status : null;
    renderStepsStatusUI(status);
  });
}
function loadPoints() {
  chrome.runtime.sendMessage({ action: "getPoints" }, (res) => {
    const totalPoints = (res && res.totalPoints) || 0;
    set(pointsEl, `Total Points: ${totalPoints}`);
  });
  chrome.runtime.sendMessage({ action: "getFiredSteps" }, (res) => {
    const log = (res && res.matchedStepsLog) || [];
    if (!log.length) {
      set(firedEl, "No steps fired yet.");
      return;
    }
    const txt = log
      .map((s) => `✅ [${s.id}] ${s.step} (+${s.points}) @ ${s.matchedAtISO}`)
      .join("\n");
    set(firedEl, txt);
  });
}
function loadRecent(limit = 20) {
  setHTML(recentEl, "Loading…");
  chrome.runtime.sendMessage({ action: "getRecentEvents", limit }, (res) => {
    const items = res && Array.isArray(res.events) ? res.events : [];
    if (!items.length) {
      set(recentEl, "No events yet.");
      set(statusEl, "Recent events: 0");
      return;
    }
    const html = items.map((ev, i) => renderEventCard(ev, i)).join("");
    setHTML(recentEl, html);
    bindCardToggles(recentEl);
    set(statusEl, `Recent events: ${items.length}`);
  });
}

async function refreshAll() {
  loadRecent(20);
  loadPoints();
  loadStepsStatus();
}

document.getElementById("refresh").addEventListener("click", refreshAll);
document.getElementById("reset").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "resetProgress" }, () => {
    set(statusEl, "Progress reset.");
    setTimeout(refreshAll, 300);
  });
});
retryBtn.addEventListener("click", () => {
  disable(retryBtn, true);
  set(retryBtn, "Retrying…");
  chrome.runtime.sendMessage({ action: "refreshSteps" }, (res) => {
    const ok = res && res.ok;
    set(
      stepsMsg,
      ok
        ? `Steps loaded (count: ${res.count})`
        : "Failed to load steps (see badge)."
    );
    set(retryBtn, "⟳ Retry Steps");
    disable(retryBtn, false);
    loadStepsStatus();
  });
});

// Initial load
refreshAll();
