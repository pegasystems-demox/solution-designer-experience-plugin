(() => {
  const DEDUPE_CLICK_WINDOW_MS = 250;
  const SELECTOR_MAX_DEPTH = 5;
  const MAX_QUERY_KEYS = 25;
  const ENABLE_KEYSTROKE_SNAPSHOT = true;
  const KEY_SNAPSHOT_INTERVAL_MS = 1000;
  const EMIT_PER_KEY_EVENT = true;
  const isTopFrame = window.top === window.self;

  let cachedEmail = null;
  let lastEmailFetchTs = 0;
  let userEmail = null;
  function readEmailFromDom() {
    try {
      const el = document.getElementById("lmms-user-email");
      if (!el) return null;
      const val = typeof el.value === "string" ? el.value.trim() : null;
      return val && val.length ? val : null;
    } catch {
      return null;
    }
  }

  if (isTopFrame) {
    if (!window.__demoxEmailInit) {
      window.__demoxEmailInit = true;

      let observer = null;
      let obsTimeoutId = null;
      let emailLogged = false;

      function onEmailDetected(val) {
        if (!val || userEmail) return;
        userEmail = val;

        try {
          window.userEmail = userEmail;
          chrome.runtime.sendMessage({
            action: "setCurrentUserEmail",
            email: userEmail,
          });
        } catch {
          console.log("Unable to set window.userEmail");
        }

        if (!emailLogged) {
          console.debug("User email detected :", userEmail);
          emailLogged = true;
        }
        if (observer) {
          try {
            observer.disconnect();
          } catch {}
          observer = null;
        }
        if (obsTimeoutId) {
          clearTimeout(obsTimeoutId);
          obsTimeoutId = null;
        }
      }

      const initial = readEmailFromDom();
      if (initial) onEmailDetected(initial);

      if (!userEmail) {
        setTimeout(() => {
          const val = readEmailFromDom();
          if (val) onEmailDetected(val);
        }, 500);
      }

      if (!userEmail) {
        try {
          observer = new MutationObserver(() => {
            const val = readEmailFromDom();
            if (val) onEmailDetected(val);
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
          obsTimeoutId = setTimeout(() => {
            if (!userEmail) {
              try {
                window.userEmail = null;
                chrome.runtime.sendMessage({
                  action: "setCurrentUserEmail",
                  email: null,
                });
                chrome.runtime.sendMessage({ action: "resetProgress" });
              } catch {
                console.log("Unable to set window.userEmail");
              }
              console.debug(
                "User email not found within observation window (user likely not logged in)."
              );
            }
            if (observer) {
              try {
                observer.disconnect();
              } catch {}
              observer = null;
            }
            obsTimeoutId = null;
          }, 10000);
        } catch {}
      }
    }
  }

  function fetchEmailFromSW(force = false) {
    const now = Date.now();
    if (!force && cachedEmail !== null && now - lastEmailFetchTs < 2000) {
      return Promise.resolve(cachedEmail);
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "getCurrentUserEmail" }, (res) => {
          const email =
            res && typeof res.email === "string" && res.email.length
              ? res.email
              : null;
          cachedEmail = email;
          lastEmailFetchTs = now;
          resolve(cachedEmail);
        });
      } catch {
        resolve(cachedEmail);
      }
    });
  }

  function getCurrentUserEmailFast() {
    const email = readEmailFromDom();
    console.log(email);
    if (typeof email === "string" && email.length) {
      try {
        window.userEmail = email;
        chrome.runtime.sendMessage({
          action: "setCurrentUserEmail",
          email: email,
        });
      } catch {
        console.log("Unable to set window.userEmail");
      } finally {
        return email;
      }
    }
    if (typeof userEmail === "string" && userEmail.length) return userEmail;
    return cachedEmail;
  }

  function parseUrl(href) {
    try {
      const u = new URL(href);
      const queryKeys = Array.from(u.searchParams.keys()).slice(
        0,
        MAX_QUERY_KEYS
      );
      return {
        origin: u.origin,
        pathname: u.pathname,
        queryKeys,
        search: u.search,
      };
    } catch {
      return { origin: null, pathname: null, queryKeys: [], search: "" };
    }
  }

  function viewportBucket() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bw = w >= 1200 ? "lg" : w >= 768 ? "md" : "sm";
    const bh = h >= 800 ? "tall" : "short";
    return `${bw}-${bh}`;
  }

  function cssEscape(str) {
    return String(str).replace(/(["\\#.:;?=*\\[\\]{}()<>$^|])/g, "\\$1");
  }

  function shortestUniqueSelector(el) {
    try {
      const parts = [];
      let node = el,
        depth = 0;

      while (node && node.nodeType === 1 && depth < SELECTOR_MAX_DEPTH) {
        let sel = node.tagName.toLowerCase();

        if (node.id && node.id.length < 80) {
          sel += `#${cssEscape(node.id)}`;
          parts.unshift(sel);
          break; // good enough
        }

        const dataId =
          node.getAttribute("data-analytics-id") ||
          node.getAttribute("data-testid");
        if (dataId && dataId.length < 120)
          sel += `[data-analytics-id="${cssEscape(dataId)}"]`;

        const role = node.getAttribute("role");
        if (role) sel += `[role="${cssEscape(role)}"]`;

        const nameAttr = node.getAttribute("name");
        if (nameAttr && nameAttr.length < 80)
          sel += `[name="${cssEscape(nameAttr)}"]`;

        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName === node.tagName
          );
          if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            sel += `:nth-of-type(${idx})`;
          }
        }

        parts.unshift(sel);
        node = node.parentElement;
        depth++;
      }

      return parts.join(" > ");
    } catch {
      return null;
    }
  }

  function isElementVisible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      )
        return false;
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  function elementFingerprint(target) {
    const selector = shortestUniqueSelector(target) || null;
    const ariaLabel = target.getAttribute?.("aria-label") || null;
    const dataId =
      target.getAttribute?.("data-analytics-id") ||
      target.getAttribute?.("data-testid") ||
      null;
    const role = target.getAttribute?.("role") || null;
    const hidden = !isElementVisible(target);
    const text = (target.innerText || target.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return { selector, ariaLabel, dataId, role, hidden, text };
  }

  function readRawValue(target) {
    if (typeof target.value === "string") return target.value;
    if (target.isContentEditable)
      return target.innerText || target.textContent || "";
    return (target.innerText || target.textContent || "").trim();
  }

  function nearestFormInfo(target) {
    try {
      const form = target.closest && target.closest("form");
      if (!form) return null;
      return {
        id: form.id || null,
        name: form.getAttribute("name") || null,
        action: form.getAttribute("action") || form.action || null,
        method:
          (form.getAttribute("method") || form.method || "").toUpperCase() ||
          null,
      };
    } catch {
      return null;
    }
  }

  let routeVersion = 0;
  function bumpRouteVersion() {
    routeVersion++;
  }

  (function (history) {
    try {
      const push = history.pushState;
      const replace = history.replaceState;

      history.pushState = function () {
        const res = push.apply(this, arguments);
        bumpRouteVersion();
        sendNavigationEvent();
        return res;
      };
      history.replaceState = function () {
        const res = replace.apply(this, arguments);
        bumpRouteVersion();
        sendNavigationEvent();
        return res;
      };
    } catch {}
  })(window.history);

  window.addEventListener(
    "popstate",
    () => {
      bumpRouteVersion();
      sendNavigationEvent();
    },
    { capture: true }
  );

  async function sendNavigationEvent() {
    const { origin, pathname, queryKeys, search } = parseUrl(location.href);
    await fetchEmailFromSW();
    const payload = {
      type: "navigation",
      time: new Date().toISOString(),
      url: location.href,
      urlParts: { origin, pathname, queryKeys, search },
      pageTitle: document.title,
      visible: document.visibilityState === "visible",
      routeVersion,
      vp: viewportBucket(),
      isTop: window.top === window.self,
      userEmail: getCurrentUserEmailFast(),
    };
    safeSend({ action: "enqueueEvent", payload });
  }

  document.addEventListener(
    "visibilitychange",
    () => {
      const payload = {
        type: "visibility",
        time: new Date().toISOString(),
        url: location.href,
        pageTitle: document.title,
        visible: document.visibilityState === "visible",
        routeVersion,
        userEmail: getCurrentUserEmailFast(),
      };
      safeSend({ action: "enqueueEvent", payload });
    },
    { capture: true, passive: true }
  );

  let lastClick = { selector: null, t: 0 };

  async function captureEvent(type, e) {
    try {
      const target = e.target || e.srcElement;
      if (!target || !target.tagName) return;

      const tag = target.tagName || null;
      const id = target.id || null;
      const className =
        typeof target.className === "string" ? target.className : null;

      const fp = elementFingerprint(target);

      if ((type === "click" || type === "dblclick") && fp.selector) {
        const now = Date.now();
        if (
          fp.selector === lastClick.selector &&
          now - lastClick.t < DEDUPE_CLICK_WINDOW_MS &&
          type === "click"
        ) {
          return;
        }
        lastClick = { selector: fp.selector, t: now };
      }

      const { origin, pathname, queryKeys, search } = parseUrl(location.href);

      let value = null;
      let inputType = null;
      const tType = (target.type || "").toLowerCase();
      const isEditable = !!target.isContentEditable;
      const shouldReadValue =
        type === "input" ||
        type === "change" ||
        type === "keyup" ||
        type === "submit" ||
        isEditable;
      if (shouldReadValue) {
        inputType = tType || (isEditable ? "contenteditable" : null);
        value = readRawValue(target);
      }

      let files = null;
      let filesCount = null;
      if (
        type === "change" &&
        inputType === "file" &&
        target.files &&
        target.files.length
      ) {
        files = Array.from(target.files)
          .slice(0, 10)
          .map((f) => ({
            name: f.name,
            size: f.size,
            type: f.type,
            lastModified: f.lastModified,
          }));
        filesCount = target.files.length;
      }

      const formInfo = nearestFormInfo(target);

      // Pointer coords
      let x = null,
        y = null;
      if (typeof e.clientX === "number" && typeof e.clientY === "number") {
        x = e.clientX;
        y = e.clientY;
      } else if (target.getBoundingClientRect) {
        const rect = target.getBoundingClientRect();
        x = Math.round(rect.left);
        y = Math.round(rect.top);
      }

      const payload = {
        type,
        time: new Date().toISOString(),
        url: location.href,
        urlParts: { origin, pathname, queryKeys, search },
        pageTitle: document.title,
        visible: document.visibilityState === "visible",
        routeVersion,
        tag,
        id,
        className,
        selector: fp.selector,
        role: fp.role,
        ariaLabel: fp.ariaLabel,
        dataId: fp.dataId,
        hidden: fp.hidden,
        text: fp.text,
        x,
        y,
        vp: viewportBucket(),
        isTop: window.top === window.self,
        inputType,
        value,
        files,
        filesCount,
        formInfo,
        userEmail: getCurrentUserEmailFast(),
      };

      safeSend({ action: "enqueueEvent", payload });
    } catch {}
  }

  const events = [
    "click",
    "dblclick",
    "input",
    "change",
    "submit",
    "focus",
    "blur",
    "keyup",
  ];
  events.forEach((evt) => {
    document.addEventListener(
      evt,
      (e) => {
        captureEvent(evt, e);
      },
      { capture: true, passive: true }
    );
  });

  let keyBuffer = "";
  let lastKeyTargetSelector = null;

  document.addEventListener(
    "keydown",
    (e) => {
      try {
        const target = e.target || e.srcElement;
        if (!target || !target.tagName) return;

        keyBuffer += e.key;
        const fp = elementFingerprint(target);
        lastKeyTargetSelector = fp.selector;

        if (EMIT_PER_KEY_EVENT) {
          const { origin, pathname, queryKeys, search } = parseUrl(
            location.href
          );
          const payload = {
            type: "keystroke",
            time: new Date().toISOString(),
            url: location.href,
            urlParts: { origin, pathname, queryKeys, search },
            pageTitle: document.title,
            routeVersion,
            key: e.key,
            code: e.code,
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
            repeat: e.repeat,
            activeSelector: lastKeyTargetSelector,
            userEmail: getCurrentUserEmailFast(),
            isTop: window.top === window.self,
          };
          safeSend({ action: "enqueueEvent", payload });
        }
      } catch {}
    },
    { capture: true }
  );

  if (ENABLE_KEYSTROKE_SNAPSHOT) {
    setInterval(() => {
      try {
        if (!keyBuffer.length) return;
        const { origin, pathname, queryKeys, search } = parseUrl(location.href);
        const payload = {
          type: "keystroke_snapshot",
          time: new Date().toISOString(),
          url: location.href,
          urlParts: { origin, pathname, queryKeys, search },
          pageTitle: document.title,
          routeVersion,
          buffer: keyBuffer,
          activeSelector: lastKeyTargetSelector,
          isTop: window.top === window.self,
          userEmail: getCurrentUserEmailFast(),
        };
        safeSend({ action: "enqueueEvent", payload });
        keyBuffer = "";
        lastKeyTargetSelector = null;
      } catch {}
    }, KEY_SNAPSHOT_INTERVAL_MS);
  }
  function safeSend(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch {}
  }
  fetchEmailFromSW(true);
  setTimeout(() => {
    sendNavigationEvent();
  }, 200);
})();
