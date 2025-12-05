// main.js - 4-lane analyzer + BPM + onset + grid generator + player
// Keys: F G H J => lanes 0..3

// ---------- DOM ----------
const fileInput = document.getElementById("audioFile");
const analyzeBtn = document.getElementById("analyzeBtn");
const genNotesBtn = document.getElementById("genNotesBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const sensitivitySlider = document.getElementById("sensitivity");
const subdivSelect = document.getElementById("subdiv");
const bpmEl = document.getElementById("bpm");
const onsetCountEl = document.getElementById("onsetCount");
const notesOut = document.getElementById("notesOut");

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const lanes = 4;
const laneW = canvas.width / lanes;
const hitY = canvas.height - 120;
const noteSpeed = 360; // px/second

// ---------- Audio ----------
let audioCtx, audioBuffer;
let audioSource;
let analyser, fftSize = 2048;
let rawData; // Float32Array of PCM
let sampleRate = 44100;

// analysis results
let onsets = []; // seconds
let bpmEstimate = null;
let energyEnv = null;
let freqDataOverTime = []; // for frequency mapping (array of Float32Array per frame)

// generated notes (time seconds, lane 0..3)
let notes = [];

// player state
let startTime = 0;
let playing = false;
let pressed = [false,false,false,false];
let score = 0;
let combo = 0;
let idxNextNote = 0;

// ---------- helpers ----------
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}

// ---------- load file ----------
fileInput.addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ab = await file.arrayBuffer();
  audioBuffer = await audioCtx.decodeAudioData(ab);
  sampleRate = audioBuffer.sampleRate;
  alert(`Loaded: ${file.name} (${Math.round(audioBuffer.duration)}s, ${sampleRate}Hz)`);
});

// ---------- analyze: waveform, energy, onsets, BPM, freq frames ----------
analyzeBtn.addEventListener('click', async ()=>{
  if(!audioBuffer) return alert("先に曲を選んでください");
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // get mono PCM Float32
  const raw = audioBuffer.getChannelData(0);
  rawData = raw; // Float32Array

  // 1) compute short-time energy envelope
  const win = 1024;
  const step = 512;
  const env = [];
  for(let i=0;i<raw.length-win;i+=step){
    let sum = 0;
    for(let j=0;j<win;j++){ const s = raw[i+j]; sum += s*s; }
    env.push(Math.sqrt(sum/win));
  }
  energyEnv = env;

  // 2) onset detection: simple spectral flux-like using frame energy diff
  const diffs = [];
  for(let i=1;i<env.length;i++){
    diffs.push(Math.max(0, env[i]-env[i-1]));
  }
  // normalize
  let maxd = Math.max(...diffs);
  const norm = diffs.map(d=>d / (maxd||1));

  // threshold adaptive
  const sens = parseFloat(sensitivitySlider.value) || 1.5;
  const thresh = 0.18 / sens; // tweakable
  onsets = [];
  for(let i=0;i<norm.length;i++){
    if(norm[i] > thresh){
      // convert frame idx to seconds
      const sec = ((i+1)*step)/sampleRate;
      // avoid duplicates (keep 0.15s separation)
      if(onsets.length===0 || sec - onsets[onsets.length-1] > 0.12) onsets.push(sec);
    }
  }

  // 3) BPM estimate via autocorrelation of energy envelope
  bpmEstimate = estimateBPMFromEnv(env, sampleRate, step);
  bpmEl.textContent = bpmEstimate ? Math.round(bpmEstimate) : '—';
  onsetCountEl.textContent = onsets.length;

  // 4) frequency frames (spectrum) for mapping to lanes
  // create offline analyser by splitting into frames and doing FFT using AnalyserNode is browser-realtime; we'll compute using offline FFT approximated via Analyser
  // Simpler: create real-time analyser by making an AudioBufferSource into an OfflineAudioContext for fast FFT frames.
  freqDataOverTime = await computeSpectralFrames(audioBuffer, fftSize, step);

  // show some debug
  notesOut.textContent = JSON.stringify({bpm:bpmEstimate, onsets:onsets.slice(0,50)}, null, 2);

  alert('解析完了');
});

// ---------- generate notes ----------
genNotesBtn.addEventListener('click', ()=>{
  if(!audioBuffer) return alert("先に曲を選んで解析してね (Analyze)");
  // two contributions:
  //  A) onsets -> candidate times + frequency mapping -> lane
  //  B) grid snapping using BPM and subdivision
  const subdiv = parseInt(subdivSelect.value);
  const grid = buildBeatGrid(bpmEstimate || 120, subdiv, audioBuffer.duration);
  // map each onset to nearest grid time
  const snapWindow = (60/(bpmEstimate||120))/ (subdiv/4) / 2; // half subdivision length
  const candidates = [];

  // use freqDataOverTime to map frequency content at onset to lane
  for(const t of onsets){
    // map to nearest grid
    let nearest = null;
    let mind = 999;
    for(const g of grid){
      const d = Math.abs(g - t);
      if(d < mind){ mind = d; nearest = g; }
    }
    if(mind > snapWindow) continue; // skip if too far
    // determine lane: analyze spectrum near t
    const lane = freqToLane(t);
    candidates.push({time: nearest, lane});
  }

  // optionally fill with some grid-based filler to avoid empty parts
  // we will keep unique times per lane once (merge duplicates)
  const merged = {};
  for(const c of candidates){
    const key = `${c.time.toFixed(3)}|${c.lane}`;
    merged[key] = c;
  }
  notes = Object.values(merged).sort((a,b)=>a.time-b.time);

  // debug show up to first 200 notes
  notesOut.textContent = JSON.stringify(notes.slice(0,200), null, 2);
  alert(`譜面生成: ${notes.length} ノーツ`);
});

// ---------- play / stop ----------
startBtn.addEventListener('click', async ()=>{
  if(!audioBuffer) return alert("曲を読み込んで解析・生成してね");
  if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // stop previous
  if(audioSource){ try{ audioSource.stop(); }catch(e){} }

  audioSource = audioCtx.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.connect(audioCtx.destination);
  startTime = audioCtx.currentTime + 0.15; // slight delay to schedule
  audioSource.start(startTime);
  playing = true;
  score = 0; combo = 0; idxNextNote = 0;
  requestAnimationFrame(loop);
});

stopBtn.addEventListener('click', ()=>{
  if(audioSource) try{ audioSource.stop(); }catch(e){}
  playing = false;
});

// ---------- key handling ----------
const keyMap = {'f':0,'g':1,'h':2,'j':3};
document.addEventListener('keydown', (e)=>{
  const k = e.key.toLowerCase();
  if(keyMap[k] !== undefined){
    if(!pressed[keyMap[k]]) handleHit(keyMap[k]);
    pressed[keyMap[k]] = true;
  }
});
document.addEventListener('keyup', (e)=>{
  const k = e.key.toLowerCase();
  if(keyMap[k] !== undefined) pressed[keyMap[k]] = false;
});

// ---------- hit logic ----------
function handleHit(lane){
  // find earliest note in lane that is not judged
  const now = audioCtx.currentTime - startTime;
  // scoring windows (s)
  const perfect = 0.08;
  const good = 0.18;
  const missWindow = 0.30;

  // find note close to now
  let bestIdx = -1, bestDiff = 999;
  for(let i=idxNextNote;i<notes.length;i++){
    const n = notes[i];
    if(n.lane !== lane) continue;
    const d = Math.abs(n.time - now);
    if(d < bestDiff){
      bestDiff = d; bestIdx = i;
    }
    // if note time is far in future (>missWindow) break optimization
    if(n.time - now > missWindow) break;
  }
  if(bestIdx === -1) { combo = 0; return; }
  const n = notes[bestIdx];
  if(Math.abs(n.time - now) <= perfect){
    score += 1000; combo += 1; // perfect
    notes.splice(bestIdx,1);
  }else if(Math.abs(n.time - now) <= good){
    score += 500; combo += 1; notes.splice(bestIdx,1);
  }else{
    // too late/early
    combo = 0;
  }
}

// ---------- main visual loop ----------
function loop(){
  // clear
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // draw lanes
  for(let i=0;i<lanes;i++){
    const x = i*laneW;
    ctx.fillStyle = '#0b1b20';
    ctx.fillRect(x,0,laneW,canvas.height);
    ctx.fillStyle = '#08303a';
    ctx.fillRect(x+4,0,laneW-8,canvas.height-120);
    ctx.fillStyle = '#0f7f99';
    ctx.fillRect(x+6,hitY-10,laneW-12,10);
    ctx.fillStyle = pressed[i] ? '#36f3ff' : '#2a9db7';
