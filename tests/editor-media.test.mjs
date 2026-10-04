import test from 'node:test';
import {getSchema} from '@tiptap/core';
import assert from 'node:assert/strict';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { PageMedia, embedSource, normalizeMedia } from '../editor-media.js';

const manager = new MarkdownManager({extensions:[PageMedia,StarterKit,TaskList,TaskItem,TableKit]});
test('uploaded media and embeds survive Markdown round trips alongside existing text',()=>{
  const files=['image/png','application/pdf','application/octet-stream','video/mp4'].map((media_type,index)=>normalizeMedia({id:String(index).repeat(32),filename:'Vakantie [ideeën] ` test.docx',media_type,size:190}));
  files.push(normalizeMedia({kind:'embed',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}));
  const body='# Titel\n\n**Tekst** erboven.\n\n'+files.map(attrs=>'```thuis-media\n'+JSON.stringify(attrs)+'\n```').join('\n\n')+'\n\n- [ ] Inpakken\n\n```js\nconst answer = 42;\n```\n\nTekst eronder.';
  const parsed=manager.parse(body);
  assert.equal(parsed.content.filter(node=>node.type==='pageMedia').length,5);
  assert.equal(parsed.content.filter(node=>node.type==='codeBlock').length,1);
  const saved=manager.serialize(parsed);
  assert.deepEqual(manager.parse(saved),parsed);
  assert.match(saved,/Tekst eronder/);
  assert.match(saved,/- \[ \] Inpakken/);
});
test('unsafe URLs and malformed media remain non-executable',()=>{
  for(const url of ['javascript:alert(1)','http://youtube.com/watch?v=dQw4w9WgXcQ','https://evil.example/embed','https://docs.google.com.evil.test/document/d/abc','https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ','https://www.google.com/search?q=test','https://family.example/api/files/abc']) assert.equal(embedSource(url),null,url);
  assert.equal(normalizeMedia({id:'../../private'}),null);
  assert.equal(normalizeMedia({id:'a'.repeat(32),media_type:'text/html'}).media_type,'application/octet-stream');
  assert.equal(manager.parse('```thuis-media\n{"kind":"embed","url":"javascript:alert(1)"}\n```').content[0].type,'codeBlock');
});
test('supported embed links canonicalize without losing their destination',()=>{
  for(const [url,result] of [
    ['https://youtu.be/dQw4w9WgXcQ','https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://vimeo.com/123456','https://player.vimeo.com/video/123456'],
    ['https://open.spotify.com/track/123abc','https://open.spotify.com/embed/track/123abc'],
    ['https://docs.google.com/document/d/abc_123/edit?usp=sharing','https://docs.google.com/document/d/abc_123/preview'],
    ['https://docs.google.com/presentation/d/abc_123/edit','https://docs.google.com/presentation/d/abc_123/embed'],
  ]) {assert.equal(embedSource(url),result);assert.equal(embedSource(result),result);}
});

test('empty pages and new paragraphs never become empty media blocks',()=>{
  assert.equal(getSchema([PageMedia,StarterKit]).topNodeType.createAndFill().firstChild.type.name,'paragraph');
});
