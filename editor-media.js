import { Node } from '@tiptap/core';
import {createPdfPreview} from './pdf-preview.js';

const FILE_ID = /^[a-f0-9]{32}$/;
const PREVIEWS = new Set(['image/png','image/jpeg','image/gif','image/webp','application/pdf','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/ogg','audio/wav','audio/mp4']);
export function embedSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase(), path = url.pathname;
    if (['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtube-nocookie.com'].includes(host)) {
      const id = host === 'youtu.be' ? path.slice(1) : url.searchParams.get('v') || path.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1];
      return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (['vimeo.com','www.vimeo.com','player.vimeo.com'].includes(host)) {
      const id = path.match(/^\/(?:video\/)?(\d+)\/?$/)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
    if (host === 'open.spotify.com') {
      const match = path.match(/^\/(?:embed\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]+)\/?$/);
      return match ? `https://open.spotify.com/embed/${match[1]}/${match[2]}` : null;
    }
    if (host === 'docs.google.com') {
      const match = path.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)(?:\/(?:edit|preview|embed))?\/?$/);
      if (match) return `https://docs.google.com/${match[1]}/d/${match[2]}/${match[1] === 'presentation' ? 'embed' : 'preview'}`;
      if (/^\/(?:document|spreadsheets|presentation)\/d\/e\/[\w-]+\/(?:pub|pubhtml|embed)$/.test(path)) return url.href;
    }
    if (host === 'www.google.com' && /^\/maps\/embed(?:\/v1\/[a-z]+)?\/?$/.test(path)) return url.href;
  } catch {}
  return null;
}

export function embedOpenUrl(value) {
  const url = new URL(value);
  if (url.hostname === 'www.youtube-nocookie.com') return `https://www.youtube.com/watch?v=${url.pathname.split('/').pop()}`;
  if (url.hostname === 'player.vimeo.com') return `https://vimeo.com/${url.pathname.split('/').pop()}`;
  if (url.hostname === 'open.spotify.com') return url.href.replace('/embed/', '/');
  return url.href;
}

export function normalizeMedia(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'embed') {
    const src = embedSource(value.url);
    return src ? {kind:'embed', url:src, filename:'Insluiting', id:'', media_type:'', size:0} : null;
  }
  if (!FILE_ID.test(value.id || '')) return null;
  return {kind:'file', id:value.id, filename:String(value.filename || 'Bestand').slice(0,240), media_type:PREVIEWS.has(value.media_type) ? value.media_type : 'application/octet-stream', size:Math.max(0, Number(value.size) || 0), url:''};
}
function sizeLabel(size) { return size >= 1024*1024 ? `${(size/1024/1024).toFixed(1)} MB` : `${Math.ceil(size/1024)} KB`; }
function element(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

export const PageMedia = Node.create({
  name:'pageMedia', group:'block', atom:true, draggable:true, selectable:true, priority:150,
  addAttributes() { return Object.fromEntries(['kind','id','filename','media_type','size','url'].map(key => [key,{default:key === 'size' ? 0 : ''}])); },
  parseHTML() { return [{tag:'figure[data-page-media]', getAttrs:node => {try {return normalizeMedia(JSON.parse(node.getAttribute('data-page-media'))) || false;} catch {return false;}}}]; },
  renderHTML({node}) {
    const data = normalizeMedia(node.attrs);
    if (!data) return ['p', {}, 'Bijlage niet beschikbaar'];
    return ['figure', {'data-page-media':JSON.stringify(data)}, ['a', {href:data.kind === 'file' ? `/api/files/${data.id}` : data.url}, data.filename]];
  },
  markdownTokenName:'code',
  parseMarkdown(token, helpers) {
    if (token.lang !== 'thuis-media') return null;
    try { const attrs = normalizeMedia(JSON.parse(token.text)); return attrs ? helpers.createNode('pageMedia',attrs) : null; } catch {return null;}
  },
  renderMarkdown(node) { return '```thuis-media\n' + JSON.stringify(node.attrs) + '\n```'; },
  addNodeView() {
    return ({node, editor, getPos}) => {
      const data = normalizeMedia(node.attrs), dom = element('figure',{class:'page-media',contenteditable:'false'});
      if (!data) {dom.textContent = 'Bijlage niet beschikbaar'; return {dom};}
      let pdfPreview=null;
      const header = element('div',{class:'page-media-header'});
      header.append(element('span', {class:'page-media-name'}, data.kind === 'embed' ? new URL(data.url).hostname : data.filename));
      const remove = element('button',{type:'button',class:'page-media-remove','aria-label':`Verwijder ${data.filename} uit de tekst`,title:'Uit de tekst verwijderen; het bestand blijft bij Bestanden'},'×');
      remove.addEventListener('click', () => {const pos=getPos(); if (typeof pos === 'number') editor.chain().focus().deleteRange({from:pos,to:pos+node.nodeSize}).run();});
      header.append(remove); dom.append(header);
      if (data.kind === 'embed') {
        const load = element('button',{type:'button',class:'page-embed-load'},'Insluiting laden');
        load.append(element('small',{},'Laadt inhoud van deze externe dienst.'));
        load.addEventListener('click', () => {
          const frame = element('iframe',{src:data.url,title:`Insluiting van ${new URL(data.url).hostname}`,loading:'lazy',referrerpolicy:'strict-origin',sandbox:'allow-scripts allow-same-origin allow-presentation',allow:'fullscreen; encrypted-media; picture-in-picture',allowfullscreen:''});
          load.replaceWith(frame);
        });
        dom.append(load,element('a',{href:embedOpenUrl(data.url),target:'_blank',rel:'noopener noreferrer',class:'page-media-link'},'Open in nieuw tabblad ↗'));
      } else {
        const url = `/api/files/${data.id}`, preview = url + '?preview=1';
        if (data.media_type.startsWith('image/')) dom.append(element('img',{src:preview,alt:data.filename,loading:'lazy'}));
        else if (data.media_type.startsWith('video/')) dom.append(element('video',{src:preview,controls:'',preload:'metadata',playsinline:''}));
        else if (data.media_type.startsWith('audio/')) dom.append(element('audio',{src:preview,controls:'',preload:'metadata'}));
        else if (data.media_type === 'application/pdf') {pdfPreview=createPdfPreview(preview,data.filename);dom.append(pdfPreview.dom);}
        const links = element('div',{class:'page-media-links'});
        if (PREVIEWS.has(data.media_type)) links.append(element('a',{href:preview,target:'_blank',rel:'noopener noreferrer',class:'page-media-link'},'Openen ↗'));
        links.append(element('a',{href:url,target:'_blank',download:data.filename,rel:'noopener noreferrer',class:'page-media-link'},`Downloaden · ${sizeLabel(data.size)}`));
        dom.append(links);
      }
      return {dom, destroy:()=>pdfPreview?.destroy(), stopEvent:event => !!event.target.closest('button,a,video,audio,iframe'), ignoreMutation:() => true};
    };
  }
});
