"use strict";(()=>{var g="https://leadryze-backend.onrender.com/api/v1";var h="__leadryze_visitor_id",u="__leadryze_session_id";function d(){return typeof crypto!="undefined"&&typeof crypto.randomUUID=="function"?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,n=>{let e=Math.random()*16|0;return(n==="x"?e:e&3|8).toString(16)})}function x(){try{let n=localStorage.getItem(h);return n||(n=d(),localStorage.setItem(h,n)),n}catch(n){return d()}}function f(){try{let n=sessionStorage.getItem(u);return n||(n=d(),sessionStorage.setItem(u,n)),n}catch(n){return d()}}function p(n){let e=document.createElement("div");return e.textContent=n,e.innerHTML}function y(n,e){let t=/^#?([0-9a-f]{6})$/i.exec(n.trim());if(!t)return n;let i=parseInt(t[1],16),r=l=>Math.round(Math.max(0,Math.min(255,l))),s=r((i>>16&255)+255*e),o=r((i>>8&255)+255*e),a=r((i&255)+255*e);return`#${((1<<24)+(s<<16)+(o<<8)+a).toString(16).slice(1)}`}var v='<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',w='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',E='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>',c=class{constructor(e,t){this.open=!1;this.typingEl=null;let i=document.createElement("div");i.id="leadryze-widget-host",i.style.cssText="all: initial; position: fixed; z-index: 2147483000;",document.body.appendChild(i),this.shadow=i.attachShadow({mode:"open"}),this.shadow.innerHTML=this.renderShell(e),this.bubbleEl=this.shadow.getElementById("lr-bubble"),this.panelEl=this.shadow.getElementById("lr-panel"),this.messagesEl=this.shadow.getElementById("lr-messages"),this.inputEl=this.shadow.getElementById("lr-input"),this.sendBtn=this.shadow.getElementById("lr-send");let r=this.shadow.getElementById("lr-close");this.bubbleEl.addEventListener("click",()=>this.toggle()),r.addEventListener("click",()=>this.toggle()),this.sendBtn.addEventListener("click",()=>this.handleSend(t)),this.inputEl.addEventListener("keydown",s=>{s.key==="Enter"&&this.handleSend(t)}),e.greeting&&this.addMessage("assistant",e.greeting)}handleSend(e){let t=this.inputEl.value.trim();t&&(this.inputEl.value="",this.addMessage("user",t),e(t))}toggle(){this.open=!this.open,this.panelEl.classList.toggle("lr-open",this.open),this.open?(this.panelEl.style.display="flex",requestAnimationFrame(()=>this.inputEl.focus())):setTimeout(()=>{this.open||(this.panelEl.style.display="none")},160)}addMessage(e,t){e==="assistant"&&this.typingEl&&(this.typingEl.remove(),this.typingEl=null);let i=document.createElement("div");i.className=`lr-msg lr-msg-${e}`,i.textContent=t,this.messagesEl.appendChild(i),this.messagesEl.scrollTop=this.messagesEl.scrollHeight}setBusy(e){var t;if(this.sendBtn.disabled=e,this.inputEl.disabled=e,e){let i=document.createElement("div");i.className="lr-msg lr-msg-assistant lr-typing",i.innerHTML="<span></span><span></span><span></span>",this.messagesEl.appendChild(i),this.messagesEl.scrollTop=this.messagesEl.scrollHeight,this.typingEl=i}else(t=this.typingEl)==null||t.remove(),this.typingEl=null}renderShell(e){let t=e.primaryColor||"#2563eb",i=y(t,-.18),r=e.logoUrl?`<img src="${p(e.logoUrl)}" alt="" id="lr-avatar-img" />`:`<span id="lr-avatar-fallback">${p((e.agentName||e.companyName||"?").charAt(0).toUpperCase())}</span>`;return`
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  @keyframes lr-pop { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes lr-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
  @keyframes lr-fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

  #lr-bubble {
    position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px; border-radius: 50%;
    border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 10px 24px -6px ${t}66, 0 2px 8px rgba(0,0,0,0.15);
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
    background: linear-gradient(135deg, ${t}, ${i}); color: #fff; flex-shrink: 0;
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

  #lr-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #edeef2; background: #fff; flex-shrink: 0; }
  #lr-input { flex: 1; padding: 9px 13px; border: 1px solid #dfe2e8; border-radius: 22px; font-size: 13.5px;
    outline: none; transition: border-color .15s ease; }
  #lr-input:focus { border-color: ${t}; }
  #lr-send { border: none; color: #fff; background: ${t}; border-radius: 50%; width: 36px; height: 36px;
    cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: transform .1s ease, opacity .15s ease; }
  #lr-send:hover:not(:disabled) { transform: scale(1.06); }
  #lr-send:disabled, #lr-input:disabled { opacity: .55; cursor: default; }
</style>
<button id="lr-bubble" aria-label="Open chat" style="background:${t}">${v}</button>
<div id="lr-panel">
  <div id="lr-header">
    <div id="lr-avatar">${r}</div>
    <div id="lr-header-text">
      <span id="lr-header-name">${p(e.agentName)}</span>
      <span id="lr-header-sub">${p(e.companyName)}</span>
    </div>
    <button id="lr-close" aria-label="Close chat">${w}</button>
  </div>
  <div id="lr-messages"></div>
  <div id="lr-inputbar">
    <input id="lr-input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="lr-send" aria-label="Send">${E}</button>
  </div>
</div>`}};function b(n){var i;let e=document.currentScript;if(e!=null&&e.dataset[n])return e.dataset[n];let t=document.querySelector(`script[data-${n.replace(/[A-Z]/g,r=>"-"+r.toLowerCase())}]`);return(i=t==null?void 0:t.dataset[n])!=null?i:null}function k(){return b("widgetKey")}function S(){return b("apiUrl")||g}async function I(n,e){try{let t=await fetch(`${e}/public/widget/config?widgetKey=${encodeURIComponent(n)}`);return t.ok?(await t.json()).data:null}catch(t){return null}}async function L(n,e,t,i,r){var s,o;try{let a=await fetch(`${n}/public/widget/chat?widgetKey=${encodeURIComponent(e)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:t,visitorId:i,message:r,pageUrl:location.href})}),l=await a.json();return!a.ok||!l.success?l.message||"Sorry, I'm having trouble responding right now.":(o=(s=l.data)==null?void 0:s.response)!=null?o:"Sorry, I didn't catch that."}catch(a){return"Sorry, I'm having trouble connecting right now. Please try again shortly."}}async function m(){let n=k();if(!n){console.warn("[LeadRyze Widget] Missing data-widget-key on the <script> tag \u2014 widget not loaded.");return}let e=S(),t=await I(n,e);if(!t){console.warn("[LeadRyze Widget] Could not load widget config (disabled, unknown key, or disallowed origin) \u2014 widget not loaded.");return}let i=x(),r=f(),s=new c(t,async o=>{s.setBusy(!0);let a=await L(e,n,r,i,o);s.addMessage("assistant",a),s.setBusy(!1)})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{m()}):m();})();
