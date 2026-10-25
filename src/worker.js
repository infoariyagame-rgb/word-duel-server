const HEADERS={'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'};
const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code=()=>Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>ALPHABET[n%ALPHABET.length]).join('');
const LEVELS=[
 {letters:'کتاب',words:['کتاب','تاب','باک','تاک','بات']},
 {letters:'مادر',words:['مادر','دام','رام','مار','دار','راد']},
 {letters:'دریا',words:['دریا','یار','دار','یاد','رای','دیر']},
 {letters:'بهار',words:['بهار','راه','بار','هار','ربا']},
 {letters:'سفره',words:['سفره','سفر','سره','رفه']}
];
const norm=s=>String(s||'').normalize('NFC').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[\u064B-\u065F\u0670\u200c\s]/g,'').trim();
const buildable=(word,letters)=>{const chars=[...letters];for(const c of [...word]){const i=chars.indexOf(c);if(i<0)return false;chars.splice(i,1)}return true};
function summary(room,playerId){
 const idx=room.players.indexOf(playerId),active=room.players.length===2;
 const remaining=active?Math.max(0,Math.ceil((room.deadline-Date.now())/1000)):90;
 return {code:room.code,roomId:room.code,status:!active?'waiting':remaining?'playing':'finished',players:room.players,letters:active?room.letters:null,seconds:remaining,scores:room.scores||[0,0],words:room.words||[[],[]],playerIndex:idx,winner:active&&!remaining?(room.scores[0]===room.scores[1]?0:room.scores[0]>room.scores[1]?1:2):null};
}
export default {async fetch(request,env){
 if(request.method==='OPTIONS')return new Response(null,{headers:HEADERS});
 const path=new URL(request.url).pathname;
 if(path==='/health')return respond({ok:true,service:'word-duel',gameplay:true,version:2});
 if(request.method!=='POST')return respond({message:'Word Duel API v2',endpoints:['/create','/join','/quick','/status','/word','/leave']});
 let body;try{body=await request.json()}catch{return respond({error:'invalid_json'},400)}
 const playerId=String(body.playerId||'').trim();if(!/^[a-zA-Z0-9_-]{8,80}$/.test(playerId))return respond({error:'invalid_player_id'},400);
 let roomCode=String(body.code||body.roomId||'').trim().toUpperCase();
 if(path==='/create')roomCode=code();
 if(path==='/quick'||body.matchType==='quick')roomCode='MATCHMAKER';
 if(!/^[A-Z2-9]{6}$/.test(roomCode)&&roomCode!=='MATCHMAKER')return respond({error:'invalid_room_code'},400);
 const stub=env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomCode));
 return stub.fetch(new Request('https://room.internal'+path,{method:'POST',body:JSON.stringify({...body,playerId,code:roomCode})}));
}};
export class GameRoom{
 constructor(ctx,env){this.ctx=ctx;this.env=env}
 async fetch(request){
  const data=await request.json(),{playerId,code:roomKey}=data,action=new URL(request.url).pathname,now=Date.now();
  const rooms=await this.ctx.storage.get('rooms')||{};
  for(const [k,r] of Object.entries(rooms))if(now-(r.updated||0)>3600000)delete rooms[k];
  const save=async()=>this.ctx.storage.put('rooms',rooms);
  const init=(id)=>({code:id,players:[playerId],updated:now,scores:[0,0],words:[[],[]],letters:null,deadline:null});
  const activate=r=>{if(r.players.length===2&&!r.deadline){r.letters=LEVELS[Math.floor(Math.random()*LEVELS.length)].letters;r.deadline=Date.now()+90000;r.scores=[0,0];r.words=[[],[]]}};
  if(roomKey==='MATCHMAKER'){
   let room=Object.values(rooms).find(r=>r.players.includes(playerId));
   if(action==='/quick'){
    if(!room){room=Object.values(rooms).find(r=>r.players.length===1&&r.players[0]!==playerId);
     if(room){room.players.push(playerId);activate(room)}else{room=init(crypto.randomUUID());rooms[room.code]=room}}
    room.updated=now;await save();return respond(summary(room,playerId));
   }
   const requested=String(data.roomId||'');room=Object.values(rooms).find(r=>r.code===requested&&r.players.includes(playerId));
   if(!room)return respond({error:'room_not_found'},404);
   return this.handle(room,rooms,action,data,playerId,save);
  }
  let room=rooms[roomKey];
  if(action==='/create'){if(room)return respond({error:'code_collision_retry'},409);room=init(roomKey);rooms[roomKey]=room;await save();return respond(summary(room,playerId))}
  if(action==='/join'){
   if(!room)return respond({error:'room_not_found'},404);
   if(!room.players.includes(playerId)){if(room.players.length>=2)return respond({error:'room_full'},409);room.players.push(playerId);activate(room)}
   room.updated=now;await save();return respond(summary(room,playerId));
  }
  if(!room||!room.players.includes(playerId))return respond({error:'room_not_found'},404);
  return this.handle(room,rooms,action,data,playerId,save);
 }
 async handle(room,rooms,action,data,playerId,save){
  if(action==='/status')return respond(summary(room,playerId));
  if(action==='/leave'){
   room.players=room.players.filter(p=>p!==playerId);
   if(!room.players.length)delete rooms[room.code];else room.updated=Date.now();
   await save();return respond({ok:true});
  }
  if(action==='/word'){
   if(room.players.length!==2)return respond({error:'waiting_for_opponent'},409);
   if(Date.now()>=room.deadline)return respond({error:'game_finished',...summary(room,playerId)},409);
   const word=norm(data.word),index=room.players.indexOf(playerId);
   if(!word||word.length>24)return respond({error:'invalid_word'},400);
   const level=LEVELS.find(l=>l.letters===room.letters);
   if(!level.words.includes(word)||!buildable(word,room.letters))return respond({error:'word_not_in_dictionary',...summary(room,playerId)},422);
   if(room.words[index].includes(word))return respond({error:'already_found',...summary(room,playerId)},409);
   room.words[index].push(word);room.scores[index]+=word.length*10;room.updated=Date.now();await save();
   return respond({accepted:true,points:word.length*10,...summary(room,playerId)});
  }
  return respond({error:'not_found'},404);
 }
}
