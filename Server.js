// ReelCraft AI v2: real AI pipeline. All API keys live in environment variables on the server only.
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const E = process.env, DIR = '/tmp/rc', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await fs.mkdir(DIR, { recursive: true });
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use('/files', express.static(DIR));
app.get('/', (_q, r) => r.sendFile(path.resolve('index.html')));

app.use('/api', (q, r, n) => {
  if (!E.APP_PASSWORD) return r.status(500).json({ error: 'APP_PASSWORD is not set on the server.' });
  if (q.get('x-app-key') !== E.APP_PASSWORD) return r.status(401).json({ error: 'Wrong app password.' });
  n();
});
app.get('/api/health', (_q, r) => r.json({ story: !!E.GEMINI_API_KEY, fal: !!E.FAL_KEY, voice: !!E.ELEVENLABS_API_KEY, audio: E.AUDIO_MODE || 'synth' }));

/* ---------- jobs (long tasks; the phone polls) ---------- */
const jobs = new Map();
function startJob(fn) {
  const id = crypto.randomUUID(), j = { status: 'running', log: [] };
  jobs.set(id, j);
  fn((m) => j.log.push(m)).then((r) => { j.status = 'done'; j.result = r; }, (e) => { j.status = 'error'; j.error = String(e.message || e); });
  return id;
}
const job = (fn) => (q, r) => r.json({ job: startJob((log) => fn(q.body, log)) });
app.get('/api/jobs/:id', (q, r) => (jobs.get(q.params.id) ? r.json(jobs.get(q.params.id)) : r.status(404).json({ error: 'Job not found (server restarted?). Try again.' })));

/* ---------- story (Gemini) ---------- */
const STY = {
  cartoon: '2D cartoon animation, flat colors, bold clean outlines, hand-drawn look',
  pixar: '3D Pixar-style animated film, soft lighting, expressive big eyes, stylized characters',
  real: 'realistic 3D CGI animation, detailed textures, natural cinematic lighting',
  doc: 'cinematic documentary animation, muted palette, shallow depth of field, film grain',
  cute: 'cute kawaii character animation, pastel colors, rounded shapes, soft glow',
  dark: 'dark mystery animation, low-key lighting, drifting fog, deep shadows, teal and amber palette'
};
const PLAN = { 30: [5, 5, 5, 5, 5, 5], 45: [5, 10, 5, 5, 10, 5, 5], 60: [5, 10, 5, 10, 5, 10, 5, 10] };

app.post('/api/story', async (q, r) => {
  try {
    if (!E.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server.');
    const { topic, style, duration, language = 'English' } = q.body, plan = PLAN[duration] || PLAN[45];
    const prompt = `You are an award-winning animation director writing a vertical short (Instagram Reel). Topic: "${topic}".
Visual style: ${STY[style]}. Write an ORIGINAL story with a hook in scene 1, a clear arc and a satisfying ending.
Exactly ${plan.length} scenes with these durations in seconds, in order: ${plan.join(', ')}.
Narration language: ${language}. Narration length: max 11 words for a 5s scene, max 24 words for a 10s scene. All other fields in English.
Return ONLY JSON: {"title":"","characterBible":"one fixed, very specific description of the single main character: species/age, face, hair, exact clothes and colors, proportions","environmentBible":"fixed look of the main location, palette, time of day","musicPrompt":"mood, tempo, instruments, no vocals","scenes":[{"title":"","narration":"","visualPrompt":"what we SEE: the character's pose/action, expression and framing in this moment (do not redescribe clothes)","motionPrompt":"how things move: character action, camera movement, background animation, lighting change","sfx":""}]}`;
    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${E.GEMINI_MODEL || 'gemini-flash-latest'}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': E.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } })
    });
    const j = await g.json();
    if (!g.ok) throw new Error(j.error?.message || 'Gemini request failed');
    const s = JSON.parse(j.candidates[0].content.parts.map((p) => p.text || '').join('').match(/\{[\s\S]*\}/)[0]);
    s.scenes = s.scenes.slice(0, plan.length).map((x, i) => ({ ...x, duration: plan[i] }));
    r.json({ ...s, topic, style, styleDesc: STY[style] });
  } catch (e) { r.status(500).json({ error: e.message }); }
});

/* ---------- fal.ai (images + video) ---------- */
async function fal(model, input) {
  if (!E.FAL_KEY) throw new Error('FAL_KEY is not set on the server.');
  const H = { Authorization: `Key ${E.FAL_KEY}`, 'Content-Type': 'application/json' };
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: H, body: JSON.stringify(input) });
  const j = await sub.json();
  if (!sub.ok) throw new Error('fal: ' + JSON.stringify(j.detail || j).slice(0, 300));
  for (;;) {
    await sleep(3000);
    const s = await (await fetch(j.status_url, { headers: H })).json();
    if (s.status === 'COMPLETED') break;
    if (s.status !== 'IN_QUEUE' && s.status !== 'IN_PROGRESS') throw new Error('fal: ' + JSON.stringify(s).slice(0, 200));
  }
  const out = await (await fetch(j.response_url, { headers: H })).json();
  const url = out.images?.[0]?.url || out.video?.url;
  if (!url) throw new Error('fal returned no media: ' + JSON.stringify(out).slice(0, 250));
  return url;
}
app.post('/api/job/image', job(({ prompt }) => fal(E.FAL_IMAGE_MODEL || 'fal-ai/flux/dev', { prompt, image_size: 'portrait_16_9', num_images: 1 })));
app.post('/api/job/keyframe', job(({ prompt, imageUrl }) => fal(E.FAL_EDIT_MODEL || 'fal-ai/flux-pro/kontext', { prompt, image_url: imageUrl, aspect_ratio: '9:16', output_format: 'jpeg' })));
app.post('/api/job/clip', job(({ prompt, imageUrl, duration }) => fal(E.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v2.1/standard/image-to-video', {
  prompt, image_url: imageUrl, duration: String(duration >= 8 ? 10 : 5), negative_prompt: 'text, subtitles, watermark, blur, distortion, extra limbs', ...JSON.parse(E.FAL_VIDEO_EXTRA || '{}')
})));

/* ---------- voice (ElevenLabs) ---------- */
const XI = () => ({ 'xi-api-key': E.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' });
app.post('/api/job/voice', job(async ({ text }) => {
  if (!E.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set on the server.');
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${E.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'}?output_format=mp3_44100_128`, {
    method: 'POST', headers: XI(), body: JSON.stringify({ text, model_id: E.ELEVENLABS_MODEL || 'eleven_multilingual_v2' })
  });
  if (!r.ok) throw new Error('ElevenLabs: ' + (await r.text()).slice(0, 250));
  return 'data:audio/mpeg;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
}));

/* ---------- final video (ffmpeg) ---------- */
const run = (c, a) => new Promise((ok, no) => {
  const p = spawn(c, a); let o = '', e = '';
  p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e = (e + d).slice(-1500)));
  p.on('close', (k) => (k ? no(new Error(`${c} failed: ${e}`)) : ok(o)));
});
const dur = async (f) => parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]));
async function save(src, f) {
  if (src.startsWith('data:')) return fs.writeFile(f, Buffer.from(src.split(',')[1], 'base64'));
  const r = await fetch(src);
  if (!r.ok) throw new Error('Could not download a clip (link may have expired). Regenerate that scene.');
  await fs.writeFile(f, Buffer.from(await r.arrayBuffer()));
}
async function aiAudio(url, body, file, log, what) {
  if (E.AUDIO_MODE !== 'elevenlabs' || !E.ELEVENLABS_API_KEY) return false;
  try {
    const r = await fetch(url, { method: 'POST', headers: XI(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()).slice(0, 150));
    await fs.writeFile(file, Buffer.from(await r.arrayBuffer())); log(`AI ${what} ready`); return true;
  } catch (e) { log(`AI ${what} failed (${e.message}); using built-in sound`); return false; }
}

app.post('/api/job/final', job(async ({ scenes, musicPrompt }, log) => {
  const id = crypto.randomUUID().slice(0, 8), W = path.join(DIR, id);
  await fs.mkdir(W);
  const parts = [], cuts = []; let t = 0;
  for (const [i, s] of scenes.entries()) {
    if (!s.clipUrl) throw new Error(`Scene ${i + 1} has no video clip yet.`);
    log(`Preparing scene ${i + 1} of ${scenes.length}`);
    const v = `${W}/c${i}.mp4`, o = `${W}/s${i}.mp4`;
    await save(s.clipUrl, v);
    const d = await dur(v), f = (d - 0.3).toFixed(2), args = ['-y', '-i', v];
    let af;
    if (s.voiceUrl) {
      const a = `${W}/v${i}.mp3`; await save(s.voiceUrl, a);
      const tempo = Math.min(1.3, Math.max(1, (await dur(a)) / (d - 0.6)));
      args.push('-i', a); af = `[1:a]atempo=${tempo.toFixed(3)},adelay=350|350,apad,atrim=0:${d},`;
    } else { args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'); af = `[1:a]atrim=0:${d},`; }
    args.push('-filter_complex',
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,fade=t=in:d=0.3,fade=t=out:st=${f}:d=0.3,format=yuv420p[v];${af}aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:d=0.15,afade=t=out:st=${f}:d=0.3[a]`,
      '-map', '[v]', '-map', '[a]', '-t', String(d), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-c:a', 'aac', '-b:a', '160k', o);
    await run('ffmpeg', args);
    parts.push(o); t += d; cuts.push(t);
  }
  log('Joining scenes');
  await fs.writeFile(`${W}/list.txt`, parts.map((p) => `file '${p}'`).join('\n'));
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', `${W}/list.txt`, '-c', 'copy', `${W}/joined.mp4`]);

  log('Making music and sound effects');
  const music = `${W}/music.mp3`, sfx = `${W}/sfx.mp3`, L = Math.ceil(t) + 2;
  if (!(await aiAudio('https://api.elevenlabs.io/v1/music', { prompt: musicPrompt || 'gentle cinematic background music, no vocals', music_length_ms: Math.min(300000, L * 1000) }, music, log, 'music')))
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `aevalsrc=0.30*sin(2*PI*220*t)+0.22*sin(2*PI*277.18*t)+0.22*sin(2*PI*329.63*t)+0.12*sin(2*PI*110*t):d=${L}:s=44100`, '-af', 'tremolo=f=0.25:d=0.5,lowpass=f=1800', music]);
  const cu = cuts.slice(0, -1), n = cu.length;
  if (n && !(await aiAudio('https://api.elevenlabs.io/v1/sound-generation', { text: 'smooth cinematic whoosh transition', duration_seconds: 1.5 }, sfx, log, 'sound effect')))
    await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anoisesrc=d=0.8:c=pink:r=44100,highpass=f=250,lowpass=f=3500,afade=t=in:d=0.3,afade=t=out:st=0.3:d=0.5,volume=0.8', sfx]);

  log('Mixing voice, music and effects');
  let fc = `[1:a]volume=0.16,afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, t - 2).toFixed(1)}:d=2,apad[m];`, mix = '[0:a][m]';
  if (n) {
    fc += `[2:a]volume=0.5,asplit=${n}${cu.map((_, i) => `[x${i}]`).join('')};`;
    fc += cu.map((c, i) => { const ms = Math.round((c - 0.25) * 1000); return `[x${i}]adelay=${ms}|${ms},apad[d${i}];`; }).join('');
    mix += cu.map((_, i) => `[d${i}]`).join('');
  }
  fc += `${mix}amix=inputs=${2 + n}:duration=first:dropout_transition=0,volume=${2 + n}[a]`;
  await run('ffmpeg', ['-y', '-i', `${W}/joined.mp4`, '-i', music, ...(n ? ['-i', sfx] : []), '-filter_complex', fc, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', `${W}/reel.mp4`]);
  for (const f of await fs.readdir(W)) if (f !== 'reel.mp4') await fs.rm(path.join(W, f));
  return `/files/${id}/reel.mp4`;
}));

app.listen(E.PORT || 10000, () => console.log('ReelCraft AI running'));
