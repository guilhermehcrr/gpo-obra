"use strict";
/* ==========================================================================
   GPO Obra — sistema de engenharia e gestão de obra
   Projetos de rede de distribuição de energia elétrica
   ========================================================================== */

var S = { sess:null, route:"painel", obraId:null, q:"", cat:{}, obras:[], usuarios:[],
          log:[], ready:false, offline:false, precisaPrimeiro:false, grupos:{},
          rascunho:null, original:"", salvoEm:null, salvando:false };

var CHAVES_NORMATIVAS = ["normas","padroes","especificacoes","fornecedores_aprovados","ged","ged3738","cintas","cabos",
  "cabos_qt","trafos","luminarias","empreendimentos","estruturas"];

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
function revisaoDe(k){ var c=S.cat[k]; return (c&&c.revisao)||null; }
function rotuloRevisao(k){ var r=revisaoDe(k); return r&&r.versao?r.versao:"não informada"; }
// Tabelas cuja revisão é carimbada na obra, porque entram no cálculo ou no memorial.
var TABELAS_NORMATIVAS=["anexo1","cabos_qt","trafos","luminarias","empreendimentos","estruturas","ged","ged3738","normas","padroes","especificacoes","fornecedores_aprovados","cintas","cabos"];
function revisoesAtuais(){
  var o={};
  TABELAS_NORMATIVAS.forEach(function(k){ var r=revisaoDe(k); if(r&&r.versao) o[k]=r.versao; });
  return o;
}
function revisoesDefasadas(obra){
  var usadas=obra&&obra.revisoes, fora=[];
  if(!usadas) return fora;
  var atuais=revisoesAtuais();
  Object.keys(usadas).forEach(function(k){
    if(atuais[k]&&atuais[k]!==usadas[k]) fora.push({chave:k,usada:usadas[k],atual:atuais[k]});
  });
  return fora;
}
var NOME_TABELA={anexo1:"Anexo 1 — previsão de consumo",
  cabos_qt:"Cabos — queda de tensão",trafos:"Transformadores",luminarias:"Luminárias",
  empreendimentos:"Tipos de empreendimento",estruturas:"Estruturas por ângulo",ged:"GED aplicável",ged3738:"GED 3738 — consumo",normas:"Normas técnicas",
  padroes:"Padrões de instalação",especificacoes:"Especificações técnicas",
  fornecedores_aprovados:"Fornecedores aprovados",cintas:"Diâmetro de poste e cintas",cabos:"Dados técnicos de cabos"};
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
    anexo1:"normativas/anexo1", ged:"normativas/ged", ged3738:"normativas/ged3738", cintas:"normativas/cintas", cabos:"normativas/cabos",
    cabos_qt:"normativas/cabos_qt", trafos:"normativas/trafos", luminarias:"normativas/luminarias",
    empreendimentos:"normativas/empreendimentos", estruturas:"normativas/estruturas" };
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

/* ---------- formatação ---------- */
var MINUSCULAS=["de","da","do","das","dos","e","em","no","na","nos","nas","a","o","as","os","ao","aos",
  "à","às","para","com","por","sob","sobre","entre","sem","um","uma"];
function titulo(s){
  if(!s) return s;
  var partes=String(s).toLowerCase().trim().split(/\s+/);
  return partes.map(function(p,i){
    if(i>0&&MINUSCULAS.indexOf(p)>=0) return p;
    return p.replace(/^([a-zà-ÿ])/,function(c){ return c.toUpperCase(); })
            .replace(/([-'\u2019])([a-zà-ÿ])/g,function(_,s2,c){ return s2+c.toUpperCase(); });
  }).join(" ");
}
function mascara(valor,molde){
  var d=digitos(valor), fora=0, out="";
  for(var i=0;i<molde.length&&fora<d.length;i++){
    if(molde[i]==="0"){ out+=d[fora++]; } else { out+=molde[i]; }
  }
  return out;
}
var FORMATO={
  titulo:titulo,
  maiuscula:function(v){ return (v||"").toUpperCase().trim(); },
  minuscula:function(v){ return (v||"").toLowerCase().trim(); },
  cnpj:function(v){ return mascara(v,"00.000.000/0000-00"); },
  cpf:function(v){ return mascara(v,"000.000.000-00"); },
  cep:function(v){ return mascara(v,"00000-000"); },
  telefone:function(v){ var d=digitos(v);
    return d.length>10?mascara(v,"(00) 00000-0000"):mascara(v,"(00) 0000-0000"); },
  ie:function(v,obra){
    var uf=(obra&&(obra.ufEmp||obra.uf||obra.ufCli))||"";
    if(uf==="RS") return mascara(v,"000/0000000");
    return mascara(v,"000.000.000.000");
  }
};
function aplicarFormato(campo,valor,obra){
  if(!campo.fmt||valor===""||valor===null||valor===undefined) return valor;
  var f=FORMATO[campo.fmt];
  return f?f(valor,obra):valor;
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
   MOTOR DE ENGENHARIA
   Cada função reproduz uma regra da planilha de origem. São puras: recebem
   os valores e devolvem o resultado, sem tocar na tela nem no banco.
   ========================================================================== */

/* Arredondamento conforme a folha de dados (ARRED / TRUNCAR / para cima / para baixo). */
function cortar(v,funcao,casas){
  if(v===null||v===undefined||isNaN(v)) return 0;
  var f=Math.pow(10,casas===undefined?2:casas);
  switch(funcao){
    case "TRUNCAR": return Math.trunc(v*f)/f;
    case "ARREDONDAR.PARA.CIMA": return Math.ceil(v*f)/f;
    case "ARREDONDAR.PARA.BAIXO": return Math.floor(v*f)/f;
    default: return Math.round(v*f)/f;   // ARRED
  }
}
function trunc(v,casas){ return cortar(v,"TRUNCAR",casas); }

/* Demanda de um grupo de consumidores ligados ao mesmo transformador.

     kVA do grupo    = A × (Nx × kWh)^B
     kVA por consum. = A × (Nx × kWh)^B / Nx

   A e B são as constantes da concessionária, kWh é o consumo por lote e Nx é
   o número de consumidores do grupo. A diversidade está dentro do expoente B:
   quanto mais consumidores no mesmo transformador, menor a demanda de cada um.
   Por isso a demanda por consumidor não é constante da obra, é do grupo.

   Com tipos diferentes no mesmo transformador, Nx × kWh vira a soma dos kWh
   de todos eles, que é a mesma conta quando o tipo é um só. */
function demandaGrupo(ctx,n1,n2,nEsp){
  var nx=(Number(n1)||0)+(Number(n2)||0)+(Number(nEsp)||0);
  var vazio={nx:nx,kwhTotal:0,total:0,porConsumidor:0};
  if(!ctx||!nx||!ctx.constA||!ctx.constB) return vazio;
  var kwhTotal=(Number(n1)||0)*(ctx.kwh1||0)+(Number(n2)||0)*(ctx.kwh2||0);
  if(!kwhTotal) return vazio;
  var total=ctx.constA*Math.pow(kwhTotal,ctx.constB);
  return {nx:nx, kwhTotal:kwhTotal,
          total:cortar(total,ctx.funcao,ctx.casas),
          porConsumidor:cortar(total/nx,ctx.funcao,ctx.casas)};
}

/* Mesma conta, para quando só se quer o valor por consumidor. */
function demandaConsumidor(ctx,n1,n2,nEsp){ return demandaGrupo(ctx,n1,n2,nEsp).porConsumidor; }

/* Fator de potência e carregamento admissível, por tipo de empreendimento. */
function empreendimentoInfo(tipo){
  var l=items("empreendimentos"), r=null;
  l.forEach(function(x){ if(x.tipo&&tipo&&x.tipo.toLowerCase()===String(tipo).toLowerCase()) r=x; });
  return r;
}
function fatorPotencia(tipo){ var e=empreendimentoInfo(tipo); return e?e.fatorPotencia:1; }

/* Consumo da luminária, em kVA. */
function potenciaLuminaria(modelo){
  var r=0; items("luminarias").forEach(function(x){ if(x.modelo===modelo) r=x.consumo; });
  return r||0;
}

/* Coeficiente de queda de tensão do cabo (GED 3667 Tab. 4.1).
   Escolhido pela tensão nominal da rede e pelo fator de potência. */
function coefCabo(bitola,tensaoNominal,fp){
  var c=null; items("cabos_qt").forEach(function(x){ if(x.bitola===String(bitola)) c=x; });
  if(!c) return null;
  var faixa=Number(tensaoNominal)>275?"380":"220";
  var pot=Number(fp)===1?"1":"092";
  var v=c.coef[faixa+"_"+pot];
  return (v===null||v===undefined)?null:v;
}
function amperagemCabo(bitola){
  var r=null; items("cabos_qt").forEach(function(x){ if(x.bitola===String(bitola)) r=x.amperagem; });
  return r;
}

/* Estrutura a partir do ângulo de aplicação entre trechos. */
function estruturaPorAngulo(angulo,nivel){
  var t=S.cat.estruturas; if(!t) return null;
  var faixas=(nivel==="secundaria")?t.secundarias:t.primarias;
  var a=Number(angulo), r=null;
  (faixas||[]).forEach(function(f){ if(r===null&&a>=f.de&&a<=f.ate) r=f; });
  return r;
}

/* Contexto de cálculo da obra: tudo que não varia de ponto para ponto. */
function contextoCalculo(obra){
  var mi=municipioInfo(obra.municipio);
  var c=mi?constantesDe(mi):{constA:null,constB:null};
  var fp=fatorPotencia(obra.tipoEmpreendimento);
  return {
    constA:c.constA, constB:c.constB,
    tensaoNominal: mi?mi.tensaoSecFF:null,
    tensaoFN: mi?mi.tensaoSecFN:null,
    tensaoPrim: mi?mi.tensaoPrimNominal:null,
    fatorPotencia: fp,
    kwh1: consumoAnexo1(obra.atividadeT1,obra.ligacaoT1)||0,
    kwh2: consumoAnexo1(obra.atividadeT2,obra.ligacaoT2)||0,
    potLum1: potenciaLuminaria(obra.luminaria),
    potLum2: potenciaLuminaria(obra.luminaria2),
    funcao: obra.funcaoArred||"ARRED",
    casas: obra.casasDecimais===undefined?2:Number(obra.casasDecimais),
    limiteSec: Number(obra.qtMaxSec)||0,
    limiteIP: Number(obra.qtMaxIP)||0,
    caboSec: obra.caboSecundario||null,
    fatorCarreg: fatorCarregamento(obra),
    lotesTotais: Number(obra.lotesTotais)||0,
    lotesExistentes: Number(obra.lotesExistentes)||0
  };
}

/* Fator de carregamento admissível do transformador: KVAT = fator × KVAN.
   Vem do tipo de empreendimento, e a obra pode sobrescrever. */
function fatorCarregamento(obra){
  if(obra&&obra.fatorCarreg) return Number(obra.fatorCarreg);
  var e=empreendimentoInfo(obra&&obra.tipoEmpreendimento);
  if(e&&e.kvatAdmissivel) return Number(e.kvatAdmissivel);
  var t=S.cat.trafos;
  if(t&&t.fatores){
    var nucleo=/núcleo/i.test((obra&&obra.tipoEmpreendimento)||"");
    var f=nucleo?t.fatores["Núcleo habitacional"]:t.fatores["Loteamento"];
    if(f) return Number(f);
  }
  return 1.5;
}

/* Consumo estimado do loteamento, em kWh/mês. */
function consumoLoteamento(obra){
  var k1=consumoAnexo1(obra.atividadeT1,obra.ligacaoT1)||0;
  var k2=consumoAnexo1(obra.atividadeT2,obra.ligacaoT2)||0;
  return (Number(obra.qtdT1)||0)*k1 + (Number(obra.qtdT2)||0)*k2;
}

/* Carga de um ponto, em kVA.

   kvas é a demanda por consumidor do transformador que alimenta este ponto.
   Como ela depende de quantos consumidores existem no circuito inteiro, o
   valor chega pronto de calcularCircuito em vez de sair do contexto da obra. */
function cargaDoPonto(p,ctx,kvas){
  if(!p) return 0;
  var d=(kvas===undefined||kvas===null)?0:kvas;
  return ((Number(p.consT1)||0)+(Number(p.consT2)||0))*d
       + (Number(p.lumT1)||0)*ctx.potLum1
       + (Number(p.lumT2)||0)*ctx.potLum2
       + (Number(p.cargaEspecial)||0);
}

/* Consumidores e luminárias de um conjunto de pontos. */
function somarPontos(pontos){
  var t={consT1:0,consT2:0,lumT1:0,lumT2:0,cargaEspecial:0,especiais:0};
  (pontos||[]).forEach(function(p){
    t.consT1+=Number(p.consT1)||0; t.consT2+=Number(p.consT2)||0;
    t.lumT1+=Number(p.lumT1)||0;   t.lumT2+=Number(p.lumT2)||0;
    var ce=Number(p.cargaEspecial)||0;
    t.cargaEspecial+=ce; if(ce>0) t.especiais++;
  });
  return t;
}

/* Percorre a topologia de um transformador e devolve, para cada trecho:
   carga própria do ponto de chegada, carga acumulada a jusante, momento
   elétrico, queda do trecho, queda acumulada, tensão e corrente.

   O momento usa a carga local pela metade (centro de gravidade do trecho)
   e a carga de jusante inteira, como na planilha de origem. */
function calcularCircuito(obra,trafoId){
  var ctx=contextoCalculo(obra);
  var pontos={}, filhos={}, cargas={};
  (obra.pontos||[]).forEach(function(p){ pontos[String(p.id)]=p; });
  var trechos=(obra.trechos||[]).filter(function(t){
    return String(t.trafo||"")===String(trafoId) && t.de && t.para; });
  trechos.forEach(function(t){
    var k=String(t.de);
    (filhos[k]=filhos[k]||[]).push(t);
  });

  var trafo=null; (obra.trafos||[]).forEach(function(x){ if(String(x.id)===String(trafoId)) trafo=x; });
  var raiz=trafo?String(trafo.ponto):null;
  var saida=[], ciclo=false;

  /* Primeiro passo: quais pontos pertencem a este transformador. A demanda por
     consumidor depende de quantos consumidores o circuito inteiro tem, então
     o conjunto precisa estar fechado antes de qualquer carga ser calculada. */
  var noCircuito={};
  (function alcancar(ponto,pilha){
    var k=String(ponto);
    if(!k||pilha[k]) { if(pilha[k]) ciclo=true; return; }
    pilha[k]=1; noCircuito[k]=1;
    (filhos[k]||[]).forEach(function(t){ alcancar(t.para,pilha); });
    delete pilha[k];
  })(raiz,{});

  var listaPontos=Object.keys(noCircuito).map(function(k){ return pontos[k]; })
    .filter(function(p){ return !!p; });
  var tot=somarPontos(listaPontos);
  var grupo=demandaGrupo(ctx,tot.consT1,tot.consT2,tot.especiais);
  var kvas=grupo.porConsumidor;

  Object.keys(pontos).forEach(function(k){ cargas[k]=cargaDoPonto(pontos[k],ctx,kvas); });

  // Carga total a jusante de um ponto, incluindo a dele próprio.
  function jusante(ponto,pilha){
    var k=String(ponto);
    if(pilha[k]){ ciclo=true; return 0; }
    pilha[k]=1;
    var soma=cargas[k]||0;
    (filhos[k]||[]).forEach(function(t){ soma+=jusante(t.para,pilha); });
    delete pilha[k];
    return soma;
  }

  function descer(ponto,quedaAcum,pilha){
    var k=String(ponto);
    if(pilha[k]){ ciclo=true; return; }
    pilha[k]=1;
    (filhos[k]||[]).forEach(function(t){
      var destino=String(t.para);
      var local=cargas[destino]||0;
      var aJusante=0;
      (filhos[destino]||[]).forEach(function(f){ aJusante+=jusante(f.para,{}); });
      var mom=trunc(((local/2+aJusante)*(Number(t.comprimento)||0))/100,2);
      var bitola=t.bitola||ctx.caboSec;
      var coef=coefCabo(bitola,ctx.tensaoNominal,ctx.fatorPotencia);
      var queda=(coef===null)?null:cortar(mom*coef,ctx.funcao,ctx.casas);
      var acum=(queda===null)?quedaAcum:cortar(quedaAcum+queda,ctx.funcao,ctx.casas);
      var tensao=ctx.tensaoNominal?ctx.tensaoNominal-(ctx.tensaoNominal*acum/100):null;
      var corrente=(tensao&&mom)?mom*1000/tensao/Math.sqrt(3):0;
      var limite=(t.classificacao==="IP")?ctx.limiteIP:ctx.limiteSec;
      saida.push({
        de:k, para:destino, comprimento:Number(t.comprimento)||0,
        designacao:letraPonto(pontos[k],k,k===raiz)+"-"+letraPonto(pontos[destino],destino,destino===raiz),
        classificacao:t.classificacao||"S", bitola:bitola,
        cargaLocal:local, cargaJusante:aJusante, momento:mom,
        coef:coef, queda:queda, quedaAcumulada:acum,
        tensao:tensao, corrente:corrente,
        amperagem:amperagemCabo(bitola),
        limite:limite,
        excedeQueda:(queda!==null&&limite>0&&acum>limite),
        excedeCorrente:(amperagemCabo(bitola)&&corrente>amperagemCabo(bitola)),
        semCoeficiente:(coef===null&&!!bitola)
      });
      descer(destino,acum,pilha);
    });
    delete pilha[k];
  }

  if(raiz) descer(raiz,0,{});
  return {trechos:saida, ciclo:ciclo, ctx:ctx, raiz:raiz,
          totais:tot, grupo:grupo, kvas:kvas, pontos:listaPontos.length,
          cargaTotal:raiz?jusante(raiz,{}):0};
}

/* Designação do ponto no relatório: a letra escolhida pelo projetista, ou o
   próprio número do ponto quando ainda não houver letra. A raiz sai como T,
   que é como o formulário da concessionária marca o transformador. */
function letraPonto(p,id,ehRaiz){
  if(ehRaiz) return "T";
  if(p&&p.letra) return String(p.letra).toUpperCase();
  return String(id);
}

/* Demanda vista pelo transformador.

     diurna  = (Nx × kVAS) + cargas especiais
     noturna = diurna + luminárias

   A escolha do transformador e o carregamento olham a demanda noturna, que é
   a maior das duas. O fator de potência corrige a parcela dos consumidores. */
function demandaTrafo(obra,trafoId){
  var r=calcularCircuito(obra,trafoId), ctx=r.ctx, tot=r.totais;
  var fp=ctx.fatorPotencia||1;
  var consumidores=((tot.consT1+tot.consT2)*r.kvas)/fp;
  var iluminacao=tot.lumT1*ctx.potLum1 + tot.lumT2*ctx.potLum2;
  var diurna=cortar(consumidores+tot.cargaEspecial,ctx.funcao,ctx.casas);
  var noturna=cortar(diurna+iluminacao,ctx.funcao,ctx.casas);
  return {totais:tot, grupo:r.grupo, kvas:r.kvas,
          diurna:diurna, noturna:noturna, iluminacao:iluminacao,
          demanda:noturna, ctx:ctx, pontos:r.pontos};
}

/* Menor transformador que comporta a demanda.

   KVAT = fator × KVAN é a potência admissível. O fator vem do tipo de
   empreendimento e pode ser sobrescrito na folha de dados. */
function dimensionarTrafo(demanda,tipoEmpreendimento,fatorObra){
  var t=S.cat.trafos; if(!t||!demanda) return null;
  var fator=Number(fatorObra)||fatorCarregamento({tipoEmpreendimento:tipoEmpreendimento});
  var escolhido=null;
  (t.items||[]).forEach(function(x){
    var max=x.nominal*fator;
    if(escolhido===null&&demanda<=max) escolhido={nominal:x.nominal,maximo:max,fator:fator};
  });
  return escolhido;
}

/* Carregamento do transformador em %: demanda sobre a potência admissível. */
function carregamentoTrafo(demanda,nominal,fator){
  var f=Number(fator)||1.5, n=Number(nominal)||0;
  if(!n||!demanda) return null;
  var kvat=n*f;
  return {kvat:kvat, percentual:demanda/kvat*100, fator:f};
}

/* Corrente de linha do transformador, em ampères. */
function correnteTrafo(demanda,tensaoFF){
  var v=Number(tensaoFF)||0;
  if(!v||!demanda) return null;
  return demanda*1000/(Math.sqrt(3)*v);
}

/* Quantidade máxima de consumidores que o transformador comporta.
   Na planilha é "Qtd. Max. Cons. TP1": é o total, não o que ainda sobra.

   Como a demanda do grupo é A × (N × kWh)^B, o limite sai invertendo a conta
   em vez de dividir a sobra pela demanda de um consumidor: aquela divisão só
   valia quando a demanda por consumidor era fixa. */
function maxConsumidoresT1(obra,trafoId,potenciaNominal){
  var d=demandaTrafo(obra,trafoId), ctx=d.ctx;
  var fator=ctx.fatorCarreg;
  var max=potenciaNominal?Number(potenciaNominal)*fator
                         :(function(){ var a=dimensionarTrafo(d.demanda,obra.tipoEmpreendimento,fator);
                                       return a?a.maximo:null; })();
  if(!max||!ctx.constA||!ctx.constB||!ctx.kwh1) return null;
  var fp=ctx.fatorPotencia||1;
  var livre=max - d.totais.cargaEspecial - d.totais.lumT1*ctx.potLum1 - d.totais.lumT2*ctx.potLum2;
  if(livre<=0) return 0;
  var kwhMax=Math.pow(livre*fp/ctx.constA,1/ctx.constB);
  return Math.max(0,Math.floor(kwhMax/ctx.kwh1));
}

/* ==========================================================================
   FOLHA DE DADOS — esquema e regras
   ========================================================================== */
var FD=[
 {id:"cliente",titulo:"Dados do cliente",campos:[
  {k:"tipoPessoa",l:"Tipo de pessoa",req:1,w:1,tipo:"select",ops:["Jurídica","Física"],
   nota:"Define se o cliente é identificado por CNPJ ou por CPF."},
  {k:"cliente",fmt:"titulo",l:"Cliente",req:1,w:3},
  {k:"cnpj",fmt:"cnpj",l:"CNPJ",req:1,w:2,val:okCNPJ,msg:"CNPJ inválido",
   verSe:function(o){ return o.tipoPessoa!=="Física"; }},
  {k:"cpfCliente",fmt:"cpf",l:"CPF do cliente",req:1,w:2,val:okCPF,msg:"CPF inválido",
   verSe:function(o){ return o.tipoPessoa==="Física"; }},
  {k:"rgCliente",l:"RG do cliente",w:1,verSe:function(o){ return o.tipoPessoa==="Física"; }},
  {k:"nacCliente",fmt:"titulo",l:"Nacionalidade",w:1,verSe:function(o){ return o.tipoPessoa==="Física"; }},
  {k:"ecCliente",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"],
   verSe:function(o){ return o.tipoPessoa==="Física"; }},
  {k:"profCliente",fmt:"titulo",l:"Profissão",w:2,verSe:function(o){ return o.tipoPessoa==="Física"; }},
  {k:"codigoObra",l:"Código da obra",w:1},
  {k:"rua",fmt:"titulo",l:"Rua",req:1,w:3},{k:"numero",l:"Nº",req:1,w:1},{k:"bairro",fmt:"titulo",l:"Bairro",req:1,w:2},
  {k:"municipioCli",l:"Município",req:1,w:3,tipo:"municipio"},
  {k:"ufCli",fmt:"maiuscula",l:"UF",w:1,ro:1,drv:"Preenchida pelo município"},
  {k:"cepCli",fmt:"cep",l:"CEP",req:1,w:2,val:okCEP,msg:"CEP deve ter 8 dígitos"},
  {k:"emailNfe",fmt:"minuscula",l:"E-mail para envio de NF-e",req:1,w:3,val:okEmail,msg:"E-mail inválido"},
  {k:"respConcess",fmt:"titulo",l:"Responsável pelo cliente junto à concessionária",req:1,w:3},
  {k:"cpfResp",fmt:"cpf",l:"CPF do responsável",req:1,w:2,val:okCPF,msg:"CPF inválido"},
  {k:"rep1",fmt:"titulo",l:"Representante legal 1",req:1,w:2,pj:1},{k:"nac1",fmt:"titulo",l:"Nacionalidade",w:2,pj:1},
  {k:"ec1",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"],pj:1},
  {k:"rg1",l:"RG",w:2,pj:1},{k:"cpf1",fmt:"cpf",l:"CPF",w:2,val:okCPF,msg:"CPF inválido",pj:1},
  {k:"rep2",fmt:"titulo",l:"Representante legal 2",w:2,pj:1},{k:"nac2",fmt:"titulo",l:"Nacionalidade",w:2,pj:1},
  {k:"ec2",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"],pj:1},
  {k:"rg2",l:"RG",w:2,pj:1},{k:"cpf2",fmt:"cpf",l:"CPF",w:2,val:okCPF,msg:"CPF inválido",pj:1},
  {k:"testCli",fmt:"titulo",l:"Testemunha da contratante",w:2},{k:"rgTestCli",l:"RG",w:2},
  {k:"cpfTestCli",fmt:"cpf",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"}
 ]},
 {id:"obra",titulo:"Dados da obra",campos:[
  {k:"empreendimento",fmt:"titulo",l:"Nome do empreendimento",req:1,w:4},
  {k:"dataEnergizacao",l:"Data prevista para energização",req:1,w:2,tipo:"date"},
  {k:"municipio",l:"Município da obra",req:1,w:3,tipo:"municipio",
   nota:"Define a concessionária, as constantes A e B, a tensão primária e a classe de tensão."},
  {k:"uf",fmt:"maiuscula",l:"UF",w:1,ro:1,drv:"Preenchida pelo município"},
  {k:"bairroObra",fmt:"titulo",l:"Bairro",req:1,w:2},
  {k:"cepObra",fmt:"cep",l:"CEP",req:1,w:2,val:okCEP,msg:"CEP deve ter 8 dígitos"},
  {k:"tipoEmpreendimento",l:"Tipo de empreendimento",req:1,w:2,tipo:"select",ops:["Loteamento","Núcleo habitacional"]},
  {k:"respIP",l:"Responsável pelo consumo da iluminação pública",req:1,w:2,tipo:"select",ops:["Prefeitura","Condomínio","Cliente"]},
  {k:"oficioPrefeitura",l:"Já existe ofício da prefeitura?",w:2,tipo:"select",ops:["Sim","Não"],
   reqSe:function(o){return o.respIP==="Prefeitura";},nota:"Obrigatório quando a iluminação pública é da prefeitura."}
 ]},
 {id:"projeto",titulo:"Dados do projeto",campos:[
  {k:"concessionaria",l:"Concessionária",w:2,ro:1,drv:"Preenchida pelo município da obra"},
  {k:"regional",fmt:"titulo",l:"Regional",req:1,w:2},
  {k:"tipoProjeto",l:"Tipo de projeto",req:1,w:6,tipo:"select",ops:[
    "Rede de distribuição aérea primária e secundária com iluminação pública",
    "Rede de distribuição aérea primária e secundária sem iluminação pública",
    "Rede de distribuição subterrânea",
    "Somente cálculo de esforço mecânico",
    "Cálculo de esforço mecânico + lista de materiais"]},
  {k:"gedKvas",l:"Tabela para cálculo do kVA",req:1,w:3,tipo:"select",
   ops:["Anexo 1 — Previsão de consumo (kWh) por tipo de empreendimento"]},
  {k:"caboPrimario",l:"Cabo principal da rede primária",req:1,w:2,tipo:"select",ops:["E70","E50","E35","CA 1/0","CA 4/0"]},
  {k:"caboSecundario",l:"Cabo padrão da rede secundária",req:1,w:2,tipo:"cabo",
   nota:"Usado no cálculo de queda de tensão quando o trecho não indicar outra bitola."},
  {k:"vaoBasico",l:"Vão básico entre postes (m)",req:1,w:1,tipo:"number",min:20,max:60,
   val:function(v){return v>=20&&v<=60;},msg:"Entre 20 e 60 m"},
  {k:"lotesT1",l:"Tamanho médio dos lotes tipo 1 (m²)",req:1,w:2,tipo:"number",min:1},
  {k:"atividadeT1",l:"Tipo de empreendimento do consumidor tipo 1",req:1,w:2,tipo:"atividade"},
  {k:"ligacaoT1",l:"Ligação do consumidor tipo 1",req:1,w:1,tipo:"ligacao"},
  {k:"qtdT1",l:"Quantidade de consumidores tipo 1",req:1,w:1,tipo:"number",min:1},
  {k:"lotesT2",l:"Tamanho médio dos lotes tipo 2 (m²)",w:2,tipo:"number",reqSe:function(o){return Number(o.qtdT2)>0;}},
  {k:"atividadeT2",l:"Tipo de empreendimento do consumidor tipo 2",w:2,tipo:"atividade",reqSe:function(o){return Number(o.qtdT2)>0;}},
  {k:"ligacaoT2",l:"Ligação do consumidor tipo 2",w:1,tipo:"ligacao",reqSe:function(o){return Number(o.qtdT2)>0;}},
  {k:"qtdT2",l:"Quantidade de consumidores tipo 2",w:1,tipo:"number",min:0,
   nota:"Deixe zero quando não houver segundo tipo de consumidor."},
  {k:"lotesTotais",l:"Quantidade total de lotes do empreendimento",w:2,tipo:"number",min:0,
   nota:"Todos os lotes do loteamento, inclusive os que não entram nesta obra."},
  {k:"lotesExistentes",l:"Lotes já atendidos pela rede existente",w:2,tipo:"number",min:0,
   nota:"Lotes que já recebem energia pela rede da concessionária."},
  {k:"consumidoresEspeciais",l:"Consumidores especiais (portaria, clube, administração, salão de festas)",w:6,tipo:"textarea",
   nota:"Quantificar e descrever cada tipo. Deixar em branco se não houver."},
  {k:"luminaria",l:"Luminária tipo 1",req:1,w:3,tipo:"luminaria",
   nota:"Modelo e consumo conforme a tabela da concessionária."},
  {k:"luminaria2",l:"Luminária tipo 2",w:3,tipo:"luminaria",
   nota:"Preencher apenas quando o projeto usar um segundo modelo."},
  {k:"respProjeto",fmt:"titulo",l:"Responsabilidade do projeto",w:3},
  {k:"numeroProjeto",l:"Número do projeto",w:2},{k:"trt",l:"TRT",w:2},
  {k:"refEletricas",l:"Referências elétricas",w:2},{k:"numAtividade",l:"Número da atividade",w:2},
  {k:"viabilidade",l:"Viabilidade aprovada em",w:2,tipo:"date"},
  {k:"atividadeCancelar",l:"Atividade a ser cancelada",w:2},
  {k:"ramal1",l:"Ramal subterrâneo 01",w:3},{k:"ramal2",l:"Ramal subterrâneo 02",w:3},
  {k:"ramal3",l:"Ramal subterrâneo 03",w:3},{k:"ramal4",l:"Ramal subterrâneo 04",w:3},
  {k:"impressao",l:"Impressão",w:2,tipo:"select",ops:["Folha timbrada","Folha sem timbre"]}
 ]},
 {id:"empreiteira",titulo:"Dados da empreiteira",campos:[
  {k:"empreiteira",fmt:"titulo",l:"Empreiteira",req:1,w:3},
  {k:"cnpjEmp",fmt:"cnpj",l:"CNPJ",req:1,w:2,val:okCNPJ,msg:"CNPJ inválido"},
  {k:"conselhoEmp",l:"Conselho",w:1,tipo:"select",ops:["CREA","CAU","CFT"],
   nota:"CREA para nível superior, CAU para arquitetura e urbanismo, CFT para técnico industrial."},
  {k:"registroEmp",fmt:"maiuscula",l:"Registro no conselho",w:2,reqSe:function(o){ return !!o.conselhoEmp; }},
  {k:"ieEmp",fmt:"ie",l:"Inscrição estadual",w:2},
  {k:"ruaEmp",fmt:"titulo",l:"Rua",w:3},{k:"numEmp",l:"Nº",w:1},
  {k:"bairroEmp",fmt:"titulo",l:"Bairro",w:2},{k:"munEmp",l:"Município",w:3,tipo:"municipio"},
  {k:"ufEmp",fmt:"maiuscula",l:"UF",w:1,ro:1,drv:"Preenchida pelo município"},
  {k:"cepEmp",fmt:"cep",l:"CEP",w:2,val:okCEP,msg:"CEP deve ter 8 dígitos"},
  {k:"contatoEmp",fmt:"titulo",l:"Contato",w:2},{k:"cpfContato",fmt:"cpf",l:"CPF do contato",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"telEmp",fmt:"telefone",l:"Telefone(s)",w:2},
  {k:"emailEmp",fmt:"minuscula",l:"E-mail para contato",w:3,val:okEmail,msg:"E-mail inválido"},
  {k:"responsavelEmp",fmt:"titulo",l:"Responsável",w:3},{k:"nacEmp",fmt:"titulo",l:"Nacionalidade",w:2},
  {k:"ecEmp",l:"Estado civil",w:2,tipo:"select",ops:["Solteiro(a)","Casado(a)","Divorciado(a)","Viúvo(a)","União estável"]},
  {k:"rgEmp",l:"RG",w:1},{k:"orgaoEmp",l:"Órgão expedidor",w:1},
  {k:"cpfEmp",fmt:"cpf",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"testEmp",fmt:"titulo",l:"Testemunha da contratada",w:2},{k:"rgTestEmp",l:"RG",w:2},
  {k:"cpfTestEmp",fmt:"cpf",l:"CPF",w:2,val:okCPF,msg:"CPF inválido"},
  {k:"respTecnico",fmt:"titulo",l:"Responsável técnico",req:1,w:3},
  {k:"conselhoRT",l:"Conselho do responsável técnico",req:1,w:1,tipo:"select",ops:["CREA","CAU","CFT"]},
  {k:"registroRT",fmt:"maiuscula",l:"Registro no conselho",req:1,w:2}
 ]},
 {id:"parametros",titulo:"Parâmetros de cálculo",campos:[
  {k:"qtMaxSec",l:"Queda de tensão máxima na rede secundária (%)",req:1,w:2,tipo:"number",step:"0.1",
   val:function(v){return v>0&&v<=10;},msg:"Entre 0 e 10 %",nota:"Limite usado na conferência de queda de tensão."},
  {k:"qtMaxIP",l:"Queda de tensão máxima na rede de iluminação pública (%)",req:1,w:2,tipo:"number",step:"0.1",
   val:function(v){return v>0&&v<=10;},msg:"Entre 0 e 10 %"},
  {k:"funcaoArred",l:"Função para corte de casas decimais",req:1,w:2,tipo:"select",
   ops:["ARRED","ARREDONDAR.PARA.CIMA","ARREDONDAR.PARA.BAIXO","TRUNCAR"]},
  {k:"casasDecimais",l:"Nº de casas decimais para a queda de tensão",req:1,w:2,tipo:"number",min:0,max:6,
   val:function(v){return v>=0&&v<=6;},msg:"Entre 0 e 6"},
  {k:"fatorCarreg",l:"Fator de carregamento do transformador (KVAT = fator × KVAN)",w:2,tipo:"number",step:"0.001",
   val:function(v){return v>0&&v<=3;},msg:"Entre 0 e 3",
   nota:"Em branco usa o fator do tipo de empreendimento. Núcleo habitacional 1,5 e loteamento 1,875 na planilha de origem."},
  {k:"demandaExistente",l:"Demanda existente (kVA)",w:2,tipo:"number",step:"0.01",min:0,
   nota:"Carga já atendida pela rede da concessionária. Sai no rodapé do relatório de queda."}
 ]}
];
var PADROES={qtMaxSec:3.5,qtMaxIP:6,funcaoArred:"ARRED",casasDecimais:2,vaoBasico:35,qtdT2:0,
  tipoPessoa:"Jurídica",
  gedKvas:"Anexo 1 — Previsão de consumo (kWh) por tipo de empreendimento",
  impressao:"Folha timbrada"};

function obrigatorio(c,o){ if(!visivel(c,o)) return false; if(c.req) return true; if(c.reqSe) return !!c.reqSe(o); return false; }
/* Campo que só aparece em certas condições. "pj" marca os campos que só fazem
   sentido para pessoa jurídica, como os representantes legais. */
function visivel(c,o){
  if(c.pj&&o&&o.tipoPessoa==="Física") return false;
  return c.verSe?!!c.verSe(o):true;
}
function validarObra(o){
  var errs=[];
  FD.forEach(function(s){ s.campos.forEach(function(c){
    if(!visivel(c,o)) return;
    var v=o[c.k], vazio=(v===undefined||v===null||String(v).trim()==="");
    if(obrigatorio(c,o)&&vazio){ errs.push({sec:s.id,secT:s.titulo,k:c.k,l:c.l,tipo:"obrigatorio",msg:"Campo obrigatório não preenchido"}); return; }
    if(valorOrfao(c,v)){
      errs.push({sec:s.id,secT:s.titulo,k:c.k,l:c.l,tipo:"orfao",
        msg:'"'+v+'" não existe mais na lista. Escolha um valor atual.'});
      return;
    }
    if(!vazio&&c.val&&!c.val(c.tipo==="number"?Number(v):v))
      errs.push({sec:s.id,secT:s.titulo,k:c.k,l:c.l,tipo:"formato",msg:c.msg||"Valor inválido"});
  });});
  [["T1","lotesT1","atividadeT1","ligacaoT1","tipo 1"],["T2","lotesT2","atividadeT2","ligacaoT2","tipo 2"]].forEach(function(t){
    var ativ=o[t[2]], lig=o[t[3]], lote=Number(o[t[1]]);
    if(t[0]==="T2"&&!(Number(o.qtdT2)>0)) return;
    var defAtiv=null, defLig=null;
    FD.forEach(function(s){ s.campos.forEach(function(c){ if(c.k===t[2]) defAtiv=c; if(c.k===t[3]) defLig=c; }); });
    var orfaoA=valorOrfao(defAtiv,ativ), orfaoL=valorOrfao(defLig,lig);
    if(orfaoA||orfaoL) return; // já sinalizado como valor fora da lista
    if(!ativ||!lig) return;
    if(consumoAnexo1(ativ,lig)===null)
      errs.push({sec:"projeto",secT:"Dados do projeto",k:t[3],l:"Ligação do consumidor "+t[4],tipo:"formato",
        msg:"O Anexo 1 não prevê "+nomeLigacao(lig).toLowerCase()+" para esse tipo de empreendimento"});
    var def=tipoAnexo1(ativ);
    if(def&&def.faixa&&lote>0){
      if(def.faixa==="ate500"&&lote>500)
        errs.push({sec:"projeto",secT:"Dados do projeto",k:t[1],l:"Tamanho médio dos lotes "+t[4],tipo:"coerencia",
          msg:"Lote de "+num(lote)+" m² com faixa de até 500 m² selecionada"});
      if(def.faixa==="acima500"&&lote<=500)
        errs.push({sec:"projeto",secT:"Dados do projeto",k:t[1],l:"Tamanho médio dos lotes "+t[4],tipo:"coerencia",
          msg:"Lote de "+num(lote)+" m² com faixa acima de 500 m² selecionada"});
    }
  });
  [["registroEmp","conselhoEmp","da empreiteira"],["registroRT","conselhoRT","do responsável técnico"]].forEach(function(t){
    if(o[t[0]]&&!o[t[1]])
      errs.push({sec:"empreiteira",secT:"Dados da empreiteira",k:t[1],l:"Conselho "+t[2],tipo:"formato",
        msg:"Informe a qual conselho o registro pertence"});
  });
  if(Number(o.qtdT1)>0&&Number(o.lotesT1)>0&&Number(o.lotesT1)<50)
    errs.push({sec:"projeto",secT:"Dados do projeto",k:"lotesT1",l:"Tamanho médio dos lotes tipo 1",
      tipo:"coerencia",msg:"Lote menor que 50 m² — confirmar com o responsável técnico"});
  if(o.qtMaxSec&&o.qtMaxIP&&Number(o.qtMaxIP)<Number(o.qtMaxSec))
    errs.push({sec:"parametros",secT:"Parâmetros de cálculo",k:"qtMaxIP",l:"Queda máxima na iluminação pública",
      tipo:"coerencia",msg:"Normalmente o limite da iluminação pública é maior que o da rede secundária"});
  return errs;
}
function totalCampos(o){
  var n=0;
  FD.forEach(function(s){ s.campos.forEach(function(c){ if(!o||visivel(c,o)) n++; }); });
  return n;
}
// A cinta é o menor múltiplo de 10 mm que acomoda o diâmetro, com folga de 5 mm.
function cintaPara(diametro){ return Math.ceil((diametro-5)/10)*10; }
var QTD_PONTOS=10;
// Diâmetro e cinta em cada ponto de fixação declarado para a bitola.
function pontosDe(r){
  var out=[];
  for(var i=0;i<QTD_PONTOS;i++){
    var d=(r.distancias||[])[i];
    if(d===null||d===undefined||d===""){ out.push({n:i+1,d:null}); continue; }
    d=Number(d);
    var dia=r.diamTopo+d*r.conicidade;
    out.push({n:i+1,d:d,diametro:Number(dia.toFixed(1)),cinta:cintaPara(dia),
              fora:d>r.altura*1000});
  }
  return out;
}
function recalcularBitola(r){
  var altura=Number(r.altura)||0, topo=Number(r.diamTopo)||0, base=Number(r.diamBase)||0;
  r.conicidade = altura>0 ? Number(((base-topo)/(altura*1000)).toFixed(5)) : 0;
  r.maxDist = altura*1000;
  var faixas=[], atual=null;
  for(var d=0; d<=altura*1000; d+=10){
    var dia=topo+d*r.conicidade, c=cintaPara(dia);
    if(!atual||atual.cinta!==c){ atual={cinta:c,de:Number(dia.toFixed(1)),ate:Number(dia.toFixed(1))}; faixas.push(atual); }
    else atual.ate=Number(dia.toFixed(1));
  }
  r.faixas=faixas;
  return r;
}
function anexo1Tipos(){ return items("anexo1"); }
function anexo1Ligacoes(){ return (S.cat.anexo1&&S.cat.anexo1.ligacoes)||[]; }
function tipoAnexo1(nome){ var r=null; anexo1Tipos().forEach(function(x){ if(x.tipo===nome) r=x; }); return r; }
// Consumo estimado em kWh/mês. Sem valor quando a combinação não existe no Anexo 1.
function consumoAnexo1(tipo,ligacao){
  var t=tipoAnexo1(tipo);
  if(!t||!ligacao) return null;
  var v=t.consumo[ligacao];
  return (v===undefined)?null:v;
}
function nomeLigacao(cod){ var n=cod; anexo1Ligacoes().forEach(function(l){ if(l.codigo===cod) n=l.nome; }); return n; }
function contarMunicipios(nome){ var n=0; items("municipios").forEach(function(m){ if(m.concessionaria===nome) n++; }); return n; }
function concessionariaInfo(nome){ var l=items("concessionarias"); for(var i=0;i<l.length;i++) if(l[i].nome===nome) return l[i]; return null; }
// As constantes A e B pertencem à concessionária. O município só aponta para ela.
function constantesDe(municipio){
  var c=municipio&&concessionariaInfo(municipio.concessionaria);
  return c?{constA:c.constA,constB:c.constB}:{constA:null,constB:null};
}
function municipioInfo(nome){
  var l=items("municipios");
  for(var i=0;i<l.length;i++) if(l[i].municipio===nome) return Object.assign({},l[i],constantesDe(l[i]));
  return null;
}

/* ==========================================================================
   CARGA
   ========================================================================== */
// Obras gravadas quando o campo era só "CFT", antes de virar conselho + registro.
function migrarConselho(o){
  if(o.cftEmp&&!o.registroEmp){ o.conselhoEmp=o.conselhoEmp||"CFT"; o.registroEmp=String(o.cftEmp).toUpperCase(); }
  if(o.cftRT&&!o.registroRT){ o.conselhoRT=o.conselhoRT||"CFT"; o.registroRT=String(o.cftRT).toUpperCase(); }
  delete o.cftEmp; delete o.cftRT;
  return o;
}
async function carregar(){
  try{
    var d=await Store.carregar();
    S.cat=d.catalogos||{}; S.obras=(d.obras||[]).map(migrarConselho); S.usuarios=d.usuarios||[];
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
   {r:"anexo1",l:"Anexo 1 — consumo",c:"anexo1"},
   {r:"ged",l:"GED aplicável",c:"ged"},
   {r:"ged3738",l:"GED 3738 (anterior)",c:"ged3738"},
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
  ABAS_OBRA.forEach(function(x){ if(x.r===S.route) t=x.l; });
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
  S.rascunho=sincronizarDerivados(JSON.parse(JSON.stringify(o)));
  S.original=JSON.stringify(S.rascunho);
  S.salvoEm=null;
  S.route="folha";
}
/* Campos que não se digitam: saem do município escolhido. Derivados na abertura
   e antes de cada gravação, para que uma obra vinda do banco nunca mostre vazio
   um valor que o cadastro já sabe. */
function sincronizarDerivados(o){
  if(!o) return o;
  var m=municipioInfo(o.municipio);
  if(m){ o.uf=m.uf; o.concessionaria=m.concessionaria; }
  var mc=municipioInfo(o.municipioCli); if(mc) o.ufCli=mc.uf;
  var me=municipioInfo(o.munEmp);       if(me) o.ufEmp=me.uf;
  return o;
}
function emObra(){ return S.route==="folha"||S.route==="topologia"||S.route==="queda"; }
function marcarSujo(){
  var bar=document.querySelector(".salvabar");
  if(bar&&!bar.classList.contains("sujo")){
    bar.classList.add("sujo");
    bar.querySelector(".estado").innerHTML='<span class="ponto"></span>Alterações não salvas';
    bar.querySelectorAll("button").forEach(function(b){ b.disabled=false; });
  }
}
function folhaAlterada(){ return !!S.rascunho && JSON.stringify(S.rascunho)!==S.original; }
function fecharFolha(){ S.rascunho=null; S.original=""; S.salvoEm=null; }
async function salvarFolha(){
  if(!S.rascunho||S.salvando) return true;
  S.salvando=true;
  try{
    S.rascunho.revisoes=revisoesAtuais();
    sincronizarDerivados(S.rascunho);
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
  var bg=modal("Alterações não salvas",
    "<p>Esta obra tem alterações que ainda não foram gravadas.</p>",
    async function(){ if(await salvarFolha()){ fecharFolha(); depois(); return true; } return false; },
    "Salvar e sair");
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
    "<th>Concessionária</th><th>Energização</th><th>Consistência</th><th>Base normativa</th><th>Atualizada</th><th></th></tr></thead><tbody>";
  S.obras.slice().sort(function(a,b){ return (b.atualizadoEm||"").localeCompare(a.atualizadoEm||""); }).forEach(function(o){
    var e=validarObra(o), pr=Math.round((1-e.length/totalCampos(o))*100);
    h+="<tr><td><strong>"+esc(o.empreendimento||"(sem nome)")+"</strong></td><td>"+esc(o.cliente||"—")+"</td><td>"+
      esc(o.municipio||"—")+"</td><td>"+esc(o.concessionaria||"—")+'</td><td class="num">'+
      (o.dataEnergizacao?esc(o.dataEnergizacao.split("-").reverse().join("/")):"—")+"</td><td>"+
      (e.length?'<span class="chip bad">'+e.length+" pendente"+(e.length>1?"s":"")+"</span>":'<span class="chip ok">completa '+pr+"%</span>")+
      "</td><td>"+(function(){ var f=revisoesDefasadas(o);
        if(!o.revisoes) return '<span class="pill">não carimbada</span>';
        return f.length?'<span class="chip warn">'+f.length+" desatualizada"+(f.length>1?"s":"")+"</span>":'<span class="chip ok">em dia</span>'; })()+
      '</td><td class="num" style="color:var(--muted);font-size:12px">'+fmtDT(o.atualizadoEm)+
      '</td><td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-obra="'+esc(o._id)+'">Abrir</button>'+
      (can("obra.edit")?' <button class="btn danger sm" data-del-obra="'+esc(o._id)+'">Excluir</button>':"")+"</td></tr>";
  });
  return h+'</tbody></table></div><div class="tbl-foot"><span>'+S.obras.length+" obra"+(S.obras.length>1?"s":"")+"</span></div></div>";
}

// Opções válidas de um campo de seleção, na forma [valor, rótulo].
function opcoesDe(c){
  if(c.tipo==="municipio") return items("municipios").map(function(m){ return [m.municipio, m.municipio+" / "+m.uf]; });
  if(c.tipo==="atividade") return anexo1Tipos().map(function(a){ return [a.tipo, a.tipo]; });
  if(c.tipo==="ligacao") return anexo1Ligacoes().map(function(l){ return [l.codigo, l.nome]; });
  if(c.tipo==="luminaria") return items("luminarias").map(function(x){
    return [x.modelo, x.modelo+(x.consumo?" · "+num(x.consumo,3)+" kVA":"")+(x.tipo?" · "+x.tipo:"")]; });
  if(c.tipo==="cabo") return items("cabos_qt").filter(function(x){ return x.coef["380_1"]!==null; })
    .map(function(x){ return [x.bitola, x.bitola+" "+x.unidade+" · "+num(x.amperagem)+" A"]; });
  if(c.tipo==="select") return (c.ops||[]).map(function(x){ return [x,x]; });
  return null;
}
// Valor gravado que saiu da lista, por troca de tabela ou de cadastro.
// Município é lista aberta: o cliente pode ser de qualquer região, então um
// nome fora do cadastro é aceito — só não traz constante nenhuma.
function valorOrfao(c,v){
  if(c.tipo==="municipio") return false;
  if(v===undefined||v===null||String(v).trim()==="") return false;
  var ops=opcoesDe(c);
  if(!ops||!ops.length) return false;
  return !ops.some(function(par){ return String(par[0])===String(v); });
}
/* Data em AAAA-MM-DD vira dd/mm/aaaa para digitação, e volta na gravação. */
function dataBR(iso){
  var m=String(iso||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m?m[3]+"/"+m[2]+"/"+m[1]:(iso||"");
}
function dataISO(br){
  var s=String(br||"").trim();
  var m=s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(!m) return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:"";
  var d=Number(m[1]), mes=Number(m[2]), a=Number(m[3]);
  if(d<1||d>31||mes<1||mes>12) return "";
  return m[3]+"-"+m[2]+"-"+m[1];
}
/* Vai pondo as barras enquanto o usuário digita os números. */
function mascaraData(v){
  var d=String(v||"").replace(/\D/g,"").slice(0,8);
  if(d.length<=2) return d;
  if(d.length<=4) return d.slice(0,2)+"/"+d.slice(2);
  return d.slice(0,2)+"/"+d.slice(2,4)+"/"+d.slice(4);
}

function campoHTML(c,o,errs){
  var err=null; errs.forEach(function(e){ if(e.k===c.k) err=e; });
  var v=o[c.k]===undefined||o[c.k]===null?"":o[c.k];
  var req=obrigatorio(c,o);
  var dis=(!can("obra.edit")||c.ro)?" disabled":"";
  var inner;
  /* Município é lista aberta: sugere os cadastrados, mas aceita qualquer nome,
     porque há cliente de região que ainda não está na base. */
  if(c.tipo==="municipio"){
    var lista="mun-"+c.k;
    inner='<input type="text" list="'+lista+'" data-k="'+c.k+'" value="'+esc(v)+'" autocomplete="off"'+dis+'>'+
      '<datalist id="'+lista+'">'+items("municipios").map(function(m){
        return '<option value="'+esc(m.municipio)+'">'+esc(m.municipio+" / "+m.uf)+"</option>"; }).join("")+"</datalist>";
  } else if(c.tipo==="select"||c.tipo==="atividade"||c.tipo==="ligacao"||c.tipo==="luminaria"||c.tipo==="cabo"){
    var ops=[];
    var pares=opcoesDe(c)||[];
    var orfao=valorOrfao(c,v);
    inner='<select data-k="'+c.k+'"'+dis+'>'+
      (orfao?'<option value="'+esc(v)+'" selected>'+esc(v)+" (fora da lista atual)</option>":"")+
      '<option value=""'+(!orfao&&!v?" selected":"")+">—</option>"+
      pares.map(function(par){
        return '<option value="'+esc(par[0])+'"'+(String(v)===String(par[0])?" selected":"")+">"+esc(par[1])+"</option>"; }).join("")+"</select>";
  } else if(c.tipo==="textarea"){
    inner='<textarea data-k="'+c.k+'" rows="2"'+dis+">"+esc(v)+"</textarea>";
  } else {
    var t=c.tipo==="number"?"number":(c.tipo==="date"?"date":"text");
    /* A data vai como texto com máscara, para poder ser digitada direto.
       O valor continua gravado em AAAA-MM-DD. */
    if(c.tipo==="date")
      inner='<input type="text" data-k="'+c.k+'" data-data="1" value="'+esc(dataBR(v))+
        '" placeholder="dd/mm/aaaa" inputmode="numeric" maxlength="10" autocomplete="off"'+dis+">";
    else
      inner='<input type="'+t+'" data-k="'+c.k+'" value="'+esc(v)+'"'+
        (c.step?' step="'+c.step+'"':"")+(c.min!==undefined?' min="'+c.min+'"':"")+(c.max!==undefined?' max="'+c.max+'"':"")+dis+">";
  }
  return '<div class="fld c'+(c.w||2)+(err?" bad":"")+'"><label>'+esc(c.l)+(req?'<span class="req">*</span>':"")+"</label>"+inner+
    (err?'<div class="err">'+esc(err.msg)+"</div>":"")+
    (c.drv?'<div class="drv">'+esc(c.drv)+"</div>":"")+
    (c.nota&&!err?'<div class="drv">'+esc(c.nota)+"</div>":"")+"</div>";
}

/* Cabeçalho comum das telas de uma obra: título, abas e barra de gravação. */
var ABAS_OBRA=[{r:"folha",l:"Folha de dados"},{r:"topologia",l:"Vãos entre pontos"},{r:"queda",l:"Queda de tensão"}];
function cabecalhoObra(o,desc){
  var h='<div class="phead"><div><h2>'+esc(o.empreendimento||"Nova obra")+"</h2>"+
    '<p class="desc">'+esc(desc)+"</p></div>"+
    '<div class="actions"><button class="btn ghost" id="btnVoltar">Voltar para obras</button></div></div>';
  h+='<div class="tabs">'+ABAS_OBRA.map(function(a){
    return '<button data-aba="'+a.r+'" class="'+(S.route===a.r?"on":"")+'">'+esc(a.l)+"</button>"; }).join("")+"</div>";
  var sujo=folhaAlterada();
  h+='<div class="salvabar'+(sujo?" sujo":"")+'"><div class="estado">'+
    (sujo?'<span class="ponto"></span>Alterações não salvas'
        :(S.salvoEm?'<span class="ok">✓</span>Salvo às '+S.salvoEm.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})
                   :'<span class="ok">✓</span>Sem alterações pendentes'))+
    '</div><div class="acoes">'+
    '<button class="btn ghost sm" id="btnDescartar"'+(sujo?"":" disabled")+'>Descartar</button>'+
    '<button class="btn" id="btnSalvar"'+(sujo&&can("obra.edit")?"":" disabled")+'>'+
    (S.salvando?"Salvando…":"Salvar")+'</button></div></div>';
  return h;
}

function viewFolha(){
  var o=S.rascunho;
  if(!o) return '<div class="empty"><h4>Obra não encontrada</h4></div>';
  var errs=validarObra(o), tot=totalCampos(o);
  var preench=tot-errs.filter(function(e){ return e.tipo==="obrigatorio"; }).length;
  var pct=Math.round(preench/tot*100);
  var mi=municipioInfo(o.municipio);

  var h=cabecalhoObra(o,"Folha de dados do cliente, da obra, do projeto e da empreiteira.");

  h+='<div class="consist'+(errs.length?" bad":"")+'"><div><strong>'+
    (errs.length?errs.length+" ponto"+(errs.length>1?"s":"")+" a resolver":"Folha consistente")+"</strong>"+
    '<div class="note">'+(errs.length?"Resolva os pontos abaixo antes de seguir para o cálculo.":
      "Todos os campos obrigatórios estão preenchidos e nos formatos esperados.")+"</div></div>"+
    '<div class="bar"><i style="width:'+pct+'%"></i></div><span class="mono" style="font-size:12px">'+pct+"%</span></div>";

  var fora=revisoesDefasadas(o);
  if(fora.length){
    h+='<div class="panel aviso-rev" style="margin-bottom:14px"><div class="panel-h"><div>'+
      "<h3>Base normativa desatualizada</h3>"+
      '<p class="sub">Esta obra foi gravada sobre revisões que deixaram de ser as vigentes. Confira se o cálculo precisa ser refeito.</p></div></div>'+
      '<div class="tbl-wrap"><table><thead><tr><th>Tabela</th><th>Revisão usada na obra</th><th>Revisão vigente</th></tr></thead><tbody>'+
      fora.map(function(f){ return "<tr><td>"+esc(NOME_TABELA[f.chave]||f.chave)+'</td><td class="mono">'+esc(f.usada)+
        '</td><td class="mono" style="color:var(--warn)">'+esc(f.atual)+"</td></tr>"; }).join("")+
      "</tbody></table></div></div>";
  }

  if(errs.length){
    h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><h3>Pendências</h3></div>'+
      '<div class="panel-b" style="display:flex;flex-wrap:wrap;gap:7px">'+
      errs.map(function(e){ return '<span class="chip '+(e.tipo==="coerencia"||e.tipo==="orfao"?"warn":"bad")+'">'+esc(e.l)+" — "+esc(e.msg)+"</span>"; }).join("")+
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
  var temOrfao=errs.some(function(e){ return e.tipo==="orfao"; });
  var c1=consumoAnexo1(o.atividadeT1,o.ligacaoT1), c2=consumoAnexo1(o.atividadeT2,o.ligacaoT2);
  if((o.atividadeT1||o.atividadeT2)&&!temOrfao){
    var linhas=[["Consumidor tipo 1",o.atividadeT1,o.ligacaoT1,c1,Number(o.qtdT1)||0],
                ["Consumidor tipo 2",o.atividadeT2,o.ligacaoT2,c2,Number(o.qtdT2)||0]]
               .filter(function(l){ return l[1]; });
    var total=linhas.reduce(function(s,l){ return s+((l[3]||0)*l[4]); },0);
    h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div><h3>Consumo estimado</h3>'+
      '<p class="sub">'+esc(rotuloRevisao("anexo1")==="não informada"?"Anexo 1 — revisão não informada":"Anexo 1 · "+rotuloRevisao("anexo1"))+
      '</p></div></div><div class="tbl-wrap"><table><thead><tr><th>Consumidor</th><th>Tipo de empreendimento</th>'+
      '<th>Ligação</th><th class="num">kWh/mês</th><th class="num">Qtd.</th><th class="num">Total kWh/mês</th></tr></thead><tbody>'+
      linhas.map(function(l){
        return "<tr><td>"+esc(l[0])+"</td><td>"+esc(l[1])+"</td><td>"+esc(l[2]?nomeLigacao(l[2]):"—")+
          '</td><td class="num">'+(l[3]===null?'<span class="chip bad">não previsto</span>':num(l[3]))+
          '</td><td class="num">'+num(l[4])+'</td><td class="num">'+(l[3]===null?"—":num(l[3]*l[4]))+"</td></tr>"; }).join("")+
      (total?'<tr><td colspan="5" style="text-align:right"><strong>Total</strong></td><td class="num"><strong>'+num(total)+"</strong></td></tr>":"")+
      "</tbody></table></div></div>";
  }

  FD.forEach(function(s,i){
    var se=errs.filter(function(e){ return e.sec===s.id; }).length;
    h+='<div class="sect" data-sect="'+s.id+'"><div class="sect-h"><h4><span class="idx">'+String(i+1).padStart(2,"0")+"</span>"+
      esc(s.titulo)+(se?' <span class="chip bad">'+se+"</span>":"")+"</h4></div>"+
      '<div class="sect-b">'+
      (s.id==="empreiteira"&&can("obra.edit")?
        '<div style="margin-bottom:10px"><button class="btn ghost sm" id="btnRepetirEmp">Repetir empreiteira da última obra</button>'+
        '<span class="drv" style="display:inline-block;margin-left:8px">Traz todos os campos desta seção da obra gravada mais recentemente.</span></div>':"")+
      '<div class="fgrid">'+s.campos.filter(function(c){ return visivel(c,o); })
        .map(function(c){ return campoHTML(c,o,errs); }).join("")+"</div></div></div>";
  });
  return h+'<p class="note">As alterações só vão para o banco quando você clicar em Salvar.</p>';
}

/* ==========================================================================
   VÃOS ENTRE PONTOS
   Três grades: transformadores, pontos e trechos. Juntas formam a topologia
   que a queda de tensão e o esforço mecânico percorrem.
   ========================================================================== */
function proximoId(lista,prefixo){
  var n=0;
  (lista||[]).forEach(function(x){
    var m=String(x.id||"").replace(prefixo||"","");
    if(/^\d+$/.test(m)) n=Math.max(n,Number(m));
  });
  return (prefixo||"")+(n+1);
}
function grade(titulo,sub,chave,colunas,linhas,rotulo,acoes){
  var editavel=can("obra.edit");
  var h='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div><h3>'+esc(titulo)+"</h3>"+
    (sub?'<p class="sub">'+esc(sub)+"</p>":"")+"</div>"+
    (editavel?'<div class="actions">'+(acoes||"")+'<button class="btn sm" data-add="'+chave+'">Adicionar '+esc(rotulo)+"</button></div>":"")+"</div>";
  if(!linhas.length) return h+'<div class="empty" style="padding:28px"><p>Nenhum '+esc(rotulo)+" lançado.</p></div></div>";
  h+='<div class="tbl-wrap"><table><thead><tr>'+
    colunas.map(function(c){ return "<th"+(c.num?' class="num"':"")+' style="min-width:'+(c.w||80)+'px">'+esc(c.l)+"</th>"; }).join("")+
    (editavel?"<th></th>":"")+"</tr></thead><tbody>";
  linhas.forEach(function(r,i){
    h+="<tr>"+colunas.map(function(c){
      if(c.calc) return "<td"+(c.num?' class="num"':"")+">"+c.calc(r,i)+"</td>";
      var v=r[c.k]===undefined||r[c.k]===null?"":r[c.k];
      var attr=' data-g="'+chave+'" data-i="'+i+'" data-k="'+c.k+'"'+(editavel?"":" disabled");
      if(c.ops) return '<td><select'+attr+'><option value="">—</option>'+
        c.ops().map(function(p){ return '<option value="'+esc(p[0])+'"'+(String(v)===String(p[0])?" selected":"")+">"+esc(p[1])+"</option>"; }).join("")+"</select></td>";
      return "<td"+(c.num?' class="num"':"")+'><input type="'+(c.tipo||"text")+'"'+attr+' value="'+esc(v)+'"'+
        (c.step?' step="'+c.step+'"':"")+(c.min!==undefined?' min="'+c.min+'"':"")+"></td>";
    }).join("")+
    (editavel?'<td style="text-align:right"><button class="btn danger sm" data-del="'+chave+'" data-i="'+i+'">Excluir</button></td>':"")+"</tr>";
  });
  return h+"</tbody></table></div></div>";
}

function viewTopologia(){
  var o=S.rascunho;
  if(!o) return '<div class="empty"><h4>Obra não encontrada</h4></div>';
  o.trafos=o.trafos||[]; o.pontos=o.pontos||[]; o.trechos=o.trechos||[];
  var ctx=contextoCalculo(o);
  var h=cabecalhoObra(o,"Transformadores, pontos e trechos da rede. É a topologia que alimenta a queda de tensão e o esforço mecânico.");

  var faltam=[];
  if(!ctx.constA||!ctx.constB) faltam.push("as constantes do município");
  if(!ctx.kwh1) faltam.push("o tipo de empreendimento e a ligação do consumidor tipo 1");
  if(!ctx.caboSec) faltam.push("o cabo padrão da rede secundária");
  if(faltam.length)
    h+='<div class="consist bad"><div><strong>Faltam dados na folha</strong><div class="note">Preencha '+
       faltam.join(", ")+" para o cálculo rodar.</div></div></div>";

  /* A demanda por consumidor depende de quantos consumidores o transformador
     tem, então a conta é mostrada por transformador, não uma vez só. */
  h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div><h3>Cálculo de demanda</h3>'+
    '<p class="sub">kVA<sub>S</sub> = A × (Nx × kWh)<sup>B</sup> ÷ Nx — a conta está aberta para conferência. '+
    'Nx é o número de consumidores ligados ao transformador: quanto maior o grupo, menor a demanda de cada um.</p></div></div>'+
    '<div class="tbl-wrap"><table><thead><tr><th>Trafo</th><th class="num">A</th><th class="num">B</th>'+
    '<th class="num">kWh/lote</th><th class="num">Nx</th><th class="num">kVA do grupo</th>'+
    '<th class="num">kVA<sub>S</sub> por consumidor</th><th class="num">Diurna</th><th class="num">Noturna</th>'+
    "</tr></thead><tbody>";
  if(!o.trafos.length)
    h+='<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:16px">Cadastre um transformador abaixo para a conta aparecer.</td></tr>';
  o.trafos.forEach(function(tr){
    var d=demandaTrafo(o,tr.id), g=d.grupo;
    h+="<tr><td><strong>"+esc(tr.id||"—")+'</strong></td><td class="num">'+num(ctx.constA,4)+
      '</td><td class="num">'+num(ctx.constB,4)+'</td><td class="num">'+num(ctx.kwh1,0)+
      '</td><td class="num">'+num(g.nx)+'</td><td class="num">'+num(g.total,2)+
      '</td><td class="num"><strong>'+num(d.kvas,2)+'</strong></td><td class="num">'+num(d.diurna,2)+
      '</td><td class="num"><strong>'+num(d.noturna,2)+"</strong></td></tr>";
  });
  h+="</tbody></table></div>"+
    '<div class="tbl-foot"><span>Consumo estimado do empreendimento: '+num(consumoLoteamento(o),0)+
    " kWh/mês</span><span>Fator de potência "+num(ctx.fatorPotencia,2)+" · "+esc(o.tipoEmpreendimento||"—")+
    " · carregamento KVAN × "+num(ctx.fatorCarreg,3)+"</span></div></div>";

  var opsPontos=function(){ return (o.pontos||[]).map(function(p){ return [p.id,String(p.id)]; }); };
  var opsTrafos=function(){ return (o.trafos||[]).map(function(t){ return [t.id,String(t.id)]; }); };
  var opsCabo=function(){ return items("cabos_qt").filter(function(x){ return x.coef["380_1"]!==null; })
    .map(function(x){ return [x.bitola,x.bitola+" "+x.unidade]; }); };

  h+=grade("Transformadores","Cada transformador é a raiz de um circuito.","trafos",[
    {k:"id",l:"Nº",w:70},
    {k:"ponto",l:"Ponto de instalação",w:150,ops:opsPontos},
    {k:"potencia",l:"Potência (kVA)",w:120,num:1,ops:function(){
      return (((S.cat.trafos||{}).items)||[]).map(function(x){ return [x.nominal,num(x.nominal,1)+" kVA"]; }); }},
    {l:"Demanda noturna (kVA)",num:1,w:140,calc:function(r){
      var d=demandaTrafo(o,r.id); return '<span class="mono">'+num(d.noturna,2)+"</span>"; }},
    {l:"Sugerido",num:1,w:110,calc:function(r){
      var d=demandaTrafo(o,r.id), s=dimensionarTrafo(d.noturna,o.tipoEmpreendimento,ctx.fatorCarreg);
      if(!s) return "—";
      var ok=Number(r.potencia)===s.nominal;
      return '<span class="chip '+(r.potencia?(ok?"ok":"warn"):"")+'">'+num(s.nominal,1)+" kVA</span>"; }},
    {l:"Carregamento",num:1,w:130,calc:function(r){
      var d=demandaTrafo(o,r.id);
      var c=carregamentoTrafo(d.noturna,r.potencia,ctx.fatorCarreg);
      if(!c) return "—";
      var cls=c.percentual>100?"bad":(c.percentual>90?"warn":"ok");
      return '<span class="chip '+cls+'">'+num(c.percentual,2)+" %</span>"; }},
    {l:"Máx. cons. tipo 1",num:1,w:150,calc:function(r){
      var m=maxConsumidoresT1(o,r.id,r.potencia);
      if(m===null) return "—";
      var d=demandaTrafo(o,r.id), atual=d.totais.consT1+d.totais.consT2;
      return '<span class="mono">'+num(atual)+" / "+num(m)+"</span>"+
        (atual>m?' <span class="chip bad">acima</span>':""); }}
  ],o.trafos,"transformador");

  /* A carga do ponto depende do transformador que o alimenta, porque a demanda
     por consumidor é do grupo. Guardamos de qual circuito cada ponto veio. */
  var kvasDoPonto={};
  o.trafos.forEach(function(tr){
    var c=calcularCircuito(o,tr.id);
    if(c.raiz) kvasDoPonto[c.raiz]=c.kvas;
    c.trechos.forEach(function(t){ kvasDoPonto[t.para]=c.kvas; });
  });

  h+=grade("Pontos","Cargas instaladas em cada ponto da rede. A letra é a designação usada no relatório de queda.","pontos",[
    {k:"id",l:"Ponto",w:70},
    {k:"letra",l:"Letra",w:70},
    {k:"consT1",l:"Consum. tipo 1",tipo:"number",min:0,num:1,w:110},
    {k:"consT2",l:"Consum. tipo 2",tipo:"number",min:0,num:1,w:110},
    {k:"lumT1",l:"Lumin. tipo 1",tipo:"number",min:0,num:1,w:100},
    {k:"lumT2",l:"Lumin. tipo 2",tipo:"number",min:0,num:1,w:100},
    {k:"cargaEspecial",l:"Carga especial (kVA)",tipo:"number",step:"0.01",min:0,num:1,w:140},
    {l:"Carga no ponto (kVA)",num:1,w:140,calc:function(r){
      var k=kvasDoPonto[String(r.id)];
      if(k===undefined) return '<span class="mono">—</span>';
      return '<span class="mono">'+num(cargaDoPonto(r,ctx,k),3)+"</span>"; }}
  ],o.pontos,"ponto");

  h+=grade("Trechos","Ligação entre dois pontos, com comprimento e bitola.","trechos",[
    {k:"trafo",l:"Trafo",w:80,ops:opsTrafos},
    {k:"de",l:"De",w:90,ops:opsPontos},
    {k:"para",l:"Para",w:90,ops:opsPontos},
    {k:"comprimento",l:"Comprimento (m)",tipo:"number",step:"0.1",min:0,num:1,w:130},
    {k:"classificacao",l:"Classificação",w:130,ops:function(){
      return [["S","Secundária"],["P","Primária"],["IP","Iluminação pública"],["M","Mergulho"],["N","Neutro"]]; }},
    {k:"bitola",l:"Bitola",w:110,ops:opsCabo}
  ],o.trechos,"trecho");

  return h+'<p class="note">O ponto onde o transformador está instalado é a raiz do circuito. Os trechos saem dele em cadeia ou em ramificação.</p>';
}

/* ==========================================================================
   QUEDA DE TENSÃO
   ========================================================================== */
function viewQueda(){
  var o=S.rascunho;
  if(!o) return '<div class="empty"><h4>Obra não encontrada</h4></div>';
  var h=cabecalhoObra(o,"Queda de tensão por transformador, comparada aos limites da folha de dados.");
  var trafos=o.trafos||[];
  if(!trafos.length) return h+'<div class="panel"><div class="empty"><h4>Nenhum transformador lançado</h4>'+
    "<p>O cálculo percorre a topologia a partir de cada transformador. Cadastre ao menos um na aba de vãos entre pontos.</p></div></div>";

  var ctx=contextoCalculo(o);
  h+='<div class="panel" style="margin-bottom:14px"><div class="panel-b grid g4" style="gap:10px">'+
    [["Tensão secundária",ctx.tensaoNominal?num(ctx.tensaoNominal,0)+" / "+num(ctx.tensaoFN,0)+" V":"—"],
     ["Fator de potência",num(ctx.fatorPotencia,2)],
     ["Limite rede secundária",ctx.limiteSec?num(ctx.limiteSec,1)+" %":"—"],
     ["Limite iluminação pública",ctx.limiteIP?num(ctx.limiteIP,1)+" %":"—"]]
    .map(function(r){ return '<div><div style="font-size:11.5px;color:var(--muted)">'+esc(r[0])+
      '</div><div class="mono" style="font-size:15px;margin-top:2px">'+esc(r[1])+"</div></div>"; }).join("")+"</div></div>";

  trafos.forEach(function(tr){
    var r=calcularCircuito(o,tr.id);
    var d=demandaTrafo(o,tr.id);
    var carr=carregamentoTrafo(d.noturna,tr.potencia,ctx.fatorCarreg);
    var corrente=correnteTrafo(d.noturna,ctx.tensaoNominal);
    var pior=0, fora=0, semCoef=0;
    r.trechos.forEach(function(t){
      if(t.quedaAcumulada>pior) pior=t.quedaAcumulada;
      if(t.excedeQueda) fora++;
      if(t.semCoeficiente) semCoef++;
    });
    h+='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div>'+
      "<h3>Transformador "+esc(tr.id)+(tr.potencia?" · "+num(tr.potencia,1)+" kVA":"")+"</h3>"+
      '<p class="sub">'+(r.raiz?"Instalado no ponto "+esc(r.raiz)+" · ":"")+
      r.trechos.length+" trecho"+(r.trechos.length===1?"":"s")+"</p></div>"+
      "<div>"+(r.ciclo?'<span class="chip bad">topologia com laço</span>':
        (fora?'<span class="chip bad">'+fora+" trecho"+(fora>1?"s":"")+" acima do limite</span>":
         (r.trechos.length?'<span class="chip ok">dentro do limite · pior '+num(pior,2)+"%</span>":"")))+
      (semCoef?' <span class="chip warn">'+semCoef+" sem coeficiente de cabo</span>":"")+"</div></div>";

    /* Cabeçalho igual ao do formulário da concessionária. */
    h+='<div class="panel-b grid g4" style="gap:10px;border-bottom:1px solid var(--line-2)">'+
      [["Consumidores",num(d.totais.consT1+d.totais.consT2)],
       ["Luminárias",num(d.totais.lumT1+d.totais.lumT2)],
       ["kWh por lote",ctx.kwh1?num(ctx.kwh1,0):"—"],
       ["Demanda por lote",num(d.kvas,2)+" kVA"],
       ["Primária",ctx.tensaoPrim?num(ctx.tensaoPrim,1)+" kV":"—"],
       ["Secundária",ctx.tensaoNominal?num(ctx.tensaoNominal,0)+" / "+num(ctx.tensaoFN,0)+" V":"—"],
       ["Potência do trafo",tr.potencia?num(tr.potencia,1)+" kVA":"—"],
       ["Carregamento",carr?num(carr.percentual,2)+" % (KVAN × "+num(carr.fator,3)+")":"—"]]
      .map(function(x){ return '<div><div style="font-size:11.5px;color:var(--muted)">'+esc(x[0])+
        '</div><div class="mono" style="font-size:15px;margin-top:2px">'+esc(x[1])+"</div></div>"; }).join("")+"</div>";

    if(!r.trechos.length){
      h+='<div class="empty" style="padding:28px"><p>'+
        (r.raiz?"Nenhum trecho sai do ponto "+esc(r.raiz)+".":"Defina o ponto de instalação deste transformador.")+
        "</p></div></div>";
      return;
    }

    /* Colunas na ordem do formulário: trecho, carga, condutor, queda. */
    h+='<div class="tbl-wrap"><table><thead>'+
      '<tr><th colspan="2">Trecho</th><th colspan="3" class="num">Carga (kVA)</th>'+
      '<th>Condutor</th><th colspan="3" class="num">Queda de tensão (%)</th>'+
      '<th colspan="2" class="num">Verificação</th></tr>'+
      '<tr><th>Designação</th><th class="num">Compr. (×100 m)</th>'+
      '<th class="num">Distribuída</th><th class="num">Acumulada no fim</th><th class="num">Total (C/2+D)×B</th>'+
      '<th>Bitola</th><th class="num">Unitária</th><th class="num">No trecho</th><th class="num">Total</th>'+
      '<th class="num">Tensão (V)</th><th class="num">Corrente (A)</th></tr></thead><tbody>'+
      r.trechos.map(function(t){
        return "<tr"+(t.excedeQueda?' class="fora"':"")+'><td class="mono"><strong>'+esc(t.designacao)+"</strong>"+
          (t.classificacao==="IP"?' <span class="pill">IP</span>':"")+
          '</td><td class="num">'+num(t.comprimento/100,2)+
          '</td><td class="num">'+(t.cargaLocal?num(t.cargaLocal,2):"—")+
          '</td><td class="num">'+num(t.cargaJusante,2)+
          '</td><td class="num">'+num(t.momento,3)+
          "</td><td>"+(t.bitola?esc(t.bitola):'<span class="pill">sem bitola</span>')+
          '</td><td class="num">'+(t.coef===null?'<span class="pill">—</span>':num(t.coef,4))+
          '</td><td class="num">'+(t.queda===null?"—":num(t.queda,ctx.casas))+
          '</td><td class="num"><strong>'+(t.queda===null?"—":num(t.quedaAcumulada,ctx.casas))+"</strong>"+
          (t.excedeQueda?' <span class="chip bad">&gt; '+num(t.limite,1)+"%</span>":"")+
          '</td><td class="num">'+(t.tensao?num(t.tensao,1):"—")+
          '</td><td class="num">'+num(t.corrente,1)+
          (t.excedeCorrente?' <span class="chip bad">&gt; '+num(t.amperagem)+" A</span>":"")+"</td></tr>"; }).join("")+
      "</tbody></table></div>";

    /* Rodapé do formulário. */
    h+='<div class="panel-b grid g4" style="gap:10px;border-top:1px solid var(--line-2)">'+
      [["Demanda existente",num(Number(o.demandaExistente)||0,2)+" kVA"],
       ["Demanda projetada",num(d.noturna,2)+" kVA"],
       ["Demanda diurna",num(d.diurna,2)+" kVA"],
       ["Demanda noturna",num(d.noturna,2)+" kVA"+
         (carr?" ("+num(carr.percentual,2)+" %)":"")+(corrente?" · "+num(corrente,4)+" A":"")]]
      .map(function(x){ return '<div><div style="font-size:11.5px;color:var(--muted)">'+esc(x[0])+
        '</div><div class="mono" style="font-size:15px;margin-top:2px">'+esc(x[1])+"</div></div>"; }).join("")+
      "</div></div>";
  });

  if(ctx.lotesTotais||ctx.lotesExistentes)
    h+='<p class="note">Empreendimento com '+num(ctx.lotesTotais)+" lote"+(ctx.lotesTotais===1?"":"s")+
       " no total, dos quais "+num(ctx.lotesExistentes)+" já são atendidos pela rede existente.</p>";

  h+='<p class="note">Total do trecho = (carga distribuída ÷ 2 + carga acumulada no fim) × comprimento, '+
     'com o comprimento em centenas de metros. A carga do próprio trecho entra pela metade, por estar '+
     'distribuída ao longo dele. A queda do trecho é esse total multiplicado pela queda unitária do cabo, '+
     'que sai da GED 3667 Tab. 4.1 pela tensão da rede e pelo fator de potência.</p>';
  return h;
}

/* ==========================================================================
   CADASTROS E TABELAS
   ========================================================================== */
var TAB={
 concessionarias:{cat:"concessionarias",t:"Concessionárias",
   d:"As constantes A e B pertencem à concessionária. Alterar aqui vale na hora para todos os municípios dela.",
   cols:[["nome","Concessionária"],["constA","Constante A",function(v){return num(v,4);},1],
         ["constB","Constante B",function(v){return num(v,4);},1],
         ["ufs","UF",function(v){return (v||[]).join(", ");}],
         ["municipios","Municípios",function(v,r){ return num(contarMunicipios(r.nome)); },1],
         ["classesTensao","Classes de tensão",function(v){return (v||[]).join(" / ")+" kV";}],
         ["gedVigente","GED vigente"],
         ["absorveu","Absorveu",function(v){ return (v&&v.length)?v.map(function(x){ return '<span class="pill" style="margin-right:3px">'+esc(x)+"</span>"; }).join(""):"—"; }]],
   busca:["nome","grupo"],perm:"cad",
   novo:{nome:"",grupo:"CPFL Energia",constA:null,constB:null,ufs:[],classesTensao:[],gedVigente:"",absorveu:[],ativo:true},
   form:[["nome","Concessionária"],["grupo","Grupo"],["constA","Constante A","number"],["constB","Constante B","number"],["gedVigente","GED vigente"]]},
 municipios:{cat:"municipios",t:"Municípios e constantes",
   d:"Tensões e concessionária por município. As constantes A e B vêm da concessionária e são editadas lá.",
   cols:[["municipio","Município"],["uf","UF"],["concessionaria","Concessionária"],
         ["constA","Constante A",function(v,r){ return '<span class="derivado">'+num(constantesDe(r).constA,4)+"</span>"; },1],
         ["constB","Constante B",function(v,r){ return '<span class="derivado">'+num(constantesDe(r).constB,4)+"</span>"; },1],
         ["tensaoPrimNominal","Tensão prim. (kV)",function(v){return num(v,1);},1],
         ["classe15_25","Classe (kV)",function(v){return num(v,0);},1],
         ["tensaoSecFF","Tensão sec. (V)",function(v,r){return num(v,0)+" / "+num(r.tensaoSecFN,0);},1],
         ["concessionariaAnterior","Era",function(v){ return v?'<span class="pill">'+esc(v)+"</span>":"—"; }]],
   busca:["municipio","uf","concessionaria"],perm:"cad",
   novo:{municipio:"",uf:"",concessionaria:"",tensaoPrimNominal:null,classe15_25:null,tensaoSecFF:null,tensaoSecFN:null},
   form:[["municipio","Município"],["uf","UF"],["concessionaria","Concessionária"],
         ["tensaoPrimNominal","Tensão primária nominal (kV)","number"],
         ["classe15_25","Classe de tensão (kV)","number"],["tensaoSecFF","Tensão secundária fase-fase (V)","number"],
         ["tensaoSecFN","Tensão secundária fase-neutro (V)","number"]]},
 materiais:{cat:"materiais",t:"Materiais",d:"Cadastro próprio, independente dos projetos. O preço unitário entra com a tabela vigente.",
   cols:[["codigo","Código",function(v){ return v?'<span class="mono">'+esc(v)+"</span>":'<span class="pill">sem código</span>'; }],
         ["descricao","Descrição"],["grupo","Classe"],["unidade","Un."],["fabricante","Fabricante"],["fornecedor","Fornecedor"],
         ["ged","GED"],["precoUnitario","Preço unitário",function(v){ return v===null||v===undefined?'<span class="pill">pendente</span>':num(v,2); },1]],
   busca:["codigo","descricao","grupo","fabricante","fornecedor","ged"],perm:"cad",
   novo:{codigo:"",descricao:"",grupo:"DIVERSOS",unidade:"pç",fabricante:"",fornecedor:"",ged:"",precoUnitario:null},
   form:[["codigo","Código (até 10 caracteres)","text",10],["descricao","Descrição"],["grupo","Classe"],
         ["unidade","Unidade"],["fabricante","Fabricante"],["fornecedor","Fornecedor"],["ged","GED"],
         ["precoUnitario","Preço unitário (R$)","number"]]},
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
   novo:{tipo:"GED",numero:"",descricao:""},form:[["tipo","Tipo"],["numero","Número"],["descricao","Descrição"]]},
 cintas:{cat:"cintas",t:"Diâmetro de poste e cintas",d:"Parâmetros de cada bitola de poste. A conicidade e as faixas de cinta são recalculadas a cada gravação.",
   cols:[["bitola","Bitola"],["altura","Altura (m)",function(v){return num(v,1);},1],["carga","Carga (daN)",null,1],
         ["diamTopo","Ø topo (mm)",function(v){return num(v,0);},1],["diamBase","Ø base (mm)",function(v){return num(v,0);},1],
         ["conicidade","Conicidade (mm/mm)",function(v){return num(v,5);},1],

         ["distancias","Pontos de fixação (D1 a D10)",function(v,r){
            var ps=pontosDe(r), tem=ps.filter(function(p){ return p.d!==null; }).length;
            if(!tem) return '<span class="pill">nenhum definido</span>';
            return '<div class="pontos">'+ps.filter(function(p){ return p.d!==null; }).map(function(p){
              return '<span class="ponto'+(p.fora?" fora":"")+'" title="'+(p.fora?"Além do comprimento do poste":"Ø "+num(p.diametro,1)+" mm")+'">'+
                '<b>D'+p.n+"</b>"+num(p.d,0)+' <i>Ø'+p.cinta+"</i></span>"; }).join("")+"</div>"; }]],
   busca:["bitola","carga"],perm:"norm",derivar:recalcularBitola,
   novo:{bitola:"",altura:9,carga:"",diamTopo:null,diamBase:null,distancias:[10,null,null,null,null,null,null,null,null,null]},
   form:[["bitola","Bitola (ex.: 9/300)"],["altura","Altura (m)","number"],["carga","Carga nominal (daN)"],
         ["diamTopo","Diâmetro do topo (mm)","number"],["diamBase","Diâmetro da base (mm)","number"]],
   formExtra:formPontos, lerExtra:lerPontos}
};

function barraRevisao(chave){
  var r=revisaoDe(chave);
  var pode=can("norm.edit")&&TABELAS_NORMATIVAS.indexOf(chave)>=0;
  return '<div class="revbar'+(r&&r.versao?"":" vazia")+'">'+
    '<div><strong>Revisão vigente:</strong> '+esc(rotuloRevisao(chave))+
    (r&&r.atualizadoEm?' <span class="note">· informada por '+esc(r.atualizadoPor||"—")+" em "+fmtDT(r.atualizadoEm)+"</span>":"")+
    "</div>"+
    (pode?'<button class="btn ghost sm" data-rev="'+esc(chave)+'">Atualizar revisão</button>':"")+"</div>";
}
function editarRevisao(chave){
  var r=revisaoDe(chave)||{};
  modal("Revisão de "+(NOME_TABELA[chave]||chave),
    '<div class="fgrid">'+
    '<div class="fld c6"><label>Identificação da revisão</label><input type="text" data-f="versao" value="'+esc(r.versao||"")+
      '" placeholder="REV. 09/11/23"></div>'+
    '<div class="fld c3"><label>Data da revisão</label><input type="date" data-f="data" value="'+esc(r.data||"")+'"></div>'+
    "</div>"+
    '<p class="note" style="margin-top:12px">As obras salvas guardam qual revisão estava vigente. Ao mudar aqui, as obras calculadas sobre a revisão anterior passam a exibir aviso de base desatualizada.</p>',
    async function(bg){
      var v={}; bg.querySelectorAll("[data-f]").forEach(function(x){ v[x.getAttribute("data-f")]=x.value; });
      if(!v.versao.trim()){ toast("Informe a identificação da revisão"); return false; }
      S.cat[chave]=S.cat[chave]||{items:[]};
      S.cat[chave].revisao={versao:v.versao.trim(),data:v.data||null,
        atualizadoEm:new Date().toISOString(),atualizadoPor:S.sess.nome};
      try{ await Store.salvarCatalogo(chave); }catch(e){ toast(e.message); return false; }
      await Store.registrar("Atualizou revisão",chave,(NOME_TABELA[chave]||chave)+" · "+v.versao.trim());
      toast("Revisão registrada"); render();
    });
}
function viewTabela(rota){
  var cfg=TAB[rota], lista=items(cfg.cat), c=S.cat[cfg.cat];
  var q=S.q.trim().toLowerCase();
  var fil=!q?lista:lista.filter(function(r){ return cfg.busca.some(function(k){ return String(r[k]||"").toLowerCase().indexOf(q)>=0; }); });
  var editavel=can(cfg.perm+".edit");
  var h='<div class="phead"><div><h2>'+esc(cfg.t)+'</h2><p class="desc">'+esc(cfg.d)+"</p></div>"+
    '<div class="actions"><input type="text" class="search" id="qBusca" placeholder="Buscar" value="'+esc(S.q)+'">'+
    (editavel?'<button class="btn" id="btnNovo">Adicionar</button>':"")+"</div></div>";
  if(TABELAS_NORMATIVAS.indexOf(cfg.cat)>=0) h+=barraRevisao(cfg.cat);
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
  h+=barraRevisao("cabos");
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
  var l=items("cintas");
  var h=viewTabela("cintas");
  if(!l.length) return h;
  var calc='<div class="panel" style="margin-bottom:14px"><div class="panel-h"><div><h3>Conferir um ponto do poste</h3>'+
    '<p class="sub">Ø no ponto = Ø do topo + distância do topo × conicidade. A cinta é o menor múltiplo de 10 mm que acomoda o diâmetro, com folga de 5 mm.</p></div>'+
    '<div style="display:flex;gap:8px;align-items:flex-end"><div class="fld"><label>Bitola</label><select id="ciB">'+
    l.map(function(r,i){ return '<option value="'+i+'">'+esc(r.bitola)+"</option>"; }).join("")+"</select></div>"+
    '<div class="fld"><label>Distância do topo (mm)</label><input type="number" id="ciD" value="1000" step="10" min="0"></div>'+
    '<button class="btn" id="ciCalc">Calcular</button></div></div><div class="panel-b" id="ciOut"></div></div>';
  // insere a calculadora logo abaixo do cabeçalho, antes da tabela
  var corte=h.indexOf('<div class="panel">');
  return h.slice(0,corte)+calc+h.slice(corte);
}

function viewAnexo1(){
  var l=anexo1Tipos(), lig=anexo1Ligacoes(), c=S.cat.anexo1;
  var h='<div class="phead"><div><h2>Anexo 1 — previsão de consumo</h2>'+
    '<p class="desc">'+esc((c&&c.referencia)||"")+". Substitui a GED 3738 como base do cálculo de kVA.</p></div></div>";
  h+=barraRevisao("anexo1");
  if(!l.length) return h+'<div class="panel"><div class="empty"><h4>Tabela não importada</h4></div></div>';
  h+='<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Tipo de empreendimento</th>'+
    lig.map(function(x){ return '<th class="num">'+esc(x.nome)+"</th>"; }).join("")+"</tr></thead><tbody>"+
    l.map(function(r){ return "<tr><td>"+esc(r.tipo)+"</td>"+lig.map(function(x){
      var v=r.consumo[x.codigo];
      return '<td class="num">'+(v===undefined?'<span style="color:var(--line-strong)">—</span>':num(v)+" kWh")+"</td>"; }).join("")+"</tr>"; }).join("")+
    '</tbody></table></div><div class="tbl-foot"><span>'+l.length+" tipos · "+lig.length+" ligações</span>"+
    "<span>Os traços são combinações que o Anexo 1 não prevê</span></div></div>";
  h+='<p class="note" style="margin-top:10px">Tabela publicada pela concessionária, mantida somente leitura. Quando for revisada, o caminho é reimportar o documento inteiro.</p>';
  return h;
}
function viewGed3738(){
  var l=items("ged3738"), lig=(S.cat.ged3738&&S.cat.ged3738.ligacoes)||[], c=S.cat.ged3738;
  var q=S.q.trim().toLowerCase();
  var fil=!q?l:l.filter(function(r){ return r.atividade.toLowerCase().indexOf(q)>=0; });
  var h='<div class="phead"><div><h2>GED 3738 — consumo por atividade</h2><p class="desc">'+
    "Base anterior ao Anexo 1, mantida para consulta e para conferir obras calculadas antes da troca. Não alimenta mais o cálculo.</p></div>"+
    '<div class="actions"><input type="text" class="search" id="qBusca" placeholder="Buscar atividade" value="'+esc(S.q)+'"></div></div>';
  h+=barraRevisao("ged3738");
  h+='<p class="note" style="margin:-4px 0 14px">Tabela publicada pela concessionária, mantida somente leitura. Quando a GED for revisada, o caminho é reimportar o documento inteiro.</p>';
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
function formPontos(r){
  var ps=pontosDe(r);
  return '<div style="margin-top:16px;border-top:1px solid var(--line-2);padding-top:14px">'+
    '<div style="font-size:12.5px;margin-bottom:4px"><strong>Pontos de fixação</strong></div>'+
    '<p class="note" style="margin:0 0 10px">Distância a partir do topo, em milímetros, mínimo de 10. '+
    'Cada estrutura da concessionária usa o ponto que lhe corresponde. Deixe em branco os que ainda não forem usados.</p>'+
    '<div class="fgrid">'+ps.map(function(p){
      return '<div class="fld c1"><label>D'+p.n+'</label><input type="number" data-p="'+p.n+'" min="10" step="10" value="'+
        (p.d===null?"":p.d)+'">'+
        (p.d===null?"":'<div class="drv">'+(p.fora?'<span style="color:var(--alert)">além do poste</span>':"Ø "+num(p.diametro,1)+" → cinta Ø"+p.cinta)+"</div>")+
        "</div>"; }).join("")+"</div></div>";
}
function lerPontos(bg,rec){
  var d=[];
  for(var i=1;i<=QTD_PONTOS;i++){
    var inp=bg.querySelector('[data-p="'+i+'"]');
    var v=inp?inp.value:"";
    d.push(v===""?null:Number(v));
  }
  rec.distancias=d;
  return d;
}
function formCampos(defs,valores){
  return '<div class="fgrid">'+defs.map(function(d){
    var t=d[2]||"text";
    return '<div class="fld c3"><label>'+esc(d[1])+'</label><input type="'+t+'" data-f="'+d[0]+'" value="'+
      esc(valores[d[0]]===null||valores[d[0]]===undefined?"":valores[d[0]])+'"'+(t==="number"?' step="any"':"")+
      (d[3]?' maxlength="'+d[3]+'"':"")+"></div>"; }).join("")+"</div>";
}
function lerForm(bg){ var o={};
  bg.querySelectorAll("[data-f]").forEach(function(i){
    var v=i.value; if(i.type==="number") v=v===""?null:Number(v); o[i.getAttribute("data-f")]=v; });
  return o; }

function editarRegistro(rota,idx){
  var cfg=TAB[rota], lista=items(cfg.cat);
  var novo=idx<0, base=novo?Object.assign({},cfg.novo):Object.assign({},lista[idx]);
  modal((novo?"Adicionar em ":"Editar registro de ")+cfg.t.toLowerCase(),
    formCampos(cfg.form,base)+(cfg.formExtra?cfg.formExtra(base):""),async function(bg){
    var rec=Object.assign({},base,lerForm(bg));
    if(cfg.lerExtra) cfg.lerExtra(bg,rec);
    if(!String(rec[cfg.form[0][0]]||"").trim()){ toast("Preencha "+cfg.form[0][1].toLowerCase()); return false; }
    if(cfg.cat==="materiais"&&String(rec.codigo||"").length>10){ toast("O código aceita no máximo 10 caracteres"); return false; }
    if(cfg.cat==="concessionarias"&&(rec.constA===null||rec.constB===null)){ toast("Informe as constantes A e B"); return false; }
    if(cfg.derivar){
      if(!(Number(rec.diamBase)>Number(rec.diamTopo))){ toast("O diâmetro da base tem que ser maior que o do topo"); return false; }
      var ruim=null, alem=null;
      (rec.distancias||[]).forEach(function(d,i){
        if(d===null||d===undefined) return;
        if(!(Number(d)>=10)) ruim=ruim||("D"+(i+1));
        if(Number(d)>Number(rec.altura)*1000) alem=alem||("D"+(i+1));
      });
      if(ruim){ toast("O ponto "+ruim+" está abaixo do mínimo de 10 mm"); return false; }
      if(alem){ toast("O ponto "+alem+" passa do comprimento do poste"); return false; }
      cfg.derivar(rec);
    }
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
/* Botão que precisa agir antes de o campo perder o foco.

   Sair de um campo redesenha a tela, e isso acontece entre o apertar e o soltar
   do botão: no clique o elemento já foi substituído e nada acontece. Agindo no
   mousedown o botão responde antes. O clique continua ligado para teclado e
   para quem aciona por script, e a janela de tempo evita a ação dobrada. */
var ultimoAcionamento={chave:"",quando:0};
function aoAcionar(el,fn,chave){
  var k=chave||el.id||el.getAttribute("data-aba")||el.textContent||"";
  var h=function(e){
    var agora=Date.now();
    // Só ignora a repetição do mesmo botão; outro botão age normalmente.
    if(ultimoAcionamento.chave===k&&agora-ultimoAcionamento.quando<350) return;
    ultimoAcionamento={chave:k,quando:agora};
    if(e.preventDefault) e.preventDefault();
    fn(e);
  };
  el.addEventListener("mousedown",h);
  el.addEventListener("click",h);
}

/* Trocar o HTML tira o foco do campo que estava aberto, e isso dispara o blur,
   que chama render de novo no meio da troca. A trava abaixo faz a chamada de
   dentro ser ignorada: quem está desenhando já vai mostrar o estado mais novo. */
var desenhando=false;
function render(){
  if(desenhando) return;
  desenhando=true;
  try{ desenhar(); } finally { desenhando=false; }
}
function desenhar(){
  var app=document.getElementById("app");
  if(!S.ready){ app.innerHTML='<div class="loading">Carregando…</div>'; return; }
  if(!S.sess){ app.innerHTML=viewLogin(); ligarLogin(); return; }
  var corpo="";
  switch(S.route){
    case "painel": corpo=viewPainel(); break;
    case "obras": corpo=viewObras(); break;
    case "folha": corpo=viewFolha(); break;
    case "topologia": corpo=viewTopologia(); break;
    case "queda": corpo=viewQueda(); break;
    case "usuarios": corpo=can("user.ler")?viewUsuarios():'<div class="empty"><h4>Sem permissão</h4></div>'; break;
    case "registro": corpo=can("log.ler")?viewRegistro():'<div class="empty"><h4>Sem permissão</h4></div>'; break;
    case "cabos": corpo=viewCabos(); break;
    case "cintas": corpo=viewCintas(); break;
    case "anexo1": corpo=viewAnexo1(); break;
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
/* Põe o foco no campo que o Enter escolheu, depois que a tela foi redesenhada. */
function focarGuardado(){
  var k=S.focoCampo;
  if(!k) return;
  S.focoCampo=null;
  var alvo=(k==="__salvar")?document.getElementById("btnSalvar")
                           :document.querySelector('.sect-b [data-k="'+k+'"]:not([disabled])');
  if(!alvo||alvo.disabled) return;
  alvo.focus();
  if(alvo.select) try{ alvo.select(); }catch(e){}
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
      if(emObra()&&folhaAlterada()){
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
    /* A empreiteira costuma ser sempre a mesma, então já vem preenchida da obra
       anterior. O usuário pode trocar qualquer campo depois. */
    var fonte=null, melhor="";
    S.obras.forEach(function(x){
      if(!x.empreiteira) return;
      var q=x.atualizadoEm||x.criadoEm||"";
      if(!fonte||q>melhor){ fonte=x; melhor=q; }
    });
    if(fonte) FD.forEach(function(s){
      if(s.id!=="empreiteira") return;
      s.campos.forEach(function(c){ if(fonte[c.k]!==undefined&&fonte[c.k]!=="") o[c.k]=fonte[c.k]; });
    });
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

  // abas da obra — o rascunho segue aberto, não precisa confirmar nada
  document.querySelectorAll("[data-aba]").forEach(function(b){
    aoAcionar(b,function(){ S.route=b.getAttribute("data-aba"); render(); });
  });

  // grades de topologia
  document.querySelectorAll("[data-add]").forEach(function(b){
    b.addEventListener("click",function(){
      var o=S.rascunho, chave=b.getAttribute("data-add");
      if(!o) return;
      o[chave]=o[chave]||[];
      if(chave==="trafos") o[chave].push({id:proximoId(o[chave],"T"),ponto:"",potencia:""});
      else if(chave==="pontos") o[chave].push({id:proximoId(o[chave],""),consT1:0,consT2:0,lumT1:0,lumT2:0,cargaEspecial:0});
      else o[chave].push({trafo:(o.trafos&&o.trafos[0]&&o.trafos[0].id)||"",de:"",para:"",comprimento:"",classificacao:"S",bitola:o.caboSecundario||""});
      render();
    });
  });
  document.querySelectorAll("[data-del]").forEach(function(b){
    b.addEventListener("click",function(){
      var o=S.rascunho, chave=b.getAttribute("data-del"), i=Number(b.getAttribute("data-i"));
      if(!o||!o[chave]) return;
      var alvo=o[chave][i];
      if(chave==="pontos"&&alvo){
        var usado=(o.trechos||[]).some(function(t){ return String(t.de)===String(alvo.id)||String(t.para)===String(alvo.id); })
               || (o.trafos||[]).some(function(t){ return String(t.ponto)===String(alvo.id); });
        if(usado) return toast("O ponto "+alvo.id+" está em uso em um trecho ou transformador");
      }
      if(chave==="trafos"&&alvo){
        var comTrecho=(o.trechos||[]).some(function(t){ return String(t.trafo)===String(alvo.id); });
        if(comTrecho) return toast("O transformador "+alvo.id+" ainda tem trechos ligados a ele");
      }
      o[chave].splice(i,1); render();
    });
  });
  document.querySelectorAll("[data-g]").forEach(function(inp){
    var ev=(inp.tagName==="SELECT")?"change":"input";
    inp.addEventListener(ev,function(){
      var o=S.rascunho; if(!o) return;
      var chave=inp.getAttribute("data-g"), i=Number(inp.getAttribute("data-i")), k=inp.getAttribute("data-k");
      var v=inp.value;
      if(inp.type==="number") v=v===""?"":Number(v);
      o[chave][i][k]=v;
      if(ev==="change") render();
      else marcarSujo();
    });
    inp.addEventListener("blur",function(){ if(inp.tagName!=="SELECT") render(); });
  });

  var bs=document.getElementById("btnSalvar");
  if(bs) aoAcionar(bs,async function(){
    if(bs.disabled) return;
    render(); await salvarFolha(); render(); });
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
      if(inp.getAttribute("data-data")){
        // Data digitada: vai pondo as barras e grava em AAAA-MM-DD.
        var pos=inp.selectionStart, antes=v;
        v=mascaraData(v);
        if(v!==antes){ inp.value=v; try{ inp.setSelectionRange(pos+(v.length-antes.length),pos+(v.length-antes.length)); }catch(e){} }
        o[k]=dataISO(v);
      } else {
        if(inp.type==="number") v=v===""?"":Number(v);
        o[k]=v;
      }
      var ehMunicipio=(k==="municipio"||k==="municipioCli"||k==="munEmp");
      if(ehMunicipio) sincronizarDerivados(o);
      /* Município virou campo de digitação. Escolher da lista de sugestões não
         dispara "change" em todo navegador, então quando o nome digitado bate
         com um do cadastro a tela é redesenhada na hora, para as constantes
         aparecerem sem precisar sair do campo. */
      if(ehMunicipio&&municipioInfo(v)){ S.focoCampo=k; render(); return; }
      if(ev==="change"){ render(); }
      else{
        var pend=validarObra(o), barra=document.querySelector(".consist .bar i");
        var tc=totalCampos(o);
        if(barra) barra.style.width=Math.round((tc-pend.filter(function(e){return e.tipo==="obrigatorio";}).length)/tc*100)+"%";
        var bar=document.querySelector(".salvabar");
        if(bar&&!bar.classList.contains("sujo")){
          bar.classList.add("sujo");
          bar.querySelector(".estado").innerHTML='<span class="ponto"></span>Alterações não salvas';
          bar.querySelectorAll("button").forEach(function(b){ b.disabled=false; });
        }
      }
    });
    inp.addEventListener("blur",function(e){
      if(inp.tagName==="SELECT") return;
      /* Sair de um campo redesenha a tela para atualizar os painéis derivados,
         e o redesenho troca o campo que acabou de receber o foco. Sem isto,
         quem sai de um campo clicando no seguinte digita no vazio. Guardamos
         para onde o foco estava indo e o devolvemos depois do redesenho. */
      var indo=e&&e.relatedTarget;
      if(indo&&indo.getAttribute&&indo.getAttribute("data-k"))
        S.focoCampo=indo.getAttribute("data-k");
      // Campo numérico não formata, mas precisa redesenhar os painéis derivados.
      if(inp.type==="number"){ render(); return; }
      var o=S.rascunho; if(!o) return;
      var k=inp.getAttribute("data-k"), def=null;
      FD.forEach(function(s){ s.campos.forEach(function(c){ if(c.k===k) def=c; }); });
      if(def&&def.fmt){
        var formatado=aplicarFormato(def,o[k],o);
        if(formatado!==o[k]){ o[k]=formatado; inp.value=formatado; }
      }
      render();
    });

    /* Enter anda para o campo seguinte, como o Tab. Quem preenche a folha
       inteira no teclado não precisa trocar de tecla no meio.

       Sair do campo redesenha a tela, o que apagaria o foco recém-posto. Por
       isso guardamos para onde ir e o foco é devolvido depois do redesenho. */
    inp.addEventListener("keydown",function(e){
      if(e.key!=="Enter"||e.shiftKey) return;
      if(inp.tagName==="TEXTAREA") return;
      e.preventDefault();
      var campos=Array.prototype.slice.call(
        document.querySelectorAll(".sect-b [data-k]:not([disabled])"));
      var alvo=campos[campos.indexOf(inp)+1];
      S.focoCampo=alvo?alvo.getAttribute("data-k"):"__salvar";
      /* Sair do campo dispara o redesenho, e redesenhar no meio do evento de
         teclado quebra o DOM. Por isso o blur só acontece depois que o evento
         termina; o foco é posto no fim do redesenho. */
      setTimeout(function(){ inp.blur(); if(S.focoCampo) focarGuardado(); },0);
    });
  });
  focarGuardado();

  /* Repete os dados da empreiteira da obra gravada mais recentemente. */
  var bre=document.getElementById("btnRepetirEmp");
  if(bre) bre.addEventListener("click",function(){
    var o=S.rascunho; if(!o) return;
    var campos=[]; FD.forEach(function(s){ if(s.id==="empreiteira") campos=s.campos.map(function(c){ return c.k; }); });
    var fonte=null, melhor="";
    S.obras.forEach(function(x){
      if(x._id===o._id||!x.empreiteira) return;
      var q=x.atualizadoEm||"";
      if(!fonte||q>melhor){ fonte=x; melhor=q; }
    });
    if(!fonte) return toast("Nenhuma outra obra com empreiteira preenchida ainda.");
    campos.forEach(function(k){ if(fonte[k]!==undefined) o[k]=fonte[k]; });
    sincronizarDerivados(o);
    render();
    toast("Empreiteira trazida de "+(fonte.empreendimento||"obra anterior")+".");
  });

  document.querySelectorAll("[data-rev]").forEach(function(b){
    b.addEventListener("click",function(){ editarRevisao(b.getAttribute("data-rev")); }); });

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
    var dia=r.diamTopo+d*r.conicidade, cinta=cintaPara(dia);
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
  if(emObra()&&folhaAlterada()){ e.preventDefault(); e.returnValue=""; }
});

(async function(){
  render();
  Store=await criarStore();
  await carregar();
  if(S.sess&&can("log.ler")) await lerLog();
  render();
})();