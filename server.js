
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = Number(process.env.PORT || 3000);

const rounds = [
  { letters: 'باران', words: ['باران','بار','بارا','ران','نار','بان','آبان'].filter(w=>!w.includes('آ')) },
  { letters: 'مداد', words: ['مداد','داد','دام','ماد'] },
  { letters: 'کتاب', words: ['کتاب','تاب','بات','تاک','کاب'] },
  { letters: 'دریا', words: ['دریا','یار','دار','دیر','رای','یاد'] },
  { letters: 'بهار', words: ['بهار','راه','بهر','هار','بار','رها'] }
];

const rooms = new Map();
const normalize = s => String(s||'').normalize('NFC').replace(/[ي]/g,'ی').replace(/[ك]/g,'ک').replace(/[\u064B-\u065F\u200C\s]/g,'').trim();

function validLetters(word, letters) {
  const chars=[...letters];
  for(const ch of [...word]) {
    const i=chars.indexOf(ch);
    if(i<0)return false;
    chars.splice(i,1);
  }
  return true;
}
function send(ws, data){
  if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data){
  room.players.forEach(p=>send(p.ws,data));
}
function state(room){
  return {
    type:'state',
    room:room.code,
    phase:room.phase,
    players:room.players.map(p=>({
      name:p.name,score:p.score,ready:p.ready,
      connected:p.ws.readyState===WebSocket.OPEN
    })),
    round:room.round,
    letters:room.phase==='playing'?rounds[room.round%rounds.length].letters:null,
    endsAt:room.endsAt
  };
}
function finish(room){
  if(room.phase!=='playing')return;
  room.phase='finished';
  clearTimeout(room.timer);
  const scores=room.players.map(p=>p.score);
  broadcast(room,{
    ...state(room),type:'finished',
    winner:scores[0]===scores[1]?null:(scores[0]>scores[1]?0:1)
  });
}
function start(room){
  room.players.forEach(p=>{
    p.score=0;p.words.clear();p.ready=false;
  });
  room.round=(room.round+1)%rounds.length;
  room.phase='playing';
  room.endsAt=Date.now()+30000;
  broadcast(room,state(room));
  room.timer=setTimeout(()=>finish(room),30000);
}
const server=http.createServer((req,res)=>{
  res.writeHead(200,{
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*'
  });
  res.end(JSON.stringify({
    ok:true,service:'word-duel-server',rooms:rooms.size
  }));
});
const wss=new WebSocketServer({server,maxPayload:2048});
wss.on('connection',ws=>{
  let room=null,player=null;
  ws.on('message',raw=>{
    let m;
    try{m=JSON.parse(raw.toString());}
    catch{return send(ws,{type:'error',message:'Invalid JSON'});}
    if(!m||typeof m.type!=='string')return;

    if(m.type==='create'){
      if(room)return;
      let code;
      do{
        code=String(Math.floor(100000+Math.random()*900000));
      }while(rooms.has(code));
      room={
        code,players:[],phase:'waiting',
        round:-1,endsAt:null,timer:null
      };
      rooms.set(code,room);
      player={
        ws,name:String(m.name||'بازیکن ۱').slice(0,30),
        score:0,ready:false,words:new Set()
      };
      room.players.push(player);
      send(ws,{type:'created',code});
      broadcast(room,state(room));
    }
    else if(m.type==='join'){
      if(room)return;
      const found=rooms.get(String(m.code||''));
      if(!found||found.players.length!==1||found.phase!=='waiting')
        return send(ws,{type:'error',message:'اتاق در دسترس نیست'});
      room=found;
      player={
        ws,name:String(m.name||'بازیکن ۲').slice(0,30),
        score:0,ready:false,words:new Set()
      };
      room.players.push(player);
      send(ws,{type:'joined',code:room.code});
      broadcast(room,state(room));
    }
    else if(!room||!player)
      return send(ws,{type:'error',message:'ابتدا وارد اتاق شوید'});
    else if(m.type==='ready'){
      if(room.phase!=='waiting')return;
      player.ready=true;
      broadcast(room,state(room));
      if(room.players.length===2&&room.players.every(p=>p.ready))
        start(room);
    }
    else if(m.type==='word'){
      if(room.phase!=='playing'||Date.now()>=room.endsAt)return;
      const word=normalize(m.word);
      const data=rounds[room.round%rounds.length];
      if(!data.words.includes(word)||!validLetters(word,data.letters)||player.words.has(word))
        return send(ws,{type:'rejected',word});
      player.words.add(word);
      player.score+=word.length*10;
      send(ws,{type:'accepted',word,score:player.score});
      broadcast(room,state(room));
    }
    else if(m.type==='next'){
      if(room.phase!=='finished'||room.players.length!==2)return;
      room.phase='waiting';
      room.endsAt=null;
      room.players.forEach(p=>p.ready=false);
      broadcast(room,state(room));
    }
  });
  ws.on('close',()=>{
    if(!room)return;
    clearTimeout(room.timer);
    rooms.delete(room.code);
    room.players.forEach(p=>{
      if(p.ws!==ws)send(p.ws,{type:'opponent_left'});
    });
  });
});
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Word Duel server listening on ${PORT}`);
});
