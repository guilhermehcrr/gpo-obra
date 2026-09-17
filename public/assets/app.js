"use strict";
/* ==========================================================================
   GPO Obra — sistema de engenharia e gestão de obra
   Projetos de rede de distribuição de energia elétrica
   ========================================================================== */

var S = { sess:null, route:"painel", obraId:null, q:"", cat:{}, obras:[], usuarios:[],
          log:[], ready:false, offline:false, precisaPrimeiro:false, grupos:{},
          rascunho:null, original:"", salvoEm:null, salvando:false };

var CHAVES_NORMATIVAS = ["normas","padroes","especificacoes","fornecedores_aprovados","ged","ged3738","cintas","cabos"];

var PERFIS = {
  admin:{nome:"Administrador",desc:"Acesso total, inclusive usuários e registro de operações"},
  engenharia:{nome:"Engenharia",desc:"Edita cadastros e tabelas normativas; consulta obras"},
  projetista:{nome:"Projetista",desc:"Cria e edita obras; consulta cadastros"},
  consulta:{nome:"Consulta",desc:"Somente leitura"}
};
var PERMS = {
  admin:["cad.ler","cad.edit","norm.ler","norm.edit","obra.ler","obra.edit","user.ler","user.edit","log.ler"],
  engenharia:["cad.ler","cad.edit","norm.ler","norm.edit","obra.ler","log.ler"],
  projetista:["cad.ler","norm.ler","obra.ler","obra.edit"],
  consulta:["cad.ler","norm.ler","obra.ler"]
};
function can(p){ return S.sess && (PERMS[S.sess.perfil]||[]).indexOf(p)>=0; }

/* ---------- utilidades ---------- */
function el(h){ var d=document.createElement("div"); d.innerHTML=h.trim(); return d.firstChild; }
function esc(s){ if(s===null||s===undefined) return ""; return String(s).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function num(v,d){ if(v===null||v===undefined||v==="") return "—"; var n=Number(v); if(isNaN(n)) return esc(v);
  return n.toLocaleString("pt-BR",{minimumFractionDigits:d||0,maximumFractionDigits:d===undefined?4:d}); }
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function fmtDT(s){ if(!s) return "—"; var d=new Date(s); if(isNaN(d)) return esc(s);
  return d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"}); }
function toast(m){ var t=el('<div class="toast">'+esc(m)+"</div>"); document.body.appendChild(t); setTimeout(function(){t.remove();},2600); }
async function sha(s){ var b=new TextEncoder().encode(s); var h=await crypto.subtle.digest("SHA-256",b);
  return Array.from(new Uint8Array(h)).map(function(x){return x.toString(16).padStart(2,"0");}).join(""); }
function items(k){ var c=S.cat[k]; return (c&&c.items)||[]; }
function initials(n){ return (n||"?").split(/\s+/).slice(0,2).map(function(w){return w[0];}).join("").toUpperCase(); }

/* ==========================================================================
   CAMADA DE DADOS
   Duas implementações com a mesma interface. A API do servidor é a de produção;
   a outra atende a prévia publicada, que roda sem servidor próprio.
   ========================================================================== */
var Store = null;

function storeApi(){
  var token = null;
  try { token = sessionStorage.getItem("gpo_token"); } catch(e){}
  async function req(metodo, caminho, corpo){
    var op = { method:metodo, headers:{ "Content-Type":"application/json" } };
    if(token) op.headers.Authorization = "Bearer "+token;
    if(corpo!==undefined) op.body = JSON.stringify(corpo);
    var r = await fetch("/api/"+caminho, op);
    var d = null;
    try { d = await r.json(); } catch(e){}
    if(!r.ok) throw new Error((d&&d.erro)||("Erro "+r.status));
    return d;
  }
  function guardar(t){ token=t; try{ t?sessionStorage.setItem("gpo_token",t):sessionStorage.removeItem("gpo_token"); }catch(e){} }
  return {
    tipo:"api",
    async carregar(){ return await req("GET","estado"); },
    async primeiroAcesso(nome,login,senha){ var d=await req("POST","primeiro-acesso",{nome:nome,login:login,senha:senha}); guardar(d.token); return d.usuario; },
    async login(login,senha){ var d=await req("POST","login",{login:login,senha:senha}); guardar(d.token); return d.usuario; },
    async sair(){ try{ await req("POST","sair"); }catch(e){} guardar(null); },
    async salvarCatalogo(chave){ await req("PUT","catalogo/"+encodeURIComponent(chave), S.cat[chave]); },
    async salvarObra(o){ await req("PUT","obras/"+encodeURIComponent(o._id), o); },
    async excluirObra(id){ await req("DELETE","obras/"+encodeURIComponent(id)); },
    async salvarUsuario(u){ return await req("PUT","usuarios/"+encodeURIComponent(u._id), u); },
    async excluirUsuario(id){ await req("DELETE","usuarios/"+encodeURIComponent(id)); },
    async lerRegistro(){ try{ return await req("GET","registro"); }catch(e){ return []; } },
    async registrar(acao,alvo,detalhe){ try{ await req("POST","registro",{acao:acao,alvo:alvo,detalhe:detalhe}); }catch(e){} }
  };
}

function storePrevia(DB){
  var CAMINHO = { municipios:"catalog/municipios", materiais:"catalog/materiais", concessionarias:"catalog/concessionarias",
    fornecedores:"catalog/fornecedores", fabricantes:"catalog/fabricantes", unidades:"catalog/unidades",
    servicos:"catalog/servicos", normas:"normativas/normas", padroes:"normativas/padroes",
    especificacoes:"normativas/especificacoes", fornecedores_aprovados:"normativas/fornecedores_aprovados",
    ged:"normativas/ged", ged3738:"normativas/ged3738", cintas:"normativas/cintas", cabos:"normativas/cabos" };
  var usuariosCache = [];
  return {
    tipo:"previa",
    async carregar(){
      var cat={}, obras=[], usuarios=[];
      await Promise.all(Object.keys(CAMINHO).map(async function(k){
        try{ var s=await DB.doc(CAMINHO[k]).get(); if(s.exists) cat[k]=s.data(); }catch(e){}
      }));
      try{ var o=await DB.collection("obras").get();
        obras=o.docs.map(function(d){ var x=Object.assign({},d.data()); x._id=d.id; return x; }); }catch(e){}
      try{ var u=await DB.collection("usuarios").get();
        usuarios=u.docs.map(function(d){ var x=Object.assign({},d.data()); x._id=d.id; return x; }); }catch(e){}
      usuariosCache=usuarios;
      return { catalogos:cat, obras:obras, usuarios:usuarios, totalUsuarios:usuarios.length,
               precisaPrimeiroAcesso:usuarios.length===0, sessao:null };
    },
    async primeiroAcesso(nome,login,senha){
      var u={_id:uid(),login:login,nome:nome,perfil:"admin",ativo:true,
             criadoEm:new Date().toISOString(),hash:await sha(login+":"+senha)};
      var b=Object.assign({},u); delete b._id;
      try{ await DB.doc("usuarios/"+u._id).set(b); }catch(e){}
      usuariosCache.push(u); S.usuarios=usuariosCache;
      return u;
    },
    async login(login,senha){
      var h=await sha(login+":"+senha), achou=null;
      usuariosCache.forEach(function(x){ if(x.login===login&&x.hash===h&&x.ativo!==false) achou=x; });
      if(!achou) throw new Error("Usuário ou senha não conferem.");
      return achou;
    },
    async sair(){},
    async salvarCatalogo(chave){ try{ await DB.doc(CAMINHO[chave]).set(S.cat[chave]); }catch(e){ toast("Falha ao gravar"); } },
    async salvarObra(o){ var b=Object.assign({},o); delete b._id;
      b.atualizadoEm=new Date().toISOString(); b.atualizadoPor=S.sess?S.sess.nome:"";
      try{ await DB.doc("obras/"+o._id).set(b); }catch(e){} },
    async excluirObra(id){ try{ await DB.doc("obras/"+id).delete(); }catch(e){} },
    async salvarUsuario(u){
      var rec=Object.assign({},u);
      if(rec.senha){ rec.hash=await sha(rec.login+":"+rec.senha); }
      delete rec.senha;
      var b=Object.assign({},rec); delete b._id;
      try{ await DB.doc("usuarios/"+rec._id).set(b); }catch(e){}
      var i=-1; usuariosCache.forEach(function(x,j){ if(x._id===rec._id) i=j; });
      if(i<0) usuariosCache.push(rec); else usuariosCache[i]=rec;
      return rec;
    },
    async excluirUsuario(id){ try{ await DB.doc("usuarios/"+id).delete(); }catch(e){}
      usuariosCache=usuariosCache.filter(function(x){return x._id!==id;}); },
    async lerRegistro(){
      try{ var l=await DB.collection("registro").orderBy("quando","desc").limit(200).get();
           return l.docs.map(function(d){ return d.data(); }); }catch(e){ return []; }
    },
    async registrar(acao,alvo,detalhe){
      if(!S.sess) return;
      try{ await DB.collection("registro").add({ quando:new Date().toISOString(), quem:S.sess.nome,
        login:S.sess.login, perfil:S.sess.perfil, acao:acao, alvo:alvo||"", detalhe:detalhe||"" }); }catch(e){}
    }
  };
}

async function criarStore(){
  if(window.claude && window.claude.use){
    try{ var db = await window.claude.use("db"); if(db) return storePrevia(db); }catch(e){}
  }
  return storeApi();
}

/* ---------- validadores ---------- */
function digitos(s){ return (s||"").replace(/\D/g,""); }
function okCNPJ(v){ var c=digitos(v); if(c.length!==14||/^(\d)\1+$/.test(c)) return false;
  var t=c.length-2,d=c.substring(t),n=c.substring(0,t),s=0,p=t-7,i;
  for(i=t;i>=1;i--){ s+=n.charAt(t-i)*p--; if(p<2)p=9; }
  var r=s%11<2?0:11-s%11; if(r!=d.charAt(0)) return false;
  t=t+1; n=c.substring(0,t); s=0; p=t-7;
  for(i=t;i>=1;i--){ s+=n.charAt(t-i)*p--; if(p<2)p=9; }
  r=s%11<2?0:11-s%11; return r==d.charAt(1); }
function okCPF(v){ var c=digitos(v); if(c.length!==11||/^(\d)\1+$/.test(c)) return false;
  var s=0,i; for(i=0;i<9;i++) s+=parseInt(c.charAt(i))*(10-i);
  var r=(s*10)%11; if(r===10)r=0; if(r!=c.charAt(9)) return false;
  s=0; for(i=0;i<10;i++) s+=parseInt(c.charAt(i))*(11-i);
  r=(s*10)%11; if(r===10)r=0; return r==c.charAt(10); }
function okCEP(v){ return digitos(v).length===8; }
function okEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v||""); }

/* ==========================================================================
   FOLHA DE DADOS — esquema e regras
   ========================================================================== */
var FD=[
 {id:"cliente",titulo:"Dados do cliente",campos:[
  {k:"cliente",l:"Cliente",req:1,w:3},
  {k:"cnpj",l:"CNPJ",req:1,w:2,val:okCNPJ,msg:"CNPJ inválido"},
  {k:"codigoObra",l:"Código da obra",w:1},
  {k:"rua",l:"Rua",req:1,w:3},{k:"numero",l:"Nº",req:1,w:1},{k:"bairro",l:"Bairro",req:1,w:2},
  {k:"municipioCli",l:"Município",req:1,w:3,tipo:"municipio"},
  {k:"ufCli",l:"UF",w:1,ro:1,drv:"Preenchida pelo município"},
  {k:"cepCli",l:"CEP",req:1,w:2,val:okCEP,msg:"CEP deve ter 8 dígitos"},
  {k:"emailNfe",l:"E-mail para envio de NF-e",req:1,w:3,val:okEmail,msg:"E-mail inválido"},
  {k:"respConcess",l:"Responsável pelo cliente junto à concessionária",req:1,w:3},
  {k:"cpfResp",l:"CPF do responsável",req:1,w:2,val:okCPF,msg:"CPF inválido"},
  {k:"rep1",l:"Representante legal 1",req:1,w:2},{k:"nac1",l:"Nacionalidade",w:2},
  {k:"ec1",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"]},
  {k:"rg1",l:"RG",w:2},{k:"cpf1",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"rep2",l:"Representante legal 2",w:2},{k:"nac2",l:"Nacionalidade",w:2},
  {k:"ec2",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"]},
  {k:"rg2",l:"RG",w:2},{k:"cpf2",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"testCli",l:"Testemunha da contratante",w:2},{k:"rgTestCli",l:"RG",w:2},
  {k:"cpfTestCli",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"}
 ]},
 {id:"obra",titulo:"Dados da obra",campos:[
  {k:"empreendimento",l:"Nome do empreendimento",req:1,w:4},
  {k:"dataEnergizacao",l:"Data prevista para energização",req:1,w:2,tipo:"date"},
  {k:"municipio",l:"Município da obra",req:1,w:3,tipo:"municipio",
   nota:"Define a concessionária, as constantes A e B, a tensão primária e a classe de tensão."},
  {k:"uf",l:"UF",w:1,ro:1,drv:"Preenchida pelo município"},
  {k:"bairroObra",l:"Bairro",req:1,w:2},
  {k:"cepObra",l:"CEP",req:1,w:2,val:okCEP,msg:"CEP deve ter 8 dígitos"},
  {k:"tipoEmpreendimento",l:"Tipo de empreendimento",req:1,w:2,tipo:"select",ops:["Loteamento","Núcleo habitacional"]},
  {k:"respIP",l:"Responsável pelo consumo da iluminação pública",req:1,w:2,tipo:"select",ops:["Prefeitura","Condomínio","Cliente"]},
  {k:"oficioPrefeitura",l:"Já existe ofício da prefeitura?",w:2,tipo:"select",ops:["Sim","Não"],
   reqSe:function(o){return o.respIP==="Prefeitura";},nota:"Obrigatório quando a iluminação pública é da prefeitura."}
 ]},
 {id:"projeto",titulo:"Dados do projeto",campos:[
  {k:"concessionaria",l:"Concessionária",w:2,ro:1,drv:"Preenchida pelo município da obra"},
  {k:"regional",l:"Regional",req:1,w:2},
  {k:"tipoProjeto",l:"Tipo de projeto",req:1,w:6,tipo:"select",ops:[
    "Rede de distribuição aérea primária e secundária com iluminação pública",
    "Rede de distribuição aérea primária e secundária sem iluminação pública",
    "Rede de distribuição subterrânea",
    "Somente cálculo de esforço mecânico",
    "Cálculo de esforço mecânico + lista de materiais"]},
  {k:"gedKvas",l:"Tabela para cálculo do kVA",req:1,w:3,tipo:"select",ops:["GED 3738 REV. 09/11/23 PG.07/08"]},
  {k:"caboPrimario",l:"Cabo principal da rede primária",req:1,w:2,tipo:"select",ops:["E70","E50","E35","CA 1/0","CA 4/0"]},
  {k:"vaoBasico",l:"Vão básico entre postes (m)",req:1,w:1,tipo:"number",min:20,max:60,
   val:function(v){return v>=20&&v<=60;},msg:"Entre 20 e 60 m"},
  {k:"lotesT1",l:"Tamanho médio dos lotes tipo 1 (m²)",req:1,w:2,tipo:"number",min:1},
  {k:"atividadeT1",l:"Atividade do consumidor tipo 1",req:1,w:2,tipo:"atividade"},
  {k:"ligacaoT1",l:"Ligação do consumidor tipo 1",req:1,w:1,tipo:"ligacao"},
  {k:"qtdT1",l:"Quantidade de consumidores tipo 1",req:1,w:1,tipo:"number",min:1},
  {k:"lotesT2",l:"Tamanho médio dos lotes tipo 2 (m²)",w:2,tipo:"number",reqSe:function(o){return Number(o.qtdT2)>0;}},
  {k:"atividadeT2",l:"Atividade do consumidor tipo 2",w:2,tipo:"atividade",reqSe:function(o){return Number(o.qtdT2)>0;}},
  {k:"ligacaoT2",l:"Ligação do consumidor tipo 2",w:1,tipo:"ligacao",reqSe:function(o){return Number(o.qtdT2)>0;}},
  {k:"qtdT2",l:"Quantidade de consumidores tipo 2",w:1,tipo:"number",min:0,
   nota:"Deixe zero quando não houver segundo tipo de consumidor."},
  {k:"consumidoresEspeciais",l:"Consumidores especiais (portaria, clube, administração, salão de festas)",w:6,tipo:"textarea",
   nota:"Quantificar e descrever cada tipo. Deixar em branco se não houver."},
  {k:"luminaria",l:"Luminária mais utilizada",req:1,w:3,tipo:"select",
   ops:["LED 100 W","LED 150 W","LED 250 W","Vapor de sódio 100 W","Vapor de sódio 150 W","Vapor de sódio 250 W","Vapor de sódio 400 W"]},
  {k:"respProjeto",l:"Responsabilidade do projeto",w:3},
  {k:"numeroProjeto",l:"Número do projeto",w:2},{k:"trt",l:"TRT",w:2},
  {k:"refEletricas",l:"Referências elétricas",w:2},{k:"numAtividade",l:"Número da atividade",w:2},
  {k:"viabilidade",l:"Viabilidade aprovada em",w:2,tipo:"date"},
  {k:"atividadeCancelar",l:"Atividade a ser cancelada",w:2},
  {k:"ramal1",l:"Ramal subterrâneo 01",w:3},{k:"ramal2",l:"Ramal subterrâneo 02",w:3},
  {k:"ramal3",l:"Ramal subterrâneo 03",w:3},{k:"ramal4",l:"Ramal subterrâneo 04",w:3},
  {k:"impressao",l:"Impressão",w:2,tipo:"select",ops:["Folha timbrada","Folha sem timbre"]}
 ]},
 {id:"empreiteira",titulo:"Dados da empreiteira",campos:[
  {k:"empreiteira",l:"Empreiteira",req:1,w:3},
  {k:"cnpjEmp",l:"CNPJ",req:1,w:2,val:okCNPJ,msg:"CNPJ inválido"},
  {k:"cftEmp",l:"CFT",w:1},{k:"ieEmp",l:"Inscrição estadual",w:2},
  {k:"ruaEmp",l:"Rua",w:3},{k:"numEmp",l:"Nº",w:1},
  {k:"bairroEmp",l:"Bairro",w:2},{k:"munEmp",l:"Município",w:3,tipo:"municipio"},
  {k:"ufEmp",l:"UF",w:1,ro:1,drv:"Preenchida pelo município"},
  {k:"cepEmp",l:"CEP",w:2,val:okCEP,msg:"CEP deve ter 8 dígitos"},
  {k:"contatoEmp",l:"Contato",w:2},{k:"cpfContato",l:"CPF do contato",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"telEmp",l:"Telefone(s)",w:2},
  {k:"emailEmp",l:"E-mail para contato",w:3,val:okEmail,msg:"E-mail inválido"},
  {k:"responsavelEmp",l:"Responsável",w:3},{k:"nacEmp",l:"Nacionalidade",w:2},
  {k:"ecEmp",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"]},
  {k:"rgEmp",l:"RG",w:1},{k:"orgaoEmp",l:"Órgão expedidor",w:1},
  {k:"cpfEmp",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"testEmp",l:"Testemunha da contratada",w:2},{k:"rgTestEmp",l:"RG",w:2},
  {k:"cpfTestEmp",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"respTecnico",l:"Responsável técnico",req:1,w:3},{k:"cftRT",l:"CFT do responsável técnico",w:2}
 ]},
 {id:"parametros",titulo:"Parâmetros de cálculo",campos:[
  {k:"qtMaxSec",l:"Queda de tensão máxima na rede secundária (%)",req:1,w:2,tipo:"number",step:"0.1",
   val:function(v){return v>0&&v<=10;},msg:"Entre 0 e 10 %",nota:"Limite usado na conferência de queda de tensão."},
  {k:"qtMaxIP",l:"Queda de tensão máxima na rede de iluminação pública (%)",req:1,w:2,tipo:"number",step:"0.1",
   val:function(v){return v>0&&v<=10;},msg:"Entre 0 e 10 %"},
  {k:"funcaoArred",l:"Função para corte de casas decimais",req:1,w:2,tipo:"select",
   ops:["ARRED","ARREDONDAR.PARA.CIMA","ARREDONDAR.PARA.BAIXO","TRUNCAR"]},
  {k:"casasDecimais",l:"Nº de casas decimais para a queda de tensão",req:1,w:2,tipo:"number",min:0,max:6,
   val:function(v){return v>=0&&v<=6;},msg:"Entre 0 e 6"}
 ]}
];
var PADROES={qtMaxSec:3.5,qtMaxIP:6,funcaoArred:"ARRED",casasDecimais:2,vaoBasico:35,qtdT2:0,
  gedKvas:"GED 3738 REV. 09/11/23 PG.07/08",impressao:"Folha timbrada"};

function obrigatorio(c,o){ if(c.req) return true; if(c.reqSe) return !!c.reqSe(o); return false; }
function validarObra(o){
  var errs=[];
  FD.forEach(function(s){ s.campos.forEach(function(c){
    var v=o[c.k], vazio=(v===undefined||v===null||String(v).trim()==="");
    if(obrigatorio(c,o)&&vazio){ errs.push({sec:s.id,secT:s.titulo,k:c.k,l:c.l,tipo:"obrigatorio",msg:"Campo obrigatório não preenchido"}); return; }
    if(!vazio&&c.val&&!c.val(c.tipo==="number"?Number(v):v))
      errs.push({sec:s.id,secT:s.titulo,k:c.k,l:c.l,tipo:"formato",msg:c.msg||"Valor inválido"});
  });});
  if(Number(o.qtdT1)>0&&Number(o.lotesT1)>0&&Number(o.lotesT1)<50)
    errs.push({sec:"projeto",secT:"Dados do projeto",k:"lotesT1",l:"Tamanho médio dos lotes tipo 1",
      tipo:"coerencia",msg:"Lote menor que 50 m² — confirmar com o responsável técnico"});
  if(o.qtMaxSec&&o.qtMaxIP&&Number(o.qtMaxIP)<Number(o.qtMaxSec))
    errs.push({sec:"parametros",secT:"Parâmetros de cálculo",k:"qtMaxIP",l:"Queda máxima na iluminação pública",
      tipo:"coerencia",msg:"Normalmente o limite da iluminação pública é maior que o da rede secundária"});
  return errs;
}
function totalCampos(){ var n=0; FD.forEach(function(s){ n+=s.campos.length; }); return n; }
function municipioInfo(nome){ var l=items("municipios"); for(var i=0;i<l.length;i++) if(l[i].municipio===nome) return l[i]; return null; }

/* ==========================================================================
   CARGA
   ========================================================================== */
async function carregar(){
  try{
    var d=await Store.carregar();
    S.cat=d.catalogos||{}; S.obras=d.obras||[]; S.usuarios=d.usuarios||[];
    S.precisaPrimeiro=!!d.precisaPrimeiroAcesso;
    if(d.sessao) S.sess=d.sessao;
    S.offline=false;
  }catch(e){ S.offline=true; }
  S.ready=true;
}
async function lerLog(){ S.log=await Store.lerRegistro(); }

/* ==========================================================================
   ENTRADA
   ========================================================================== */
function desenhoRede(){ return '<svg viewBox="0 0 640 240" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">'+
 '<line x1="0" y1="212" x2="640" y2="212" stroke-dasharray="2 4" opacity=".45"/>'+
 [70,240,410,580].map(function(x,i){ var topo=i===1?48:62;
   return '<g>'+
   '<path d="M'+(x-4)+' 212 L'+(x-2.4)+' '+topo+' L'+(x+2.4)+' '+topo+' L'+(x+4)+' 212 Z" opacity=".9"/>'+
   '<line x1="'+(x-22)+'" y1="'+(topo+16)+'" x2="'+(x+22)+'" y2="'+(topo+16)+'"/>'+
   '<line x1="'+(x-14)+'" y1="'+(topo+16)+'" x2="'+x+'" y2="'+(topo+4)+'" opacity=".6"/>'+
   '<line x1="'+(x+14)+'" y1="'+(topo+16)+'" x2="'+x+'" y2="'+(topo+4)+'" opacity=".6"/>'+
   '<circle cx="'+(x-22)+'" cy="'+(topo+16)+'" r="2.6"/><circle cx="'+x+'" cy="'+(topo+16)+'" r="2.6"/>'+
   '<circle cx="'+(x+22)+'" cy="'+(topo+16)+'" r="2.6"/>'+
   '<line x1="'+(x-16)+'" y1="'+(topo+44)+'" x2="'+(x+16)+'" y2="'+(topo+44)+'" opacity=".55"/></g>'; }).join("")+
 '<path d="M70 78 Q155 104 240 64" opacity=".85"/><path d="M240 64 Q325 100 410 78" opacity=".85"/><path d="M410 78 Q495 106 580 78" opacity=".85"/>'+
 '<path d="M70 106 Q155 130 240 92" opacity=".5"/><path d="M240 92 Q325 126 410 106" opacity=".5"/><path d="M410 106 Q495 132 580 106" opacity=".5"/>'+
 '<rect x="250" y="96" width="26" height="34" rx="2"/><line x1="250" y1="104" x2="276" y2="104" opacity=".5"/>'+
 '<line x1="256" y1="96" x2="256" y2="88" opacity=".7"/><line x1="270" y1="96" x2="270" y2="88" opacity=".7"/>'+
 '<line x1="414" y1="94" x2="436" y2="90" opacity=".8"/><path d="M436 90 l10 4 -4 7 -9 -4 z" opacity=".8"/>'+
 '<line x1="70" y1="228" x2="240" y2="228" opacity=".55"/>'+
 '<line x1="70" y1="222" x2="70" y2="234" opacity=".55"/><line x1="240" y1="222" x2="240" y2="234" opacity=".55"/>'+
 '<text x="155" y="224" font-size="9" fill="currentColor" stroke="none" text-anchor="middle" font-family="IBM Plex Mono, monospace" opacity=".8">vão básico</text>'+
 '</svg>'; }

function viewLogin(){
  var primeiro=S.precisaPrimeiro;
  return '<div class="login">'+
   '<div class="login-art">'+
     '<div><div class="brandline"><span style="color:#fff;font-weight:600;font-size:15px">GPO Obra</span></div>'+
       '<h1 style="margin-top:22px">Projeto de rede de distribuição, do cadastro à lista de materiais.</h1>'+
       '<p>Cadastros base, tabelas normativas, folha de dados com validação em tela e controle de acesso por perfil, em um sistema único.</p></div>'+
     '<div class="login-draw">'+desenhoRede()+'</div>'+
     '<div class="login-meta"><span>Rede de distribuição de energia elétrica</span><span>Loteamentos e núcleos habitacionais</span></div>'+
   '</div>'+
   '<div class="login-form"><div class="inner">'+
     '<h2>'+(primeiro?"Criar o primeiro acesso":"Entrar no sistema")+"</h2>"+
     '<p class="sub">'+(primeiro?"Nenhum usuário cadastrado. Defina o administrador do sistema.":"Informe seu usuário e senha.")+"</p>"+
     '<form id="fLogin">'+
       (primeiro?'<div class="fld" style="margin-bottom:12px"><label>Nome completo</label><input type="text" id="lNome" required></div>':"")+
       '<div class="fld" style="margin-bottom:12px"><label>Usuário</label><input type="text" id="lUser" autocomplete="username" required></div>'+
       '<div class="fld" style="margin-bottom:16px"><label>Senha</label><input type="password" id="lPass" autocomplete="current-password" required></div>'+
       '<button class="btn" style="width:100%" type="submit">'+(primeiro?"Criar acesso e entrar":"Entrar")+"</button>"+
       '<div id="lErr" class="fld"><div class="err" style="margin-top:10px;display:none"></div></div>'+
     "</form>"+
     (S.offline?'<div class="hint">O sistema não conseguiu falar com o servidor. Verifique se o serviço está no ar.</div>':"")+
   "</div></div></div>";
}
function ligarLogin(){
  var f=document.getElementById("fLogin"); if(!f) return;
  f.addEventListener("submit",async function(ev){
    ev.preventDefault();
    var erro=document.querySelector("#lErr .err");
    var u=document.getElementById("lUser").value.trim().toLowerCase();
    var p=document.getElementById("lPass").value;
    try{
      var usuario;
      if(S.precisaPrimeiro){
        var nome=document.getElementById("lNome").value.trim();
        if(p.length<6) throw new Error("A senha precisa de pelo menos 6 caracteres.");
        usuario=await Store.primeiroAcesso(nome,u,p);
        S.precisaPrimeiro=false;
      } else {
        usuario=await Store.login(u,p);
      }
      S.sess={id:usuario._id,login:usuario.login,nome:usuario.nome,perfil:usuario.perfil};
      await carregar();
      if(can("log.ler")) await lerLog();
      S.route="painel"; render();
    }catch(e){ erro.style.display="flex"; erro.textContent=e.message||"Não foi possível entrar."; }
  });
}

/* ==========================================================================
   NAVEGAÇÃO
   ========================================================================== */
var MENU=[
 {grp:"Projeto",itens:[{r:"painel",l:"Painel"},{r:"obras",l:"Obras"}]},
 {grp:"Cadastros base",itens:[
   {r:"concessionarias",l:"Concessionárias",c:"concessionarias"},
   {r:"municipios",l:"Municípios e constantes",c:"municipios"},
   {r:"materiais",l:"Materiais",c:"materiais"},
   {r:"servicos",l:"Serviços",c:"servicos"},
   {r:"fornecedores",l:"Fornecedores",c:"fornecedores"},
   {r:"fabricantes",l:"Fabricantes",c:"fabricantes"},
   {r:"unidades",l:"Unidades",c:"unidades"}]},
 {grp:"Tabelas normativas",itens:[
   {r:"ged",l:"GED aplicável",c:"ged"},
   {r:"ged3738",l:"GED 3738 — consumo",c:"ged3738"},
   {r:"normas",l:"Normas técnicas",c:"normas"},
   {r:"padroes",l:"Padrões de instalação",c:"padroes"},
   {r:"especificacoes",l:"Especificações técnicas",c:"especificacoes"},
   {r:"aprovados",l:"Fornecedores aprovados",c:"fornecedores_aprovados"},
   {r:"cabos",l:"Dados técnicos de cabos",c:"cabos"},
   {r:"cintas",l:"Diâmetro de poste e cintas",c:"cintas"}]},
 {grp:"Administração",itens:[{r:"usuarios",l:"Usuários e perfis"},{r:"registro",l:"Registro de operações"}]}
];
function grupoPorNome(n){ var r=null; MENU.forEach(function(g){ if(g.grp===n) r=g; }); return r; }
function grupoAberto(g){
  if(S.grupos[g.grp]!==undefined) return S.grupos[g.grp];
  return g.itens.some(function(i){ return i.r===S.route; });
}
function viewRail(){
  var h='<aside class="rail"><div class="rail-head"><div class="logo">GPO Obra</div>'+
    '<div class="sysname">Engenharia e gestão de obra</div></div><nav>';
  MENU.forEach(function(g){
    if(g.grp==="Administração"&&!can("user.ler")&&!can("log.ler")) return;
    var aberto=grupoAberto(g);
    h+='<div class="grp'+(aberto?" aberto":"")+'" data-grp="'+esc(g.grp)+'">'+esc(g.grp)+'<span class="seta">\u203A</span></div>';
    h+='<div class="grp-itens'+(aberto?"":" fechado")+'">';
    g.itens.forEach(function(it){
      var n="";
      if(it.c) n=items(it.c).length?String(items(it.c).length):"—";
      if(it.r==="obras") n=String(S.obras.length);
      if(it.r==="usuarios"){ if(!can("user.ler")) return; n=String(S.usuarios.length); }
      if(it.r==="registro"&&!can("log.ler")) return;
      h+='<a data-r="'+it.r+'" class="'+(S.route===it.r?"on":"")+'">'+esc(it.l)+'<span class="n">'+n+"</span></a>";
    });
    h+="</div>";
  });
  h+="</nav><div class=\"rail-foot\">Versão 1.0</div></aside>";
  return h;
}
function viewTop(){
  var p=PERFIS[S.sess.perfil];
  return '<div class="topbar"><div style="display:flex;align-items:center;gap:12px">'+
    "<strong style=\"font-size:13.5px\">"+esc(tituloRota())+"</strong>"+
    (S.offline?'<span class="chip bad">Sem conexão com o servidor</span>':"")+
    '</div><div class="who"><span class="chip">'+esc(p.nome)+"</span>"+
    '<div class="avatar">'+esc(initials(S.sess.nome))+"</div>"+
    '<span style="color:var(--text-2)">'+esc(S.sess.nome)+"</span>"+
    '<button class="linkbtn" id="btnSair">Sair</button></div></div>';
}
function tituloRota(){
  var t=""; MENU.forEach(function(g){ g.itens.forEach(function(i){ if(i.r===S.route) t=i.l; }); });
  if(S.route==="folha") t="Folha de dados";
  return t||"Painel";
}

/* ==========================================================================
   PAINEL
   ========================================================================== */
function viewPainel(){
  var totCad=items("concessionarias").length+items("municipios").length+items("materiais").length+
             items("servicos").length+items("fornecedores").length+items("fabricantes").length+items("unidades").length;
  var totNorm=items("normas").length+items("padroes").length+items("especificacoes").length+
              items("fornecedores_aprovados").length+items("ged").length+items("ged3738").length+items("cintas").length;
  var pend=0, completas=0;
  S.obras.forEach(function(o){ var e=validarObra(o); if(e.length===0) completas++; else pend+=e.length; });

  var h='<div class="phead"><div><h2>Painel</h2>'+
    '<p class="desc">Cadastros, tabelas normativas e obras do sistema.</p></div>'+
    (can("obra.edit")?'<div class="actions"><button class="btn" id="btnNovaObra">Nova obra</button></div>':"")+"</div>";

  h+='<div class="grid g4" style="margin-bottom:18px">'+
    '<div class="stat line-70"><div class="k">Registros de cadastro</div><div class="v">'+num(totCad)+
      '</div><div class="f">Concessionárias, municípios, materiais, serviços, fornecedores, fabricantes e unidades</div></div>'+
    '<div class="stat line-50"><div class="k">Registros normativos</div><div class="v">'+num(totNorm)+
      '</div><div class="f">Normas, padrões, especificações e tabelas, com data de revisão editável</div></div>'+
    '<div class="stat line-10"><div class="k">Obras cadastradas</div><div class="v">'+num(S.obras.length)+
      '</div><div class="f">'+num(completas)+" com folha de dados completa</div></div>"+
    '<div class="stat line-35"><div class="k">Pendências de consistência</div><div class="v">'+num(pend)+
      '</div><div class="f">Campos obrigatórios ou fora de formato nas obras abertas</div></div></div>';

  h+='<div class="grid g2"><div class="panel"><div class="panel-h"><div><h3>Módulos do sistema</h3>'+
     '<p class="sub">O que já está disponível e o que está em desenvolvimento</p></div></div><div class="panel-b">'+
     [["Cadastros base","disponível","Concessionárias, municípios, materiais, serviços, fornecedores, fabricantes e unidades"],
      ["Tabelas normativas","disponível","Normas, padrões, especificações, fornecedores aprovados, GED e cabos"],
      ["Folha de dados","disponível","Cliente, obra, projeto e empreiteira, com validação em tela"],
      ["Usuários e perfis","disponível","Quatro perfis de acesso e registro das operações"],
      ["Motor de engenharia","em desenvolvimento","Demanda, vãos entre pontos, queda de tensão e esforço mecânico"],
      ["Materiais e custos","em desenvolvimento","Lista de materiais, impostos, custos operacionais e resultado"],
      ["Documentos e TAGs","em desenvolvimento","Memorial descritivo, termos, laudos e exportação"]]
     .map(function(r){ return '<div class="kv"><span>'+esc(r[0])+"</span><span>"+
       (r[1]==="disponível"?'<span class="chip ok">disponível</span>':'<span class="chip warn">em desenvolvimento</span>')+
       '<div class="note" style="margin-top:3px">'+esc(r[2])+"</div></span></div>"; }).join("")+
     "</div></div>";

  h+='<div class="panel"><div class="panel-h"><div><h3>Obras recentes</h3><p class="sub">Estado da folha de dados</p></div></div>';
  if(!S.obras.length){
    h+='<div class="empty"><h4>Nenhuma obra cadastrada</h4><p>Crie a primeira obra para preencher a folha de dados e acompanhar a conferência de consistência.</p></div>';
  } else {
    h+='<div class="tbl-wrap"><table><thead><tr><th>Empreendimento</th><th>Município</th><th>Consistência</th><th></th></tr></thead><tbody>';
    S.obras.slice().sort(function(a,b){ return (b.atualizadoEm||"").localeCompare(a.atualizadoEm||""); }).slice(0,6).forEach(function(o){
      var e=validarObra(o);
      h+="<tr><td><strong>"+esc(o.empreendimento||"(sem nome)")+"</strong></td><td>"+esc(o.municipio||"—")+"</td><td>"+
        (e.length?'<span class="chip bad">'+e.length+" pendência"+(e.length>1?"s":"")+"</span>":'<span class="chip ok">completa</span>')+
        '</td><td style="text-align:right"><button class="btn ghost sm" data-obra="'+esc(o._id)+'">Abrir</button></td></tr>';
    });
    h+="</tbody></table></div>";
  }
  return h+"</div></div>";
}

/* ==========================================================================
   OBRAS E FOLHA DE DADOS
   ========================================================================== */
function obraPorId(id){ var o=null; S.obras.forEach(function(x){ if(x._id===id) o=x; }); return o; }
function abrirFolha(id){
  var o=obraPorId(id);
  if(!o) return;
  S.obraId=id;
  S.rascunho=JSON.parse(JSON.stringify(o));
  S.original=JSON.stringify(o);
  S.salvoEm=null;
  S.route="folha";
}
function folhaAlterada(){ return !!S.rascunho && JSON.stringify(S.rascunho)!==S.original; }
function fecharFolha(){ S.rascunho=null; S.original=""; S.salvoEm=null; }
async function salvarFolha(){
  if(!S.rascunho||S.salvando) return true;
  S.salvando=true;
  try{
    await Store.salvarObra(S.rascunho);
    var i=-1; S.obras.forEach(function(x,k){ if(x._id===S.rascunho._id) i=k; });
    S.rascunho.atualizadoEm=new Date().toISOString();
    S.rascunho.atualizadoPor=S.sess.nome;
    if(i>=0) S.obras[i]=JSON.parse(JSON.stringify(S.rascunho));
    S.original=JSON.stringify(S.rascunho);
    S.salvoEm=new Date();
    await Store.registrar("Salvou obra",S.rascunho._id,S.rascunho.empreendimento||"(sem nome)");
    S.salvando=false;
    toast("Obra salva");
    return true;
  }catch(e){
    S.salvando=false;
    toast("Não foi possível salvar: "+e.message);
    return false;
  }
}
function confirmarSaida(depois){
  if(!folhaAlterada()) { fecharFolha(); depois(); return; }
  modal("Alterações não salvas",
    "<p>Esta obra tem alterações que ainda não foram gravadas.</p>",
    async function(){ if(await salvarFolha()){ fecharFolha(); depois(); } else return false; },
    "Salvar e sair");
  var bg=document.querySelector(".modal-bg:last-of-type");
  var rodape=bg.querySelector(".modal-f");
  var descartar=el('<button class="btn danger">Sair sem salvar</button>');
  descartar.addEventListener("click",function(){ bg.remove(); fecharFolha(); depois(); });
  rodape.insertBefore(descartar,rodape.firstChild);
}
function viewObras(){
  var h='<div class="phead"><div><h2>Obras</h2>'+
    '<p class="desc">Cada obra guarda a própria folha de dados. Os cadastros ficam fora dela e são apenas referenciados.</p></div>'+
    (can("obra.edit")?'<div class="actions"><button class="btn" id="btnNovaObra">Nova obra</button></div>':"")+"</div>";
  if(!S.obras.length) return h+'<div class="panel"><div class="empty"><h4>Nenhuma obra cadastrada</h4>'+
    "<p>A folha de dados confere os campos obrigatórios enquanto você digita e aponta o que falta antes do cálculo.</p></div></div>";
  h+='<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Empreendimento</th><th>Cliente</th><th>Município</th>'+
    "<th>Concessionária</th><th>Energização</th><th>Consistência</th><th>Atualizada</th><th></th></tr></thead><tbody>";
  S.obras.slice().sort(function(a,b){ return (b.atualizadoEm||"").localeCompare(a.atualizadoEm||""); }).forEach(function(o){
    var e=validarObra(o), pr=Math.round((1-e.length/totalCampos())*100);
    h+="<tr><td><strong>"+esc(o.empreendimento||"(sem nome)")+"</strong></td><td>"+esc(o.cliente||"—")+"</td><td>"+
      esc(o.municipio||"—")+"</td><td>"+esc(o.concessionaria||"—")+'</td><td class="num">'+
      (o.dataEnergizacao?esc(o.dataEnergizacao.split("-").reverse().join("/")):"—")+"</td><td>"+
      (e.length?'<span class="chip bad">'+e.length+" pendente"+(e.length>1?"s":"")+"</span>":'<span class="chip ok">completa '+pr+"%</span>")+
      '</td><td class="num" style="color:var(--muted);font-size:12px">'+fmtDT(o.atualizadoEm)+
      '</td><td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-obra="'+esc(o._id)+'">Abrir</button>'+
      (can("obra.edit")?' <button class="btn danger sm" data-del-obra="'+esc(o._id)+'">Excluir</button>':"")+"</td></tr>";
  });
  return h+'</tbody></table></div><div class="tbl-foot"><span>'+S.obras.length+" obra"+(S.obras.length>1?"s":"")+"</span></div></div>";
}

function campoHTML(c,o,errs){
  var err=null; errs.forEach(function(e){ if(e.k===c.k) err=e; });
  var v=o[c.k]===undefined||o[c.k]===null?"":o[c.k];
  var req=obrigatorio(c,o);
  var dis=(!can("obra.edit")||c.ro)?" disabled":"";
  var inner;
  if(c.tipo==="select"||c.tipo==="municipio"||c.tipo==="atividade"||c.tipo==="ligacao"){
    var ops=[];
    if(c.tipo==="municipio") ops=items("municipios").map(function(m){ return m.municipio+" / "+m.uf; });
    else if(c.tipo==="atividade") ops=items("ged3738").map(function(a){ return a.atividade; });
    else if(c.tipo==="ligacao"){ var lg=(S.cat.ged3738&&S.cat.ged3738.ligacoes)||[];
      ops=lg.map(function(l){ return l.codigo+" · "+(l.fases||"").toLowerCase()+" "+(l.tensao||"")+" · renda "+(l.renda||""); }); }
    else ops=c.ops||[];
    inner='<select data-k="'+c.k+'"'+dis+'><option value="">—</option>'+
      ops.map(function(op){
        var val=(c.tipo==="municipio")?op.split(" / ")[0]:((c.tipo==="ligacao")?op.split(" · ")[0]:op);
        return '<option value="'+esc(val)+'"'+(String(v)===val?" selected":"")+">"+esc(op)+"</option>"; }).join("")+"</select>";
  } else if(c.tipo==="textarea"){
    inner='<textarea data-k="'+c.k+'" rows="2"'+dis+">"+esc(v)+"</textarea>";
  } else {
    var t=c.tipo==="number"?"number":(c.tipo==="date"?"date":"text");
    inner='<input type="'+t+'" data-k="'+c.k+'" value="'+esc(v)+'"'+
      (c.step?' step="'+c.step+'"':"")+(c.min!==undefined?' min="'+c.min+'"':"")+(c.max!==undefined?' max="'+c.max+'"':"")+dis+">";
  }
  return '<div class="fld c'+(c.w||2)+(err?" bad":"")+'"><label>'+esc(c.l)+(req?'<span class="req">*</span>':"")+"</label>"+inner+
    (err?'<div class="err">'+esc(err.msg)+"</div>":"")+
    (c.drv?'<div class="drv">'+esc(c.drv)+"</div>":"")+
    (c.nota&&!err?'<div class="drv">'+esc(c.nota)+"</div>":"")+"</div>";
}

function viewFolha(){
  var o=S.rascunho;
  if(!o) return '<div class="empty"><h4>Obra não encontrada</h4></div>';
  var errs=validarObra(o), tot=totalCampos();
  var preench=tot-errs.filter(function(e){ return e.tipo==="obrigatorio"; }).length;
  var pct=Math.round(preench/tot*100);
  var mi=municipioInfo(o.municipio);

  var h='<div class="phead"><div><h2>'+esc(o.empreendimento||"Nova obra")+"</h2>"+
    '<p class="desc">Folha de dados do cliente, da obra, do projeto e da empreiteira.</p></div>'+
    '<div class="actions"><button class="btn ghost" id="btnVoltar">Voltar para obras</button></div></div>';

  var sujo=folhaAlterada();
  h+='<div class="salvabar'+(sujo?" sujo":"")+'"><div class="estado">'+
    (sujo?'<span class="ponto"></span>Alterações não salvas'
        :(S.salvoEm?'<span class="ok">✓</span>Salvo às '+S.salvoEm.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})
                   :'<span class="ok">✓</span>Sem alterações pendentes'))+
    '</div><div class="acoes">'+
    '<button class="btn ghost sm" id="btnDescartar"'+(sujo?"":" disabled")+'>Descartar</button>'+
    '<button class="btn" id="btnSalvar"'+(sujo&&can("obra.edit")?"":" disabled")+'>'+
    (S.salvando?"Salvando…":"Salvar")+'</button></div></div>';

  h+='<div class="consist'+(errs.length?" bad":"")+'"><div><strong>'+
    (errs.length?errs.length+" ponto"+(errs.length>1?"s":"")+" a resolver":"Folha consistente")+"</strong>"+
    '<div class="note">'+(errs.length?"Resolva os pontos abaixo antes de seguir para o cálculo.":
      "Todos os campos obrigatórios estão preenchidos e nos formatos esperados.")+"</div></div>"+
    '<div class="bar"><i style="width:'+pct+'%"></i></div><span class="mono" style="font-size:12px">'+pct+"%</span></div>";

  if(errs.length){
    h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><h3>Pendências</h3></div>'+
      '<div class="panel-b" style="display:flex;flex-wrap:wrap;gap:7px">'+
      errs.map(function(e){ return '<span class="chip '+(e.tipo==="coerencia"?"warn":"bad")+'">'+esc(e.l)+" — "+esc(e.msg)+"</span>"; }).join("")+
      "</div></div>";
  }
  if(mi){
    h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div><h3>Constantes trazidas pelo município</h3>'+
      '<p class="sub">Preenchidas pelo cadastro e usadas no cálculo de demanda</p></div></div>'+
      '<div class="panel-b grid g4" style="gap:10px">'+
      [["Concessionária",mi.concessionaria],["Constante A",num(mi.constA,4)],["Constante B",num(mi.constB,4)],
       ["Tensão primária nominal",num(mi.tensaoPrimNominal,1)+" kV"],["Classe de tensão",num(mi.classe15_25,0)+" kV"],
       ["Tensão secundária",num(mi.tensaoSecFF,0)+" / "+num(mi.tensaoSecFN,0)+" V"],["UF",mi.uf],
       ["Tabela de kVA",o.gedKvas||"—"]]
      .map(function(r){ return '<div><div style="font-size:11.5px;color:var(--muted)">'+esc(r[0])+
        '</div><div class="mono" style="font-size:14px;margin-top:2px">'+esc(r[1]===null||r[1]===undefined?"—":r[1])+"</div></div>"; }).join("")+
      "</div></div>";
  }
  FD.forEach(function(s,i){
    var se=errs.filter(function(e){ return e.sec===s.id; }).length;
    h+='<div class="sect" data-sect="'+s.id+'"><div class="sect-h"><h4><span class="idx">'+String(i+1).padStart(2,"0")+"</span>"+
      esc(s.titulo)+(se?' <span class="chip bad">'+se+"</span>":"")+"</h4></div>"+
      '<div class="sect-b"><div class="fgrid">'+s.campos.map(function(c){ return campoHTML(c,o,errs); }).join("")+"</div></div></div>";
  });
  return h+'<p class="note">As alterações só vão para o banco quando você clicar em Salvar.</p>';
}

/* ==========================================================================
   CADASTROS E TABELAS
   ========================================================================== */
var TAB={
 concessionarias:{cat:"concessionarias",t:"Concessionárias",d:"Vinculadas aos municípios, materiais e projetos. Cada concessionária carrega a GED vigente.",
   cols:[["nome","Concessionária"],["grupo","Grupo"],["ufs","UF",function(v){return (v||[]).join(", ");}],
         ["municipios","Municípios",null,1],["classesTensao","Classes de tensão",function(v){return (v||[]).join(" / ")+" kV";}],
         ["gedVigente","GED vigente"]],
   busca:["nome","grupo"],perm:"cad",novo:{nome:"",grupo:"",ufs:[],municipios:0,classesTensao:[],gedVigente:"",ativo:true},
   form:[["nome","Concessionária"],["grupo","Grupo"],["gedVigente","GED vigente"]]},
 municipios:{cat:"municipios",t:"Municípios e constantes",d:"Constantes A e B, tensões e concessionária por município, usadas no cálculo de demanda.",
   cols:[["municipio","Município"],["uf","UF"],["concessionaria","Concessionária"],
         ["constA","Constante A",function(v){return num(v,4);},1],["constB","Constante B",function(v){return num(v,4);},1],
         ["tensaoPrimNominal","Tensão prim. (kV)",function(v){return num(v,1);},1],
         ["classe15_25","Classe (kV)",function(v){return num(v,0);},1],
         ["tensaoSecFF","Tensão sec. (V)",function(v,r){return num(v,0)+" / "+num(r.tensaoSecFN,0);},1]],
   busca:["municipio","uf","concessionaria"],perm:"cad",
   novo:{municipio:"",uf:"",concessionaria:"",constA:null,constB:null,tensaoPrimNominal:null,classe15_25:null,tensaoSecFF:null,tensaoSecFN:null},
   form:[["municipio","Município"],["uf","UF"],["concessionaria","Concessionária"],["constA","Constante A","number"],
         ["constB","Constante B","number"],["tensaoPrimNominal","Tensão primária nominal (kV)","number"],
         ["classe15_25","Classe de tensão (kV)","number"],["tensaoSecFF","Tensão secundária fase-fase (V)","number"],
         ["tensaoSecFN","Tensão secundária fase-neutro (V)","number"]]},
 materiais:{cat:"materiais",t:"Materiais",d:"Cadastro próprio, independente dos projetos. O preço unitário entra com a tabela vigente.",
   cols:[["descricao","Descrição"],["grupo","Classe"],["unidade","Un."],["fabricante","Fabricante"],["fornecedor","Fornecedor"],
         ["ged","GED"],["precoUnitario","Preço unitário",function(v){ return v===null||v===undefined?'<span class="pill">pendente</span>':num(v,2); },1]],
   busca:["descricao","grupo","fabricante","fornecedor","ged"],perm:"cad",
   novo:{descricao:"",grupo:"DIVERSOS",unidade:"pç",fabricante:"",fornecedor:"",ged:"",precoUnitario:null},
   form:[["descricao","Descrição"],["grupo","Classe"],["unidade","Unidade"],["fabricante","Fabricante"],
         ["fornecedor","Fornecedor"],["ged","GED"],["precoUnitario","Preço unitário (R$)","number"]]},
 servicos:{cat:"servicos",t:"Serviços",d:"Serviços com código, descrição, unidade e preço unitário.",
   cols:[["codigo","Código"],["descricao","Descrição"],["unidade","Un."],["classe","Classe"],
         ["precoUnitario","Preço unitário",function(v){ return v===null||v===undefined?'<span class="pill">pendente</span>':num(v,2); },1]],
   busca:["codigo","descricao","classe"],perm:"cad",novo:{codigo:"",descricao:"",unidade:"vb",classe:"",precoUnitario:null},
   form:[["codigo","Código"],["descricao","Descrição"],["unidade","Unidade"],["classe","Classe"],["precoUnitario","Preço unitário (R$)","number"]]},
 fornecedores:{cat:"fornecedores",t:"Fornecedores",d:"Fornecedores usados na cotação de materiais.",
   cols:[["nome","Fornecedor"],["tipo","Tipo"]],busca:["nome","tipo"],perm:"cad",
   novo:{nome:"",tipo:"Distribuidor",ativo:true},form:[["nome","Fornecedor"],["tipo","Tipo"]]},
 fabricantes:{cat:"fabricantes",t:"Fabricantes",d:"Fabricantes homologados pela concessionária.",
   cols:[["nome","Fabricante"],["homologado","Homologado",function(v){ return v?'<span class="chip ok">sim</span>':'<span class="chip">não</span>'; }]],
   busca:["nome"],perm:"cad",novo:{nome:"",homologado:true},form:[["nome","Fabricante"]]},
 unidades:{cat:"unidades",t:"Unidades de medida",d:"Unidades usadas nos cadastros de materiais e serviços.",
   cols:[["sigla","Sigla"],["descricao","Descrição"],["grandeza","Grandeza"]],busca:["sigla","descricao"],perm:"cad",
   novo:{sigla:"",descricao:"",grandeza:""},form:[["sigla","Sigla"],["descricao","Descrição"],["grandeza","Grandeza"]]},
 ged:{cat:"ged",t:"GED aplicável ao projeto",d:"Documentos da concessionária que regem o projeto, com data de revisão editável.",
   cols:[["ged","GED"],["descricao","Descrição"],["data","Revisão",function(v){ return v?v.split("-").reverse().join("/"):"—"; }],
         ["pgs","Págs.",null,1],["categoria","Categoria"]],
   busca:["ged","descricao","categoria"],perm:"norm",novo:{ged:"",descricao:"",data:"",pgs:null,categoria:"OPERAC."},
   form:[["ged","GED"],["descricao","Descrição"],["data","Data de revisão","date"],["pgs","Páginas","number"],["categoria","Categoria"]]},
 normas:{cat:"normas",t:"Normas técnicas",d:"Normas técnicas aplicáveis ao projeto.",
   cols:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]],busca:["numero","descricao"],perm:"norm",
   novo:{tipo:"GED",numero:"",descricao:""},form:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]]},
 padroes:{cat:"padroes",t:"Padrões de instalação",d:"Padrões de montagem das estruturas.",
   cols:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]],busca:["numero","descricao"],perm:"norm",
   novo:{tipo:"GED",numero:"",descricao:""},form:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]]},
 especificacoes:{cat:"especificacoes",t:"Especificações técnicas",d:"Especificações dos materiais aplicados no projeto.",
   cols:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]],busca:["numero","descricao"],perm:"norm",
   novo:{tipo:"GED",numero:"",descricao:""},form:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]]},
 aprovados:{cat:"fornecedores_aprovados",t:"Fornecedores aprovados",d:"Documentos que definem fabricantes e fornecedores homologados.",
   cols:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]],busca:["numero","descricao"],perm:"norm",
   novo:{tipo:"GED",numero:"",descricao:""},form:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]]}
};

function viewTabela(rota){
  var cfg=TAB[rota], lista=items(cfg.cat), c=S.cat[cfg.cat];
  var q=S.q.trim().toLowerCase();
  var fil=!q?lista:lista.filter(function(r){ return cfg.busca.some(function(k){ return String(r[k]||"").toLowerCase().indexOf(q)>=0; }); });
  var editavel=can(cfg.perm+".edit");
  var h='<div class="phead"><div><h2>'+esc(cfg.t)+'</h2><p class="desc">'+esc(cfg.d)+"</p></div>"+
    '<div class="actions"><input type="text" class="search" id="qBusca" placeholder="Buscar" value="'+esc(S.q)+'">'+
    (editavel?'<button class="btn" id="btnNovo">Adicionar</button>':"")+"</div></div>";
  if(!lista.length) return h+'<div class="panel"><div class="empty"><h4>Cadastro vazio</h4>'+
    "<p>Nenhum registro importado. A carga inicial é feita pelo script de importação do sistema.</p></div></div>";
  h+='<div class="panel"><div class="tbl-wrap"><table><thead><tr>'+
    cfg.cols.map(function(col){ return "<th"+(col[3]?' class="num"':"")+">"+esc(col[1])+"</th>"; }).join("")+
    (editavel?"<th></th>":"")+"</tr></thead><tbody>";
  fil.slice(0,400).forEach(function(r){
    var idx=lista.indexOf(r);
    h+="<tr>"+cfg.cols.map(function(col){
      var v=r[col[0]], txt=col[2]?col[2](v,r):(v===null||v===undefined||v===""?"—":esc(v));
      return "<td"+(col[3]?' class="num"':"")+">"+txt+"</td>"; }).join("")+
      (editavel?'<td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-edit="'+idx+
        '">Editar</button> <button class="btn danger sm" data-rm="'+idx+'">Excluir</button></td>':"")+"</tr>";
  });
  return h+'</tbody></table></div><div class="tbl-foot"><span>'+fil.length+" de "+lista.length+" registro"+
    (lista.length>1?"s":"")+(fil.length>400?" · mostrando 400":"")+"</span><span>"+
    (c&&c.origem?"Origem: "+esc(c.origem):"")+"</span></div></div>";
}

function viewCabos(){
  var l=items("cabos");
  var h='<div class="phead"><div><h2>Dados técnicos de cabos</h2>'+
    '<p class="desc">Características construtivas, dimensionais e elétricas do cabo protegido de média tensão e do cabo isolado de baixa tensão.</p></div></div>';
  if(!l.length) return h+'<div class="panel"><div class="empty"><h4>Tabela não importada</h4></div></div>';
  function bloco(titulo,campo,valor){
    return '<div class="panel"><div class="panel-h"><h3>'+titulo+'</h3></div><div class="panel-b">'+
      l.filter(function(r){ return r[campo]; }).map(function(r){
        if(!r[valor]) return '<div style="font-size:11.5px;color:var(--muted);margin:12px 0 5px;border-bottom:1px solid var(--line-2);padding-bottom:4px">'+esc(r[campo])+"</div>";
        return '<div class="kv"><span>'+esc(r[campo])+'</span><span class="mono">'+esc(r[valor])+"</span></div>"; }).join("")+"</div></div>";
  }
  return h+'<div class="grid g2">'+bloco("Cabo protegido — média tensão","mtCampo","mtValor")+
    bloco("Cabo isolado — baixa tensão","btCampo","btValor")+"</div>";
}

function viewCintas(){
  var l=items("cintas"), c=S.cat.cintas;
  var h='<div class="phead"><div><h2>Diâmetro de poste e cintas</h2>'+
    '<p class="desc">O diâmetro em qualquer ponto do poste e a cinta correspondente, calculados a partir dos parâmetros de cada bitola.</p></div></div>';
  if(!l.length) return h+'<div class="panel"><div class="empty"><h4>Tabela não importada</h4></div></div>';
  h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div><h3>Regra de cálculo</h3></div></div><div class="panel-b">'+
    '<div class="mono" style="font-size:13px;background:var(--surface-2);padding:11px 13px;border-radius:3px;border:1px solid var(--line-2)">'+
    esc(c.regra||"")+"</div></div></div>";
  h+='<div class="panel"><div class="panel-h"><div><h3>Parâmetros por bitola de poste</h3></div>'+
    '<div style="display:flex;gap:8px;align-items:flex-end"><div class="fld"><label>Bitola</label><select id="ciB">'+
    l.map(function(r,i){ return '<option value="'+i+'">'+esc(r.bitola)+"</option>"; }).join("")+"</select></div>"+
    '<div class="fld"><label>Distância do topo (mm)</label><input type="number" id="ciD" value="1000" step="10" min="0"></div>'+
    '<button class="btn" id="ciCalc">Calcular</button></div></div><div class="panel-b" id="ciOut"></div>'+
    '<div class="tbl-wrap"><table><thead><tr><th>Bitola</th><th class="num">Altura (m)</th><th class="num">Carga (daN)</th>'+
    '<th class="num">Ø topo (mm)</th><th class="num">Ø base (mm)</th><th class="num">Conicidade (mm/mm)</th><th>Cintas disponíveis</th></tr></thead><tbody>'+
    l.map(function(r){ return "<tr><td><strong>"+esc(r.bitola)+'</strong></td><td class="num">'+num(r.altura,1)+
      '</td><td class="num">'+esc(r.carga)+'</td><td class="num">'+num(r.diamTopo,0)+'</td><td class="num">'+num(r.diamBase,0)+
      '</td><td class="num">'+num(r.conicidade,5)+"</td><td>"+
      r.faixas.map(function(f){ return '<span class="pill" style="margin-right:4px">Ø'+f.cinta+"</span>"; }).join("")+"</td></tr>"; }).join("")+
    "</tbody></table></div></div>";
  return h;
}

function viewGed3738(){
  var l=items("ged3738"), lig=(S.cat.ged3738&&S.cat.ged3738.ligacoes)||[], c=S.cat.ged3738;
  var q=S.q.trim().toLowerCase();
  var fil=!q?l:l.filter(function(r){ return r.atividade.toLowerCase().indexOf(q)>=0; });
  var h='<div class="phead"><div><h2>GED 3738 — consumo por atividade</h2><p class="desc">'+
    esc((c&&c.referencia)||"Consumo estimado por atividade e tipo de ligação.")+"</p></div>"+
    '<div class="actions"><input type="text" class="search" id="qBusca" placeholder="Buscar atividade" value="'+esc(S.q)+'"></div></div>';
  if(!l.length) return h+'<div class="panel"><div class="empty"><h4>Tabela não importada</h4></div></div>';
  h+='<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Atividade</th>'+
    lig.map(function(x){ return '<th class="num" title="'+esc((x.fases||"")+" "+(x.tensao||"")+" · renda "+(x.renda||""))+'">'+esc(x.codigo)+"</th>"; }).join("")+
    "</tr></thead><tbody>"+
    fil.map(function(r){ return "<tr><td>"+esc(r.atividade)+"</td>"+lig.map(function(x){
      var v=r.consumo[x.codigo];
      return '<td class="num">'+(v===undefined?'<span style="color:var(--line-strong)">·</span>':num(v,0))+"</td>"; }).join("")+"</tr>"; }).join("")+
    '</tbody></table></div><div class="tbl-foot"><span>'+fil.length+" de "+l.length+" atividades · "+lig.length+
    " tipos de ligação</span></div></div>";
  return h;
}

/* ==========================================================================
   USUÁRIOS E REGISTRO
   ========================================================================== */
function viewUsuarios(){
  var h='<div class="phead"><div><h2>Usuários e perfis</h2>'+
    '<p class="desc">Até cinco usuários com senha e perfil de permissão, separando quem edita cadastro de quem lança e consulta obras.</p></div>'+
    (can("user.edit")&&S.usuarios.length<5?'<div class="actions"><button class="btn" id="btnNovoUser">Adicionar usuário</button></div>':"")+"</div>";
  h+='<div class="panel" style="margin-bottom:14px"><div class="tbl-wrap"><table><thead><tr><th>Nome</th><th>Usuário</th>'+
    "<th>Perfil</th><th>Situação</th><th>Criado em</th>"+(can("user.edit")?"<th></th>":"")+"</tr></thead><tbody>";
  S.usuarios.forEach(function(u,i){
    h+="<tr><td><strong>"+esc(u.nome)+'</strong></td><td class="mono">'+esc(u.login)+"</td><td>"+
      esc((PERFIS[u.perfil]||{}).nome||u.perfil)+"</td><td>"+
      (u.ativo===false?'<span class="chip">inativo</span>':'<span class="chip ok">ativo</span>')+
      '</td><td class="num" style="font-size:12px;color:var(--muted)">'+fmtDT(u.criadoEm)+"</td>"+
      (can("user.edit")?'<td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-eu="'+i+'">Editar</button>'+
        (u._id!==S.sess.id?' <button class="btn danger sm" data-du="'+i+'">Excluir</button>':"")+"</td>":"")+"</tr>";
  });
  h+='</tbody></table></div><div class="tbl-foot"><span>'+S.usuarios.length+" de 5 usuários</span></div></div>";
  h+='<div class="panel"><div class="panel-h"><div><h3>O que cada perfil alcança</h3></div></div>'+
    '<div class="tbl-wrap"><table><thead><tr><th>Perfil</th><th>Cadastros</th><th>Tabelas normativas</th><th>Obras</th>'+
    "<th>Usuários</th><th>Registro</th></tr></thead><tbody>"+
    Object.keys(PERFIS).map(function(k){
      function m(p){ var l=PERMS[k];
        if(l.indexOf(p+".edit")>=0) return '<span class="chip ok">edita</span>';
        if(l.indexOf(p+".ler")>=0) return '<span class="chip">consulta</span>';
        return '<span style="color:var(--line-strong)">—</span>'; }
      return "<tr><td><strong>"+esc(PERFIS[k].nome)+'</strong><div class="note">'+esc(PERFIS[k].desc)+"</div></td><td>"+
        m("cad")+"</td><td>"+m("norm")+"</td><td>"+m("obra")+"</td><td>"+m("user")+"</td><td>"+m("log")+"</td></tr>"; }).join("")+
    "</tbody></table></div></div>";
  return h;
}
function viewRegistro(){
  var h='<div class="phead"><div><h2>Registro de operações</h2>'+
    '<p class="desc">Log das operações sensíveis, com identificação de quem as executou.</p></div>'+
    '<div class="actions"><button class="btn ghost" id="btnRecarregarLog">Atualizar</button></div></div>';
  if(!S.log.length) return h+'<div class="panel"><div class="empty"><h4>Nenhuma operação registrada</h4>'+
    "<p>Entradas no sistema, alterações de cadastro, de obra e de usuário aparecem aqui.</p></div></div>";
  return h+'<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Quando</th><th>Quem</th><th>Perfil</th>'+
    "<th>Operação</th><th>Detalhe</th></tr></thead><tbody>"+
    S.log.map(function(r){ return '<tr><td class="num" style="font-size:12px">'+fmtDT(r.quando)+"</td><td>"+esc(r.quem||"—")+
      "</td><td>"+esc((PERFIS[r.perfil]||{}).nome||r.perfil||"—")+"</td><td><strong>"+esc(r.acao)+
      '</strong></td><td style="color:var(--text-2)">'+esc(r.detalhe||r.alvo||"")+"</td></tr>"; }).join("")+
    '</tbody></table></div><div class="tbl-foot"><span>'+S.log.length+" operações (200 mais recentes)</span></div></div>";
}

/* ==========================================================================
   MODAIS
   ========================================================================== */
function modal(titulo,corpo,onOk,okLabel){
  var bg=el('<div class="modal-bg"><div class="modal"><div class="modal-h"><h3>'+esc(titulo)+
    '</h3><button class="linkbtn" data-x>Fechar</button></div><div class="modal-b">'+corpo+
    '</div><div class="modal-f"><button class="btn ghost" data-x>Cancelar</button>'+
    '<button class="btn" data-ok>'+esc(okLabel||"Salvar")+"</button></div></div></div>");
  document.body.appendChild(bg);
  function fecha(){ bg.remove(); }
  bg.querySelectorAll("[data-x]").forEach(function(b){ b.addEventListener("click",fecha); });
  bg.addEventListener("click",function(e){ if(e.target===bg) fecha(); });
  bg.querySelector("[data-ok]").addEventListener("click",async function(){ if(await onOk(bg)!==false) fecha(); });
  var first=bg.querySelector("input,select,textarea"); if(first) first.focus();
  return bg;
}
function formCampos(defs,valores){
  return '<div class="fgrid">'+defs.map(function(d){
    var t=d[2]||"text";
    return '<div class="fld c3"><label>'+esc(d[1])+'</label><input type="'+t+'" data-f="'+d[0]+'" value="'+
      esc(valores[d[0]]===null||valores[d[0]]===undefined?"":valores[d[0]])+'"'+(t==="number"?' step="any"':"")+"></div>"; }).join("")+"</div>";
}
function lerForm(bg){ var o={};
  bg.querySelectorAll("[data-f]").forEach(function(i){
    var v=i.value; if(i.type==="number") v=v===""?null:Number(v); o[i.getAttribute("data-f")]=v; });
  return o; }

function editarRegistro(rota,idx){
  var cfg=TAB[rota], lista=items(cfg.cat);
  var novo=idx<0, base=novo?Object.assign({},cfg.novo):Object.assign({},lista[idx]);
  modal((novo?"Adicionar em ":"Editar registro de ")+cfg.t.toLowerCase(),formCampos(cfg.form,base),async function(bg){
    var rec=Object.assign({},base,lerForm(bg));
    if(!String(rec[cfg.form[0][0]]||"").trim()){ toast("Preencha "+cfg.form[0][1].toLowerCase()); return false; }
    if(novo) lista.push(rec); else lista[idx]=rec;
    S.cat[cfg.cat].items=lista;
    try{ await Store.salvarCatalogo(cfg.cat); }catch(e){ toast(e.message); return false; }
    await Store.registrar(novo?"Incluiu registro":"Alterou registro",cfg.cat,cfg.t+" · "+String(rec[cfg.form[0][0]]));
    toast(novo?"Registro incluído":"Registro alterado"); render();
  });
}
function excluirRegistro(rota,idx){
  var cfg=TAB[rota], lista=items(cfg.cat), r=lista[idx];
  modal("Excluir registro","<p>Excluir <strong>"+esc(String(r[cfg.form[0][0]]))+"</strong> de "+esc(cfg.t.toLowerCase())+
    '?</p><p class="note">A operação fica registrada no log com o seu usuário.</p>',async function(){
    lista.splice(idx,1); S.cat[cfg.cat].items=lista;
    try{ await Store.salvarCatalogo(cfg.cat); }catch(e){ toast(e.message); return false; }
    await Store.registrar("Excluiu registro",cfg.cat,cfg.t+" · "+String(r[cfg.form[0][0]]));
    toast("Registro excluído"); render();
  },"Excluir");
}
function editarUsuario(i){
  var novo=i<0, u=novo?{nome:"",login:"",perfil:"projetista",ativo:true}:Object.assign({},S.usuarios[i]);
  var corpo='<div class="fgrid">'+
    '<div class="fld c3"><label>Nome completo</label><input type="text" data-f="nome" value="'+esc(u.nome)+'"></div>'+
    '<div class="fld c3"><label>Usuário</label><input type="text" data-f="login" value="'+esc(u.login)+'"></div>'+
    '<div class="fld c3"><label>Perfil</label><select data-f="perfil">'+
      Object.keys(PERFIS).map(function(k){ return '<option value="'+k+'"'+(u.perfil===k?" selected":"")+">"+esc(PERFIS[k].nome)+"</option>"; }).join("")+
      "</select></div>"+
    '<div class="fld c3"><label>Situação</label><select data-f="ativo"><option value="1"'+(u.ativo!==false?" selected":"")+
      '>Ativo</option><option value="0"'+(u.ativo===false?" selected":"")+">Inativo</option></select></div>"+
    '<div class="fld c6"><label>'+(novo?"Senha":"Nova senha (deixe em branco para manter)")+
      '</label><input type="password" data-f="senha"></div></div>';
  modal(novo?"Adicionar usuário":"Editar usuário",corpo,async function(bg){
    var v={}; bg.querySelectorAll("[data-f]").forEach(function(x){ v[x.getAttribute("data-f")]=x.value; });
    if(!v.nome.trim()||!v.login.trim()){ toast("Nome e usuário são obrigatórios"); return false; }
    if(novo&&v.senha.length<6){ toast("A senha precisa de pelo menos 6 caracteres"); return false; }
    var rec={ _id:novo?uid():u._id, nome:v.nome.trim(), login:v.login.trim().toLowerCase(),
              perfil:v.perfil, ativo:v.ativo==="1", criadoEm:u.criadoEm||new Date().toISOString() };
    if(v.senha) rec.senha=v.senha;
    try{
      var salvo=await Store.salvarUsuario(rec);
      if(novo) S.usuarios.push(salvo); else S.usuarios[i]=salvo;
    }catch(e){ toast(e.message); return false; }
    toast(novo?"Usuário criado":"Usuário alterado");
    if(can("log.ler")) await lerLog();
    render();
  });
}

/* ==========================================================================
   RENDER
   ========================================================================== */
function render(){
  var app=document.getElementById("app");
  if(!S.ready){ app.innerHTML='<div class="loading">Carregando…</div>'; return; }
  if(!S.sess){ app.innerHTML=viewLogin(); ligarLogin(); return; }
  var corpo="";
  switch(S.route){
    case "painel": corpo=viewPainel(); break;
    case "obras": corpo=viewObras(); break;
    case "folha": corpo=viewFolha(); break;
    case "usuarios": corpo=can("user.ler")?viewUsuarios():'<div class="empty"><h4>Sem permissão</h4></div>'; break;
    case "registro": corpo=can("log.ler")?viewRegistro():'<div class="empty"><h4>Sem permissão</h4></div>'; break;
    case "cabos": corpo=viewCabos(); break;
    case "cintas": corpo=viewCintas(); break;
    case "ged3738": corpo=viewGed3738(); break;
    default: corpo=TAB[S.route]?viewTabela(S.route):viewPainel();
  }
  app.innerHTML='<div class="shell">'+viewRail()+'<div class="main">'+viewTop()+'<div class="content">'+corpo+"</div></div></div>";
  ligarEventos();
}

async function irPara(destino){
  S.route=destino; S.q="";
  MENU.forEach(function(g){ if(g.itens.some(function(i){ return i.r===destino; })) S.grupos[g.grp]=true; });
  if(destino==="registro"){ await lerLog(); }
  render();
}
function ligarEventos(){
  document.querySelectorAll(".rail .grp").forEach(function(gh){
    gh.addEventListener("click",function(){
      var nome=gh.getAttribute("data-grp"), g=grupoPorNome(nome);
      if(!g) return;
      S.grupos[nome]=!grupoAberto(g);
      render();
    });
  });
  document.querySelectorAll(".rail a").forEach(function(a){
    a.addEventListener("click",async function(){
      var destino=a.getAttribute("data-r");
      if(S.route==="folha"&&folhaAlterada()){
        confirmarSaida(function(){ irPara(destino); });
        return;
      }
      fecharFolha();
      irPara(destino);
    });
  });
  var sair=document.getElementById("btnSair");
  if(sair) sair.addEventListener("click",async function(){ await Store.sair(); S.sess=null; S.route="painel"; render(); });

  var q=document.getElementById("qBusca");
  if(q) q.addEventListener("input",function(){
    S.q=q.value; var pos=q.selectionStart; render();
    var n=document.getElementById("qBusca"); if(n){ n.focus(); n.setSelectionRange(pos,pos); } });

  var nova=document.getElementById("btnNovaObra");
  if(nova) nova.addEventListener("click",async function(){
    var o=Object.assign({_id:uid(),criadoEm:new Date().toISOString(),criadoPor:S.sess.nome},PADROES);
    try{ await Store.salvarObra(o); }catch(e){ return toast(e.message); }
    S.obras.push(o);
    await Store.registrar("Criou obra",o._id,"Nova obra");
    abrirFolha(o._id); render();
  });
  document.querySelectorAll("[data-obra]").forEach(function(b){
    b.addEventListener("click",function(){ abrirFolha(b.getAttribute("data-obra")); render(); }); });
  document.querySelectorAll("[data-del-obra]").forEach(function(b){
    b.addEventListener("click",function(){
      var id=b.getAttribute("data-del-obra"), o=null;
      S.obras.forEach(function(x){ if(x._id===id) o=x; });
      modal("Excluir obra","<p>Excluir <strong>"+esc(o.empreendimento||"(sem nome)")+"</strong> e a folha de dados associada?</p>",async function(){
        try{ await Store.excluirObra(id); }catch(e){ toast(e.message); return false; }
        S.obras=S.obras.filter(function(x){ return x._id!==id; });
        await Store.registrar("Excluiu obra",id,o.empreendimento||"");
        toast("Obra excluída"); render();
      },"Excluir");
    });
  });
  var volta=document.getElementById("btnVoltar");
  if(volta) volta.addEventListener("click",function(){
    confirmarSaida(function(){ S.route="obras"; render(); }); });

  var bs=document.getElementById("btnSalvar");
  if(bs) bs.addEventListener("click",async function(){ render(); await salvarFolha(); render(); });
  var bd=document.getElementById("btnDescartar");
  if(bd) bd.addEventListener("click",function(){
    modal("Descartar alterações","<p>As alterações feitas desde a última gravação serão perdidas.</p>",function(){
      S.rascunho=JSON.parse(S.original); render();
    },"Descartar"); });

  document.querySelectorAll(".sect-h").forEach(function(hd){
    hd.addEventListener("click",function(e){ if(e.target.closest("input,select")) return; hd.parentNode.classList.toggle("closed"); }); });

  document.querySelectorAll(".sect-b [data-k]").forEach(function(inp){
    var ev=(inp.tagName==="SELECT")?"change":"input";
    inp.addEventListener(ev,function(){
      var o=S.rascunho;
      if(!o) return;
      var k=inp.getAttribute("data-k"), v=inp.value;
      if(inp.type==="number") v=v===""?"":Number(v);
      o[k]=v;
      if(k==="municipio"||k==="municipioCli"||k==="munEmp"){
        var mi=municipioInfo(v);
        if(k==="municipio"&&mi){ o.uf=mi.uf; o.concessionaria=mi.concessionaria; }
        if(k==="municipioCli"&&mi) o.ufCli=mi.uf;
        if(k==="munEmp"&&mi) o.ufEmp=mi.uf;
      }
      if(ev==="change"||inp.type==="date"){ render(); }
      else{
        var pend=validarObra(o), barra=document.querySelector(".consist .bar i");
        if(barra) barra.style.width=Math.round((totalCampos()-pend.filter(function(e){return e.tipo==="obrigatorio";}).length)/totalCampos()*100)+"%";
        var bar=document.querySelector(".salvabar");
        if(bar&&!bar.classList.contains("sujo")){
          bar.classList.add("sujo");
          bar.querySelector(".estado").innerHTML='<span class="ponto"></span>Alterações não salvas';
          bar.querySelectorAll("button").forEach(function(b){ b.disabled=false; });
        }
      }
    });
    inp.addEventListener("blur",function(){ if(inp.type!=="number"&&inp.tagName!=="SELECT") render(); });
  });

  var bn=document.getElementById("btnNovo");
  if(bn) bn.addEventListener("click",function(){ editarRegistro(S.route,-1); });
  document.querySelectorAll("[data-edit]").forEach(function(b){
    b.addEventListener("click",function(){ editarRegistro(S.route,Number(b.getAttribute("data-edit"))); }); });
  document.querySelectorAll("[data-rm]").forEach(function(b){
    b.addEventListener("click",function(){ excluirRegistro(S.route,Number(b.getAttribute("data-rm"))); }); });

  var bu=document.getElementById("btnNovoUser");
  if(bu) bu.addEventListener("click",function(){ editarUsuario(-1); });
  document.querySelectorAll("[data-eu]").forEach(function(b){
    b.addEventListener("click",function(){ editarUsuario(Number(b.getAttribute("data-eu"))); }); });
  document.querySelectorAll("[data-du]").forEach(function(b){
    b.addEventListener("click",function(){
      var i=Number(b.getAttribute("data-du")), u=S.usuarios[i];
      modal("Excluir usuário","<p>Excluir o acesso de <strong>"+esc(u.nome)+"</strong>?</p>",async function(){
        try{ await Store.excluirUsuario(u._id); }catch(e){ toast(e.message); return false; }
        S.usuarios.splice(i,1);
        toast("Usuário excluído");
        if(can("log.ler")) await lerLog();
        render();
      },"Excluir");
    });
  });
  var rl=document.getElementById("btnRecarregarLog");
  if(rl) rl.addEventListener("click",async function(){ await lerLog(); render(); });

  var cc=document.getElementById("ciCalc");
  if(cc) cc.addEventListener("click",function(){
    var l=items("cintas"), r=l[Number(document.getElementById("ciB").value)];
    var d=Number(document.getElementById("ciD").value), out=document.getElementById("ciOut");
    if(d<0||d>r.altura*1000){ out.innerHTML='<span class="chip bad">Distância fora do comprimento do poste ('+num(r.altura*1000,0)+" mm)</span>"; return; }
    var dia=r.diamTopo+d*r.conicidade, cinta=null;
    r.faixas.forEach(function(f){ if(cinta===null&&dia<=f.ate+0.001) cinta=f.cinta; });
    if(cinta===null) cinta=r.faixas[r.faixas.length-1].cinta;
    out.innerHTML='<div class="grid g3" style="gap:10px">'+
      '<div><div style="font-size:11.5px;color:var(--muted)">Diâmetro no ponto</div><div class="mono" style="font-size:20px">'+num(dia,1)+" mm</div></div>"+
      '<div><div style="font-size:11.5px;color:var(--muted)">Cinta indicada</div><div class="mono" style="font-size:20px;color:var(--accent)">Ø '+cinta+" mm</div></div>"+
      '<div><div style="font-size:11.5px;color:var(--muted)">Poste</div><div class="mono" style="font-size:20px">'+esc(r.bitola)+"</div></div></div>";
  });
}

/* ==========================================================================
   INÍCIO
   ========================================================================== */
window.addEventListener("beforeunload",function(e){
  if(S.route==="folha"&&folhaAlterada()){ e.preventDefault(); e.returnValue=""; }
});

(async function(){
  render();
  Store=await criarStore();
  await carregar();
  if(S.sess&&can("log.ler")) await lerLog();
  render();
})();