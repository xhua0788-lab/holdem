/* =====================================================================
   数据库层（PostgreSQL）—— 生涯战绩 / 对手胜负 长期保存
   - 通过环境变量 DATABASE_URL 连接（Neon / Render / 任意 PostgreSQL）。
   - 若未配置 DATABASE_URL：自动降级，游戏照常运行，仅不记录生涯数据。
   - 每手结束写一条 hands 记录 + 每个参与者一条 results 记录；
     对手胜负在每手内两两记账（opponents 表）。
   ===================================================================== */
"use strict";
let Pool=null;
try { Pool = require("pg").Pool; } catch(e) { /* pg 未安装时降级 */ }

let pool=null, ready=false;

async function initDb(){
  const url=process.env.DATABASE_URL;
  if(!url || !Pool){
    console.log(url ? "未安装 pg，生涯统计已禁用" : "未配置 DATABASE_URL，生涯统计已禁用（游戏正常运行）");
    return false;
  }
  pool=new Pool({ connectionString:url, ssl:{ rejectUnauthorized:false } });
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS results(
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        room_code TEXT NOT NULL,
        hand_no INT NOT NULL,
        player_token TEXT NOT NULL,
        player_name TEXT NOT NULL,
        delta INT NOT NULL,                -- 本手净盈亏
        won BOOLEAN NOT NULL               -- 本手是否盈利（delta>0）
      );
      CREATE INDEX IF NOT EXISTS idx_results_token_ts ON results(player_token, ts);

      CREATE TABLE IF NOT EXISTS opponents(
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        room_code TEXT NOT NULL,
        hand_no INT NOT NULL,
        a_token TEXT NOT NULL,             -- 视角玩家
        b_token TEXT NOT NULL,             -- 对手
        b_name TEXT NOT NULL,
        a_delta INT NOT NULL,              -- 该手 a 的净盈亏（用于按对手汇总）
        a_won BOOLEAN NOT NULL             -- 该手 a 是否赢（相对此对手而言：a_delta>0）
      );
      CREATE INDEX IF NOT EXISTS idx_opp_a_ts ON opponents(a_token, ts);
    `);
    ready=true;
    console.log("数据库已连接，生涯统计已启用");
    return true;
  }catch(e){
    console.error("数据库初始化失败，降级为不记录生涯：", e.message);
    pool=null; ready=false;
    return false;
  }
}
function dbReady(){ return ready; }

/* 记录一手：players = [{token,name,delta}]，delta 为该手净变化 */
async function recordHandToDb(roomCode, handNo, players){
  if(!ready) return;
  const valid = players.filter(p=>p && p.token);
  if(valid.length===0) return;
  try{
    // results：每人一条
    const vals=[], params=[]; let i=1;
    for(const p of valid){
      vals.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
      params.push(roomCode, handNo, p.token, p.name, Math.round(p.delta||0), (p.delta||0)>0);
    }
    await pool.query(
      `INSERT INTO results(room_code,hand_no,player_token,player_name,delta,won) VALUES ${vals.join(",")}`,
      params
    );
    // opponents：参与者两两记账（a 相对 b）
    if(valid.length>=2){
      const ov=[], op=[]; let j=1;
      for(const a of valid){
        for(const b of valid){
          if(a.token===b.token) continue;
          ov.push(`($${j++},$${j++},$${j++},$${j++},$${j++},$${j++},$${j++})`);
          op.push(roomCode, handNo, a.token, b.token, b.name, Math.round(a.delta||0), (a.delta||0)>0);
        }
      }
      if(ov.length){
        await pool.query(
          `INSERT INTO opponents(room_code,hand_no,a_token,b_token,b_name,a_delta,a_won) VALUES ${ov.join(",")}`,
          op
        );
      }
    }
  }catch(e){ console.error("写入生涯数据失败：", e.message); }
}

/* 时间范围 SQL 片段：today / 7 / 30 / 90 天 */
function rangeClause(range){
  if(range==="today") return "ts >= date_trunc('day', now())";
  const days={ "7":7, "30":30, "90":90 }[String(range)] || 90;
  return `ts >= now() - interval '${days} days'`;
}

/* 生涯总览：总盈亏、手数、胜负、盈亏曲线（按天） */
async function careerStats(token, range){
  if(!ready) return null;
  const where=rangeClause(range);
  const sum=await pool.query(
    `SELECT COALESCE(SUM(delta),0) AS net, COUNT(*) AS hands,
            COALESCE(SUM(CASE WHEN won THEN 1 ELSE 0 END),0) AS wins
       FROM results WHERE player_token=$1 AND ${where}`, [token]);
  const curve=await pool.query(
    `SELECT to_char(date_trunc('day', ts),'MM-DD') AS d, SUM(delta) AS net
       FROM results WHERE player_token=$1 AND ${where}
       GROUP BY 1 ORDER BY MIN(ts)`, [token]);
  const recent=await pool.query(
    `SELECT room_code, hand_no, delta, to_char(ts,'MM-DD HH24:MI') AS t
       FROM results WHERE player_token=$1 AND ${where}
       ORDER BY ts DESC LIMIT 100`, [token]);
  const r=sum.rows[0];
  return {
    net: +r.net, hands: +r.hands, wins: +r.wins, losses: +r.hands - +r.wins,
    curve: curve.rows.map(x=>({d:x.d, net:+x.net})),
    recent: recent.rows.map(x=>({code:x.room_code, hand:x.hand_no, delta:+x.delta, t:x.t}))
  };
}

/* 对手胜负：与每个对手的手数 / 胜 / 负 / 对其累计盈亏 */
async function opponentStats(token, range){
  if(!ready) return null;
  const where=rangeClause(range);
  const q=await pool.query(
    `SELECT b_token,
            MAX(b_name) AS name,
            COUNT(*) AS hands,
            SUM(CASE WHEN a_won THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN a_won THEN 0 ELSE 1 END) AS losses,
            SUM(a_delta) AS net
       FROM opponents WHERE a_token=$1 AND ${where}
       GROUP BY b_token
       ORDER BY net DESC`, [token]);
  return q.rows.map(x=>({
    name:x.name, hands:+x.hands, wins:+x.wins, losses:+x.losses, net:+x.net
  }));
}

module.exports = { initDb, dbReady, recordHandToDb, careerStats, opponentStats };
