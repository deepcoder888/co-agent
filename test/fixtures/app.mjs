import fs from 'node:fs/promises';
import { documentFrom } from './dom.mjs';
export async function appDocument(ui = 'bento', token = 'synthetic-token') {
  const html = (await fs.readFile('public/index.html','utf8')).replace('<!-- AGENT_HUB_TOKEN -->',`<meta name="agent-hub-token" content="${token}">`);
  const doc=documentFrom(html);doc.documentElement.setAttribute('data-ui',ui);
  const ids=new Proxy({}, {get:(_,id)=>doc.getElementById(id)});
  return {doc,ids,events:{keydown:e=>doc.fire('keydown',e)}};
}
export async function allStyles() {
  return (await Promise.all(['public/styles.css',...['threepane','bento','editorial','shelf'].map(id=>`public/layouts/${id}.css`)].map(f=>fs.readFile(f,'utf8')))).join('\n');
}
