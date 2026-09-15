import puppeteer from 'puppeteer-core';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const html = `<!doctype html><html><body><canvas id=c width=400 height=300></canvas>
<script>
const gl = document.getElementById('c').getContext('webgl2', {antialias:false});
let info = {ok: !!gl};
if (gl) {
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  info.renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  info.vendor = d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  info.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  info.instanced = !!gl.drawArraysInstanced;
  gl.clearColor(0.9,0.2,0.1,1); gl.clear(gl.COLOR_BUFFER_BIT);
}
window.__info = info;
</script></body></html>`;

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({width:400,height:300});
await page.setContent(html, {waitUntil:'load'});
const info = await page.evaluate(()=>window.__info);
console.log(JSON.stringify(info,null,2));
await page.screenshot({path:'docs/shots/_glcheck.png'});
await browser.close();
