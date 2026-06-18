/* =====================================================================
   公平德州扑克 · 联机服务端
   - 真人对战：无机器人。房间满足 2 人及以上即可开局。
   - 洗牌、发牌、比牌全部在服务器完成；每个玩家只收到自己的底牌。
   - 公平性：每局开局公示整副牌 SHA-256 指纹，结束公开牌序+盐供核对。
   - 规则：15 秒行动限时(可延时)、整局时长、全员弃牌看底牌、河牌跟注强制亮牌。
   ===================================================================== */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const db = require("./db.js");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");

/* ---------- 静态文件服务（把 public/ 里的网页发给浏览器） ---------- */
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".css":"text/css",
  ".png":"image/png", ".ico":"image/x-icon", ".json":"application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/" ) p = "/index.html";
  if (p === "/health") { res.writeHead(200); return res.end("ok"); }   // 唤醒用
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ""));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

/* =====================================================================
   牌与引擎
   ===================================================================== */
const SUITS = ["♠","♥","♦","♣"];
const RNAME = {11:"J",12:"Q",13:"K",14:"A"};
const rname = r => RNAME[r] || String(r);
const cardCode = c => rname(c.r) + c.s;

function rint(n){
  if (n <= 1) return 0;
  const lim = Math.floor(0x100000000 / n) * n, buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= lim);
  return buf[0] % n;
}
const r01 = () => rint(1<<30) / (1<<30);
function freshDeck(){ const d=[]; for(const s of SUITS) for(let r=2;r<=14;r++) d.push({r,s}); return d; }

/* 真人洗牌：切牌 + 7 次 GSR 交错洗 */
function riffleOnce(deck){
  let k=0; for(let i=0;i<deck.length;i++) k+=rint(2);
  k=Math.max(1,Math.min(deck.length-1,k));
  const A=deck.slice(0,k), B=deck.slice(k), out=[];
  let a=A.length,b=B.length,ai=0,bi=0;
  while(a+b>0){ if(rint(a+b)<a){ out.push(A[ai++]); a--; } else { out.push(B[bi++]); b--; } }
  return {out,k};
}
function cutOnce(deck){ const k=1+rint(deck.length-1); return {out:deck.slice(k).concat(deck.slice(0,k)),k}; }
function humanShuffle(deck){
  const log=[]; let d=deck.slice(), r;
  r=cutOnce(d); d=r.out; log.push(`切牌 @ 第 ${r.k} 张`);
  for(let i=1;i<=7;i++){
    r=riffleOnce(d); d=r.out;
    log.push(`第 ${i} 次交错洗牌（分叠 ${r.k}/${52-r.k}）`);
    if(i===3||i===5){ r=cutOnce(d); d=r.out; log.push(`切牌 @ 第 ${r.k} 张`); }
  }
  r=cutOnce(d); d=r.out; log.push(`最终切牌 @ 第 ${r.k} 张`);
  return {deck:d,log};
}
function sha256hex(str){ return crypto.createHash("sha256").update(str).digest("hex"); }
function saltHex(){ return crypto.randomBytes(8).toString("hex"); }

/* 牌力评估 */
function eval5(cs){
  const rs=cs.map(c=>c.r).sort((a,b)=>b-a);
  const flush=cs.every(c=>c.s===cs[0].s);
  const cnt={}; rs.forEach(r=>cnt[r]=(cnt[r]||0)+1);
  const g=Object.keys(cnt).map(r=>[+r,cnt[r]]).sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  const u=[...new Set(rs)];
  let sh=0;
  if(u.length===5){ if(u[0]-u[4]===4) sh=u[0]; else if(u[0]===14&&u[1]===5) sh=5; }
  if(flush&&sh) return [8,sh];
  if(g[0][1]===4) return [7,g[0][0],g[1][0]];
  if(g[0][1]===3&&g[1][1]===2) return [6,g[0][0],g[1][0]];
  if(flush) return [5,...rs];
  if(sh) return [4,sh];
  if(g[0][1]===3) return [3,g[0][0],g[1][0],g[2][0]];
  if(g[0][1]===2&&g[1][1]===2) return [2,g[0][0],g[1][0],g[2][0]];
  if(g[0][1]===2) return [1,g[0][0],g[1][0],g[2][0],g[3][0]];
  return [0,...rs];
}
function cmpRank(a,b){ for(let i=0;i<Math.max(a.length,b.length);i++){ const d=(a[i]||0)-(b[i]||0); if(d) return d; } return 0; }
function evalAny(cards){
  if(cards.length<5) return [0,...cards.map(c=>c.r).sort((a,b)=>b-a)];
  let best=null;
  const idx=[...cards.keys()];
  const combos=(arr,k)=>{ const res=[]; const rec=(s,c)=>{ if(c.length===k){res.push(c.slice());return;} for(let i=s;i<arr.length;i++){c.push(arr[i]);rec(i+1,c);c.pop();}}; rec(0,[]); return res; };
  for(const cb of combos(idx,5)){
    const r=eval5(cb.map(i=>cards[i]));
    if(!best||cmpRank(r,best)>0) best=r;
  }
  return best;
}
function rankName(r){
  const n=["高牌","一对","两对","三条","顺子","同花","葫芦","四条","同花顺"][r[0]];
  return (r[0]===8&&r[1]===14)?"皇家同花顺":n;
}

/* =====================================================================
   房间
   ===================================================================== */
const rooms = new Map();    // code -> Room
const TURN_SECONDS = 15;

function send(ws, obj){ try{ if(ws&&ws.readyState===1) ws.send(JSON.stringify(obj)); }catch(e){} }

class Room {
  constructor(code, opts){
    this.code = code;
    this.name = opts.name || "朋友局";
    this.maxN = opts.maxN || 9;
    this.buyin = opts.buyin || 400;
    this.sb = opts.sb || 1;
    this.bb = this.sb * 2;
    this.dur = opts.dur || 30;             // 分钟，0=不限时
    this.seats = new Array(this.maxN).fill(null); // 每个座位 {id,name,ws,chips,buyin,...}
    this.btn = -1;
    this.handNo = 0;
    this.history = [];
    this.inHand = false;
    this.sessionRemain = this.dur ? this.dur*60 : -1;
    this.lastActive = Date.now();
    this.ledger = {};      // token -> {name,chips,buyin}  退出后保存分数，重进恢复
    this.hostToken = null; // 房主（第一个进来的人）
    this.startSessionClock();
  }
  occupied(){ return this.seats.filter(Boolean); }
  byId(id){ return this.seats.find(p=>p&&p.id===id) || null; }
  freeSeat(){ return this.seats.findIndex(s=>s===null); }

  startSessionClock(){
    if(this._sc) return;
    this._sc=setInterval(()=>{
      if(this.sessionRemain>0){
        this.sessionRemain--;
        if(this.sessionRemain%5===0) this.broadcastState();   // 减少消息量
        if(this.sessionRemain===0) this.log("整局时间到，本手打完后自动总结算","sys");
      }
    },1000);
  }
  destroy(){ clearInterval(this._sc); clearInterval(this._turnIv); clearTimeout(this._nextTo); rooms.delete(this.code); }

  log(msg,cls=""){ this.broadcast({t:"log",msg,cls}); }
  broadcast(obj){ for(const p of this.occupied()) send(p.ws,obj); }

  /* ---- 加入 / 离座 ---- */
  join(ws, name, token){
    // 同一 token 已在座（同一人开了两个页面）→ 当作重连
    const existing = token ? this.seats.find(p=>p&&p.token===token) : null;
    if(existing){ existing.ws=ws; existing.connected=true; if(existing.status==="掉线")existing.status="";
      send(ws,{t:"joined",youId:existing.id,room:this.meta()}); this.broadcastState(); return existing; }
    const seat=this.freeSeat();
    if(seat<0){ send(ws,{t:"error",msg:"房间已满"}); return null; }
    const id=crypto.randomBytes(4).toString("hex");
    // 从账本恢复分数（退出再进，分数照旧）
    const saved = token && this.ledger[token];
    const p={id,token:token||id,name:(saved&&saved.name)||name||("玩家"+(seat+1)),ws,seat,
      chips: saved?saved.chips:this.buyin,
      buyin: saved?saved.buyin:this.buyin,
      hole:[],bet:0,contrib:0,folded:true,allIn:false,revealed:false,foldShow:false,status:"",
      sittingOut:false,connected:true};
    this.seats[seat]=p;
    if(!this.hostToken) this.hostToken=p.token;   // 第一个进来的人是房主
    this.lastActive=Date.now();
    send(ws,{t:"joined",youId:id,room:this.meta()});
    this.log(saved?`${p.name} 回到房间（分数已恢复：${p.chips}）`:`${p.name} 加入了房间`,"sys");
    this.broadcastState();
    // 不再自动开局：等房主点「开始」。若正在进行中则下一手自动带上新玩家。
    return p;
  }
  saveToLedger(p){ if(!p) return; this.ledger[p.token]={name:p.name,chips:p.chips,buyin:p.buyin}; }
  leave(id){
    const p=this.byId(id); if(!p) return;
    if(this.inHand && !p.folded){ p.folded=true; p.status="离座弃牌"; }
    this.saveToLedger(p);                       // 保存分数，下次回来恢复
    this.log(`${p.name} 离开了房间（分数已保存）`,"sys");
    this.seats[p.seat]=null;
    // 房主走了，顺位给下一个在座的人
    if(this.hostToken===p.token){ const n=this.occupied()[0]; this.hostToken=n?n.token:null; }
    if(this.occupied().length===0){ /* 留空房保存账本，10 分钟后再清 */ this.scheduleEmptyCleanup(); }
    this.broadcastState();
  }
  scheduleEmptyCleanup(){
    clearTimeout(this._emptyTo);
    this._emptyTo=setTimeout(()=>{ if(this.occupied().length===0) this.destroy(); }, 10*60*1000);
  }
  disconnect(id){
    const p=this.byId(id); if(!p) return;
    p.connected=false; p.status="掉线";
    this.saveToLedger(p);
    this.broadcastState();
    setTimeout(()=>{ const q=this.byId(id); if(q&&!q.connected) this.leave(id); },60000);
  }
  reconnect(id, ws){
    const p=this.byId(id); if(!p) return false;
    p.ws=ws; p.connected=true; if(p.status==="掉线") p.status="";
    send(ws,{t:"joined",youId:id,room:this.meta()});
    this.broadcastState();
    return true;
  }

  meta(){ return {code:this.code,name:this.name,sb:this.sb,bb:this.bb,buyin:this.buyin,
    dur:this.dur,maxN:this.maxN}; }

  addOn(id){
    const p=this.byId(id); if(!p) return;
    if(this.inHand && !p.folded){ send(p.ws,{t:"toast",msg:"本手结束后再补码"}); return; }
    p.chips+=this.buyin; p.buyin+=this.buyin;
    this.log(`${p.name} 补码 +${this.buyin}（计入带入）`,"sys");
    this.broadcastState();
  }

  /* ---- 开局 ---- */
  // 房主点「开始游戏」才起第一手
  startByHost(token){
    if(token!==this.hostToken) return;            // 只有房主能开
    if(this.inHand) return;
    if(this.sessionRemain===0){ this.endSession(); return; }
    const ready=this.occupied().filter(p=>p.chips>0);
    if(ready.length>=2) this.startHand();
    else this.broadcast({t:"toast",msg:"至少需要 2 人才能开始"});
  }
  // 手与手之间是否还能继续（用于自动开下一手）
  canContinue(){
    if(this.sessionRemain===0) return false;
    return this.occupied().filter(p=>p.chips>0).length>=2;
  }

  /* ---- 一手 ---- */
  startHand(){
    const ready=this.occupied().filter(p=>p.chips>0);
    if(ready.length<2){ this.broadcastState(); return; }
    this.inHand=true; this.handNo++;
    this.board=[]; this.potCollected=0; this.currentBet=0; this.lastRaise=this.bb;
    for(const p of this.occupied()){
      if(p.chips<=0){ p.chips+=this.buyin; p.buyin+=this.buyin; this.log(`${p.name} 筹码用尽，补码 +${this.buyin}`,"sys"); }
      Object.assign(p,{hole:[],bet:0,contrib:0,folded:false,allIn:false,revealed:false,foldShow:false,status:""});
    }
    this.snap={}; for(const p of this.occupied()) this.snap[p.id]=p.chips;

    // 庄家按在座顺序轮转
    const order=this.seats.map((s,i)=>s?i:-1).filter(i=>i>=0);
    let bi=order.indexOf(this.btn);
    this.btn = order[(bi+1)%order.length];

    // 洗牌 + 承诺
    const sh=humanShuffle(freshDeck());
    this.deck=sh.deck; this.shuffleLog=sh.log;
    this.salt=saltHex();
    this.orderStr=this.deck.map(cardCode).join(",");
    this.commit=sha256hex(this.salt+"|"+this.orderStr);
    this.log(`—— 第 ${this.handNo} 局 ——`,"hl");
    this.log(`荷官洗牌完成；开局指纹 ${this.commit.slice(0,24)}…`,"sys");

    // 盲注
    const seatsInHand=order;        // 仍是全部在座（含 chips>0）
    const live=order.filter(i=>this.seats[i].chips>0);
    const pos=live;                 // 有筹码的座位
    const bIdx=pos.indexOf(this.btn);
    const sbSeat=pos[(bIdx+1)%pos.length];
    const bbSeat=pos[(bIdx+2)%pos.length];
    this.post(this.seats[sbSeat],this.sb,"小盲");
    this.post(this.seats[bbSeat],this.bb,"大盲");
    this.currentBet=this.bb;
    this.log(`${this.seats[sbSeat].name} 小盲 ${this.sb}，${this.seats[bbSeat].name} 大盲 ${this.bb}`);

    // 发底牌（绕桌两轮）
    for(let round=0;round<2;round++){
      for(const i of pos){ this.seats[i].hole.push(this.deck.shift()); }
    }
    this.stageName="翻牌前";
    this.posOrder=pos;
    this.bbSeat=bbSeat;
    this.broadcastState();

    // 第一个行动者：大盲下一位
    this.beginBetting((pos.indexOf(bbSeat)+1)%pos.length);
  }

  post(p,amt,st){ const a=Math.min(amt,p.chips); p.chips-=a; p.bet+=a; p.contrib+=a; if(p.chips===0)p.allIn=true; p.status=st; }
  liveSeats(){ return this.posOrder.filter(i=>!this.seats[i].folded); }
  actableSeats(){ return this.posOrder.filter(i=>!this.seats[i].folded&&!this.seats[i].allIn); }

  beginBetting(startPosIdx){
    this.betActed=new Set();
    this.betPtr=startPosIdx;
    this.advanceTurn(true);
  }
  /* 推进到下一个需要行动的人；firstCall 时不前移 */
  advanceTurn(first){
    // 收束判断
    const check=()=>{
      if(this.liveSeats().length<=1) return "fold_end";
      const actable=this.actableSeats();
      if(actable.length===0) return "street_end";
      const allMatched=actable.every(i=>this.betActed.has(i)&&this.seats[i].bet===this.currentBet);
      if(allMatched) return "street_end";
      return null;
    };
    let res=check();
    if(res){ return this.endBetting(res); }
    // 找下一个可行动的人
    const pos=this.posOrder;
    let guard=0;
    while(guard++<pos.length*2){
      if(!first) this.betPtr=(this.betPtr+1)%pos.length;
      first=false;
      const i=pos[this.betPtr];
      const p=this.seats[i];
      if(!p.folded && !p.allIn){ this.setTurn(i); return; }
    }
    this.endBetting("street_end");
  }
  setTurn(seatIdx){
    this.actingSeat=seatIdx;
    this.turnRemain=TURN_SECONDS; this.turnTotal=TURN_SECONDS;
    this.broadcastState();
    clearInterval(this._turnIv);
    this._turnIv=setInterval(()=>{
      this.turnRemain--;
      if(this.turnRemain<=0){
        clearInterval(this._turnIv);
        // 超时：能过牌则过牌，否则弃牌
        const p=this.seats[this.actingSeat];
        if(this.currentBet-p.bet>0){ this.applyAction(p.id,{type:"fold"},true); }
        else { this.applyAction(p.id,{type:"check"},true); }
      } else {
        this.broadcast({t:"turn",seat:this.actingSeat,remain:this.turnRemain,total:this.turnTotal});
      }
    },1000);
  }
  extend(id){
    const p=this.byId(id); if(!p||this.seats[this.actingSeat]!==p) return;
    this.turnRemain+=15; this.turnTotal+=15;
    this.log(`${p.name} 延时 +15秒`,"sys");
    this.broadcast({t:"turn",seat:this.actingSeat,remain:this.turnRemain,total:this.turnTotal});
  }

  /* 处理玩家动作 */
  applyAction(id, act, isTimeout){
    if(!this.inHand) return;
    const p=this.byId(id);
    if(!p || this.seats[this.actingSeat]!==p) return;     // 不是你的回合
    clearInterval(this._turnIv);
    const before=this.currentBet;
    const toCall=this.currentBet-p.bet;
    if(act.type==="fold"){ p.folded=true; p.status="弃牌"; this.log(`${p.name} 弃牌`); }
    else if(act.type==="check"){
      if(toCall>0){ // 非法过牌 → 当跟注/弃牌兜底
        if(p.chips>0) return this.applyAction(id,{type:"call"});
        p.folded=true; p.status="弃牌";
      } else { p.status="过牌"; this.log(`${p.name} 过牌`); }
    }
    else if(act.type==="call"){
      const need=Math.min(toCall,p.chips);
      this.post(p,need,need>=p.chips+0&&p.chips===0?"全下":(need===0?"过牌":"跟注"));
      if(p.chips===0){p.allIn=true;p.status="全下";}
      this.log(`${p.name} ${p.status} ${need}`);
    }
    else if(act.type==="raise"){
      let target=Math.max(act.to||0, this.minRaiseTo(p));
      target=Math.min(target,p.bet+p.chips);
      const add=target-p.bet;
      this.post(p,add,"");
      if(p.chips===0){p.allIn=true;p.status="全下 "+p.bet;} else p.status="加注至 "+p.bet;
      if(p.bet>this.currentBet){ this.lastRaise=Math.max(this.lastRaise,p.bet-this.currentBet); this.currentBet=p.bet; }
      this.log(`${p.name} ${p.status}`);
    }
    this.betActed.add(p.seat);
    if(this.currentBet>before){ this.betActed=new Set([p.seat]); }
    this.lastActive=Date.now();
    this.advanceTurn(false);
  }
  minRaiseTo(p){ return Math.min(this.currentBet+this.lastRaise, p.bet+p.chips); }

  endBetting(reason){
    clearInterval(this._turnIv);
    this.actingSeat=-1;
    for(const i of this.posOrder){ const p=this.seats[i]; this.potCollected+=p.bet; p.bet=0; if(!p.folded&&!p.allIn) p.status=""; }
    this.currentBet=0; this.lastRaise=this.bb;
    this.broadcastState();
    if(reason==="fold_end" || this.liveSeats().length<=1) return this.endByFold();
    // 进入下一街或摊牌
    setTimeout(()=>this.nextStreet(),700);
  }
  nextStreet(){
    const seq=[["翻牌",3],["转牌",1],["河牌",1]];
    const dealt = this.board.length;
    let stageIdx = dealt===0?0 : dealt===3?1 : dealt===4?2 : 3;
    if(stageIdx>2) return this.showdown();
    const [nm,cnt]=seq[stageIdx];
    this.deck.shift(); // 烧牌
    for(let i=0;i<cnt;i++) this.board.push(this.deck.shift());
    this.stageName=nm;
    this.log(`烧 1 张，发${nm}：${this.board.slice(-cnt).map(cardCode).join(" ")}`,"hl");
    this.broadcastState();
    if(this.actableSeats().length>1){
      const pos=this.posOrder;
      // 翻后从庄家下一个仍在局中的人开始
      let start=(pos.indexOf(this.btn)+1)%pos.length;
      // 跳到第一个可行动者由 advanceTurn 处理
      setTimeout(()=>this.beginBetting(start),500);
    } else {
      setTimeout(()=>this.nextStreet(),900);   // 全员all-in，连发到底
    }
  }

  endByFold(){
    const liveIdx=this.liveSeats();
    const w=this.seats[liveIdx[0]];
    const won=this.potCollected;
    w.chips+=won; this.potCollected=0;
    this.log(`其余玩家全部弃牌，${w.name} 收下底池 ${won}`,"hl");
    // 复盘：翻完公共牌 + 亮所有底牌
    this.deck.shift();
    while(this.board.length<5){ const c=this.deck.shift(); c.ghost=true; this.board.push(c); }
    for(const i of this.posOrder){ const p=this.seats[i]; if(p.hole.length){ p.revealed=true; if(p.folded)p.foldShow=true; } }
    this.stageName="复盘 · 虚线牌为实际未发出";
    this.finishHand(`${w.name} 收下底池 ${won}（全员弃牌）`,
      {title:`${w.name} 赢下 ${won}`,detail:"其余玩家全部弃牌。已自动翻开剩余公共牌与所有人底牌供复盘。"});
  }

  showdown(){
    this.stageName="摊牌 · 全员强制亮牌";
    const live=this.liveSeats().map(i=>this.seats[i]);
    for(const p of live) p.revealed=true;     // 河牌跟注到底，强制亮牌
    const results=live.map(p=>({p,rank:evalAny([...p.hole,...this.board])}));
    for(const r of results) this.log(`${r.p.name} 亮牌 ${r.p.hole.map(cardCode).join(" ")} → ${rankName(r.rank)}`);
    // 边池结算
    const all=this.posOrder.map(i=>this.seats[i]);
    const levels=[...new Set(all.filter(p=>p.contrib>0).map(p=>p.contrib))].sort((a,b)=>a-b);
    let prev=0; const winnerTotals={};
    for(const L of levels){
      let amt=0;
      for(const q of all) amt+=Math.max(0,Math.min(q.contrib,L)-prev);
      const elig=results.filter(r=>!r.p.folded&&r.p.contrib>=L);
      if(amt>0&&elig.length){
        let best=elig[0]; for(const r of elig) if(cmpRank(r.rank,best.rank)>0) best=r;
        const ws=elig.filter(r=>cmpRank(r.rank,best.rank)===0);
        const share=Math.floor(amt/ws.length); let rem=amt-share*ws.length;
        for(const wr of ws){ const got=share+(rem-->0?1:0); wr.p.chips+=got; winnerTotals[wr.p.id]=(winnerTotals[wr.p.id]||0)+got; }
      }
      prev=L;
    }
    this.potCollected=0;
    const lines=Object.keys(winnerTotals).map(id=>{
      const p=this.byId(id), rr=results.find(x=>x.p===p);
      p.status="+"+winnerTotals[id];
      return `${p.name} 以「${rankName(rr.rank)}」赢得 ${winnerTotals[id]}`;
    });
    this.log(lines.join("；"),"hl");
    this.finishHand(lines.join("；"),
      {title:"摊牌结果",detail:lines.join("<br>")+"<br>跟注到底者已全部强制亮牌"});
  }

  finishHand(desc, banner){
    this.inHand=false;
    // 公开本局牌序，供验证
    this.reveal={salt:this.salt,commit:this.commit,order:this.orderStr};
    // 历史（房间内显示用）
    const deltas=this.occupied().map(p=>({name:p.name,d:p.chips-(this.snap[p.id]??p.chips)}));
    this.history.unshift({h:this.handNo,desc,deltas});
    if(this.history.length>200) this.history.length=200;
    // 写入数据库做长期生涯/对手统计（按 token）
    const dbPlayers=this.occupied().map(p=>({token:p.token,name:p.name,delta:p.chips-(this.snap[p.id]??p.chips)}));
    db.recordHandToDb(this.code, this.handNo, dbPlayers).catch(()=>{});
    // 把当前分数写入账本，刷新/掉线都不丢
    for(const p of this.occupied()) this.saveToLedger(p);
    this.broadcastState();
    this.broadcast({t:"handEnd",banner,reveal:this.reveal});
    // 整局时间到 → 总结算；否则 5 秒后自动开下一局
    if(this.sessionRemain===0){ setTimeout(()=>this.endSession(),1200); return; }
    if(!this.canContinue()){ this.broadcast({t:"waiting"}); this.broadcastState(); return; }
    let c=5;
    this.broadcast({t:"nextIn",sec:c});
    this._nextTo=setInterval(()=>{
      c--;
      if(c<=0){ clearInterval(this._nextTo); this.maybeStartNow(); }
      else this.broadcast({t:"nextIn",sec:c});
    },1000);
  }
  maybeStartNow(){
    if(this.sessionRemain===0){ this.endSession(); return; }
    if(this.canContinue()) this.startHand();
    else { this.broadcast({t:"waiting"}); this.broadcastState(); }
  }
  forceNext(){ clearInterval(this._nextTo); this.maybeStartNow(); }

  endSession(){
    const rows=this.occupied().slice().sort((a,b)=>(b.chips-b.buyin)-(a.chips-a.buyin))
      .map(p=>{ const n=p.chips-p.buyin; return `${p.name}：带入 ${p.buyin} → ${p.chips}（${n>=0?"+":""}${n}）`; });
    this.broadcast({t:"sessionEnd",rows});
    this.log("—— 整局时间到，总结算 ——","hl");
    this.log(rows.join("；"),"hl");
  }
  restartSession(){
    this.sessionRemain=this.dur?this.dur*60:-1;
    this.log(`新的一整局开始（${this.dur?this.dur+" 分钟":"不限时"}）`,"hl");
    this.broadcastState();
    this.maybeStartNow();
  }

  /* ---- 发给客户端的状态：底牌只发给本人 ---- */
  stateFor(viewerId){
    const viewer=this.byId(viewerId);
    const players=this.seats.map((p,seat)=>{
      if(!p) return {seat,empty:true};
      const showHole = (p.id===viewerId) || p.revealed;
      return {
        seat, id:p.id, name:p.name, chips:p.chips, buyin:p.buyin,
        bet:p.bet, status:p.status, folded:p.folded, allIn:p.allIn,
        revealed:p.revealed, foldShow:p.foldShow, connected:p.connected,
        isYou:p.id===viewerId, isHost:(p.token===this.hostToken),
        hole: p.hole.length ? (showHole ? p.hole.map(c=>({r:c.r,s:c.s})) : p.hole.map(()=>null)) : []
      };
    });
    const readyCount=this.occupied().filter(p=>p.chips>0).length;
    return {
      t:"state",
      code:this.code, name:this.name, sb:this.sb, bb:this.bb, buyin:this.buyin,
      handNo:this.handNo, btn:this.btn, inHand:this.inHand,
      board:(this.board||[]).map(c=>({r:c.r,s:c.s,ghost:!!c.ghost})),
      pot:this.potCollected||0,
      stageName:this.stageName||"",
      currentBet:this.currentBet||0, lastRaise:this.lastRaise||this.bb,
      actingSeat:(this.inHand?this.actingSeat:-1),
      turn:(this.inHand&&this.actingSeat>=0)?{seat:this.actingSeat,remain:this.turnRemain,total:this.turnTotal}:null,
      sessionRemain:this.sessionRemain,
      commit:this.commit||"",
      shuffleLog:this.shuffleLog||[],
      history:this.history,
      readyCount,
      iAmHost: !!(viewer && viewer.token===this.hostToken),
      canStart: !this.inHand && readyCount>=2,   // 房主可点开始
      players
    };
  }
  broadcastState(){ for(const p of this.occupied()) send(p.ws,this.stateFor(p.id)); }
}

/* =====================================================================
   WebSocket 接入
   ===================================================================== */
const wss = new WebSocketServer({ server });
function newCode(){ let c; do{ c=String(100000+rint(900000)); }while(rooms.has(c)); return c; }

wss.on("connection",(ws)=>{
  ws.meta={room:null,id:null};
  ws.on("message",(raw)=>{
    let m; try{ m=JSON.parse(raw); }catch(e){ return; }
    const room = ws.meta.room ? rooms.get(ws.meta.room) : null;

    if(m.t==="create"){
      (async()=>{
        const finalName = await db.ensureProfile(m.token, m.me);   // 永久昵称：已存在则用旧的
        const code=newCode();
        const r=new Room(code,{name:m.name,maxN:m.maxN,buyin:m.buyin,sb:m.sb,dur:m.dur});
        rooms.set(code,r);
        const p=r.join(ws,finalName,m.token);
        if(p){ ws.meta.room=code; ws.meta.id=p.id; ws.meta.token=m.token; }
      })();
      return;
    }
    if(m.t==="join"){
      const r=rooms.get(m.code);
      if(!r){ return send(ws,{t:"error",msg:"房间不存在或已解散"}); }
      (async()=>{
        const finalName = await db.ensureProfile(m.token, m.me);
        const p=r.join(ws,finalName,m.token);
        if(p){ ws.meta.room=m.code; ws.meta.id=p.id; ws.meta.token=m.token; }
      })();
      return;
    }
    if(m.t==="reconnect"){
      const r=rooms.get(m.code);
      if(r){
        const exist = m.token ? r.seats.find(p=>p&&p.token===m.token) : null;
        if(exist){ exist.ws=ws; exist.connected=true; if(exist.status==="掉线")exist.status="";
          ws.meta.room=m.code; ws.meta.id=exist.id; ws.meta.token=m.token;
          send(ws,{t:"joined",youId:exist.id,room:r.meta()}); r.broadcastState(); return; }
        (async()=>{
          const finalName = await db.ensureProfile(m.token, m.me);
          const p=r.join(ws,finalName,m.token);
          if(p){ ws.meta.room=m.code; ws.meta.id=p.id; ws.meta.token=m.token; }
          else send(ws,{t:"error",msg:"重连失败，请重新加入"});
        })();
        return;
      }
      send(ws,{t:"error",msg:"重连失败，请重新加入"});
      return;
    }
    // 查询档案（昵称 + 能否改名 + 还需等几天）
    if(m.t==="profile"){
      const token=m.token||ws.meta.token;
      if(!db.dbReady()){ return send(ws,{t:"profile",disabled:true}); }
      (async()=>{ const p=await db.getProfile(token); send(ws,{t:"profile",profile:p}); })();
      return;
    }
    // 改名（7 天一次）
    if(m.t==="setname"){
      const token=m.token||ws.meta.token;
      if(!db.dbReady()){ return send(ws,{t:"setname",disabled:true}); }
      (async()=>{
        const res=await db.changeName(token, m.name);
        send(ws,{t:"setname",result:res});
        // 改名成功且在房间内 → 同步更新座位显示名
        if(res.ok && room){ const p=room.byId(ws.meta.id); if(p){ p.name=res.name; room.broadcastState(); } }
      })();
      return;
    }
    // 生涯 / 对手查询：可在大厅或房间内调用，按 token 查
    if(m.t==="career" || m.t==="opponents"){
      const token=m.token||ws.meta.token;
      const range=m.range||"90";
      if(!token){ return; }
      if(!db.dbReady()){ return send(ws,{t:m.t,range,disabled:true}); }
      (async()=>{
        try{
          if(m.t==="career"){ const data=await db.careerStats(token,range); send(ws,{t:"career",range,data}); }
          else { const list=await db.opponentStats(token,range); send(ws,{t:"opponents",range,list}); }
        }catch(e){ send(ws,{t:m.t,range,disabled:true}); }
      })();
      return;
    }
    if(!room) return;
    switch(m.t){
      case "action": room.applyAction(ws.meta.id,m.act); break;
      case "extend": room.extend(ws.meta.id); break;
      case "addon":  room.addOn(ws.meta.id); break;
      case "start":  room.startByHost(ws.meta.token); break;
      case "next":   room.forceNext(); break;
      case "restart":room.restartSession(); break;
      case "leave":  room.leave(ws.meta.id); ws.meta.room=null; break;
    }
  });
  ws.on("close",()=>{
    const room = ws.meta.room ? rooms.get(ws.meta.room) : null;
    if(room && ws.meta.id) room.disconnect(ws.meta.id);
  });
});

db.initDb().catch(e=>console.error("initDb error",e.message));
server.listen(PORT,()=>console.log("公平德州联机服务已启动，端口 "+PORT));

/* 导出供本地测试 */
module.exports = { Room, humanShuffle, freshDeck, eval5, evalAny, cmpRank, rankName, sha256hex, cardCode };
