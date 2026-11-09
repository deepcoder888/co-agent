import { bookLabel, summary, statsReadable } from './display.js';

const ranges = { '7d':'last7d', '30d':'last30d', all:'total' };
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const validBucket = b => b && ['calls','ok','failed','unknown'].every(k => validCount(b[k])) && ['claude','codex'].every(k => validCount(b.bySource?.[k]));
const descending = (a, b) => b.value - a.value || String(a.name || a.label).localeCompare(String(b.name || b.label), 'zh-CN') || String(a.id || a.key).localeCompare(String(b.id || b.key));

// Own only view choices; registry/statistics remain owned by app.js. No API calls here.
export function createStatsView({getStats, getRegistry, onState = () => {}}) {
  let range = '7d', filter = 'all', showAll = false, categoryFilter = null;
  function snapshot() {
    const stats = getStats(), registry = getRegistry(), bucket = ranges[range];
    const categories = [...(registry?.categories || [])];
    if (registry?.agents.some(a => a.kind === 'book' && a.primary === '未分类') && !categories.includes('未分类')) categories.push('未分类');
    const limited = range === 'all' ? stats?.limited : stats?.[`${bucket}Limited`];
    const limitedReasons = [...(range === 'all' ? stats?.limitedReasons || [] : stats?.[`${bucket}LimitedReasons`] || [])];
    const base = {range,filter,showAll,categoryFilter,generatedAt:stats?.generatedAt || null,
      daily:stats?.daily ? structuredClone(stats.daily) : [], limited:!!limited,limitedReasons};
    const status = !registry || !stats || stats.building ? 'loading' : !statsReadable(stats) || !registry.agents.every(a => validBucket(stats.perAgent?.[a.id]?.[bucket])) ? 'unavailable' : 'ready';
    if (status !== 'ready') return {...base,status,limited:true,limitedReasons:[...limitedReasons, status === 'loading' ? '统计正在建立' : `${range === '30d' ? '30 天' : range === '7d' ? '7 天' : '累计'}调用数据不可用`],
      totals:{calls:null,claude:null,codex:null,ok:null,failed:null,unknown:null,agentsUsed:null},byKind:[],byCategory:[],agents:[],zeroCount:0,agentCount:0};
    const all = registry.agents.map(agent => {
      const b = stats.perAgent[agent.id][bucket];
      return {id:agent.id,name:agent.name,kind:agent.kind,category:agent.primary,
        ...(agent.kind === 'book' ? {bookLabel:bookLabel(agent)} : {purpose:agent.purpose || summary(agent.description)}),
        value:b.calls,claude:b.bySource.claude,codex:b.bySource.codex,ok:b.ok,failed:b.failed,lastAt:stats.perAgent[agent.id].lastAt || null,unknown:b.unknown};
    }).sort(descending);
    const totals = all.reduce((acc, a) => { acc.calls += a.value; for (const k of ['claude','codex','ok','failed','unknown']) acc[k] += a[k]; acc.agentsUsed += Number(a.value > 0); return acc; }, {calls:0,claude:0,codex:0,ok:0,failed:0,unknown:0,agentsUsed:0});
    const sum = predicate => all.filter(predicate).reduce((n, a) => n + a.value, 0);
    const byKind = [{key:'role',label:'功能性',value:sum(a => a.kind === 'role')},{key:'book',label:'书籍',value:sum(a => a.kind === 'book')}];
    const byCategory = categories.map(key => ({key,label:key,value:sum(a => a.kind === 'book' && a.category === key)})).sort(descending);
    const filtered = all.filter(a => (filter === 'all' || a.kind === filter) && (!categoryFilter || a.category === categoryFilter));
    return {...base,status,totals,byKind,byCategory,agents:showAll ? filtered : filtered.filter(a => a.value > 0).slice(0,20),zeroCount:filtered.filter(a => a.value === 0).length,agentCount:filtered.length};
  }
  return {snapshot,
    setRange(value) { if (!Object.hasOwn(ranges,value) || range === value) return; range=value;showAll=false;onState(); },
    setFilter(value) { if (!['all','role','book'].includes(value)) return; filter=value;categoryFilter=null;showAll=false;onState(); },
    setCategory(value) { if (!(getRegistry()?.categories || []).includes(value) && !(value === '未分类' && getRegistry()?.agents.some(a => a.primary === value))) return;
      const same=categoryFilter===value;categoryFilter=same?null:value;filter=same?'all':'book';showAll=false;onState(); },
    toggleShowAll() { showAll=!showAll;onState(); }
  };
}
