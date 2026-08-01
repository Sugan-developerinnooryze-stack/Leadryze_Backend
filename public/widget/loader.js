"use strict";
(() => {
  // src/config.ts
  var API_BASE_URL = "http://localhost:5000/api/v1";

  // src/storage.ts
  var VISITOR_KEY = "__leadryze_visitor_id";
  var SESSION_KEY = "__leadryze_session_id";
  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === "x" ? r : r & 3 | 8;
      return v.toString(16);
    });
  }
  function getVisitorId() {
    try {
      let id = localStorage.getItem(VISITOR_KEY);
      if (!id) {
        id = uuid();
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch (e) {
      return uuid();
    }
  }
  function getSessionId() {
    try {
      let id = sessionStorage.getItem(SESSION_KEY);
      if (!id) {
        id = uuid();
        sessionStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (e) {
      return uuid();
    }
  }

  // src/ui.ts
  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
  function shade(hex, amount) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const clamp = (v) => Math.round(Math.max(0, Math.min(255, v)));
    const r = clamp((n >> 16 & 255) + 255 * amount);
    const g = clamp((n >> 8 & 255) + 255 * amount);
    const b = clamp((n & 255) + 255 * amount);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }
  var ICON_CHAT = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  var ICON_CHEVRON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  var QUICK_SUGGESTIONS = ["Book an appointment", "I have a question", "Talk to a human"];
  var WidgetUI = class {
    constructor(config, onSend) {
      this.open = false;
      this.typingEl = null;
      var _a;
      this.onSend = onSend;
      const host = document.createElement("div");
      host.id = "leadryze-widget-host";
      host.style.cssText = "all: initial; position: fixed; z-index: 2147483000;";
      document.body.appendChild(host);
      this.shadow = host.attachShadow({ mode: "open" });
      const template = (_a = config.template) != null ? _a : "modern";
      this.shadow.innerHTML = this.renderShell(config, template);
      this.bubbleEl = this.shadow.getElementById("lr-bubble");
      this.panelEl = this.shadow.getElementById("lr-panel");
      this.messagesEl = this.shadow.getElementById("lr-messages");
      this.inputEl = this.shadow.getElementById("lr-input");
      this.sendBtn = this.shadow.getElementById("lr-send");
      const closeEl = this.shadow.getElementById("lr-close");
      this.bubbleEl.addEventListener("click", () => this.toggle());
      closeEl.addEventListener("click", () => this.toggle());
      this.sendBtn.addEventListener("click", () => this.handleSend());
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.handleSend();
      });
      if (config.greeting) this.addMessage("assistant", config.greeting);
      if (template === "chips") this.renderQuickReplies("lr-chips", "lr-chip");
      if (template === "dark") this.renderQuickReplies("lr-actions", "lr-action");
    }
    /** Same suggestion list, rendered as either horizontal pills (chips
     * template) or a vertical stacked menu (dark template) — the wrapper/item
     * class names are the only difference; both send identically on click. */
    renderQuickReplies(wrapClass, itemClass) {
      const wrap = document.createElement("div");
      wrap.className = wrapClass;
      for (const label of QUICK_SUGGESTIONS) {
        const btn = document.createElement("button");
        btn.className = itemClass;
        btn.type = "button";
        btn.innerHTML = itemClass === "lr-action" ? `<span>${escapeHtml(label)}</span>${ICON_CHEVRON}` : escapeHtml(label);
        btn.addEventListener("click", () => {
          wrap.remove();
          this.sendText(label);
        });
        wrap.appendChild(btn);
      }
      this.messagesEl.appendChild(wrap);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    handleSend() {
      const text = this.inputEl.value.trim();
      if (!text) return;
      this.inputEl.value = "";
      this.sendText(text);
    }
    sendText(text) {
      this.addMessage("user", text);
      this.onSend(text);
    }
    toggle() {
      var _a;
      this.open = !this.open;
      this.panelEl.classList.toggle("lr-open", this.open);
      if (this.open) {
        this.panelEl.style.display = "flex";
        (_a = this.shadow.getElementById("lr-badge")) == null ? void 0 : _a.remove();
        requestAnimationFrame(() => this.inputEl.focus());
      } else {
        setTimeout(() => {
          if (!this.open) this.panelEl.style.display = "none";
        }, 160);
      }
    }
    addMessage(role, text) {
      if (role === "assistant" && this.typingEl) {
        this.typingEl.remove();
        this.typingEl = null;
      }
      const div = document.createElement("div");
      div.className = `lr-msg lr-msg-${role}`;
      div.textContent = text;
      this.messagesEl.appendChild(div);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    setBusy(busy) {
      var _a;
      this.sendBtn.disabled = busy;
      this.inputEl.disabled = busy;
      if (busy) {
        const div = document.createElement("div");
        div.className = "lr-msg lr-msg-assistant lr-typing";
        div.innerHTML = "<span></span><span></span><span></span>";
        this.messagesEl.appendChild(div);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        this.typingEl = div;
      } else {
        (_a = this.typingEl) == null ? void 0 : _a.remove();
        this.typingEl = null;
      }
    }
    renderShell(config, template) {
      const color = config.primaryColor || "#2563eb";
      const colorDark = shade(color, -0.18);
      const avatar = config.logoUrl ? `<img src="${escapeHtml(config.logoUrl)}" alt="" id="lr-avatar-img" />` : `<span id="lr-avatar-fallback">${escapeHtml((config.agentName || config.companyName || "?").charAt(0).toUpperCase())}</span>`;
      return `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  @keyframes lr-pop { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes lr-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
  @keyframes lr-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes lr-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Base \u2014 shared plumbing only \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-bubble {
    position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px; border-radius: 50%;
    border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
    background: ${color}; box-shadow: 0 10px 24px -6px ${color}66, 0 2px 8px rgba(0,0,0,0.15);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  #lr-bubble-wrap { position: fixed; right: 22px; bottom: 22px; }
  #lr-bubble-wrap #lr-bubble { position: static; }
  #lr-bubble:hover { transform: scale(1.06); box-shadow: 0 14px 28px -6px ${color}80, 0 2px 8px rgba(0,0,0,0.18); }
  #lr-bubble:active { transform: scale(.97); }

  #lr-panel {
    display: none; flex-direction: column; position: fixed; right: 22px; bottom: 96px;
    width: 336px; height: 470px; max-height: 72vh; background: #fff; border-radius: 18px;
    box-shadow: 0 20px 50px -12px rgba(15,23,42,0.3), 0 4px 14px rgba(15,23,42,0.1);
    overflow: hidden; opacity: 0; transform: translateY(10px) scale(.97);
    transition: opacity .16s ease, transform .16s ease;
  }
  #lr-panel.lr-open { opacity: 1; transform: translateY(0) scale(1); animation: lr-pop .16s ease; }

  #lr-header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; color: #fff; flex-shrink: 0; }
  #lr-avatar { width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,0.22);
    display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; font-weight: 700; font-size: 14px; }
  #lr-avatar-img { width: 100%; height: 100%; object-fit: cover; }
  #lr-header-text { flex: 1; min-width: 0; }
  #lr-header-name { display: block; font-size: 14px; font-weight: 600; letter-spacing: .1px; }
  #lr-header-sub { display: block; font-size: 11.5px; opacity: .85; margin-top: 1px; }
  #lr-close { background: rgba(255,255,255,0.14); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%;
    cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .15s ease; }
  #lr-close:hover { background: rgba(255,255,255,0.26); }
  #lr-status { display: none; align-items: center; gap: 6px; padding: 6px 16px 12px; font-size: 11px; color: #fff; margin-bottom: -1px; }
  #lr-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; animation: lr-pulse 1.8s infinite ease-in-out; }
  #lr-wave { display: none; width: 100%; height: 14px; margin-top: -1px; flex-shrink: 0; }

  #lr-badge { position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 999px;
    background: #ef4444; color: #fff; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center;
    border: 2px solid #fff; }

  #lr-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #f8f9fb; }
  #lr-messages::-webkit-scrollbar { width: 6px; }
  #lr-messages::-webkit-scrollbar-thumb { background: #d8dce3; border-radius: 3px; }

  .lr-msg { max-width: 82%; padding: 9px 13px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap;
    word-break: break-word; animation: lr-fade-in .18s ease; }
  .lr-msg-assistant { align-self: flex-start; background: #fff; border: 1px solid #e8eaee; color: #1e2430; }
  .lr-msg-user { align-self: flex-end; color: #fff; }

  .lr-typing { display: flex; align-items: center; gap: 4px; padding: 12px 14px; }
  .lr-typing span { width: 6px; height: 6px; border-radius: 50%; background: #a7adba; display: inline-block;
    animation: lr-bounce 1.2s infinite ease-in-out; }
  .lr-typing span:nth-child(2) { animation-delay: .15s; }
  .lr-typing span:nth-child(3) { animation-delay: .3s; }

  #lr-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #edeef2; background: #fff; flex-shrink: 0; }
  #lr-input { flex: 1; padding: 9px 13px; border: 1px solid #dfe2e8; border-radius: 22px; font-size: 13.5px;
    outline: none; transition: border-color .15s ease; }
  #lr-input:focus { border-color: ${color}; }
  #lr-send { border: none; color: #fff; background: ${color}; border-radius: 50%; width: 36px; height: 36px;
    cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform .1s ease, opacity .15s ease; }
  #lr-send:hover:not(:disabled) { transform: scale(1.06); }
  #lr-send:disabled, #lr-input:disabled { opacity: .55; cursor: default; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Modern \u2014 gradient header, wave transition, live-status, soft bubbles \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="modern"] #lr-header { background: linear-gradient(135deg, ${color}, ${colorDark}); padding-bottom: 8px; }
  #lr-panel[data-template="modern"] #lr-avatar { width: 40px; height: 40px; box-shadow: 0 0 0 2px rgba(255,255,255,0.4); }
  #lr-panel[data-template="modern"] #lr-status { display: flex; background: linear-gradient(135deg, ${color}, ${colorDark}); }
  #lr-panel[data-template="modern"] #lr-wave { display: block; }
  #lr-panel[data-template="modern"] .lr-msg-assistant { border-radius: 4px 16px 16px 16px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  #lr-panel[data-template="modern"] .lr-msg-user { background: ${color}; border-radius: 16px 4px 16px 16px; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Minimal Flat \u2014 bare, quiet, no avatar/status/shadow \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="minimal"] { border-radius: 8px; box-shadow: 0 2px 16px rgba(15,23,42,0.14); }
  #lr-panel[data-template="minimal"] #lr-header { background: ${color}; }
  #lr-panel[data-template="minimal"] #lr-avatar { display: none; }
  #lr-bubble[data-template="minimal"] { border-radius: 14px; box-shadow: 0 3px 10px rgba(0,0,0,0.16); }
  #lr-panel[data-template="minimal"] .lr-msg { border-radius: 6px; }
  #lr-panel[data-template="minimal"] .lr-msg-user { background: ${color}; }
  #lr-panel[data-template="minimal"] #lr-input { border-radius: 6px; }
  #lr-panel[data-template="minimal"] #lr-send { border-radius: 6px; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Compact Chips \u2014 icon avatar, horizontal pill quick-replies \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="chips"] #lr-header { background: ${color}; }
  #lr-panel[data-template="chips"] #lr-avatar { background: #fff; color: ${color}; }
  #lr-panel[data-template="chips"] .lr-msg { border-radius: 12px; }
  #lr-panel[data-template="chips"] .lr-msg-assistant { border-radius: 4px 12px 12px 12px; }
  #lr-panel[data-template="chips"] .lr-msg-user { background: ${color}; border-radius: 12px 4px 12px 12px; }
  .lr-chips { display: flex; flex-wrap: wrap; gap: 6px; animation: lr-fade-in .2s ease; }
  .lr-chip { border: 1.5px solid ${color}; background: #fff; color: ${color}; font-size: 12.5px; font-weight: 600;
    padding: 7px 12px; border-radius: 999px; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .lr-chip:hover { background: ${color}; color: #fff; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Dark Professional \u2014 dark chrome, vertical stacked action menu \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="dark"] { background: #f4f5f7; }
  #lr-panel[data-template="dark"] #lr-header { background: #1a1f2e; }
  #lr-panel[data-template="dark"] #lr-avatar { background: rgba(255,255,255,0.1); }
  #lr-panel[data-template="dark"] #lr-close { background: rgba(255,255,255,0.08); }
  #lr-panel[data-template="dark"] #lr-close:hover { background: rgba(255,255,255,0.16); }
  #lr-panel[data-template="dark"] #lr-messages { background: #f4f5f7; }
  #lr-panel[data-template="dark"] .lr-msg { border-radius: 4px 12px 12px 12px; }
  #lr-panel[data-template="dark"] .lr-msg-user { background: #1a1f2e; border-radius: 12px 4px 12px 12px; }
  #lr-panel[data-template="dark"] #lr-inputbar { background: #fff; border-top-color: #e4e6ea; }
  #lr-panel[data-template="dark"] #lr-send { background: ${color}; }
  /* Same list as Chips' pills, rendered as a vertical stacked menu instead \u2014
   * first item filled/primary, the rest outlined/secondary, matching the
   * HappyFox-style "one primary action + secondary options" pattern. */
  .lr-actions { display: flex; flex-direction: column; gap: 7px; width: 100%; animation: lr-fade-in .2s ease; }
  .lr-action { display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left;
    background: #fff; border: 1.5px solid ${color}; color: ${color}; font-size: 13px; font-weight: 600;
    padding: 10px 14px; border-radius: 999px; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .lr-action:hover { background: ${color}; color: #fff; }
  .lr-action:hover svg { color: #fff; }
  .lr-action svg { flex-shrink: 0; color: ${color}; margin-left: 8px; transition: color .15s ease; }
  .lr-action:first-child { background: ${color}; color: #fff; }
  .lr-action:first-child svg { color: #fff; }
  .lr-action:first-child:hover { background: ${colorDark}; }
</style>
<div id="lr-bubble-wrap">
  <button id="lr-bubble" data-template="${template}" aria-label="Open chat">${ICON_CHAT}</button>
  <span id="lr-badge">1</span>
</div>
<div id="lr-panel" data-template="${template}">
  <div id="lr-header">
    <div id="lr-avatar">${avatar}</div>
    <div id="lr-header-text">
      <span id="lr-header-name">${escapeHtml(config.agentName)}</span>
      <span id="lr-header-sub">${escapeHtml(config.companyName)}</span>
    </div>
    <button id="lr-close" aria-label="Close chat">${ICON_CLOSE}</button>
  </div>
  <div id="lr-status"><span id="lr-status-dot"></span>We're online</div>
  <svg id="lr-wave" viewBox="0 0 336 14" preserveAspectRatio="none"><path d="M0,0 C56,14 112,14 168,7 C224,0 280,0 336,7 L336,14 L0,14 Z" fill="#f8f9fb"/></svg>
  <div id="lr-messages"></div>
  <div id="lr-inputbar">
    <input id="lr-input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="lr-send" aria-label="Send">${ICON_SEND}</button>
  </div>
</div>`;
    }
  };

  // src/loader.ts
  function readScriptAttr(name) {
    var _a;
    const current = document.currentScript;
    if (current == null ? void 0 : current.dataset[name]) return current.dataset[name];
    const fallback = document.querySelector(`script[data-${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}]`);
    return (_a = fallback == null ? void 0 : fallback.dataset[name]) != null ? _a : null;
  }
  function getWidgetKey() {
    return readScriptAttr("widgetKey");
  }
  function getApiBaseUrl() {
    return readScriptAttr("apiUrl") || API_BASE_URL;
  }
  async function fetchConfig(widgetKey, apiBaseUrl) {
    try {
      const res = await fetch(`${apiBaseUrl}/public/widget/config?widgetKey=${encodeURIComponent(widgetKey)}`);
      if (!res.ok) return null;
      const body = await res.json();
      return body.data;
    } catch (e) {
      return null;
    }
  }
  async function sendChat(apiBaseUrl, widgetKey, sessionId, visitorId, message) {
    var _a, _b;
    try {
      const res = await fetch(`${apiBaseUrl}/public/widget/chat?widgetKey=${encodeURIComponent(widgetKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, visitorId, message, pageUrl: location.href })
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        return body.message || "Sorry, I'm having trouble responding right now.";
      }
      return (_b = (_a = body.data) == null ? void 0 : _a.response) != null ? _b : "Sorry, I didn't catch that.";
    } catch (e) {
      return "Sorry, I'm having trouble connecting right now. Please try again shortly.";
    }
  }
  async function init() {
    const widgetKey = getWidgetKey();
    if (!widgetKey) {
      console.warn("[LeadRyze Widget] Missing data-widget-key on the <script> tag \u2014 widget not loaded.");
      return;
    }
    const apiBaseUrl = getApiBaseUrl();
    const config = await fetchConfig(widgetKey, apiBaseUrl);
    if (!config) {
      console.warn("[LeadRyze Widget] Could not load widget config (disabled, unknown key, or disallowed origin) \u2014 widget not loaded.");
      return;
    }
    const visitorId = getVisitorId();
    const sessionId = getSessionId();
    const ui = new WidgetUI(config, async (message) => {
      ui.setBusy(true);
      const reply = await sendChat(apiBaseUrl, widgetKey, sessionId, visitorId, message);
      ui.addMessage("assistant", reply);
      ui.setBusy(false);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    });
  } else {
    void init();
  }
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvbmZpZy50cyIsICIuLi9zcmMvc3RvcmFnZS50cyIsICIuLi9zcmMvdWkudHMiLCAiLi4vc3JjL2xvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqIEJ1aWxkLXRpbWUgY29uc3RhbnQsIGlubGluZWQgYnkgYnVpbGQuanMncyBlc2J1aWxkIGBkZWZpbmVgIChyZWFkc1xuICogTEVBRFJZWkVfQVBJX0JBU0VfVVJMIGZyb20gLmVudiwgZmFsbHMgYmFjayB0byB0aGUgbG9jYWwgYmFja2VuZCBkZXZcbiAqIHNlcnZlcikuIFNlZSBnbG9iYWwuZC50cyBmb3Igd2h5IGBwcm9jZXNzLmVudmAgdHlwZS1jaGVja3MgaGVyZSB3aXRob3V0XG4gKiBAdHlwZXMvbm9kZS4gKi9cbmV4cG9ydCBjb25zdCBBUElfQkFTRV9VUkw6IHN0cmluZyA9IHByb2Nlc3MuZW52LkxFQURSWVpFX0FQSV9CQVNFX1VSTCBhcyBzdHJpbmc7XG4iLCAiLyoqIHZpc2l0b3JJZDogY3J5cHRvLnJhbmRvbVVVSUQoKSwgbG9jYWxTdG9yYWdlIFx1MjAxNCBzdXJ2aXZlcyByZWxvYWRzL25ldyB0YWJzXG4gKiAoc2FtZSBkdXJhYmlsaXR5IG1vZGVsIEludGVyY29tJ3Mgb3duIHdpZGdldCBpZGVudGl0eSB1c2VzKS5cbiAqIHNlc3Npb25JZDogZ2VuZXJhdGVkIHBlciBjb252ZXJzYXRpb24sIHNlc3Npb25TdG9yYWdlIFx1MjAxNCBkaWVzIHdoZW4gdGhlIHRhYlxuICogY2xvc2VzLCBzdXJ2aXZlcyBpbi1wYWdlIG5hdmlnYXRpb24uIE5laXRoZXIgcm91bmQtdHJpcHMgdG8gdGhlIHNlcnZlciB0b1xuICogbWludDsgYm90aCBhcmUgZXhhY3RseSB0aGUgb3BhcXVlIHN0cmluZ3MgdGhlIGJhY2tlbmQvQUkgc2VydmljZSBhbHJlYWR5XG4gKiBleHBlY3QgKG5vIGZvcm1hdCByZXF1aXJlbWVudCBiZXlvbmQgXCJub24tZW1wdHkgc3RyaW5nXCIpLiAqL1xuY29uc3QgVklTSVRPUl9LRVkgPSAnX19sZWFkcnl6ZV92aXNpdG9yX2lkJztcbmNvbnN0IFNFU1NJT05fS0VZID0gJ19fbGVhZHJ5emVfc2Vzc2lvbl9pZCc7XG5cbmZ1bmN0aW9uIHV1aWQoKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiBjcnlwdG8gIT09ICd1bmRlZmluZWQnICYmIHR5cGVvZiBjcnlwdG8ucmFuZG9tVVVJRCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICB9XG4gIC8vIEZhbGxiYWNrIGZvciBvbGRlciBicm93c2VycyBsYWNraW5nIGNyeXB0by5yYW5kb21VVUlELlxuICByZXR1cm4gJ3h4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eCcucmVwbGFjZSgvW3h5XS9nLCAoYykgPT4ge1xuICAgIGNvbnN0IHIgPSAoTWF0aC5yYW5kb20oKSAqIDE2KSB8IDA7XG4gICAgY29uc3QgdiA9IGMgPT09ICd4JyA/IHIgOiAociAmIDB4MykgfCAweDg7XG4gICAgcmV0dXJuIHYudG9TdHJpbmcoMTYpO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFZpc2l0b3JJZCgpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIGxldCBpZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFZJU0lUT1JfS0VZKTtcbiAgICBpZiAoIWlkKSB7IGlkID0gdXVpZCgpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShWSVNJVE9SX0tFWSwgaWQpOyB9XG4gICAgcmV0dXJuIGlkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdXVpZCgpOyAvLyBzdG9yYWdlIGJsb2NrZWQgKHByaXZhdGUgYnJvd3NpbmcpIFx1MjAxNCBkZWdyYWRlIHRvIGEgZnJlc2ggaWRcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2Vzc2lvbklkKCk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgbGV0IGlkID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShTRVNTSU9OX0tFWSk7XG4gICAgaWYgKCFpZCkgeyBpZCA9IHV1aWQoKTsgc2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShTRVNTSU9OX0tFWSwgaWQpOyB9XG4gICAgcmV0dXJuIGlkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdXVpZCgpO1xuICB9XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBXaWRnZXRDb25maWcge1xuICBjb21wYW55TmFtZTogc3RyaW5nO1xuICBhZ2VudE5hbWU6IHN0cmluZztcbiAgbG9nb1VybD86IHN0cmluZztcbiAgcHJpbWFyeUNvbG9yOiBzdHJpbmc7XG4gIGdyZWV0aW5nOiBzdHJpbmc7XG4gIHRlbXBsYXRlPzogJ21vZGVybicgfCAnbWluaW1hbCcgfCAnY2hpcHMnIHwgJ2RhcmsnO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICBkaXYudGV4dENvbnRlbnQgPSBzO1xuICByZXR1cm4gZGl2LmlubmVySFRNTDtcbn1cblxuLyoqIERhcmtlbnMvbGlnaHRlbnMgYSAjcnJnZ2JiIGhleCBjb2xvciBieSBgYW1vdW50YCAoLTEuLjEpIFx1MjAxNCB1c2VkIHRvIGRlcml2ZVxuICogYSBob3ZlciBzaGFkZSBmcm9tIHRoZSB0ZW5hbnQncyBvd24gcHJpbWFyeUNvbG9yIHdpdGhvdXQgbmVlZGluZyBhIHNlY29uZFxuICogY29uZmlndXJlZCBjb2xvci4gKi9cbmZ1bmN0aW9uIHNoYWRlKGhleDogc3RyaW5nLCBhbW91bnQ6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IG0gPSAvXiM/KFswLTlhLWZdezZ9KSQvaS5leGVjKGhleC50cmltKCkpO1xuICBpZiAoIW0pIHJldHVybiBoZXg7XG4gIGNvbnN0IG4gPSBwYXJzZUludChtWzFdLCAxNik7XG4gIGNvbnN0IGNsYW1wID0gKHY6IG51bWJlcikgPT4gTWF0aC5yb3VuZChNYXRoLm1heCgwLCBNYXRoLm1pbigyNTUsIHYpKSk7XG4gIGNvbnN0IHIgPSBjbGFtcCgoKG4gPj4gMTYpICYgMHhmZikgKyAyNTUgKiBhbW91bnQpO1xuICBjb25zdCBnID0gY2xhbXAoKChuID4+IDgpICYgMHhmZikgKyAyNTUgKiBhbW91bnQpO1xuICBjb25zdCBiID0gY2xhbXAoKG4gJiAweGZmKSArIDI1NSAqIGFtb3VudCk7XG4gIHJldHVybiBgIyR7KCgxIDw8IDI0KSArIChyIDw8IDE2KSArIChnIDw8IDgpICsgYikudG9TdHJpbmcoMTYpLnNsaWNlKDEpfWA7XG59XG5cbmNvbnN0IElDT05fQ0hBVCA9ICc8c3ZnIHZpZXdCb3g9XCIwIDAgMjQgMjRcIiB3aWR0aD1cIjI2XCIgaGVpZ2h0PVwiMjZcIiBmaWxsPVwibm9uZVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjJcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIj48cGF0aCBkPVwiTTIxIDExLjVhOC4zOCA4LjM4IDAgMCAxLS45IDMuOCA4LjUgOC41IDAgMCAxLTcuNiA0LjcgOC4zOCA4LjM4IDAgMCAxLTMuOC0uOUwzIDIxbDEuOS01LjdhOC4zOCA4LjM4IDAgMCAxLS45LTMuOCA4LjUgOC41IDAgMCAxIDQuNy03LjYgOC4zOCA4LjM4IDAgMCAxIDMuOC0uOWguNWE4LjQ4IDguNDggMCAwIDEgOCA4di41elwiLz48L3N2Zz4nO1xuY29uc3QgSUNPTl9DTE9TRSA9ICc8c3ZnIHZpZXdCb3g9XCIwIDAgMjQgMjRcIiB3aWR0aD1cIjE4XCIgaGVpZ2h0PVwiMThcIiBmaWxsPVwibm9uZVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjIuMjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIj48cGF0aCBkPVwiTTE4IDYgNiAxOE02IDZsMTIgMTJcIi8+PC9zdmc+JztcbmNvbnN0IElDT05fU0VORCA9ICc8c3ZnIHZpZXdCb3g9XCIwIDAgMjQgMjRcIiB3aWR0aD1cIjE4XCIgaGVpZ2h0PVwiMThcIiBmaWxsPVwibm9uZVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjJcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIj48cGF0aCBkPVwiTTIyIDIgMTEgMTNNMjIgMmwtNyAyMC00LTktOS00IDIwLTd6XCIvPjwvc3ZnPic7XG5jb25zdCBJQ09OX0NIRVZST04gPSAnPHN2ZyB2aWV3Qm94PVwiMCAwIDI0IDI0XCIgd2lkdGg9XCIxNVwiIGhlaWdodD1cIjE1XCIgZmlsbD1cIm5vbmVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIyLjI1XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCI+PHBhdGggZD1cIm05IDE4IDYtNi02LTZcIi8+PC9zdmc+JztcblxuLy8gQSBzbWFsbCwgZ2VuZXJpYyBzZXQgb2YgcXVpY2stcmVwbHkgc3VnZ2VzdGlvbnMgXHUyMDE0IGRlbGliZXJhdGVseVxuLy8gYnVzaW5lc3MtdHlwZS1hZ25vc3RpYyAobm8gaW5kdXN0cnktc3BlY2lmaWMgd29yZGluZyksIHNpbmNlIHRoaXMgc2FtZVxuLy8gYnVuZGxlIHNlcnZlcyBldmVyeSB0ZW5hbnQgcmVnYXJkbGVzcyBvZiB3aGF0IHRoZXkgc2VsbC4gXCJjaGlwc1wiIHJlbmRlcnNcbi8vIHRoZXNlIGFzIGhvcml6b250YWwgcGlsbCBidXR0b25zIChTdGFsbWFydC9IYXBweUFpci1zdHlsZSk7IFwiZGFya1wiIHJlbmRlcnNcbi8vIHRoZSBpZGVudGljYWwgbGlzdCBhcyBhIHZlcnRpY2FsIHN0YWNrZWQgYWN0aW9uIG1lbnUgKEhhcHB5Rm94LXN0eWxlKSBcdTIwMTRcbi8vIHNhbWUgZGF0YSwgZGVsaWJlcmF0ZWx5IGRpZmZlcmVudCBzdHJ1Y3R1cmUsIG5vdCBqdXN0IGEgcmVjb2xvci5cbmNvbnN0IFFVSUNLX1NVR0dFU1RJT05TID0gWydCb29rIGFuIGFwcG9pbnRtZW50JywgJ0kgaGF2ZSBhIHF1ZXN0aW9uJywgJ1RhbGsgdG8gYSBodW1hbiddO1xuXG4vKiogUmVuZGVycyBpbnNpZGUgYSBTaGFkb3cgRE9NIChgbW9kZTonb3BlbidgKSBzbyB0aGUgdGVuYW50J3Mgb3duIHNpdGUgQ1NTXG4gKiBjYW4gbmV2ZXIgbGVhayBpbnRvIHRoZSB3aWRnZXQgb3IgdmljZSB2ZXJzYSBcdTIwMTQgdGhpcyBtYXR0ZXJzIGhlcmVcbiAqIHNwZWNpZmljYWxseSBiZWNhdXNlLCB1bmxpa2UgYSBzY3JhcGluZy1vbmx5IGNvbnRlbnQgc2NyaXB0LCB0aGlzIHdpZGdldFxuICogbXVzdCBjb2V4aXN0IHZpc3VhbGx5IHdpdGggYW4gYXJiaXRyYXJ5LCB1bmtub3duIGhvc3QgcGFnZSBpbmRlZmluaXRlbHkuICovXG5leHBvcnQgY2xhc3MgV2lkZ2V0VUkge1xuICBwcml2YXRlIHNoYWRvdzogU2hhZG93Um9vdDtcbiAgcHJpdmF0ZSBtZXNzYWdlc0VsOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBpbnB1dEVsOiBIVE1MSW5wdXRFbGVtZW50O1xuICBwcml2YXRlIHNlbmRCdG46IEhUTUxCdXR0b25FbGVtZW50O1xuICBwcml2YXRlIHBhbmVsRWw6IEhUTUxFbGVtZW50O1xuICBwcml2YXRlIGJ1YmJsZUVsOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBvcGVuID0gZmFsc2U7XG4gIHByaXZhdGUgb25TZW5kOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuICBwcml2YXRlIHR5cGluZ0VsOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0cnVjdG9yKGNvbmZpZzogV2lkZ2V0Q29uZmlnLCBvblNlbmQ6IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQpIHtcbiAgICB0aGlzLm9uU2VuZCA9IG9uU2VuZDtcbiAgICBjb25zdCBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgaG9zdC5pZCA9ICdsZWFkcnl6ZS13aWRnZXQtaG9zdCc7XG4gICAgLy8gYGFsbDogaW5pdGlhbGAgaXNvbGF0ZXMgdGhpcyBob3N0IGVsZW1lbnQncyBvd24gYm94IGZyb20gdGhlIGhvc3RcbiAgICAvLyBwYWdlJ3MgaW5oZXJpdGVkIHN0eWxlcyBcdTIwMTQgdGhlIHJlYWwgaXNvbGF0aW9uIGlzIHRoZSBTaGFkb3cgRE9NIGJlbG93LFxuICAgIC8vIHRoaXMgaXMganVzdCBiZWx0LWFuZC1zdXNwZW5kZXJzIGZvciB0aGUgaG9zdCBlbGVtZW50IGl0c2VsZi5cbiAgICBob3N0LnN0eWxlLmNzc1RleHQgPSAnYWxsOiBpbml0aWFsOyBwb3NpdGlvbjogZml4ZWQ7IHotaW5kZXg6IDIxNDc0ODMwMDA7JztcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGhvc3QpO1xuICAgIHRoaXMuc2hhZG93ID0gaG9zdC5hdHRhY2hTaGFkb3coeyBtb2RlOiAnb3BlbicgfSk7XG4gICAgY29uc3QgdGVtcGxhdGUgPSBjb25maWcudGVtcGxhdGUgPz8gJ21vZGVybic7XG4gICAgdGhpcy5zaGFkb3cuaW5uZXJIVE1MID0gdGhpcy5yZW5kZXJTaGVsbChjb25maWcsIHRlbXBsYXRlKTtcblxuICAgIHRoaXMuYnViYmxlRWwgICA9IHRoaXMuc2hhZG93LmdldEVsZW1lbnRCeUlkKCdsci1idWJibGUnKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLnBhbmVsRWwgICAgPSB0aGlzLnNoYWRvdy5nZXRFbGVtZW50QnlJZCgnbHItcGFuZWwnKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLm1lc3NhZ2VzRWwgPSB0aGlzLnNoYWRvdy5nZXRFbGVtZW50QnlJZCgnbHItbWVzc2FnZXMnKSBhcyBIVE1MRWxlbWVudDtcbiAgICB0aGlzLmlucHV0RWwgICAgPSB0aGlzLnNoYWRvdy5nZXRFbGVtZW50QnlJZCgnbHItaW5wdXQnKSBhcyBIVE1MSW5wdXRFbGVtZW50O1xuICAgIHRoaXMuc2VuZEJ0biAgICA9IHRoaXMuc2hhZG93LmdldEVsZW1lbnRCeUlkKCdsci1zZW5kJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgY29uc3QgY2xvc2VFbCAgID0gdGhpcy5zaGFkb3cuZ2V0RWxlbWVudEJ5SWQoJ2xyLWNsb3NlJykgYXMgSFRNTEVsZW1lbnQ7XG5cbiAgICB0aGlzLmJ1YmJsZUVsLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgKCkgPT4gdGhpcy50b2dnbGUoKSk7XG4gICAgY2xvc2VFbC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRoaXMudG9nZ2xlKCkpO1xuICAgIHRoaXMuc2VuZEJ0bi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHRoaXMuaGFuZGxlU2VuZCgpKTtcbiAgICB0aGlzLmlucHV0RWwuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIChlKSA9PiB7XG4gICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHRoaXMuaGFuZGxlU2VuZCgpO1xuICAgIH0pO1xuXG4gICAgaWYgKGNvbmZpZy5ncmVldGluZykgdGhpcy5hZGRNZXNzYWdlKCdhc3Npc3RhbnQnLCBjb25maWcuZ3JlZXRpbmcpO1xuXG4gICAgaWYgKHRlbXBsYXRlID09PSAnY2hpcHMnKSB0aGlzLnJlbmRlclF1aWNrUmVwbGllcygnbHItY2hpcHMnLCAnbHItY2hpcCcpO1xuICAgIGlmICh0ZW1wbGF0ZSA9PT0gJ2RhcmsnKSB0aGlzLnJlbmRlclF1aWNrUmVwbGllcygnbHItYWN0aW9ucycsICdsci1hY3Rpb24nKTtcbiAgfVxuXG4gIC8qKiBTYW1lIHN1Z2dlc3Rpb24gbGlzdCwgcmVuZGVyZWQgYXMgZWl0aGVyIGhvcml6b250YWwgcGlsbHMgKGNoaXBzXG4gICAqIHRlbXBsYXRlKSBvciBhIHZlcnRpY2FsIHN0YWNrZWQgbWVudSAoZGFyayB0ZW1wbGF0ZSkgXHUyMDE0IHRoZSB3cmFwcGVyL2l0ZW1cbiAgICogY2xhc3MgbmFtZXMgYXJlIHRoZSBvbmx5IGRpZmZlcmVuY2U7IGJvdGggc2VuZCBpZGVudGljYWxseSBvbiBjbGljay4gKi9cbiAgcHJpdmF0ZSByZW5kZXJRdWlja1JlcGxpZXMod3JhcENsYXNzOiBzdHJpbmcsIGl0ZW1DbGFzczogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHdyYXAuY2xhc3NOYW1lID0gd3JhcENsYXNzO1xuICAgIGZvciAoY29uc3QgbGFiZWwgb2YgUVVJQ0tfU1VHR0VTVElPTlMpIHtcbiAgICAgIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpO1xuICAgICAgYnRuLmNsYXNzTmFtZSA9IGl0ZW1DbGFzcztcbiAgICAgIGJ0bi50eXBlID0gJ2J1dHRvbic7XG4gICAgICBidG4uaW5uZXJIVE1MID0gaXRlbUNsYXNzID09PSAnbHItYWN0aW9uJyA/IGA8c3Bhbj4ke2VzY2FwZUh0bWwobGFiZWwpfTwvc3Bhbj4ke0lDT05fQ0hFVlJPTn1gIDogZXNjYXBlSHRtbChsYWJlbCk7XG4gICAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB7XG4gICAgICAgIHdyYXAucmVtb3ZlKCk7XG4gICAgICAgIHRoaXMuc2VuZFRleHQobGFiZWwpO1xuICAgICAgfSk7XG4gICAgICB3cmFwLmFwcGVuZENoaWxkKGJ0bik7XG4gICAgfVxuICAgIHRoaXMubWVzc2FnZXNFbC5hcHBlbmRDaGlsZCh3cmFwKTtcbiAgICB0aGlzLm1lc3NhZ2VzRWwuc2Nyb2xsVG9wID0gdGhpcy5tZXNzYWdlc0VsLnNjcm9sbEhlaWdodDtcbiAgfVxuXG4gIHByaXZhdGUgaGFuZGxlU2VuZCgpOiB2b2lkIHtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5pbnB1dEVsLnZhbHVlLnRyaW0oKTtcbiAgICBpZiAoIXRleHQpIHJldHVybjtcbiAgICB0aGlzLmlucHV0RWwudmFsdWUgPSAnJztcbiAgICB0aGlzLnNlbmRUZXh0KHRleHQpO1xuICB9XG5cbiAgcHJpdmF0ZSBzZW5kVGV4dCh0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmFkZE1lc3NhZ2UoJ3VzZXInLCB0ZXh0KTtcbiAgICB0aGlzLm9uU2VuZCh0ZXh0KTtcbiAgfVxuXG4gIHRvZ2dsZSgpOiB2b2lkIHtcbiAgICB0aGlzLm9wZW4gPSAhdGhpcy5vcGVuO1xuICAgIHRoaXMucGFuZWxFbC5jbGFzc0xpc3QudG9nZ2xlKCdsci1vcGVuJywgdGhpcy5vcGVuKTtcbiAgICBpZiAodGhpcy5vcGVuKSB7XG4gICAgICB0aGlzLnBhbmVsRWwuc3R5bGUuZGlzcGxheSA9ICdmbGV4JztcbiAgICAgIHRoaXMuc2hhZG93LmdldEVsZW1lbnRCeUlkKCdsci1iYWRnZScpPy5yZW1vdmUoKTtcbiAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB0aGlzLmlucHV0RWwuZm9jdXMoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIExldCB0aGUgY2xvc2luZyB0cmFuc2l0aW9uIGZpbmlzaCBiZWZvcmUgYWN0dWFsbHkgaGlkaW5nLCBzbyB0aGVcbiAgICAgIC8vIHBhbmVsIGZhZGVzL3NjYWxlcyBvdXQgaW5zdGVhZCBvZiBqdXN0IHZhbmlzaGluZy5cbiAgICAgIHNldFRpbWVvdXQoKCkgPT4geyBpZiAoIXRoaXMub3BlbikgdGhpcy5wYW5lbEVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7IH0sIDE2MCk7XG4gICAgfVxuICB9XG5cbiAgYWRkTWVzc2FnZShyb2xlOiAndXNlcicgfCAnYXNzaXN0YW50JywgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gICAgLy8gQSByZXBseSBhcnJpdmluZyByZW1vdmVzIHRoZSB0eXBpbmcgaW5kaWNhdG9yIHJpZ2h0IGFzIGl0J3MgcmVwbGFjZWRcbiAgICAvLyBieSB0aGUgcmVhbCBtZXNzYWdlLCByYXRoZXIgdGhhbiBsZWF2aW5nIGl0IHRvIGxpbmdlciB1bnRpbCBzZXRCdXN5KGZhbHNlKS5cbiAgICBpZiAocm9sZSA9PT0gJ2Fzc2lzdGFudCcgJiYgdGhpcy50eXBpbmdFbCkge1xuICAgICAgdGhpcy50eXBpbmdFbC5yZW1vdmUoKTtcbiAgICAgIHRoaXMudHlwaW5nRWwgPSBudWxsO1xuICAgIH1cbiAgICBjb25zdCBkaXYgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtcbiAgICBkaXYuY2xhc3NOYW1lID0gYGxyLW1zZyBsci1tc2ctJHtyb2xlfWA7XG4gICAgZGl2LnRleHRDb250ZW50ID0gdGV4dDtcbiAgICB0aGlzLm1lc3NhZ2VzRWwuYXBwZW5kQ2hpbGQoZGl2KTtcbiAgICB0aGlzLm1lc3NhZ2VzRWwuc2Nyb2xsVG9wID0gdGhpcy5tZXNzYWdlc0VsLnNjcm9sbEhlaWdodDtcbiAgfVxuXG4gIHNldEJ1c3koYnVzeTogYm9vbGVhbik6IHZvaWQge1xuICAgIHRoaXMuc2VuZEJ0bi5kaXNhYmxlZCA9IGJ1c3k7XG4gICAgdGhpcy5pbnB1dEVsLmRpc2FibGVkID0gYnVzeTtcbiAgICBpZiAoYnVzeSkge1xuICAgICAgY29uc3QgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7XG4gICAgICBkaXYuY2xhc3NOYW1lID0gJ2xyLW1zZyBsci1tc2ctYXNzaXN0YW50IGxyLXR5cGluZyc7XG4gICAgICBkaXYuaW5uZXJIVE1MID0gJzxzcGFuPjwvc3Bhbj48c3Bhbj48L3NwYW4+PHNwYW4+PC9zcGFuPic7XG4gICAgICB0aGlzLm1lc3NhZ2VzRWwuYXBwZW5kQ2hpbGQoZGl2KTtcbiAgICAgIHRoaXMubWVzc2FnZXNFbC5zY3JvbGxUb3AgPSB0aGlzLm1lc3NhZ2VzRWwuc2Nyb2xsSGVpZ2h0O1xuICAgICAgdGhpcy50eXBpbmdFbCA9IGRpdjtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy50eXBpbmdFbD8ucmVtb3ZlKCk7XG4gICAgICB0aGlzLnR5cGluZ0VsID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJlbmRlclNoZWxsKGNvbmZpZzogV2lkZ2V0Q29uZmlnLCB0ZW1wbGF0ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBjb2xvciA9IGNvbmZpZy5wcmltYXJ5Q29sb3IgfHwgJyMyNTYzZWInO1xuICAgIGNvbnN0IGNvbG9yRGFyayA9IHNoYWRlKGNvbG9yLCAtMC4xOCk7XG4gICAgY29uc3QgYXZhdGFyID0gY29uZmlnLmxvZ29VcmxcbiAgICAgID8gYDxpbWcgc3JjPVwiJHtlc2NhcGVIdG1sKGNvbmZpZy5sb2dvVXJsKX1cIiBhbHQ9XCJcIiBpZD1cImxyLWF2YXRhci1pbWdcIiAvPmBcbiAgICAgIDogYDxzcGFuIGlkPVwibHItYXZhdGFyLWZhbGxiYWNrXCI+JHtlc2NhcGVIdG1sKChjb25maWcuYWdlbnROYW1lIHx8IGNvbmZpZy5jb21wYW55TmFtZSB8fCAnPycpLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpKX08L3NwYW4+YDtcblxuICAgIHJldHVybiBgXG48c3R5bGU+XG4gIDpob3N0IHsgYWxsOiBpbml0aWFsOyB9XG4gICogeyBib3gtc2l6aW5nOiBib3JkZXItYm94OyBmb250LWZhbWlseTogLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAnU2Vnb2UgVUknLCBSb2JvdG8sIHNhbnMtc2VyaWY7IH1cbiAgQGtleWZyYW1lcyBsci1wb3AgeyBmcm9tIHsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDEwcHgpIHNjYWxlKC45Nyk7IH0gdG8geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoMCkgc2NhbGUoMSk7IH0gfVxuICBAa2V5ZnJhbWVzIGxyLWJvdW5jZSB7IDAlLCA2MCUsIDEwMCUgeyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoMCk7IG9wYWNpdHk6IC40OyB9IDMwJSB7IHRyYW5zZm9ybTogdHJhbnNsYXRlWSgtNHB4KTsgb3BhY2l0eTogMTsgfSB9XG4gIEBrZXlmcmFtZXMgbHItZmFkZS1pbiB7IGZyb20geyBvcGFjaXR5OiAwOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoNHB4KTsgfSB0byB7IG9wYWNpdHk6IDE7IHRyYW5zZm9ybTogdHJhbnNsYXRlWSgwKTsgfSB9XG4gIEBrZXlmcmFtZXMgbHItcHVsc2UgeyAwJSwgMTAwJSB7IG9wYWNpdHk6IDE7IH0gNTAlIHsgb3BhY2l0eTogLjM1OyB9IH1cbiAgQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpIHsgKiB7IGFuaW1hdGlvbjogbm9uZSAhaW1wb3J0YW50OyB0cmFuc2l0aW9uOiBub25lICFpbXBvcnRhbnQ7IH0gfVxuXG4gIC8qIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MCBCYXNlIFx1MjAxNCBzaGFyZWQgcGx1bWJpbmcgb25seSBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTAgKi9cbiAgI2xyLWJ1YmJsZSB7XG4gICAgcG9zaXRpb246IGZpeGVkOyByaWdodDogMjJweDsgYm90dG9tOiAyMnB4OyB3aWR0aDogNjBweDsgaGVpZ2h0OiA2MHB4OyBib3JkZXItcmFkaXVzOiA1MCU7XG4gICAgYm9yZGVyOiBub25lOyBjb2xvcjogI2ZmZjsgY3Vyc29yOiBwb2ludGVyOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcbiAgICBiYWNrZ3JvdW5kOiAke2NvbG9yfTsgYm94LXNoYWRvdzogMCAxMHB4IDI0cHggLTZweCAke2NvbG9yfTY2LCAwIDJweCA4cHggcmdiYSgwLDAsMCwwLjE1KTtcbiAgICB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjE1cyBlYXNlLCBib3gtc2hhZG93IC4xNXMgZWFzZTtcbiAgfVxuICAjbHItYnViYmxlLXdyYXAgeyBwb3NpdGlvbjogZml4ZWQ7IHJpZ2h0OiAyMnB4OyBib3R0b206IDIycHg7IH1cbiAgI2xyLWJ1YmJsZS13cmFwICNsci1idWJibGUgeyBwb3NpdGlvbjogc3RhdGljOyB9XG4gICNsci1idWJibGU6aG92ZXIgeyB0cmFuc2Zvcm06IHNjYWxlKDEuMDYpOyBib3gtc2hhZG93OiAwIDE0cHggMjhweCAtNnB4ICR7Y29sb3J9ODAsIDAgMnB4IDhweCByZ2JhKDAsMCwwLDAuMTgpOyB9XG4gICNsci1idWJibGU6YWN0aXZlIHsgdHJhbnNmb3JtOiBzY2FsZSguOTcpOyB9XG5cbiAgI2xyLXBhbmVsIHtcbiAgICBkaXNwbGF5OiBub25lOyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBwb3NpdGlvbjogZml4ZWQ7IHJpZ2h0OiAyMnB4OyBib3R0b206IDk2cHg7XG4gICAgd2lkdGg6IDMzNnB4OyBoZWlnaHQ6IDQ3MHB4OyBtYXgtaGVpZ2h0OiA3MnZoOyBiYWNrZ3JvdW5kOiAjZmZmOyBib3JkZXItcmFkaXVzOiAxOHB4O1xuICAgIGJveC1zaGFkb3c6IDAgMjBweCA1MHB4IC0xMnB4IHJnYmEoMTUsMjMsNDIsMC4zKSwgMCA0cHggMTRweCByZ2JhKDE1LDIzLDQyLDAuMSk7XG4gICAgb3ZlcmZsb3c6IGhpZGRlbjsgb3BhY2l0eTogMDsgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDEwcHgpIHNjYWxlKC45Nyk7XG4gICAgdHJhbnNpdGlvbjogb3BhY2l0eSAuMTZzIGVhc2UsIHRyYW5zZm9ybSAuMTZzIGVhc2U7XG4gIH1cbiAgI2xyLXBhbmVsLmxyLW9wZW4geyBvcGFjaXR5OiAxOyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoMCkgc2NhbGUoMSk7IGFuaW1hdGlvbjogbHItcG9wIC4xNnMgZWFzZTsgfVxuXG4gICNsci1oZWFkZXIgeyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IDEwcHg7IHBhZGRpbmc6IDE0cHggMTZweDsgY29sb3I6ICNmZmY7IGZsZXgtc2hyaW5rOiAwOyB9XG4gICNsci1hdmF0YXIgeyB3aWR0aDogMzRweDsgaGVpZ2h0OiAzNHB4OyBib3JkZXItcmFkaXVzOiA1MCU7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4yMik7XG4gICAgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IG92ZXJmbG93OiBoaWRkZW47IGZsZXgtc2hyaW5rOiAwOyBmb250LXdlaWdodDogNzAwOyBmb250LXNpemU6IDE0cHg7IH1cbiAgI2xyLWF2YXRhci1pbWcgeyB3aWR0aDogMTAwJTsgaGVpZ2h0OiAxMDAlOyBvYmplY3QtZml0OiBjb3ZlcjsgfVxuICAjbHItaGVhZGVyLXRleHQgeyBmbGV4OiAxOyBtaW4td2lkdGg6IDA7IH1cbiAgI2xyLWhlYWRlci1uYW1lIHsgZGlzcGxheTogYmxvY2s7IGZvbnQtc2l6ZTogMTRweDsgZm9udC13ZWlnaHQ6IDYwMDsgbGV0dGVyLXNwYWNpbmc6IC4xcHg7IH1cbiAgI2xyLWhlYWRlci1zdWIgeyBkaXNwbGF5OiBibG9jazsgZm9udC1zaXplOiAxMS41cHg7IG9wYWNpdHk6IC44NTsgbWFyZ2luLXRvcDogMXB4OyB9XG4gICNsci1jbG9zZSB7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4xNCk7IGJvcmRlcjogbm9uZTsgY29sb3I6ICNmZmY7IHdpZHRoOiAyOHB4OyBoZWlnaHQ6IDI4cHg7IGJvcmRlci1yYWRpdXM6IDUwJTtcbiAgICBjdXJzb3I6IHBvaW50ZXI7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyOyBmbGV4LXNocmluazogMDsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMTVzIGVhc2U7IH1cbiAgI2xyLWNsb3NlOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjI2KTsgfVxuICAjbHItc3RhdHVzIHsgZGlzcGxheTogbm9uZTsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiA2cHg7IHBhZGRpbmc6IDZweCAxNnB4IDEycHg7IGZvbnQtc2l6ZTogMTFweDsgY29sb3I6ICNmZmY7IG1hcmdpbi1ib3R0b206IC0xcHg7IH1cbiAgI2xyLXN0YXR1cy1kb3QgeyB3aWR0aDogN3B4OyBoZWlnaHQ6IDdweDsgYm9yZGVyLXJhZGl1czogNTAlOyBiYWNrZ3JvdW5kOiAjNGFkZTgwOyBhbmltYXRpb246IGxyLXB1bHNlIDEuOHMgaW5maW5pdGUgZWFzZS1pbi1vdXQ7IH1cbiAgI2xyLXdhdmUgeyBkaXNwbGF5OiBub25lOyB3aWR0aDogMTAwJTsgaGVpZ2h0OiAxNHB4OyBtYXJnaW4tdG9wOiAtMXB4OyBmbGV4LXNocmluazogMDsgfVxuXG4gICNsci1iYWRnZSB7IHBvc2l0aW9uOiBhYnNvbHV0ZTsgdG9wOiAtMnB4OyByaWdodDogLTJweDsgbWluLXdpZHRoOiAxOHB4OyBoZWlnaHQ6IDE4cHg7IHBhZGRpbmc6IDAgNHB4OyBib3JkZXItcmFkaXVzOiA5OTlweDtcbiAgICBiYWNrZ3JvdW5kOiAjZWY0NDQ0OyBjb2xvcjogI2ZmZjsgZm9udC1zaXplOiAxMHB4OyBmb250LXdlaWdodDogNzAwOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjtcbiAgICBib3JkZXI6IDJweCBzb2xpZCAjZmZmOyB9XG5cbiAgI2xyLW1lc3NhZ2VzIHsgZmxleDogMTsgb3ZlcmZsb3cteTogYXV0bzsgcGFkZGluZzogMTRweDsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiAxMHB4OyBiYWNrZ3JvdW5kOiAjZjhmOWZiOyB9XG4gICNsci1tZXNzYWdlczo6LXdlYmtpdC1zY3JvbGxiYXIgeyB3aWR0aDogNnB4OyB9XG4gICNsci1tZXNzYWdlczo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWIgeyBiYWNrZ3JvdW5kOiAjZDhkY2UzOyBib3JkZXItcmFkaXVzOiAzcHg7IH1cblxuICAubHItbXNnIHsgbWF4LXdpZHRoOiA4MiU7IHBhZGRpbmc6IDlweCAxM3B4OyBmb250LXNpemU6IDEzLjVweDsgbGluZS1oZWlnaHQ6IDEuNDU7IHdoaXRlLXNwYWNlOiBwcmUtd3JhcDtcbiAgICB3b3JkLWJyZWFrOiBicmVhay13b3JkOyBhbmltYXRpb246IGxyLWZhZGUtaW4gLjE4cyBlYXNlOyB9XG4gIC5sci1tc2ctYXNzaXN0YW50IHsgYWxpZ24tc2VsZjogZmxleC1zdGFydDsgYmFja2dyb3VuZDogI2ZmZjsgYm9yZGVyOiAxcHggc29saWQgI2U4ZWFlZTsgY29sb3I6ICMxZTI0MzA7IH1cbiAgLmxyLW1zZy11c2VyIHsgYWxpZ24tc2VsZjogZmxleC1lbmQ7IGNvbG9yOiAjZmZmOyB9XG5cbiAgLmxyLXR5cGluZyB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGdhcDogNHB4OyBwYWRkaW5nOiAxMnB4IDE0cHg7IH1cbiAgLmxyLXR5cGluZyBzcGFuIHsgd2lkdGg6IDZweDsgaGVpZ2h0OiA2cHg7IGJvcmRlci1yYWRpdXM6IDUwJTsgYmFja2dyb3VuZDogI2E3YWRiYTsgZGlzcGxheTogaW5saW5lLWJsb2NrO1xuICAgIGFuaW1hdGlvbjogbHItYm91bmNlIDEuMnMgaW5maW5pdGUgZWFzZS1pbi1vdXQ7IH1cbiAgLmxyLXR5cGluZyBzcGFuOm50aC1jaGlsZCgyKSB7IGFuaW1hdGlvbi1kZWxheTogLjE1czsgfVxuICAubHItdHlwaW5nIHNwYW46bnRoLWNoaWxkKDMpIHsgYW5pbWF0aW9uLWRlbGF5OiAuM3M7IH1cblxuICAjbHItaW5wdXRiYXIgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDhweDsgcGFkZGluZzogMTJweDsgYm9yZGVyLXRvcDogMXB4IHNvbGlkICNlZGVlZjI7IGJhY2tncm91bmQ6ICNmZmY7IGZsZXgtc2hyaW5rOiAwOyB9XG4gICNsci1pbnB1dCB7IGZsZXg6IDE7IHBhZGRpbmc6IDlweCAxM3B4OyBib3JkZXI6IDFweCBzb2xpZCAjZGZlMmU4OyBib3JkZXItcmFkaXVzOiAyMnB4OyBmb250LXNpemU6IDEzLjVweDtcbiAgICBvdXRsaW5lOiBub25lOyB0cmFuc2l0aW9uOiBib3JkZXItY29sb3IgLjE1cyBlYXNlOyB9XG4gICNsci1pbnB1dDpmb2N1cyB7IGJvcmRlci1jb2xvcjogJHtjb2xvcn07IH1cbiAgI2xyLXNlbmQgeyBib3JkZXI6IG5vbmU7IGNvbG9yOiAjZmZmOyBiYWNrZ3JvdW5kOiAke2NvbG9yfTsgYm9yZGVyLXJhZGl1czogNTAlOyB3aWR0aDogMzZweDsgaGVpZ2h0OiAzNnB4O1xuICAgIGN1cnNvcjogcG9pbnRlcjsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBjZW50ZXI7IGZsZXgtc2hyaW5rOiAwOyB0cmFuc2l0aW9uOiB0cmFuc2Zvcm0gLjFzIGVhc2UsIG9wYWNpdHkgLjE1cyBlYXNlOyB9XG4gICNsci1zZW5kOmhvdmVyOm5vdCg6ZGlzYWJsZWQpIHsgdHJhbnNmb3JtOiBzY2FsZSgxLjA2KTsgfVxuICAjbHItc2VuZDpkaXNhYmxlZCwgI2xyLWlucHV0OmRpc2FibGVkIHsgb3BhY2l0eTogLjU1OyBjdXJzb3I6IGRlZmF1bHQ7IH1cblxuICAvKiBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTAgTW9kZXJuIFx1MjAxNCBncmFkaWVudCBoZWFkZXIsIHdhdmUgdHJhbnNpdGlvbiwgbGl2ZS1zdGF0dXMsIHNvZnQgYnViYmxlcyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTAgKi9cbiAgI2xyLXBhbmVsW2RhdGEtdGVtcGxhdGU9XCJtb2Rlcm5cIl0gI2xyLWhlYWRlciB7IGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsICR7Y29sb3J9LCAke2NvbG9yRGFya30pOyBwYWRkaW5nLWJvdHRvbTogOHB4OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibW9kZXJuXCJdICNsci1hdmF0YXIgeyB3aWR0aDogNDBweDsgaGVpZ2h0OiA0MHB4OyBib3gtc2hhZG93OiAwIDAgMCAycHggcmdiYSgyNTUsMjU1LDI1NSwwLjQpOyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibW9kZXJuXCJdICNsci1zdGF0dXMgeyBkaXNwbGF5OiBmbGV4OyBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCAke2NvbG9yfSwgJHtjb2xvckRhcmt9KTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cIm1vZGVyblwiXSAjbHItd2F2ZSB7IGRpc3BsYXk6IGJsb2NrOyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibW9kZXJuXCJdIC5sci1tc2ctYXNzaXN0YW50IHsgYm9yZGVyLXJhZGl1czogNHB4IDE2cHggMTZweCAxNnB4OyBib3gtc2hhZG93OiAwIDFweCAycHggcmdiYSgxNSwyMyw0MiwwLjA0KTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cIm1vZGVyblwiXSAubHItbXNnLXVzZXIgeyBiYWNrZ3JvdW5kOiAke2NvbG9yfTsgYm9yZGVyLXJhZGl1czogMTZweCA0cHggMTZweCAxNnB4OyB9XG5cbiAgLyogXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwIE1pbmltYWwgRmxhdCBcdTIwMTQgYmFyZSwgcXVpZXQsIG5vIGF2YXRhci9zdGF0dXMvc2hhZG93IFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MCAqL1xuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cIm1pbmltYWxcIl0geyBib3JkZXItcmFkaXVzOiA4cHg7IGJveC1zaGFkb3c6IDAgMnB4IDE2cHggcmdiYSgxNSwyMyw0MiwwLjE0KTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cIm1pbmltYWxcIl0gI2xyLWhlYWRlciB7IGJhY2tncm91bmQ6ICR7Y29sb3J9OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibWluaW1hbFwiXSAjbHItYXZhdGFyIHsgZGlzcGxheTogbm9uZTsgfVxuICAjbHItYnViYmxlW2RhdGEtdGVtcGxhdGU9XCJtaW5pbWFsXCJdIHsgYm9yZGVyLXJhZGl1czogMTRweDsgYm94LXNoYWRvdzogMCAzcHggMTBweCByZ2JhKDAsMCwwLDAuMTYpOyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibWluaW1hbFwiXSAubHItbXNnIHsgYm9yZGVyLXJhZGl1czogNnB4OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibWluaW1hbFwiXSAubHItbXNnLXVzZXIgeyBiYWNrZ3JvdW5kOiAke2NvbG9yfTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cIm1pbmltYWxcIl0gI2xyLWlucHV0IHsgYm9yZGVyLXJhZGl1czogNnB4OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwibWluaW1hbFwiXSAjbHItc2VuZCB7IGJvcmRlci1yYWRpdXM6IDZweDsgfVxuXG4gIC8qIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MCBDb21wYWN0IENoaXBzIFx1MjAxNCBpY29uIGF2YXRhciwgaG9yaXpvbnRhbCBwaWxsIHF1aWNrLXJlcGxpZXMgXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwICovXG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwiY2hpcHNcIl0gI2xyLWhlYWRlciB7IGJhY2tncm91bmQ6ICR7Y29sb3J9OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwiY2hpcHNcIl0gI2xyLWF2YXRhciB7IGJhY2tncm91bmQ6ICNmZmY7IGNvbG9yOiAke2NvbG9yfTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImNoaXBzXCJdIC5sci1tc2cgeyBib3JkZXItcmFkaXVzOiAxMnB4OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwiY2hpcHNcIl0gLmxyLW1zZy1hc3Npc3RhbnQgeyBib3JkZXItcmFkaXVzOiA0cHggMTJweCAxMnB4IDEycHg7IH1cbiAgI2xyLXBhbmVsW2RhdGEtdGVtcGxhdGU9XCJjaGlwc1wiXSAubHItbXNnLXVzZXIgeyBiYWNrZ3JvdW5kOiAke2NvbG9yfTsgYm9yZGVyLXJhZGl1czogMTJweCA0cHggMTJweCAxMnB4OyB9XG4gIC5sci1jaGlwcyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiA2cHg7IGFuaW1hdGlvbjogbHItZmFkZS1pbiAuMnMgZWFzZTsgfVxuICAubHItY2hpcCB7IGJvcmRlcjogMS41cHggc29saWQgJHtjb2xvcn07IGJhY2tncm91bmQ6ICNmZmY7IGNvbG9yOiAke2NvbG9yfTsgZm9udC1zaXplOiAxMi41cHg7IGZvbnQtd2VpZ2h0OiA2MDA7XG4gICAgcGFkZGluZzogN3B4IDEycHg7IGJvcmRlci1yYWRpdXM6IDk5OXB4OyBjdXJzb3I6IHBvaW50ZXI7IHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1cyBlYXNlLCBjb2xvciAuMTVzIGVhc2U7IH1cbiAgLmxyLWNoaXA6aG92ZXIgeyBiYWNrZ3JvdW5kOiAke2NvbG9yfTsgY29sb3I6ICNmZmY7IH1cblxuICAvKiBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTAgRGFyayBQcm9mZXNzaW9uYWwgXHUyMDE0IGRhcmsgY2hyb21lLCB2ZXJ0aWNhbCBzdGFja2VkIGFjdGlvbiBtZW51IFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MCAqL1xuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0geyBiYWNrZ3JvdW5kOiAjZjRmNWY3OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwiZGFya1wiXSAjbHItaGVhZGVyIHsgYmFja2dyb3VuZDogIzFhMWYyZTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0gI2xyLWF2YXRhciB7IGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4xKTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0gI2xyLWNsb3NlIHsgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA4KTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0gI2xyLWNsb3NlOmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjE2KTsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0gI2xyLW1lc3NhZ2VzIHsgYmFja2dyb3VuZDogI2Y0ZjVmNzsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0gLmxyLW1zZyB7IGJvcmRlci1yYWRpdXM6IDRweCAxMnB4IDEycHggMTJweDsgfVxuICAjbHItcGFuZWxbZGF0YS10ZW1wbGF0ZT1cImRhcmtcIl0gLmxyLW1zZy11c2VyIHsgYmFja2dyb3VuZDogIzFhMWYyZTsgYm9yZGVyLXJhZGl1czogMTJweCA0cHggMTJweCAxMnB4OyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwiZGFya1wiXSAjbHItaW5wdXRiYXIgeyBiYWNrZ3JvdW5kOiAjZmZmOyBib3JkZXItdG9wLWNvbG9yOiAjZTRlNmVhOyB9XG4gICNsci1wYW5lbFtkYXRhLXRlbXBsYXRlPVwiZGFya1wiXSAjbHItc2VuZCB7IGJhY2tncm91bmQ6ICR7Y29sb3J9OyB9XG4gIC8qIFNhbWUgbGlzdCBhcyBDaGlwcycgcGlsbHMsIHJlbmRlcmVkIGFzIGEgdmVydGljYWwgc3RhY2tlZCBtZW51IGluc3RlYWQgXHUyMDE0XG4gICAqIGZpcnN0IGl0ZW0gZmlsbGVkL3ByaW1hcnksIHRoZSByZXN0IG91dGxpbmVkL3NlY29uZGFyeSwgbWF0Y2hpbmcgdGhlXG4gICAqIEhhcHB5Rm94LXN0eWxlIFwib25lIHByaW1hcnkgYWN0aW9uICsgc2Vjb25kYXJ5IG9wdGlvbnNcIiBwYXR0ZXJuLiAqL1xuICAubHItYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogN3B4OyB3aWR0aDogMTAwJTsgYW5pbWF0aW9uOiBsci1mYWRlLWluIC4ycyBlYXNlOyB9XG4gIC5sci1hY3Rpb24geyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47IHdpZHRoOiAxMDAlOyB0ZXh0LWFsaWduOiBsZWZ0O1xuICAgIGJhY2tncm91bmQ6ICNmZmY7IGJvcmRlcjogMS41cHggc29saWQgJHtjb2xvcn07IGNvbG9yOiAke2NvbG9yfTsgZm9udC1zaXplOiAxM3B4OyBmb250LXdlaWdodDogNjAwO1xuICAgIHBhZGRpbmc6IDEwcHggMTRweDsgYm9yZGVyLXJhZGl1czogOTk5cHg7IGN1cnNvcjogcG9pbnRlcjsgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMTVzIGVhc2UsIGNvbG9yIC4xNXMgZWFzZTsgfVxuICAubHItYWN0aW9uOmhvdmVyIHsgYmFja2dyb3VuZDogJHtjb2xvcn07IGNvbG9yOiAjZmZmOyB9XG4gIC5sci1hY3Rpb246aG92ZXIgc3ZnIHsgY29sb3I6ICNmZmY7IH1cbiAgLmxyLWFjdGlvbiBzdmcgeyBmbGV4LXNocmluazogMDsgY29sb3I6ICR7Y29sb3J9OyBtYXJnaW4tbGVmdDogOHB4OyB0cmFuc2l0aW9uOiBjb2xvciAuMTVzIGVhc2U7IH1cbiAgLmxyLWFjdGlvbjpmaXJzdC1jaGlsZCB7IGJhY2tncm91bmQ6ICR7Y29sb3J9OyBjb2xvcjogI2ZmZjsgfVxuICAubHItYWN0aW9uOmZpcnN0LWNoaWxkIHN2ZyB7IGNvbG9yOiAjZmZmOyB9XG4gIC5sci1hY3Rpb246Zmlyc3QtY2hpbGQ6aG92ZXIgeyBiYWNrZ3JvdW5kOiAke2NvbG9yRGFya307IH1cbjwvc3R5bGU+XG48ZGl2IGlkPVwibHItYnViYmxlLXdyYXBcIj5cbiAgPGJ1dHRvbiBpZD1cImxyLWJ1YmJsZVwiIGRhdGEtdGVtcGxhdGU9XCIke3RlbXBsYXRlfVwiIGFyaWEtbGFiZWw9XCJPcGVuIGNoYXRcIj4ke0lDT05fQ0hBVH08L2J1dHRvbj5cbiAgPHNwYW4gaWQ9XCJsci1iYWRnZVwiPjE8L3NwYW4+XG48L2Rpdj5cbjxkaXYgaWQ9XCJsci1wYW5lbFwiIGRhdGEtdGVtcGxhdGU9XCIke3RlbXBsYXRlfVwiPlxuICA8ZGl2IGlkPVwibHItaGVhZGVyXCI+XG4gICAgPGRpdiBpZD1cImxyLWF2YXRhclwiPiR7YXZhdGFyfTwvZGl2PlxuICAgIDxkaXYgaWQ9XCJsci1oZWFkZXItdGV4dFwiPlxuICAgICAgPHNwYW4gaWQ9XCJsci1oZWFkZXItbmFtZVwiPiR7ZXNjYXBlSHRtbChjb25maWcuYWdlbnROYW1lKX08L3NwYW4+XG4gICAgICA8c3BhbiBpZD1cImxyLWhlYWRlci1zdWJcIj4ke2VzY2FwZUh0bWwoY29uZmlnLmNvbXBhbnlOYW1lKX08L3NwYW4+XG4gICAgPC9kaXY+XG4gICAgPGJ1dHRvbiBpZD1cImxyLWNsb3NlXCIgYXJpYS1sYWJlbD1cIkNsb3NlIGNoYXRcIj4ke0lDT05fQ0xPU0V9PC9idXR0b24+XG4gIDwvZGl2PlxuICA8ZGl2IGlkPVwibHItc3RhdHVzXCI+PHNwYW4gaWQ9XCJsci1zdGF0dXMtZG90XCI+PC9zcGFuPldlJ3JlIG9ubGluZTwvZGl2PlxuICA8c3ZnIGlkPVwibHItd2F2ZVwiIHZpZXdCb3g9XCIwIDAgMzM2IDE0XCIgcHJlc2VydmVBc3BlY3RSYXRpbz1cIm5vbmVcIj48cGF0aCBkPVwiTTAsMCBDNTYsMTQgMTEyLDE0IDE2OCw3IEMyMjQsMCAyODAsMCAzMzYsNyBMMzM2LDE0IEwwLDE0IFpcIiBmaWxsPVwiI2Y4ZjlmYlwiLz48L3N2Zz5cbiAgPGRpdiBpZD1cImxyLW1lc3NhZ2VzXCI+PC9kaXY+XG4gIDxkaXYgaWQ9XCJsci1pbnB1dGJhclwiPlxuICAgIDxpbnB1dCBpZD1cImxyLWlucHV0XCIgdHlwZT1cInRleHRcIiBwbGFjZWhvbGRlcj1cIlR5cGUgYSBtZXNzYWdlLi4uXCIgYXV0b2NvbXBsZXRlPVwib2ZmXCIgLz5cbiAgICA8YnV0dG9uIGlkPVwibHItc2VuZFwiIGFyaWEtbGFiZWw9XCJTZW5kXCI+JHtJQ09OX1NFTkR9PC9idXR0b24+XG4gIDwvZGl2PlxuPC9kaXY+YDtcbiAgfVxufVxuIiwgImltcG9ydCB7IEFQSV9CQVNFX1VSTCB9IGZyb20gJy4vY29uZmlnJztcbmltcG9ydCB7IGdldFZpc2l0b3JJZCwgZ2V0U2Vzc2lvbklkIH0gZnJvbSAnLi9zdG9yYWdlJztcbmltcG9ydCB7IFdpZGdldFVJLCBXaWRnZXRDb25maWcgfSBmcm9tICcuL3VpJztcblxuLyoqIFJlYWRzIGEgZGF0YS0qIGF0dHJpYnV0ZSBvZmYgdGhlIDxzY3JpcHQ+IHRhZyBpdHNlbGYgXHUyMDE0IHdvcmtzIHdoZXRoZXIgdGhpc1xuICogc2NyaXB0IGlzIHRoZSBjdXJyZW50bHktZXhlY3V0aW5nIG9uZSAobm9ybWFsIGNhc2UpIG9yLCBkZWZlbnNpdmVseSwgYnlcbiAqIGZhbGxpbmcgYmFjayB0byBhIHF1ZXJ5LXNlbGVjdG9yIG1hdGNoIGluIGNhc2Ugc29tZSBob3N0IHBhZ2UncyBvd25cbiAqIHNjcmlwdC1sb2FkaW5nIHNldHVwIHN0cmlwcyBgZG9jdW1lbnQuY3VycmVudFNjcmlwdGAgKGUuZy4gZHluYW1pY1xuICogaW5qZWN0aW9uIHZpYSBpbm5lckhUTUwpLiAqL1xuZnVuY3Rpb24gcmVhZFNjcmlwdEF0dHIobmFtZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGN1cnJlbnQgPSBkb2N1bWVudC5jdXJyZW50U2NyaXB0IGFzIEhUTUxTY3JpcHRFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGN1cnJlbnQ/LmRhdGFzZXRbbmFtZV0pIHJldHVybiBjdXJyZW50LmRhdGFzZXRbbmFtZV0gYXMgc3RyaW5nO1xuICBjb25zdCBmYWxsYmFjayA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoYHNjcmlwdFtkYXRhLSR7bmFtZS5yZXBsYWNlKC9bQS1aXS9nLCAoYykgPT4gJy0nICsgYy50b0xvd2VyQ2FzZSgpKX1dYCkgYXMgSFRNTFNjcmlwdEVsZW1lbnQgfCBudWxsO1xuICByZXR1cm4gKGZhbGxiYWNrPy5kYXRhc2V0W25hbWVdIGFzIHN0cmluZykgPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gZ2V0V2lkZ2V0S2V5KCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gcmVhZFNjcmlwdEF0dHIoJ3dpZGdldEtleScpO1xufVxuXG4vKiogVGhlIEFQSSBiYXNlIFVSTCBpcyBub3JtYWxseSBiYWtlZCBpbiBhdCBidWlsZCB0aW1lIChBUElfQkFTRV9VUkwsXG4gKiBwb2ludGluZyBhdCB3aGVyZXZlciB0aGlzIGJ1bmRsZSB3YXMgYnVpbHQgdG8gdGFsayB0bykgXHUyMDE0IGJ1dCBhbiBvcHRpb25hbFxuICogYGRhdGEtYXBpLXVybGAgYXR0cmlidXRlIG9uIHRoZSBlbWJlZCBzbmlwcGV0IG92ZXJyaWRlcyBpdCBhdCBydW50aW1lLCB3aXRoXG4gKiBubyByZWJ1aWxkIHJlcXVpcmVkLiBUaGlzIGlzIHdoYXQgbWFrZXMgbG9jYWwvbGl2ZSBVQVQgdGVzdGluZyBwcmFjdGljYWw6XG4gKiB0aGUgZXhhY3Qgc2FtZSBkZXBsb3llZCB3aWRnZXQuanMgY2FuIGJlIHBvaW50ZWQgYXQgYSBsb2NhbCBiYWNrZW5kXG4gKiAoYGRhdGEtYXBpLXVybD1cImh0dHA6Ly9sb2NhbGhvc3Q6NTAwMC9hcGkvdjFcImApIGZvciBvbmUgdGVzdCBwYWdlLCBhbmQgbGVmdFxuICogb24gdGhlIHJlYWwgZGVwbG95ZWQgYmFja2VuZCBldmVyeXdoZXJlIGVsc2UsIGp1c3QgYnkgY2hhbmdpbmcgdGhlIDxzY3JpcHQ+XG4gKiB0YWcncyBvd24gYXR0cmlidXRlcy4gKi9cbmZ1bmN0aW9uIGdldEFwaUJhc2VVcmwoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRTY3JpcHRBdHRyKCdhcGlVcmwnKSB8fCBBUElfQkFTRV9VUkw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoQ29uZmlnKHdpZGdldEtleTogc3RyaW5nLCBhcGlCYXNlVXJsOiBzdHJpbmcpOiBQcm9taXNlPFdpZGdldENvbmZpZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHthcGlCYXNlVXJsfS9wdWJsaWMvd2lkZ2V0L2NvbmZpZz93aWRnZXRLZXk9JHtlbmNvZGVVUklDb21wb25lbnQod2lkZ2V0S2V5KX1gKTtcbiAgICBpZiAoIXJlcy5vaykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gICAgcmV0dXJuIGJvZHkuZGF0YSBhcyBXaWRnZXRDb25maWc7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNlbmRDaGF0KGFwaUJhc2VVcmw6IHN0cmluZywgd2lkZ2V0S2V5OiBzdHJpbmcsIHNlc3Npb25JZDogc3RyaW5nLCB2aXNpdG9ySWQ6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHthcGlCYXNlVXJsfS9wdWJsaWMvd2lkZ2V0L2NoYXQ/d2lkZ2V0S2V5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHdpZGdldEtleSl9YCwge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc2Vzc2lvbklkLCB2aXNpdG9ySWQsIG1lc3NhZ2UsIHBhZ2VVcmw6IGxvY2F0aW9uLmhyZWYgfSksXG4gICAgfSk7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gICAgaWYgKCFyZXMub2sgfHwgIWJvZHkuc3VjY2Vzcykge1xuICAgICAgcmV0dXJuIGJvZHkubWVzc2FnZSB8fCBcIlNvcnJ5LCBJJ20gaGF2aW5nIHRyb3VibGUgcmVzcG9uZGluZyByaWdodCBub3cuXCI7XG4gICAgfVxuICAgIHJldHVybiBib2R5LmRhdGE/LnJlc3BvbnNlID8/IFwiU29ycnksIEkgZGlkbid0IGNhdGNoIHRoYXQuXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcIlNvcnJ5LCBJJ20gaGF2aW5nIHRyb3VibGUgY29ubmVjdGluZyByaWdodCBub3cuIFBsZWFzZSB0cnkgYWdhaW4gc2hvcnRseS5cIjtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBpbml0KCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3aWRnZXRLZXkgPSBnZXRXaWRnZXRLZXkoKTtcbiAgaWYgKCF3aWRnZXRLZXkpIHtcbiAgICBjb25zb2xlLndhcm4oJ1tMZWFkUnl6ZSBXaWRnZXRdIE1pc3NpbmcgZGF0YS13aWRnZXQta2V5IG9uIHRoZSA8c2NyaXB0PiB0YWcgXHUyMDE0IHdpZGdldCBub3QgbG9hZGVkLicpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGFwaUJhc2VVcmwgPSBnZXRBcGlCYXNlVXJsKCk7XG4gIGNvbnN0IGNvbmZpZyA9IGF3YWl0IGZldGNoQ29uZmlnKHdpZGdldEtleSwgYXBpQmFzZVVybCk7XG4gIGlmICghY29uZmlnKSB7XG4gICAgY29uc29sZS53YXJuKCdbTGVhZFJ5emUgV2lkZ2V0XSBDb3VsZCBub3QgbG9hZCB3aWRnZXQgY29uZmlnIChkaXNhYmxlZCwgdW5rbm93biBrZXksIG9yIGRpc2FsbG93ZWQgb3JpZ2luKSBcdTIwMTQgd2lkZ2V0IG5vdCBsb2FkZWQuJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdmlzaXRvcklkID0gZ2V0VmlzaXRvcklkKCk7XG4gIGNvbnN0IHNlc3Npb25JZCA9IGdldFNlc3Npb25JZCgpO1xuXG4gIGNvbnN0IHVpID0gbmV3IFdpZGdldFVJKGNvbmZpZywgYXN5bmMgKG1lc3NhZ2UpID0+IHtcbiAgICB1aS5zZXRCdXN5KHRydWUpO1xuICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgc2VuZENoYXQoYXBpQmFzZVVybCwgd2lkZ2V0S2V5LCBzZXNzaW9uSWQsIHZpc2l0b3JJZCwgbWVzc2FnZSk7XG4gICAgdWkuYWRkTWVzc2FnZSgnYXNzaXN0YW50JywgcmVwbHkpO1xuICAgIHVpLnNldEJ1c3koZmFsc2UpO1xuICB9KTtcbn1cblxuaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09ICdsb2FkaW5nJykge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdET01Db250ZW50TG9hZGVkJywgKCkgPT4geyB2b2lkIGluaXQoKTsgfSk7XG59IGVsc2Uge1xuICB2b2lkIGluaXQoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUlPLE1BQU0sZUFBdUI7OztB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
