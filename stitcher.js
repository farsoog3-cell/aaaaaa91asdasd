function log(msg){ 
    const el=document.getElementById('log'); 
    el.textContent += '['+new Date().toLocaleTimeString()+'] '+msg + "\n"; 
    el.scrollTop = el.scrollHeight; 
}

function forceDownload(blob,name){ 
    const url=URL.createObjectURL(blob); 
    const a=document.createElement('a'); 
    a.href=url; 
    a.download=name; 
    document.body.appendChild(a); 
    a.click(); 
    a.remove(); 
    setTimeout(()=>URL.revokeObjectURL(url),2000); 
}

function makeWorkerFromFunc(fn){ 
    const src = fn.toString(); 
    const blob=new Blob(['('+src+')()'],{type:'application/javascript'}); 
    return new Worker(URL.createObjectURL(blob)); 
}

/* Worker: produce monochrome (B/W) cell grid and X-stitches per dark cell, export same pattern */
const worker = makeWorkerFromFunc(function(){
    function buildDstBytes(points, exportScale, label){
        const header = new Uint8Array(512);
        const name = ('LA:'+label+'\n').slice(0,80);
        for(let i=0;i<name.length;i++) header[i] = name.charCodeAt(i);
        const body = [];
        let prevx = 0, prevy = 0;
        function toCoord(px){ return Math.round(px * exportScale); }
        for(const p of points){
            const x = toCoord(p[0]), y = toCoord(p[1]);
            let dx = x - prevx, dy = y - prevy;
            while(Math.abs(dx) > 127 || Math.abs(dy) > 127){
                const sx = Math.max(-127, Math.min(127, dx));
                const sy = Math.max(-127, Math.min(127, dy));
                body.push((sx & 0xFF), (sy & 0xFF), 0x01); // jump/chunk
                dx -= sx; dy -= sy; prevx += sx; prevy += sy;
            }
            body.push((dx & 0xFF), (dy & 0xFF), 0x03); // normal stitch
            prevx = x; prevy = y;
        }
        body.push(0x00,0x00,0xF3);
        const arr = new Uint8Array(512 + body.length);
        arr.set(header,0); 
        arr.set(new Uint8Array(body),512);
        return arr;
    }

    onmessage = async (ev) => {
        const {dataURL, cellSize, bwThreshold, stitchStep, exportScale} = ev.data;
        try{
            const imgBlob = await (await fetch(dataURL)).blob();
            const img = await createImageBitmap(imgBlob);
            const cell = Math.max(4, Math.min(48, Number(cellSize)||8));
            const gridW = Math.max(1, Math.floor(img.width / cell));
            const gridH = Math.max(1, Math.floor(img.height / cell));
            const w = gridW * cell, h = gridH * cell;
            const off = new OffscreenCanvas(w,h);
            const ctx = off.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);

            const id = ctx.getImageData(0,0,w,h);
            const d = id.data;
            const cells = [];
            for(let gy=0; gy<gridH; gy++){
                const row = [];
                for(let gx=0; gx<gridW; gx++){
                    let sr=0, sg=0, sb=0, cnt=0;
                    for(let yy=gy*cell; yy<(gy+1)*cell; yy++){
                        for(let xx=gx*cell; xx<(gx+1)*cell; xx++){
                            const i = (yy*w + xx)*4;
                            sr += d[i]; sg += d[i+1]; sb += d[i+2]; cnt++;
                        }
                    }
                    const lum = Math.round((0.299*(sr/cnt) + 0.587*(sg/cnt) + 0.114*(sb/cnt)));
                    const black = lum < (bwThreshold|0) ? 1 : 0;
                    row.push({lum, black});
                }
                cells.push(row);
            }

            const step = Math.max(1, Math.min(16, Number(stitchStep)||4));
            const stitchPoints = [];
            for(let gy=0; gy<gridH; gy++){
                for(let gx=0; gx<gridW; gx++){
                    if(!cells[gy][gx].black) continue;
                    const x0 = gx*cell, y0 = gy*cell;
                    const x1 = x0 + cell, y1 = y0 + cell;
                    // diagonal 1
                    const dx = x1 - x0, dy = y1 - y0;
                    const L = Math.hypot(dx,dy);
                    const n = Math.max(1, Math.ceil(L/step));
                    for(let i=0;i<=n;i++){
                        const t = i/n;
                        stitchPoints.push([x0 + dx*t, y0 + dy*t]);
                    }
                    // diagonal 2
                    const dx2 = x0 - x1, dy2 = y1 - y0;
                    const L2 = Math.hypot(dx2,dy2);
                    const n2 = Math.max(1, Math.ceil(L2/step));
                    for(let i=0;i<=n2;i++){
                        const t = i/n2;
                        stitchPoints.push([x1 + dx2*t, y0 + dy2*t]);
                    }
                }
            }

            if(stitchPoints.length < 2){
                stitchPoints.push([0,0],[10,10]);
            }

            const merged = [];
            for(const p of stitchPoints){
                if(merged.length===0) merged.push(p);
                else {
                    const last = merged[merged.length-1];
                    if(Math.hypot(last[0]-p[0], last[1]-p[1]) >= 0.8) merged.push(p);
                }
            }

            const dstArr = buildDstBytes(merged, Number(exportScale)||0.2, 'MOLFA_DST');
            const dteArr = buildDstBytes(merged, Number(exportScale)||0.2, 'MOLFA_DTE');
            const dseArr = buildDstBytes(merged, Number(exportScale)||0.2, 'MOLFA_DSE');

            const bwCanvas = new OffscreenCanvas(w,h);
            const bwCtx = bwCanvas.getContext('2d');
            bwCtx.fillStyle = 'white'; bwCtx.fillRect(0,0,w,h);
            const bwImgData = bwCtx.getImageData(0,0,w,h);
            const bwD = bwImgData.data;
            for(let gy=0; gy<gridH; gy++){
                for(let gx=0; gx<gridW; gx++){
                    const blk = cells[gy][gx].black;
                    for(let yy=gy*cell; yy<(gy+1)*cell; yy++){
                        for(let xx=gx*cell; xx<(gx+1)*cell; xx++){
                            const idx = (yy*w + xx)*4;
                            const v = blk ? 0 : 255;
                            bwD[idx] = v; bwD[idx+1] = v; bwD[idx+2] = v; bwD[idx+3] = 255;
                        }
                    }
                }
            }
            bwCtx.putImageData(bwImgData,0,0);
            const bwDataURL = bwCanvas.convertToBlob ? await bwCanvas.convertToBlob({type:'image/png'}) : null;
            let bwDataURLstring = '';
            if(bwDataURL){
                const r = new FileReader();
                const d = await new Promise((res,rej)=>{
                    r.onload = ()=> res(r.result);
                    r.onerror = rej;
                    r.readAsDataURL(bwDataURL);
                });
                bwDataURLstring = d;
            }

            let svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>`;
            if(bwDataURLstring) svg += `<image href='${bwDataURLstring}' x='0' y='0' width='${w}' height='${h}' preserveAspectRatio='xMidYMid slice' ></image>`;
            else svg += `<rect width='100%' height='100%' fill='white'></rect>`;
            svg += `<g stroke='black' stroke-width='1' stroke-linecap='round'>`;
            if(merged.length){
                svg += `<polyline fill='none' points='${merged.map(p=>p[0]+','+p[1]).join(' ')}'/>`;
            }
            svg += `</g></svg>`;

            const pngCanvas = new OffscreenCanvas(w,h);
            const pngCtx = pngCanvas.getContext('2d');
            pngCtx.fillStyle='white'; pngCtx.fillRect(0,0,w,h);
            pngCtx.fillStyle='black';
            for(let gy=0; gy<gridH; gy++){
                for(let gx=0; gx<gridW; gx++){
                    if(cells[gy][gx].black){
                        pngCtx.fillRect(gx*cell, gy*cell, cell, cell);
                    }
                }
            }
            pngCtx.strokeStyle='black';
            pngCtx.lineWidth = Math.max(1, Math.round(cell/6));
            for(let gy=0; gy<gridH; gy++){
                for(let gx=0; gx<gridW; gx++){
                    if(!cells[gy][gx].black) continue;
                    const x0 = gx*cell + 1, y0 = gy*cell + 1;
                    const x1 = x0 + cell - 2, y1 = y0 + cell - 2;
                    pngCtx.beginPath(); pngCtx.moveTo(x0,y0); pngCtx.lineTo(x1,y1); pngCtx.stroke();
                    pngCtx.beginPath(); pngCtx.moveTo(x1,y0); pngCtx.lineTo(x0,y1); pngCtx.stroke();
                }
            }
            const pngBlob = await pngCanvas.convertToBlob({type:'image/png', quality:0.9});

            postMessage({ svg, dst: dstArr.buffer, dte: dteArr.buffer, dse: dseArr.buffer, png: pngBlob, notes: {cells: gridW*gridH, stitches: merged.length} }, [dstArr.buffer, dteArr.buffer, dseArr.buffer]);

        }catch(err){
            postMessage({ error: (err && err.message) ? err.message : String(err) });
        }
    };
});

const fileInput = document.getElementById('file');
const btn = document.getElementById('process');
const preview = document.getElementById('svgPreview');
const dlSvg = document.getElementById('downloadSvg');
const dlDst = document.getElementById('downloadDst');
const dlDte = document.getElementById('downloadDte');
const dlDse = document.getElementById('downloadDse');
const dlPng = document.getElementById('downloadPng');
const cellSizeInput = document.getElementById('cellSize');
const bwThresholdInput = document.getElementById('bwThreshold');
const stitchStepInput = document.getElementById('stitchStep');
const exportScaleInput = document.getElementById('exportScale');

let lastSvg, lastDst, lastDte, lastDse, lastPng;

worker.onmessage = (ev) => {
    if(ev.data && ev.data.type === 'log'){ log('[worker] ' + ev.data.msg); return; }
    if(ev.data.error){ log('خطأ: '+ev.data.error); return; }
    log('تمت المعالجة — خلايا: ' + (ev.data.notes && ev.data.notes.cells) + ', نقاط: ' + (ev.data.notes && ev.data.notes.stitches));
    lastSvg = new Blob([ev.data.svg], {type:'image/svg+xml'});
    lastDst = new Blob([ev.data.dst], {type:'application/octet-stream'});
    lastDte = new Blob([ev.data.dte], {type:'application/octet-stream'});
    lastDse = new Blob([ev.data.dse], {type:'application/octet-stream'});
    lastPng = ev.data.png;

    const url = URL.createObjectURL(lastSvg);
    preview.innerHTML = `<object type="image/svg+xml" data="${url}" style="width:100%;height:100%"></object>`;

    dlSvg.classList.remove('hidden');
    dlDst.classList.remove('hidden');
    dlDte.classList.remove('hidden');
    dlDse.classList.remove('hidden');
    dlPng.classList.remove('hidden');

    dlSvg.onclick = ()=> forceDownload(lastSvg, 'molfa_bw_stitch.svg');
    dlDst.onclick = ()=> forceDownload(lastDst, 'molfa_bw_stitch.dst');
    dlDte.onclick = ()=> forceDownload(lastDte, 'molfa_bw_stitch.dte');
    dlDse.onclick = ()=> forceDownload(lastDse, 'molfa_bw_stitch.dse');
    dlPng.onclick = ()=> forceDownload(lastPng, 'molfa_bw_stitch.png');
};

btn.addEventListener('click', () => {
    const f = fileInput.files[0];
    if(!f){ alert('اختر صورة'); return; }
    const reader = new FileReader();
    reader.onload = () => {
        worker.postMessage({
            dataURL: reader.result,
            cellSize: Number(cellSizeInput.value||8),
            bwThreshold: Number(bwThresholdInput.value||128),
            stitchStep: Number(stitchStepInput.value||4),
            exportScale: Number(exportScaleInput.value||0.2)
        });
        log('إرسال الصورة للعامل للمعالجة...');
    };
    reader.readAsDataURL(f);
});