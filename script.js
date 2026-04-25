(() => {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const VIEW_W = 960, VIEW_H = 540;
  const TS = 32;

  const GRAVITY = 1200;
  const FIXED_DT = 1/120;
  const MAX_FRAME_DT = 0.05;
  const MAX_STEPS = 6;

  // Jump feel (responsive)
  const COYOTE_TIME = 0.16;
  const JUMP_BUFFER = 0.20;
  const JUMP_CUT = 0.55;

  const PLAYER_W = 22, PLAYER_H = 30;
  const RUN_SPEED = 225;
  const JUMP_V = 500;
  const MAX_FALL = 980;

  // Shooting
  const FIRE_RATE = 9;                // tap-fire rate limit
  const CHARGE_TIME = 2.0;            // hold J for 2s -> charged
  const CHARGED_DMG = 6;
  const CHARGED_W = 18, CHARGED_H = 12;
  const NORMAL_DMG = 1;

  // Dash
  const DASH_SPEED = 540;
  const DASH_TIME = 0.18;
  const DASH_COOLDOWN = 0.55;

  // Health
  const PLAYER_MAX_HP = 20;

  // ============================================================
  // CANVAS / DPI
  // ============================================================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha:false });

  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.width = VIEW_W * dpr;
  canvas.height = VIEW_H * dpr;
  canvas.style.width = VIEW_W + 'px';
  canvas.style.height = VIEW_H + 'px';
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;

  // ============================================================
  // INPUT (pressed/released consumed once per frame)
  // ============================================================
  function normalizeKey(e){
    if (e.code === 'Space' || e.key === ' ') return 'space';
    const k = (e.key || '').toLowerCase();
    return (k === 'spacebar') ? 'space' : k;
  }

  const Input = {
    down: Object.create(null),
    pressed: Object.create(null),
    released: Object.create(null),
    anyLatch: false,

    _onKeyDown(e){
      const k = normalizeKey(e);
      if (!Input.down[k]) Input.pressed[k] = true;
      Input.down[k] = true;
      Input.anyLatch = true;
      if (k === 'space' || k.startsWith('arrow')) e.preventDefault();
    },
    _onKeyUp(e){
      const k = normalizeKey(e);
      Input.down[k] = false;
      Input.released[k] = true;
      Input.anyLatch = true;
    },

    takePressed(k){
      if (this.pressed[k]) { this.pressed[k] = false; return true; }
      return false;
    },
    takeReleased(k){
      if (this.released[k]) { this.released[k] = false; return true; }
      return false;
    },

    isDown(k){ return !!this.down[k]; },
    consumeAny(){ return this.anyLatch; },

    endFrame(){
      this.pressed = Object.create(null);
      this.released = Object.create(null);
      this.anyLatch = false;
    }
  };

  window.addEventListener('keydown', Input._onKeyDown, { passive:false });
  window.addEventListener('keyup', Input._onKeyUp, { passive:false });

  canvas.addEventListener('pointerdown', () => {
    canvas.focus({ preventScroll:true });
    Input.anyLatch = true;
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
    if (Game.state === 'intro') Game.state = 'playing';
  });

  function moveLeft(){ return Input.isDown('a') || Input.isDown('arrowleft'); }
  function moveRight(){ return Input.isDown('d') || Input.isDown('arrowright'); }
  function jumpHeld(){ return Input.isDown('w') || Input.isDown('arrowup') || Input.isDown('space'); }
  function jumpPressed(){ return Input.takePressed('w') || Input.takePressed('arrowup') || Input.takePressed('space'); }
  function jumpReleased(){ return Input.takeReleased('w') || Input.takeReleased('arrowup') || Input.takeReleased('space'); }
  function fireHeld(){ return Input.isDown('j'); }
  function firePressed(){ return Input.takePressed('j'); }
  function fireReleased(){ return Input.takeReleased('j'); }

  // ============================================================
  // AUDIO (WebAudio beeps)
  // ============================================================
  let audioCtx = null;
  let audioEnabled = false;

  function ensureAudio(){
    if (audioEnabled) return;
    try{
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioEnabled = true;
    } catch(e){ audioEnabled = false; }
  }

  function beep(freq, dur=0.06, type='square', vol=0.06){
    if (!audioEnabled || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  const SFX = {
    shoot(){ beep(520, 0.05, 'square', 0.05); },
    chargeTick(){ beep(780, 0.03, 'triangle', 0.04); },
    chargeReady(){ beep(1040, 0.06, 'triangle', 0.06); },
    chargedShot(){ beep(220, 0.10, 'sawtooth', 0.08); },
    jump(){ beep(320, 0.07, 'triangle', 0.06); },
    dash(){ beep(180, 0.08, 'sawtooth', 0.05); },
    hit(){ beep(110, 0.10, 'square', 0.08); },
    pickup(){ beep(760, 0.06, 'triangle', 0.05); },
    bossShot(){ beep(260, 0.07, 'square', 0.06); },
    win(){ beep(660, 0.10, 'triangle', 0.06); setTimeout(()=>beep(880,0.12,'triangle',0.06), 110); },
    lose(){ beep(90, 0.20, 'square', 0.08); }
  };

  // ============================================================
  // MATH / AABB
  // ============================================================
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function sign(v){ return v<0?-1:(v>0?1:0); }
  function aabbOverlap(ax,ay,aw,ah,bx,by,bw,bh){
    return ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by;
  }
  function randRange(a,b){ return a + Math.random()*(b-a); }

  // ============================================================
  // BULLET POOLS (supports special modes)
  // mode: 'linear' | 'split' | 'orbit'
  // ============================================================
  function makeBulletPool(cap){
    const bullets = new Array(cap);
    for (let i=0;i<cap;i++){
      bullets[i] = {
        active:false, x:0,y:0,w:8,h:6, vx:0,vy:0, dmg:1, from:'player', life:0,
        mode:'linear', t:0, T:0, a:0, b:0, c:0 // generic fields
      };
    }
    return {
      spawn(x,y,vx,vy,dmg,from,w=8,h=6){
        for (let i=0;i<cap;i++){
          const b = bullets[i];
          if (!b.active){
            b.active = true;
            b.x=x; b.y=y; b.vx=vx; b.vy=vy; b.dmg=dmg|0; b.from=from;
            b.w=w; b.h=h;
            b.life = 2.2;
            b.mode='linear';
            b.t=0; b.T=0; b.a=0; b.b=0; b.c=0;
            return b;
          }
        }
        return null;
      },
      forEachActive(fn){
        for (let i=0;i<cap;i++){ const b = bullets[i]; if (b.active) fn(b); }
      },
      clear(){
        for (let i=0;i<cap;i++) bullets[i].active = false;
      }
    };
  }

  const playerBullets = makeBulletPool(140);
  const enemyBullets  = makeBulletPool(240);

  // ============================================================
  // PARTICLES (rect bursts)
  // ============================================================
  const Particle = (() => {
    const CAP = 260;
    const p = new Array(CAP);
    for (let i=0;i<CAP;i++) p[i] = { active:false, x:0,y:0, vx:0,vy:0, w:3,h:3, t:0, T:0, col:'#ffd9a6' };

    function spawn(x,y,count=10,speed=220,col='#ffd9a6'){
      for (let k=0;k<count;k++){
        for (let i=0;i<CAP;i++){
          const a = p[i];
          if (!a.active){
            a.active = true;
            a.x=x; a.y=y;
            const ang = Math.random()*Math.PI*2;
            const sp = speed*(0.35+Math.random()*0.75);
            a.vx = Math.cos(ang)*sp;
            a.vy = Math.sin(ang)*sp - 80;
            a.w = 2 + (Math.random()*3)|0;
            a.h = 2 + (Math.random()*3)|0;
            a.t = 0;
            a.T = 0.35 + Math.random()*0.35;
            a.col = col;
            break;
          }
        }
      }
    }

    function update(dt){
      for (let i=0;i<CAP;i++){
        const a = p[i];
        if (!a.active) continue;
        a.t += dt;
        if (a.t >= a.T){ a.active=false; continue; }
        a.vy += 600*dt;
        a.x += a.vx*dt;
        a.y += a.vy*dt;
      }
    }

    function draw(ctx, cam){
      ctx.save();
      for (let i=0;i<CAP;i++){
        const a = p[i];
        if (!a.active) continue;
        ctx.globalAlpha = 1 - (a.t/a.T);
        ctx.fillStyle = a.col;
        ctx.fillRect((a.x-cam.x)|0, (a.y-cam.y)|0, a.w, a.h);
      }
      ctx.restore();
    }

    return { spawn, update, draw };
  })();

  // ============================================================
  // LEVEL SYSTEM (4 levels)
  // Tiles:
  // 0 empty | 1 solid | 2 spikes | 3 checkpoint | 4 pickup | 5 boss gate (solid after triggered)
  // ============================================================
  function Level(){
    this.w=180; this.h=18;
    this.tiles = new Uint8Array(this.w*this.h);

    this.name = '—';
    this.index = 0;

    this.playerSpawn = { x:4*TS, y:10*TS };
    this.checkpoint = { x:this.playerSpawn.x, y:this.playerSpawn.y, active:false };

    this.bossGateTx = 0;
    this.bossGateTy = 14;
    this.bossTriggered=false;
    this.bossDead=false;

    this.arena = { x0:0, y0:0, x1:0, y1:this.h*TS };

    this.enemies=[];
    this.pickups=[];
    this.boss=null;

    this.enemyBulletDmg = 2;
    this.enemyTouchDmg = 2;
    this.spikeDmg = 4;
    this.pitDmg = 5;
  }
  Level.prototype.idx=function(tx,ty){ return ty*this.w+tx; };
  Level.prototype.inBounds=function(tx,ty){ return tx>=0&&ty>=0&&tx<this.w&&ty<this.h; };
  Level.prototype.get=function(tx,ty){ if(!this.inBounds(tx,ty)) return 1; return this.tiles[this.idx(tx,ty)]; };
  Level.prototype.set=function(tx,ty,v){ if(!this.inBounds(tx,ty)) return; this.tiles[this.idx(tx,ty)]=v; };
  Level.prototype.isSolid=function(t){
    if (t===1) return true;
    if (t===5) return this.bossTriggered;
    return false;
  };

  // enemy factories
  function makeWalker(x,y,dir=1, hp=6, speed=80){
    return { type:'walker', x,y,w:24,h:22, vx:dir?speed:-speed, vy:0, hp, alive:true, onGround:false, hitWall:false, touchCd:0 };
  }
  function makeTurret(x,y,period=1.0, hp=7, bulletSpeed=340){
    return { type:'turret', x,y,w:22,h:22, vx:0, vy:0, hp, alive:true, shootT:0, period, bulletSpeed };
  }
  function makeDrone(x,y,xMin,xMax, hp=5, speed=100){
    return { type:'drone', x,y,w:26,h:18, vx:speed, vy:0, hp, alive:true, baseY:y, t:0, xMin, xMax };
  }

  // boss factory (kind controls patterns & look)
  function makeBoss(kind,x,y,hp){
    return {
      type:'boss', kind,
      x,y,w:52,h:48,
      vx:0, vy:0,
      hp, maxHp:hp,
      alive:true,
      onGround:false,
      hitWall:false,
      facing:-1,
      state:'sleep',
      t:0,
      cooldown:0,
      invul:0,
      // generic boss scratch fields
      a:0,b:0,c:0, phase:0
    };
  }

  // Level definitions (increasing difficulty)
  const LEVEL_DEFS = [
    {
      name:'Level 1 — Neon Ruins',
      w:160,
      pits:[[28,31],[54,57],[76,79],[103,106]],
      platforms:[
        [10,13,6],[18,11,5],[24,12,3],[36,12,7],[45,10,5],
        [62,12,7],[70,9,4],[84,12,7],[95,10,6],[112,12,8],[122,9,5]
      ],
      spikes:[
        [20,15,3],[41,15,3],[66,15,4],[90,15,3],[118,15,4]
      ],
      checkpoint:[64,15],
      pickups:[[14,12,6],[19,10,6],[38,11,6],[50,9,6],[72,8,6],[86,11,6],[101,9,6],[124,8,6]],
      enemies:(lv)=>{
        lv.enemies.push(makeWalker(22*TS, 15*TS-PLAYER_H, 0, 6, 75));
        lv.enemies.push(makeWalker(42*TS, 15*TS-PLAYER_H, 1, 6, 80));
        lv.enemies.push(makeWalker(68*TS, 15*TS-PLAYER_H, 0, 7, 85));
        lv.enemies.push(makeWalker(92*TS, 15*TS-PLAYER_H, 1, 7, 85));

        lv.enemies.push(makeTurret(47*TS+6, 15*TS-24, 1.20, 7, 320));
        lv.enemies.push(makeTurret(87*TS+6, 15*TS-24, 1.05, 7, 330));
        lv.enemies.push(makeTurret(116*TS+6,15*TS-24, 0.95, 8, 340));

        lv.enemies.push(makeDrone(33*TS, 9*TS, 28*TS, 40*TS, 5, 95));
        lv.enemies.push(makeDrone(78*TS, 7*TS, 74*TS, 86*TS, 5, 100));
        lv.enemies.push(makeDrone(108*TS, 8*TS,104*TS,120*TS, 6, 110));
      },
      boss:{ kind:'warden', hp:60 },
      enemyBulletDmg:2, enemyTouchDmg:2, spikeDmg:4, pitDmg:5
    },
    {
      name:'Level 2 — Storm Foundry',
      w:175,
      pits:[[22,24],[46,49],[70,74],[96,99],[118,121]],
      platforms:[
        [8,13,6],[16,11,6],[26,12,4],[34,10,6],[44,12,6],
        [58,9,5],[66,12,7],[80,10,6],[92,12,7],[108,9,6],[124,12,8],[138,10,6]
      ],
      spikes:[
        [18,15,4],[52,15,4],[78,15,4],[104,15,4],[130,15,5]
      ],
      checkpoint:[88,15],
      pickups:[[12,12,6],[32,9,6],[60,8,7],[84,9,6],[110,8,7],[136,9,6]],
      enemies:(lv)=>{
        lv.enemies.push(makeWalker(18*TS, 15*TS-PLAYER_H, 1, 8, 95));
        lv.enemies.push(makeWalker(40*TS, 15*TS-PLAYER_H, 0, 8, 105));
        lv.enemies.push(makeWalker(74*TS, 15*TS-PLAYER_H, 1, 9, 110));
        lv.enemies.push(makeWalker(110*TS,15*TS-PLAYER_H,0, 9, 115));

        lv.enemies.push(makeTurret(49*TS+6, 15*TS-24, 0.95, 9, 360));
        lv.enemies.push(makeTurret(94*TS+6, 15*TS-24, 0.85, 9, 370));
        lv.enemies.push(makeTurret(128*TS+6,15*TS-24, 0.78,10, 390));

        lv.enemies.push(makeDrone(60*TS, 7*TS, 54*TS, 70*TS, 6, 120));
        lv.enemies.push(makeDrone(104*TS, 7*TS, 98*TS, 116*TS, 7, 130));
        lv.enemies.push(makeDrone(136*TS, 6*TS, 130*TS, 150*TS, 7, 135));
      },
      boss:{ kind:'tempest', hp:80 },
      enemyBulletDmg:2, enemyTouchDmg:3, spikeDmg:5, pitDmg:6
    },
    {
      name:'Level 3 — Cryo Vault',
      w:190,
      pits:[[30,34],[58,61],[86,90],[112,116],[140,144]],
      platforms:[
        [10,13,7],[20,11,6],[32,9,5],[44,11,6],[56,12,7],
        [70,10,6],[84,8,5],[96,11,7],[112,9,6],[126,12,8],[144,10,7],[156,8,6]
      ],
      spikes:[
        [24,15,5],[52,15,4],[76,15,5],[106,15,5],[134,15,5],[160,15,6]
      ],
      checkpoint:[104,15],
      pickups:[[16,12,6],[38,8,7],[66,9,6],[92,7,7],[120,8,7],[150,9,6]],
      enemies:(lv)=>{
        lv.enemies.push(makeWalker(24*TS, 15*TS-PLAYER_H, 1, 10, 120));
        lv.enemies.push(makeWalker(52*TS, 15*TS-PLAYER_H, 0, 10, 125));
        lv.enemies.push(makeWalker(84*TS, 15*TS-PLAYER_H, 1, 11, 130));
        lv.enemies.push(makeWalker(124*TS,15*TS-PLAYER_H,0, 12, 135));

        lv.enemies.push(makeTurret(60*TS+6, 15*TS-24, 0.80, 10, 420));
        lv.enemies.push(makeTurret(108*TS+6,15*TS-24, 0.72, 11, 440));
        lv.enemies.push(makeTurret(156*TS+6,15*TS-24, 0.65, 12, 460));

        lv.enemies.push(makeDrone(40*TS, 6*TS, 34*TS, 52*TS, 7, 140));
        lv.enemies.push(makeDrone(100*TS,6*TS, 92*TS, 112*TS, 8, 150));
        lv.enemies.push(makeDrone(152*TS,6*TS, 146*TS, 168*TS, 8, 160));
      },
      boss:{ kind:'frost', hp:100 },
      enemyBulletDmg:3, enemyTouchDmg:3, spikeDmg:5, pitDmg:7
    },
    {
      name:'Level 4 — Solar Core',
      w:210,
      pits:[[18,22],[44,48],[70,76],[98,102],[124,130],[152,156],[176,182]],
      platforms:[
        [8,13,7],[18,11,6],[30,9,6],[44,11,7],[60,12,8],
        [76,10,7],[92,8,6],[106,11,8],[124,9,7],[140,12,10],[160,10,8],[176,8,8]
      ],
      spikes:[
        [26,15,6],[56,15,6],[86,15,6],[116,15,6],[146,15,6],[170,15,8]
      ],
      checkpoint:[132,15],
      pickups:[[12,12,6],[36,8,7],[68,9,6],[100,7,7],[134,8,7],[166,9,6],[188,8,8]],
      enemies:(lv)=>{
        lv.enemies.push(makeWalker(26*TS, 15*TS-PLAYER_H, 1, 12, 140));
        lv.enemies.push(makeWalker(58*TS, 15*TS-PLAYER_H, 0, 13, 150));
        lv.enemies.push(makeWalker(92*TS, 15*TS-PLAYER_H, 1, 14, 155));
        lv.enemies.push(makeWalker(140*TS,15*TS-PLAYER_H,0, 15, 160));

        lv.enemies.push(makeTurret(52*TS+6, 15*TS-24, 0.70, 12, 500));
        lv.enemies.push(makeTurret(112*TS+6,15*TS-24, 0.62, 13, 520));
        lv.enemies.push(makeTurret(170*TS+6,15*TS-24, 0.55, 14, 540));

        lv.enemies.push(makeDrone(44*TS, 6*TS, 36*TS, 58*TS, 9, 170));
        lv.enemies.push(makeDrone(124*TS,6*TS, 116*TS, 140*TS, 9, 175));
        lv.enemies.push(makeDrone(176*TS,6*TS, 168*TS, 192*TS,10, 185));
      },
      boss:{ kind:'solar', hp:130 },
      enemyBulletDmg:3, enemyTouchDmg:4, spikeDmg:6, pitDmg:8
    }
  ];

  function buildLevel(lv, levelIndex){
    const def = LEVEL_DEFS[levelIndex];
    lv.index = levelIndex;
    lv.name = def.name;

    lv.w = def.w;
    lv.h = 18;
    lv.tiles = new Uint8Array(lv.w * lv.h);

    lv.enemies.length = 0;
    lv.pickups.length = 0;
    lv.boss = null;

    lv.bossTriggered = false;
    lv.bossDead = false;

    lv.enemyBulletDmg = def.enemyBulletDmg;
    lv.enemyTouchDmg  = def.enemyTouchDmg;
    lv.spikeDmg       = def.spikeDmg;
    lv.pitDmg         = def.pitDmg;

    // spawn
    lv.playerSpawn = { x:4*TS, y:10*TS };
    lv.checkpoint  = { x:lv.playerSpawn.x, y:lv.playerSpawn.y, active:false };

    const groundY = 16;

    // gate near end
    lv.bossGateTx = Math.max(0, lv.w - 27);
    lv.bossGateTy = 14;

    // arena bounds (start right after gate, end at last column wall)
    lv.arena.x0 = (lv.bossGateTx + 1) * TS;
    lv.arena.x1 = (lv.w - 1) * TS;
    lv.arena.y0 = 0;
    lv.arena.y1 = lv.h * TS;

    // ground with pits (but arena always solid)
    function inPit(x){
      for (let i=0;i<def.pits.length;i++){
        const a=def.pits[i][0], b=def.pits[i][1];
        if (x>=a && x<=b) return true;
      }
      return false;
    }
    for (let x=0;x<lv.w;x++){
      const inArena = x >= (lv.bossGateTx+1);
      const pit = (!inArena) && inPit(x);
      if (!pit){
        lv.set(x,groundY,1);
        lv.set(x,groundY+1,1);
      }
    }

    // right boundary wall
    for (let y=0;y<lv.h;y++) lv.set(lv.w-1, y, 1);

    // platforms
    for (let i=0;i<def.platforms.length;i++){
      const [x0,y,len] = def.platforms[i];
      for (let x=x0;x<x0+len && x<lv.w-1;x++) lv.set(x,y,1);
    }

    // spikes (placed on row 15 by defs)
    for (let i=0;i<def.spikes.length;i++){
      const [x0,y,len] = def.spikes[i];
      for (let x=x0;x<x0+len && x<lv.w-1;x++) lv.set(x,y,2);
    }

    // checkpoint
    if (def.checkpoint){
      const [cx,cy] = def.checkpoint;
      if (cx<lv.w-1) lv.set(cx,cy,3);
    }

    // pickups
    for (let i=0;i<def.pickups.length;i++){
      const [tx,ty,heal] = def.pickups[i];
      if (tx>=lv.w-1) continue;
      lv.set(tx,ty,4);
      lv.pickups.push({ active:true, x:tx*TS+8, y:ty*TS+8, w:16, h:16, heal:heal|0 });
    }

    // boss gate tiles (2 high at correct height)
    lv.set(lv.bossGateTx, lv.bossGateTy,   5);
    lv.set(lv.bossGateTx, lv.bossGateTy+1, 5);

    // enemies
    def.enemies(lv);

    // boss
    lv.boss = makeBoss(def.boss.kind, (lv.bossGateTx + 16)*TS, 15*TS-48, def.boss.hp);
  }

  // ============================================================
  // COLLISION (axis-separated)
  // ============================================================
  function resolveTileCollisions(e, lv, axis){
    const eps=0.001;
    const x0=Math.floor(e.x/TS), y0=Math.floor(e.y/TS);
    const x1=Math.floor((e.x+e.w)/TS), y1=Math.floor((e.y+e.h)/TS);

    if (axis==='x'){
      if (e.vx>0){
        const tx=Math.floor((e.x+e.w)/TS);
        for(let ty=y0;ty<=y1;ty++){
          const t=lv.get(tx,ty);
          if (lv.isSolid(t)){
            e.x = tx*TS - e.w - eps;
            e.vx = 0;
            e.hitWall = true;
            break;
          }
        }
      } else if (e.vx<0){
        const tx=Math.floor(e.x/TS);
        for(let ty=y0;ty<=y1;ty++){
          const t=lv.get(tx,ty);
          if (lv.isSolid(t)){
            e.x = (tx+1)*TS + eps;
            e.vx = 0;
            e.hitWall = true;
            break;
          }
        }
      }
    } else {
      e.onGround = false;
      if (e.vy>0){
        const ty=Math.floor((e.y+e.h)/TS);
        for(let tx=x0;tx<=x1;tx++){
          const t=lv.get(tx,ty);
          if (lv.isSolid(t)){
            e.y = ty*TS - e.h - eps;
            e.vy = 0;
            e.onGround = true;
            break;
          }
        }
      } else if (e.vy<0){
        const ty=Math.floor(e.y/TS);
        for(let tx=x0;tx<=x1;tx++){
          const t=lv.get(tx,ty);
          if (lv.isSolid(t)){
            e.y = (ty+1)*TS + eps;
            e.vy = 0;
            break;
          }
        }
      }
    }
  }

  function tileAtWorld(lv, wx, wy){
    return lv.get(Math.floor(wx/TS), Math.floor(wy/TS));
  }

  // ============================================================
  // PLAYER
  // ============================================================
  function makePlayer(x,y){
    return {
      x,y,w:PLAYER_W,h:PLAYER_H,
      vx:0, vy:0,
      facing:1,
      onGround:false,
      hitWall:false,
      hp:PLAYER_MAX_HP,
      invul:0,
      dashT:0,
      dashCd:0,
      alive:true,
      respawnX:x, respawnY:y,
      hurtFlash:0,

      // jump
      jumpsMax: 2,
      jumpsLeft: 2,
      coyote: 0,
      jumpBuf: 0,

      // charge shot
      charging:false,
      chargeT:0,
      chargeReady:false,
      shotCd:0,
      queuedShot:0 // 0 none | 1 normal | 2 charged
    };
  }

  // ============================================================
  // GAME
  // ============================================================
  const Game = {
    state:'intro', // intro | playing | paused | gameover | levelclear | win
    debug:false,
    msg:'', msgT:0,
    lv:new Level(),
    player:null,
    cam:{x:0,y:0},
    levelIndex:0,
    reset(toIntro=false){
      buildLevel(this.lv, this.levelIndex);
      this.player = makePlayer(this.lv.playerSpawn.x, this.lv.playerSpawn.y);
      this.player.respawnX = this.lv.playerSpawn.x;
      this.player.respawnY = this.lv.playerSpawn.y;

      playerBullets.clear();
      enemyBullets.clear();

      this.cam.x=0; this.cam.y=0;
      this.msg=''; this.msgT=0;
      this.state = toIntro ? 'intro' : 'playing';
    },
    nextLevel(){
      if (this.levelIndex < LEVEL_DEFS.length-1){
        this.levelIndex++;
        this.reset(false);
        setMessage(`Bắt đầu ${this.lv.name}`, 1.2);
      } else {
        this.state='win';
      }
    }
  };
  Game.reset(true);

  function setMessage(t,sec=1.6){ Game.msg=t; Game.msgT=sec; }

  function damagePlayer(p, amount, knockX=0, knockY=0){
    if(!p.alive) return;
    if(p.invul>0) return;
    p.hp -= amount;
    p.invul = 0.75;
    p.hurtFlash = 0.25;
    p.vx += knockX;
    p.vy += knockY;
    Particle.spawn(p.x+p.w*0.5, p.y+p.h*0.5, 10, 240, '#ffd9a6');
    SFX.hit();
    if (p.hp<=0){
      p.hp=0; p.alive=false;
      Game.state='gameover';
      SFX.lose();
    }
  }

  function healPlayer(p, amount){
    p.hp = clamp(p.hp+amount, 0, PLAYER_MAX_HP);
    SFX.pickup();
    Particle.spawn(p.x+p.w*0.5, p.y+p.h*0.5, 12, 180, '#7ad7ff');
  }

  function respawnPlayer(p, lv, tookDamage=true){
    if (tookDamage) damagePlayer(p, lv.pitDmg, 0, -120);
    if (!p.alive) return;
    p.x=p.respawnX; p.y=p.respawnY;
    p.vx=0; p.vy=0;
    p.dashT=0; p.dashCd=0.15;
    p.invul = Math.max(p.invul, 0.9);
    p.jumpBuf = 0;
    p.coyote = 0;
    p.jumpsLeft = p.jumpsMax;
    p.charging=false; p.chargeT=0; p.chargeReady=false; p.queuedShot=0;
    setMessage('Respawn!', 0.9);
  }

  function isHazardSpike(lv, x,y,w,h){
    const pts = [
      [x+2,y+h-2],[x+w-2,y+h-2],[x+w*0.5,y+h-2],
      [x+2,y+h*0.55],[x+w-2,y+h*0.55]
    ];
    for(let i=0;i<pts.length;i++) if (tileAtWorld(lv, pts[i][0], pts[i][1])===2) return true;
    return false;
  }

  function doJump(p){
    if (p.jumpsLeft <= 0) return;
    p.vy = -JUMP_V;
    p.onGround = false;
    p.coyote = 0;
    p.jumpBuf = 0;
    p.jumpsLeft = Math.max(0, p.jumpsLeft - 1);
    SFX.jump();
    Particle.spawn(p.x + p.w*0.5, p.y + p.h*0.98, 7, 140, '#bfe3ff');
  }

  function fireShot(p, lv, type){
    const dir = p.facing;
    const baseX = p.x + (dir>0 ? p.w : -6);
    const baseY = p.y + 12;

    if (type === 2){
      // charged
      const speed = 520;
      const b = playerBullets.spawn(baseX, baseY-2, dir*speed, 0, CHARGED_DMG, 'player', CHARGED_W, CHARGED_H);
      if (b){
        b.life = 2.0;
        SFX.chargedShot();
        Particle.spawn(baseX, baseY, 14, 220, '#ffe066');
        p.shotCd = 0.22; // heavier recovery
      }
    } else {
      // normal
      const speed = 560;
      const b = playerBullets.spawn(baseX, baseY, dir*speed, 0, NORMAL_DMG, 'player', 8, 6);
      if (b){
        b.life = 2.0;
        SFX.shoot();
        p.shotCd = 1/FIRE_RATE;
      }
    }
  }

  function updatePlayer(p, lv, dt){
    p.hitWall=false;

    if (p.invul>0) p.invul -= dt;
    if (p.hurtFlash>0) p.hurtFlash -= dt;
    if (p.dashCd>0) p.dashCd -= dt;
    if (p.shotCd>0) p.shotCd -= dt;

    // --- Jump buffering ---
    if (jumpPressed()) p.jumpBuf = JUMP_BUFFER;
    if (jumpHeld() && p.jumpsLeft === p.jumpsMax) p.jumpBuf = Math.max(p.jumpBuf, JUMP_BUFFER);
    if (p.jumpBuf>0) p.jumpBuf -= dt;

    // --- Dash ---
    const dashing = p.dashT>0;
    if (dashing){
      p.dashT -= dt;
      if (p.dashT<=0) p.vx *= 0.4;
    }
    if (Input.takePressed('k') && p.dashCd<=0 && !dashing){
      p.dashT = DASH_TIME;
      p.dashCd = DASH_COOLDOWN;
      p.vx = p.facing * DASH_SPEED;
      p.vy = Math.min(p.vy, 80);
      p.invul = Math.max(p.invul, 0.25);
      SFX.dash();
      Particle.spawn(p.x+p.w*0.5, p.y+p.h*0.65, 10, 200, '#57ffd9');
    }

    // --- Horizontal movement ---
    let ax=0;
    if (!dashing){
      if (moveLeft()) ax -= 1;
      if (moveRight()) ax += 1;
      if (ax!==0) p.facing = sign(ax);
    }

    if (!dashing){
      const targetV = ax*RUN_SPEED;
      const accel = p.onGround ? 1750 : 1000;
      const dv = targetV - p.vx;
      p.vx += clamp(dv, -accel*dt, accel*dt);

      if (ax===0 && p.onGround){
        p.vx *= Math.pow(0.0006, dt);
        if (Math.abs(p.vx)<6) p.vx=0;
      }
    }

    // --- Gravity ---
    if (!p.onGround || p.vy<0){
      p.vy += GRAVITY*dt;
      if (p.vy>MAX_FALL) p.vy = MAX_FALL;
    }

    // --- Integrate & resolve ---
    p.x += p.vx*dt;
    resolveTileCollisions(p, lv, 'x');

    p.y += p.vy*dt;
    resolveTileCollisions(p, lv, 'y');

    // landing reset
    if (p.onGround){
      p.coyote = COYOTE_TIME;
      p.jumpsLeft = p.jumpsMax;
    } else {
      p.coyote = Math.max(0, p.coyote - dt);
    }

    // execute buffered jump
    if (p.jumpBuf > 0){
      if (p.onGround || p.coyote > 0 || p.jumpsLeft > 0){
        doJump(p);
      }
    }

    // variable jump height
    if (jumpReleased() && p.vy < 0){
      p.vy *= JUMP_CUT;
    }

    // --- Charge Shot System (hold J, release to fire) ---
    // Start charging on press
    if (firePressed()){
      p.charging = true;
      p.chargeT = 0;
      p.chargeReady = false;
    }

    // While holding
    if (p.charging && fireHeld()){
      p.chargeT += dt;
      if (!p.chargeReady && p.chargeT >= CHARGE_TIME){
        p.chargeReady = true;
        SFX.chargeReady();
        Particle.spawn(p.x+p.w*0.5, p.y+8, 18, 180, '#ffe066');
      } else if (!p.chargeReady){
        // subtle tick each ~0.5s while charging
        const tickEvery = 0.50;
        const tPrev = p.chargeT - dt;
        if (Math.floor(tPrev / tickEvery) !== Math.floor(p.chargeT / tickEvery)) SFX.chargeTick();
      }
    }

    // Release: decide shot type
    if (p.charging && fireReleased()){
      const want = (p.chargeT >= CHARGE_TIME) ? 2 : 1;
      p.charging = false;

      if (p.shotCd <= 0){
        fireShot(p, lv, want);
      } else {
        // queue for earliest allowed shot
        p.queuedShot = want;
      }
      p.chargeT = 0;
      p.chargeReady = false;
    }

    // If a shot was queued during cooldown
    if (p.queuedShot && p.shotCd <= 0){
      fireShot(p, lv, p.queuedShot);
      p.queuedShot = 0;
    }

    // --- Hazards ---
    if (isHazardSpike(lv, p.x,p.y,p.w,p.h)){
      damagePlayer(p, lv.spikeDmg, -p.facing*90, -220);
      setMessage('Spikes!', 0.7);
    }

    const worldH = lv.h*TS;
    if (p.y > worldH + 120) respawnPlayer(p, lv, true);

    // --- Checkpoint ---
    const cx = Math.floor((p.x + p.w*0.5)/TS);
    const cy = Math.floor((p.y + p.h*0.8)/TS);
    if (lv.get(cx,cy) === 3){
      if (!lv.checkpoint.active || Math.abs(lv.checkpoint.x - cx*TS) > 1){
        lv.checkpoint.active = true;
        lv.checkpoint.x = cx*TS + 4;
        lv.checkpoint.y = (cy*TS) - 2*TS;
        p.respawnX = lv.checkpoint.x;
        p.respawnY = lv.checkpoint.y;
        setMessage('Checkpoint saved!', 1.1);
        Particle.spawn(cx*TS+16, cy*TS+10, 18, 160, '#57ffd9');
        beep(980, 0.06, 'triangle', 0.05);
      }
    }

    // --- Pickups ---
    for (let i=0;i<lv.pickups.length;i++){
      const it = lv.pickups[i];
      if (!it.active) continue;
      if (aabbOverlap(p.x,p.y,p.w,p.h, it.x,it.y,it.w,it.h)){
        it.active = false;
        const tx=Math.floor((it.x+it.w*0.5)/TS);
        const ty=Math.floor((it.y+it.h*0.5)/TS);
        if (lv.get(tx,ty)===4) lv.set(tx,ty,0);
        healPlayer(p, it.heal);
        setMessage('Energy +' + it.heal, 0.9);
      }
    }

    // --- Boss trigger & snap-in (prevents dash-stuck) ---
    const gateLineX = (lv.bossGateTx + 1) * TS; // inside
    const pCenterX = p.x + p.w * 0.5;
    if (!lv.bossTriggered && pCenterX > gateLineX + 6){
      lv.bossTriggered = true;
      if (lv.boss){
        lv.boss.state='idle';
        lv.boss.t=0;
        lv.boss.cooldown=0.9;
      }
      setMessage('Arena locked! Defeat the boss!', 1.5);
      beep(140, 0.10, 'square', 0.06);

      // snap inside
      const minInsideX = gateLineX + 6;
      if (p.x < minInsideX) p.x = minInsideX;
      if (p.vx < 0) p.vx = 0;
    }
  }

  // ============================================================
  // ENEMIES
  // ============================================================
  function updateWalker(e, lv, dt, player){
    if(!e.alive) return;
    e.vy += GRAVITY*dt;
    if (e.vy>MAX_FALL) e.vy=MAX_FALL;
    e.hitWall=false;

    e.x += e.vx*dt;
    resolveTileCollisions(e, lv, 'x');

    const dir = sign(e.vx) || 1;
    const footX = e.x + (dir>0 ? e.w+1 : -1);
    const footY = e.y + e.h + 2;
    const under = tileAtWorld(lv, footX, footY);
    if (e.hitWall || !lv.isSolid(under)) e.vx = -e.vx;

    e.y += e.vy*dt;
    resolveTileCollisions(e, lv, 'y');

    if (e.touchCd>0) e.touchCd -= dt;
    if (e.touchCd<=0 && aabbOverlap(e.x,e.y,e.w,e.h, player.x,player.y,player.w,player.h)){
      e.touchCd=0.55;
      damagePlayer(player, lv.enemyTouchDmg, sign(player.x-e.x)*150, -190);
      setMessage('Hit!', 0.5);
    }
  }

  function updateTurret(e, lv, dt, player){
    if(!e.alive) return;
    e.shootT += dt;
    if (e.shootT >= e.period){
      e.shootT=0;
      const dir = (player.x+player.w*0.5) >= (e.x+e.w*0.5) ? 1 : -1;
      const sx = e.x + e.w*0.5 + dir*10;
      const sy = e.y + 9;
      const speed = e.bulletSpeed;
      const b = enemyBullets.spawn(sx, sy, dir*speed, 0, lv.enemyBulletDmg, 'enemy', 8, 6);
      if (b) SFX.bossShot();
    }
    if (aabbOverlap(e.x,e.y,e.w,e.h, player.x,player.y,player.w,player.h)){
      damagePlayer(player, 1, sign(player.x-e.x)*90, -120);
    }
  }

  function updateDrone(e, lv, dt, player){
    if(!e.alive) return;
    e.t += dt;
    e.x += e.vx*dt;
    if (e.x < e.xMin){ e.x=e.xMin; e.vx=Math.abs(e.vx); }
    if (e.x > e.xMax){ e.x=e.xMax; e.vx=-Math.abs(e.vx); }
    e.y = e.baseY + Math.sin(e.t*2.3)*14;

    if (aabbOverlap(e.x,e.y,e.w,e.h, player.x,player.y,player.w,player.h)){
      damagePlayer(player, lv.enemyTouchDmg, sign(player.x-e.x)*130, -170);
      setMessage('Hit!', 0.5);
    }
  }

  // ============================================================
  // BOSSES (4 distinct)
  // ============================================================
  function bossShootSpread(boss, player, count, speed, dmg){
    const cx=boss.x+boss.w*0.5, cy=boss.y+18;
    const px=player.x+player.w*0.5, py=player.y+player.h*0.5;
    const base = Math.atan2(py-cy, px-cx);
    const span = 0.30;
    for(let i=0;i<count;i++){
      const t = (count===1) ? 0 : (i/(count-1));
      const a = base + (t-0.5)*span*2;
      enemyBullets.spawn(cx, cy, Math.cos(a)*speed, Math.sin(a)*speed, dmg, 'enemy', 8, 6);
    }
    SFX.bossShot();
  }

  function bossRadialBurst(boss, count, speed, dmg){
    const cx=boss.x+boss.w*0.5, cy=boss.y+18;
    for(let i=0;i<count;i++){
      const a = (i/count) * Math.PI*2;
      enemyBullets.spawn(cx, cy, Math.cos(a)*speed, Math.sin(a)*speed, dmg, 'enemy', 8, 6);
    }
    SFX.bossShot();
  }

  function bossRain(lv, count, dmg, w=8,h=10){
    const topY = 2*TS;
    for(let i=0;i<count;i++){
      const x = randRange(lv.arena.x0 + 40, lv.arena.x1 - 40);
      const b = enemyBullets.spawn(x, topY, randRange(-40,40), randRange(420,520), dmg, 'enemy', w, h);
      if (b){
        b.life = 2.2;
      }
    }
    SFX.bossShot();
  }

  function bossShockwave(boss, lv, dmg){
    // emits ground waves both directions
    const y = 15*TS - 6;
    const cx = boss.x + boss.w*0.5;
    for(let k=1;k<=5;k++){
      const sp = 280 + k*40;
      enemyBullets.spawn(cx, y,  sp, 0, dmg, 'enemy', 10, 6);
      enemyBullets.spawn(cx, y, -sp, 0, dmg, 'enemy', 10, 6);
    }
    SFX.bossShot();
  }

  function bossSpawnSplitOrb(boss, player, lv, dmg){
    const dir = (player.x + player.w*0.5 < boss.x + boss.w*0.5) ? -1 : 1;
    const x = boss.x + boss.w*0.5 + dir*14;
    const y = boss.y + 18;
    const b = enemyBullets.spawn(x, y, dir*240, -40, dmg, 'enemy', 14, 12);
    if (b){
      b.mode='split';
      b.t=0;
      b.T=0.55; // split after a short time or on wall
      b.life=2.0;
    }
    SFX.bossShot();
  }

  function bossSummonOrbit(boss, count, dmg){
    const cx=boss.x+boss.w*0.5, cy=boss.y+18;
    for(let i=0;i<count;i++){
      const b = enemyBullets.spawn(cx, cy, 0, 0, dmg, 'enemy', 10, 10);
      if (!b) continue;
      b.mode='orbit';
      b.t=0;
      b.T=1.25;                 // orbit duration
      b.a = (i/count)*Math.PI*2; // angle
      b.b = 6.2;                 // angular velocity
      b.c = 46;                  // radius
      b.life = 3.0;
    }
    SFX.bossShot();
  }

  function updateBoss(b, lv, dt, player){
    if(!b || !b.alive) return;
    if(!lv.bossTriggered) return;

    if (b.invul>0) b.invul -= dt;

    b.vy += GRAVITY*dt;
    if (b.vy>MAX_FALL) b.vy=MAX_FALL;

    b.t += dt;
    b.facing = (player.x < b.x) ? -1 : 1;

    // boss movement gentle (idle tracking)
    function idleDrift(strength=0.6){
      const targetX = clamp(player.x + player.w*0.5 + (b.facing*-1)*150, lv.arena.x0+TS*2, lv.arena.x1-TS*3);
      b.vx += clamp((targetX - b.x)*strength, -260, 260)*dt;
      b.vx *= Math.pow(0.02, dt);
    }

    // ==========================================================
    // KIND: WARDEN (spread + dash)
    // ==========================================================
    if (b.kind === 'warden'){
      if (b.state==='idle'){
        if (b.cooldown>0) b.cooldown -= dt;
        else {
          const r=Math.random();
          if (r<0.55){ b.state='spread'; b.t=0; }
          else { b.state='dashPrep'; b.t=0; }
        }
        idleDrift(0.6);
      } else if (b.state==='spread'){
        if (b.t>0.22 && b.t<0.22+dt) bossShootSpread(b, player, 3, 360, lv.enemyBulletDmg);
        if (b.t>0.62 && b.t<0.62+dt) bossShootSpread(b, player, 3, 380, lv.enemyBulletDmg);
        if (b.t>=1.02){ b.state='idle'; b.t=0; b.cooldown=0.55; }
      } else if (b.state==='dashPrep'){
        if (b.t<0.08 && b.onGround) b.vy = -340;
        b.vx *= Math.pow(0.001, dt);
        if (b.t>=0.55){
          b.state='dash'; b.t=0;
          const dir = (player.x+player.w*0.5 < b.x+b.w*0.5) ? -1 : 1;
          b.vx = dir * 620;
          b.invul = Math.max(b.invul, 0.08);
          beep(200,0.08,'sawtooth',0.06);
        }
      } else if (b.state==='dash'){
        if (b.t>=0.55){ b.state='recover'; b.t=0; }
      } else if (b.state==='recover'){
        b.vx *= Math.pow(0.0008, dt);
        if (b.t>=0.55){ b.state='idle'; b.t=0; b.cooldown=0.75; }
      }
    }

    // ==========================================================
    // KIND: TEMPEST (lightning rain + leap slam shockwave)
    // ==========================================================
    else if (b.kind === 'tempest'){
      if (b.state==='idle'){
        if (b.cooldown>0) b.cooldown -= dt;
        else {
          const r=Math.random();
          if (r<0.55){ b.state='rain'; b.t=0; b.a=0; }
          else { b.state='leap'; b.t=0; b.phase=0; }
        }
        idleDrift(0.55);
      } else if (b.state==='rain'){
        // for ~1.6s spawn rain at intervals
        b.a += dt;
        if (b.a >= 0.16){
          b.a = 0;
          bossRain(lv, 2, lv.enemyBulletDmg, 8, 14);
        }
        if (b.t>=1.55){ b.state='idle'; b.t=0; b.cooldown=0.70; }
      } else if (b.state==='leap'){
        // Phase 0: jump up, Phase 1: fall, Phase 2: slam emit waves
        if (b.phase===0){
          if (b.onGround){
            b.vy = -520;
            b.vx = b.facing * 180;
            b.phase=1;
            beep(260,0.06,'triangle',0.05);
          }
        } else if (b.phase===1){
          // waiting to land
          if (b.onGround){
            b.phase=2;
            b.t=0;
            bossShockwave(b, lv, lv.enemyBulletDmg+1);
            Particle.spawn(b.x+b.w*0.5, b.y+b.h, 40, 320, '#57ffd9');
            beep(140,0.10,'square',0.07);
          }
        } else if (b.phase===2){
          b.vx *= Math.pow(0.0008, dt);
          if (b.t>=0.55){ b.state='idle'; b.t=0; b.cooldown=0.85; }
        }
      }
    }

    // ==========================================================
    // KIND: FROST (5-way spread + teleport + split orb)
    // ==========================================================
    else if (b.kind === 'frost'){
      if (b.state==='idle'){
        if (b.cooldown>0) b.cooldown -= dt;
        else {
          const r=Math.random();
          if (r<0.55){ b.state='spread5'; b.t=0; }
          else { b.state='blink'; b.t=0; b.phase=0; }
        }
        idleDrift(0.5);
      } else if (b.state==='spread5'){
        if (b.t>0.20 && b.t<0.20+dt) bossShootSpread(b, player, 5, 380, lv.enemyBulletDmg);
        if (b.t>0.55 && b.t<0.55+dt) bossShootSpread(b, player, 5, 410, lv.enemyBulletDmg);
        if (b.t>=0.95){ b.state='idle'; b.t=0; b.cooldown=0.75; }
      } else if (b.state==='blink'){
        // phase 0: disappear/teleport
        if (b.phase===0){
          if (b.t>0.18){
            // teleport to opposite side region
            const left = lv.arena.x0 + TS*2;
            const right = lv.arena.x1 - TS*2 - b.w;
            const toLeft = (player.x > (lv.arena.x0+lv.arena.x1)/2);
            b.x = toLeft ? left : right;
            b.vx = 0; b.vy = Math.min(b.vy, 80);
            b.invul = Math.max(b.invul, 0.25);
            Particle.spawn(b.x+b.w*0.5, b.y+18, 30, 260, '#bfe3ff');
            beep(520,0.06,'triangle',0.06);
            b.phase=1;
            b.t=0;
          }
        } else if (b.phase===1){
          // fire split orb, then return
          if (b.t>0.22 && b.t<0.22+dt) bossSpawnSplitOrb(b, player, lv, lv.enemyBulletDmg+1);
          if (b.t>=0.80){ b.state='idle'; b.t=0; b.cooldown=0.85; }
        }
      }
    }

    // ==========================================================
    // KIND: SOLAR (radial burst + orbiting flames release)
    // ==========================================================
    else if (b.kind === 'solar'){
      if (b.state==='idle'){
        if (b.cooldown>0) b.cooldown -= dt;
        else {
          const r=Math.random();
          if (r<0.52){ b.state='burst'; b.t=0; }
          else { b.state='orbit'; b.t=0; b.phase=0; }
        }
        idleDrift(0.45);
      } else if (b.state==='burst'){
        if (b.t>0.18 && b.t<0.18+dt) bossRadialBurst(b, 12, 330, lv.enemyBulletDmg);
        if (b.t>0.55 && b.t<0.55+dt) bossShootSpread(b, player, 3, 440, lv.enemyBulletDmg+1);
        if (b.t>=1.05){ b.state='idle'; b.t=0; b.cooldown=0.80; }
      } else if (b.state==='orbit'){
        if (b.phase===0){
          if (b.t>0.20){
            bossSummonOrbit(b, 8, lv.enemyBulletDmg);
            Particle.spawn(b.x+b.w*0.5, b.y+18, 30, 240, '#ffe066');
            b.phase=1; b.t=0;
          }
        } else if (b.phase===1){
          // after a while, do a dash to pressure player
          if (b.t>0.65 && b.t<0.65+dt){
            const dir = (player.x+player.w*0.5 < b.x+b.w*0.5) ? -1 : 1;
            b.vx = dir * 520;
            b.invul = Math.max(b.invul, 0.08);
            beep(200,0.08,'sawtooth',0.06);
          }
          if (b.t>=1.15){ b.state='idle'; b.t=0; b.cooldown=0.90; }
        }
      }
    }

    // physics & collisions
    b.hitWall=false;
    b.x += b.vx*dt;
    resolveTileCollisions(b, lv, 'x');
    b.x = clamp(b.x, lv.arena.x0+TS*2, lv.arena.x1-TS*2-b.w);

    b.y += b.vy*dt;
    resolveTileCollisions(b, lv, 'y');

    // touch damage
    if (aabbOverlap(b.x,b.y,b.w,b.h, player.x,player.y,player.w,player.h)){
      damagePlayer(player, Math.max(3, lv.enemyTouchDmg), sign(player.x-b.x)*230, -220);
      setMessage('Boss hit!', 0.6);
    }
  }

  // ============================================================
  // BULLET UPDATE (handles special modes)
  // ============================================================
  function splitBullet(b, lv){
    // spawn 3 shards outward
    const cx=b.x + b.w*0.5, cy=b.y + b.h*0.5;
    const speed=360;
    const angles=[-0.25, 0, 0.25];
    for(let i=0;i<3;i++){
      const a = angles[i];
      enemyBullets.spawn(cx, cy, Math.cos(a)*speed, Math.sin(a)*speed, Math.max(1,b.dmg-1), 'enemy', 8, 6);
    }
    Particle.spawn(cx, cy, 16, 240, '#bfe3ff');
    beep(420,0.05,'square',0.05);
  }

  function updateBullets(pool, lv, dt, player, enemies, boss){
    const worldW=lv.w*TS, worldH=lv.h*TS;

    pool.forEachActive(b=>{
      b.life -= dt;
      if (b.life<=0){ b.active=false; return; }

      // special: orbit bullets follow boss until release
      if (b.mode === 'orbit'){
        b.t += dt;
        if (!boss || !boss.alive){
          // if boss gone, release outward
          b.mode='linear';
          b.vx = Math.cos(b.a) * 360;
          b.vy = Math.sin(b.a) * 360;
        } else {
          b.a += b.b * dt;
          const cx = boss.x + boss.w*0.5;
          const cy = boss.y + 18;
          b.x = cx + Math.cos(b.a)*b.c - b.w*0.5;
          b.y = cy + Math.sin(b.a)*b.c - b.h*0.5;

          // release after duration
          if (b.t >= b.T){
            b.mode='linear';
            const out = 420;
            b.vx = Math.cos(b.a) * out;
            b.vy = Math.sin(b.a) * out;
            b.life = Math.min(b.life, 1.6);
          }
        }

        // still damage player
        if (player.alive && b.from==='enemy' && aabbOverlap(b.x,b.y,b.w,b.h, player.x,player.y,player.w,player.h)){
          b.active=false;
          damagePlayer(player, b.dmg, sign(player.x-b.x)*120, -160);
          return;
        }
        // skip tile collision while orbiting
        return;
      }

      // normal linear movement
      b.x += b.vx*dt;
      b.y += b.vy*dt;

      // split mode timer
      if (b.mode === 'split'){
        b.t += dt;
      }

      // bounds
      if (b.x<-80 || b.y<-80 || b.x>worldW+80 || b.y>worldH+80){
        b.active=false; return;
      }

      // tile collision
      const tx0=Math.floor(b.x/TS), ty0=Math.floor(b.y/TS);
      const tx1=Math.floor((b.x+b.w)/TS), ty1=Math.floor((b.y+b.h)/TS);
      for(let ty=ty0;ty<=ty1;ty++){
        for(let tx=tx0;tx<=tx1;tx++){
          const t=lv.get(tx,ty);
          if (lv.isSolid(t)){
            if (b.mode==='split' && b.from==='enemy'){
              splitBullet(b, lv);
            } else {
              Particle.spawn(b.x,b.y,8,180, b.from==='player' ? '#bfe3ff' : '#ffb2c6');
            }
            b.active=false;
            return;
          }
        }
      }

      // timed split
      if (b.mode==='split' && b.from==='enemy' && b.t >= b.T){
        splitBullet(b, lv);
        b.active=false;
        return;
      }

      // hit checks
      if (b.from==='player'){
        // enemies
        for(let i=0;i<enemies.length;i++){
          const e=enemies[i];
          if(!e.alive) continue;
          if (aabbOverlap(b.x,b.y,b.w,b.h, e.x,e.y,e.w,e.h)){
            b.active=false;
            e.hp -= b.dmg;
            Particle.spawn(b.x,b.y,10,220, '#ffd9a6');
            beep(420,0.04,'square',0.04);
            if (e.hp<=0){
              e.alive=false;
              Particle.spawn(e.x+e.w*0.5,e.y+e.h*0.5,22,260,'#ffe066');
              beep(260,0.06,'square',0.05);
            }
            return;
          }
        }
        // boss
        if (boss && boss.alive && lv.bossTriggered){
          if (aabbOverlap(b.x,b.y,b.w,b.h, boss.x,boss.y,boss.w,boss.h)){
            b.active=false;
            if (boss.invul<=0){
              boss.hp -= b.dmg;
              boss.invul=0.06;
              Particle.spawn(b.x,b.y,12,240, '#ffe066');
              beep(360,0.05,'square',0.05);
              if (boss.hp<=0){
                boss.hp=0;
                boss.alive=false;
                lv.bossDead=true;
                Particle.spawn(boss.x+boss.w*0.5, boss.y+boss.h*0.5, 70, 360, '#ffe066');
                setMessage('Boss defeated!', 1.0);

                if (Game.levelIndex < LEVEL_DEFS.length-1){
                  Game.state='levelclear';
                  beep(660, 0.08, 'triangle', 0.06);
                } else {
                  Game.state='win';
                  SFX.win();
                }
              }
            }
            return;
          }
        }
      } else {
        // enemy bullet vs player
        if (player.alive && aabbOverlap(b.x,b.y,b.w,b.h, player.x,player.y,player.w,player.h)){
          b.active=false;
          damagePlayer(player, b.dmg, sign(player.x-b.x)*120, -160);
          return;
        }
      }
    });
  }

  // ============================================================
  // CAMERA
  // ============================================================
  function updateCamera(cam, lv, player){
    const worldW=lv.w*TS, worldH=lv.h*TS;
    const targetX = player.x + player.w*0.5 - VIEW_W*0.5;
    const targetY = player.y + player.h*0.5 - VIEW_H*0.55;

    cam.x += (targetX-cam.x)*0.12;
    cam.y += (targetY-cam.y)*0.10;

    let minX=0, maxX=Math.max(0, worldW - VIEW_W);
    let minY=0, maxY=Math.max(0, worldH - VIEW_H);

    if (lv.bossTriggered){
      minX = Math.max(0, lv.arena.x0);
      maxX = Math.max(minX, lv.arena.x1 - VIEW_W);
    }

    cam.x = clamp(cam.x, minX, maxX);
    cam.y = clamp(cam.y, minY, maxY);

    cam.x = cam.x|0;
    cam.y = cam.y|0;
  }

  // ============================================================
  // DRAW
  // ============================================================
  function drawBackground(ctx, lvlIdx){
    ctx.fillStyle='#0b0f1a';
    ctx.fillRect(0,0,VIEW_W,VIEW_H);

    // subtle different tints per level
    const tints = ['rgba(70,120,255,0.08)','rgba(87,255,217,0.07)','rgba(191,227,255,0.07)','rgba(255,224,102,0.07)'];
    ctx.fillStyle = tints[lvlIdx] || 'rgba(255,255,255,0.06)';
    ctx.fillRect(0,VIEW_H-170,VIEW_W,90);

    ctx.fillStyle='rgba(255,255,255,0.08)';
    for(let i=0;i<70;i++){
      const x=(i*137)%VIEW_W, y=(i*71)%VIEW_H;
      ctx.fillRect(x,y,2,2);
    }
  }

  function drawTiles(ctx, lv, cam, debug=false){
    const tx0=Math.floor(cam.x/TS), ty0=Math.floor(cam.y/TS);
    const tx1=Math.floor((cam.x+VIEW_W)/TS)+1, ty1=Math.floor((cam.y+VIEW_H)/TS)+1;

    for(let ty=ty0;ty<=ty1;ty++){
      for(let tx=tx0;tx<=tx1;tx++){
        const t=lv.get(tx,ty);
        if (t===0) continue;
        const x=tx*TS-cam.x, y=ty*TS-cam.y;

        if (t===1){
          ctx.fillStyle='#1b2440';
          ctx.fillRect(x,y,TS,TS);
          ctx.fillStyle='rgba(255,255,255,0.06)';
          ctx.fillRect(x+2,y+2,TS-4,6);
        } else if (t===2){
          ctx.fillStyle='#5c1e2f';
          ctx.fillRect(x,y,TS,TS);
          ctx.fillStyle='#ff5a7a';
          for(let k=0;k<4;k++) ctx.fillRect(x+4+k*7, y+TS-14, 5, 12);
        } else if (t===3){
          ctx.fillStyle='#0f2d2a';
          ctx.fillRect(x+6,y+4,TS-12,TS-8);
          ctx.fillStyle='#57ffd9';
          ctx.fillRect(x+10,y+8,TS-20,6);
          ctx.fillRect(x+10,y+18,TS-20,10);
        } else if (t===4){
          ctx.fillStyle='rgba(30,80,120,0.12)';
          ctx.fillRect(x,y,TS,TS);
        } else if (t===5){
          ctx.fillStyle = lv.bossTriggered ? '#3a1e44' : 'rgba(58,30,68,0.28)';
          ctx.fillRect(x,y,TS,TS);
          ctx.fillStyle = lv.bossTriggered ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)';
          ctx.fillRect(x+6,y+6,TS-12,TS-12);
        }

        if (debug && lv.isSolid(t)){
          ctx.strokeStyle='rgba(255,255,0,0.35)';
          ctx.strokeRect(x+0.5,y+0.5,TS-1,TS-1);
        }
      }
    }

    // pickups drawn as gems
    for(let i=0;i<lv.pickups.length;i++){
      const it=lv.pickups[i];
      if(!it.active) continue;
      const x=(it.x-cam.x)|0, y=(it.y-cam.y)|0;
      ctx.fillStyle='#103251';
      ctx.fillRect(x,y,it.w,it.h);
      ctx.fillStyle='#7ad7ff';
      ctx.fillRect(x+4,y+4,it.w-8,it.h-8);
      ctx.fillStyle='rgba(255,255,255,0.2)';
      ctx.fillRect(x+6,y+6,4,4);
    }
  }

  function drawPlayer(ctx,p,cam,debug=false){
    const x=(p.x-cam.x)|0, y=(p.y-cam.y)|0;
    const flash=(p.invul>0 && (((p.invul*20)|0)%2===0)) || p.hurtFlash>0;

    ctx.fillStyle = flash ? '#ffffff' : '#59a9ff';
    ctx.fillRect(x+5,y+6,p.w-10,p.h-10);
    ctx.fillStyle = flash ? '#ffffff' : '#2b5bff';
    ctx.fillRect(x+3,y,p.w-6,10);
    ctx.fillStyle='#0b0f1a';
    ctx.fillRect(x + (p.facing>0?12:6), y+4, 6, 3);

    // arm
    ctx.fillStyle = flash ? '#ffffff' : '#bfe3ff';
    if (p.facing>0) ctx.fillRect(x+p.w-6,y+14,10,6);
    else ctx.fillRect(x-4,y+14,10,6);

    // boots
    ctx.fillStyle = flash ? '#ffffff' : '#17305e';
    ctx.fillRect(x+3,y+p.h-6,8,6);
    ctx.fillRect(x+p.w-11,y+p.h-6,8,6);

    // charge glow
    if (p.charging){
      const r = clamp(p.chargeT/CHARGE_TIME, 0, 1);
      ctx.globalAlpha = 0.35 + 0.35*r;
      ctx.fillStyle = p.chargeReady ? '#ffe066' : '#bfe3ff';
      ctx.fillRect(x-2, y-6, (p.w+4)*r, 4);
      ctx.globalAlpha = 1;
    }

    if (debug){
      ctx.strokeStyle='rgba(0,255,255,0.7)';
      ctx.strokeRect(x+0.5,y+0.5,p.w-1,p.h-1);
    }
  }

  function drawEnemy(ctx,e,cam,debug=false){
    if(!e.alive) return;
    const x=(e.x-cam.x)|0, y=(e.y-cam.y)|0;

    if (e.type==='walker'){
      ctx.fillStyle='#ffb84d';
      ctx.fillRect(x,y,e.w,e.h);
      ctx.fillStyle='#1a1a1a';
      ctx.fillRect(x+5,y+6,5,4);
      ctx.fillRect(x+14,y+6,5,4);
      ctx.fillStyle='#7a3b00';
      ctx.fillRect(x+4,y+e.h-5,e.w-8,5);
    } else if (e.type==='turret'){
      ctx.fillStyle='#a35bff';
      ctx.fillRect(x,y,e.w,e.h);
      ctx.fillStyle='#0b0f1a';
      ctx.fillRect(x+6,y+6,e.w-12,e.h-12);
      ctx.fillStyle='#d7b8ff';
      ctx.fillRect(x+e.w-2,y+9,8,4);
    } else if (e.type==='drone'){
      ctx.fillStyle='#54ffd1';
      ctx.fillRect(x,y,e.w,e.h);
      ctx.fillStyle='#0b0f1a';
      ctx.fillRect(x+6,y+6,6,4);
      ctx.fillRect(x+e.w-12,y+6,6,4);
      ctx.fillStyle='rgba(255,255,255,0.18)';
      ctx.fillRect(x+2,y+2,e.w-4,3);
    }

    if (debug){
      ctx.strokeStyle='rgba(255,0,255,0.7)';
      ctx.strokeRect(x+0.5,y+0.5,e.w-1,e.h-1);
    }
  }

  function drawBoss(ctx,b,cam,debug=false){
    if(!b||!b.alive) return;
    const x=(b.x-cam.x)|0, y=(b.y-cam.y)|0;
    const flash=(b.invul>0 && (((b.invul*30)|0)%2===0));

    // different look per boss kind
    let base='#ff4d78', core='#7a1f3b', eye='#ffe066', aura='#ffd1dc';
    if (b.kind==='warden'){ base='#ff4d78'; core='#7a1f3b'; eye='#ffe066'; aura='#ffd1dc'; }
    if (b.kind==='tempest'){ base='#57ffd9'; core='#0f2d2a'; eye='#bfe3ff'; aura='#2b5bff'; }
    if (b.kind==='frost'){ base='#bfe3ff'; core='#17305e'; eye='#ffffff'; aura='#7ad7ff'; }
    if (b.kind==='solar'){ base='#ffe066'; core='#7a3b00'; eye='#ff4d78'; aura='#ffd9a6'; }

    ctx.fillStyle = flash ? '#ffffff' : base;
    ctx.fillRect(x,y,b.w,b.h);

    ctx.fillStyle = flash ? '#ffffff' : core;
    ctx.fillRect(x+7,y+10,b.w-14,b.h-18);

    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(x + (b.facing>0 ? b.w-20 : 10), y+16, 10, 6);

    ctx.fillStyle = eye;
    ctx.fillRect(x + (b.facing>0 ? b.w-16 : 14), y+18, 4, 2);

    ctx.fillStyle = aura;
    if (b.facing>0) ctx.fillRect(x+b.w-2,y+24,12,9);
    else ctx.fillRect(x-10,y+24,12,9);

    // little emblem
    ctx.fillStyle='rgba(0,0,0,0.18)';
    ctx.fillRect(x+b.w/2-6, y+b.h/2-4, 12, 8);

    if (debug){
      ctx.strokeStyle='rgba(255,255,255,0.7)';
      ctx.strokeRect(x+0.5,y+0.5,b.w-1,b.h-1);
    }
  }

  function drawBullets(ctx,pool,cam,forPlayer){
    pool.forEachActive(b=>{
      const x=(b.x-cam.x)|0, y=(b.y-cam.y)|0;

      // color by type
      let col = forPlayer ? '#bfe3ff' : '#ffb2c6';
      if (!forPlayer && b.mode==='orbit') col = '#ffe066';
      if (!forPlayer && b.mode==='split') col = '#bfe3ff';
      if (forPlayer && b.dmg >= CHARGED_DMG) col = '#ffe066';

      ctx.fillStyle=col;
      ctx.fillRect(x,y,b.w,b.h);

      // simple highlight for charged
      if (forPlayer && b.dmg >= CHARGED_DMG){
        ctx.fillStyle='rgba(255,255,255,0.25)';
        ctx.fillRect(x+2,y+2, Math.max(1,b.w-4), 3);
      }
    });
  }

  function drawHUD(ctx,g){
    const p=g.player, lv=g.lv;
    const pad=12;

    ctx.fillStyle='rgba(0,0,0,0.35)';
    ctx.fillRect(pad,pad,520,66);

    // level title
    ctx.fillStyle='rgba(255,255,255,0.82)';
    ctx.font='14px system-ui';
    ctx.fillText(`${lv.name}  (${g.levelIndex+1}/4)`, pad+10, pad+18);

    // HP
    const barW=220, barH=12;
    const hpRatio=p.hp/PLAYER_MAX_HP;
    ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.font='13px system-ui';
    ctx.fillText('HP', pad+10, pad+40);

    ctx.fillStyle='#1b2440';
    ctx.fillRect(pad+40,pad+31,barW,barH);
    ctx.fillStyle='#59a9ff';
    ctx.fillRect(pad+40,pad+31,(barW*hpRatio)|0,barH);
    ctx.strokeStyle='rgba(255,255,255,0.25)';
    ctx.strokeRect(pad+40+0.5,pad+31+0.5,barW-1,barH-1);

    // Dash
    const d = clamp(1 - (p.dashCd / DASH_COOLDOWN), 0, 1);
    ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.fillText('DASH', pad+270, pad+40);
    ctx.fillStyle='#1b2440';
    ctx.fillRect(pad+315,pad+31,180,10);
    ctx.fillStyle='#57ffd9';
    ctx.fillRect(pad+315,pad+31,(180*d)|0,10);

    // Charge meter
    const cr = clamp(p.chargeT/CHARGE_TIME, 0, 1);
    ctx.fillStyle='rgba(255,255,255,0.65)';
    ctx.fillText('CHARGE', pad+10, pad+60);
    ctx.fillStyle='#1b2440';
    ctx.fillRect(pad+70,pad+52,220,10);
    ctx.fillStyle = p.chargeReady ? '#ffe066' : '#bfe3ff';
    ctx.fillRect(pad+70,pad+52,(220*cr)|0,10);

    // jumps
    ctx.fillStyle='rgba(255,255,255,0.55)';
    ctx.font='12px system-ui';
    ctx.fillText(`Jumps: ${p.jumpsLeft}/${p.jumpsMax}`, pad+320, pad+60);

    // Boss HP
    if (lv.bossTriggered && lv.boss){
      const boss = lv.boss;
      const ratio = boss.alive ? (boss.hp/boss.maxHp) : 0;
      const bw=380, bh=14;
      const x=(VIEW_W-bw)*0.5, y=14;

      ctx.fillStyle='rgba(0,0,0,0.35)';
      ctx.fillRect(x-10,y-8,bw+20,36);

      ctx.fillStyle='rgba(255,255,255,0.75)';
      const bossName = boss.kind==='warden'?'Warden':
                       boss.kind==='tempest'?'Tempest Core':
                       boss.kind==='frost'?'Frost Wraith':'Solar Colossus';
      ctx.fillText(bossName, x, y+2);

      ctx.fillStyle='#3a0f1c';
      ctx.fillRect(x,y+8,bw,bh);
      ctx.fillStyle='#ff4d78';
      ctx.fillRect(x,y+8,(bw*ratio)|0,bh);
      ctx.strokeStyle='rgba(255,255,255,0.22)';
      ctx.strokeRect(x+0.5,y+8+0.5,bw-1,bh-1);
    }

    // bottom message
    if (g.msgT>0 && g.msg){
      ctx.fillStyle='rgba(0,0,0,0.35)';
      ctx.fillRect((VIEW_W-560)/2, VIEW_H-70, 560, 44);
      ctx.fillStyle='rgba(255,255,255,0.9)';
      ctx.font='16px system-ui';
      ctx.fillText(g.msg, (VIEW_W-560)/2 + 16, VIEW_H-42);
    }

    ctx.font='12px system-ui';
    ctx.fillStyle='rgba(255,255,255,0.55)';
    ctx.fillText('A/D ←/→: Move  W/↑/Space: Jump(2x)  J: Hold+Release (Charge 2s)  K: Dash  P: Pause  R: Restart  H: Hitbox', 12, VIEW_H-12);
  }

 function drawOverlay(ctx, state, g) {
  if (state === 'intro') {
    const w = 820, h = 380;
    const x = (VIEW_W - w) / 2, y = (VIEW_H - h) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    ctx.fillStyle = '#ffffff';
    ctx.font = '28px system-ui';
    ctx.fillText('NOVA BLASTER', x + 28, y + 56);

    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = '15px system-ui';
    // Translation: 4 stages — increasing difficulty. Each boss has unique skills, power, and appearance.
    ctx.fillText('4 Stages — increasing difficulty. Each Boss has unique skills, power, and appearance.', x + 28, y + 86);

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '16px system-ui';
    ctx.fillText('Controls:', x + 28, y + 126);

    ctx.font = '15px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    // Translation: A/D or Arrows: Run
    ctx.fillText('A/D or ←/→: Run', x + 28, y + 154);
    // Translation: W or Up or Space: Jump (Double Jump)
    ctx.fillText('W or ↑ or Space: Jump (Double Jump)', x + 28, y + 178);
    // Translation: J: Hold and RELEASE to shoot — hold 2s for Charge Shot (bigger bullet, high damage)
    ctx.fillText('J: Hold and RELEASE to shoot — hold 2s for Charge Shot (high damage)', x + 28, y + 202);
    // Translation: K: dash | P: pause | R: restart level | H: hitbox
    ctx.fillText('K: Dash  |  P: Pause  |  R: Restart Level  |  H: Hitbox', x + 28, y + 226);

    ctx.fillStyle = '#57ffd9';
    ctx.font = '17px system-ui';
    // Translation: CLICK / PRESS ANY KEY TO START
    ctx.fillText('CLICK / PRESS ANY KEY TO START', x + 28, y + 348);
  }

  if (state === 'paused') {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = '34px system-ui';
    ctx.fillText('PAUSED', VIEW_W / 2 - 70, VIEW_H / 2 - 10);
    ctx.font = '16px system-ui';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    // Translation: Press P to continue
    ctx.fillText('Press P to Continue', VIEW_W / 2 - 78, VIEW_H / 2 + 22);
  }

  if (state === 'gameover') {
    ctx.fillStyle = 'rgba(0,0,0,0.60)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = '#ff4d78';
    ctx.font = '40px system-ui';
    ctx.fillText('GAME OVER', VIEW_W / 2 - 120, VIEW_H / 2 - 12);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '16px system-ui';
    // Translation: Press R to retry level
    ctx.fillText('Press R to Retry Level', VIEW_W / 2 - 98, VIEW_H / 2 + 22);
  }

  if (state === 'levelclear') {
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = '#57ffd9';
    ctx.font = '44px system-ui';
    ctx.fillText('LEVEL CLEAR', VIEW_W / 2 - 140, VIEW_H / 2 - 18);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '16px system-ui';
    // Translation: Press N or Enter for next level
    ctx.fillText('Press N or Enter for Next Level', VIEW_W / 2 - 168, VIEW_H / 2 + 22);
    // Translation: Press R to replay this level
    ctx.fillText('Press R to Replay Level', VIEW_W / 2 - 104, VIEW_H / 2 + 48);
  }

  if (state === 'win') {
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = '#ffe066';
    ctx.font = '44px system-ui';
    ctx.fillText('YOU WIN', VIEW_W / 2 - 92, VIEW_H / 2 - 16);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '16px system-ui';
    // Translation: Press R to restart from Level 1
    ctx.fillText('Press R to Restart from Level 1', VIEW_W / 2 - 132, VIEW_H / 2 + 22);
  }
}

  // ============================================================
  // STEP / LOOP
  // ============================================================
  function step(dt){
    const g=Game, lv=g.lv, p=g.player;

    if (!audioEnabled && Input.consumeAny()){
      ensureAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(()=>{});
    }

    if (Input.takePressed('h')) g.debug = !g.debug;

    // Restart behavior
    if (Input.takePressed('r')){
      if (g.state === 'win'){
        g.levelIndex = 0;
        g.reset(false);
        setMessage('Restart from Level 1', 1.2);
      } else {
        g.reset(g.state==='intro');
        if (g.state!=='intro') setMessage('Restarted!', 0.9);
      }
      return;
    }

    if (g.state==='intro'){
      if (Input.consumeAny()) g.state='playing';
      return;
    }

    // Next level
    if (g.state==='levelclear'){
      if (Input.takePressed('n') || Input.takePressed('enter')){
        g.nextLevel();
      }
      Particle.update(dt);
      return;
    }

    if (Input.takePressed('p')){
      if (g.state==='playing') g.state='paused';
      else if (g.state==='paused') g.state='playing';
    }

    if (g.state!=='playing'){
      if (g.msgT>0) g.msgT -= dt;
      Particle.update(dt);
      return;
    }

    if (g.msgT>0) g.msgT -= dt;

    if (p.alive) updatePlayer(p, lv, dt);

    // enemies
    for(let i=0;i<lv.enemies.length;i++){
      const e=lv.enemies[i];
      if(!e.alive) continue;
      if (e.type==='walker') updateWalker(e, lv, dt, p);
      else if (e.type==='turret') updateTurret(e, lv, dt, p);
      else if (e.type==='drone') updateDrone(e, lv, dt, p);
    }

    // boss
    updateBoss(lv.boss, lv, dt, p);

    // bullets
    updateBullets(playerBullets, lv, dt, p, lv.enemies, lv.boss);
    updateBullets(enemyBullets,  lv, dt, p, lv.enemies, lv.boss);

    Particle.update(dt);
    updateCamera(g.cam, lv, p);
  }

  function render(){
    const g=Game, lv=g.lv, p=g.player, cam=g.cam;

    drawBackground(ctx, g.levelIndex);
    drawTiles(ctx, lv, cam, g.debug);

    for(let i=0;i<lv.enemies.length;i++) drawEnemy(ctx, lv.enemies[i], cam, g.debug);
    drawBoss(ctx, lv.boss, cam, g.debug);
    drawPlayer(ctx, p, cam, g.debug);

    drawBullets(ctx, playerBullets, cam, true);
    drawBullets(ctx, enemyBullets,  cam, false);

    Particle.draw(ctx, cam);
    drawHUD(ctx, g);
    drawOverlay(ctx, g.state, g);
  }

  // ============================================================
  // MAIN LOOP (fixed timestep)
  // ============================================================
  let lastT = performance.now();
  let acc = 0;

  function frame(now){
    let dt = (now-lastT)/1000;
    lastT = now;
    dt = Math.min(MAX_FRAME_DT, Math.max(0, dt));
    acc += dt;

    let steps=0;
    while (acc >= FIXED_DT && steps < MAX_STEPS){
      step(FIXED_DT);
      acc -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0;

    render();
    Input.endFrame();
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
