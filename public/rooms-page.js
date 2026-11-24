import { node, action, region } from './layouts/shared.js';
import { renderMarkdown } from './markdown.js';
import { setStyle, roomShortage, READY_TEXT } from './display.js';
import { markAgentLink } from './agent-links.js';
import { seminarParticipants, seminarStatus } from './seminars.js';
import { consultLenses, consultDisclaimer, consultActive, consultDraftError, consultCounts } from './consults.js';
import { councilActive, councilDraftError } from './councils.js';
import { drawTurns, clothOf, clock } from './chat-page.js';

// v0.40 (2026-11-01, docs/design/v0.40-rooms): 圆桌讨论, 会诊室 and 顾问团 live inside the chat page. Ribbons at
// the top of the left column switch rooms; each room lists its own records, opens new ones on an opening sheet (开场纸)
// and shows results as one synthesis sheet plus one sheet per author. These rooms run on Codex only.
export const rooms = [['chat', '对话'], ['seminars', '圆桌'], ['consults', '会诊'], ['councils', '顾问团']];
const roomTitles = { seminars: '圆桌讨论', consults: '会诊室', councils: '顾问团' };
const active = record => ['queued', 'running'].includes(record?.status);
const firstLine = (text, n = 40) => Array.from(String(text || '').trim().split(/\r?\n/)[0]).slice(0, n).join('');
const lensName = id => consultLenses.find(l => l[0] === id)?.[1] || id;

export function renderRooms(ctx, model, host) {
  const { doc, refs: r, actions: a } = ctx, room = model.room || 'chat';
  r.roomModel = model;
  const button = (text, key, run, label = text, cls = '') => {
    const el = action(doc, text, event => { if (!el.disabled) return run(event); }, label);
    if (key) { el.id = `room-${key}`; el.setAttribute('data-focus-key', el.id); }
    if (cls) el.className = cls; return el;
  };
  const agents = ctx.state.allAgents || [];
  const person = id => { const agent = agents.find(x => x.id === id); return { id, name: agent?.name || id, shortTitle: agent?.spineTitle || '', kind: agent?.kind }; };
  const byCodexName = name => agents.find(x => x.platforms?.codex?.name === name || x.name === name);
  const seal = text => { const el = node(doc, 'span', text, 'room-seal'); el.setAttribute('aria-hidden', 'true'); return el; };
  const paper = (cls, mark, title, state = '') => {
    const el = node(doc, 'article', undefined, `room-paper ${cls}`);
    el.append(region(doc, 'header', 'room-paper-head', seal(mark), node(doc, 'h2', title, 'room-paper-title'), node(doc, 'span', state, 'room-paper-state')));
    return el;
  };
  const section = (title, ...children) => region(doc, 'section', 'room-paper-section', node(doc, 'h3', title), ...children);
  const list = (tag, items) => { const el = node(doc, tag); for (const item of items) el.append(typeof item === 'string' ? node(doc, 'li', item) : item); return el; };
  const bubble = (text, meta) => region(doc, 'div', 'chat-question', node(doc, 'p', text, 'chat-question-text'), node(doc, 'span', meta, 'chat-question-meta'));
  const label = (text, id) => { const el = node(doc, 'label', text, 'room-field-label'); el.setAttribute('for', id); return el; };

  if (!r.rooms) {
    r.rooms = {};
    for (const key of ['seminars', 'consults', 'councils']) {
      const title = node(doc, 'h1', roomTitles[key], 'chat-title room-title'); title.id = `room-title-${key}`; title.setAttribute('tabindex', '-1');
      const meta = node(doc, 'p', '', 'chat-byline');
      const extra = node(doc, 'div', undefined, 'room-side-extra');
      const listLabel = node(doc, 'h2', { seminars: '圆桌记录', consults: '会诊记录', councils: '我的顾问团' }[key], 'chat-side-label'); listLabel.id = `room-list-label-${key}`;
      const records = node(doc, 'ul', undefined, 'chat-list'); records.setAttribute('aria-labelledby', listLabel.id);
      const archived = node(doc, 'details', undefined, 'chat-others'), archivedList = node(doc, 'ul', undefined, 'chat-list');
      archived.append(node(doc, 'summary', '已归档的顾问团'), archivedList); archived.hidden = true;
      const fresh = button({ seminars: '＋ 新开一场圆桌', consults: '＋ 新开一次会诊', councils: '＋ 新建顾问团' }[key], `${key}-new`,
        () => key === 'councils' ? a.newCouncil() : a.newRoomRecord(key), undefined, 'chat-new');
      // 圆桌 and 会诊 show who took part above their records; 顾问团 lists the councils first, then the members.
      const nav = region(doc, 'nav', 'chat-side-block chat-nav', listLabel, records, archived, fresh);
      const side = region(doc, 'div', 'chat-side-body room-side-body', region(doc, 'div', 'chat-identity', title, meta), ...(key === 'councils' ? [nav, extra] : [extra, nav]));
      side.id = `room-side-${key}`; side.setAttribute('data-room', key); side.hidden = true; host.side.append(side);
      const notice = node(doc, 'p', '', 'chat-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
      const error = node(doc, 'p', '', 'chat-error'); error.setAttribute('role', 'alert');
      const lead = node(doc, 'span', '', 'room-lead'), tools = node(doc, 'div', undefined, 'room-tools');
      const layoutBox = node(doc, 'div', undefined, 'chat-layout'); layoutBox.setAttribute('role', 'group'); layoutBox.setAttribute('aria-label', '回答排列');
      const layoutButtons = [['columns', '并排'], ['stack', '单列']].map(([mode, text]) => {
        const el = button(text, `${key}-layout-${mode}`, () => r.chatArrange(mode), `${text}显示回答`, 'chat-layout-option');
        el.setAttribute('data-layout', mode); layoutBox.append(el); return el;
      });
      const toolbar = region(doc, 'div', 'room-toolbar', lead, tools, layoutBox);
      const content = node(doc, 'div', undefined, 'room-content');
      const followWrap = region(doc, 'section', 'room-follow'); followWrap.setAttribute('aria-label', '追问');
      const followThread = node(doc, 'div', undefined, 'chat-thread is-joint');
      followWrap.append(node(doc, 'h2', '追问', 'room-divider'), followThread);
      // The composer: 追问 for 圆桌 and 会诊, the next meeting for 顾问团.
      const composeLabel = node(doc, 'label', '', 'chat-sr-only'); composeLabel.setAttribute('for', `room-${key}-input`);
      const recipients = node(doc, 'div', undefined, 'chat-recipients'); recipients.setAttribute('role', 'group'); recipients.setAttribute('aria-label', '发给谁');
      const hint = node(doc, 'span', '', 'chat-hint'); hint.id = `room-${key}-hint`;
      const input = node(doc, 'textarea', undefined, 'room-input'); input.id = `room-${key}-input`; input.rows = 1; input.setAttribute('data-focus-key', input.id);
      input.maxLength = key === 'councils' ? 4000 : 8000;
      const send = button(key === 'councils' ? '开会' : '发送', `${key}-send`, () => submit(), key === 'councils' ? '开始这次会议' : '发送追问', 'chat-send');
      send.setAttribute('aria-describedby', hint.id);
      const submit = () => key === 'councils' ? a.startCouncilSession() : a.sendFollowup();
      const grow = () => { if (typeof input.scrollHeight === 'number' && input.style?.setProperty) { input.style.setProperty('height', 'auto'); input.style.setProperty('height', `${Math.min(input.scrollHeight, 240)}px`); } };
      input.addEventListener('input', () => { key === 'councils' ? a.setCouncilReport(input.value) : a.setFollowupDraft(input.value); grow(); r.rooms[key].update?.(); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled) submit(); } });
      const composerLead = node(doc, 'span', key === 'councils' ? '' : '追问', 'chat-side-label room-composer-lead');
      const composer = region(doc, 'div', 'chat-composer', region(doc, 'div', 'chat-slip', composeLabel,
        region(doc, 'div', 'chat-composer-meta', composerLead, recipients, hint), region(doc, 'div', 'chat-composer-line', input, send)));
      const main = region(doc, 'div', 'chat-main room-main', notice, error, region(doc, 'div', 'chat-thread-wrap room-scroll', toolbar, content), composer);
      main.setAttribute('data-room', key); main.hidden = true; host.main.append(main);
      r.rooms[key] = { side, main, title, meta, extra, records, archived, archivedList, fresh, notice, error, lead, tools, toolbar, layoutButtons, content,
        followWrap, follow: { thread: followThread, answers: new Map(), shape: null }, composer, composeLabel, composerLead, recipients, hint, input, send, grow, open: new Set() };
    }
  }
  for (const [key, v] of Object.entries(r.rooms)) { v.side.hidden = key !== room || r.chatSideFolded === true; v.main.hidden = key !== room; }
  if (room === 'chat') { r.roomShown = 'chat'; return; }
  const v = r.rooms[room], entering = r.roomShown !== room; r.roomShown = room;
  for (const el of v.layoutButtons) el.setAttribute('aria-pressed', String(el.getAttribute('data-layout') === r.chatLayout));
  const recordItem = (id, title, meta, current, select) => {
    const li = node(doc, 'li'), link = button('', '', select, `打开：${title}`, 'chat-list-item');
    link.setAttribute('data-focus-key', `room-item-${id}`); if (current) link.setAttribute('aria-current', 'page');
    link.append(node(doc, 'span', title, 'chat-list-title'), node(doc, 'span', meta, 'chat-list-meta')); li.append(link); return li;
  };
  // v0.48 (2026-11-07): a room's records also open from its toolbar, so history is reachable with the left column folded.
  // rows: [id, title, meta, current, select] per record.
  const historyMenu = (label, listKey, rows) => {
    if (!v.history) {
      v.history = node(doc, 'details', undefined, 'room-history'); v.history.id = `room-${room}-history`;
      v.historySummary = node(doc, 'summary', '', 'chat-chip room-tool'); v.historyList = node(doc, 'ul', undefined, 'chat-list room-history-list');
      v.historyList.setAttribute('aria-label', label); v.history.append(v.historySummary, v.historyList);
    }
    v.historySummary.textContent = `${label}（${rows.length}）`;
    if (v.historyKey !== listKey) {
      v.historyKey = listKey;
      v.historyList.replaceChildren(...rows.map(([id, title, meta, current, select]) => recordItem(`history-${id}`, title, meta, current, () => { v.history.open = false; return select(); })));
    }
    return v.history;
  };
  const roster = (title, rows) => {
    const ul = node(doc, 'ul', undefined, 'chat-roster');
    for (const row of rows) {
      const li = node(doc, 'li', undefined, `chat-roster-row status-${row.status || 'done'}`), dot = node(doc, 'span', undefined, 'chat-dot'); dot.setAttribute('aria-hidden', 'true');
      li.append(dot, markAgentLink(node(doc, 'span', row.name, 'chat-roster-name'), row.id), node(doc, 'span', row.book || '', 'chat-roster-book'), node(doc, 'span', row.state || '', 'chat-roster-state'));
      ul.append(li);
    }
    return region(doc, 'section', 'chat-side-block', node(doc, 'h2', title, 'chat-side-label'), ul);
  };
  const authorSheet = (key, member, book, body, extra = []) => {
    const card = node(doc, 'article', undefined, 'chat-answer room-author status-done'); setStyle(card, { '--cloth': clothOf(member.id || member.name) });
    const toggle = button('读全文', '', () => { const open = !v.open.has(key); open ? v.open.add(key) : v.open.delete(key); show(open); }, `展开 ${member.name} 的全文`, 'room-read');
    const text = region(doc, 'div', 'chat-answer-body room-author-body', ...extra, body);
    const show = open => { card.className = `chat-answer room-author status-done${open ? ' is-open' : ''}`; toggle.textContent = open ? '收起' : '读全文'; toggle.setAttribute('aria-expanded', String(open)); };
    card.append(region(doc, 'header', 'chat-answer-head', markAgentLink(node(doc, 'h3', member.name, 'chat-answer-name'), member.id), node(doc, 'span', book, 'chat-answer-book')), text, toggle);
    show(v.open.has(key)); return card;
  };
  const follow = model.follow || {};
  // The composer follows its draft when the model changes it (sent, another record); typing keeps the two equal.
  const follow_ = text => { if (v.inputSeen !== text) { v.inputSeen = text; if (v.input.value !== text) { v.input.value = text; v.grow(); } } };
  // The follow-up thread and composer for a finished 圆桌 or 会诊 (members: who took part).
  function drawFollow(origin, members, ready) {
    const chat = follow.origin?.room === origin.room && follow.origin?.id === origin.id ? follow.chat : null;
    v.followWrap.hidden = !chat?.turns?.length;
    drawTurns(doc, v.follow, chat, members, { stop: id => a.followupStop(id), retry: (turnId, id) => a.followupRetry(turnId, id), terminal: id => a.followupTerminal(id),
      only: id => { a.setFollowupRecipients([id]); v.input.focus(); } });
    v.composer.hidden = !ready;
    const ids = members.map(m => m.id), chosen = follow.recipients?.length ? follow.recipients : ids, all = chosen.length === ids.length;
    const recipientKey = JSON.stringify([ids, chosen]);
    if (v.recipientKey !== recipientKey) {
      v.recipientKey = recipientKey; v.recipients.replaceChildren();
      const everyone = button(`全部 ${ids.length} 位`, `${room}-to-all`, () => a.setFollowupRecipients(ids), '发给全部参与的作者', 'chat-chip');
      everyone.setAttribute('aria-pressed', String(all)); v.recipients.append(everyone);
      for (const m of members) {
        const chip = button(m.name, `${room}-to-${m.id}`, () => a.setFollowupRecipients(all ? [m.id] : chosen.includes(m.id) ? chosen.filter(id => id !== m.id) : [...chosen, m.id]), `发给 ${m.name}`, 'chat-chip');
        chip.setAttribute('aria-pressed', String(!all && chosen.includes(m.id))); v.recipients.append(chip);
      }
    }
    v.composeLabel.textContent = `追问 ${all ? '参与的作者' : chosen.map(id => members.find(m => m.id === id)?.name).join('、')}`;
    v.input.setAttribute('placeholder', `${v.composeLabel.textContent}…（Enter 发送，Shift+Enter 换行）`);
    follow_(follow.draft || '');
    v.update = () => {
      const text = v.input.value, long = Array.from(text).length > 8000;
      const busy = !!chat && chat.turns.some(t => chosen.some(id => ['queued', 'running'].includes(t.answers[id]?.status)));
      v.send.disabled = !!follow.busy || !text.trim() || long || busy || !ready;
      v.send.textContent = follow.busy ? '正在发送…' : '发送';
      v.hint.textContent = long ? '追问最多 8000 字' : busy ? '所选作者还在回答，可以先写好' : `${chat ? '' : '带上这份综合作为背景 · '}由 Codex 回答`;
      v.input.disabled = !!follow.busy;
    };
    v.update();
    if (follow.origin?.room === origin.room && follow.origin?.id === origin.id) { v.notice.textContent ||= follow.notice || ''; if (follow.error) v.error.textContent = follow.error; }
  }

  if (room === 'seminars') {
    const s = model.seminars || { items: [] }, fresh = model.fresh?.seminars || !s.selected && !s.items.length, record = fresh ? null : s.selected;
    const live = s.items.filter(active).length;
    v.meta.textContent = `${live ? `${live} 场进行中 · ` : ''}共 ${s.items.length} 场`;
    v.notice.textContent = s.busy ? '正在提交或等待确认…' : ''; v.error.textContent = s.error || '';
    const participants = record?.result ? seminarParticipants(record, { agents }) : [];
    const members = participants.map(p => ({ ...person(p.id), name: p.name, id: p.id || p.agent }));
    const listKey = JSON.stringify([s.items, record?.seminarId, fresh]);
    const rows = s.items.map(item => [item.seminarId, firstLine(item.input) || '问题未载明',
      [clock(item.createdAt), active(item) ? seminarStatus(item) : item.status === 'failed' ? '失败' : `${item.result?.selected?.length || 0} 位`].join(' · '),
      item.seminarId === record?.seminarId, () => a.selectSeminar(item.seminarId)]);
    if (v.listKey !== listKey) {
      v.listKey = listKey;
      v.records.replaceChildren(...rows.map(row => recordItem(...row)));
      if (!s.items.length) v.records.append(node(doc, 'li', '还没有圆桌讨论', 'chat-list-empty'));
    }
    const history = historyMenu('圆桌记录', listKey, rows);
    const sideKey = JSON.stringify([record?.seminarId, participants.map(p => [p.id, p.name])]);
    if (v.sideKey !== sideKey) {
      v.sideKey = sideKey;
      v.extra.replaceChildren(...(participants.length ? [roster(`这场圆桌 · ${participants.length} 位作者`, participants.map(p => ({ id: p.id, name: p.name,
        book: person(p.id).shortTitle, state: (record.result.perAgent || []).find(x => [p.id, p.agent].includes(x.id || x.agent))?.coverage || '' })))] : []));
    }
    v.lead.textContent = record ? `圆桌讨论 · ${record.mode === 'explicit' ? '指定了' : '自动选了'} ${participants.length || '3–5'} 位作者 · 由 Codex 主持` : '';
    v.toolbar.hidden = !record && !s.items.length; v.layoutButtons[0].parentElement.hidden = !record?.result;
    const contentKey = JSON.stringify([fresh, record, s.running, s.busy, s.items.length > 0]);
    if (v.contentKey !== contentKey) {
      v.contentKey = contentKey; v.content.replaceChildren(); v.tools.replaceChildren();
      if (s.items.length) v.tools.append(history);
      if (!record) v.content.append(seminarOpening());
      else {
        // v0.48 (2026-11-07): a new 圆桌 starts from the toolbar too, as in 会诊室.
        v.tools.append(button('＋ 新开一场圆桌', 'seminars-new-main', () => a.newRoomRecord('seminars'), '新开一场圆桌；进行中的圆桌照常继续', 'chat-chip room-tool'));
        const terms = (record.result?.terms || record.terms || []).map(t => [t.zh, t.en, t.fr].filter(Boolean).join(' · ')).join(' / ');
        v.content.append(bubble(record.input, [clock(record.createdAt), terms].filter(Boolean).join(' · ')));
        if (active(record)) v.content.append(waiting(`${seminarStatus(record)}。主持人选好作者、收齐各自的看法后写综合，完成后自动出现在这里。`));
        if (record.status === 'failed') {
          const sheet = paper('room-failed', '综', '这场圆桌没有完成', '失败');
          sheet.append(node(doc, 'p', record.error || '原因未载明', 'room-error-text'),
            region(doc, 'div', 'room-paper-foot', button('重试', `seminars-retry`, () => record.mode === 'explicit' ? a.rerunSeminar(record.seminarId, record.requestedAgents) : a.startSeminar(record.input), '重新开这场圆桌', 'chat-tool')));
          v.content.append(sheet);
        }
        if (record.thinkError) v.content.append(node(doc, 'p', `THINK 另存失败：${record.thinkError}`, 'room-note'));
        if (record.result) {
          const add = button('加人重跑', 'seminars-add', () => a.openSeminarAddPicker(record.seminarId), '加几位作者重开这场圆桌', 'chat-chip room-tool');
          const go = button('在终端中继续', 'seminars-continue', () => a.continueSeminarInJoint(record.seminarId), '在终端中联合调用这几位作者', 'chat-chip room-tool');
          add.disabled = s.busy || s.active >= s.parallel; go.disabled = s.busy;
          v.tools.append(add, go);
          v.content.append(seminarSynthesis(record, participants), seminarAuthors(record, participants), v.followWrap);
        }
      }
    }
    if (record?.result) drawFollow({ room: 'seminars', id: record.seminarId }, members, record.status === 'done');
    else { v.composer.hidden = true; v.followWrap.hidden = true; }
    if (!record) syncSeminarOpening(s);
    focusOnEnter(record ? null : v.openInput);
  }

  if (room === 'consults') {
    const c = model.consults || { items: [], draft: {} }, fresh = model.fresh?.consults || !c.selected && !c.items.length, record = fresh ? null : c.selected;
    const live = c.items.filter(consultActive).length;
    v.meta.textContent = `${live ? `${live} 次进行中 · ` : ''}共 ${c.items.length} 次`;
    v.notice.textContent = c.busy ? '正在提交或等待确认…' : ''; v.error.textContent = c.error || '';
    const result = record?.result, lensAgents = (result?.lenses || []).map(l => { const agent = byCodexName(l.agent); return { ...l, id: agent?.id || l.agent, name: agent?.name || l.name || l.agent }; });
    const members = lensAgents.map(l => ({ ...person(l.id), name: l.name, id: l.id }));
    const listKey = JSON.stringify([c.items, record?.consultId, fresh]);
    if (v.listKey !== listKey) {
      v.listKey = listKey;
      v.records.replaceChildren(...c.items.map(item => recordItem(item.consultId, firstLine(item.situation) || '处境未载明',
        [clock(item.createdAt), consultActive(item) ? '会诊中' : item.status === 'failed' ? '失败' : `${item.result?.lenses?.length || item.requestedLenses?.length || 0} 个视角`].join(' · '),
        item.consultId === record?.consultId, () => a.selectConsult(item.consultId))));
      if (!c.items.length) v.records.append(node(doc, 'li', '还没有会诊', 'chat-list-empty'));
    }
    const sideKey = JSON.stringify([record?.consultId, lensAgents.map(l => [l.lens, l.id])]);
    if (v.sideKey !== sideKey) {
      v.sideKey = sideKey;
      v.extra.replaceChildren(...(lensAgents.length ? [roster(`这次会诊 · ${lensAgents.length} 个视角`, lensAgents.map(l => ({ id: l.id, name: l.name, book: person(l.id).shortTitle, state: lensName(l.lens) })))] : []));
    }
    v.lead.textContent = record ? `会诊室 · ${lensAgents.length || '3–5'} 个视角 · 由 Codex 进行` : '';
    const history = historyMenu('会诊记录', listKey, c.items.map(item => [item.consultId, firstLine(item.situation) || '处境未载明',
      [clock(item.createdAt), consultActive(item) ? '会诊中' : item.status === 'failed' ? '失败' : `${item.result?.lenses?.length || item.requestedLenses?.length || item.count || 0} 个视角`].join(' · '),
      item.consultId === record?.consultId, () => a.selectConsult(item.consultId)]));
    v.toolbar.hidden = !record && !c.items.length; v.layoutButtons[0].parentElement.hidden = !result;
    const contentKey = JSON.stringify([fresh, record, c.running, c.active, c.busy, c.items.length > 0]);
    if (v.contentKey !== contentKey) {
      v.contentKey = contentKey; v.content.replaceChildren(); v.tools.replaceChildren();
      if (c.items.length) v.tools.append(history);
      if (!record) v.content.append(consultOpening());
      else {
        const rerun = button('补充信息后重新会诊', 'consults-rerun', () => a.rerunConsult(record.consultId), '补充信息后重新会诊；原记录保留', 'chat-chip room-tool');
        const remove = button('删除', 'consults-delete', event => a.deleteConsult(record.consultId, event.currentTarget), '删除这次会诊', 'chat-chip room-tool chat-danger');
        rerun.disabled = remove.disabled = c.busy || consultActive(record);
        // v0.47: a new consult can start from here too, so the folded left column is not the only way in.
        const another = button('＋ 新开一次会诊', 'consults-new-main', () => a.newRoomRecord('consults'), '新开一次会诊；进行中的会诊照常继续', 'chat-chip room-tool');
        v.tools.append(another, rerun, remove);
        const options = (record.options || result?.options || []).map((o, i) => typeof o === 'string' ? `${'ABCDE'[i]}. ${o}` : `${o.id || 'ABCDE'[i]}. ${o.text}`);
        v.content.append(bubble(record.situation, [clock(record.createdAt), options.length ? `选项：${options.join(' / ')}` : '选项由 AI 提出'].join(' · ')));
        if (consultActive(record)) v.content.append(waiting('正在会诊。几位作者从各自的视角分析完，备忘录会自动出现在这里。'));
        if (record.status === 'failed' || record.error && !result) {
          const sheet = paper('room-failed', '诊', '这次会诊没有完成', '失败'); sheet.append(node(doc, 'p', record.error || '原因未载明', 'room-error-text')); v.content.append(sheet);
        }
        if (result) v.content.append(consultMemo(record, lensAgents), consultAuthors(record, lensAgents), v.followWrap);
      }
    }
    if (result) drawFollow({ room: 'consults', id: record.consultId }, members, record.status === 'done');
    else { v.composer.hidden = true; v.followWrap.hidden = true; }
    if (!record) syncConsultOpening(c);
    focusOnEnter(record ? null : v.consultInput);
  }

  if (room === 'councils') {
    const k = model.councils || { items: [] }, c = k.selected, draft = k.draft;
    const open = k.items.filter(x => !x.archived), closed = k.items.filter(x => x.archived);
    v.meta.textContent = `${k.items.some(x => x.running) ? '有顾问团正在开会 · ' : ''}共 ${open.length} 个`;
    v.notice.textContent = k.busy ? '正在提交或等待确认…' : ''; v.error.textContent = k.error || '';
    const listKey = JSON.stringify([k.items, c?.councilId, k.busy]);
    if (v.listKey !== listKey) {
      v.listKey = listKey;
      const item = x => recordItem(x.councilId, x.name, `${x.members.length} 本书 · ${x.sessionCount} 次会议${x.running ? ' · 开会中' : ''}`, x.councilId === c?.councilId, () => a.selectCouncil(x.councilId));
      v.records.replaceChildren(...open.map(item)); if (!open.length) v.records.append(node(doc, 'li', '还没有顾问团', 'chat-list-empty'));
      v.archivedList.replaceChildren(...closed.map(item)); v.archived.hidden = !closed.length;
    }
    const sideKey = JSON.stringify([c?.councilId, c?.members]);
    if (v.sideKey !== sideKey) {
      v.sideKey = sideKey;
      v.extra.replaceChildren(...(c ? [roster('成员', c.members.map(m => ({ id: m.id, name: m.name, book: person(m.id).shortTitle, state: m.available ? '' : '不可用', status: m.available ? 'done' : 'failed' })))] : []));
    }
    // v0.48 (2026-11-07): 顾问团 history and 新建 sit in the toolbar too, as in 圆桌 and 会诊室.
    const history = historyMenu('顾问团记录', listKey, [...open, ...closed].map(x => [x.councilId, x.name,
      `${x.members.length} 本书 · ${x.sessionCount} 次会议${x.running ? ' · 开会中' : ''}${x.archived ? ' · 已归档' : ''}`, x.councilId === c?.councilId, () => a.selectCouncil(x.councilId)]));
    v.toolbar.hidden = !k.items.length; v.layoutButtons[0].parentElement.hidden = true;
    const running = !!c && (!!c.running || c.sessions.some(councilActive));
    const contentKey = JSON.stringify([draft ? { ...draft, books: k.books } : null, c, k.busy, k.items.length]);
    if (v.contentKey !== contentKey) {
      v.contentKey = contentKey; v.content.replaceChildren(); v.tools.replaceChildren();
      if (k.items.length) v.tools.append(history);
      if (c && !draft) v.tools.append(button('＋ 新建顾问团', 'councils-new-main', () => a.newCouncil(), '新建一个顾问团；现有的顾问团不受影响', 'chat-chip room-tool'));
      if (draft || !c) v.content.append(councilOpening(k));
      else v.content.append(...councilView(c, k, running));
    }
    if (draft) syncCouncilOpening(k);
    v.composer.hidden = !!draft || !c; v.recipients.hidden = true;
    if (c && !draft) {
      const n = c.sessions.length + 1;
      v.composerLead.textContent = `开第 ${n} 次会议`; v.composeLabel.textContent = `向顾问团汇报进展，开第 ${n} 次会议`;
      v.input.setAttribute('placeholder', '汇报这段时间的进展、遇到的问题…（Enter 开会，Shift+Enter 换行）');
      follow_(k.report || '');
      v.update = () => {
        const text = v.input.value, count = Array.from(text).length;
        v.send.disabled = k.busy || running || c.archived || !text.trim() || count > 4000;
        v.send.textContent = k.busy ? '正在开会…' : '开会';
        v.hint.textContent = c.archived ? '已归档，先取消归档再开会' : running ? '这次会议还在进行' : count > 4000 ? '汇报最多 4000 字' : `${c.sessions.length ? `带上目标和前 ${c.sessions.length} 次会议` : '带上目标'} · 由 Codex 主持`;
        v.input.disabled = k.busy || c.archived;
      };
      v.update();
    }
    focusOnEnter(draft ? v.councilName : null);
  }

  function focusOnEnter(target) {
    const want = `${room}|${target ? 'open' : 'view'}`;
    if (r.roomFocus === want && !entering) return;
    r.roomFocus = want;
    if (Array.from(doc.querySelectorAll('dialog')).some(d => d.open)) return;
    (target && !target.closest('[hidden]') ? target : v.title).focus();
  }
  function waiting(text) {
    const sheet = paper('room-waiting', '…', '正在进行', ''); sheet.setAttribute('aria-busy', 'true'); sheet.append(node(doc, 'p', text, 'chat-waiting')); return sheet;
  }

  // ---- 圆桌讨论 ----
  function seminarOpening() {
    if (!v.openSheet) {
      const sheet = node(doc, 'section', undefined, 'room-paper room-opening'); sheet.setAttribute('aria-labelledby', 'room-seminars-open-title');
      const heading = node(doc, 'h2', '新开一场圆桌', 'room-paper-title'); heading.id = 'room-seminars-open-title';
      const head = region(doc, 'header', 'room-paper-head', seal('圆'), heading, node(doc, 'span', '由 Codex 主持', 'room-paper-state'));
      const input = node(doc, 'textarea', undefined, 'room-field'); input.id = 'room-seminars-question'; input.rows = 4; input.maxLength = 2000;
      input.setAttribute('placeholder', '写下一个问题或概念，例如：为什么习惯难以改变？'); input.setAttribute('data-focus-key', input.id); input.setAttribute('aria-describedby', 'room-seminars-count');
      input.addEventListener('input', () => { a.setSeminarInput(input.value); syncSeminarOpening(r.roomModel?.seminars); });
      const count = node(doc, 'span', '', 'room-count'); count.id = 'room-seminars-count';
      const start = button('开始圆桌', 'seminars-start', () => a.startSeminar(v.openInput.value), '开始这场圆桌', 'room-primary');
      // v0.53: say before anyone types when there are too few books for the host to pick from.
      const need = node(doc, 'p', '', 'room-note room-need'); need.id = 'room-seminars-need'; start.setAttribute('aria-describedby', need.id);
      sheet.append(head, need, label('问题或概念', input.id), input, count, node(doc, 'p', '主持人从你的书里自动选 3–5 位最相关的作者，各自回答后写一份综合：共同答案、分歧和行动建议。', 'room-note'),
        region(doc, 'div', 'room-paper-foot', start));
      Object.assign(v, { openSheet: sheet, openInput: input, openCount: count, openStart: start, openNeed: need });
    }
    return v.openSheet;
  }
  function syncSeminarOpening(s) {
    if (!s || !v.openInput) return;
    const draft = s.input ?? '';
    if (v.openInput.value !== draft && doc.activeElement !== v.openInput) v.openInput.value = draft;
    const text = v.openInput.value, n = Array.from(text).length;
    v.openInput.disabled = s.busy;
    const full = s.active >= s.parallel;
    v.openCount.textContent = `${n} / 2000 字${full ? ` · 已有 ${s.active} 场圆桌在进行，等其中一场结束再开` : s.active ? ` · 另有 ${s.active} 场圆桌在进行` : ''}`;
    const short = (s.ready ?? 3) < 3;
    v.openNeed.textContent = short ? `圆桌${roomShortage(3, s.ready, READY_TEXT)}` : ''; v.openNeed.hidden = !short;
    v.openStart.disabled = s.busy || full || short || !text.trim() || n > 2000;
  }
  function seminarSynthesis(record, participants) {
    const result = record.result, memberFor = ref => participants.find(p => [p.id, p.agent, p.name].includes(ref));
    const nameOf = id => memberFor(id)?.name || id, names = ids => (ids || []).map(nameOf).join('、');
    // 原文回查 (2026-11-16): found quotes show on hover; quotes not found in that author's analysis are marked.
    const cited = (label, ids, evidence = []) => {
      const list = node(doc, 'small', ` · ${label}：${names(ids)}`), found = evidence.filter(e => e.verified === true), missing = evidence.filter(e => e.verified === false);
      if (found.length) list.setAttribute('title', found.map(e => `${nameOf(e.agent)}：「${e.quote}」`).join('\n'));
      return [list, missing.length ? node(doc, 'small', ` · 未在${missing.map(e => `「${nameOf(e.agent)}」`).join('、')}的原文中找到`, 'room-unverified') : null];
    };
    const parallel = record.verify?.parallel, parallelOk = parallel === true || parallel === 'ok' || parallel?.state === 'ok';
    const verified = record.verify?.state === 'ok' && parallelOk && !record.verify?.violations?.length;
    const sheet = paper('room-synthesis', '综', '主持人综合', verified ? '核验通过' : `核验：${record.verify?.state || '未确认'}`);
    const points = node(doc, 'ul', undefined, 'room-points');
    for (const point of result.commonAnswer?.points || []) {
      const tone = point.strength === '全员一致' ? 'room-unanimous' : point.strength === '多数同意' ? 'room-majority' : 'room-unsure';
      points.append(region(doc, 'li', '', node(doc, 'span', point.text), node(doc, 'span', ` ${point.strength || '共识未确认'}`, tone), ...cited('支持', point.support, point.evidence)));
    }
    const divergences = (result.divergences || []).map(d => region(doc, 'p', '', node(doc, 'strong', `${d.topic}：`),
      node(doc, 'span', (d.positions || []).map(p => `${nameOf(p.agent)}：${p.view}${p.verified === false ? '（未在原文中找到）' : ''}`).join('；'))));
    const actions = node(doc, 'ol');
    for (const item of result.actions || []) actions.append(region(doc, 'li', '', node(doc, 'span', item.text), ...cited('依据', item.basis, item.evidence)));
    // 各书独有 (2026-11-16): one insight per participant, shown before the common answer so a single book's point is not lost.
    const unique = node(doc, 'ul', undefined, 'room-points');
    for (const u of result.unique || []) unique.append(region(doc, 'li', '', node(doc, 'strong', `${nameOf(u.agent)}：`), node(doc, 'span', u.insight), ...cited('出处', [u.agent], [u])));
    sheet.append(region(doc, 'div', 'room-synthesis-grid',
      ...(result.unique ? [section('各书独有', unique)] : []),
      section('共同答案', node(doc, 'p', result.commonAnswer?.summary || '暂无共同答案'), points),
      section('分歧', ...(divergences.length ? divergences : [node(doc, 'p', '未列出分歧点。')])),
      section('行动建议', actions)));
    if (record.strengthCorrected || result.strengthCorrected || (result.commonAnswer?.points || []).some(p => p.strengthCorrected)) sheet.append(node(doc, 'p', '共识强度已由服务器按支持人数修正。', 'room-note'));
    const check = result.sourceCheck;
    if (check) sheet.append(node(doc, 'p', check.unverified ? `原文回查：综合引用的 ${check.total} 处依据中有 ${check.unverified} 处未在作者原文中找到，已逐条标出。`
      : `原文回查：综合引用的 ${check.total} 处依据均见于作者原文。`, 'room-note'));
    if (record.verify?.violations?.length) sheet.append(node(doc, 'p', `核验提示：${JSON.stringify(record.verify.violations)}`, 'room-note'));
    return sheet;
  }
  function seminarAuthors(record, participants) {
    const grid = node(doc, 'div', undefined, 'chat-answers chat-answers-joint room-authors');
    for (const item of record.result.perAgent || []) {
      const id = item.id || item.agent, p = participants.find(x => [x.id, x.agent].includes(id)) || { id, name: id };
      const extra = p.reason ? [node(doc, 'p', `选择理由：${p.reason}`, 'room-reason')] : [];
      grid.append(authorSheet(`${record.seminarId}/${id}`, { id: p.id || id, name: p.name }, [person(p.id).shortTitle, item.coverage].filter(Boolean).join(' · '), renderMarkdown(doc, item.analysis || ''), extra));
    }
    return grid;
  }

  // ---- 会诊室 ----
  function consultOpening() {
    if (!v.consultSheet) {
      const sheet = node(doc, 'section', undefined, 'room-paper room-opening'); sheet.setAttribute('aria-labelledby', 'room-consults-open-title');
      const heading = node(doc, 'h2', '新开一次会诊', 'room-paper-title'); heading.id = 'room-consults-open-title';
      const head = region(doc, 'header', 'room-paper-head', seal('诊'), heading, node(doc, 'span', '由 Codex 进行', 'room-paper-state'));
      const input = node(doc, 'textarea', undefined, 'room-field'); input.id = 'room-consults-situation'; input.rows = 5; input.setAttribute('data-focus-key', input.id);
      input.setAttribute('placeholder', '写下你正面对的处境：背景、约束、你在犹豫什么'); input.setAttribute('aria-describedby', 'room-consults-count room-consults-validation');
      input.addEventListener('input', () => a.setConsultDraft({ situation: input.value }));
      const count = node(doc, 'span', '', 'room-count'); count.id = 'room-consults-count';
      const parent = node(doc, 'p', '', 'room-note');
      const options = node(doc, 'div', undefined, 'room-options');
      const addOption = button('＋ 添加选项', 'consults-add-option', () => { a.setConsultDraft({ options: [...r.roomModel.consults.draft.options, ''] }); doc.getElementById(`room-consults-option-${r.roomModel.consults.draft.options.length - 1}`)?.focus(); }, '添加一个选项', 'room-dashed');
      const optionSet = region(doc, 'fieldset', 'room-fieldset', node(doc, 'legend', '选项 · 留空则由 AI 提出，含维持现状', 'room-field-label'), options, addOption);
      const modes = node(doc, 'div', undefined, 'room-modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '视角与书的选择方式');
      const auto = button('自动选择', 'consults-auto', () => a.setConsultDraft({ explicit: false }), '自动选择视角与书', 'room-mode');
      const explicit = button('指定 3–5 组', 'consults-explicit', () => a.setConsultDraft({ explicit: true, ...(r.roomModel.consults.draft.lenses.length ? {} : { lenses: consultLenses.slice(0, 3).map(([lens]) => ({ lens, agentId: '' })) }) }), '自己指定 3–5 组视角与书', 'room-mode');
      // Choosing a number also chooses 自动选择: the count only applies when the host picks the books.
      const counts = node(doc, 'div', undefined, 'room-counts'); counts.setAttribute('role', 'group'); counts.setAttribute('aria-label', '自动选择几本书');
      const countButtons = consultCounts.map(n => { const el = button(`${n} 本`, `consults-count-${n}`, () => a.setConsultDraft({ explicit: false, count: n }), `自动选择 ${n} 本书一起会诊`, 'room-mode room-count'); counts.append(el); return el; });
      modes.append(auto, counts, explicit);
      const lenses = node(doc, 'div', undefined, 'room-lenses');
      const addLens = button('＋ 添加视角', 'consults-add-lens', () => { const d = r.roomModel.consults.draft; a.setConsultDraft({ lenses: [...d.lenses, { lens: consultLenses.find(([id]) => !d.lenses.some(l => l.lens === id))?.[0] || '', agentId: '' }] }); }, '添加一组视角与书', 'room-dashed');
      const lensSet = region(doc, 'fieldset', 'room-fieldset room-lens-box', node(doc, 'legend', '视角与书', 'room-field-label'), modes, lenses, addLens);
      const validation = node(doc, 'p', '', 'room-note'); validation.id = 'room-consults-validation';
      const start = button('开始会诊', 'consults-start', () => a.startConsult(), '开始这次会诊', 'room-primary'); start.setAttribute('aria-describedby', validation.id);
      sheet.append(head, parent, label('处境', input.id), input, count, optionSet, lensSet, validation,
        region(doc, 'div', 'room-paper-foot', node(doc, 'span', '备忘录由书中观点推演而来，不构成医疗、法律、心理或投资建议', 'room-note'), start));
      Object.assign(v, { consultSheet: sheet, consultInput: input, consultCount: count, consultParent: parent, consultOptions: options, consultAddOption: addOption,
        consultAuto: auto, consultCountButtons: countButtons, consultExplicit: explicit, consultLenses: lenses, consultAddLens: addLens, consultValidation: validation, consultStart: start });
    }
    return v.consultSheet;
  }
  function syncConsultOpening(c) {
    if (!v.consultSheet) return;
    const draft = c.draft, busy = c.busy;
    if (v.consultInput.value !== draft.situation && doc.activeElement !== v.consultInput) v.consultInput.value = draft.situation;
    v.consultInput.disabled = busy;
    v.consultCount.textContent = `${Array.from(draft.situation.trim()).length} / 4000 字`;
    v.consultParent.textContent = draft.parentId ? '补充信息后重新会诊；原来的记录会保留。' : ''; v.consultParent.hidden = !draft.parentId;
    if (v.optionCount !== draft.options.length) {
      v.optionCount = draft.options.length; v.optionInputs = []; v.consultOptions.replaceChildren();
      draft.options.forEach((_text, i) => {
        const input = node(doc, 'input', undefined, 'room-line'); input.id = `room-consults-option-${i}`; input.setAttribute('data-focus-key', input.id); input.setAttribute('aria-label', `选项 ${'ABCDE'[i]}`);
        input.setAttribute('placeholder', `选项 ${'ABCDE'[i]}`);
        input.addEventListener('input', () => { const options = [...r.roomModel.consults.draft.options]; options[i] = input.value; a.setConsultDraft({ options }); });
        const remove = button('移除', `consults-remove-option-${i}`, () => { a.setConsultDraft({ options: r.roomModel.consults.draft.options.filter((_, n) => n !== i) }); (doc.getElementById(`room-consults-option-${Math.max(0, i - 1)}`) || v.consultAddOption).focus(); }, `移除选项 ${'ABCDE'[i]}`, 'room-remove');
        v.consultOptions.append(region(doc, 'div', 'room-option-row', node(doc, 'span', 'ABCDE'[i], 'room-option-letter'), input, remove));
        v.optionInputs.push([input, remove]);
      });
    }
    v.optionInputs.forEach(([input, remove], i) => { if (input.value !== draft.options[i] && doc.activeElement !== input) input.value = draft.options[i]; input.disabled = remove.disabled = busy; });
    v.consultAddOption.disabled = busy || draft.options.length >= 5;
    v.consultAuto.setAttribute('aria-pressed', String(!draft.explicit)); v.consultExplicit.setAttribute('aria-pressed', String(draft.explicit));
    v.consultAuto.disabled = v.consultExplicit.disabled = busy;
    for (const [i, el] of v.consultCountButtons.entries()) { el.setAttribute('aria-pressed', String(!draft.explicit && draft.count === consultCounts[i])); el.disabled = busy; }
    v.consultLenses.hidden = v.consultAddLens.hidden = !draft.explicit; v.consultAddLens.disabled = busy || draft.lenses.length >= 5;
    const lensKey = JSON.stringify([draft.lenses.length, c.books]);
    if (v.lensKey !== lensKey) {
      v.lensKey = lensKey; v.lensInputs = []; v.consultLenses.replaceChildren();
      draft.lenses.forEach((_l, i) => {
        const lens = node(doc, 'select', undefined, 'room-line'), book = node(doc, 'select', undefined, 'room-line');
        for (const [id, name] of consultLenses) { const o = node(doc, 'option', name); o.value = id; lens.append(o); }
        const none = node(doc, 'option', '请选择书籍'); none.value = ''; book.append(none);
        for (const b of c.books) { const o = node(doc, 'option', `${b.name} · ${b.bookLabel}${b.available ? '' : '（Codex 不可用）'}`); o.value = b.id; o.disabled = !b.available; book.append(o); }
        for (const [field, el] of [['lens', lens], ['agentId', book]]) {
          el.id = `room-consults-${field}-${i}`; el.setAttribute('data-focus-key', el.id); el.setAttribute('aria-label', `${field === 'lens' ? '视角' : '书籍'} ${i + 1}`);
          el.addEventListener('change', () => { const lenses = structuredClone(r.roomModel.consults.draft.lenses); lenses[i][field] = el.value; a.setConsultDraft({ lenses }); });
        }
        const remove = button('移除', `consults-remove-lens-${i}`, () => { a.setConsultDraft({ lenses: r.roomModel.consults.draft.lenses.filter((_, n) => n !== i) }); v.consultAddLens.focus(); }, `移除视角 ${i + 1}`, 'room-remove');
        v.consultLenses.append(region(doc, 'div', 'room-lens-row', lens, book, remove)); v.lensInputs.push([lens, book, remove]);
      });
    }
    v.lensInputs.forEach(([lens, book, remove], i) => { lens.value = draft.lenses[i].lens; book.value = draft.lenses[i].agentId; lens.disabled = book.disabled = busy; remove.disabled = busy || draft.lenses.length <= 3; });
    // v0.53: 自动选择 needs as many ready books as it is asked to pick; 指定 needs 3 books Codex can run.
    const need = draft.explicit ? 3 : draft.count ?? 3, have = c.books.filter(b => draft.explicit ? b.available : b.ready).length;
    const shortage = have < need ? `会诊${draft.explicit ? '指定视角' : `自动选择 ${need} 本`}${roomShortage(need, have, draft.explicit ? ' Codex 能用' : READY_TEXT)}` : '';
    v.consultValidation.textContent = shortage || consultDraftError(draft);
    const full = c.active >= c.parallel;
    v.consultStart.disabled = busy || full || !!shortage || !!consultDraftError(draft);
    v.consultStart.textContent = full ? `已有 ${c.active} 场会诊在进行` : c.active ? `开始会诊（另有 ${c.active} 场在进行）` : '开始会诊';
  }
  function consultMemo(record, lensAgents) {
    const result = record.result, memo = result.memo, rec = memo.recommendation;
    const author = agent => { const l = lensAgents.find(x => x.agent === agent); return l ? `${l.name}（${lensName(l.lens)}）` : agent; };
    const refs = item => `依据：${(item.basis || []).map(author).join('、')}${item.notes?.length ? ' · ' + item.notes.join('；') : ''}`;
    const sheet = paper('room-synthesis', '诊', '会诊备忘录', `把握程度：${rec.confidence}`);
    sheet.append(node(doc, 'p', `${result.situation.summary} 要做的决定：${result.situation.decision}`, 'room-situation'),
      region(doc, 'div', 'room-recommend', node(doc, 'h3', rec.option === null ? '暂不推荐，先补充下面的信息' : `推荐 ${rec.option}：${result.options.find(o => o.id === rec.option)?.text || ''}`),
        node(doc, 'p', rec.rationale), node(doc, 'small', refs(rec))));
    const table = node(doc, 'table', undefined, 'room-matrix'); table.append(node(doc, 'caption', '选项 × 视角'));
    const head = node(doc, 'tr'), corner = node(doc, 'th', '选项'); corner.setAttribute('scope', 'col'); head.append(corner);
    for (const l of lensAgents) { const th = node(doc, 'th', `${lensName(l.lens)} · ${l.name}`); th.setAttribute('scope', 'col'); head.append(th); }
    const rows = node(doc, 'tbody');
    for (const o of result.options) {
      const row = node(doc, 'tr'), title = node(doc, 'th', `${o.id}. ${o.text}`); title.setAttribute('scope', 'row'); row.append(title);
      for (const l of lensAgents) {
        const note = result.perLens.find(p => p.lens === l.lens)?.optionNotes.find(n => n.option === o.id);
        row.append(region(doc, 'td', '', node(doc, 'strong', note?.assessment || '—', `room-assess-${{ 有利: 'good', 不利: 'bad', 中性: 'neutral' }[note?.assessment] || 'neutral'}`), node(doc, 'p', note?.note || '')));
      }
      rows.append(row);
    }
    table.append(region(doc, 'thead', '', head), rows);
    const scroll = region(doc, 'div', 'room-table-scroll', table); scroll.setAttribute('tabindex', '0'); scroll.setAttribute('aria-label', '选项与视角对照表，可横向滚动');
    sheet.append(scroll, region(doc, 'div', 'room-synthesis-grid',
      section('主要风险', list('ul', memo.risks.map(x => region(doc, 'li', '', node(doc, 'span', x.text), node(doc, 'small', ` · ${refs(x)}`))))),
      section('视角之间的冲突', ...(memo.tensions.length ? memo.tensions.map(t => region(doc, 'p', '', node(doc, 'strong', `${t.topic}：`),
        node(doc, 'span', t.positions.map(p => `${author(p.agent)}：${p.view}${p.note ? `（${p.note}）` : ''}`).join('；')))) : [node(doc, 'p', '未列出冲突。')])),
      section('下一步行动', list('ol', memo.nextSteps.map(x => region(doc, 'li', '', node(doc, 'span', x.text), node(doc, 'small', ` · ${refs(x)}`)))))),
      memo.missingInfo.length ? section('会改变结论的信息', list('ul', memo.missingInfo)) : node(doc, 'span'),
      node(doc, 'p', consultDisclaimer, 'room-note'),
      node(doc, 'p', `派生核验：${record.verify?.state || 'unconfirmed'}${record.verify?.error ? ` · ${record.verify.error}` : ''}${record.verify?.violations?.length ? ' · ' + record.verify.violations.join('；') : ''}`, 'room-note'));
    return sheet;
  }
  function consultAuthors(record, lensAgents) {
    const grid = node(doc, 'div', undefined, 'chat-answers chat-answers-joint room-authors');
    for (const p of record.result.perLens) {
      const l = lensAgents.find(x => x.lens === p.lens) || { id: p.agent, name: p.agent, lens: p.lens };
      grid.append(authorSheet(`${record.consultId}/${p.lens}`, { id: l.id, name: `${lensName(p.lens)} · ${l.name}` }, l.bookLabel || person(l.id).shortTitle,
        renderMarkdown(doc, p.analysis || ''), l.reason ? [node(doc, 'p', `选择理由：${l.reason}`, 'room-reason')] : []));
    }
    return grid;
  }

  // ---- 顾问团 ----
  function councilOpening(k) {
    if (!v.councilSheet) {
      const sheet = node(doc, 'section', undefined, 'room-paper room-opening'); sheet.setAttribute('aria-labelledby', 'room-councils-open-title');
      const title = node(doc, 'h2', '', 'room-paper-title'); title.id = 'room-councils-open-title';
      const name = node(doc, 'input', undefined, 'room-line'); name.id = 'room-councils-name'; name.maxLength = 40; name.setAttribute('data-focus-key', name.id); name.setAttribute('placeholder', '例如：健康长期计划');
      name.addEventListener('input', () => a.setCouncilDraft({ name: name.value }));
      const goal = node(doc, 'textarea', undefined, 'room-field'); goal.id = 'room-councils-goal'; goal.rows = 3; goal.setAttribute('data-focus-key', goal.id); goal.setAttribute('placeholder', '这个顾问团长期帮你盯着什么目标？');
      goal.addEventListener('input', () => a.setCouncilDraft({ goal: goal.value }));
      const choices = node(doc, 'fieldset', undefined, 'room-fieldset room-members');
      const validation = node(doc, 'p', '', 'room-note'); validation.id = 'room-councils-validation';
      const save = button('保存顾问团', 'councils-save', () => a.saveCouncil(), '保存这个顾问团', 'room-primary'); save.setAttribute('aria-describedby', validation.id);
      const cancel = button('取消', 'councils-cancel', () => a.cancelCouncilEdit(), '取消编辑', 'chat-tool');
      const empty = region(doc, 'div', 'room-empty-sheet', node(doc, 'p', '新建一个顾问团：选 2–5 本书做成员，写下长期目标。之后每次向它汇报进展，它会回顾上次的建议、调整计划。', 'room-empty-text'),
        button('＋ 新建顾问团', 'councils-start', () => a.newCouncil(), '新建顾问团', 'room-primary'));
      const form = region(doc, 'div', 'room-opening-body', label('名字（1–40 字）', name.id), name, label('长期目标（1–1000 字）', goal.id), goal, choices, validation,
        region(doc, 'div', 'room-paper-foot', node(doc, 'span', consultDisclaimer, 'room-note'), cancel, save));
      sheet.append(region(doc, 'header', 'room-paper-head', seal('团'), title, node(doc, 'span', '由 Codex 主持', 'room-paper-state')), empty, form);
      Object.assign(v, { councilSheet: sheet, councilTitle: title, councilName: name, councilGoal: goal, councilChoices: choices, councilValidation: validation, councilSave: save, councilCancel: cancel, councilEmpty: empty, councilForm: form });
    }
    v.councilEmpty.hidden = !!k.draft; v.councilForm.hidden = !k.draft;
    v.councilTitle.textContent = k.draft ? (k.draft.councilId ? '编辑顾问团' : '新建顾问团') : k.items.length ? '选一个顾问团' : '还没有顾问团';
    v.councilEmpty.querySelector('.room-empty-text').textContent = (k.items.length ? '在左边选一个顾问团查看历次会议，或新建一个。'
      : '新建一个顾问团：选 2–5 本书做成员，写下长期目标。之后每次向它汇报进展，它会回顾上次的建议、调整计划。') +
      (k.books.length < 2 ? `顾问团${roomShortage(2, k.books.length, '')}` : '');
    return v.councilSheet;
  }
  function syncCouncilOpening(k) {
    const draft = k.draft;
    for (const [key, el] of [['name', v.councilName], ['goal', v.councilGoal]]) { if (el.value !== draft[key] && doc.activeElement !== el) el.value = draft[key]; el.disabled = k.busy; }
    const problem = k.books.length < 2 ? `顾问团${roomShortage(2, k.books.length, '')}` : councilDraftError(draft);
    v.councilValidation.textContent = problem; v.councilSave.disabled = k.busy || !!problem; v.councilCancel.disabled = k.busy;
    const choicesKey = JSON.stringify([k.books, draft.memberIds]);
    if (v.choicesKey !== choicesKey) {
      v.choicesKey = choicesKey; v.councilChoices.replaceChildren(node(doc, 'legend', `成员：${draft.memberIds.length} / 5（至少 2 本）`, 'room-field-label'));
      const books = [...k.books, ...draft.memberIds.filter(id => !k.books.some(b => b.id === id)).map(id => ({ id, name: id, bookLabel: '已移除', available: false }))];
      for (const book of books) {
        const input = node(doc, 'input'); input.type = 'checkbox'; input.id = `room-councils-member-${book.id}`; input.setAttribute('data-focus-key', input.id); input.checked = draft.memberIds.includes(book.id);
        input.addEventListener('change', () => { const ids = r.roomModel.councils.draft.memberIds; a.setCouncilDraft({ memberIds: input.checked ? [...ids, book.id] : ids.filter(id => id !== book.id) }); });
        v.councilChoices.append(region(doc, 'div', 'room-choice', input, label(`${book.name} · ${book.bookLabel}${book.available ? '' : '（不可用）'}`, input.id)));
      }
    }
    for (const input of v.councilChoices.querySelectorAll('input')) input.disabled = k.busy || (!input.checked && draft.memberIds.length >= 5);
  }
  function councilView(c, k, running) {
    const currentNames = c.members.map(m => m.codexName);
    const author = name => `${c.members.find(m => m.codexName === name)?.name || name}${currentNames.includes(name) ? '' : '（已退出）'}`;
    const refs = rec => `依据：${rec.basis.map(author).join('、')}${rec.notes?.length ? ' · ' + rec.notes.join('；') : ''}`;
    const edit = button('编辑名字、目标、成员', 'councils-edit', () => a.editCouncil(), '编辑这个顾问团', 'chat-chip room-tool');
    const archive = button(c.archived ? '取消归档' : '归档', 'councils-archive', () => a.archiveCouncil(), undefined, 'chat-chip room-tool');
    const undo = button('撤销最近一次会议', 'councils-undo', event => a.undoCouncil(event.currentTarget), '撤销最近一次会议并恢复之前的计划', 'chat-chip room-tool');
    const remove = button('删除', 'councils-delete', event => a.deleteCouncil(event.currentTarget), '删除整个顾问团', 'chat-chip room-tool chat-danger');
    for (const el of [edit, archive, remove]) el.disabled = k.busy || running;
    undo.disabled = k.busy || running || !c.sessions.some(s => s.status === 'done' && !s.undone);
    const header = region(doc, 'header', 'room-council-head', region(doc, 'div', 'room-council-line', node(doc, 'h2', c.name, 'room-council-name'), edit, archive, undo, remove),
      node(doc, 'p', `目标：${c.goal}`, 'room-council-goal'));
    // The plan and memory the council carries between meetings.
    const plan = node(doc, 'details', undefined, 'room-plan'); plan.setAttribute('data-room-open', `${c.councilId}/plan`); plan.open = v.open.has(`${c.councilId}/plan`);
    plan.addEventListener('toggle', () => plan.open ? v.open.add(`${c.councilId}/plan`) : v.open.delete(`${c.councilId}/plan`));
    const planSheet = region(doc, 'div', 'room-paper room-plan-sheet', node(doc, 'p', c.memory.summary));
    for (const status of ['有效', '无效', '未执行', '待观察']) {
      const entries = c.memory.recommendations.filter(x => x.status === status); if (!entries.length) continue;
      planSheet.append(section(status, list('ul', entries.map(x => region(doc, 'li', '', node(doc, 'span', `${x.id} · ${x.text}`), node(doc, 'small', ` · ${refs(x)}`))))));
    }
    if (c.memory.openItems.length) planSheet.append(section('待观察事项', list('ul', c.memory.openItems)));
    planSheet.append(node(doc, 'p', `下次重点：${c.nextCheck || '等待首次汇报'}`, 'room-next'));
    plan.append(node(doc, 'summary', `当前计划与记忆 · 下次重点：${c.nextCheck || '首次汇报后形成计划'}`), planSheet);
    // The server lists meetings newest first; read them in order, the latest open at the bottom.
    const meetings = [...c.sessions].reverse().map((s, i) => {
      const key = `${s.sessionId}`, last = i === c.sessions.length - 1;
      const meeting = node(doc, 'details', undefined, `room-meeting${s.undone ? ' is-undone' : ''}`); meeting.open = last ? !v.open.has(`${key}/closed`) : v.open.has(key);
      meeting.addEventListener('toggle', () => { if (last) meeting.open ? v.open.delete(`${key}/closed`) : v.open.add(`${key}/closed`); else meeting.open ? v.open.add(key) : v.open.delete(key); });
      const state = s.undone ? '已撤销' : s.status === 'done' ? '' : s.status === 'failed' ? '失败' : '正在开会';
      meeting.append(node(doc, 'summary', [`第 ${i + 1} 次会议`, clock(s.createdAt), state].filter(Boolean).join(' · ')), bubble(s.report, clock(s.createdAt)));
      if (councilActive(s)) meeting.append(waiting('顾问团正在开会：每位成员先回顾上次的建议，再给出意见，完成后自动出现在这里。'));
      if (s.error) { const sheet = paper('room-failed', '团', '这次会议没有完成', '失败'); sheet.append(node(doc, 'p', s.error, 'room-error-text')); meeting.append(sheet); }
      if (s.result) {
        const sheet = paper('room-synthesis', '团', '顾问团意见', s.verify?.state === 'ok' ? '核验通过' : `核验：${s.verify?.state || '未确认'}`);
        const reviews = s.result.review.map(review => {
          const before = s.memoryBefore.recommendations.find(x => x.id === review.recId);
          return `${review.recId} ${before?.text || ''}：${before?.status || '待观察'} → ${review.status}；证据：${review.evidence}`;
        });
        const p = s.result.plan, before = id => s.memoryBefore.recommendations.find(x => x.id === id)?.text || '';
        const planParts = [['保留', p.keep.map(id => `${id} · ${before(id)}`)], ['调整', p.change.map(x => `${x.recId} · ${x.text}（${refs(x)}）`)],
          ['新增', p.add.map(x => `${x.text}（${refs(x)}）`)], ['停止', p.stop.map(x => `${x.recId} · ${x.reason}`)]].filter(([, items]) => items.length);
        sheet.append(region(doc, 'div', 'room-synthesis-grid', section('建议效果回顾', list('ul', reviews.length ? reviews : ['这是第一次会议，没有可回顾的建议。'])),
          ...planParts.map(([title, items]) => section(title, list('ul', items)))), node(doc, 'p', `下次重点：${s.result.nextCheck}`, 'room-next'));
        if (s.verify?.violations?.length || s.verify?.error) sheet.append(node(doc, 'p', `核验提示：${[...(s.verify.violations || []), s.verify.error].filter(Boolean).join('；')}`, 'room-note'));
        const chips = node(doc, 'div', undefined, 'room-originals'), originals = node(doc, 'div', undefined, 'room-original-list');
        for (const entry of s.result.perMember) {
          const member = s.memberSnapshot.find(m => (m.platforms?.codex?.name || m.name) === entry.agent), name = member?.name || entry.agent, openKey = `${s.sessionId}/${entry.agent}`;
          const text = region(doc, 'article', 'chat-answer room-original status-done', region(doc, 'header', 'chat-answer-head', node(doc, 'h3', `${name} 的原文`, 'chat-answer-name')), renderMarkdown(doc, entry.analysis || ''));
          setStyle(text, { '--cloth': clothOf(member?.id || name) }); text.hidden = !v.open.has(openKey);
          const chip = button(`${name} 的原文`, '', () => { const show = !v.open.has(openKey); show ? v.open.add(openKey) : v.open.delete(openKey); text.hidden = !show; chip.setAttribute('aria-expanded', String(show)); }, `${name} 在这次会议里的原文`, 'chat-chip room-tool');
          chip.setAttribute('aria-expanded', String(!text.hidden)); chips.append(chip); originals.append(text);
        }
        meeting.append(sheet, chips, originals);
      }
      return meeting;
    });
    if (!meetings.length) meetings.push(node(doc, 'p', '还没有开过会。在下面写下这段时间的进展，开第一次会议。', 'room-note room-first'));
    return [header, plan, ...meetings];
  }
}
