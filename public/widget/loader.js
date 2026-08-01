"use strict";(()=>{var g="https://leadryze-backend.onrender.com/api/v1";var m="__leadryze_visitor_id",u="__leadryze_session_id";function p(){return typeof crypto!="undefined"&&typeof crypto.randomUUID=="function"?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,a=>{let t=Math.random()*16|0;return(a==="x"?t:t&3|8).toString(16)})}function h(){try{let a=localStorage.getItem(m);return a||(a=p(),localStorage.setItem(m,a)),a}catch(a){return p()}}function x(){try{let a=sessionStorage.getItem(u);return a||(a=p(),sessionStorage.setItem(u,a)),a}catch(a){return p()}}function l(a){let t=document.createElement("div");return t.textContent=a,t.innerHTML}function y(a,t){let r=/^#?([0-9a-f]{6})$/i.exec(a.trim());if(!r)return a;let e=parseInt(r[1],16),n=d=>Math.round(Math.max(0,Math.min(255,d))),i=n((e>>16&255)+255*t),s=n((e>>8&255)+255*t),o=n((e&255)+255*t);return`#${((1<<24)+(i<<16)+(s<<8)+o).toString(16).slice(1)}`}var v='<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',k='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',w='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',E='<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',S=["Book an appointment","I have a question","Talk to a human"],c=class{constructor(t,r){this.open=!1;this.typingEl=null;var s;this.onSend=r;let e=document.createElement("div");e.id="leadryze-widget-host",e.style.cssText="all: initial; position: fixed; z-index: 2147483000;",document.body.appendChild(e),this.shadow=e.attachShadow({mode:"open"});let n=(s=t.template)!=null?s:"modern";this.shadow.innerHTML=this.renderShell(t,n),this.bubbleEl=this.shadow.getElementById("lr-bubble"),this.panelEl=this.shadow.getElementById("lr-panel"),this.messagesEl=this.shadow.getElementById("lr-messages"),this.inputEl=this.shadow.getElementById("lr-input"),this.sendBtn=this.shadow.getElementById("lr-send");let i=this.shadow.getElementById("lr-close");this.bubbleEl.addEventListener("click",()=>this.toggle()),i.addEventListener("click",()=>this.toggle()),this.sendBtn.addEventListener("click",()=>this.handleSend()),this.inputEl.addEventListener("keydown",o=>{o.key==="Enter"&&this.handleSend()}),t.greeting&&this.addMessage("assistant",t.greeting),n==="chips"&&this.renderQuickReplies("lr-chips","lr-chip"),n==="dark"&&this.renderQuickReplies("lr-actions","lr-action")}renderQuickReplies(t,r){let e=document.createElement("div");e.className=t;for(let n of S){let i=document.createElement("button");i.className=r,i.type="button",i.innerHTML=r==="lr-action"?`<span>${l(n)}</span>${E}`:l(n),i.addEventListener("click",()=>{e.remove(),this.sendText(n)}),e.appendChild(i)}this.messagesEl.appendChild(e),this.messagesEl.scrollTop=this.messagesEl.scrollHeight}handleSend(){let t=this.inputEl.value.trim();t&&(this.inputEl.value="",this.sendText(t))}sendText(t){this.addMessage("user",t),this.onSend(t)}toggle(){this.open=!this.open,this.panelEl.classList.toggle("lr-open",this.open),this.open?(this.panelEl.style.display="flex",requestAnimationFrame(()=>this.inputEl.focus())):setTimeout(()=>{this.open||(this.panelEl.style.display="none")},160)}addMessage(t,r){t==="assistant"&&this.typingEl&&(this.typingEl.remove(),this.typingEl=null);let e=document.createElement("div");e.className=`lr-msg lr-msg-${t}`,e.textContent=r,this.messagesEl.appendChild(e),this.messagesEl.scrollTop=this.messagesEl.scrollHeight}setBusy(t){var r;if(this.sendBtn.disabled=t,this.inputEl.disabled=t,t){let e=document.createElement("div");e.className="lr-msg lr-msg-assistant lr-typing",e.innerHTML="<span></span><span></span><span></span>",this.messagesEl.appendChild(e),this.messagesEl.scrollTop=this.messagesEl.scrollHeight,this.typingEl=e}else(r=this.typingEl)==null||r.remove(),this.typingEl=null}renderShell(t,r){let e=t.primaryColor||"#2563eb",n=y(e,-.18),i=t.logoUrl?`<img src="${l(t.logoUrl)}" alt="" id="lr-avatar-img" />`:`<span id="lr-avatar-fallback">${l((t.agentName||t.companyName||"?").charAt(0).toUpperCase())}</span>`;return`
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
    background: ${e}; box-shadow: 0 10px 24px -6px ${e}66, 0 2px 8px rgba(0,0,0,0.15);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  #lr-bubble:hover { transform: scale(1.06); box-shadow: 0 14px 28px -6px ${e}80, 0 2px 8px rgba(0,0,0,0.18); }
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
  #lr-status { display: none; align-items: center; gap: 6px; padding: 6px 16px 9px; font-size: 11px; color: #fff; }
  #lr-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; animation: lr-pulse 1.8s infinite ease-in-out; }

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
  #lr-input:focus { border-color: ${e}; }
  #lr-send { border: none; color: #fff; background: ${e}; border-radius: 50%; width: 36px; height: 36px;
    cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform .1s ease, opacity .15s ease; }
  #lr-send:hover:not(:disabled) { transform: scale(1.06); }
  #lr-send:disabled, #lr-input:disabled { opacity: .55; cursor: default; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Modern \u2014 gradient header, live-status bar, soft bubbles \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="modern"] #lr-header { background: linear-gradient(135deg, ${e}, ${n}); padding-bottom: 8px; }
  #lr-panel[data-template="modern"] #lr-status { display: flex; background: linear-gradient(135deg, ${e}, ${n}); }
  #lr-panel[data-template="modern"] .lr-msg-assistant { border-radius: 4px 16px 16px 16px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  #lr-panel[data-template="modern"] .lr-msg-user { background: ${e}; border-radius: 16px 4px 16px 16px; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Minimal Flat \u2014 bare, quiet, no avatar/status/shadow \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="minimal"] { border-radius: 8px; box-shadow: 0 2px 16px rgba(15,23,42,0.14); }
  #lr-panel[data-template="minimal"] #lr-header { background: ${e}; }
  #lr-panel[data-template="minimal"] #lr-avatar { display: none; }
  #lr-bubble[data-template="minimal"] { border-radius: 14px; box-shadow: 0 3px 10px rgba(0,0,0,0.16); }
  #lr-panel[data-template="minimal"] .lr-msg { border-radius: 6px; }
  #lr-panel[data-template="minimal"] .lr-msg-user { background: ${e}; }
  #lr-panel[data-template="minimal"] #lr-input { border-radius: 6px; }
  #lr-panel[data-template="minimal"] #lr-send { border-radius: 6px; }

  /* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 Compact Chips \u2014 icon avatar, horizontal pill quick-replies \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */
  #lr-panel[data-template="chips"] #lr-header { background: ${e}; }
  #lr-panel[data-template="chips"] #lr-avatar { background: #fff; color: ${e}; }
  #lr-panel[data-template="chips"] .lr-msg { border-radius: 12px; }
  #lr-panel[data-template="chips"] .lr-msg-assistant { border-radius: 4px 12px 12px 12px; }
  #lr-panel[data-template="chips"] .lr-msg-user { background: ${e}; border-radius: 12px 4px 12px 12px; }
  .lr-chips { display: flex; flex-wrap: wrap; gap: 6px; animation: lr-fade-in .2s ease; }
  .lr-chip { border: 1.5px solid ${e}; background: #fff; color: ${e}; font-size: 12.5px; font-weight: 600;
    padding: 7px 12px; border-radius: 999px; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .lr-chip:hover { background: ${e}; color: #fff; }

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
  #lr-panel[data-template="dark"] #lr-send { background: ${e}; }
  .lr-actions { display: flex; flex-direction: column; gap: 6px; width: 100%; animation: lr-fade-in .2s ease; }
  .lr-action { display: flex; align-items: center; justify-content: space-between; width: 100%; text-align: left;
    background: #fff; border: 1px solid #e4e6ea; color: #1e2430; font-size: 13px; font-weight: 500;
    padding: 10px 13px; border-radius: 10px; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
  .lr-action:hover { border-color: ${e}; background: ${e}0d; }
  .lr-action svg { flex-shrink: 0; color: ${e}; margin-left: 8px; }
</style>
<button id="lr-bubble" data-template="${r}" aria-label="Open chat">${v}</button>
<div id="lr-panel" data-template="${r}">
  <div id="lr-header">
    <div id="lr-avatar">${i}</div>
    <div id="lr-header-text">
      <span id="lr-header-name">${l(t.agentName)}</span>
      <span id="lr-header-sub">${l(t.companyName)}</span>
    </div>
    <button id="lr-close" aria-label="Close chat">${k}</button>
  </div>
  <div id="lr-status"><span id="lr-status-dot"></span>We're online</div>
  <div id="lr-messages"></div>
  <div id="lr-inputbar">
    <input id="lr-input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="lr-send" aria-label="Send">${w}</button>
  </div>
</div>`}};function b(a){var e;let t=document.currentScript;if(t!=null&&t.dataset[a])return t.dataset[a];let r=document.querySelector(`script[data-${a.replace(/[A-Z]/g,n=>"-"+n.toLowerCase())}]`);return(e=r==null?void 0:r.dataset[a])!=null?e:null}function $(){return b("widgetKey")}function I(){return b("apiUrl")||g}async function C(a,t){try{let r=await fetch(`${t}/public/widget/config?widgetKey=${encodeURIComponent(a)}`);return r.ok?(await r.json()).data:null}catch(r){return null}}async function M(a,t,r,e,n){var i,s;try{let o=await fetch(`${a}/public/widget/chat?widgetKey=${encodeURIComponent(t)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:r,visitorId:e,message:n,pageUrl:location.href})}),d=await o.json();return!o.ok||!d.success?d.message||"Sorry, I'm having trouble responding right now.":(s=(i=d.data)==null?void 0:i.response)!=null?s:"Sorry, I didn't catch that."}catch(o){return"Sorry, I'm having trouble connecting right now. Please try again shortly."}}async function f(){let a=$();if(!a){console.warn("[LeadRyze Widget] Missing data-widget-key on the <script> tag \u2014 widget not loaded.");return}let t=I(),r=await C(a,t);if(!r){console.warn("[LeadRyze Widget] Could not load widget config (disabled, unknown key, or disallowed origin) \u2014 widget not loaded.");return}let e=h(),n=x(),i=new c(r,async s=>{i.setBusy(!0);let o=await M(t,a,n,e,s);i.addMessage("assistant",o),i.setBusy(!1)})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{f()}):f();})();
