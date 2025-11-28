// Change these URLs for production use. They point to localhost for testing.
const STEPS_API_URL = "http://localhost:8080/steps";
const POINTS_ENDPOINT = "http://localhost:8080/points";

const RECENT_MAX = 500;
const DEFAULT_RECENT_LIMIT = 20;

const K = {
  firedStepIds: "firedStepIds",
  totalPoints: "totalPoints",
  matchedStepsLog: "matchedStepsLog",

  recentEvents: "recentEvents",
  remoteSteps: "remoteSteps",
  stepsEtag: "stepsEtag",
  stepsStatus: "stepsStatus",
  currentUserEmail: "currentUserEmail",
};

function getSessionArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

async function loadLocal() {
  const {
    [K.firedStepIds]: firedStepIds = [],
    [K.totalPoints]: totalPoints = 0,
    [K.matchedStepsLog]: matchedStepsLog = [],
  } = await chrome.storage.local.get({
    [K.firedStepIds]: [],
    [K.totalPoints]: 0,
    [K.matchedStepsLog]: [],
  });
  return {
    firedStepIds: new Set(firedStepIds),
    totalPoints,
    matchedStepsLog,
  };
}

async function saveLocal(partial) {
  const payload = { ...partial };
  if (payload[K.firedStepIds] instanceof Set) {
    payload[K.firedStepIds] = Array.from(payload[K.firedStepIds]);
  }
  await chrome.storage.local.set(payload);
}

async function loadSession() {
  const ses = getSessionArea();
  const {
    [K.recentEvents]: recentEvents = [],
    [K.remoteSteps]: remoteSteps = null,
    [K.stepsEtag]: stepsEtag = null,
    [K.stepsStatus]: stepsStatus = null,
    [K.currentUserEmail]: currentUserEmail = null,
  } = await ses.get({
    [K.recentEvents]: [],
    [K.remoteSteps]: null,
    [K.stepsEtag]: null,
    [K.stepsStatus]: null,
    [K.currentUserEmail]: null,
  });
  return {
    recentEvents,
    remoteSteps,
    stepsEtag,
    stepsStatus,
    currentUserEmail,
  };
}

async function saveSession(partial) {
  const ses = getSessionArea();
  await ses.set(partial);
}

async function fetchStepsFromApi({ force = false } = {}) {
  try {
    const { stepsEtag } = await loadSession();
    const headers = new Headers();
    if (!force && stepsEtag) headers.set("If-None-Match", stepsEtag);

    const res = await fetch(STEPS_API_URL, { method: "GET", headers });

    if (res.status === 304) {
      const { remoteSteps } = await loadSession();
      const count = Array.isArray(remoteSteps) ? remoteSteps.length : 0;
      await saveSession({
        [K.stepsStatus]: {
          ok: true,
          message: "Steps up-to-date (304)",
          lastFetchedISO: new Date().toISOString(),
          count,
          etag: stepsEtag || null,
        },
      });
      return remoteSteps;
    }

    if (!res.ok) {
      await saveSession({
        [K.stepsStatus]: {
          ok: false,
          message: `Steps fetch failed (HTTP ${res.status})`,
          lastFetchedISO: new Date().toISOString(),
        },
      });
      return null;
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      await saveSession({
        [K.stepsStatus]: {
          ok: false,
          message: "Invalid steps payload",
          lastFetchedISO: new Date().toISOString(),
        },
      });
      return null;
    }

    const etag = res.headers.get("ETag") || null;
    await saveSession({
      [K.remoteSteps]: data,
      [K.stepsEtag]: etag,
      [K.stepsStatus]: {
        ok: true,
        message: "Steps loaded",
        lastFetchedISO: new Date().toISOString(),
        count: data.length,
        etag,
      },
    });
    return data;
  } catch (err) {
    await saveSession({
      [K.stepsStatus]: {
        ok: false,
        message: `Steps fetch error: ${err?.message || String(err)}`,
        lastFetchedISO: new Date().toISOString(),
      },
    });
    return null;
  }
}

async function getActiveSteps() {
  const { remoteSteps } = await loadSession();
  return Array.isArray(remoteSteps) ? remoteSteps : [];
}

async function ensureStepsLoaded() {
  const { remoteSteps } = await loadSession();
  if (Array.isArray(remoteSteps)) return true;
  const fetched = await fetchStepsFromApi({ force: false });
  return Array.isArray(fetched);
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path
    .split(".")
    .reduce(
      (acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined),
      obj
    );
}
function normIfCI(v, ci) {
  return ci && typeof v === "string" ? v.toLowerCase() : v;
}

function cmpString(actual, op, expected, ci = false) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = normIfCI(actual, ci);
  const e = normIfCI(expected, ci);
  switch (op) {
    case "equals":
      return a === e;
    case "includes":
    case "contains":
      return a.includes(e);
    case "startsWith":
      return a.startsWith(e);
    case "endsWith":
      return a.endsWith(e);
    case "regex":
      return new RegExp(expected, ci ? "i" : undefined).test(actual);
    default:
      return false;
  }
}
function cmpScalar(actual, op, expected) {
  switch (op) {
    case "equals":
      return actual === expected;
    case "exists":
      return actual !== undefined && actual !== null;
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    default:
      return false;
  }
}
function cmpAnyOf(actual, values, ci = false) {
  if (!Array.isArray(values)) return false;
  if (typeof actual === "string") {
    const a = normIfCI(actual, ci);
    return values.some((v) =>
      typeof v === "string" ? a === normIfCI(v, ci) : a === v
    );
  }
  return values.some((v) => actual === v);
}

function matchFlatMap(event, flat) {
  return Object.entries(flat).every(([k, v]) => {
    const actual = getPath(event, k);
    if (typeof v === "string")
      return cmpString(String(actual ?? ""), "includes", v, false);
    return actual === v;
  });
}

function matchesLogical(event, node) {
  if (!node) return true;
  if (node.all) return node.all.every((c) => matchesLogical(event, c));
  if (node.any) return node.any.some((c) => matchesLogical(event, c));
  if (node.none) return node.none.every((c) => !matchesLogical(event, c));
  if (node.scope) return node.scope.every((c) => matchesLogical(event, c));
  const cond = node;
  if (!cond || typeof cond !== "object") return false;
  if (
    !cond.field &&
    !cond.op &&
    cond.value === undefined &&
    !cond.anyOf &&
    !cond.all &&
    !cond.any &&
    !cond.none &&
    !cond.scope
  ) {
    return matchFlatMap(event, cond);
  }
  const { field, op = "equals", value, anyOf, ci = false } = cond;
  const actual = getPath(event, field);
  if (op === "anyOf" || anyOf) return cmpAnyOf(actual, value ?? anyOf, ci);
  if (typeof actual === "string" || typeof value === "string") {
    return cmpString(String(actual ?? ""), op, String(value ?? ""), ci);
  }
  return cmpScalar(actual, op, value);
}

function sequenceSatisfied(events, sequenceNode, nowIdx) {
  const { withinMs = 5 * 60 * 1000, steps = [] } = sequenceNode || {};
  if (!steps.length) return false;
  if (!Array.isArray(events) || !events.length) return false;

  const endTime = new Date(events[nowIdx]?.time || Date.now()).getTime();
  const startTime = endTime - withinMs;

  const windowEvents = [];
  for (let i = 0; i <= nowIdx; i++) {
    const ev = events[i];
    if (!ev || !ev.time) continue;
    const t = new Date(ev.time).getTime();
    if (t >= startTime && t <= endTime) windowEvents.push(ev);
  }
  if (!windowEvents.length) return false;

  let stepPos = 0;
  for (const ev of windowEvents) {
    if (matchesLogical(ev, steps[stepPos])) {
      stepPos++;
      if (stepPos === steps.length) return true;
    }
  }
  return false;
}
function matchesCriteriaAdvanced(event, allEvents, idx, criteria) {
  if (!criteria) return false;
  if (criteria.sequence)
    return sequenceSatisfied(allEvents, criteria.sequence, idx);
  return matchesLogical(event, criteria);
}

function matchEventAgainstUnfiredSteps(
  event,
  allEvents,
  idx,
  steps,
  firedStepIds
) {
  const stepsWithCriteria = steps.filter(
    (s) => s.criteria && typeof s.criteria === "object"
  );
  const newlyFired = [];
  for (const step of stepsWithCriteria) {
    if (firedStepIds.has(step.id)) continue;
    const ok = matchesCriteriaAdvanced(event, allEvents, idx, step.criteria);
    if (ok)
      newlyFired.push({ id: step.id, step: step.step, points: step.points });
  }
  return newlyFired;
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      await fetchStepsFromApi({ force: false });
      await rehydrateProgressFromRecent();
    })()
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "setCurrentUserEmail") {
    const email = typeof message.email === "string" ? message.email.trim() : "";
    const val = email.length ? email : null;
    console.log("SW: setCurrentUserEmail received");
    saveSession({ [K.currentUserEmail]: val })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message && message.action === "getCurrentUserEmail") {
    const ses = getSessionArea();
    ses
      .get({ [K.currentUserEmail]: null })
      .then((obj) => sendResponse({ email: obj[K.currentUserEmail] ?? null }))
      .catch(() => sendResponse({ email: null }));
    return true;
  }

  if (message && message.action === "enqueueEvent") {
    enqueueEvent(message.payload).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message && message.action === "getRecentEvents") {
    const limit = Number.isFinite(message.limit)
      ? Math.max(1, Math.min(message.limit, 200))
      : DEFAULT_RECENT_LIMIT;
    getRecentEvents(limit).then((events) => sendResponse({ events }));
    return true;
  }

  if (message && message.action === "getPoints") {
    chrome.storage.local
      .get({ [K.totalPoints]: 0 })
      .then((obj) => sendResponse({ totalPoints: obj[K.totalPoints] || 0 }));
    return true;
  }

  if (message && message.action === "getFiredSteps") {
    chrome.storage.local
      .get({ [K.firedStepIds]: [], [K.matchedStepsLog]: [] })
      .then((obj) =>
        sendResponse({
          firedStepIds: obj[K.firedStepIds] || [],
          matchedStepsLog: obj[K.matchedStepsLog] || [],
        })
      );
    return true;
  }

  if (message && message.action === "getStepsStatus") {
    const ses = getSessionArea();
    ses
      .get({ [K.stepsStatus]: null })
      .then((obj) => sendResponse({ status: obj[K.stepsStatus] || null }));
    return true;
  }

  if (message && message.action === "refreshSteps") {
    fetchStepsFromApi({ force: true }).then((data) => {
      const count = Array.isArray(data) ? data.length : 0;
      sendResponse({ ok: count > 0, count });
    });
    return true;
  }

  if (message && message.action === "resetProgress") {
    chrome.storage.local
      .set({
        [K.firedStepIds]: [],
        [K.totalPoints]: 0,
        [K.matchedStepsLog]: [],
      })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function enqueueEvent(ev) {
  try {
    await ensureStepsLoaded();

    const { recentEvents, currentUserEmail } = await loadSession();

    recentEvents.push(ev);
    if (recentEvents.length > RECENT_MAX) {
      recentEvents.splice(0, recentEvents.length - RECENT_MAX);
    }
    if (!currentUserEmail) {
      console.log("SW: No email found. Skipping matching/points for", ev.type);
      await saveSession({ [K.recentEvents]: recentEvents });
      return;
    }

    const { firedStepIds, totalPoints, matchedStepsLog } = await loadLocal();
    console.log("SW event:", ev.type, "email=", ev.userEmail);
    const steps = await getActiveSteps();
    const idx = recentEvents.length - 1;
    const newlyFired = steps.length
      ? matchEventAgainstUnfiredSteps(
          ev,
          recentEvents,
          idx,
          steps,
          firedStepIds
        )
      : [];

    let newTotal = totalPoints;
    if (newlyFired.length) {
      for (const m of newlyFired) {
        firedStepIds.add(m.id);
        newTotal += m.points || 0;
        matchedStepsLog.push({ ...m, matchedAtISO: new Date().toISOString() });
      }

      postAwards(newlyFired, newTotal).catch((err) => {
        console.warn("postAwards failed:", err);
      });
    }

    await saveSession({ [K.recentEvents]: recentEvents });
    await saveLocal({
      [K.firedStepIds]: firedStepIds,
      [K.totalPoints]: newTotal,
      [K.matchedStepsLog]: matchedStepsLog,
    });
  } catch (err) {
    console.error("enqueueEvent error", err);
  }
}

async function getRecentEvents(limit = DEFAULT_RECENT_LIMIT) {
  const { recentEvents } = await loadSession();
  if (!recentEvents?.length) return [];
  const slice = recentEvents.slice(-limit);
  return slice.reverse(); // newest first
}

async function postAwards(awards, totalPoints) {
  try {
    const ses = getSessionArea();
    const { [K.currentUserEmail]: currentUserEmail = null } = await ses.get({
      [K.currentUserEmail]: null,
    });
    const client = {
      ua:
        typeof navigator !== "undefined" && navigator.userAgent
          ? navigator.userAgent
          : "sw",
      version: chrome.runtime.getManifest?.().version || "dev",
    };
    const body = JSON.stringify({
      awards,
      totalPoints,
      client,
      email: currentUserEmail,
    });
    const res = await fetch(POINTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn("postAwards error:", err);
    throw err;
  }
}

async function rehydrateProgressFromRecent() {
  try {
    const { recentEvents } = await loadSession();
    if (!recentEvents.length) return;

    await ensureStepsLoaded();
    const steps = await getActiveSteps();
    if (!steps.length) return;

    const { firedStepIds, totalPoints, matchedStepsLog } = await loadLocal();

    let newTotal = totalPoints;
    const sessionAwards = [];

    for (let i = 0; i < recentEvents.length; i++) {
      const ev = recentEvents[i];
      const newlyFired = matchEventAgainstUnfiredSteps(
        ev,
        recentEvents,
        i,
        steps,
        firedStepIds
      );
      if (!newlyFired.length) continue;

      for (const m of newlyFired) {
        firedStepIds.add(m.id);
        newTotal += m.points || 0;
        const entry = { ...m, matchedAtISO: new Date().toISOString() };
        matchedStepsLog.push(entry);
        sessionAwards.push(entry);
      }
    }

    if (sessionAwards.length) {
      postAwards(sessionAwards, newTotal).catch((err) =>
        console.warn("postAwards (rehydrate) failed:", err)
      );

      await saveLocal({
        [K.firedStepIds]: firedStepIds,
        [K.totalPoints]: newTotal,
        [K.matchedStepsLog]: matchedStepsLog,
      });
    }
  } catch (err) {
    console.warn("rehydrateProgressFromRecent error", err);
  }
}
