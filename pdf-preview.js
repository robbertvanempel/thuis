import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
GlobalWorkerOptions.workerSrc = '/assets/pdf-worker.mjs?v=6.3.289';

// Render PDF pages locally; no document is sent to an external preview service.
export function createPdfPreview(url, filename) {
  const dom=document.createElement('div'); dom.className='page-pdf';
  const controls=document.createElement('div'); controls.className='page-pdf-controls';
  const previous=document.createElement('button'), next=document.createElement('button'), status=document.createElement('span');
  previous.type=next.type='button'; previous.textContent='‹'; next.textContent='›';
  previous.setAttribute('aria-label','Vorige PDF-pagina'); next.setAttribute('aria-label','Volgende PDF-pagina');
  status.setAttribute('role','status'); status.textContent='PDF laden…'; controls.append(previous,status,next);
  const canvas=document.createElement('canvas'); canvas.setAttribute('role','img'); canvas.setAttribute('aria-label',`PDF-voorbeeld: ${filename}`);
  dom.append(controls,canvas);
  let documentTask, renderTask, pdf, pageNumber=1, busy=false, destroyed=false;
  previous.disabled=next.disabled=true;
  async function render() {
    if (destroyed || busy) return;
    busy=true; previous.disabled=next.disabled=true;
    try {
      status.textContent=`Pagina ${pageNumber} van ${pdf.numPages}`;
      const page=await pdf.getPage(pageNumber);
      if (destroyed) return;
      const base=page.getViewport({scale:1}), viewport=page.getViewport({scale:Math.min(2,1100/base.width)});
      canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
      renderTask=page.render({canvas,viewport}); await renderTask.promise;
    } catch(error) {
      if (!destroyed) {status.textContent='Voorbeeld niet beschikbaar. Gebruik Openen of Downloaden.';canvas.hidden=true;}
    } finally {
      busy=false; previous.disabled=pageNumber<=1;next.disabled=pageNumber>=pdf.numPages;
    }
  }
  previous.addEventListener('click',()=>{if(pageNumber>1&&!busy){pageNumber--;render();}});
  next.addEventListener('click',()=>{if(pdf&&pageNumber<pdf.numPages&&!busy){pageNumber++;render();}});
  const start=async()=>{
    if(destroyed||documentTask) return;
    try {
      documentTask=getDocument({url,withCredentials:true,cMapUrl:'/assets/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/pdfjs/standard_fonts/',useWasm:false,disableFontFace:true,isEvalSupported:false});
      pdf=await documentTask.promise;
      if(!destroyed) await render();
    } catch(error) {
      if(!destroyed){status.textContent=error.name==='PasswordException' ? 'Deze PDF is beveiligd. Open of download het bestand om het wachtwoord in te voeren.' : 'Voorbeeld niet beschikbaar. Gebruik Openen of Downloaden.';canvas.hidden=true;}
    }
  };
  const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();start();}},{rootMargin:'300px'});
  observer.observe(dom);
  return {dom,destroy(){destroyed=true;observer.disconnect();renderTask?.cancel();documentTask?.destroy().catch(()=>{});}};
}
