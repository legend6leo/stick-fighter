'use strict';
// ============ 火柴人格斗 Stick Fighter v5.1 ============
// 布局(死神vs火影式): A/D移动 W上 S防御/下 K跳 J普攻(三段连) I必杀(耗气) O大招 L冲刺
// v5: 受击替身 / 手机触控 / 暂停与重开 / 四地图单向平台 / 觉醒与反弹系统
const cvs = document.getElementById('c');
const ctx = cvs.getContext('2d');
const pauseToggle = document.getElementById('pause-toggle');
const pauseOverlay = document.getElementById('pause-overlay');
const pauseResume = document.getElementById('pause-resume');
const pauseRestart = document.getElementById('pause-restart');
const pauseSelect = document.getElementById('pause-select');
const soundToggle = document.getElementById('sound-toggle');
const effectsToggle = document.getElementById('effects-toggle');
const pauseMoves = document.getElementById('pause-moves');
const W = 1280, H = 720, GROUND = 640;
const SP_COST = 30;
const SUBSTITUTE_COOLDOWN = 540;                  // 免费替身，9 秒冷却
const SUBSTITUTE_IFRAMES = 24;                    // 替身后 0.4 秒无敌

const preferences = {
  sound: true,
  reducedFx: matchMedia('(prefers-reduced-motion: reduce)').matches,
};
try{
  const saved=JSON.parse(localStorage.getItem('stick-fighter-settings')||'null');
  if (saved && typeof saved.sound==='boolean') preferences.sound=saved.sound;
  if (saved && typeof saved.reducedFx==='boolean') preferences.reducedFx=saved.reducedFx;
}catch(e){}

// ---------- 输入 ----------
const keys = {}, pressed = {};
window.addEventListener('keydown', e => {
  if ((e.code==='Escape' || e.code==='KeyP') && scene==='fight'){
    if (!e.repeat) setPaused(!paused);
    e.preventDefault();
    return;
  }
  if (paused){ e.preventDefault(); return; }
  if (!keys[e.code]) pressed[e.code] = true;
  keys[e.code] = true;
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => keys[e.code] = false);

// ---------- 手机触控输入 ----------
const touchMode = matchMedia('(pointer: coarse)').matches ||
  navigator.maxTouchPoints > 0 ||
  new URLSearchParams(location.search).has('touch');
document.documentElement.classList.toggle('mobile-mode', touchMode);

const virtualHolds = new Map();
function setVirtualKey(code, pointerId, down){
  let holders = virtualHolds.get(code);
  if (!holders){
    holders = new Set();
    virtualHolds.set(code, holders);
  }
  if (down){
    if (holders.size===0 && !keys[code]) pressed[code] = true;
    holders.add(pointerId);
    keys[code] = true;
  } else {
    holders.delete(pointerId);
    if (holders.size===0) keys[code] = false;
  }
}

if (touchMode){
  for (const button of document.querySelectorAll('.touch-key')){
    const code = button.dataset.code;
    const release = e => {
      setVirtualKey(code, e.pointerId, false);
      button.classList.remove('is-active');
    };
    button.addEventListener('pointerdown', e => {
      e.preventDefault();
      button.setPointerCapture?.(e.pointerId);
      setVirtualKey(code, e.pointerId, true);
      button.classList.add('is-active');
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
    button.addEventListener('contextmenu', e => e.preventDefault());
  }
}

window.addEventListener('blur', () => {
  clearInputs();
  if (scene==='fight' && fight?.phase==='play') setPaused(true);
});

// ---------- 音效 (WebAudio 合成) ----------
let AC = null;
function ac(){ if(!AC) AC = new (window.AudioContext||window.webkitAudioContext)(); return AC; }
function beep(freq, dur, type='square', vol=0.12, slide=0){
  if (!preferences.sound) return;
  try{
    const a = ac(), o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(Math.max(30,freq+slide), a.currentTime+dur);
    g.gain.setValueAtTime(vol, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime+dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime+dur);
  }catch(e){}
}
const sfx = {
  punch : ()=>beep(220,0.08,'square',0.10,-80),
  kick  : ()=>beep(150,0.12,'square',0.12,-60),
  hit   : ()=>{beep(90,0.15,'sawtooth',0.18,-40); beep(400,0.05,'square',0.08,-200);},
  launch: ()=>{beep(260,0.18,'square',0.13,220); beep(120,0.12,'sawtooth',0.1,80);},
  block : ()=>beep(600,0.06,'triangle',0.10,-100),
  jump  : ()=>beep(300,0.10,'sine',0.08,150),
  dash  : ()=>beep(520,0.09,'sine',0.07,-300),
  special:()=>{beep(180,0.25,'sawtooth',0.15,120); beep(500,0.15,'square',0.06,300);},
  superGo:()=>{beep(120,0.4,'sawtooth',0.2,200); beep(700,0.3,'square',0.08,-400);},
  ko    : ()=>{beep(80,0.6,'sawtooth',0.25,-50); beep(200,0.4,'square',0.1,-150);},
  select: ()=>beep(500,0.06,'square',0.08,100),
  confirm:()=>{beep(400,0.08,'square',0.1); setTimeout(()=>beep(600,0.12,'square',0.1),80);},
  awaken: ()=>{beep(90,0.6,'sawtooth',0.22,180); beep(300,0.5,'square',0.1,500);
               setTimeout(()=>beep(800,0.25,'sine',0.12,-300),140);},
  bounce: ()=>{beep(140,0.14,'square',0.16,-70); beep(500,0.06,'square',0.07,-250);},
};

// ---------- 角色数据 ----------
const CHARS = [
  {
    id:0, name:'烈拳·炎', style:'均衡拳法', color:'#ff4b3a', glow:'#ffb199',
    hp:100, speed:4.4, jumpV:16.5,
    chain:[
      {pose:'jab',    dmg:4, range:78, startup:4, active:3, recover:8,  kb:3,  stun:18},
      {pose:'cross',  dmg:5, range:86, startup:5, active:3, recover:9,  kb:4,  stun:20},
      {pose:'bigkick',dmg:9, range:98, startup:7, active:4, recover:15, kb:13, stun:26, launch:5},
    ],
    upJ  :{pose:'upper',  dmg:8, range:52, startup:6, active:5, recover:17, kb:2, stun:30, launch:13},
    downJ:{pose:'sweep',  dmg:7, range:94, startup:7, active:4, recover:14, kb:7, stun:26, launch:3},
    airJ :{pose:'airkick',dmg:8, range:80, startup:4, active:5, recover:8,  kb:6, stun:20, launch:4},
    spNames:{n:'烈焰冲拳', up:'升龙焰', down:'炎爆滑踢'}, supName:'百裂连拳',
    uNames :{n:'炎弹', up:'焰刃升', down:'火地刺'},
    awk:{name:'焰皇燃魂', color:'#ff8a1a', glow:'#ffe9c0'},
    desc:'速度与力量兼备，冲拳突进威胁极大',
  },
  {
    id:1, name:'疾影·风', style:'高速腿法', color:'#3ecfff', glow:'#bdefff',
    hp:88, speed:5.6, jumpV:18,
    chain:[
      {pose:'jab',    dmg:3, range:72, startup:3, active:3, recover:6,  kb:2,  stun:16},
      {pose:'kick',   dmg:4, range:82, startup:4, active:3, recover:7,  kb:3,  stun:18},
      {pose:'bigkick',dmg:7, range:96, startup:6, active:4, recover:12, kb:12, stun:24, launch:5},
    ],
    upJ  :{pose:'upper',  dmg:7, range:50, startup:5, active:5, recover:14, kb:2, stun:30, launch:14},
    downJ:{pose:'sweep',  dmg:6, range:98, startup:5, active:4, recover:12, kb:6, stun:24, launch:3},
    airJ :{pose:'airkick',dmg:7, range:82, startup:3, active:5, recover:7,  kb:5, stun:18, launch:4},
    spNames:{n:'燕返飞踢', up:'旋风升踢', down:'疾风滑铲'}, supName:'旋风连脚',
    uNames :{n:'风刃', up:'升风刃', down:'残影突'},
    awk:{name:'岚神降临', color:'#9ef5ff', glow:'#ffffff'},
    desc:'身法如风，出招极快，但较为脆皮',
  },
  {
    id:2, name:'崩山·岩', style:'刚猛重击', color:'#ffc63a', glow:'#ffe9a8',
    hp:120, speed:3.3, jumpV:14.5,
    chain:[
      {pose:'jab',    dmg:6,  range:84,  startup:7,  active:4, recover:11, kb:5,  stun:20},
      {pose:'cross',  dmg:8,  range:92,  startup:9,  active:4, recover:13, kb:6,  stun:22},
      {pose:'bigkick',dmg:13, range:102, startup:12, active:5, recover:19, kb:15, stun:30, launch:6},
    ],
    upJ  :{pose:'upper',  dmg:11, range:56,  startup:10, active:5, recover:20, kb:3,  stun:34, launch:15},
    downJ:{pose:'sweep',  dmg:10, range:102, startup:10, active:4, recover:17, kb:10, stun:28, launch:4},
    airJ :{pose:'airkick',dmg:10, range:84,  startup:5,  active:5, recover:9,  kb:8,  stun:24, launch:4},
    spNames:{n:'裂地震波', up:'崩岳掌', down:'震山跺'}, supName:'天崩地裂',
    uNames :{n:'飞石', up:'顶天肘', down:'岩踏'},
    awk:{name:'崩天怒霸', color:'#ffdf5e', glow:'#fff8dd'},
    desc:'血厚攻高，震波远程压制，就是腿短跑不快',
  },
  {
    id:3, name:'居合·刹', style:'拔刀居合', color:'#c8a0ff', glow:'#eaddff',
    hp:92, speed:4.8, jumpV:17,
    chain:[
      {pose:'jab',    dmg:4, range:80,  startup:4, active:3, recover:8,  kb:3,  stun:18},
      {pose:'kick',   dmg:5, range:90,  startup:5, active:3, recover:9,  kb:4,  stun:20},
      {pose:'bigkick',dmg:10,range:112, startup:8, active:4, recover:16, kb:13, stun:28, launch:5},
    ],
    upJ  :{pose:'upper',  dmg:8, range:54, startup:6, active:5, recover:16, kb:2, stun:30, launch:14},
    downJ:{pose:'sweep',  dmg:7, range:100,startup:6, active:4, recover:14, kb:7, stun:26, launch:3},
    airJ :{pose:'airkick',dmg:8, range:88, startup:4, active:5, recover:8,  kb:6, stun:20, launch:4},
    spNames:{n:'居合·月华', up:'升月斩', down:'纳刀突'}, supName:'一闪·万象',
    uNames :{n:'飞燕刃', up:'燕返', down:'落樱'},
    awk:{name:'心眼·无想', color:'#b06aff', glow:'#ffffff'},
    desc:'拔刀居合，出鞘一闪爆发极高，判定长但需要贴身把握时机',
  },
  {
    id:4, name:'青岚·竹', style:'长棍武艺', color:'#4ee87e', glow:'#c9ffd9',
    hp:96, speed:4.2, jumpV:16,
    chain:[
      {pose:'jab',    dmg:4, range:96,  startup:5, active:3, recover:9,  kb:4,  stun:18},
      {pose:'cross',  dmg:5, range:106, startup:6, active:3, recover:10, kb:5,  stun:20},
      {pose:'bigkick',dmg:9, range:118, startup:8, active:4, recover:16, kb:13, stun:27, launch:5},
    ],
    upJ  :{pose:'upper',  dmg:8, range:56,  startup:7, active:5, recover:17, kb:2, stun:30, launch:13},
    downJ:{pose:'sweep',  dmg:7, range:108, startup:7, active:4, recover:15, kb:8, stun:26, launch:3},
    airJ :{pose:'airkick',dmg:8, range:86,  startup:4, active:5, recover:8,  kb:6, stun:20, launch:4},
    spNames:{n:'横扫千军', up:'撑杆冲霄', down:'苍龙摆尾'}, supName:'万竹穿林',
    uNames :{n:'飞叶刃', up:'竹影升', down:'盘根错节'},
    awk:{name:'青竹傲雪', color:'#8effa9', glow:'#eafff1'},
    desc:'一寸长一寸强，棍法大开大合，中距离压制大师',
  },
];

const DIFFS = [
  {name:'简单', react:0.25, aggr:0.40, blockCh:0.12, spCh:0.25, supCh:0.30, think:26, color:'#7ed87e'},
  {name:'普通', react:0.55, aggr:0.65, blockCh:0.32, spCh:0.45, supCh:0.60, think:15, color:'#ffd75e'},
  {name:'困难', react:0.85, aggr:0.88, blockCh:0.55, spCh:0.70, supCh:0.95, think:8,  color:'#ff6a5e'},
];

// ---------- 战斗场景 ----------
const STAGES = [
  {id:0, name:'落霞荒野', ambient:'ember', platforms:[
    {x:155, y:525, w:280, kind:'stone'}, {x:845, y:555, w:250, kind:'stone'},
  ]},
  {id:1, name:'月夜天台', ambient:'neon', platforms:[
    {x:105, y:520, w:260, kind:'roof'}, {x:870, y:470, w:300, kind:'roof'},
  ]},
  {id:2, name:'雪岭神社', ambient:'snow', platforms:[
    {x:475, y:500, w:330, kind:'shrine'}, {x:92, y:560, w:220, kind:'snow'},
  ]},
  {id:3, name:'熔岩洞窟', ambient:'lava', platforms:[
    {x:125, y:510, w:275, kind:'basalt'}, {x:790, y:455, w:330, kind:'basalt'},
  ]},
];
let stage = STAGES[0];

// ---------- 全局状态 ----------
let scene = 'menu';           // menu | stageSelect | fight | matchEnd
let paused = false;
let menuSel = 0, diffSel = 1, stageSel = 0;
let fight = null;
let shake = 0, freeze = 0, koFlash = 0, slowmo = 0;
let zoomP = 0, zoomX = W/2, zoomY = H/2;        // 大招镜头推近
let superDark = 0;                               // 大招暗幕
let screenFlash = 0, screenFlashC = '#ffffff';   // 全屏闪光
let particles = [], floaters = [], projectiles = [], rings = [], embers = [], banners = [], decoys = [];
let frame = 0;
const substituteTouch = document.querySelector?.('.touch-key[data-code="KeyH"]') || null;
const substituteTouchLabel = substituteTouch?.querySelector('span') || null;

function clearInputs(){
  for (const code in keys) keys[code] = false;
  for (const code in pressed) pressed[code] = false;
  virtualHolds.clear();
  document.querySelectorAll('.touch-key.is-active').forEach(el => el.classList.remove('is-active'));
}

function syncGameUi(){
  const canPause = scene==='fight';
  pauseToggle.hidden = !canPause || paused;
  pauseOverlay.hidden = !paused;
  document.documentElement.classList.toggle('game-paused', paused);
  soundToggle.textContent=`音效：${preferences.sound?'开':'关'}`;
  effectsToggle.textContent=`闪光震屏：${preferences.reducedFx?'减弱':'标准'}`;
  if (fight){
    const ch=fight.p.ch;
    pauseMoves.innerHTML=`<strong>${ch.name} 招式</strong><br>U：${ch.uNames.n} / ↑${ch.uNames.up} / ↓${ch.uNames.down}<br>I：${ch.spNames.n} / ↑${ch.spNames.up} / ↓${ch.spNames.down}`;
  } else pauseMoves.textContent='进入战斗后可在这里查看当前角色招式。';
  if (!canPause && substituteTouch){
    substituteTouch.classList.remove('is-ready','is-cooling');
    if (substituteTouchLabel) substituteTouchLabel.textContent='替身';
    substituteTouch.setAttribute('aria-label','受击时替身到敌人身后');
  }
  syncTouchLabels();
}

function syncTouchLabels(){
  if (!touchMode) return;
  const combat={KeyW:'上',KeyA:'左',KeyS:'防',KeyD:'右',KeyU:'技',KeyI:'必杀',KeyO:'大招',KeyH:'替身',KeyL:'闪',KeyK:'跳',KeyJ:'攻击'};
  const menu={KeyA:'角色−',KeyD:'角色+',KeyJ:'下一步'};
  const select={KeyA:'地图−',KeyD:'地图+',KeyW:'难度−',KeyS:'难度+',KeyJ:'开战',KeyK:'返回'};
  const activeMap=scene==='menu'?menu:(scene==='stageSelect'?select:combat);
  document.querySelectorAll('.touch-key').forEach(button=>{
    const code=button.dataset.code, label=activeMap[code];
    const span=button.querySelector?.('span');
    if (span && !(code==='KeyH' && scene==='fight')) span.textContent=label||'—';
    button.classList.toggle('is-muted',!label);
  });
}

function savePreferences(){
  try{ localStorage.setItem('stick-fighter-settings',JSON.stringify(preferences)); }catch(e){}
  syncGameUi();
}

function setPaused(next){
  paused = scene==='fight' && !!next;
  clearInputs();
  syncGameUi();
  if (paused) pauseResume.focus?.();
}

function resetFight(){
  if (!fight) return;
  const pChar = fight.p.ch, cChar = fight.c.ch, diff = fight.diff;
  fight = makeFight(pChar, cChar, diff);
  resetBattleEffects();
  setPaused(false);
}

function returnToMenu(){
  scene = 'menu';
  fight = null;
  resetBattleEffects();
  setPaused(false);
  syncGameUi();
}

function resetBattleEffects(){
  projectiles=[]; particles=[]; floaters=[]; rings=[]; embers=[]; banners=[]; decoys=[];
  slowmo=0; zoomP=0; freeze=0; shake=0; superDark=0; screenFlash=0; koFlash=0;
}

pauseToggle.addEventListener('click', () => setPaused(true));
pauseResume.addEventListener('click', () => setPaused(false));
pauseRestart.addEventListener('click', resetFight);
function toggleSound(){preferences.sound=!preferences.sound;savePreferences();}
function toggleEffects(){preferences.reducedFx=!preferences.reducedFx;savePreferences();}

pauseSelect.addEventListener('click', returnToMenu);
soundToggle.addEventListener('click',toggleSound);
effectsToggle.addEventListener('click',toggleEffects);

// ---------- 战斗者 ----------
class Fighter {
  constructor(ch, x, isCPU){
    this.ch = ch; this.isCPU = isCPU;
    this.maxHp = ch.hp; this.hp = ch.hp;
    this.meter = 0;
    this.x = x; this.y = GROUND; this.floorY = GROUND; this.vx = 0; this.vy = 0;
    this.face = 1;
    this.state = 'idle'; this.st = 0;      // state timer (frames)
    this.atk = null; this.hasHit = false;  // current attack data
    this.stun = 0; this.isBlockstun = false;
    this.spCd = 0; this.spVar = 'n';
    this.uCd = 0;  this.uVar = 'n';
    this.dashCd = 0; this.dashDir = 1;
    this.airJumps = 0; this.airDashT = 0; this.airDashDir = 1;
    this.bufAtk = 0; this.bufSp = 0; this.bufU = 0; this.bufJmp = 0;  // input buffers (frames)
    this.combo = 0; this.comboT = 999;
    this.flashT = 0; this.msgCd = 0;
    this.trail = [];
    this.wins = 0;
    this.aiTimer = 0;
    this.intents = {};
    this.awakened = false; this.awkT = 0;          // 觉醒(整回合持续)
    this.wallB = 0; this.grdB = 0;                 // 本次受击串已用的弹墙/地弹次数
    this.rollDir = 1;                              // 受身翻滚方向
    this.iFrames = 0;                              // 受身后无敌帧(60=1秒)
    this.subCd = 0;                                // 替身冷却
  }
  get airborne(){ return this.y < this.floorY - 0.5; }
  // 觉醒外观色(招式强化在各技能实现内分支)
  get col(){ return this.awakened ? this.ch.awk.color : this.ch.color; }
  get glo(){ return this.awakened ? this.ch.awk.glow : this.ch.glow; }

  setState(s){ this.state = s; this.st = 0; }

  startNormal(move, chainIdx=-1){
    this.atk = Object.assign({chainIdx}, move);
    this.hasHit = false;
    this.setState('attack');
    sfx[(move.pose==='jab'||move.pose==='cross'||move.pose==='upper')?'punch':'kick']();
  }
  startSpecial(v){
    this.meter -= SP_COST;
    this.spVar = v; this.spCd = 30;
    this.atk = null; this.hasHit = false;
    this.setState('special');
    sfx.special();
    floaters.push({x:this.x, y:this.y-150, txt:(this.awakened?'觉醒·':'')+this.ch.spNames[v], c:this.glo, t:0});
    flame(this.x, this.y-55, this.glo, 6, 34);
    rings.push({x:this.x, y:this.y-55, r:14, vr:4, life:12, c:this.glo});
    if (this.ch.id===1 && v==='n'){ this.vy = -9; this.vx = 13*this.face; }
  }
  startU(v){
    this.uVar = v; this.uCd = 60;   // 1秒冷却
    this.atk = null; this.hasHit = false;
    this.setState('uskill');
    sfx.special();
    floaters.push({x:this.x, y:this.y-150, txt:(this.awakened?'觉醒·':'')+this.ch.uNames[v], c:this.glo, t:0});
    spark(this.x, this.y-60, this.glo, 4);
  }
  startSuper(){
    this.meter = 0;
    this.atk = null; this.hasHit = false;
    this.setState('super');
    sfx.superGo();
    freeze = Math.max(freeze, 18);
    shake = Math.max(shake, 8);
    banner('必杀・' + this.ch.supName, this.col);
    superDark = 52;
    zoomP = 1; zoomX = this.x; zoomY = this.y - 70;
    flame(this.x, this.y-50, this.glo, 14, 44);
    rings.push({x:this.x, y:this.y-55, r:16, vr:7, life:20, c:this.glo});
  }
  startAwaken(){
    this.meter = 0;
    this.awakened = true; this.awkT = 0;
    this.atk = null; this.vx = 0;
    this.setState('awaken');
    sfx.awaken();
    freeze = Math.max(freeze, 20);
    shake = Math.max(shake, 10);
    banner('觉醒・' + this.ch.awk.name, this.ch.awk.color);
    superDark = 64;
    zoomP = 1.4; zoomX = this.x; zoomY = this.y - 70;
    flame(this.x, this.y-50, this.ch.awk.glow, 16, 50);
    rings.push({x:this.x, y:this.y-55, r:14, vr:6, life:18, c:this.ch.awk.color});
    rings.push({x:this.x, y:this.y-55, r:6,  vr:10, life:14, c:'#ffffff'});
  }
  startDash(dir){
    this.dashDir = dir; this.dashCd = 30;
    this.setState('dash');
    sfx.dash();
    rings.push({x:this.x, y:this.y-52, r:10, vr:4, life:10, c:this.glo});
  }
  startAirDash(dir){
    this.dashCd = 30;
    this.airDashDir = dir; this.airDashT = 10;
    this.vy = 0; this.atk = null;
    sfx.dash();
    rings.push({x:this.x, y:this.y-52, r:10, vr:4, life:10, c:this.glo});
  }
  gainMeter(n){ this.meter = Math.min(100, this.meter + n); }
}

function makeFight(pChar, cChar, diff){
  return {
    p: new Fighter(pChar, 420, false),
    c: new Fighter(cChar, 860, true),
    diff,
    round: 1, phase: 'intro', pt: 0,   // phase timer
    time: 60*60,                        // frames left
    winner: null, matchWinner: null,
  };
}

// ---------- 命中处理 ----------
function applyHit(tgt, atkr, dmg, kb, stun, launch=0, isSuper=false){
  if (tgt.state==='awaken') return;   // 变身演出无敌
  if (tgt.iFrames > 0) return;        // 受身后无敌
  const dir = Math.sign(tgt.x - atkr.x) || atkr.face;
  const blocked = tgt.state==='block' && !tgt.airborne;

  if (blocked){
    // 完美格挡:命中前几帧才进入防御(block 状态 ≤6 帧),零削血 + 大顿帧 + 攒气 + 攻击方僵直
    const perfect = tgt.state==='block' && tgt.st <= 6 && !isSuper;
    if (perfect){
      tgt.stun = 0; tgt.isBlockstun = false;
      tgt.vx = 0;
      tgt.gainMeter(14); atkr.gainMeter(0);
      atkr.stun = 20; atkr.isBlockstun = true;    // 攻击方被弹硬直,给防守方反击窗口
      atkr.setState('hit'); atkr.vx = -dir * 3;
      sfx.block(); beep(900,0.08,'sine',0.12,300);
      freeze = Math.max(freeze, 12);
      screenFlash = Math.max(screenFlash, 0.22); screenFlashC = '#cfe8ff';
      spark(tgt.x + dir*-16, tgt.y-70, '#ffffff', 10);
      rings.push({x:tgt.x + dir*-14, y:tgt.y-70, r:12, vr:6, life:14, c:'#cfe8ff'});
      floaters.push({x:tgt.x, y:tgt.y-120, txt:'完美格挡!', c:'#cfe8ff', t:0});
      return;
    }
    const chip = Math.floor(dmg*0.07);   // 普通格挡削血:约7%,小招完全挡住
    tgt.hp = Math.max(0, tgt.hp - chip);
    tgt.stun = 10; tgt.isBlockstun = true;
    tgt.setState('hit');
    tgt.vx = dir * kb * 0.5;
    tgt.gainMeter(2); atkr.gainMeter(3);
    sfx.block();
    spark(tgt.x + dir*-20, tgt.y-70, '#9ecfff', 6);
    floaters.push({x:tgt.x, y:tgt.y-120, txt:'防御!', c:'#9ecfff', t:0});
    freeze = Math.max(freeze, 3);
  } else {
    // 连击追踪 + 伤害/硬直递减
    const inCombo = tgt.state==='hit';
    if (!inCombo){ tgt.wallB = 0; tgt.grdB = 0; }   // 新受击串:重置弹墙/地弹配额
    atkr.combo = inCombo ? atkr.combo+1 : 1;
    atkr.comboT = 0;
    const scale = Math.max(0.35, 1 - 0.08*(atkr.combo-1));
    dmg = Math.max(1, Math.round(dmg*scale));
    stun = Math.max(10, Math.round(stun * Math.max(0.5, 1 - 0.05*(atkr.combo-1))));

    const wasAir = tgt.airborne;
    tgt.hp = Math.max(0, tgt.hp - dmg);
    tgt.stun = stun; tgt.isBlockstun = false;
    tgt.setState('hit');
    tgt.flashT = 5;
    if (launch){ tgt.vy = -launch; tgt.y -= 1; }
    else if (wasAir) tgt.vy = -5;           // 浮空追击：轻托一下
    tgt.vx = dir * (wasAir ? Math.min(kb,6) : kb);
    tgt.gainMeter(dmg*1.0); atkr.gainMeter(dmg*1.6);
    if (launch >= 10){ sfx.launch(); slowmo = Math.max(slowmo, 10); rings.push({x:tgt.x, y:tgt.y-70, r:12, vr:5, life:16, c:atkr.glo}); }
    else sfx.hit();
    impactBurst(tgt.x + dir*-15, tgt.y-75, isSuper?'#ffe95e':atkr.glo, isSuper || launch>=10);
    if (isSuper) flame(tgt.x, tgt.y-70, atkr.glo, 3, 26);
    floaters.push({x:tgt.x+(Math.random()*30-15), y:tgt.y-130, txt:''+dmg, c:isSuper?'#ffe95e':'#ff8866', t:0});
    freeze = Math.max(freeze, isSuper?10:5);
    shake = Math.max(shake, isSuper?10:4);
  }
  if (tgt.hp <= 0){
    tgt.setState('ko');
    tgt.vy = -8; tgt.vx = dir*6;
    sfx.ko();
    shake = 14; freeze = 20; koFlash = 1;
    slowmo = 70;                    // KO 慢动作
    zoomP = Math.max(zoomP, 1.1); zoomX = tgt.x; zoomY = tgt.y-70;
    impactBurst(tgt.x, tgt.y-70, '#ffffff', true);
    debris(tgt.x, GROUND, 8);
    if (fight.phase==='play'){
      fight.phase = 'ko'; fight.pt = 0;
      fight.winner = (tgt===fight.p) ? fight.c : fight.p;
    }
  }
}

function attackHitbox(f){
  if (!f.atk) return null;
  const a = f.atk;
  if (f.st < a.startup || f.st >= a.startup + a.active) return null;
  if (a.pose==='upper')
    return norm({x1:f.x-6*f.face, x2:f.x+a.range*f.face, y1:f.y-144, y2:f.y-40});
  if (a.pose==='sweep')
    return norm({x1:f.x+8*f.face, x2:f.x+a.range*f.face, y1:f.y-34, y2:f.y});
  const yC = a.pose==='airkick' ? f.y-50 : (a.pose==='kick'||a.pose==='bigkick') ? f.y-54 : f.y-76;
  return norm({x1:f.x+10*f.face, x2:f.x+a.range*f.face, y1:yC-28, y2:yC+28});
}
function hurtbox(f){
  if (f.state==='awaken') return null;               // 变身演出期间无敌
  if (f.iFrames > 0) return null;                    // 受身后无敌(1秒)
  if (f.state==='ko') return {x1:f.x-40,x2:f.x+40,y1:f.y-24,y2:f.y};
  return {x1:f.x-22, x2:f.x+22, y1:f.y-104, y2:f.y};
}
function overlap(a,b){ return a && b && a.x1<b.x2 && a.x2>b.x1 && a.y1<b.y2 && a.y2>b.y1; }
function norm(hb){
  if (hb.x1>hb.x2){ const t=hb.x1; hb.x1=hb.x2; hb.x2=t; }
  return hb;
}

// ---------- 特效 ----------
function spark(x,y,color,n){
  for(let i=0;i<n;i++){
    const a = Math.random()*Math.PI*2, sp = 2+Math.random()*5;
    particles.push({type:'spark',x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-2,life:14+Math.random()*10,max:24,c:color,r:2+Math.random()*3});
  }
}
function dust(x,n,y=GROUND){
  for(let i=0;i<n;i++)
    particles.push({type:'spark',x:x+(Math.random()*40-20), y:y-2, vx:(Math.random()-0.5)*3, vy:-Math.random()*2,
                    life:12+Math.random()*8, max:20, c:'#8a7a6a', r:2+Math.random()*2});
}
function flame(x,y,c,n,spread=18){
  for(let i=0;i<n;i++)
    particles.push({type:'flame', x:x+(Math.random()-0.5)*spread, y:y+(Math.random()-0.5)*spread,
      vx:(Math.random()-0.5)*1.6, vy:-1-Math.random()*2.2, life:16+Math.random()*12, max:28, c, r:4+Math.random()*5});
}
function debris(x,y,n,c='#9a8a72'){
  for(let i=0;i<n;i++)
    particles.push({type:'debris', x:x+(Math.random()-0.5)*30, y, vx:(Math.random()-0.5)*7, vy:-(4+Math.random()*6),
      life:30+Math.random()*20, max:50, c, r:2+Math.random()*3});
}
function streakLine(x,y,ang,sp,c){
  particles.push({type:'streak', x, y, vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp,
    life:9+Math.random()*5, max:14, c});
}
function impactBurst(x,y,c,big=false){
  particles.push({type:'flash', x, y, r:big?32:18, life:big?8:6, max:8, c});
  const n = big?12:7;
  for(let i=0;i<n;i++){
    const a = Math.random()*Math.PI*2, sp = big?7+Math.random()*7:4+Math.random()*5;
    streakLine(x, y, a, sp, Math.random()<0.4?'#ffffff':c);
  }
  spark(x, y, c, big?10:5);
}
function banner(txt, c){ banners.push({txt, c, t:0}); }

// ---------- 玩家输入 → intents ----------
function playerIntents(f){
  const it = {};
  it.left  = keys['KeyA']; it.right = keys['KeyD'];
  it.up    = keys['KeyW']; it.down  = keys['KeyS'];
  it.jump  = pressed['KeyK'];
  it.atk   = pressed['KeyJ'];
  it.sp    = pressed['KeyI'];
  it.u     = pressed['KeyU'];
  it.sup   = pressed['KeyO'];
  it.dash  = pressed['KeyL'];
  it.sub   = pressed['KeyH'];
  return it;
}

function contextTip(){
  if (!fight || fight.phase!=='play') return null;
  const p=fight.p;
  if (p.state==='hit' && p.subCd<=0) return {title:'被连击时',text:`按 H${touchMode?'（紫色替身键）':''} 脱身到敌人背后`};
  if (p.state==='hit' && p.airborne && p.vy>1) return {title:'即将落地',text:'按 A 或 D 受身，快速起身并获得短暂无敌'};
  if (!p.awakened && p.meter>=100) return {title:'气已满',text:'按 O 释放大招，或同时按 J + K 觉醒'};
  if (p.meter>=SP_COST && p.meter<100) return {title:'气槽可用',text:'按 I 使用必杀；配合 W / S 可改变招式'};
  return null;
}

// ---------- AI ----------
function aiIntents(f, foe, diff){
  f.aiTimer--;
  if (f.aiTimer > 0) return f.intents;
  f.aiTimer = diff.think + Math.floor(Math.random()*8);
  const it = {};
  const dx = foe.x - f.x, dy = foe.y - f.y, dist = Math.abs(dx);
  const toward = dx > 0 ? 'right' : 'left';
  const away   = dx > 0 ? 'left' : 'right';
  const foeAttacking = ['attack','special','super'].includes(foe.state);
  const reach = f.ch.chain[0].range;

  // 自己被击飞:按难度概率尝试受身(落地帧读取方向键)
  if (f.state==='hit' && f.airborne){
    if (Math.random() < diff.react*0.6) it[away] = true;
    f.intents = it;
    return it;
  }

  if (dy < -70 && Math.random() < 0.55 + diff.react*0.25){
    // 对手在高台:向对方跳跃追击，避免 AI 长时间停在台下
    it[toward] = true; it.jump = true;
    if (dist < 150 && Math.random() < diff.react) it.atk = true;
  } else if (foe.state==='hit' && foe.airborne && dist < 170 && Math.random() < diff.react){
    // 浮空追击
    it[toward] = true; it.atk = true;
    if (foe.y < GROUND-60 && Math.random()<0.7) it.jump = true;   // 地面起跳/空中二段跳
  } else if (!f.awakened && f.meter >= 100 && Math.random() < diff.supCh*0.8){
    it.awaken = true;                                              // 满气优先觉醒
  } else if (foeAttacking && dist < 200 && Math.random() < diff.blockCh){
    it.down = true;
  } else if (f.meter >= 100 && dist < 240 && Math.random() < diff.supCh){
    it.sup = true;
  } else if (f.meter >= SP_COST && f.spCd<=0 && Math.random() < diff.spCh*(dist<260?1:0.5)){
    it.sp = true;
    if (foe.airborne) it.up = true;
    else if (f.ch.id===2 && dist>300){ /* 远程震波用 n */ }
    else { const r=Math.random(); if (r<0.3) it.up=true; else if (r<0.6) it.down=true; }
  } else if (f.uCd<=0 && Math.random() < diff.spCh*0.9){
    it.u = true;
    if (foe.airborne) it.up = true;
    else if (dist > 260){ /* 远程用 n 弹幕 */ }
    else { const r=Math.random(); if (r<0.35) it.up=true; else if (r<0.7) it.down=true; }
  } else if (dist > 340){
    if (f.dashCd<=0 && Math.random() < diff.aggr*0.5) it.dash = true;
    it[toward] = true;
    if (Math.random() < 0.06) it.jump = true;
  } else if (dist > reach*1.05){
    if (Math.random() < diff.aggr) it[toward] = true;
    else if (Math.random() < 0.3) it[away] = true;
    if (Math.random() < diff.aggr*0.2){ it.down=true; it.atk=true; }  // 下段戳
  } else {
    const r = Math.random();
    if (r < diff.aggr*0.5) it.atk = true;                              // 连段
    else if (r < diff.aggr*0.68){ it.up=true; it.atk=true; }           // 上挑起手
    else if (r < diff.aggr*0.82){ it.down=true; it.atk=true; }         // 下段
    else if (r < diff.aggr + 0.12) it[away] = true;
    else it.down = true;
  }
  // 对空反应
  if (foe.airborne && foe.state!=='hit' && dist < 150 && Math.random() < diff.react*0.5){
    it.up = true; it.atk = true;
  }
  f.intents = it;
  return it;
}

function platformAtFloor(f){
  if (f.floorY===GROUND) return null;
  return stage.platforms.find(p => Math.abs(p.y-f.floorY)<0.5 && f.x>p.x+14 && f.x<p.x+p.w-14) || null;
}

function landingSurface(f, prevY, nextY){
  if (f.vy<=0 || nextY<=prevY) return null;
  let best = nextY>=GROUND && prevY<=GROUND ? GROUND : null;
  for (const p of stage.platforms){
    if (f.x<=p.x+14 || f.x>=p.x+p.w-14) continue;
    if (prevY<=p.y && nextY>=p.y && (best===null || p.y<best)) best=p.y;
  }
  return best;
}

function trySubstitute(f, foe, it){
  if (!it.sub || f.state!=='hit' || f.hp<=0 || fight.phase!=='play') return false;
  if (f.subCd>0){
    if (!f.isCPU && f.msgCd<=0){
      f.msgCd=40;
      floaters.push({x:f.x,y:f.y-132,txt:`替身冷却 ${Math.ceil(f.subCd/60)}秒`,c:'#b9a7ce',t:0});
    }
    return false;
  }

  const oldX=f.x, oldY=f.y, oldFloor=f.floorY;
  const foePlatform=platformAtFloor(foe);
  let targetX=foe.x-foe.face*92;
  let targetFloor=GROUND;
  if (foePlatform){
    targetFloor=foePlatform.y;
    targetX=Math.max(foePlatform.x+28,Math.min(foePlatform.x+foePlatform.w-28,targetX));
  }
  targetX=Math.max(50,Math.min(W-50,targetX));

  decoys.push({x:oldX,y:oldFloor,t:0,life:34,c:f.col});
  for(let i=0;i<14;i++) particles.push({type:'smoke',x:oldX+(Math.random()*36-18),y:oldY-50-Math.random()*55,
    vx:(Math.random()-.5)*3.2,vy:-.8-Math.random()*2,life:22+Math.random()*16,max:38,c:'#e8edf5',r:6+Math.random()*8});
  for(let i=0;i<8;i++) particles.push({type:'smoke',x:targetX+(Math.random()*28-14),y:targetFloor-30-Math.random()*45,
    vx:(Math.random()-.5)*2.4,vy:-.6-Math.random()*1.5,life:18+Math.random()*12,max:30,c:f.glo,r:4+Math.random()*6});

  f.x=targetX; f.y=targetFloor; f.floorY=targetFloor;
  f.vx=0; f.vy=0; f.stun=0; f.isBlockstun=false;
  f.atk=null; f.hasHit=false; f.airDashT=0; f.airJumps=0;
  f.bufAtk=0; f.bufSp=0; f.bufU=0; f.bufJmp=0;
  f.iFrames=Math.max(f.iFrames,SUBSTITUTE_IFRAMES);
  f.subCd=SUBSTITUTE_COOLDOWN;
  f.face=foe.x>=f.x?1:-1;
  f.setState('idle');
  sfx.dash(); beep(780,.11,'triangle',.09,-320);
  rings.push({x:oldX,y:oldFloor-45,r:12,vr:7,life:14,c:'#ffffff'});
  rings.push({x:f.x,y:f.y-50,r:8,vr:5,life:12,c:f.glo});
  floaters.push({x:f.x,y:f.y-126,txt:'替身!',c:'#d8bdff',t:0});
  return true;
}

// ---------- 战斗者更新 ----------
function updateFighter(f, foe, it){
  const ch = f.ch;
  f.st++;
  if (f.spCd > 0) f.spCd--;
  if (f.uCd > 0) f.uCd--;
  if (f.dashCd > 0) f.dashCd--;
  if (f.subCd > 0) f.subCd--;
  if (f.iFrames > 0) f.iFrames--;
  if (f.flashT > 0) f.flashT--;
  if (f.msgCd > 0) f.msgCd--;

  // 输入缓冲
  if (it.atk) f.bufAtk = 7; else if (f.bufAtk>0) f.bufAtk--;
  if (it.sp)  f.bufSp  = 7; else if (f.bufSp>0)  f.bufSp--;
  if (it.u)   f.bufU   = 7; else if (f.bufU>0)   f.bufU--;
  if (it.jump) f.bufJmp = 5; else if (f.bufJmp>0) f.bufJmp--;
  if (f.awakened) f.awkT++;

  // 替身是受击硬直中的紧急脱身，优先于本帧物理和受击状态更新
  if (trySubstitute(f,foe,it)) return;

  // 连击计时/重置
  f.comboT++;
  if (f.combo>0 && f.comboT>8 && ['idle','walk','block','dash','jump'].includes(foe.state)) f.combo = 0;
  if (f.comboT > 90) f.combo = 0;

  // 走出高台边缘后开始下落；平台为单向地形，可以从下方跳上去
  if (f.floorY<GROUND && !platformAtFloor(f)){
    f.floorY = GROUND;
    if (f.y>=GROUND) f.y=GROUND-1;
  }

  // 朝向（仅可行动时调整）
  if (['idle','walk','block'].includes(f.state) && !f.airborne) f.face = foe.x >= f.x ? 1 : -1;

  // 物理
  f.x += f.vx;
  const prevY = f.y;
  const prevVy = f.vy;
  if (f.airDashT > 0){       // 空中瞬移:无重力横移
    f.airDashT--;
    f.vy = 0;
    f.x += f.airDashDir * ch.speed * 3.4 * (0.4 + 0.6*(f.airDashT/10));
    streakLine(f.x - f.airDashDir*22, f.y-30-Math.random()*56, f.airDashDir>0?Math.PI:0, 9+Math.random()*4, f.glo);
    f.trail.unshift({x:f.x, y:f.y}); if (f.trail.length>5) f.trail.pop();
  } else if (f.airborne || f.vy < 0){ f.vy += 0.85; f.y += f.vy; }
  const landY = landingSurface(f, prevY, f.y);
  if (landY!==null){
    f.floorY = landY;
    // 落地反弹:受击/KO 高速下坠时弹起一次
    if ((f.state==='hit'||f.state==='ko') && prevVy > 10 && f.grdB < 1){
      f.grdB++;
      f.y = landY - 1;
      f.vy = -prevVy * 0.55;
      f.vx *= 0.8;
      if (f.state==='hit') f.stun = Math.max(f.stun, 26);
      sfx.bounce();
      shake = Math.max(shake, 6);
      dust(f.x, 6, landY); debris(f.x, landY, 4);
      rings.push({x:f.x, y:landY-8, r:12, vr:6, life:12, c:'#ffffff'});
      floaters.push({x:f.x, y:f.y-140, txt:'弹地!', c:'#ffcf7e', t:0});
    } else {
      // 受身/快速起身:受击落地(非KO)按左右方向翻滚,短无敌+快速恢复
      if (f.state==='hit' && !f.isBlockstun && prevVy > 3 && (it.left || it.right)){
        f.setState('roll');
        f.rollDir = it.left ? -1 : 1;
        f.y = landY; f.vy = 0; f.stun = 0;
        f.iFrames = 60;                       // 受身成功:1秒无敌
        f.airJumps = 0; f.airDashT = 0;
        sfx.dash();
        dust(f.x, 6, landY);
        rings.push({x:f.x, y:landY-10, r:10, vr:5, life:10, c:f.glo});
        floaters.push({x:f.x, y:f.y-140, txt:'受身!无敌!', c:'#9ef5c0', t:0});
      } else {
        f.y = landY;
        if (f.vy > 0){ if (prevVy > 6) dust(f.x, 5, landY); f.vy = 0; }
        f.airJumps = 0; f.airDashT = 0;
        if (f.state==='jump'){ f.atk=null; f.setState('idle'); }
      }
    }
  }
  // 撞墙反弹:受击/KO 高速撞边界弹回
  if ((f.state==='hit'||f.state==='ko') && f.wallB < 1 &&
      ((f.x <= 52 && f.vx < -5.5) || (f.x >= W-52 && f.vx > 5.5))){
    f.wallB++;
    const wx = f.x <= 52 ? 50 : W-50;
    f.vx = -f.vx * 0.8;
    f.vy = Math.min(f.vy, -7);
    f.y -= 1;
    if (f.state==='hit') f.stun = Math.max(f.stun, 30);
    sfx.bounce();
    shake = Math.max(shake, 8);
    slowmo = Math.max(slowmo, 14);
    impactBurst(wx, f.y-70, '#ffffff', true);
    debris(wx, f.y-40, 5, '#8a8a9a');
    rings.push({x:wx, y:f.y-65, r:14, vr:7, life:14, c:'#ffffff'});
    floaters.push({x:f.x, y:f.y-150, txt:'撞墙!', c:'#ff9e6e', t:0});
  }
  // 摩擦
  if (!f.airborne) f.vx *= 0.78;
  if (Math.abs(f.vx) < 0.3) f.vx = 0;
  f.x = Math.max(50, Math.min(W-50, f.x));

  // 残影记录
  const fast = ['dash','special','super','uskill'].includes(f.state) || Math.abs(f.vx) > 8;
  if (fast){ f.trail.unshift({x:f.x, y:f.y}); if (f.trail.length>5) f.trail.pop(); }
  else if (f.trail.length) f.trail.pop();

  // 满气光环 / 觉醒气场
  if (f.awakened && f.state!=='ko'){
    if (frame%3===0) flame(f.x+(Math.random()*36-18), f.y-8-Math.random()*80, f.ch.awk.glow, 1, 10);
    if (frame%9===0) spark(f.x+(Math.random()*40-20), f.y-30-Math.random()*60, f.ch.awk.color, 1);
  } else if (f.meter>=100 && f.state!=='ko' && frame%4===0)
    flame(f.x+(Math.random()*30-15), f.y-14-Math.random()*66, f.glo, 1, 8);

  const spVariant = () => it.up ? 'up' : (it.down ? 'down' : 'n');

  switch (f.state){
    case 'idle': case 'walk': {
      if (fight.phase !== 'play') { f.setState('idle'); break; }
      if (!f.awakened && f.meter >= 100 && (it.awaken || (f.bufAtk > 0 && f.bufJmp > 0))){
        f.bufAtk = 0; f.bufJmp = 0;
        f.startAwaken(); break;
      }
      if (it.sup && f.meter >= 100){ f.startSuper(); break; }
      if (f.bufSp > 0){
        if (f.meter >= SP_COST && f.spCd<=0){ f.bufSp=0; f.startSpecial(spVariant()); break; }
        if (f.meter < SP_COST && !f.isCPU && f.msgCd<=0){
          f.msgCd = 45; f.bufSp = 0;
          floaters.push({x:f.x, y:f.y-130, txt:'气不足!', c:'#8fb6ff', t:0});
        }
      }
      if (f.bufU > 0 && f.uCd<=0){ f.bufU=0; f.startU(spVariant()); break; }
      if (f.bufAtk > 0){
        f.bufAtk = 0;
        if (it.up) f.startNormal(ch.upJ);
        else if (it.down) f.startNormal(ch.downJ);
        else f.startNormal(ch.chain[0], 0);
        break;
      }
      if (it.jump){ f.vy = -ch.jumpV; f.y -= 1; f.setState('jump'); sfx.jump(); break; }
      if (it.dash && f.dashCd<=0){
        f.startDash(it.left ? -1 : (it.right ? 1 : f.face));
        break;
      }
      if (it.down){ f.setState('block'); break; }
      if (it.left || it.right){
        const dir = it.right ? 1 : -1;
        f.x += dir * ch.speed;
        f.state = 'walk';
      } else f.state = 'idle';
      break;
    }
    case 'block': {
      if (fight.phase==='play'){
        if (f.bufAtk > 0){ f.bufAtk=0; f.startNormal(ch.downJ); break; }
        if (f.bufSp > 0 && f.meter >= SP_COST && f.spCd<=0){ f.bufSp=0; f.startSpecial('down'); break; }
        if (f.bufU > 0 && f.uCd<=0){ f.bufU=0; f.startU('down'); break; }
      }
      if (!it.down) f.setState('idle');
      break;
    }
    case 'dash': {
      f.x += f.dashDir * ch.speed * 3.4 * (1 - f.st/24);
      streakLine(f.x - f.dashDir*22, f.y-24-Math.random()*56, f.dashDir>0?Math.PI:0, 7+Math.random()*4, ch.glow);
      if (f.st > 4 && f.bufAtk > 0){
        f.bufAtk = 0; f.vx = f.dashDir*7;
        f.startNormal(ch.chain[0], 0);
        break;
      }
      if (f.st >= 18) f.setState('idle');
      break;
    }
    case 'jump': {
      // K 先按 J 后到:起跳前几帧仍可转觉醒
      if (!f.awakened && f.meter >= 100 && f.st <= 4 && f.bufAtk > 0 && fight.phase==='play'){
        f.bufAtk = 0; f.vy = 0; f.y = f.floorY;
        f.startAwaken(); break;
      }
      if (it.left)  f.x -= ch.speed*0.7;
      if (it.right) f.x += ch.speed*0.7;
      if (it.jump && f.airJumps < 1 && f.airDashT<=0){   // 二段跳
        f.airJumps++;
        f.vy = -ch.jumpV*0.88; f.atk = null;
        sfx.jump();
        rings.push({x:f.x, y:f.y, r:8, vr:4, life:10, c:ch.glow});
        spark(f.x, f.y, ch.glow, 4);
        break;
      }
      if (it.dash && f.dashCd<=0 && f.airDashT<=0){       // 空中瞬移
        f.startAirDash(it.left ? -1 : (it.right ? 1 : f.face));
        break;
      }
      if (f.bufAtk > 0 && !f.atk){
        f.bufAtk = 0;
        f.atk = Object.assign({chainIdx:-1}, ch.airJ);
        f.hasHit = false; f.st = 0; sfx.kick();
      }
      if (f.atk && f.st > f.atk.startup + f.atk.active + 6) f.atk = null;
      break;
    }
    case 'attack': {
      const a = f.atk;
      // J 先按 K 后到:普攻前几帧仍可转觉醒
      if (!f.awakened && f.meter >= 100 && f.st <= 4 && f.bufJmp > 0 && fight.phase==='play'){
        f.bufJmp = 0; f.startAwaken(); break;
      }
      const total = a.startup + a.active + a.recover;
      const canCancel = f.hasHit ? f.st >= a.startup+1 : f.st >= a.startup + a.active;
      if (canCancel && fight.phase==='play'){
        if (f.hasHit && it.sup && f.meter >= 100){ f.startSuper(); break; }
        if (f.hasHit && f.bufSp > 0 && f.meter >= SP_COST && f.spCd<=0){
          f.bufSp = 0; f.startSpecial(spVariant()); break;
        }
        if (f.hasHit && f.bufU > 0 && f.uCd<=0){
          f.bufU = 0; f.startU(spVariant()); break;
        }
        if (f.bufAtk > 0 && a.chainIdx >= 0){
          f.bufAtk = 0;
          if (it.up){ f.startNormal(ch.upJ); break; }
          if (a.chainIdx < 2){ f.startNormal(ch.chain[a.chainIdx+1], a.chainIdx+1); break; }
        }
      }
      if (f.st >= total){ f.atk = null; f.setState('idle'); }
      break;
    }
    case 'special': updateSpecial(f, foe); break;
    case 'uskill':  updateUSkill(f, foe); break;
    case 'super':   updateSuper(f, foe); break;
    case 'awaken': {
      // 变身演出:短暂无敌,喷发气场
      f.vx = 0;
      if (f.st % 3 === 0) flame(f.x+(Math.random()*44-22), f.y-10-Math.random()*90, f.ch.awk.glow, 2, 14);
      if (f.st % 8 === 0) rings.push({x:f.x, y:f.y-55, r:10, vr:6, life:14, c:f.ch.awk.color});
      if (f.st === 24){
        screenFlash = Math.max(screenFlash, 0.45); screenFlashC = f.ch.awk.color;
        shake = Math.max(shake, 8);
        rings.push({x:f.x, y:f.y-55, r:20, vr:12, life:20, c:'#ffffff'});
        impactBurst(f.x, f.y-60, f.ch.awk.color, true);
        for(let i=0;i<10;i++) spark(f.x, f.y-40-Math.random()*60, f.ch.awk.glow, 2);
      }
      if (f.st > 40) f.setState('idle');
      break;
    }
    case 'roll': {
      // 受身翻滚:横向位移,前 12 帧无敌,尾段可行动
      f.x += f.rollDir * ch.speed * 2.2 * (1 - f.st/20);
      if (f.st % 2 === 0) dust(f.x, 1, f.floorY);
      if (f.st >= 20){ f.vx = 0; f.setState('idle'); }
      break;
    }
    case 'hit': {
      f.stun--;
      if (f.stun <= 0 && !f.airborne){ f.isBlockstun=false; f.setState('idle'); }
      break;
    }
    case 'ko': break;
    case 'win': break;
  }

  // 普通攻击命中检测（地面连段 & 空中攻击）
  if (f.atk && !f.hasHit && (f.state==='attack' || f.state==='jump')){
    const hb = attackHitbox(f);
    if (overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
      f.hasHit = true;
      applyHit(foe, f, f.atk.dmg, f.atk.kb, f.atk.stun, f.atk.launch||0);
    }
  }
}

// ---------- 必杀技（I / 上+I / 下+I,耗气,觉醒后为强化版） ----------
function updateSpecial(f, foe){
  const id = f.ch.id, v = f.spVar, t = f.st, A = f.awakened;
  const tryHit = (hb, dmg, kb, stun, launch) => {
    norm(hb);
    if (!f.hasHit && overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
      f.hasHit = true;
      applyHit(foe, f, dmg, kb, stun, launch);
      return true;
    }
    return false;
  };

  if (id===0){ // ===== 烈拳·炎 =====
    if (v==='n'){ // 烈焰冲拳 → 觉醒:焰皇贯手(更远更痛,终点爆炎)
      if (t>=6 && t<=(A?22:18)){
        f.x += (A?18:15)*f.face;
        tryHit({x1:f.x, x2:f.x+(A?115:95)*f.face, y1:f.y-100, y2:f.y-45}, A?19:14, A?14:11, A?30:26, A?5:3);
        flame(f.x-16*f.face, f.y-74, A?'#ffb14a':'#ff8844', A?3:2, A?22:16);
        streakLine(f.x-30*f.face, f.y-36-Math.random()*64, f.face>0?Math.PI:0, 9, f.glo);
      }
      if (A && t===22 && f.hasHit){ impactBurst(f.x+70*f.face, f.y-72, '#ffb14a', true); shake=Math.max(shake,6); }
      if (t>34) f.setState('idle');
    } else if (v==='up'){ // 升龙焰 → 觉醒:双重升龙,更高更痛
      if (t===5){
        f.vy = A?-18:-15; f.vx = 2.5*f.face;
        rings.push({x:f.x, y:GROUND-6, r:14, vr:6, life:14, c:'#ff8844'});
      }
      if (t>=5 && t<=(A?28:22)){
        tryHit({x1:f.x-14*f.face, x2:f.x+(A?60:50)*f.face, y1:f.y-150, y2:f.y-20}, A?16:12, 3, A?36:32, A?17:14);
        flame(f.x, f.y-60, A?'#ffb14a':'#ff8844', 3, 28);
        flame(f.x+8*f.face, f.y-120, '#ffd0a0', 1, 14);
        if (A) flame(f.x-10*f.face, f.y-90, '#ffe9c0', 1, 18);
      }
      if (t>12 && !f.airborne){ f.vx=0; f.setState('idle'); }
      if (t>90) f.setState('idle');
    } else { // 炎爆滑踢 → 觉醒:留下火路
      if (t>=5 && t<=(A?26:22)){
        f.x += (A?13:11)*f.face;
        tryHit({x1:f.x, x2:f.x+80*f.face, y1:f.y-42, y2:f.y}, A?14:10, A?11:9, A?30:26, A?6:4);
        flame(f.x-12*f.face, f.y-10, A?'#ffb14a':'#ff8844', 2, 14);
        dust(f.x-20*f.face, 1);
        if (A && t%3===0) flame(f.x-40*f.face, f.y-6, '#ff8844', 2, 10);
      }
      if (t>32) f.setState('idle');
    }
  } else if (id===1){ // ===== 疾影·风 =====
    if (v==='n'){ // 燕返飞踢 → 觉醒:三连燕返
      if (t>4 && tryHit({x1:f.x, x2:f.x+(A?92:80)*f.face, y1:f.y-90, y2:f.y-30}, A?16:12, A?12:10, A?28:24, A?7:5)){
        f.vx = -6*f.face; f.vy = -6;
      }
      streakLine(f.x-16*f.face, f.y-30-Math.random()*60, f.face>0?Math.PI:0, 10, f.glo);
      if (t%3===0) streakLine(f.x, f.y-50, Math.random()*Math.PI*2, 5, '#ffffff');
      if (!f.airborne && t>8){ f.vx=0; f.setState('idle'); }
      if (t>70) f.setState('idle');
    } else if (v==='up'){ // 旋风升踢 → 觉醒:龙卷风柱
      if (t===4){
        f.vy = A?-19:-16; f.vx = 3*f.face;
        rings.push({x:f.x, y:GROUND-6, r:14, vr:6, life:14, c:f.glo});
      }
      if (t>=4 && t<=(A?30:24)){
        tryHit({x1:f.x-(A?58:45), x2:f.x+(A?58:45), y1:f.y-130, y2:f.y-10}, A?14:10, 3, A?34:30, A?17:14);
        const a = t*0.9;
        streakLine(f.x+Math.cos(a)*(A?46:34), f.y-60+Math.sin(a)*20, a+Math.PI/2, 7, f.glo);
        streakLine(f.x-Math.cos(a)*(A?46:34), f.y-60-Math.sin(a)*20, a-Math.PI/2, 7, '#ffffff');
        if (A && t%4===0) rings.push({x:f.x, y:f.y-60, r:16, vr:4, life:10, c:f.glo});
      }
      if (t>12 && !f.airborne){ f.vx=0; f.setState('idle'); }
      if (t>90) f.setState('idle');
    } else { // 疾风滑铲 → 觉醒:更快带风痕
      if (t>=3 && t<=(A?21:18)){
        f.x += (A?16:13.5)*f.face;
        tryHit({x1:f.x, x2:f.x+82*f.face, y1:f.y-40, y2:f.y}, A?11:8, A?10:8, A?28:24, A?5:3);
        streakLine(f.x-18*f.face, f.y-8-Math.random()*26, f.face>0?Math.PI:0, 11, f.glo);
        dust(f.x-16*f.face, 1);
      }
      if (t>26) f.setState('idle');
    }
  } else if (id===2){ // ===== 崩山·岩 =====
    if (v==='n'){ // 裂地震波 → 觉醒:双波连发
      if (t===14 || (A && t===26)){
        projectiles.push({x:f.x+40*f.face, y:GROUND-30, vx:(A?9.5:8)*f.face, dmg:A?14:11, kb:A?11:9, stun:A?28:24,
                          owner:f, life:120, c:f.col, kind:'wave'});
        shake = Math.max(shake, 5);
        debris(f.x+40*f.face, GROUND, 4);
        rings.push({x:f.x+40*f.face, y:GROUND-14, r:12, vr:5, life:12, c:f.glo});
        beep(100,0.3,'sawtooth',0.2,-60);
      }
      if (t>(A?42:36)) f.setState('idle');
    } else if (v==='up'){ // 崩岳掌 → 觉醒:更大浮空
      if (t>=10 && t<=(A?28:24)){
        tryHit({x1:f.x-10*f.face, x2:f.x+(A?76:62)*f.face, y1:f.y-156, y2:f.y-36}, A?21:16, 4, A?40:36, A?19:16);
        flame(f.x+26*f.face, f.y-104, f.glo, 3, 26);
      }
      if (t===10){ beep(140,0.2,'sawtooth',0.16,90); debris(f.x+20*f.face, GROUND, 4); }
      if (t>44) f.setState('idle');
    } else { // 震山跺 → 觉醒:范围翻倍
      if (t===16){
        shake = Math.max(shake, A?14:10);
        beep(70,0.4,'sawtooth',0.24,-30);
        rings.push({x:f.x, y:GROUND-8, r:20, vr:A?12:9, life:18, c:f.glo});
        rings.push({x:f.x, y:GROUND-8, r:8, vr:13, life:14, c:'#ffffff'});
        debris(f.x-60, GROUND, 5); debris(f.x+60, GROUND, 5);
        dust(f.x-60, 4); dust(f.x+60, 4);
        screenFlash = Math.max(screenFlash, 0.16); screenFlashC = f.glo;
        if (Math.abs(foe.x-f.x) < (A?245:175) && !foe.airborne && foe.state!=='ko'){
          f.hasHit = true;
          applyHit(foe, f, A?16:12, A?13:11, A?34:30, A?8:6);
        }
      }
      if (t>42) f.setState('idle');
    }
  } else if (id===3){ // ===== 居合·刹 =====
    if (v==='n'){ // 居合·月华:短暂纳刀蓄势 → 突进拔刀一闪
      if (t < 10){ f.vx = 0; if (t===2) flame(f.x, f.y-70, f.glo, 3, 20); }
      else if (t>=10 && t<=(A?24:18)){
        f.x += (A?17:14)*f.face;
        // 拔刀斩:长判定
        if (tryHit({x1:f.x-10*f.face, x2:f.x+(A?128:108)*f.face, y1:f.y-108, y2:f.y-28}, A?20:15, A?13:11, A?32:28, A?6:4)){
          slowmo = Math.max(slowmo, A?12:8);
        }
        streakLine(f.x-30*f.face, f.y-70-Math.random()*30, f.face>0?Math.PI:0, 13, '#ffffff');
        streakLine(f.x-20*f.face, f.y-50-Math.random()*40, f.face>0?Math.PI:0, 10, f.glo);
      }
      if (A && t===24 && f.hasHit){ impactBurst(f.x+80*f.face, f.y-66, f.glo, true); }
      if (t>(A?34:30)) f.setState('idle');
    } else if (v==='up'){ // 升月斩:上挑拔刀,大浮空
      if (t===5){
        f.vy = A?-19:-16; f.vx = 2*f.face;
        rings.push({x:f.x, y:GROUND-6, r:14, vr:6, life:14, c:f.glo});
      }
      if (t>=5 && t<=(A?28:22)){
        tryHit({x1:f.x-12*f.face, x2:f.x+(A?58:48)*f.face, y1:f.y-158, y2:f.y-20}, A?15:11, 3, A?36:32, A?18:15);
        const a = -Math.PI/2 - f.face*t*0.05;
        streakLine(f.x+Math.cos(a)*40, f.y-90+Math.sin(a)*40, a, 11, '#ffffff');
        flame(f.x, f.y-110, f.glo, 1, 12);
      }
      if (t>12 && !f.airborne){ f.vx=0; f.setState('idle'); }
      if (t>90) f.setState('idle');
    } else { // 纳刀突:超快突进刺击,命中后拉刀距
      if (t>=3 && t<=(A?18:14)){
        f.x += (A?18:15)*f.face;
        if (tryHit({x1:f.x, x2:f.x+(A?96:82)*f.face, y1:f.y-84, y2:f.y-36}, A?12:9, A?9:7, A?26:22, 0)){
          f.vx = -4*f.face;
        }
        streakLine(f.x-24*f.face, f.y-60-Math.random()*20, f.face>0?Math.PI:0, 14, '#ffffff');
      }
      if (t>(A?26:22)) f.setState('idle');
    }
  } else { // ===== 青岚·竹 =====
    if (v==='n'){ // 横扫千军:旋棍推进横扫 → 觉醒:更远更痛
      if (t>=6 && t<=(A?26:20)){
        f.x += (A?9:7.5)*f.face;
        tryHit({x1:f.x-30*f.face, x2:f.x+(A?132:112)*f.face, y1:f.y-104, y2:f.y-26}, A?18:13, A?12:10, A?32:28, A?5:3);
        const a = t*0.55;
        streakLine(f.x+Math.cos(a)*56, f.y-66+Math.sin(a)*24, a+Math.PI/2, 9, f.glo);
        streakLine(f.x-Math.cos(a)*56, f.y-66-Math.sin(a)*24, a-Math.PI/2, 9, '#ffffff');
      }
      if (t>(A?36:30)) f.setState('idle');
    } else if (v==='up'){ // 撑杆冲霄:撑棍腾空踢 → 觉醒:更高更痛
      if (t===5){
        f.vy = A?-19:-16.5; f.vx = 2.5*f.face;
        rings.push({x:f.x, y:GROUND-6, r:14, vr:6, life:14, c:f.glo});
        dust(f.x, 4);
      }
      if (t>=5 && t<=(A?28:22)){
        tryHit({x1:f.x-12*f.face, x2:f.x+(A?60:50)*f.face, y1:f.y-154, y2:f.y-16}, A?16:12, 3, A?36:32, A?18:15);
        streakLine(f.x, f.y-40-Math.random()*80, -Math.PI/2, 9, f.glo);
        if (A) flame(f.x, f.y-70, f.glo, 1, 14);
      }
      if (t>12 && !f.airborne){ f.vx=0; f.setState('idle'); }
      if (t>90) f.setState('idle');
    } else { // 苍龙摆尾:低位扫棍滑行 → 觉醒:更快更远
      if (t>=4 && t<=(A?24:20)){
        f.x += (A?13:11)*f.face;
        tryHit({x1:f.x-10*f.face, x2:f.x+(A?100:88)*f.face, y1:f.y-40, y2:f.y}, A?13:10, A?10:9, A?30:26, A?6:4);
        streakLine(f.x-16*f.face, f.y-10-Math.random()*24, f.face>0?Math.PI:0, 10, f.glo);
        dust(f.x-18*f.face, 1);
      }
      if (t>30) f.setState('idle');
    }
  }
}

// ---------- U技能（U / 上+U / 下+U,免费,独立冷却,觉醒后为强化版） ----------
function updateUSkill(f, foe){
  const id = f.ch.id, v = f.uVar, t = f.st, A = f.awakened;
  const tryHit = (hb, dmg, kb, stun, launch) => {
    norm(hb);
    if (!f.hasHit && overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
      f.hasHit = true;
      applyHit(foe, f, dmg, kb, stun, launch);
      return true;
    }
    return false;
  };

  if (id===0){ // ===== 烈拳·炎 =====
    if (v==='n'){ // 炎弹 → 觉醒:双连炎弹
      if (t===10 || (A && t===18)){
        projectiles.push({x:f.x+36*f.face, y:f.y-72, vx:(A?10.5:9)*f.face, dmg:A?8:6, kb:A?7:6, stun:A?20:18,
                          owner:f, life:90, c:'#ff8844', kind:'fire'});
        flame(f.x+36*f.face, f.y-72, '#ff8844', 4, 14);
        beep(320,0.12,'square',0.1,-120);
      }
      if (t>(A?30:26)) f.setState('idle');
    } else if (v==='up'){ // 焰刃升 → 觉醒:更高更痛
      if (t>=4 && t<=14){
        tryHit({x1:f.x-6*f.face, x2:f.x+(A?54:44)*f.face, y1:f.y-140, y2:f.y-30}, A?8:6, 2, A?30:26, A?11:9);
        flame(f.x+14*f.face, f.y-90, '#ff8844', 2, 18);
      }
      if (t>24) f.setState('idle');
    } else { // 火地刺 → 觉醒:双段喷焰更远
      if (t===12 || (A && t===20)){
        const ox = t===12 ? 70 : 150;
        flame(f.x+ox*f.face, f.y-16, '#ff8844', 10, 40);
        flame(f.x+(ox+30)*f.face, f.y-30, '#ffd0a0', 5, 30);
        rings.push({x:f.x+(ox+10)*f.face, y:GROUND-10, r:10, vr:5, life:12, c:'#ff8844'});
        beep(180,0.18,'sawtooth',0.14,60);
      }
      if (t>=12 && t<=(A?26:18))
        tryHit({x1:f.x+28*f.face, x2:f.x+(A?212:132)*f.face, y1:f.y-64, y2:f.y}, A?9:7, A?6:5, A?26:22, A?6:5);
      if (t>(A?36:30)) f.setState('idle');
    }
  } else if (id===1){ // ===== 疾影·风 =====
    if (v==='n'){ // 风刃 → 觉醒:三连风刃
      if (t===8 || (A && (t===14 || t===20))){
        projectiles.push({x:f.x+34*f.face, y:f.y-66-(A?(t-8)*2:0), vx:13*f.face, dmg:5, kb:5, stun:16,
                          owner:f, life:70, c:f.glo, kind:'wind'});
        streakLine(f.x+20*f.face, f.y-66, f.face>0?0:Math.PI, 10, '#ffffff');
        beep(600,0.1,'sine',0.08,-200);
      }
      if (t>(A?26:20)) f.setState('idle');
    } else if (v==='up'){ // 升风刃 → 觉醒:更高更痛
      if (t>=3 && t<=14){
        tryHit({x1:f.x-8*f.face, x2:f.x+(A?52:42)*f.face, y1:f.y-136, y2:f.y-26}, A?7:5, 2, A?28:24, A?12:10);
        streakLine(f.x+12*f.face, f.y-80-Math.random()*40, -Math.PI/2, 8, f.glo);
      }
      if (t>22) f.setState('idle');
    } else { // 残影突 → 觉醒:更快更远
      if (t>=3 && t<=(A?17:14)){
        f.x += (A?15:12)*f.face;
        tryHit({x1:f.x, x2:f.x+56*f.face, y1:f.y-92, y2:f.y-28}, A?8:6, A?9:7, A?24:20, 0);
        streakLine(f.x-20*f.face, f.y-30-Math.random()*56, f.face>0?Math.PI:0, 12, f.glo);
      }
      if (t>22) f.setState('idle');
    }
  } else if (id===2){ // ===== 崩山·岩 =====
    if (v==='n'){ // 飞石 → 觉醒:巨岩
      if (t===14){
        projectiles.push({x:f.x+30*f.face, y:f.y-86, vx:7*f.face, vy:-8, grav:0.5,
                          dmg:A?12:8, kb:A?10:8, stun:A?26:22, owner:f, life:130, c:'#b8a888', kind:'rock', big:A});
        beep(200,0.15,'square',0.12,-60);
      }
      if (t>32) f.setState('idle');
    } else if (v==='up'){ // 顶天肘 → 觉醒:更痛更浮空
      if (t>=8 && t<=18){
        tryHit({x1:f.x-4*f.face, x2:f.x+(A?58:48)*f.face, y1:f.y-146, y2:f.y-46}, A?11:8, 3, A?32:28, A?12:10);
        spark(f.x+20*f.face, f.y-110, f.glo, 2);
      }
      if (t>32) f.setState('idle');
    } else { // 岩踏 → 觉醒:范围加大
      if (t===14){
        shake = Math.max(shake, A?9:6);
        rings.push({x:f.x+30*f.face, y:GROUND-8, r:12, vr:A?9:7, life:14, c:f.glo});
        debris(f.x+40*f.face, GROUND, 5);
        dust(f.x+40*f.face, 4);
        beep(90,0.25,'sawtooth',0.18,-30);
        if (Math.abs(foe.x-f.x) < (A?180:130) && !foe.airborne && foe.state!=='ko'){
          f.hasHit = true;
          applyHit(foe, f, A?10:7, A?10:8, A?26:22, A?5:3);
        }
      }
      if (t>34) f.setState('idle');
    }
  } else if (id===3){ // ===== 居合·刹 =====
    if (v==='n'){ // 飞燕刃:快速掷出刀气 → 觉醒:双连
      if (t===8 || (A && t===16)){
        projectiles.push({x:f.x+34*f.face, y:f.y-70, vx:12*f.face, dmg:A?7:5, kb:5, stun:16,
                          owner:f, life:80, c:f.glo, kind:'slash'});
        streakLine(f.x+20*f.face, f.y-70, f.face>0?0:Math.PI, 12, '#ffffff');
        beep(700,0.09,'sine',0.08,-260);
      }
      if (t>(A?26:20)) f.setState('idle');
    } else if (v==='up'){ // 燕返:快速上挑斩
      if (t>=3 && t<=14){
        tryHit({x1:f.x-8*f.face, x2:f.x+(A?54:44)*f.face, y1:f.y-140, y2:f.y-28}, A?8:6, 2, A?28:24, A?12:10);
        streakLine(f.x+12*f.face, f.y-90-Math.random()*40, -Math.PI/2, 10, '#ffffff');
      }
      if (t>24) f.setState('idle');
    } else { // 落樱:突进下劈,命中减速
      if (t>=4 && t<=(A?18:14)){
        f.x += (A?14:11)*f.face;
        if (tryHit({x1:f.x, x2:f.x+(A?70:58)*f.face, y1:f.y-96, y2:f.y-20}, A?9:7, A?8:6, A?24:20, A?4:2)){
          slowmo = Math.max(slowmo, 6);
        }
        streakLine(f.x+10*f.face, f.y-40-Math.random()*50, Math.PI/2+f.face*0.3, 11, f.glo);
      }
      if (t>(A?28:24)) f.setState('idle');
    }
  } else { // ===== 青岚·竹 =====
    if (v==='n'){ // 飞叶刃:掷出旋转叶刃 → 觉醒:双连
      if (t===8 || (A && t===16)){
        projectiles.push({x:f.x+34*f.face, y:f.y-68, vx:11.5*f.face, dmg:A?7:5, kb:5, stun:16,
                          owner:f, life:80, c:f.glo, kind:'wind'});
        streakLine(f.x+20*f.face, f.y-68, f.face>0?0:Math.PI, 10, f.glo);
        beep(640,0.1,'sine',0.08,-220);
      }
      if (t>(A?26:20)) f.setState('idle');
    } else if (v==='up'){ // 竹影升:立棍上挑 → 觉醒:更高更痛
      if (t>=4 && t<=15){
        tryHit({x1:f.x-8*f.face, x2:f.x+(A?56:46)*f.face, y1:f.y-142, y2:f.y-26}, A?8:6, 2, A?28:24, A?12:10);
        streakLine(f.x+12*f.face, f.y-84-Math.random()*40, -Math.PI/2, 9, f.glo);
      }
      if (t>24) f.setState('idle');
    } else { // 盘根错节:戳地引竹根破土挑人 → 觉醒:更远更痛
      if (t===12){
        rings.push({x:f.x+70*f.face, y:GROUND-10, r:12, vr:A?8:6, life:14, c:f.glo});
        debris(f.x+70*f.face, GROUND, 4, '#7ec87e');
        dust(f.x+70*f.face, 3);
        beep(160,0.2,'sawtooth',0.13,40);
        const dxr = foe.x - f.x;
        if (dxr*f.face > 0 && Math.abs(dxr) < (A?200:150) && !foe.airborne && foe.state!=='ko'){
          f.hasHit = true;
          applyHit(foe, f, A?11:8, A?7:6, A?28:24, A?9:7);
        }
      }
      if (t>32) f.setState('idle');
    }
  }
}

// ---------- 大招（O,满气） ----------
function updateSuper(f, foe){
  const id = f.ch.id, t = f.st;
  // 大招全程气场
  if (frame%2===0) flame(f.x+(Math.random()*36-18), f.y-8-Math.random()*76, f.glo, 1, 10);
  if (id===0){ // 百裂连拳：多段快拳前压
    if (t>=10 && t<=58){
      f.x += 2.2*f.face;
      flame(f.x+78*f.face, f.y-72, '#ffe95e', 1, 22);
      if (t%8===0){
        const hb = norm({x1:f.x, x2:f.x+100*f.face, y1:f.y-105, y2:f.y-40});
        if (overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
          const fin = t>=50;
          applyHit(foe, f, 5, fin?12:2, 14, fin?5:0, true);
          if (fin){ screenFlash = Math.max(screenFlash, 0.3); screenFlashC = '#ffb23a';
                    rings.push({x:foe.x, y:foe.y-70, r:14, vr:8, life:16, c:'#ffe95e'}); }
        }
        impactBurst(f.x+80*f.face, f.y-72, '#ffe95e', false);
      }
    }
    if (t>72) f.setState('idle');
  } else if (id===1){ // 旋风连脚：移动旋踢
    if (t>=8 && t<=62){
      f.x += 4.5*f.face;
      const a = t*0.8;
      streakLine(f.x+Math.cos(a)*44, f.y-56+Math.sin(a)*26, a+Math.PI/2, 8, f.glo);
      streakLine(f.x-Math.cos(a)*44, f.y-56-Math.sin(a)*26, a-Math.PI/2, 8, '#ffffff');
      if (t%14===0) rings.push({x:f.x, y:f.y-56, r:20, vr:5, life:12, c:f.glo});
      if (t%9===0){
        const hb = {x1:f.x-70, x2:f.x+70, y1:f.y-105, y2:f.y-20};
        if (overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
          const fin = t>=54;
          applyHit(foe, f, 4, fin?11:2, 13, fin?6:0, true);
          if (fin){ screenFlash = Math.max(screenFlash, 0.3); screenFlashC = '#7ee6ff'; }
        }
      }
    }
    if (t>76) f.setState('idle');
  } else if (id===2){ // 天崩地裂：跳起砸地全场震击,跳起可躲
    if (t===20){ f.vy = -17; }
    if (t>20 && f.airborne) flame(f.x, f.y-20, '#ffc63a', 2, 20);   // 坠落火尾
    if (t>20 && !f.airborne && f.vy>=0 && !f.hasHit){
      f.hasHit = true;
      shake = 18; freeze = 12;
      beep(60,0.7,'sawtooth',0.3,-30);
      screenFlash = 0.5; screenFlashC = '#ffd75e';
      rings.push({x:f.x, y:GROUND-8, r:30, vr:14, life:22, c:'#ffe9a8'});
      rings.push({x:f.x, y:GROUND-8, r:10, vr:20, life:18, c:'#ffffff'});
      debris(f.x-120, GROUND, 8); debris(f.x+120, GROUND, 8);
      flame(f.x, GROUND-20, '#ffc63a', 16, 160);
      for(let i=0;i<24;i++) spark(f.x+(Math.random()*400-200), GROUND-10, '#ffe9a8', 1);
      if (!foe.airborne && foe.state!=='ko'){
        applyHit(foe, f, 24, 14, 34, 8, true);
      } else if (foe.airborne){
        floaters.push({x:foe.x, y:foe.y-130, txt:'躲开了!', c:'#8ef58e', t:0});
      }
    }
    if (t>20 && !f.airborne && f.hasHit && t>78) f.setState('idle');
    if (t>140) f.setState('idle');
  } else if (id===3){ // 一闪·万象：瞬步突进,居合大斩,命中定格闪屏
    // 前段拔刀蓄势 + 冲刺
    if (t < 16){
      f.vx = 0;
      if (t%3===0) flame(f.x, f.y-70, f.glo, 2, 18);
      if (t===2) superDark = Math.max(superDark, 40);
    } else if (t>=16 && t<=40){
      f.x += 15*f.face;
      streakLine(f.x-40*f.face, f.y-70-Math.random()*20, f.face>0?Math.PI:0, 16, '#ffffff');
      streakLine(f.x-30*f.face, f.y-50-Math.random()*40, f.face>0?Math.PI:0, 12, f.glo);
      // 多段斩
      if (t%6===0){
        const hb = norm({x1:f.x-20*f.face, x2:f.x+120*f.face, y1:f.y-110, y2:f.y-24});
        if (overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
          const fin = t>=36;
          applyHit(foe, f, fin?10:5, fin?13:2, fin?18:12, fin?8:0, true);
          impactBurst(foe.x, foe.y-70, '#ffffff', fin);
          if (fin){
            freeze = Math.max(freeze, 12); slowmo = Math.max(slowmo, 20);
            screenFlash = Math.max(screenFlash, 0.5); screenFlashC = f.glo;
            for(let i=0;i<20;i++) streakLine(foe.x, foe.y-70, Math.random()*Math.PI*2, 8+Math.random()*8, Math.random()<0.5?'#ffffff':f.glo);
          }
        }
      }
    }
    if (t>52) f.setState('idle');
  } else { // 万竹穿林：定身弓步,竹枪如林连突远程压制
    if (t>=12 && t<=60){
      if (t%5===0){
        streakLine(f.x+20*f.face, f.y-96+Math.random()*70, f.face>0?0:Math.PI, 14, Math.random()<0.5?'#ffffff':f.glo);
        rings.push({x:f.x+(140+Math.random()*110)*f.face, y:f.y-36-Math.random()*56, r:6, vr:4, life:10, c:f.glo});
      }
      if (t%8===0){
        const hb = norm({x1:f.x+10*f.face, x2:f.x+250*f.face, y1:f.y-108, y2:f.y-16});
        if (overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
          const fin = t>=52;
          applyHit(foe, f, 5, fin?13:2, 14, fin?7:0, true);
          impactBurst(foe.x, foe.y-70, f.glo, fin);
          if (fin){ screenFlash = Math.max(screenFlash, 0.32); screenFlashC = '#9dffb5';
                    rings.push({x:foe.x, y:foe.y-70, r:14, vr:8, life:16, c:f.glo}); }
        }
      }
    }
    if (t>74) f.setState('idle');
  }
}

// ---------- 身体推挤 ----------
function pushApart(a,b){
  const dx = b.x - a.x;
  if (Math.abs(dx) < 40 && Math.abs(a.y-b.y) < 90 && a.state!=='ko' && b.state!=='ko'){
    const push = (40 - Math.abs(dx))/2 * (dx>=0?1:-1);
    a.x -= push; b.x += push;
    a.x = Math.max(50, Math.min(W-50, a.x));
    b.x = Math.max(50, Math.min(W-50, b.x));
  }
}

// ---------- 回合流程 ----------
function updateFight(){
  const F = fight;
  F.pt++;

  if (F.phase==='intro'){
    if (F.pt > 110){ F.phase='play'; F.pt=0; }
  } else if (F.phase==='play'){
    F.time--;
    if (F.time <= 0){
      F.phase='ko'; F.pt=0;
      F.winner = F.p.hp === F.c.hp ? null : (F.p.hp > F.c.hp ? F.p : F.c);
      const loser = F.winner===F.p ? F.c : F.p;
      if (F.winner) loser.setState('ko');
    }
  } else if (F.phase==='ko'){
    if (F.pt === 70 && F.winner && F.winner.state!=='ko') F.winner.setState('win');
    if (F.pt > 140){
      if (F.winner) F.winner.wins++;
      if (F.p.wins>=2 || F.c.wins>=2){
        F.matchWinner = F.p.wins>=2 ? F.p : F.c;
        scene = 'matchEnd';
        syncGameUi();
      } else {
        F.round++;
        const pw=F.p.wins, cw=F.c.wins;
        const np = new Fighter(F.p.ch, 420, false);
        const nc = new Fighter(F.c.ch, 860, true);
        np.wins=pw; nc.wins=cw;
        np.meter = Math.min(50, F.p.meter); nc.meter = Math.min(50, F.c.meter);
        F.p=np; F.c=nc;
        F.phase='intro'; F.pt=0; F.time=60*60; F.winner=null;
        projectiles=[]; particles=[]; floaters=[]; rings=[];
        slowmo=0; zoomP=0;
      }
    }
  }

  if (F.phase==='play' || F.phase==='ko'){
    const pIt = (F.phase==='play' && !F.p.isCPU) ? playerIntents(F.p) : {};
    const cIt = (F.phase==='play') ? aiIntents(F.c, F.p, F.diff) : {};
    updateFighter(F.p, F.c, pIt);
    updateFighter(F.c, F.p, cIt);
    pushApart(F.p, F.c);
  }

  // 弹道
  for (const pr of projectiles){
    pr.x += pr.vx;
    if (pr.grav){
      pr.vy += pr.grav; pr.y += pr.vy;
      if (pr.y >= GROUND-10){   // 落地碎裂
        pr.y = GROUND-10; pr.life = 0;
        debris(pr.x, GROUND, 5); dust(pr.x, 3);
        shake = Math.max(shake, 3);
      }
    }
    pr.life--;
    const foe = pr.owner===F.p ? F.c : F.p;
    const sz = pr.kind==='wave' ? 28 : (pr.kind==='rock' ? (pr.big?22:15) : (pr.kind==='slash' ? 22 : 18));
    const hb = {x1:pr.x-sz, x2:pr.x+sz, y1:pr.y-sz-4, y2:pr.y+sz+4};
    if (pr.life>0 && overlap(hb, hurtbox(foe)) && foe.state!=='ko'){
      pr.life = 0;
      applyHit(foe, pr.owner, pr.dmg, pr.kb, pr.stun, 2);
      impactBurst(pr.x, pr.y, pr.c, false);
    }
    // 拖尾
    if (pr.kind==='wave'){
      flame(pr.x-14*Math.sign(pr.vx), pr.y+6, pr.c, 1, 12);
      if (frame%5===0) debris(pr.x, GROUND, 1);
    } else if (pr.kind==='fire'){
      flame(pr.x-10*Math.sign(pr.vx), pr.y, '#ff8844', 1, 8);
    } else if (pr.kind==='wind'){
      streakLine(pr.x-12*Math.sign(pr.vx), pr.y+(Math.random()*14-7), pr.vx>0?Math.PI:0, 9, pr.c);
    } else if (pr.kind==='slash'){
      streakLine(pr.x-16*Math.sign(pr.vx), pr.y+(Math.random()*10-5), pr.vx>0?Math.PI:0, 12, '#ffffff');
    } else if (pr.kind==='rock' && frame%3===0){
      spark(pr.x, pr.y, '#9a8a72', 1);
    }
  }
  projectiles = projectiles.filter(p=>p.life>0 && p.x>-50 && p.x<W+50);
}

// ================== 渲染 ==================
function draw(){
  ctx.save();
  if (preferences.reducedFx) shake=0;
  if (shake>0){
    ctx.translate((Math.random()-0.5)*shake*2, (Math.random()-0.5)*shake*2);
    shake *= 0.88; if (shake<0.5) shake=0;
  }
  if (zoomP>0.01){   // 大招镜头推近
    const z = 1 + 0.10*zoomP;
    ctx.translate(zoomX, zoomY); ctx.scale(z, z); ctx.translate(-zoomX, -zoomY);
    zoomP *= 0.94;
  } else zoomP = 0;
  drawBg();
  if (scene==='menu'){ drawMenu(); ctx.restore(); return; }
  if (scene==='stageSelect'){ drawStageSelect(); ctx.restore(); return; }
  // 大招暗幕 + 聚焦线
  if (superDark>0){
    const a = Math.min(1, superDark/16);
    ctx.fillStyle = `rgba(4,2,14,${0.55*a})`;
    ctx.fillRect(-40,-40,W+80,H+80);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.10*a;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    for(let i=0;i<18;i++){
      const an = i/18*Math.PI*2 + frame*0.012;
      ctx.beginPath();
      ctx.moveTo(zoomX+Math.cos(an)*140, zoomY+Math.sin(an)*140);
      ctx.lineTo(zoomX+Math.cos(an)*950, zoomY+Math.sin(an)*950);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawArena();
  ctx.restore();
  drawHud();
  drawContextTip();
  drawBanners();
  if (screenFlash>0.02){
    const flashAlpha=preferences.reducedFx?Math.min(0.12,screenFlash*0.24):Math.min(0.6,screenFlash);
    ctx.fillStyle = hexA(screenFlashC, flashAlpha);
    ctx.fillRect(0,0,W,H);
    screenFlash *= 0.90;
  } else screenFlash = 0;
  if (koFlash>0){
    const koAlpha=preferences.reducedFx?koFlash*0.12:koFlash*0.45;
    ctx.fillStyle = `rgba(255,240,220,${koAlpha})`;
    ctx.fillRect(0,0,W,H);
    koFlash -= 0.06; if (koFlash<0) koFlash=0;
  }
}

function drawContextTip(){
  const tip=contextTip();
  if (!tip) return;
  const w=touchMode?590:560, h=64, x=(W-w)/2, y=touchMode?438:548;
  ctx.save();
  ctx.fillStyle='rgba(8,8,14,.86)'; roundRect(x,y,w,h,10); ctx.fill();
  ctx.strokeStyle='rgba(255,190,112,.78)'; ctx.lineWidth=2; roundRect(x,y,w,h,10); ctx.stroke();
  ctx.textAlign='left';
  ctx.font='bold 17px "Microsoft YaHei",sans-serif'; ctx.fillStyle='#ffbf73';
  ctx.fillText(tip.title,x+18,y+25);
  ctx.font='15px "Microsoft YaHei",sans-serif'; ctx.fillStyle='#fff4e7';
  ctx.fillText(tip.text,x+18,y+49);
  ctx.restore();
}

function drawBanners(){
  for (const b of banners){
    const inA  = Math.min(1, b.t/5);
    const outA = b.t>42 ? Math.max(0, 1-(b.t-42)/14) : 1;
    const al = inA*outA;
    const sc = b.t<7 ? 1.5-0.5*(b.t/7) : 1;
    ctx.save();
    ctx.globalAlpha = al*0.22;
    ctx.fillStyle = b.c;
    ctx.fillRect(0, 198, W, 86);
    ctx.globalAlpha = al;
    ctx.translate(W/2, 256); ctx.scale(sc, sc);
    ctx.textAlign = 'center';
    ctx.font = 'bold 64px "Microsoft YaHei", sans-serif';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 8;
    ctx.strokeText(b.txt, 0, 0);
    const g = ctx.createLinearGradient(0,-44,0,18);
    g.addColorStop(0,'#ffffff'); g.addColorStop(1,b.c);
    ctx.fillStyle = g;
    ctx.fillText(b.txt, 0, 0);
    ctx.restore();
  }
}

function drawBg(){
  // 视差:跟随两名角色中点,远景动得慢
  const mid = fight ? (fight.p.x+fight.c.x)/2 - W/2 : 0;
  const par = k => -mid*k;
  const id = stage.id;

  if (id===0){ // ===== 落霞荒野 =====
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#1a1230'); g.addColorStop(0.55,'#4a2140'); g.addColorStop(0.8,'#8a3a35'); g.addColorStop(1,'#2a1520');
    ctx.fillStyle = g; ctx.fillRect(-20,-20,W+40,H+40);
    // 落日(最远层)
    ctx.save(); ctx.translate(par(0.03), 0);
    ctx.fillStyle = 'rgba(255,150,80,0.9)';
    ctx.beginPath(); ctx.arc(W/2, 430, 110, Math.PI, 0); ctx.fill();
    ctx.fillStyle = 'rgba(255,200,120,0.25)';
    ctx.beginPath(); ctx.arc(W/2, 430, 170, Math.PI, 0); ctx.fill();
    ctx.restore();
    // 远山
    ctx.save(); ctx.translate(par(0.08), 0);
    ctx.fillStyle = '#241428';
    ctx.beginPath(); ctx.moveTo(-80,470);
    ctx.lineTo(150,360); ctx.lineTo(320,450); ctx.lineTo(520,380); ctx.lineTo(700,460);
    ctx.lineTo(900,370); ctx.lineTo(1100,440); ctx.lineTo(W+80,390); ctx.lineTo(W+80,H+20); ctx.lineTo(-80,H+20);
    ctx.fill();
    ctx.restore();
    // 近景枯树(视差最大层)
    ctx.save(); ctx.translate(par(0.16), 0);
    ctx.strokeStyle = '#120a14'; ctx.lineWidth = 10; ctx.lineCap='round';
    for (const tx of [130, 1120]){
      ctx.beginPath(); ctx.moveTo(tx, GROUND); ctx.lineTo(tx-14, GROUND-150); ctx.stroke();
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(tx-8, GROUND-90); ctx.lineTo(tx-58, GROUND-150); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tx-12, GROUND-120); ctx.lineTo(tx+30, GROUND-190); ctx.stroke();
      ctx.lineWidth = 10;
    }
    ctx.restore();
  } else if (id===1){ // ===== 月夜天台 =====
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#060a1e'); g.addColorStop(0.6,'#101a38'); g.addColorStop(1,'#0a0d1c');
    ctx.fillStyle = g; ctx.fillRect(-20,-20,W+40,H+40);
    // 满月+星
    ctx.save(); ctx.translate(par(0.02), 0);
    ctx.fillStyle = 'rgba(230,238,255,0.95)';
    ctx.beginPath(); ctx.arc(980, 150, 64, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(200,215,255,0.12)';
    ctx.beginPath(); ctx.arc(980, 150, 100, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for(let i=0;i<40;i++){
      const sx=(i*331)%W, sy=(i*173)%330;
      ctx.globalAlpha = 0.25+0.5*Math.abs(Math.sin(i*7+frame*0.01));
      ctx.fillRect(sx, sy, 2, 2);
    }
    ctx.globalAlpha=1; ctx.restore();
    // 远景城市天际线
    ctx.save(); ctx.translate(par(0.06), 0);
    ctx.fillStyle = '#0d1428';
    for(let i=0;i<14;i++){
      const bx=-40+i*100, bh2=120+((i*97)%140);
      ctx.fillRect(bx, 480-bh2, 74, bh2+40);
    }
    // 亮窗
    ctx.fillStyle = 'rgba(255,220,130,0.5)';
    for(let i=0;i<48;i++){
      const bi=(i*7)%14, bx=-40+bi*100, bh2=120+((bi*97)%140);
      ctx.fillRect(bx+8+((i*13)%56), 480-bh2+10+((i*31)%(bh2-24)), 6, 8);
    }
    ctx.restore();
    // 中景霓虹楼
    ctx.save(); ctx.translate(par(0.11), 0);
    ctx.fillStyle = '#141c36';
    ctx.fillRect(60, 330, 150, 310); ctx.fillRect(1030, 300, 180, 340);
    ctx.strokeStyle = 'rgba(62,207,255,0.6)'; ctx.lineWidth=3;
    ctx.strokeRect(60, 330, 150, 310); ctx.strokeRect(1030, 300, 180, 340);
    ctx.fillStyle = frame%80<40 ? 'rgba(255,80,180,0.8)' : 'rgba(255,80,180,0.4)';
    ctx.fillRect(80, 350, 110, 16);
    ctx.fillStyle = frame%60<30 ? 'rgba(62,207,255,0.8)' : 'rgba(62,207,255,0.35)';
    ctx.fillRect(1050, 326, 140, 14);
    ctx.restore();
    // 近景天台围栏
    ctx.save(); ctx.translate(par(0.18), 0);
    ctx.strokeStyle = 'rgba(120,140,190,0.5)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-80, GROUND-64); ctx.lineTo(W+80, GROUND-64); ctx.stroke();
    for(let i=0;i<24;i++){
      const fx=-80+i*64;
      ctx.beginPath(); ctx.moveTo(fx, GROUND-64); ctx.lineTo(fx, GROUND); ctx.stroke();
    }
    ctx.restore();
  } else if (id===2){ // ===== 雪岭神社 =====
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#2a3448'); g.addColorStop(0.55,'#586a86'); g.addColorStop(0.85,'#9aabc0'); g.addColorStop(1,'#42526a');
    ctx.fillStyle = g; ctx.fillRect(-20,-20,W+40,H+40);
    // 远雪山
    ctx.save(); ctx.translate(par(0.05), 0);
    ctx.fillStyle = '#d8e4f0';
    ctx.beginPath(); ctx.moveTo(-80,520);
    ctx.lineTo(220,270); ctx.lineTo(430,470); ctx.lineTo(660,300); ctx.lineTo(920,490);
    ctx.lineTo(1140,330); ctx.lineTo(W+80,470); ctx.lineTo(W+80,H+20); ctx.lineTo(-80,H+20);
    ctx.fill();
    ctx.fillStyle = 'rgba(90,110,140,0.5)';
    ctx.beginPath(); ctx.moveTo(220,270); ctx.lineTo(300,340); ctx.lineTo(180,345); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(660,300); ctx.lineTo(740,375); ctx.lineTo(600,378); ctx.closePath(); ctx.fill();
    ctx.restore();
    // 中景雪杉
    ctx.save(); ctx.translate(par(0.1), 0);
    for (const [tx,ts] of [[90,1],[230,0.7],[1060,0.9],[1190,0.65]]){
      ctx.fillStyle = '#31445c';
      for(let l=0;l<3;l++){
        const w2=(58-l*13)*ts, ty=GROUND-40-(30+l*44)*ts;
        ctx.beginPath(); ctx.moveTo(tx, ty-52*ts); ctx.lineTo(tx-w2, ty); ctx.lineTo(tx+w2, ty); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = 'rgba(235,244,255,0.85)';
      for(let l=0;l<3;l++){
        const w2=(50-l*12)*ts, ty=GROUND-44-(30+l*44)*ts;
        ctx.beginPath(); ctx.moveTo(tx, ty-40*ts); ctx.lineTo(tx-w2*0.7, ty-10*ts); ctx.lineTo(tx+w2*0.7, ty-10*ts); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
    // 近景鸟居
    ctx.save(); ctx.translate(par(0.15), 0);
    ctx.strokeStyle = '#a83232'; ctx.lineWidth = 16; ctx.lineCap='butt';
    ctx.beginPath(); ctx.moveTo(560, GROUND); ctx.lineTo(552, GROUND-240); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(720, GROUND); ctx.lineTo(728, GROUND-240); ctx.stroke();
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.moveTo(500, GROUND-238); ctx.lineTo(780, GROUND-238); ctx.stroke();
    ctx.lineWidth = 20;
    ctx.beginPath(); ctx.moveTo(478, GROUND-276); ctx.lineTo(802, GROUND-276); ctx.stroke();
    ctx.fillStyle = 'rgba(235,244,255,0.9)';   // 横梁积雪
    ctx.fillRect(478, GROUND-290, 324, 7);
    ctx.restore();
  } else { // ===== 熔岩洞窟 =====
    const g = ctx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#170a08'); g.addColorStop(0.6,'#301008'); g.addColorStop(0.92,'#7a2408'); g.addColorStop(1,'#40140a');
    ctx.fillStyle = g; ctx.fillRect(-20,-20,W+40,H+40);
    // 洞顶钟乳石
    ctx.save(); ctx.translate(par(0.04), 0);
    ctx.fillStyle = '#20100c';
    for(let i=0;i<12;i++){
      const sx=-40+i*118, sl=50+((i*67)%110);
      ctx.beginPath(); ctx.moveTo(sx-32,-10); ctx.lineTo(sx+32,-10); ctx.lineTo(sx, sl); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // 远景熔岩瀑布
    ctx.save(); ctx.translate(par(0.07), 0);
    const lg = ctx.createLinearGradient(0,240,0,560);
    lg.addColorStop(0,'rgba(255,140,40,0.85)'); lg.addColorStop(1,'rgba(255,60,10,0.4)');
    ctx.fillStyle = lg;
    ctx.fillRect(180, 240, 26, 320); ctx.fillRect(1080, 200, 34, 360);
    ctx.fillStyle = 'rgba(255,220,140,0.7)';
    ctx.fillRect(186+Math.sin(frame*0.1)*3, 240, 7, 320);
    ctx.fillRect(1090+Math.sin(frame*0.13)*4, 200, 8, 360);
    ctx.restore();
    // 中景岩壁
    ctx.save(); ctx.translate(par(0.1), 0);
    ctx.fillStyle = '#241009';
    ctx.beginPath(); ctx.moveTo(-80,560);
    ctx.lineTo(120,430); ctx.lineTo(300,540); ctx.lineTo(540,450) ;ctx.lineTo(760,555);
    ctx.lineTo(980,440); ctx.lineTo(1180,545); ctx.lineTo(W+80,470); ctx.lineTo(W+80,H+20); ctx.lineTo(-80,H+20);
    ctx.fill();
    // 岩缝熔岩光
    ctx.strokeStyle = 'rgba(255,120,30,'+(0.4+0.25*Math.sin(frame*0.05))+')'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(220,530); ctx.lineTo(300,480); ctx.lineTo(390,545); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(820,540); ctx.lineTo(950,470); ctx.lineTo(1060,530); ctx.stroke();
    ctx.restore();
  }

  // 氛围粒子(全场景通用容器)
  for (const e of embers){
    ctx.globalAlpha = e.a * Math.min(1, e.life/60);
    ctx.fillStyle = e.c;
    ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 地面
  const grounds = ['#171019', '#131722', '#e8eef8', '#1c0e08'];
  const groundLines = ['rgba(255,160,90,0.25)', 'rgba(120,160,255,0.3)', 'rgba(140,160,200,0.5)', 'rgba(255,120,40,0.5)'];
  ctx.fillStyle = grounds[id];
  ctx.fillRect(-20, GROUND, W+40, H-GROUND+20);
  ctx.strokeStyle = groundLines[id]; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-20,GROUND); ctx.lineTo(W+20,GROUND); ctx.stroke();
  // 地板线
  ctx.strokeStyle = id===2 ? 'rgba(100,120,160,0.15)' : 'rgba(255,255,255,0.05)'; ctx.lineWidth=1;
  for(let i=0;i<10;i++){
    const y = GROUND + 8 + i*8;
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
  }
  // 熔岩地面裂纹光
  if (id===3){
    ctx.strokeStyle = 'rgba(255,140,50,'+(0.25+0.15*Math.sin(frame*0.06))+')'; ctx.lineWidth=2;
    for (const cx of [200, 560, 950]){
      ctx.beginPath(); ctx.moveTo(cx, GROUND+6); ctx.lineTo(cx+40, GROUND+30); ctx.lineTo(cx+18, GROUND+56); ctx.stroke();
    }
  }
  if (scene!=='menu') drawStagePlatforms(id);
}

function drawStagePlatforms(id){
  for (const p of stage.platforms){
    ctx.save();
    if (p.kind==='stone'){
      ctx.fillStyle='#2a1b24';
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.w,p.y);
      ctx.lineTo(p.x+p.w-24,p.y+42); ctx.lineTo(p.x+20,p.y+54); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='rgba(255,174,112,.65)'; ctx.lineWidth=4;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.w,p.y); ctx.stroke();
      ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(p.x+38,p.y+12); ctx.lineTo(p.x+78,p.y+32); ctx.lineTo(p.x+118,p.y+9); ctx.stroke();
    } else if (p.kind==='roof'){
      ctx.fillStyle='#12182a'; ctx.fillRect(p.x,p.y,p.w,34);
      ctx.fillStyle='#202a44'; ctx.fillRect(p.x+15,p.y+34,p.w-30,GROUND-p.y-34);
      ctx.strokeStyle='rgba(76,213,255,.78)'; ctx.lineWidth=4;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.w,p.y); ctx.stroke();
      ctx.fillStyle='rgba(255,80,180,.42)';
      for(let x=p.x+24;x<p.x+p.w-18;x+=52) ctx.fillRect(x,p.y+13,28,4);
    } else if (p.kind==='shrine'){
      ctx.fillStyle='#54252a'; ctx.fillRect(p.x,p.y,p.w,28);
      ctx.fillStyle='#7a3833';
      for(let x=p.x+24;x<p.x+p.w-18;x+=58) ctx.fillRect(x,p.y+28,15,GROUND-p.y-28);
      ctx.fillStyle='#f0f5fb';
      ctx.beginPath(); ctx.moveTo(p.x-5,p.y-8); ctx.lineTo(p.x+p.w+5,p.y-8);
      ctx.lineTo(p.x+p.w,p.y+2); ctx.lineTo(p.x,p.y+2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='#bd4b42'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(p.x,p.y+2); ctx.lineTo(p.x+p.w,p.y+2); ctx.stroke();
    } else if (p.kind==='snow'){
      ctx.fillStyle='#617188';
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.w,p.y);
      ctx.lineTo(p.x+p.w-28,GROUND); ctx.lineTo(p.x+18,GROUND); ctx.closePath(); ctx.fill();
      ctx.fillStyle='#edf4fb';
      ctx.beginPath(); ctx.moveTo(p.x-4,p.y); ctx.quadraticCurveTo(p.x+p.w*.45,p.y-20,p.x+p.w+4,p.y);
      ctx.lineTo(p.x+p.w,p.y+9); ctx.lineTo(p.x,p.y+9); ctx.closePath(); ctx.fill();
    } else { // basalt
      ctx.fillStyle='#25110d';
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.w,p.y);
      ctx.lineTo(p.x+p.w-30,GROUND); ctx.lineTo(p.x+22,GROUND); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='rgba(255,126,38,.9)'; ctx.lineWidth=4;
      ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+p.w,p.y); ctx.stroke();
      ctx.strokeStyle='rgba(255,92,24,.5)'; ctx.lineWidth=2;
      for(let x=p.x+48;x<p.x+p.w-30;x+=86){
        ctx.beginPath(); ctx.moveTo(x,p.y+10); ctx.lineTo(x+18,p.y+32); ctx.lineTo(x+8,p.y+58); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// ---------- 火柴人 ----------
function seg(x1,y1,x2,y2,w,c){
  ctx.strokeStyle=c; ctx.lineWidth=w; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
}
function limb(x1,y1,x2,y2,bx,by,w,c){
  ctx.strokeStyle=c; ctx.lineWidth=w; ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.beginPath(); ctx.moveTo(x1,y1);
  ctx.lineTo((x1+x2)/2+bx,(y1+y2)/2+by);
  ctx.lineTo(x2,y2); ctx.stroke();
}

function drawFighter(f){
  const d = f.face, t = f.st;
  const c = f.flashT>0 ? '#ffffff' : f.col;
  const glowC = f.flashT>0 ? '#ffffff' : f.glo;
  const x = f.x, y = f.y;
  const lw = 7;

  // 残影
  for (let i=1;i<f.trail.length;i++){
    const tr = f.trail[i];
    ctx.globalAlpha = 0.16 - i*0.028;
    seg(tr.x, tr.y-46, tr.x, tr.y-92, lw, f.glo);
    ctx.fillStyle = f.glo;
    ctx.beginPath(); ctx.arc(tr.x, tr.y-104, 12, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 受身无敌:半透明闪烁提示
  const invulFlicker = f.iFrames > 0;
  if (invulFlicker) ctx.globalAlpha = 0.55 + 0.25*Math.sin(frame*0.55);

  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(x, f.floorY+6, 34*Math.max(0.4,1-(f.floorY-y)/300), 7, 0, 0, Math.PI*2);
  ctx.fill();

  // 满气光环 / 觉醒常驻光环
  if (f.awakened && f.state!=='ko'){
    const p = 0.5+0.5*Math.sin(frame*0.25);
    ctx.fillStyle = hexA(f.ch.awk.color, 0.13+0.09*p);
    ctx.beginPath(); ctx.ellipse(x, y-52, 52+8*p, 74+8*p, 0, 0, Math.PI*2); ctx.fill();
  } else if (f.meter>=100 && f.state!=='ko'){
    const p = 0.5+0.5*Math.sin(frame*0.2);
    ctx.fillStyle = hexA(f.glo, 0.10+0.08*p);
    ctx.beginPath(); ctx.ellipse(x, y-52, 46+6*p, 66+6*p, 0, 0, Math.PI*2); ctx.fill();
  }

  // 关节目标（相对脚底原点）
  let hip={x:0,y:-48}, neck={x:0,y:-92};
  let hf={x:d*22,y:-76}, hb={x:d*8,y:-66};       // 手 front/back
  let ff={x:d*11,y:0},  fb={x:-d*11,y:0};        // 脚 front/back
  let headO={x:0,y:-12};
  const bob = Math.sin(frame*0.1)*1.5;

  const atkPhase = (a)=>{
    if (!a) return 0;
    if (t < a.startup) return t/a.startup;
    if (t < a.startup+a.active) return 1;
    return Math.max(0, 1-(t-a.startup-a.active)/a.recover);
  };

  switch(f.state){
    case 'idle': neck.y+=bob*0.4; hip.y+=bob*0.2; hf.y+=bob*0.5; hb.y+=bob*0.5; break;
    case 'walk': {
      const w = Math.sin(frame*0.28);
      ff={x:d*11+w*16, y:-Math.max(0,w)*9};
      fb={x:-d*11-w*16, y:-Math.max(0,-w)*9};
      hf={x:d*20-w*6, y:-74}; hb={x:d*6+w*6, y:-66};
      break;
    }
    case 'dash': {
      const dd = f.dashDir;
      neck.x=dd*14; hip.x=dd*6;
      ff={x:dd*30,y:-6}; fb={x:-dd*24,y:-4};
      hf={x:dd*30,y:-70}; hb={x:-dd*16,y:-78};
      break;
    }
    case 'jump': {
      ff={x:d*12,y:-20}; fb={x:-d*6,y:-26};
      hf={x:d*26,y:-84}; hb={x:-d*10,y:-72};
      if (f.atk){ // 空中踢
        const p=atkPhase(f.atk);
        ff={x:d*(14+62*p), y:-46*p-12};
        neck.x=-d*8*p;
      }
      break;
    }
    case 'attack': {
      const a = f.atk, p = atkPhase(a), R = a?a.range:70;
      switch(a && a.pose){
        case 'jab':
          hf={x:d*(18+(R-14)*p), y:-78};
          hb={x:d*4,y:-64};
          neck.x=d*8*p; hip.x=d*4*p;
          fb={x:-d*(11+7*p),y:0};
          break;
        case 'cross':
          hb={x:d*(14+(R-10)*p), y:-74};
          hf={x:d*12,y:-82};
          neck.x=d*13*p; hip.x=d*7*p;
          fb={x:-d*(11+10*p),y:0};
          break;
        case 'kick':
          ff={x:d*(12+(R-16)*p), y:-56*p};
          neck.x=-d*11*p;
          hf={x:d*14,y:-80}; hb={x:-d*14,y:-70};
          break;
        case 'bigkick':
          ff={x:d*(12+(R-14)*p), y:-70*p};
          neck.x=-d*17*p; hip.x=-d*4*p;
          hf={x:d*18,y:-82}; hb={x:-d*18,y:-66};
          break;
        case 'upper':
          hf={x:d*(10+16*p), y:-42-84*p};
          hb={x:-d*8,y:-60};
          neck.x=-d*4*p; neck.y=-92-6*p;
          hip.y=-48+6*p;
          fb={x:-d*(11+6*p),y:0};
          break;
        case 'sweep':
          hip.y=-26; neck.y=-62; neck.x=d*6;
          headO={x:d*4,y:-11};
          ff={x:d*(16+(R-22)*p), y:0};
          fb={x:-d*8,y:0};
          hf={x:d*16,y:-42}; hb={x:-d*10,y:-36};
          break;
      }
      break;
    }
    case 'block': {
      hip.y=-44; neck.y=-86;
      hf={x:d*20,y:-80}; hb={x:d*22,y:-62};
      break;
    }
    case 'hit': {
      neck.x=-d*15; hip.x=-d*4;
      hf={x:-d*6,y:-84}; hb={x:d*4,y:-58};
      ff={x:d*16,y:0};
      if (f.isBlockstun){ neck.x=-d*6; hf={x:d*20,y:-80}; hb={x:d*22,y:-62}; }
      else if (f.airborne){
        neck.x=-d*18; hip.x=-d*4;
        hf={x:-d*16,y:-92}; hb={x:d*8,y:-70};
        ff={x:d*18,y:-16}; fb={x:-d*6,y:-20};
      }
      break;
    }
    case 'ko': {
      if (f.airborne){
        neck.x=-d*18; hip.x=-d*2;
        hf={x:-d*20,y:-96}; hb={x:d*10,y:-88};
        ff={x:d*18,y:-14}; fb={x:-d*4,y:-18};
      } else {
        hip={x:-d*6,y:-10}; neck={x:-d*40,y:-14};
        headO={x:-d*12,y:-4};
        hf={x:-d*52,y:-2}; hb={x:-d*30,y:-18};
        ff={x:d*22,y:-4}; fb={x:d*32,y:-8};
      }
      break;
    }
    case 'win': {
      const p=Math.min(1,t/20);
      hf={x:d*10,y:-92-28*p}; hb={x:-d*14,y:-70};
      neck.y=-94; break;
    }
    case 'roll': {
      // 蜷身翻滚:整体压低,四肢收拢
      const rd = f.rollDir;
      hip={x:0,y:-30}; neck={x:rd*10,y:-52};
      headO={x:rd*6,y:-10};
      hf={x:rd*20,y:-30}; hb={x:rd*6,y:-40};
      ff={x:rd*24,y:-8}; fb={x:-rd*6,y:-2};
      break;
    }
    case 'awaken': {
      // 仰天蓄力 → 爆发张开
      const p=Math.min(1,t/24);
      if (t<24){
        hip.y=-42; neck.y=-84+4*Math.sin(t*0.5);
        hf={x:d*14,y:-52-10*p}; hb={x:-d*14,y:-52-10*p};
        ff={x:d*16,y:0}; fb={x:-d*16,y:0};
        headO={x:0,y:-14};
      } else {
        hip.y=-50; neck.y=-96;
        hf={x:d*30,y:-108}; hb={x:-d*30,y:-108};
        ff={x:d*18,y:0}; fb={x:-d*18,y:0};
        headO={x:0,y:-15};
      }
      break;
    }
    case 'special': {
      const id=f.ch.id, v=f.spVar;
      if (v==='up'){ // 三人升龙系通用：拳/腿/掌向天
        if (id===1){ // 旋风升踢：腿画圈
          const sp=t*0.6;
          ff={x:Math.cos(sp)*50, y:-60+Math.sin(sp)*25};
          fb={x:-Math.cos(sp)*35, y:-40-Math.sin(sp)*15};
          hf={x:d*10,y:-90}; hb={x:-d*10,y:-80};
        } else if (id===2){ // 崩岳掌：双掌上托
          const p=Math.min(1,t/12);
          hf={x:d*(20+8*p),y:-70-56*p}; hb={x:d*(8+6*p),y:-66-52*p};
          neck.y=-94-4*p; hip.y=-50;
          fb={x:-d*16,y:0};
        } else { // 升龙焰
          const p=Math.min(1,t/8);
          hf={x:d*(12+14*p), y:-40-92*p};
          hb={x:-d*10,y:-56};
          neck.y=-94-6*p;
          ff={x:d*10,y:-14*p}; fb={x:-d*8,y:-8*p};
        }
      } else if (v==='down'){ // 滑铲/滑踢/震跺
        if (id===2){ // 震山跺
          if (t<16){ ff={x:d*8,y:-52}; hf={x:d*18,y:-96}; hb={x:-d*12,y:-92}; neck.y=-96; }
          else { ff={x:d*12,y:0}; hf={x:d*24,y:-40}; hb={x:-d*16,y:-44}; hip.y=-40; neck.y=-84; }
        } else {
          hip.y=-28; hip.x=d*2; neck.y=-60; neck.x=d*12;
          headO={x:d*5,y:-11};
          ff={x:d*46,y:0}; fb={x:d*10,y:0};
          hf={x:d*20,y:-44}; hb={x:-d*16,y:-30};
        }
      } else { // n 系
        if (id===0){
          hf={x:d*88,y:-78}; hb={x:-d*10,y:-60};
          neck.x=d*16; hip.x=d*10; fb={x:-d*30,y:0}; ff={x:d*16,y:0};
        } else if (id===1){
          ff={x:d*52,y:-58}; fb={x:d*30,y:-40};
          neck.x=-d*14; hip.x=d*4;
          hf={x:-d*16,y:-88}; hb={x:-d*6,y:-70};
        } else if (id===4){ // 横扫千军:双臂平旋
          const sp=t*0.55;
          hf={x:Math.cos(sp)*46, y:-70+Math.sin(sp)*16};
          hb={x:-Math.cos(sp)*46, y:-70-Math.sin(sp)*16};
          ff={x:d*16,y:0}; fb={x:-d*16,y:0};
        } else {
          const p=Math.min(1,t/14);
          if (t<14){ hf={x:d*8,y:-100-14*p}; hb={x:-d*4,y:-100-14*p}; }
          else { hf={x:d*30,y:-30}; hb={x:d*22,y:-32}; neck.x=d*10; hip.y=-42; }
        }
      }
      break;
    }
    case 'uskill': {
      const id=f.ch.id, v=f.uVar;
      if (v==='up'){ // 快速上挑系
        const p=Math.min(1,t/6);
        hf={x:d*(12+14*p), y:-44-86*p};
        hb={x:-d*8,y:-58};
        neck.y=-92-4*p;
        fb={x:-d*(11+6*p),y:0};
      } else if (v==='down'){
        if (id===2){ // 岩踏
          if (t<14){ ff={x:d*10,y:-48}; hf={x:d*16,y:-92}; hb={x:-d*10,y:-88}; }
          else { ff={x:d*16,y:0}; hf={x:d*26,y:-44}; hb={x:-d*14,y:-48}; hip.y=-42; neck.y=-86; }
        } else if (id===1){ // 残影突
          neck.x=d*16; hip.x=d*8;
          hf={x:d*44,y:-70}; hb={x:-d*20,y:-60};
          ff={x:d*30,y:-4}; fb={x:-d*22,y:0};
        } else { // 火地刺:蹲身按地
          hip.y=-32; neck.y=-66; neck.x=d*8;
          hf={x:d*34,y:-8}; hb={x:d*10,y:-30};
          ff={x:d*20,y:0}; fb={x:-d*12,y:0};
        }
      } else { // n 投掷系
        const p=Math.min(1,t/10);
        if (id===2){ // 飞石:过顶抛
          hf={x:d*(t<14? -10+50*p : 46), y:t<14? -110+40*p : -80};
          hb={x:-d*8,y:-64};
          neck.x=d*10*p; hip.x=d*4*p;
        } else { // 炎弹/风刃:单手前推
          hf={x:d*(14+34*p), y:-76};
          hb={x:-d*(6+8*p),y:-62};
          neck.x=d*9*p; hip.x=d*4*p;
          fb={x:-d*(11+8*p),y:0};
        }
      }
      break;
    }
    case 'super': {
      if (f.ch.id===0){
        const fl = Math.sin(t*1.4);
        hf={x:d*(50+40*Math.max(0,fl)), y:-78};
        hb={x:d*(50+40*Math.max(0,-fl)), y:-70};
        neck.x=d*12; hip.x=d*6;
      } else if (f.ch.id===1){
        const sp = t*0.55;
        ff={x:Math.cos(sp)*55, y:-55+Math.sin(sp)*20};
        fb={x:-Math.cos(sp)*40, y:-40-Math.sin(sp)*15};
        hf={x:Math.cos(sp+2)*35,y:-85}; hb={x:-Math.cos(sp+2)*35,y:-75};
      } else if (f.ch.id===4){ // 万竹穿林:弓步连突
        const th = Math.max(0, Math.sin(t*1.1));
        hf={x:d*(46+42*th), y:-72};
        hb={x:d*(10+16*th), y:-64};
        neck.x=d*14; hip.x=d*8;
        ff={x:d*26,y:0}; fb={x:-d*22,y:0};
      } else {
        if (t<20){ hf={x:d*8,y:-112}; hb={x:-d*6,y:-112}; }
        else if (f.airborne){ hf={x:d*10,y:-116}; hb={x:-d*8,y:-116}; ff={x:d*10,y:-24}; fb={x:-d*8,y:-20}; }
        else { hf={x:d*36,y:-16}; hb={x:d*28,y:-18}; neck.x=d*12; hip.y=-40; hip.x=d*6; }
      }
      break;
    }
  }

  // 世界坐标
  const P = o => ({x:x+o.x, y:y+o.y});
  const nH=P(neck), hP=P(hip);
  const head = {x:nH.x+headO.x*0.4+(neck.x-hip.x)*0.15, y:nH.y+headO.y};

  // 躯干
  seg(hP.x, hP.y, nH.x, nH.y, lw, c);
  // 腿
  const FF=P(ff), FB=P(fb);
  limb(hP.x,hP.y, FB.x,FB.y, -d*5, 4, lw, c);
  limb(hP.x,hP.y, FF.x,FF.y, d*5, 4, lw, c);
  // 手臂
  const HF=P(hf), HB=P(hb);
  limb(nH.x,nH.y-2, HB.x,HB.y, -d*4, 6, lw-1, c);
  limb(nH.x,nH.y-2, HF.x,HF.y, d*4, 6, lw-1, c);
  // 居合·刹的刀:从前手沿手臂方向延伸
  if (f.ch.id===3){
    const sx = nH.x+d*4, sy = nH.y-2;   // 肩
    let bx = HF.x - sx, by = HF.y - sy;
    let bl = Math.hypot(bx,by) || 1;
    bx/=bl; by/=bl;
    const bladeLen = f.awakened ? 62 : 52;
    const gx = HF.x, gy = HF.y;                       // 握柄处
    const tx = gx + bx*bladeLen, ty = gy + by*bladeLen;  // 刀尖
    // 刀身发光
    ctx.save(); ctx.globalCompositeOperation='lighter';
    ctx.strokeStyle = hexA(glowC, 0.6); ctx.lineWidth = 6; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(gx,gy); ctx.lineTo(tx,ty); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#eef0ff'; ctx.lineWidth = 3; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(gx,gy); ctx.lineTo(tx,ty); ctx.stroke();
    // 护手
    ctx.strokeStyle = glowC; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(gx-by*7, gy+bx*7); ctx.lineTo(gx+by*7, gy-bx*7); ctx.stroke();
  }
  // 青岚·竹的长棍:握于前手,沿手臂方向双向延伸
  if (f.ch.id===4){
    const sx = nH.x+d*4, sy = nH.y-2;   // 肩
    let bx = HF.x - sx, by = HF.y - sy;
    let bl = Math.hypot(bx,by) || 1;
    bx/=bl; by/=bl;
    const x1 = HF.x - bx*46, y1 = HF.y - by*46;   // 棍尾
    const x2 = HF.x + bx*(f.awakened?74:64), y2 = HF.y + by*(f.awakened?74:64); // 棍头
    ctx.save(); ctx.globalCompositeOperation='lighter';
    ctx.strokeStyle = hexA(glowC, 0.45); ctx.lineWidth = 6; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#d8bd8a'; ctx.lineWidth = 3.5; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    // 两端青玉色包头
    ctx.strokeStyle = glowC; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(x2-bx*9,y2-by*9); ctx.lineTo(x2,y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x1+bx*9,y1+by*9); ctx.stroke();
  }
  // 头
  ctx.fillStyle = c;
  ctx.beginPath(); ctx.arc(head.x, head.y, 13, 0, Math.PI*2); ctx.fill();
  // 头带
  ctx.strokeStyle = glowC; ctx.lineWidth=3;
  ctx.beginPath(); ctx.moveTo(head.x-13,head.y-3); ctx.lineTo(head.x+13,head.y-3); ctx.stroke();
  const bandL = f.awakened ? 34 : 20;   // 觉醒后飘带更长更飘
  seg(head.x-d*12, head.y-3, head.x-d*(bandL+Math.sin(frame*0.3)*(f.awakened?7:3)), head.y+2+(f.awakened?Math.sin(frame*0.22)*4:0), 2.5, glowC);
  if (invulFlicker) ctx.globalAlpha = 1;
}

function hexA(hex, a){
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ---------- 场景绘制 ----------
function drawArena(){
  const F = fight;
  // 替身留下的木桩短暂显示在原位置，帮助玩家读懂位置交换
  for (const d of decoys){
    const a=Math.max(0,d.life/34);
    ctx.save(); ctx.globalAlpha=a;
    ctx.translate(d.x,d.y);
    ctx.fillStyle='#8d5b32'; ctx.fillRect(-12,-72,24,66);
    ctx.fillStyle='#c99052'; ctx.fillRect(-8,-68,7,58);
    ctx.strokeStyle=d.c; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(-18,-52); ctx.lineTo(18,-52); ctx.stroke();
    ctx.fillStyle='#6b3d25';
    ctx.beginPath(); ctx.ellipse(0,-72,14,6,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
  // 弹道
  for (const pr of projectiles){
    const dir = Math.sign(pr.vx);
    if (pr.kind==='rock'){
      const rs = pr.big ? 15 : 9;
      ctx.fillStyle = pr.c;
      ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(frame*0.25*dir);
      ctx.fillRect(-rs,-rs,rs*2,rs*2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-rs,rs*0.25,rs*2,rs*0.75);
      ctx.restore();
    } else if (pr.kind==='wind'){
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = pr.c; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 16, frame*0.4, frame*0.4+Math.PI*1.3); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 10, -frame*0.5, -frame*0.5+Math.PI*1.2); ctx.stroke();
      ctx.restore();
    } else if (pr.kind==='fire'){
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexA('#ff8844', 0.35);
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 20+Math.sin(frame*0.5)*3, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = hexA('#ffcc66', 0.8);
      ctx.beginPath(); ctx.arc(pr.x, pr.y, 11, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(pr.x+3*dir, pr.y, 5, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    } else if (pr.kind==='slash'){   // 飞燕刃:新月形刀气
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexA(pr.c, 0.5); ctx.lineWidth = 8; ctx.lineCap='round';
      ctx.beginPath(); ctx.arc(pr.x-6*dir, pr.y, 20, -0.9, 0.9); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(pr.x-6*dir, pr.y, 20, -0.7, 0.7); ctx.stroke();
      ctx.restore();
    } else { // wave 裂地震波
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hexA(pr.c, 0.3);
      ctx.beginPath(); ctx.ellipse(pr.x, pr.y, 42, 32, 0, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = hexA(pr.c, 0.75);
      ctx.beginPath();
      ctx.moveTo(pr.x+30*dir, pr.y);
      ctx.lineTo(pr.x-22*dir, pr.y-27);
      ctx.lineTo(pr.x-10*dir, pr.y);
      ctx.lineTo(pr.x-22*dir, pr.y+27);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.ellipse(pr.x+8*dir, pr.y, 10, 8, 0, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
  }
  drawFighter(F.p);
  drawFighter(F.c);

  // 冲击环
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const r of rings){
    const a = Math.max(0, r.life/22);
    ctx.globalAlpha = a*0.85;
    ctx.strokeStyle = r.c; ctx.lineWidth = 3+r.life*0.25;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r*0.45, 0, 0, Math.PI*2); ctx.stroke();
    ctx.globalAlpha = a*0.5;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r*0.8, r.r*0.36, 0, 0, Math.PI*2); ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // 粒子(分类型渲染,发光类用叠加混合)
  for (const p of particles){
    const a = Math.max(0, p.life/(p.max||20));
    if (p.type==='flame' || p.type==='streak' || p.type==='flash') ctx.globalCompositeOperation = 'lighter';
    if (p.type==='streak'){
      ctx.globalAlpha = a*0.9;
      ctx.strokeStyle = p.c; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx*2.6, p.y - p.vy*2.6);
      ctx.stroke();
    } else if (p.type==='flash'){
      const pr2 = p.r * (1 + (1-a)*1.3);
      ctx.globalAlpha = a*0.75;
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, pr2, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(p.x, p.y, pr2*0.45, 0, Math.PI*2); ctx.fill();
    } else if (p.type==='debris'){
      ctx.globalAlpha = Math.min(1, a*1.5);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x-p.r, p.y-p.r, p.r*2, p.r*2);
    } else if (p.type==='smoke'){
      ctx.globalAlpha=a*0.56;
      ctx.fillStyle=p.c;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r*(1+(1-a)*.7),0,Math.PI*2); ctx.fill();
    } else { // spark / flame
      ctx.globalAlpha = p.type==='flame' ? a*0.8 : a;
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.globalAlpha = 1;
  // 飘字
  ctx.textAlign='center';
  for (const fl of floaters){
    ctx.globalAlpha = Math.max(0, 1-fl.t/50);
    ctx.font = 'bold 26px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = fl.c;
    ctx.fillText(fl.txt, fl.x, fl.y - fl.t*0.8);
  }
  ctx.globalAlpha = 1;

  drawCombo();

  // 阶段文字
  ctx.textAlign = 'center';
  if (F.phase==='intro'){
    ctx.font = 'bold 72px "Microsoft YaHei", sans-serif';
    if (F.pt < 70){
      ctx.fillStyle = '#ffe9c8';
      ctx.fillText(`第 ${F.round} 回合`, W/2, 300);
      ctx.font = '24px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`— ${stage.name} —`, W/2, 348);
    } else {
      const s = 1 + (1 - Math.min(1,(F.pt-70)/12)) * 1.5;
      ctx.save(); ctx.translate(W/2,300); ctx.scale(s,s);
      ctx.fillStyle = '#ff6a3a';
      ctx.fillText('开打!', 0, 0);
      ctx.restore();
    }
  } else if (F.phase==='ko'){
    ctx.font = 'bold 110px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#ffd75e';
    ctx.strokeStyle = '#802010'; ctx.lineWidth = 6;
    const txt = F.time<=0 && F.winner ? '时间到' : (F.winner ? 'K.O.' : '平局');
    ctx.strokeText(txt, W/2, 320);
    ctx.fillText(txt, W/2, 320);
    if (F.pt>70 && F.winner){
      ctx.font = 'bold 40px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(`${F.winner.ch.name} ${F.winner===F.p?'(你)':'(电脑)'} 胜`, W/2, 390);
    }
  }

  if (scene==='matchEnd'){
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0,0,W,H);
    const win = F.matchWinner===F.p;
    ctx.font = 'bold 96px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = win ? '#ffd75e' : '#ff5e5e';
    ctx.fillText(win ? '胜  利 !' : '败  北 …', W/2, 300);
    ctx.font = '30px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#ddd';
    ctx.fillText(win ? `你的 ${F.p.ch.name} 击败了 ${F.diff.name}电脑 ${F.c.ch.name}`
                     : `${F.diff.name}电脑的 ${F.c.ch.name} 更胜一筹，再来！`, W/2, 370);
    ctx.fillStyle = '#ffe9c8';
    ctx.fillText('按 J 返回选人', W/2, 450);
  }
}

function drawCombo(){
  for (const [f, left] of [[fight.p,true],[fight.c,false]]){
    if (f.combo < 2) continue;
    const pop = f.comboT < 6 ? 1.45 - 0.45*(f.comboT/6) : 1;
    const col = f.combo>=8 ? '#ff4b3a' : f.combo>=5 ? '#ffb23a' : f.combo>=3 ? '#ffe95e' : '#ffffff';
    ctx.save();
    ctx.translate(left ? 70 : W-70, 200);
    ctx.scale(pop, pop);
    ctx.textAlign = left ? 'left' : 'right';
    ctx.font = 'bold 48px "Microsoft YaHei", sans-serif';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 6;
    ctx.strokeText(`${f.combo} 连击!`, 0, 0);
    ctx.fillStyle = col;
    ctx.fillText(`${f.combo} 连击!`, 0, 0);
    ctx.restore();
  }
}

function drawHud(){
  const F = fight;
  const bw = 480, bh = 26, y0 = 30;
  for (const [f, left] of [[F.p,true],[F.c,false]]){
    const x0 = left ? 40 : W-40-bw;
    // 血条底
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0-4, y0-4, bw+8, bh+8);
    ctx.fillStyle = '#5a1010';
    ctx.fillRect(x0, y0, bw, bh);
    // 血量
    const r = Math.max(0, f.hp/f.maxHp);
    const grad = ctx.createLinearGradient(x0,0,x0+bw,0);
    grad.addColorStop(0, r>0.35?'#ffd75e':'#ff5e3a'); grad.addColorStop(1, r>0.35?'#ff9a3a':'#c02010');
    ctx.fillStyle = grad;
    if (left) ctx.fillRect(x0+bw*(1-r), y0, bw*r, bh);
    else ctx.fillRect(x0, y0, bw*r, bh);
    // 气槽
    const mx = left ? x0 : x0+bw-262;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(mx, y0+bh+8, 262, 12);
    if (f.awakened){
      ctx.fillStyle = frame%14<7 ? f.ch.awk.color : f.ch.awk.glow;
      ctx.fillRect(mx+2, y0+bh+10, 258, 8);
    } else {
      ctx.fillStyle = f.meter>=100 ? (frame%20<10?'#fff':'#7ee6ff') : '#3e9aff';
      const mw = 258*f.meter/100;
      ctx.fillRect(left?mx+2+(258-mw):mx+2, y0+bh+10, mw, 8);
    }
    // 耗气刻度(每30)
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let m=30;m<100;m+=30){
      const tx = left ? mx+2+258*(1-m/100) : mx+2+258*m/100;
      ctx.fillRect(tx, y0+bh+8, 1.5, 12);
    }
    // U技能冷却灯
    const ux = left ? mx+270 : mx-16;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(ux-2, y0+bh+6, 16, 16);
    if (f.uCd<=0){
      ctx.fillStyle = frame%30<15 ? f.ch.glow : f.ch.color;
      ctx.fillRect(ux, y0+bh+8, 12, 12);
    } else {
      ctx.fillStyle = '#555';
      const hgt = 12*(1-f.uCd/60);
      ctx.fillRect(ux, y0+bh+8+(12-hgt), 12, hgt);
    }
    ctx.font = 'bold 10px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText('U', ux+6, y0+bh+17);
    // 玩家替身冷却：紫色为可用，灰色逐步恢复
    if (!f.isCPU){
      const sx=ux+24, sw=76;
      ctx.fillStyle='rgba(0,0,0,.58)'; ctx.fillRect(sx-2,y0+bh+6,sw+4,16);
      const ready=f.subCd<=0;
      const fill=ready?1:1-f.subCd/SUBSTITUTE_COOLDOWN;
      ctx.fillStyle=ready?'#b98aff':'#655879'; ctx.fillRect(sx,y0+bh+8,sw*fill,12);
      ctx.font='bold 10px "Microsoft YaHei",sans-serif'; ctx.textAlign='center'; ctx.fillStyle='#fff';
      ctx.fillText(ready?'H 替身':`H ${Math.ceil(f.subCd/60)}秒`,sx+sw/2,y0+bh+17);
    }
    // 名字 & 胜场
    ctx.font = 'bold 20px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = f.col;
    ctx.textAlign = left?'left':'right';
    const awkTag = f.awakened ? ' ['+f.ch.awk.name+']' : '';
    ctx.fillText(`${f.ch.name}${awkTag} ${f.isCPU?'(电脑·'+F.diff.name+')':'(你)'}`, left?x0:x0+bw, y0+bh+42);
    // 满气觉醒提示
    if (!f.awakened && f.meter>=100 && frame%40<26){
      ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#ffe95e';
      ctx.fillText(f.isCPU?'满气!':'J+K 觉醒 / O 大招!', left?x0:x0+bw, y0+bh+64);
    }
    for(let i=0;i<2;i++){
      ctx.beginPath();
      const px = left ? x0+bw+24+i*26 : x0-24-i*26;
      ctx.arc(px, y0+14, 9, 0, Math.PI*2);
      ctx.fillStyle = i < f.wins ? '#ffd75e' : 'rgba(255,255,255,0.15)';
      ctx.fill();
    }
  }
  // 计时
  ctx.textAlign='center';
  ctx.font = 'bold 52px "Consolas", monospace';
  ctx.fillStyle = '#fff';
  const sec = Math.max(0, Math.ceil(F.time/60));
  ctx.fillText(sec, W/2, 72);
  if (substituteTouch){
    const ready=F.p.subCd<=0;
    const usable=ready && F.p.state==='hit' && F.phase==='play';
    substituteTouch.classList.toggle('is-ready',usable);
    substituteTouch.classList.toggle('is-cooling',!ready);
    if (substituteTouchLabel) substituteTouchLabel.textContent=ready?'替身':`${Math.ceil(F.p.subCd/60)}秒`;
    substituteTouch.setAttribute('aria-label',ready?'受击时替身到敌人身后':`替身冷却 ${Math.ceil(F.p.subCd/60)}秒`);
  }
  // 桌面操作提示使用稳定深色底板；手机由屏幕按键承载，不再重复遮挡
  if (!touchMode){
    ctx.fillStyle='rgba(6,6,10,.78)'; roundRect(142,H-42,W-284,34,8); ctx.fill();
    ctx.font = '15px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#f2e8df';
    ctx.fillText('A/D移动  K跳  S防御  J连击  U技  I必杀  O大招  L瞬移  H受击替身  落地A/D受身', W/2, H-19);
  }
}

// ---------- 地图与难度选择 ----------
function drawStageSelect(){
  const selected=STAGES[stageSel];
  ctx.fillStyle='rgba(5,5,12,.30)'; ctx.fillRect(0,0,W,H);
  const top=32;
  ctx.fillStyle='rgba(8,8,14,.82)'; ctx.fillRect(0,0,W,148);
  ctx.textAlign='center';
  ctx.font='bold 42px "Microsoft YaHei",sans-serif'; ctx.fillStyle='#ffe9c8';
  ctx.fillText('选择战场',W/2,top+48);
  ctx.font='18px "Microsoft YaHei",sans-serif'; ctx.fillStyle='rgba(255,255,255,.74)';
  ctx.fillText(`${CHARS[menuSel].name} · ${DIFFS[diffSel].name}电脑`,W/2,top+84);

  ctx.fillStyle='rgba(7,7,12,.82)'; roundRect(360,472,560,156,14); ctx.fill();
  ctx.strokeStyle='rgba(255,185,104,.74)'; ctx.lineWidth=2; roundRect(360,472,560,156,14); ctx.stroke();
  ctx.font='bold 38px "Microsoft YaHei",sans-serif'; ctx.fillStyle='#ffb05e';
  ctx.fillText(`‹  ${selected.name}  ›`,W/2,520);
  ctx.font='15px "Microsoft YaHei",sans-serif'; ctx.fillStyle='rgba(255,255,255,.72)';
  ctx.fillText(`${selected.platforms.length} 处平台 · 只改变走位，不造成伤害`,W/2,552);

  const startX=W/2-(STAGES.length-1)*82/2;
  STAGES.forEach((st,i)=>{
    const x=startX+i*82, active=i===stageSel;
    ctx.beginPath(); ctx.arc(x,580,active?7:4,0,Math.PI*2);
    ctx.fillStyle=active?'#ffb05e':'rgba(255,255,255,.35)'; ctx.fill();
  });
  ctx.font='bold 18px "Microsoft YaHei",sans-serif'; ctx.fillStyle=DIFFS[diffSel].color;
  ctx.fillText(`难度：${DIFFS[diffSel].name}`,W/2,611);
  ctx.font='16px "Microsoft YaHei",sans-serif'; ctx.fillStyle='rgba(255,255,255,.78)';
  ctx.fillText('A / D 选择地图    W / S 调整难度    J 确认开战    K 返回选人',W/2,674);
}

// ---------- 菜单 ----------
function drawMenu(){
  ctx.textAlign='center';
  // 标题
  ctx.font = 'bold 92px "Microsoft YaHei", sans-serif';
  const tg = ctx.createLinearGradient(0,60,0,170);
  tg.addColorStop(0,'#ffe9a8'); tg.addColorStop(1,'#ff6a3a');
  ctx.fillStyle = tg;
  ctx.fillText('火 柴 人 格 斗', W/2, 150);
  ctx.font = '22px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('STICK  FIGHTER', W/2, 190);

  // 角色卡(5 张)
  const n = CHARS.length;
  const cw = 230, chh = 278, gap = 16;
  const total = cw*n+gap*(n-1), x0 = (W-total)/2;
  for (let i=0;i<n;i++){
    const ch = CHARS[i], x = x0 + i*(cw+gap), y = 226;
    const sel = i===menuSel;
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.35)';
    ctx.strokeStyle = sel ? ch.color : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = sel?4:2;
    roundRect(x, y, cw, chh, 14); ctx.fill(); ctx.stroke();

    // 迷你火柴人
    ctx.save();
    ctx.translate(x+cw/2, y+138);
    const s2 = sel ? 1.1+0.04*Math.sin(frame*0.15) : 1;
    ctx.scale(s2,s2);
    drawMiniStick(ch, sel);
    ctx.restore();

    ctx.textAlign='center';
    ctx.font = 'bold 27px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = ch.color;
    ctx.fillText(ch.name, x+cw/2, y+42);
    ctx.font = '17px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(ch.style, x+cw/2, y+68);
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fillText(`HP ${ch.hp} · 招牌：${ch.spNames.n}`, x+cw/2, y+226);
    ctx.fillStyle = 'rgba(255,230,150,0.82)';
    ctx.fillText(`觉醒：${ch.awk.name}`, x+cw/2, y+252);
  }
  if (menuSel>=0){
    ctx.textAlign='center';
    ctx.font = '19px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(CHARS[menuSel].desc, W/2, 554);
  }
  ctx.font = 'bold 22px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#ffe9c8';
  ctx.fillText('A / D 选角色    J 或回车进入地图选择', W/2, 626);
  ctx.font = '14px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.62)';
  ctx.fillText('v5.1 · 仅在本机保存游戏设置 · 不上传或收集玩家数据',W/2,684);
}

function drawMiniStick(ch, active){
  const c = ch.color;
  const t = active ? frame*0.1 : 0;
  ctx.strokeStyle=c; ctx.lineWidth=6; ctx.lineCap='round';
  const bobY = Math.sin(t)*3;
  // 腿
  seg(0,bobY, -14,42, 6, c); seg(0,bobY, 14,42, 6, c);
  // 躯干
  seg(0,bobY, 0,-40+bobY, 6, c);
  // 手臂
  const ahx = 22, ahy = -12+Math.sin(t+1)*4;
  seg(0,-32+bobY, ahx,ahy, 5, c);
  seg(0,-32+bobY, -22,-12+Math.sin(t+2)*4, 5, c);
  // 居合·刹的刀
  if (ch.id===3){
    ctx.strokeStyle='#eef0ff'; ctx.lineWidth=3; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(ahx,ahy); ctx.lineTo(ahx+30,ahy-30); ctx.stroke();
    ctx.strokeStyle=ch.glow; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(ahx-5,ahy-5); ctx.lineTo(ahx+5,ahy+5); ctx.stroke();
  }
  // 青岚·竹的长棍
  if (ch.id===4){
    ctx.strokeStyle='#d8bd8a'; ctx.lineWidth=3.5; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(ahx-16,ahy+38); ctx.lineTo(ahx+24,ahy-46); ctx.stroke();
    ctx.strokeStyle=ch.glow; ctx.lineWidth=3.5;
    ctx.beginPath(); ctx.moveTo(ahx+20,ahy-38); ctx.lineTo(ahx+24,ahy-46); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ahx-16,ahy+38); ctx.lineTo(ahx-12,ahy+30); ctx.stroke();
  }
  // 头
  ctx.fillStyle=c;
  ctx.beginPath(); ctx.arc(0,-54+bobY,12,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle=ch.glow; ctx.lineWidth=3;
  ctx.beginPath(); ctx.moveTo(-12,-57+bobY); ctx.lineTo(12,-57+bobY); ctx.stroke();
}

function roundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

// ---------- 场景更新 ----------
function updateMenu(){
  const n = CHARS.length;
  if (pressed['KeyA'] || pressed['ArrowLeft']) { menuSel=(menuSel+n-1)%n; sfx.select(); }
  if (pressed['KeyD'] || pressed['ArrowRight']){ menuSel=(menuSel+1)%n; sfx.select(); }
  if (pressed['KeyJ'] || pressed['Enter']){
    sfx.confirm();
    stage=STAGES[stageSel];
    scene='stageSelect';
    syncGameUi();
  }
}

function startSelectedFight(){
  let cpuIndex=Math.floor(Math.random()*CHARS.length);
  if (cpuIndex===menuSel) cpuIndex=(cpuIndex+1)%CHARS.length;
  stage=STAGES[stageSel];
  fight=makeFight(CHARS[menuSel],CHARS[cpuIndex],DIFFS[diffSel]);
  resetBattleEffects();
  scene='fight'; paused=false;
  syncGameUi();
}

function updateStageSelect(){
  const n=STAGES.length;
  if (pressed['KeyA']||pressed['ArrowLeft']){stageSel=(stageSel+n-1)%n;stage=STAGES[stageSel];sfx.select();resetBattleEffects();}
  if (pressed['KeyD']||pressed['ArrowRight']){stageSel=(stageSel+1)%n;stage=STAGES[stageSel];sfx.select();resetBattleEffects();}
  if (pressed['KeyW']||pressed['ArrowUp']){diffSel=(diffSel+2)%3;sfx.select();}
  if (pressed['KeyS']||pressed['ArrowDown']){diffSel=(diffSel+1)%3;sfx.select();}
  if (pressed['KeyK']||pressed['Escape']){scene='menu';sfx.select();syncGameUi();return;}
  if (pressed['KeyJ']||pressed['Enter']){sfx.confirm();startSelectedFight();}
}

// ---------- 主循环 ----------
function loop(){
  frame++;
  if (paused){
    draw();
    requestAnimationFrame(loop);
    return;
  }
  if (freeze > 0){
    freeze--;   // 打击定格:跳过更新,但保留 pressed 输入,解冻帧统一消费
  } else if (slowmo > 0 && frame%2===0){
    slowmo--;   // 慢动作:每两帧只更新一帧(输入照常缓冲)
  } else {
    if (slowmo > 0) slowmo--;
    if (scene==='menu') updateMenu();
    else if (scene==='stageSelect') updateStageSelect();
    else if (scene==='fight') updateFight();
    else if (scene==='matchEnd'){
      if (pressed['KeyJ'] || pressed['Enter']){ sfx.confirm(); returnToMenu(); }
    }
    // 特效更新
    for (const p of particles){
      if (p.type==='flame'){ p.x+=p.vx; p.y+=p.vy; p.r*=0.93; }
      else if (p.type==='smoke'){ p.x+=p.vx; p.y+=p.vy; p.vx*=.94; p.vy*=.95; p.r*=1.012; }
      else if (p.type==='debris'){
        p.x+=p.vx; p.y+=p.vy; p.vy+=0.5;
        if (p.y>GROUND){ p.y=GROUND; p.vy*=-0.4; p.vx*=0.6; }
      }
      else if (p.type==='streak'){ p.x+=p.vx; p.y+=p.vy; p.vx*=0.9; p.vy*=0.9; }
      else if (p.type==='flash'){ /* 原地膨胀 */ }
      else { p.x+=p.vx; p.y+=p.vy; p.vy+=0.25; }
      p.life--;
    }
    particles = particles.filter(p=>p.life>0);
    for (const fl of floaters) fl.t++;
    floaters = floaters.filter(fl=>fl.t<55);
    for (const r of rings){ r.r+=r.vr; r.vr*=0.9; r.life--; }
    rings = rings.filter(r=>r.life>0);
    for (const b of banners) b.t++;
    banners = banners.filter(b=>b.t<58);
    for (const d of decoys){ d.t++; d.life--; }
    decoys=decoys.filter(d=>d.life>0);
    if (superDark>0) superDark--;
    for (const k in pressed) pressed[k]=false;
  }
  // 场景氛围粒子(不受freeze影响,始终缓慢飘)
  if (frame%7===0){
    const amb = stage.ambient;
    if (amb==='ember')
      embers.push({x:Math.random()*W, y:GROUND+Math.random()*40,
        vx:(Math.random()-0.5)*0.4, vy:-(0.3+Math.random()*0.7),
        r:1+Math.random()*2, a:0.15+Math.random()*0.3, life:200,
        c:Math.random()<0.5?'#ff9a5a':'#ffd0a0'});
    else if (amb==='snow')
      embers.push({x:Math.random()*W, y:-10,
        vx:(Math.random()-0.5)*0.6, vy:0.6+Math.random()*0.9,
        r:1.5+Math.random()*2.5, a:0.3+Math.random()*0.4, life:900,
        c:'#ffffff'});
    else if (amb==='lava')
      embers.push({x:Math.random()*W, y:GROUND+Math.random()*30,
        vx:(Math.random()-0.5)*0.5, vy:-(0.5+Math.random()*1.2),
        r:1+Math.random()*2.5, a:0.2+Math.random()*0.4, life:160,
        c:Math.random()<0.6?'#ff7a2a':'#ffcf6a'});
    else // neon: 夜风微尘
      embers.push({x:Math.random()<0.5?-5:W+5, y:100+Math.random()*400,
        vx:(Math.random()<0.5?1:-1)*(0.4+Math.random()*0.6), vy:(Math.random()-0.5)*0.2,
        r:1+Math.random()*1.5, a:0.1+Math.random()*0.2, life:400,
        c:Math.random()<0.5?'#9ecfff':'#e8f0ff'});
  }
  for (const e of embers){ e.x+=e.vx+Math.sin(frame*0.02+e.y*0.05)*0.15; e.y+=e.vy; e.life--; }
  embers = embers.filter(e=>e.life>0 && e.y>-14 && e.y<H+14);

  draw();
  requestAnimationFrame(loop);
}
syncGameUi();
loop();
