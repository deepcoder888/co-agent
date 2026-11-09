import { node, action, region } from './layouts/shared.js';
import { renderMarkdown } from './markdown.js';
import { setStyle } from './display.js';
import { markAgentLink } from './agent-links.js';
import { chatActive } from './chats.js';
import { rooms, renderRooms } from './rooms-page.js';
import { autoHideRail } from './reader-rail.js';

// v0.39 在 CO-AGENT 中调用 (docs/design/v0.39-inapp-chat): one page for every layout. The left column holds the book
// (or group), the answering engine and this book's conversations; answers arrive on paper sheets, one per member.
const cloth = ['#552424', '#2a4232', '#24324a', '#4e3820', '#442e48', '#2a4444', '#5a4220', '#383230'];
export const clothOf = id => { let hash = 0; for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) >>> 0; return cloth[hash % cloth.length]; };
const engineName = engine => engine === 'codex' ? 'Codex' : 'Claude';
const sideKey = 'co-agent.chat.side', layoutKey = 'co-agent.chat.layout';
function seconds(from, to) {
  const total = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  return total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}
export function clock(at) {
  const date = new Date(at); if (!Number.isFinite(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString(), two = n => String(n).padStart(2, '0');
  return `${today ? '' : `${two(date.getMonth() + 1)}-${two(date.getDate())} `}${two(date.getHours())}:${two(date.getMinutes())}`;
}
export function answerStatus(answer, now = Date.now()) {
  if (answer.status === 'queued') return '排队中';
  if (answer.status === 'running') return `正在回答 · ${seconds(answer.startedAt, now)}`;
  if (answer.status === 'done') return `用时 ${seconds(answer.startedAt, Date.parse(answer.endedAt))}`;
  if (answer.status === 'stopped') return '已停止';
  return '没有回答成功';
}

// The questions and answer sheets of one in-app chat, shared by 对话 and the rooms' 追问. The thread is rebuilt
// when turns change shape; answers update in place while they stream. view: { thread, answers: Map, shape }.
export function drawTurns(doc, view, chat, members, ops) {
  const joint = members.length > 1;
  const button = (text, run, label) => { const el = action(doc, text, event => { if (!el.disabled) return run(event); }, label); el.className = text === '停止' ? 'chat-tool chat-danger' : 'chat-tool'; return el; };
  const shape = JSON.stringify([chat?.chatId, (chat?.turns || []).map(t => [t.turnId, t.recipients])]);
  if (view.shape !== shape) {
    view.shape = shape; view.thread.replaceChildren(); view.answers.clear();
    for (const turn of chat?.turns || []) {
      const question = region(doc, 'div', 'chat-question', node(doc, 'p', turn.question, 'chat-question-text'),
        node(doc, 'span', `${turn.recipients.length < members.length ? `问 ${turn.recipients.map(id => members.find(m => m.id === id)?.name || id).join('、')} · ` : ''}${clock(turn.askedAt)}`, 'chat-question-meta'));
      const answers = node(doc, 'div', undefined, joint ? 'chat-answers chat-answers-joint' : 'chat-answers');
      for (const agentId of turn.recipients) {
        const member = members.find(m => m.id === agentId) || { id: agentId, name: agentId, bookLabel: '' };
        const card = node(doc, 'article', undefined, 'chat-answer'); setStyle(card, { '--cloth': clothOf(agentId) });
        const name = markAgentLink(node(doc, 'h3', joint ? member.name : `${member.name} 答`, 'chat-answer-name'), agentId);
        const book = node(doc, 'span', joint ? member.shortTitle : engineName(chat.engine), 'chat-answer-book');
        const state = node(doc, 'span', '', 'chat-answer-state');
        const body = node(doc, 'div', undefined, 'chat-answer-body');
        const tools = node(doc, 'div', undefined, 'chat-answer-tools');
        card.append(region(doc, 'header', 'chat-answer-head', name, book, state));
        const draft = turn.rewrites?.[agentId];
        if (draft) {
          const asked = node(doc, 'details', undefined, 'chat-rewrite-asked');
          asked.append(node(doc, 'summary', `按书改写${draft.angle ? `：${draft.angle}` : ''}`), node(doc, 'p', draft.question));
          card.append(asked);
        }
        card.append(body, tools);
        answers.append(card);
        view.answers.set(`${turn.turnId}/${agentId}`, { card, state, body, tools, member });
      }
      view.thread.append(question, answers);
    }
  }
  const now = Date.now(), latest = new Map();
  for (const turn of chat?.turns || []) for (const id of turn.recipients) latest.set(id, turn.turnId);
  for (const turn of chat?.turns || []) for (const agentId of turn.recipients) {
    const slot = view.answers.get(`${turn.turnId}/${agentId}`), answer = turn.answers[agentId];
    if (!slot || !answer) continue;
    slot.card.className = `chat-answer status-${answer.status}`;
    slot.card.setAttribute('aria-busy', String(chatActive(answer)));
    slot.state.textContent = answerStatus(answer, now);
    const textKey = `${answer.status}|${answer.text}|${answer.error}`;
    if (slot.textKey !== textKey) {
      slot.textKey = textKey; slot.body.replaceChildren();
      if (answer.status === 'done') slot.body.append(renderMarkdown(doc, answer.text));
      else if (answer.text) slot.body.append(node(doc, 'p', answer.text, 'chat-streaming'));
      else if (chatActive(answer)) slot.body.append(node(doc, 'p', answer.status === 'queued' ? '等前面的回答完成后开始。' : '正在翻书…', 'chat-waiting'));
      if (answer.status === 'failed') slot.body.append(node(doc, 'p', answer.error || '没有回答成功', 'chat-answer-error'));
      const isLatest = latest.get(agentId) === turn.turnId, tools = [];
      if (chatActive(answer)) tools.push(button('停止', () => ops.stop(agentId), `停止 ${slot.member.name} 的回答`));
      if (answer.status === 'done' || (answer.text && !chatActive(answer))) tools.push(button('复制', async event => {
        const target = event.currentTarget;
        try { await doc.defaultView?.navigator?.clipboard?.writeText(answer.text); target.textContent = '已复制'; } catch { target.textContent = '复制失败'; }
      }, `复制 ${slot.member.name} 的回答`));
      if (isLatest && ['failed', 'stopped'].includes(answer.status)) tools.push(button('重试', () => ops.retry(turn.turnId, agentId), `重新让 ${slot.member.name} 回答这个问题`));
      if (joint && isLatest && !chatActive(answer)) {
        tools.push(button('单独追问', () => ops.only(agentId), `只追问 ${slot.member.name}`));
        if (answer.status === 'done') tools.push(button('在终端中继续', () => ops.terminal(agentId), `在终端中继续和 ${slot.member.name} 的对话`));
      }
      slot.tools.replaceChildren(...tools); slot.tools.hidden = !tools.length;
    }
  }
}

export function renderDefaultChat(ctx, model) {
  if (!model) return;
  const { doc, refs: r, actions: a } = ctx;
  const button = (text, key, run, label = text, cls = '') => {
    const el = action(doc, text, event => { if (!el.disabled) return run(event); }, label);
    if (key) { el.id = `chat-${key}`; el.setAttribute('data-focus-key', el.id); }
    if (cls) el.className = cls; return el;
  };
  if (!r.chatPanel) {
    const panel = node(doc, 'section', undefined, 'chat-page'); panel.id = 'chat-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'chat-title');
    const title = node(doc, 'h1', '', 'chat-title'); title.id = 'chat-title'; title.setAttribute('tabindex', '-1');
    const art = node(doc, 'div', undefined, 'chat-art'); art.setAttribute('aria-hidden', 'true');
    const byline = node(doc, 'p', '', 'chat-byline'), roster = node(doc, 'ul', undefined, 'chat-roster'); roster.setAttribute('aria-label', '成员');
    const engines = node(doc, 'div', undefined, 'chat-engines'); engines.setAttribute('role', 'group'); engines.setAttribute('aria-labelledby', 'chat-engine-label');
    const engineLabel = node(doc, 'h2', '回答引擎', 'chat-side-label'); engineLabel.id = 'chat-engine-label';
    const engineButtons = ['claude', 'codex'].map(engine => {
      const el = button(engineName(engine), `engine-${engine}`, () => a.setChatEngine(engine), `由 ${engineName(engine)} 回答（会开始新对话）`, 'chat-engine');
      el.setAttribute('data-engine', engine); engines.append(el); return el;
    });
    const listLabel = node(doc, 'h2', '', 'chat-side-label'); listLabel.id = 'chat-list-label';
    const list = node(doc, 'ul', undefined, 'chat-list'); list.setAttribute('aria-labelledby', listLabel.id);
    const others = node(doc, 'details', undefined, 'chat-others'), othersList = node(doc, 'ul', undefined, 'chat-list');
    others.append(node(doc, 'summary', '其他对话'), othersList);
    const fresh = button('＋ 新对话', 'new', () => a.newChat(), '和同样的成员开始新对话', 'chat-new');
    const terminal = button('在终端中继续这段对话', 'terminal', () => a.chatTerminal(r.chatModel.members[0]?.id), '在终端中继续这段对话', 'chat-side-button');
    const stopAll = button('全部停止', 'stop-all', () => a.stopChat(), '停止所有正在进行的回答', 'chat-side-button chat-danger');
    const back = button('', 'back', () => a.showView('catalog'), '返回 Agent 目录', 'chat-back');
    back.append(node(doc, 'span', '←'), node(doc, 'span', ' 返回', 'chat-back-text'));
    // 2026-10-31: the left column folds into a narrow rail to give the answers more room; the choice is remembered.
    const toggle = button('', 'side-toggle', () => fold(r.chatSideFolded !== true), '收起左栏', 'chat-side-toggle');
    const sideBody = region(doc, 'div', 'chat-side-body', art, region(doc, 'div', 'chat-identity', title, byline), roster,
      region(doc, 'div', 'chat-side-block', engineLabel, engines), region(doc, 'nav', 'chat-side-block chat-nav', listLabel, list, others, fresh),
      region(doc, 'div', 'chat-side-foot', terminal, stopAll));
    sideBody.id = 'chat-side-body'; toggle.setAttribute('aria-controls', [sideBody.id, ...rooms.slice(1).map(([key]) => `room-side-${key}`)].join(' '));
    // v0.40: bookmark ribbons at the top of the left column switch between 对话, 圆桌, 会诊 and 顾问团.
    const ribbons = node(doc, 'nav', undefined, 'room-ribbons'); ribbons.setAttribute('aria-label', '房间');
    const ribbonButtons = rooms.map(([key, text]) => {
      const el = button(text, `room-${key}`, () => a.openRoom(key), text === '对话' ? '软件内对话' : { 圆桌: '圆桌讨论', 会诊: '会诊室', 顾问团: '顾问团' }[text], 'room-ribbon');
      el.setAttribute('data-room', key); ribbons.append(el); return el;
    });
    const side = region(doc, 'aside', 'chat-side', ribbons, region(doc, 'div', 'chat-side-top', back, toggle), sideBody);
    side.setAttribute('aria-label', '房间与记录');
    const status = node(doc, 'p', '', 'chat-notice'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const error = node(doc, 'p', '', 'chat-error'); error.setAttribute('role', 'alert');
    const thread = node(doc, 'div', undefined, 'chat-thread'); thread.id = 'chat-thread';
    const empty = node(doc, 'p', '', 'chat-empty');
    const recipients = node(doc, 'div', undefined, 'chat-recipients'); recipients.setAttribute('role', 'group'); recipients.setAttribute('aria-label', '发给谁');
    // 2026-10-31: a slim composer; it starts one line high and grows with the text up to 240 px.
    const label = node(doc, 'label', '', 'chat-sr-only'); label.setAttribute('for', 'chat-input');
    const input = node(doc, 'textarea'); input.id = 'chat-input'; input.rows = 1; input.maxLength = 8000; input.setAttribute('data-focus-key', input.id);
    input.addEventListener('input', () => { a.setChatDraft(input.value); grow(); updateComposer(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled) a.sendChat(); }
    });
    const hint = node(doc, 'span', '', 'chat-hint'); hint.id = 'chat-hint';
    const send = button('发送', 'send', () => a.sendChat(), '发送问题', 'chat-send'); send.setAttribute('aria-describedby', hint.id);
    // v0.46 按书改写 (2026-11-04): on request only, so ordinary questions are not slowed down.
    const rewrite = button('按书改写', 'rewrite', () => a.rewriteChat(), '让每本书从自己的角度改写这个问题，发送前可以修改', 'chat-rewrite');
    const drafts = node(doc, 'section', undefined, 'chat-rewrites'); drafts.setAttribute('aria-label', '按书改写的问题'); drafts.hidden = true;
    const composer = region(doc, 'div', 'chat-composer', drafts, region(doc, 'div', 'chat-slip', label,
      region(doc, 'div', 'chat-composer-meta', recipients, hint), region(doc, 'div', 'chat-composer-line', input, rewrite, send)));
    // Joint answers side by side (并排) or one under another (单列, easier to read); the choice is remembered.
    const layoutBox = node(doc, 'div', undefined, 'chat-layout'); layoutBox.setAttribute('role', 'group'); layoutBox.setAttribute('aria-label', '回答排列');
    const layoutButtons = [['columns', '并排'], ['stack', '单列']].map(([mode, text]) => {
      const el = button(text, `layout-${mode}`, () => arrange(mode), `${text}显示回答`, 'chat-layout-option');
      el.setAttribute('data-layout', mode); layoutBox.append(el); return el;
    });
    // v0.48 (2026-11-08): 对话记录 and ＋ 新对话 sit in the toolbar too, as in the rooms, so they work with the left column folded.
    const history = node(doc, 'details', undefined, 'room-history'); history.id = 'chat-history';
    const historySummary = node(doc, 'summary', '', 'chat-chip room-tool'), historyList = node(doc, 'ul', undefined, 'chat-list room-history-list');
    historyList.setAttribute('aria-label', '对话记录'); history.append(historySummary, historyList);
    const freshMain = button('＋ 新对话', 'new-main', () => a.newChat(), '和同样的成员开始新对话；原来的对话保留', 'chat-chip room-tool');
    const tools = region(doc, 'div', 'room-tools', history, freshMain);
    const toolbar = region(doc, 'div', 'chat-toolbar', tools, layoutBox);
    const main = region(doc, 'div', 'chat-main', status, error, region(doc, 'div', 'chat-thread-wrap', toolbar, empty, thread), composer);
    // 2026-11-03: like the reading mode's outline, the folded rail slides off after 3 s and the left edge, Tab or
    // keyboard focus brings it back (public/reader-rail.js). The side is its own exit: the ribbons and buttons all sit in it.
    const edge = node(doc, 'div', undefined, 'chat-side-edge'); edge.setAttribute('aria-hidden', 'true');
    panel.append(side, main, edge);
    ctx.root.parentElement.append(panel);
    const rail = autoHideRail(doc, { dialog: panel, rail: side, exit: side, edge, isCollapsed: () => r.chatSideFolded === true, isActive: () => !panel.hidden,
      onHidden: on => on ? panel.setAttribute('data-side-hidden', '') : panel.removeAttribute('data-side-hidden') });
    const storage = () => { try { return doc.defaultView?.localStorage || null; } catch { return null; } };
    function fold(on, remember = true) {
      r.chatSideFolded = on; panel.setAttribute('data-side', on ? 'folded' : 'open'); applySide();
      on ? rail.schedule() : rail.reveal();
      toggle.textContent = on ? '›' : '‹'; toggle.setAttribute('aria-expanded', String(!on));
      toggle.setAttribute('aria-label', on ? '展开左栏' : '收起左栏'); toggle.title = on ? '展开左栏' : '收起左栏';
      if (remember) try { storage()?.setItem(sideKey, on ? 'folded' : 'open'); } catch { /* a blocked store only forgets the choice */ }
    }
    function applySide() {
      const room = r.chatRoom || 'chat';
      sideBody.hidden = r.chatSideFolded === true || room !== 'chat';
      for (const v of Object.values(r.rooms || {})) v.side.hidden = r.chatSideFolded === true || v.side.getAttribute('data-room') !== room;
    }
    let saved = null;
    try { saved = storage()?.getItem(sideKey); } catch { /* start open */ }
    fold(saved === 'folded', false);
    function arrange(mode, remember = true) {
      r.chatLayout = mode; panel.setAttribute('data-layout', mode);
      for (const el of layoutButtons) el.setAttribute('aria-pressed', String(el.getAttribute('data-layout') === mode));
      if (remember) try { storage()?.setItem(layoutKey, mode); } catch { /* a blocked store only forgets the choice */ }
    }
    let savedLayout = null;
    try { savedLayout = storage()?.getItem(layoutKey); } catch { /* start side by side */ }
    arrange(savedLayout === 'stack' ? 'stack' : 'columns', false);
    function grow() {
      if (typeof input.scrollHeight !== 'number' || !input.style?.setProperty) return;
      input.style.setProperty('height', 'auto'); input.style.setProperty('height', `${Math.min(input.scrollHeight, 240)}px`);
    }
    Object.assign(r, { chatPanel: panel, chatTitle: title, chatArt: art, chatByline: byline, chatRoster: roster, chatEngines: engineButtons,
      chatListLabel: listLabel, chatList: list, chatOthers: others, chatOthersList: othersList, chatTerminal: terminal, chatStopAll: stopAll,
      chatStatus: status, chatError: error, chatThread: thread, chatEmpty: empty, chatRecipients: recipients, chatLabel: label, chatInput: input,
      chatHint: hint, chatSend: send, chatRewrite: rewrite, chatDrafts: drafts, chatToolbar: toolbar, chatLayoutBox: layoutBox,
      chatHistory: history, chatHistorySummary: historySummary, chatHistoryList: historyList, chatNewMain: freshMain, chatGrow: grow, chatTurns: { thread, answers: new Map(), shape: null },
      chatSide: side, chatMain: main, chatRibbons: ribbonButtons, chatArrange: arrange, chatApplySide: applySide, chatRail: rail });
  }
  const visible = ctx.state.view === 'chat', wasVisible = !r.chatPanel.hidden;
  r.chatPanel.hidden = !visible; r.chatModel = model; r.roomModel = model;
  // Count down only on opening: streaming answers re-render the page and must not keep postponing the hide.
  if (!visible) { if (wasVisible) r.chatRail.reset(); r.roomShown = null; r.roomFocus = null; return; }
  if (!wasVisible) r.chatRail.schedule();
  const room = model.room || 'chat', entering = r.roomShown !== room && room === 'chat';
  r.chatRoom = room; r.chatPanel.setAttribute('data-room', room); r.chatMain.hidden = room !== 'chat';
  for (const el of r.chatRibbons) { const on = el.getAttribute('data-room') === room; on ? el.setAttribute('aria-current', 'page') : el.removeAttribute('aria-current'); }
  renderRooms(ctx, model, { side: r.chatSide, main: r.chatPanel });
  r.chatApplySide();
  if (room !== 'chat') return;
  const chat = model.selected, joint = model.members.length > 1, first = model.members[0];
  // Left column: the book's cover (or the group's spines), names, engine and the related conversations.
  r.chatTitle.textContent = joint ? (model.groupName || `联合调用 · ${model.members.length} 位`) : (first?.shortTitle || first?.name || '');
  r.chatByline.textContent = joint ? model.members.map(m => m.name).join('、') : [first?.author, first ? `书籍 Agent：${first.name}` : ''].filter(Boolean).join(' · ');
  if (!joint && first?.kind !== 'book') r.chatByline.textContent = first ? `${first.name} · 功能性 Agent` : '';
  const artKey = JSON.stringify(model.members.map(m => [m.id, m.shortTitle]));
  if (r.chatArtKey !== artKey) {
    r.chatArtKey = artKey; r.chatArt.replaceChildren(); r.chatArt.className = joint ? 'chat-art chat-spines' : 'chat-art chat-cover';
    if (joint) for (const m of model.members) { const spine = node(doc, 'span', undefined, 'chat-spine'); setStyle(spine, { '--cloth': clothOf(m.id) }); r.chatArt.append(spine); }
    else if (first) { setStyle(r.chatArt, { '--cloth': clothOf(first.id) }); r.chatArt.append(node(doc, 'strong', first.shortTitle || first.name), node(doc, 'span', '◆ ◇ ◆'), node(doc, 'small', first.author || first.name)); }
  }
  const status = new Map(model.members.map(m => [m.id, 'idle']));
  for (const turn of chat?.turns || []) for (const [id, answer] of Object.entries(turn.answers)) status.set(id, answer.status);
  r.chatRoster.hidden = !joint;
  r.chatRoster.replaceChildren(...(joint ? model.members.map(m => {
    const s = status.get(m.id), li = node(doc, 'li', undefined, `chat-roster-row status-${s}`);
    const dot = node(doc, 'span', undefined, 'chat-dot'); dot.setAttribute('aria-hidden', 'true');
    li.append(dot, markAgentLink(node(doc, 'span', m.name, 'chat-roster-name'), m.id), node(doc, 'span', m.shortTitle, 'chat-roster-book'),
      node(doc, 'span', { running: '回答中', queued: '排队中', done: '已答', failed: '失败', stopped: '已停止', idle: '' }[s] || '', 'chat-roster-state'));
    return li;
  }) : []));
  for (const el of r.chatEngines) { const on = el.getAttribute('data-engine') === model.engine; el.setAttribute('aria-pressed', String(on)); el.disabled = model.busy; }
  r.chatListLabel.textContent = joint ? '这组的对话' : first?.kind === 'book' ? '这本书的对话' : '和 TA 的对话';
  const row = (item, other, menu = false) => {
    const li = node(doc, 'li');
    const link = button('', '', () => { if (menu) r.chatHistory.open = false; return a.selectChat(item.chatId); }, `打开对话：${item.title}`, 'chat-list-item');
    link.setAttribute('data-focus-key', `chat-${menu ? 'history' : 'item'}-${item.chatId}`);
    if (chat?.chatId === item.chatId) link.setAttribute('aria-current', 'page');
    const meta = [clock(item.updatedAt), engineName(item.engine), item.running ? '回答中' : item.failed ? '未答完' : ''].filter(Boolean).join(' · ');
    link.append(node(doc, 'span', item.title, 'chat-list-title'), node(doc, 'span', other ? `${item.names.join('、')} · ${meta}` : meta, 'chat-list-meta'));
    li.append(link); return li;
  };
  r.chatList.replaceChildren(...model.related.map(item => row(item, false)));
  if (!model.related.length) r.chatList.append(node(doc, 'li', model.pending ? '写下第一个问题，这段对话就开始了' : '还没有对话', 'chat-list-empty'));
  r.chatOthersList.replaceChildren(...model.others.map(item => row(item, true))); r.chatOthers.hidden = !model.others.length;
  // The toolbar's 对话记录 lists this book's (or group's) conversations first, then the others.
  const all = [...model.related.map(item => [item, false]), ...model.others.map(item => [item, true])];
  r.chatHistory.hidden = !all.length; r.chatHistorySummary.textContent = `对话记录（${all.length}）`;
  const historyKey = JSON.stringify([chat?.chatId, all]);
  if (r.chatHistoryKey !== historyKey) { r.chatHistoryKey = historyKey; r.chatHistoryList.replaceChildren(...all.map(([item, other]) => row(item, other, true))); }
  r.chatNewMain.hidden = !chat;
  r.chatTerminal.hidden = joint || !chat; r.chatTerminal.disabled = !!chat && model.running;
  r.chatStopAll.hidden = !model.running;
  r.chatStatus.textContent = model.notice || ''; r.chatError.textContent = model.error || '';
  drawTurns(doc, r.chatTurns, chat, model.members, {
    stop: agentId => a.stopChat(agentId), retry: (turnId, agentId) => a.retryChat(turnId, agentId), terminal: agentId => a.chatTerminal(agentId),
    only: agentId => { a.setChatRecipients([agentId]); r.chatInput.focus(); } });
  r.chatEmpty.hidden = !!chat?.turns?.length;
  r.chatEmpty.textContent = model.pending ? `向 ${joint ? '这几位作者' : first?.name || ''} 提出第一个问题，由 ${engineName(model.engine)} 回答。` : '在左边选一段对话，或从书籍详情里选「在 CO-AGENT 中调用」开始。';
  // Composer.
  const recipientKey = JSON.stringify([joint, model.members.map(m => m.id), model.recipients]);
  if (r.chatRecipientKey !== recipientKey) {
    r.chatRecipientKey = recipientKey; r.chatRecipients.replaceChildren(); r.chatRecipients.hidden = !joint;
    if (joint) {
      r.chatRecipients.append(node(doc, 'span', '发给', 'chat-side-label'));
      const all = model.recipients.length === model.members.length;
      const everyone = button(`全部 ${model.members.length} 位`, 'to-all', () => a.setChatRecipients(model.members.map(m => m.id)), '发给全部成员', 'chat-chip');
      everyone.setAttribute('aria-pressed', String(all)); r.chatRecipients.append(everyone);
      for (const m of model.members) {
        const chip = button(m.name, `to-${m.id}`, () => a.setChatRecipients(all ? [m.id] : model.recipients.includes(m.id) ? model.recipients.filter(id => id !== m.id) : [...model.recipients, m.id]), `发给 ${m.name}`, 'chat-chip');
        chip.setAttribute('aria-pressed', String(!all && model.recipients.includes(m.id))); r.chatRecipients.append(chip);
      }
    }
  }
  r.chatLabel.textContent = chat?.turns?.length ? `继续问 ${joint ? (model.recipients.length === model.members.length ? '全部成员' : model.recipients.map(id => model.members.find(m => m.id === id)?.name).join('、')) : first?.name || ''}`
    : `问 ${joint ? '这几位作者' : first?.name || ''}`;
  r.chatInput.setAttribute('placeholder', `${r.chatLabel.textContent}…（Enter 发送，Shift+Enter 换行）`);
  // Rewritten drafts: rebuilt only when a new rewrite or other recipients arrive, so typing in them is never interrupted.
  const shown = model.rewrite ? model.rewrite.items.filter(i => model.rewritable.includes(i.id)) : [];
  const draftKey = JSON.stringify([model.rewrite?.source, shown.map(i => [i.id, i.angle])]);
  if (r.chatDraftKey !== draftKey) {
    r.chatDraftKey = draftKey; r.chatDrafts.replaceChildren(); r.chatDrafts.hidden = !shown.length;
    if (shown.length) {
      const head = region(doc, 'div', 'chat-rewrites-head', node(doc, 'h2', '按书改写', 'chat-side-label'),
        node(doc, 'span', '发送时每本书收到自己的版本，其他成员收到原问题', 'chat-rewrites-note'),
        button('取消改写', 'rewrite-clear', () => a.clearChatRewrite(), '不用改写稿，按原问题发送', 'chat-tool'));
      r.chatDrafts.append(head);
      for (const item of shown) {
        const name = model.members.find(m => m.id === item.id)?.name || item.id, row = node(doc, 'div', undefined, item.fit ? 'chat-rewrite-row' : 'chat-rewrite-row is-unfit');
        row.append(node(doc, 'p', `${name} · ${item.fit ? item.angle : `书里没有合适的角度，按原问题发：${item.angle}`}`, 'chat-rewrite-angle'));
        if (item.fit) {
          const box = node(doc, 'textarea', undefined, 'chat-rewrite-input'); box.id = `chat-rewrite-${item.id}`; box.rows = 3; box.maxLength = 8000;
          box.value = item.question; box.setAttribute('aria-label', `给 ${name} 的问题`); box.setAttribute('data-focus-key', box.id);
          box.addEventListener('input', () => a.editChatRewrite(item.id, box.value));
          row.append(box);
        }
        r.chatDrafts.append(row);
      }
    }
  }
  r.chatLayoutBox.hidden = !joint || !chat?.turns?.length;
  r.chatToolbar.hidden = r.chatHistory.hidden && r.chatNewMain.hidden && r.chatLayoutBox.hidden;
  r.chatThread.className = joint ? 'chat-thread is-joint' : 'chat-thread';
  // Follow the draft when the model changes it (sent, new chat); typing already keeps the two equal.
  if (r.chatDraftSeen !== model.draft) { r.chatDraftSeen = model.draft; if (r.chatInput.value !== model.draft) { r.chatInput.value = model.draft; r.chatGrow(); } }
  updateComposer();
  if (entering) (model.pending ? r.chatInput : r.chatTitle).focus();
  function updateComposer() {
    const m = r.chatModel, c = m.selected, text = r.chatInput.value;
    const busy = !!c && c.turns.some(t => m.recipients.some(id => chatActive(t.answers[id])));
    const empty = !text.trim(), long = Array.from(text).length > 8000;
    r.chatSend.disabled = m.busy || m.rewriting || empty || long || busy || (!c && !m.pending);
    r.chatSend.textContent = m.busy ? '正在发送…' : busy && !(m.members.length > 1) ? '回答完成后可发送' : m.rewrite?.source === text ? '按改写发送' : '发送';
    r.chatRewrite.hidden = !m.rewritable.length;
    r.chatRewrite.disabled = m.busy || m.rewriting || empty || long || (!c && !m.pending);
    r.chatRewrite.textContent = m.rewriting ? '正在改写…' : m.rewrite?.source === text ? '重新改写' : '按书改写';
    r.chatHint.textContent = long ? '问题最多 8000 字' : m.rewriting ? '正在按书改写，通常要一两分钟' : busy ? (m.members.length > 1 ? '所选成员还在回答，可以先写好' : `由 ${engineName(m.engine)} 回答 · 回答完成后可发送`) : `由 ${engineName(m.engine)} 回答`;
    r.chatInput.disabled = m.busy || m.rewriting;
  }
}
