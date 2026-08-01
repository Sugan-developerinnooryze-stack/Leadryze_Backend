"use strict";(()=>{var g="https://leadryze-backend.onrender.com/api/v1";var m="__leadryze_visitor_id",h="__leadryze_session_id";function d(){return typeof crypto!="undefined"&&typeof crypto.randomUUID=="function"?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,r=>{let e=Math.random()*16|0;return(r==="x"?e:e&3|8).toString(16)})}function u(){try{let r=localStorage.getItem(m);return r||(r=d(),localStorage.setItem(m,r)),r}catch(r){return d()}}function x(){try{let r=sessionStorage.getItem(h);return r||(r=d(),sessionStorage.setItem(h,r)),r}catch(r){return d()}}function p(r){let e=document.createElement("div");return e.textContent=r,e.innerHTML}function y(r,e){let t=/^#?([0-9a-f]{6})$/i.exec(r.trim());if(!t)return r;let a=parseInt(t[1],16),n=l=>Math.round(Math.max(0,Math.min(255,l))),s=n((a>>16&255)+255*e),i=n((a>>8&255)+255*e),o=n((a&255)+255*e);return`#${((1<<24)+(s<<16)+(i<<8)+o).toString(16).slice(1)}`}var v='<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',k='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',w='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',E=["Book an appointment","I have a question","Talk to a human"],c=class{constructor(e,t){this.open=!1;this.typingEl=null;var s;this.onSend=t;let a=document.createElement("div");a.id="leadryze-widget-host",a.style.cssText="all: initial; position: fixed; z-index: 2147483000;",document.body.appendChild(a),this.shadow=a.attachShadow({mode:"open"}),this.shadow.innerHTML=this.renderShell(e),this.bubbleEl=this.shadow.getElementById("lr-bubble"),this.panelEl=this.shadow.getElementById("lr-panel"),this.messagesEl=this.shadow.getElementById("lr-messages"),this.inputEl=this.shadow.getElementById("lr-input"),this.sendBtn=this.shadow.getElementById("lr-send");let n=this.shadow.getElementById("lr-close");this.bubbleEl.addEventListener("click",()=>this.toggle()),n.addEventListener("click",()=>this.toggle()),this.sendBtn.addEventListener("click",()=>this.handleSend()),this.inputEl.addEventListener("keydown",i=>{i.key==="Enter"&&this.handleSend()}),e.greeting&&this.addMessage("assistant",e.greeting),((s=e.template)!=null?s:"modern")==="chips"&&this.renderChipSuggestions()}renderChipSuggestions(){let e=document.createElement("div");e.className="lr-chips";for(let t of E){let a=document.createElement("button");a.className="lr-chip",a.type="button",a.textContent=t,a.addEventListener("click",()=>{e.remove(),this.sendText(t)}),e.appendChild(a)}this.messagesEl.appendChild(e),this.messagesEl.scrollTop=this.messagesEl.scrollHeight}handleSend(){let e=this.inputEl.value.trim();e&&(this.inputEl.value="",this.sendText(e))}sendText(e){this.addMessage("user",e),this.onSend(e)}toggle(){this.open=!this.open,this.panelEl.classList.toggle("lr-open",this.open),this.open?(this.panelEl.style.display="flex",requestAnimationFrame(()=>this.inputEl.focus())):setTimeout(()=>{this.open||(this.panelEl.style.display="none")},160)}addMessage(e,t){e==="assistant"&&this.typingEl&&(this.typingEl.remove(),this.typingEl=null);let a=document.createElement("div");a.className=`lr-msg lr-msg-${e}`,a.textContent=t,this.messagesEl.appendChild(a),this.messagesEl.scrollTop=this.messagesEl.scrollHeight}setBusy(e){var t;if(this.sendBtn.disabled=e,this.inputEl.disabled=e,e){let a=document.createElement("div");a.className="lr-msg lr-msg-assistant lr-typing",a.innerHTML="<span></span><span></span><span></span>",this.messagesEl.appendChild(a),this.messagesEl.scrollTop=this.messagesEl.scrollHeight,this.typingEl=a}else(t=this.typingEl)==null||t.remove(),this.typingEl=null}renderShell(e){var i;let t=e.primaryColor||"#2563eb",a=y(t,-.18),n=(i=e.template)!=null?i:"modern",s=e.logoUrl?`<img src="${p(e.logoUrl)}" alt="" id="lr-avatar-img" />`:`<span id="lr-avatar-fallback">${p((e.agentName||e.companyName||"?").charAt(0).toUpperCase())}</span>`;return`
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  @keyframes lr-pop { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes lr-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
  @keyframes lr-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

  /* \u2500\u2500 Base structure shared by every template \u2014 only look-and-feel differs \u2500\u2500 */
  #lr-bubble {
    position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px; border-radius: 50%;
    border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
    background: ${t}; box-shadow: 0 10px 24px -6px ${t}66, 0 2px 8px rgba(0,0,0,0.15);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  #lr-bubble:hover { transform: scale(1.06); box-shadow: 0 14px 28px -6px ${t}80, 0 2px 8px rgba(0,0,0,0.18); }
  #lr-bubble:active { transform: scale(.97); }

  #lr-panel {
    display: none; flex-direction: column; position: fixed; right: 22px; bottom: 96px;
    width: 336px; height: 460px; max-height: 72vh; background: #fff; border-radius: 18px;
    box-shadow: 0 20px 50px -12px rgba(15,23,42,0.3), 0 4px 14px rgba(15,23,42,0.1);
    overflow: hidden; opacity: 0; transform: translateY(10px) scale(.97);
    transition: opacity .16s ease, transform .16s ease;
  }
  #lr-panel.lr-open { opacity: 1; transform: translateY(0) scale(1); animation: lr-pop .16s ease; }

  #lr-header {
    display: flex; align-items: center; gap: 10px; padding: 14px 16px;
    background: linear-gradient(135deg, ${t}, ${a}); color: #fff; flex-shrink: 0;
  }
  #lr-avatar { width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,0.22);
    display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; font-weight: 700; font-size: 14px; }
  #lr-avatar-img { width: 100%; height: 100%; object-fit: cover; }
  #lr-header-text { flex: 1; min-width: 0; }
  #lr-header-name { display: block; font-size: 14px; font-weight: 600; letter-spacing: .1px; }
  #lr-header-sub { display: block; font-size: 11.5px; opacity: .85; margin-top: 1px; }
  #lr-close { background: rgba(255,255,255,0.14); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%;
    cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background .15s ease; }
  #lr-close:hover { background: rgba(255,255,255,0.26); }

  #lr-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #f8f9fb; }
  #lr-messages::-webkit-scrollbar { width: 6px; }
  #lr-messages::-webkit-scrollbar-thumb { background: #d8dce3; border-radius: 3px; }

  .lr-msg { max-width: 82%; padding: 9px 13px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap;
    word-break: break-word; animation: lr-fade-in .18s ease; }
  .lr-msg-assistant { align-self: flex-start; background: #fff; border: 1px solid #e8eaee; color: #1e2430;
    border-radius: 4px 16px 16px 16px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
  .lr-msg-user { align-self: flex-end; background: ${t}; color: #fff; border-radius: 16px 4px 16px 16px; }

  .lr-typing { display: flex; align-items: center; gap: 4px; padding: 12px 14px; }
  .lr-typing span { width: 6px; height: 6px; border-radius: 50%; background: #a7adba; display: inline-block;
    animation: lr-bounce 1.2s infinite ease-in-out; }
  .lr-typing span:nth-child(2) { animation-delay: .15s; }
  .lr-typing span:nth-child(3) { animation-delay: .3s; }

  .lr-chips { display: flex; flex-wrap: wrap; gap: 6px; animation: lr-fade-in .2s ease; }
  .lr-chip { border: 1.5px solid ${t}; background: #fff; color: ${t}; font-size: 12.5px; font-weight: 600;
    padding: 7px 12px; border-radius: 999px; cursor: pointer; transition: background .15s ease, color .15s ease; }
  .lr-chip:hover { background: ${t}; color: #fff; }

  #lr-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #edeef2; background: #fff; flex-shrink: 0; }
  #lr-input { flex: 1; padding: 9px 13px; border: 1px solid #dfe2e8; border-radius: 22px; font-size: 13.5px;
    outline: none; transition: border-color .15s ease; }
  #lr-input:focus { border-color: ${t}; }
  #lr-send { border: none; color: #fff; background: ${t}; border-radius: 50%; width: 36px; height: 36px;
    cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform .1s ease, opacity .15s ease; }
  #lr-send:hover:not(:disabled) { transform: scale(1.06); }
  #lr-send:disabled, #lr-input:disabled { opacity: .55; cursor: default; }

  /* \u2500\u2500 Minimal Flat \u2014 understated, low-key, no heavy shadows/gradients \u2500\u2500 */
  #lr-panel[data-template="minimal"] { border-radius: 8px; box-shadow: 0 2px 16px rgba(15,23,42,0.14); }
  #lr-panel[data-template="minimal"] #lr-header { background: ${t}; }
  #lr-panel[data-template="minimal"] #lr-avatar { display: none; }
  #lr-bubble[data-template="minimal"] { border-radius: 14px; box-shadow: 0 3px 10px rgba(0,0,0,0.16); }
  #lr-panel[data-template="minimal"] .lr-msg { border-radius: 8px; }
  #lr-panel[data-template="minimal"] .lr-msg-assistant { box-shadow: none; }
  #lr-panel[data-template="minimal"] #lr-input { border-radius: 8px; }
  #lr-panel[data-template="minimal"] #lr-send { border-radius: 8px; }

  /* \u2500\u2500 Compact Chips \u2014 flat header, icon avatar, quick-reply suggestions \u2500\u2500 */
  #lr-panel[data-template="chips"] #lr-header { background: ${t}; }
  #lr-panel[data-template="chips"] #lr-avatar { background: #fff; color: ${t}; }
  #lr-panel[data-template="chips"] .lr-msg { border-radius: 12px; }
  #lr-panel[data-template="chips"] .lr-msg-assistant { border-radius: 4px 12px 12px 12px; }
  #lr-panel[data-template="chips"] .lr-msg-user { border-radius: 12px 4px 12px 12px; }

  /* \u2500\u2500 Dark Professional \u2014 dark chrome, light readable message area \u2500\u2500 */
  #lr-panel[data-template="dark"] { background: #f4f5f7; }
  #lr-panel[data-template="dark"] #lr-header { background: #1a1f2e; }
  #lr-panel[data-template="dark"] #lr-avatar { background: rgba(255,255,255,0.1); }
  #lr-panel[data-template="dark"] #lr-close { background: rgba(255,255,255,0.08); }
  #lr-panel[data-template="dark"] #lr-close:hover { background: rgba(255,255,255,0.16); }
  #lr-panel[data-template="dark"] #lr-messages { background: #f4f5f7; }
  #lr-panel[data-template="dark"] #lr-inputbar { background: #fff; border-top-color: #e4e6ea; }
</style>
<button id="lr-bubble" data-template="${n}" aria-label="Open chat">${v}</button>
<div id="lr-panel" data-template="${n}">
  <div id="lr-header">
    <div id="lr-avatar">${s}</div>
    <div id="lr-header-text">
      <span id="lr-header-name">${p(e.agentName)}</span>
      <span id="lr-header-sub">${p(e.companyName)}</span>
    </div>
    <button id="lr-close" aria-label="Close chat">${k}</button>
  </div>
  <div id="lr-messages"></div>
  <div id="lr-inputbar">
    <input id="lr-input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="lr-send" aria-label="Send">${w}</button>
  </div>
</div>`}};function b(r){var a;let e=document.currentScript;if(e!=null&&e.dataset[r])return e.dataset[r];let t=document.querySelector(`script[data-${r.replace(/[A-Z]/g,n=>"-"+n.toLowerCase())}]`);return(a=t==null?void 0:t.dataset[r])!=null?a:null}function S(){return b("widgetKey")}function C(){return b("apiUrl")||g}async function I(r,e){try{let t=await fetch(`${e}/public/widget/config?widgetKey=${encodeURIComponent(r)}`);return t.ok?(await t.json()).data:null}catch(t){return null}}async function L(r,e,t,a,n){var s,i;try{let o=await fetch(`${r}/public/widget/chat?widgetKey=${encodeURIComponent(e)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:t,visitorId:a,message:n,pageUrl:location.href})}),l=await o.json();return!o.ok||!l.success?l.message||"Sorry, I'm having trouble responding right now.":(i=(s=l.data)==null?void 0:s.response)!=null?i:"Sorry, I didn't catch that."}catch(o){return"Sorry, I'm having trouble connecting right now. Please try again shortly."}}async function f(){let r=S();if(!r){console.warn("[LeadRyze Widget] Missing data-widget-key on the <script> tag \u2014 widget not loaded.");return}let e=C(),t=await I(r,e);if(!t){console.warn("[LeadRyze Widget] Could not load widget config (disabled, unknown key, or disallowed origin) \u2014 widget not loaded.");return}let a=u(),n=x(),s=new c(t,async i=>{s.setBusy(!0);let o=await L(e,r,n,a,i);s.addMessage("assistant",o),s.setBusy(!1)})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{f()}):f();})();
