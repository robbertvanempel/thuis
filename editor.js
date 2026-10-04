import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { PageMedia, embedSource, normalizeMedia } from './editor-media.js';

window.FamilyPageEditor = function ({element, toolbar, menu, content, onChange, onUploadFile, onUploadState, onUploaded, onError}) {
  const commands = [
    ['Tekst', 'paragraph', c => c.setParagraph()],
    ['Kop 1', 'heading', c => c.toggleHeading({level:1}), {level:1}],
    ['Kop 2', 'heading', c => c.toggleHeading({level:2}), {level:2}],
    ['Kop 3', 'heading', c => c.toggleHeading({level:3}), {level:3}],
    ['Opsomming', 'bulletList', c => c.toggleBulletList()],
    ['Nummering', 'orderedList', c => c.toggleOrderedList()],
    ['Checklist', 'taskList', c => c.toggleTaskList()],
    ['Citaat', 'blockquote', c => c.toggleBlockquote()],
    ['Scheidingslijn', '', c => c.setHorizontalRule()],
    ['Tabel', '', c => c.insertTable({rows:3, cols:3, withHeaderRow:true})],
    ['Bestand uploaden', '', null, null, () => chooseFiles('')],
    ['Afbeelding', '', null, null, () => chooseFiles('image/*')],
    ['PDF', '', null, null, () => chooseFiles('application/pdf')],
    ['Video', '', null, null, () => chooseFiles('video/*')],
    ['Embed', '', null, null, () => embedDialog.showModal()],
  ];
  let slashRange = null, slashIndex = 0, filtered = [], dismissed = false;
  function run(command, slash = false) {
    let chain = editor.chain().focus();
    if (slash && slashRange) chain = chain.deleteRange(slashRange);
    if (command[4]) {chain.run(); command[4]();} else command[2](chain).run();
    menu.hidden = true;
  }
  function updateMenu() {
    const {$from, empty} = editor.state.selection;
    const text = $from.parent.textBetween(0, $from.parentOffset, '\n');
    const match = empty && $from.parent.isTextblock && text.match(/^\/([^\s/]*)$/);
    if (!match || dismissed) { menu.hidden = true; if (!match) dismissed = false; return; }
    slashRange = {from:$from.start(), to:$from.pos};
    filtered = commands.filter(c => c[0].toLowerCase().includes(match[1].toLowerCase()));
    if (slashIndex >= filtered.length) slashIndex = 0;
    menu.replaceChildren();
    filtered.forEach((command, i) => {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = command[0]; button.classList.toggle('is-active', i === slashIndex);
      button.addEventListener('mousedown', e => e.preventDefault());
      button.addEventListener('click', () => run(command, true)); menu.append(button);
    });
    menu.hidden = !filtered.length;
    if (!menu.hidden) {
      const rect = editor.view.coordsAtPos($from.pos), outer = element.parentElement.getBoundingClientRect();
      menu.style.top = `${rect.bottom - outer.top + 6}px`;
      menu.style.left = `${Math.max(0, Math.min(rect.left - outer.left, outer.width - 220))}px`;
    }
  }
  const editor = new Editor({
    element, injectCSS:false,
    extensions:[PageMedia, StarterKit.configure({underline:false, link:{openOnClick:false, autolink:true, defaultProtocol:'https'}}), TaskList, TaskItem.configure({nested:true, a11y:{checkboxLabel:node => node.textContent || 'Checklist-item'}}), TableKit, Markdown, Placeholder.configure({placeholder:'Schrijf iets, of typ / voor blokken…'})],
    content, contentType:'markdown',
    editorProps:{handlePaste(view, event) {
      const files = Array.from(event.clipboardData?.files || []);
      if (!files.length) return false; event.preventDefault(); uploadFiles(files); return true;
    }, handleDrop(view, event, slice, moved) {
      const files = Array.from(event.dataTransfer?.files || []);
      if (moved || !files.length) return false; event.preventDefault();
      const pos = view.posAtCoords({left:event.clientX, top:event.clientY})?.pos;
      if (typeof pos === 'number') editor.commands.setTextSelection(pos);
      uploadFiles(files); return true;
    }, attributes:{class:'family-prose', role:'textbox', 'aria-label':'Pagina-inhoud', 'aria-multiline':'true'}, handleKeyDown(view, event) {
      if (menu.hidden) return false;
      if (event.key === 'Escape') { dismissed = true; menu.hidden = true; return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length; updateMenu(); return true; }
      if (event.key === 'Enter' && filtered.length) { run(filtered[slashIndex], true); return true; }
      return false;
    }},
    onUpdate:() => { onChange(); updateMenu(); },
    onSelectionUpdate:() => { updateToolbar(); updateMenu(); },
    onBlur:() => { setTimeout(() => { if (!menu.contains(document.activeElement)) menu.hidden = true; }, 150); }
  });
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Bloktype');
  commands.forEach((c,i) => { const o = document.createElement('option'); o.value = i; o.textContent = c[0]; select.append(o); });
  select.addEventListener('change', () => run(commands[Number(select.value)])); toolbar.append(select);
  const buttons = [];
  function addButton(label, title, action, active) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', e => e.preventDefault()); b.addEventListener('click', action); toolbar.append(b);
    if (active) buttons.push([b,active]);
  }
  addButton('B', 'Vet (⌘/Ctrl+B)', () => editor.chain().focus().toggleBold().run(), 'bold');
  addButton('I', 'Cursief (⌘/Ctrl+I)', () => editor.chain().focus().toggleItalic().run(), 'italic');
  addButton('S̶', 'Doorhalen', () => editor.chain().focus().toggleStrike().run(), 'strike');
  addButton('☑', 'Checklist', () => editor.chain().focus().toggleTaskList().run(), 'taskList');
  addButton('↗', 'Link toevoegen of wijzigen', () => {
    const url = prompt('Link (https://…). Maak leeg om de link te verwijderen.', editor.getAttributes('link').href || 'https://');
    if (url === null) return;
    if (!url.trim()) { editor.chain().focus().extendMarkRange('link').unsetLink().run(); return; }
    try { const parsed = new URL(url); if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) throw new Error(); } catch { alert('Vul een geldige https://-, http://- of mailto:-link in.'); return; }
    editor.chain().focus().extendMarkRange('link').setLink({href:url}).run();
  }, 'link');
  addButton('＋ Bestand', 'Bestand uploaden', () => chooseFiles(''));
  addButton('▧', 'Afbeelding uploaden', () => chooseFiles('image/*'));
  addButton('▷', 'Video uploaden', () => chooseFiles('video/*'));
  addButton('Embed', 'Embed toevoegen', () => embedDialog.showModal());
  addButton('↶', 'Ongedaan maken', () => editor.chain().focus().undo().run());
  addButton('↷', 'Opnieuw', () => editor.chain().focus().redo().run());
  const tableTools = document.createElement('span'); tableTools.className = 'table-tools'; toolbar.append(tableTools);
  [['+ Rij','addRowAfter'],['− Rij','deleteRow'],['+ Kolom','addColumnAfter'],['− Kolom','deleteColumn'],['Verwijder tabel','deleteTable']].forEach(([label,cmd]) => {
    const b = document.createElement('button'); b.type='button'; b.textContent=label; b.addEventListener('mousedown',e=>e.preventDefault()); b.addEventListener('click',()=>editor.chain().focus()[cmd]().run()); tableTools.append(b);
  });
  function updateToolbar() {
    buttons.forEach(([b, mark]) => b.setAttribute('aria-pressed', String(editor.isActive(mark))));
    const current = commands.findIndex(c => c[1] && c[1] !== 'paragraph' && editor.isActive(c[1],c[3]));
    select.value = Math.max(0,current); tableTools.hidden = !editor.isActive('table');
  }
  const fileInput = document.createElement('input'); fileInput.type='file'; fileInput.multiple=true; fileInput.hidden=true;
  element.parentElement.append(fileInput);
  function chooseFiles(accept) { if (uploading) return; fileInput.accept=accept; fileInput.click(); }
  fileInput.addEventListener('change', () => {const files=Array.from(fileInput.files); fileInput.value=''; uploadFiles(files);});
  const progress = document.createElement('div'); progress.className='page-upload-progress'; progress.setAttribute('role','status'); progress.setAttribute('aria-live','polite'); progress.hidden=true;
  toolbar.after(progress);
  let uploading = false;
  editor.insertPageFiles = files => {
    const nodes = files.map(file=>normalizeMedia({...file,kind:'file'})).filter(Boolean).map(attrs=>({type:'pageMedia',attrs}));
    if (nodes.length) editor.chain().focus().insertContent([...nodes,{type:'paragraph'}]).run();
  };
  async function uploadFiles(files) {
    if (uploading || editor.isDestroyed || !files.length) return;
    uploading=true; onUploadState?.(true); progress.hidden=false;
    let position=editor.state.selection.from, uploaded=0;
    const errors=[];
    const track=({transaction})=>{position=transaction.mapping.map(position);};
    editor.on('transaction',track);
    try {
      for (let index=0; index<files.length; index++) {
        const file=files[index];
        progress.textContent=`${index+1}/${files.length} · ${file.name} uploaden…`;
        try {
          if (!file.size || file.size>100*1024*1024) throw new Error(`${file.name}: kies een niet-leeg bestand van maximaal 100 MB.`);
          const item=await onUploadFile(file, text=>{progress.textContent=`${index+1}/${files.length} · ${file.name} · ${text}`;});
          if (editor.isDestroyed) break;
          editor.chain().insertContentAt(position,[{type:'pageMedia',attrs:normalizeMedia({...item,kind:'file'})},{type:'paragraph'}]).run();
          uploaded++;
        } catch(error) {errors.push(error.message); onError?.(error.message);}
      }
      if (uploaded && !editor.isDestroyed) await onUploaded?.();
    } finally {
      editor.off('transaction',track); uploading=false; onUploadState?.(false); progress.hidden=!errors.length;
      if (errors.length) progress.textContent=errors.join(' ') + ' Kies het bestand opnieuw om het nogmaals te proberen.';
    }
  }
  editor.uploadPageFiles=uploadFiles;
  const embedDialog=document.createElement('dialog'); embedDialog.className='page-embed-dialog';
  embedDialog.innerHTML='<form><h2>Embed toevoegen</h2><label for="page-embed-url">Link naar de inhoud</label><input id="page-embed-url" type="url" placeholder="https://…" required><p>YouTube, Vimeo, Spotify, Google Documenten, Spreadsheets, Presentaties of een Google Maps-insluitlink.</p><p>Alleen de link wordt opgeslagen. De inhoud blijft bij de externe dienst.</p><p data-embed-error role="alert"></p><div><button type="button" data-embed-cancel>Annuleren</button><button type="submit">Invoegen</button></div></form>';
  element.parentElement.append(embedDialog);
  embedDialog.querySelector('[data-embed-cancel]').addEventListener('click',()=>embedDialog.close());
  embedDialog.querySelector('form').addEventListener('submit',event=>{
    event.preventDefault(); const input=embedDialog.querySelector('input'); const source=embedSource(input.value.trim());
    if (!source) {embedDialog.querySelector('[data-embed-error]').textContent='Deze link kan nog niet worden ingesloten. Gebruik een link van een genoemde dienst, of voeg hem toe als gewone link.';return;}
    editor.chain().focus().insertContent([{type:'pageMedia',attrs:normalizeMedia({kind:'embed',url:source})},{type:'paragraph'}]).run();
    input.value=''; embedDialog.querySelector('[data-embed-error]').textContent=''; embedDialog.close();
  });
  editor.on('destroy',()=>{fileInput.remove();progress.remove();embedDialog.remove();});
  updateToolbar();
  element.addEventListener('click', e => { const a=e.target.closest('a'); if (a && element.contains(a)) { e.preventDefault(); const url = new URL(a.href, location.href); if (['https:', 'http:', 'mailto:'].includes(url.protocol)) window.open(url.href,'_blank','noopener,noreferrer'); } });
  return editor;
};
