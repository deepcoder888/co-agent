// Central local-file navigation. Only registry identities/indexes cross the API boundary.
import { setStyle } from './display.js';

const hintFor = agent => agent.kind === 'role' ? 'Ctrl+单击打开定义文件' : 'Ctrl+单击打开原书';
function hint(el, agent) {
  const withoutHint = value => (value || '').replace(/(?:\n)?Ctrl\+单击打开(?:原书|定义文件)$/, '');
  const parent = el.parentElement?.closest?.('[data-agent-link]');
  const inherited = parent?.getAttribute('data-agent-link') === agent.id ? parent.title : '';
  const base = withoutHint(el.title || el.getAttribute?.('title')) || withoutHint(inherited);
  const title = [base, hintFor(agent)].filter(Boolean).join('\n');
  if (el.title !== title) { el.title = title; el.setAttribute('title', title); }
}
export function markAgentLink(el, agent) {
  const id = typeof agent === 'string' ? agent : agent?.id || agent?.agentId;
  if (!id) return el;
  el.setAttribute('data-agent-link', id);
  if (agent?.kind) hint(el, agent);
  return el;
}
export function fillAgentNames(doc, el, members = [], prefix = '') {
  el.replaceChildren(); el.removeAttribute?.('data-agent-link');
  if (prefix) { const before=doc.createElement('span');before.textContent=prefix;el.append(before); }
  members.forEach((member, i) => {
    if (i) { const separator=doc.createElement('span');separator.textContent='、';el.append(separator); }
    const name=doc.createElement('span');name.textContent=member.name || member.codexName || member.claudeName || member.id || '未载明';
    el.append(markAgentLink(name,member));
  });
  // A single-member button should also work when keyboard focus is on the button.
  if (members.length===1) markAgentLink(el,members[0]);
  return el;
}
export function runningMembers(item) {
  return item.type==='joint'?(item.whitelist || []).map(a=>({...a,name:a.codexName || a.claudeName || a.name})):[{id:item.agentId,name:item.agentName}];
}
export function openFileButton(doc, agent, actions, className = '') {
  const button=doc.createElement('button');button.type='button';button.className=className;
  button.textContent=agent.kind==='role'?'打开定义文件':'打开原书';
  button.setAttribute('data-open-agent',agent.id);button.setAttribute('data-focus-key','detail-open-file');
  // v0.41: a book opens in the app's reading mode; a role's definition file still opens with the system program.
  button.addEventListener('click',event=>agent.kind==='book'&&actions.readBook?actions.readBook(agent.id,event.currentTarget):actions.openAgentFile(agent.id,event));return button;
}

export function mountAgentLinks(doc, {api, getRegistry}) {
  const create=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const menu=create('div');menu.id='agent-book-menu';menu.className='agent-book-menu';menu.hidden=true;
  menu.setAttribute('role','menu');menu.setAttribute('aria-label','选择原书');menu.setAttribute('popover','manual');
  const toast=create('div');toast.id='agent-open-status';toast.className='agent-open-toast';toast.hidden=true;
  toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');toast.setAttribute('aria-atomic','true');
  doc.body.append(menu,toast);
  let disposed=false, busy=false, anchor, anchorKey, anchorId, anchorScope, anchorAgent, anchorPosition, items=[], choices=[], cursor=0;
  const find=id=>(getRegistry()?.agents || []).find(a=>a.id===id);
  const host=trigger=>{const dialog=trigger?.closest?.('dialog');return dialog?.open&&dialog.isConnected!==false?dialog:doc.body;};
  function replacementAnchor() {
    const byId=anchorId&&doc.getElementById(anchorId);
    if(byId&&!byId.closest('[hidden]'))return byId;
    if(anchorKey)return Array.from(doc.querySelectorAll('[data-focus-key]')).find(el=>el.getAttribute('data-focus-key')===anchorKey&&!el.closest('[hidden]'));
    const scope=anchorScope&&doc.getElementById(anchorScope);
    return scope&&!scope.closest('[hidden]')?agentLinksIn(scope)[anchorPosition]:null;
  }
  function agentLinksIn(scope) {
    return Array.from(scope.querySelectorAll('[data-agent-link]')).filter(el=>el.getAttribute('data-agent-link')===anchorAgent);
  }
  function refresh() {
    if(disposed)return;
    for(const link of doc.querySelectorAll('[data-agent-link]')) {
      const agent=find(link.getAttribute('data-agent-link'));if(!agent)continue;hint(link,agent);
      const interactive=['BUTTON','A','INPUT','SELECT','TEXTAREA','SUMMARY'].includes(link.tagName?.toUpperCase());
      // Names in a multi-member button need their own focus stops. Single-member
      // buttons already carry the identity and need no duplicate nested tab stop.
      const parentLink=link.parentElement?.closest?.('[data-agent-link]');
      if(!interactive && !parentLink && link.getAttribute('tabindex')===null)link.setAttribute('tabindex','0');
    }
    if(!menu.hidden && anchor?.isConnected===false) {
      const replacement=replacementAnchor();
      if(replacement && menu.isConnected!==false) {
        anchor=replacement;anchor.setAttribute('aria-haspopup','menu');anchor.setAttribute('aria-expanded','true');
      } else closeMenu(false);
    }
  }
  function restore() {
    if(anchor?.isConnected!==false && !anchor?.closest?.('[hidden]'))anchor?.focus?.();
    else replacementAnchor()?.focus();
  }
  function closeMenu(focus=true) {
    if(menu.hidden)return;
    try { menu.hidePopover?.(); } catch { /* Already dismissed by the host. */ }
    menu.hidden=true;anchor?.setAttribute('aria-expanded','false');if(focus)restore();
  }
  function notify(message, trigger, reveal) {
    if(disposed)return;
    host(trigger).append(toast);toast.replaceChildren(create('span',message));toast.hidden=false;
    if(reveal){const button=create('button','打开所在文件夹');button.type='button';button.addEventListener('click',reveal);toast.append(button);}
  }
  async function request(agent, target, file, trigger, reveal=false) {
    if(disposed||busy)return;
    busy=true;closeMenu();
    const body={agentId:agent.id,target,...(target==='book'?{index:file.index}:{}),...(reveal?{reveal:true}:{})};
    try {
      await api('/api/open',body);
      notify(reveal?'已打开所在文件夹':target==='book'?`已用默认程序打开《${file.label}》`:`已用默认程序打开定义文件「${agent.name}」`,trigger);
    } catch(error) {
      const path=error.data?.path;
      const message=path?`${error.message}：${path}`:`打开失败：${error.message}`;
      notify(message,trigger,!reveal&&error.status===404&&error.data?.folderExists===true?()=>request(agent,target,file,trigger,true):null);
    } finally {busy=false;}
  }
  function showMenu(agent, trigger, event) {
    closeMenu(false);anchor=trigger;anchorKey=trigger?.closest?.('[data-focus-key]')?.getAttribute('data-focus-key');
    anchorId=trigger?.id;anchorAgent=agent.id;
    const scope=trigger?.parentElement?.closest?.('[id]');anchorScope=scope?.id;anchorPosition=scope?agentLinksIn(scope).indexOf(trigger):-1;
    items=[];choices=[];cursor=0;menu.replaceChildren();host(trigger).append(menu);
    for(const file of agent.bookFiles) {
      const item=create('button',file.label);item.type='button';item.setAttribute('role','menuitem');item.setAttribute('tabindex',items.length?'-1':'0');
      const choose=()=>request(agent,'book',file,anchor);choices.push(choose);item.addEventListener('click',choose);items.push(item);menu.append(item);
    }
    trigger?.setAttribute('aria-haspopup','menu');trigger?.setAttribute('aria-expanded','true');
    const rect=trigger?.getBoundingClientRect?.() || {left:16,bottom:16};
    const pointer=event?.type==='click' && event.detail!==0 && Number.isFinite(event.clientX) && Number.isFinite(event.clientY);
    const x=pointer?event.clientX:rect.left,y=pointer?event.clientY:rect.bottom;
    const width=doc.defaultView?.innerWidth || 1024,height=doc.defaultView?.innerHeight || 768;
    setStyle(menu,{left:`${Math.max(8,Math.min(x,width-24))}px`,top:`${Math.max(8,Math.min(y,height-24))}px`});
    menu.hidden=false;try {menu.showPopover?.();}catch { /* Fixed-position fallback inside the active dialog. */ }
    const bounds=menu.getBoundingClientRect?.();
    if(bounds)setStyle(menu,{left:`${Math.max(8,Math.min(x,width-bounds.width-8))}px`,top:`${Math.max(8,Math.min(y,height-bounds.height-8))}px`});
    items[0]?.focus();
  }
  function openAgentFile(id,event={}) {
    if(disposed||busy)return;
    const trigger=event.currentTarget || event.target || doc.activeElement,agent=find(id);
    if(!agent){notify('这个 Agent 已不在当前目录中',trigger);return;}
    if(agent.kind==='role')return request(agent,'definition',null,trigger);
    if(!agent.bookFiles?.length){closeMenu(false);notify('这个 Agent 没有登记原书文件',trigger);return;}
    if(agent.bookFiles.length===1)return request(agent,'book',agent.bookFiles[0],trigger);
    showMenu(agent,trigger,event);
  }
  const stop=event=>{event.preventDefault();event.stopPropagation();event.stopImmediatePropagation?.();};
  function click(event) {
    const link=event.target?.closest?.('[data-agent-link]');
    if((event.ctrlKey||event.metaKey)&&link&&(event.button===undefined||event.button===0)) {
      stop(event);return openAgentFile(link.getAttribute('data-agent-link'),{type:'click',currentTarget:link,clientX:event.clientX,clientY:event.clientY,detail:event.detail});
    }
    if(!menu.hidden&&!menu.contains(event.target))closeMenu(false);
  }
  function keydown(event) {
    if(!menu.hidden && menu.contains(event.target)) {
      if(event.key==='Escape'){stop(event);closeMenu();return;}
      if(event.key==='Tab'){closeMenu();return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        stop(event);cursor=event.key==='Home'?0:event.key==='End'?items.length-1:(cursor+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
        items.forEach((item,i)=>item.setAttribute('tabindex',i===cursor?'0':'-1'));items[cursor].focus();return;
      }
      if(event.key==='Enter'||event.key===' '){stop(event);if(!event.repeat)return choices[items.indexOf(event.target.closest('[role="menuitem"]'))]?.();return;}
    }
    const link=event.target?.closest?.('[data-agent-link]');
    if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&link){stop(event);if(!event.repeat)return openAgentFile(link.getAttribute('data-agent-link'),{currentTarget:link});}
  }
  doc.addEventListener('click',click,true);doc.addEventListener('keydown',keydown,true);
  const Observer=doc.defaultView?.MutationObserver;
  const observer=Observer?new Observer(refresh):null;observer?.observe(doc.body,{childList:true,subtree:true});refresh();
  return {openAgentFile,refresh,dispose(){if(disposed)return;disposed=true;closeMenu(false);observer?.disconnect();doc.removeEventListener('click',click,true);doc.removeEventListener('keydown',keydown,true);menu.remove();toast.remove();}};
}
