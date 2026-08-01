"use strict";(()=>{var p="http://localhost:5000/api/v1";var c="__leadryze_visitor_id",u="__leadryze_session_id";function d(){return typeof crypto!="undefined"&&typeof crypto.randomUUID=="function"?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,t=>{let e=Math.random()*16|0;return(t==="x"?e:e&3|8).toString(16)})}function h(){try{let t=localStorage.getItem(c);return t||(t=d(),localStorage.setItem(c,t)),t}catch(t){return d()}}function x(){try{let t=sessionStorage.getItem(u);return t||(t=d(),sessionStorage.setItem(u,t)),t}catch(t){return d()}}function f(t){let e=document.createElement("div");return e.textContent=t,e.innerHTML}var l=class{constructor(e,n){this.open=!1;let i=document.createElement("div");i.id="leadryze-widget-host",i.style.cssText="all: initial; position: fixed; z-index: 2147483000;",document.body.appendChild(i),this.shadow=i.attachShadow({mode:"open"}),this.shadow.innerHTML=this.renderShell(e),this.bubbleEl=this.shadow.getElementById("lr-bubble"),this.panelEl=this.shadow.getElementById("lr-panel"),this.messagesEl=this.shadow.getElementById("lr-messages"),this.inputEl=this.shadow.getElementById("lr-input"),this.sendBtn=this.shadow.getElementById("lr-send");let r=this.shadow.getElementById("lr-close");this.bubbleEl.addEventListener("click",()=>this.toggle()),r.addEventListener("click",()=>this.toggle()),this.sendBtn.addEventListener("click",()=>this.handleSend(n)),this.inputEl.addEventListener("keydown",s=>{s.key==="Enter"&&this.handleSend(n)}),e.greeting&&this.addMessage("assistant",e.greeting)}handleSend(e){let n=this.inputEl.value.trim();n&&(this.inputEl.value="",this.addMessage("user",n),e(n))}toggle(){this.open=!this.open,this.panelEl.style.display=this.open?"flex":"none"}addMessage(e,n){let i=document.createElement("div");i.className=`lr-msg lr-msg-${e}`,i.textContent=n,this.messagesEl.appendChild(i),this.messagesEl.scrollTop=this.messagesEl.scrollHeight}setBusy(e){this.sendBtn.disabled=e,this.inputEl.disabled=e}renderShell(e){let n=e.primaryColor||"#2563eb";return`
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  #lr-bubble {
    position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%;
    border: none; color: #fff; font-size: 24px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  }
  #lr-panel {
    display: none; flex-direction: column; position: fixed; right: 20px; bottom: 88px;
    width: 320px; height: 440px; max-height: 70vh; background: #fff; border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.25); overflow: hidden;
  }
  #lr-header {
    display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
    color: #fff; font-size: 14px; font-weight: 600;
  }
  #lr-close { background: none; border: none; color: #fff; font-size: 16px; cursor: pointer; }
  #lr-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: #f7f7f8; }
  .lr-msg { max-width: 85%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.4; white-space: pre-wrap; }
  .lr-msg-assistant { align-self: flex-start; background: #fff; border: 1px solid #e5e5e5; color: #1a1a1a; }
  .lr-msg-user { align-self: flex-end; background: ${n}; color: #fff; }
  #lr-inputbar { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #eee; }
  #lr-input { flex: 1; padding: 8px 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 13px; }
  #lr-send { border: none; color: #fff; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  #lr-send:disabled, #lr-input:disabled { opacity: 0.6; cursor: default; }
</style>
<button id="lr-bubble" aria-label="Open chat" style="background:${n}">&#128172;</button>
<div id="lr-panel">
  <div id="lr-header" style="background:${n}">
    <span>${f(e.agentName)} &middot; ${f(e.companyName)}</span>
    <button id="lr-close" aria-label="Close chat">&#10005;</button>
  </div>
  <div id="lr-messages"></div>
  <div id="lr-inputbar">
    <input id="lr-input" type="text" placeholder="Type a message..." />
    <button id="lr-send" style="background:${n}" aria-label="Send">&#10148;</button>
  </div>
</div>`}};function y(t){var i;let e=document.currentScript;if(e!=null&&e.dataset[t])return e.dataset[t];let n=document.querySelector(`script[data-${t.replace(/[A-Z]/g,r=>"-"+r.toLowerCase())}]`);return(i=n==null?void 0:n.dataset[t])!=null?i:null}function b(){return y("widgetKey")}function E(){return y("apiUrl")||p}async function v(t,e){try{let n=await fetch(`${e}/public/widget/config?widgetKey=${encodeURIComponent(t)}`);return n.ok?(await n.json()).data:null}catch(n){return null}}async function w(t,e,n,i,r){var s,a;try{let o=await fetch(`${t}/public/widget/chat?widgetKey=${encodeURIComponent(e)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:n,visitorId:i,message:r,pageUrl:location.href})}),g=await o.json();return!o.ok||!g.success?g.message||"Sorry, I'm having trouble responding right now.":(a=(s=g.data)==null?void 0:s.response)!=null?a:"Sorry, I didn't catch that."}catch(o){return"Sorry, I'm having trouble connecting right now. Please try again shortly."}}async function m(){let t=b();if(!t){console.warn("[LeadRyze Widget] Missing data-widget-key on the <script> tag \u2014 widget not loaded.");return}let e=E(),n=await v(t,e);if(!n){console.warn("[LeadRyze Widget] Could not load widget config (disabled, unknown key, or disallowed origin) \u2014 widget not loaded.");return}let i=h(),r=x(),s=new l(n,async a=>{s.setBusy(!0);let o=await w(e,t,r,i,a);s.addMessage("assistant",o),s.setBusy(!1)})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",()=>{m()}):m();})();
