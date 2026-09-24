/* ============================================================
  NEXLOG — núcleo funcional
  Persistência online via Supabase.
  ============================================================ */
let db = null;
let authSession = null;
let CUR = { name:'', role:'Administrador' };
let STATE = { clients:[], materials:[], orders:[], tools:[], cnc:[], notifications:[], users:[] };
let VIEW = 'dashboard';
let OS_OPEN = null;   // id da OS aberta
let OS_TAB = 'resumo';

const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>Array.from(el.querySelectorAll(s));
// Liga um evento só se o elemento existir (evita TypeError e tela cinza)
const on = (sel, ev, fn) => { const el = $(sel); if(el) el.addEventListener(ev, fn); };
const fmtDate = (d)=>{ if(!d) return '—'; const dt = new Date(d); if(isNaN(dt)) return d; return dt.toLocaleDateString('pt-BR'); };
const nowStr = ()=> new Date().toLocaleString('pt-BR');
const uid = ()=> Math.random().toString(36).slice(2,9);
const toText = (value, fallback='—') => value === null || value === undefined || value === '' ? fallback : String(value);
const normalizeDoc = (doc) => {
  if(!doc) return {};
  const payload = typeof doc.data === 'function' ? doc.data() : (doc.data || {});
  return { id: doc.id, ...(payload || {}) };
};

function createSupabaseDb(client){
  const table = 'nexlog_records';
  const snapshot = rows => ({ docs: (rows || []).map(row => ({ id:row.id, data:() => ({ ...(row.data || {}) }) })) });
  const getRows = async (name, limit=1000, orderField='created_at', direction='asc') => {
    let query = client.from(table).select('id,data,created_at').eq('collection', name).limit(limit);
    if(orderField === 'created_at') query = query.order('created_at', { ascending: direction !== 'desc' });
    const { data, error } = await query;
    if(error) throw error;
    return data || [];
  };
  return {
    collection(name){
      return {
        orderBy(field, dir='asc'){
          return {
            onSnapshot(callback, onError){
              let active = true;
              const load = async()=>{ try { if(active) callback(snapshot(await getRows(name, 1000, field, dir))); } catch(error){ if(active && onError) onError(error); } };
              load();
              const channel = client.channel(`nexlog-${name}-${uid()}`).on('postgres_changes', {event:'*', schema:'public', table, filter:`collection=eq.${name}`}, load).subscribe();
              return { unsubscribe:()=>{ active=false; client.removeChannel(channel); } };
            }
          };
        },
        limit(n){
          return { async get(){ return { docs:snapshot(await getRows(name, n)).docs }; } };
        },
        async add(data){
          const { data:row, error } = await client.from(table).insert({ collection:name, data }).select('id').single();
          if(error) throw error;
          return { id:row.id };
        },
        doc(id){
          return {
            async update(patch){
              const { data:row, error:getError } = await client.from(table).select('data').eq('id', id).single();
              if(getError) throw getError;
              const { error } = await client.from(table).update({ data:{ ...(row.data || {}), ...patch } }).eq('id', id);
              if(error) throw error;
            },
            async delete(){
              const { error } = await client.from(table).delete().eq('id', id);
              if(error) throw error;
            }
          };
        }
      };
    }
  };
}

function toast(msg){
  const t = $('#toast'); if(!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2400);
}

/* ---------------- BOOT ---------------- */
const SUPABASE_TIMEOUT = 12000;
let LOGIN_BOUND = false;

function withTimeout(promise, ms=SUPABASE_TIMEOUT){
  return Promise.race([
    promise,
    new Promise((_, reject)=>setTimeout(()=>reject(new Error('O Supabase demorou para responder.')), ms))
  ]);
}

// Aceita a URL certa e também corrige o link do painel (supabase.com/dashboard/project/<ref>)
function normalizeSupabaseUrl(raw){
  const url = String(raw || '').trim();
  const m = url.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if(m) return `https://${m[1]}.supabase.co`;
  return url.replace(/\/+$/, '');
}

function showLogin(message=''){
  const login = $('#login-screen');
  const app = $('#app');
  if(login) login.style.display='flex';
  if(app) app.classList.remove('ready');
  const err = $('#login-error');
  if(err) err.textContent = message || '';
}

function showApp(){
  const login = $('#login-screen');
  const app = $('#app');
  if(login) login.style.display='none';
  if(app) app.classList.add('ready');
}

function bindLoginUI(){
  if(LOGIN_BOUND) return;
  LOGIN_BOUND = true;
  on('#login-btn', 'click', doLogin);
  on('#login-usuario', 'keydown', e=>{ if(e.key==='Enter') doLogin(); });
  on('#login-password', 'keydown', e=>{ if(e.key==='Enter') doLogin(); });
  on('#login-back', 'click', ()=>{
    const u = $('#login-usuario'), p = $('#login-password'), er = $('#login-error');
    if(u) u.value=''; if(p) p.value=''; if(er) er.textContent='';
    if(u) u.focus();
  });
  on('#login-magic', 'click', ()=>toast('O acesso por link mágico ainda depende de um servidor de autenticação.'));
  on('#login-sso', 'click', ()=>toast('O login corporativo será conectado ao provedor da empresa.'));
  on('#top-notifications', 'click', ()=>{ VIEW='notificacoes'; OS_OPEN=null; renderView(); });
}

// Rede de segurança: erro inesperado antes do app abrir cai na tela de login, nunca em tela cinza.
window.addEventListener('error', e=>{
  console.error('Erro global:', e.error || e.message);
  const app = $('#app');
  if(!app || !app.classList.contains('ready')) showLogin('Erro ao carregar o sistema. Recarregue a página.');
});
window.addEventListener('unhandledrejection', e=>{
  console.error('Promise rejeitada:', e.reason);
});

async function boot(){
  bindLoginUI();                       // login sempre funcional, mesmo se o Supabase falhar
  showLogin('Conectando ao sistema...');

  try{
    const config = window.NEXLOG_SUPABASE_CONFIG || {};
    const url = normalizeSupabaseUrl(config.url);
    if(!url || !config.anonKey || url.includes('SEU_')){
      throw new Error('Configure o Supabase em supabase-config.js.');
    }
    if(!window.supabase || !window.supabase.createClient){
      throw new Error('A biblioteca do Supabase não foi carregada.');
    }

    const client = window.supabase.createClient(url, config.anonKey);
    window.supabaseClient = client;
    db = createSupabaseDb(client);

    client.auth.onAuthStateChange((event, session)=>{
      const hadSession = !!authSession;
      authSession = session;
      if(event === 'SIGNED_OUT' && hadSession) showLogin('Sua sessão expirou. Entre novamente.');
    });
  }catch(e){
    console.error('Falha ao iniciar o Supabase:', e);
    db = null;
    authSession = null;
    showLogin('Não foi possível conectar ao Supabase. Verifique sua internet e tente novamente.');
    return;
  }

  // Se a leitura da sessão falhar ou demorar, segue para o login normal em vez de travar.
  try{
    const { data, error } = await withTimeout(window.supabaseClient.auth.getSession());
    if(error) throw error;
    authSession = data.session;
  }catch(e){
    console.warn('Não foi possível ler a sessão:', e);
    authSession = null;
  }

  if(authSession) await finishLogin();
  else showLogin('');
}

async function doLogin(){
  const usuario = $('#login-usuario').value.trim().toLowerCase();
  const password = $('#login-password').value;
  const error = $('#login-error');
  error.textContent = '';

  if(!usuario || !password){
    error.textContent = 'Informe usuário e senha para entrar.';
    return;
  }
  if(!db || !window.supabaseClient){
    error.textContent = 'O Supabase está indisponível. Recarregue a página e tente novamente.';
    return;
  }

  const button = $('#login-btn');
  if(button) button.disabled = true;
  error.textContent = 'Entrando...';

  try{
    const email = `${usuario}@nexlog.app`;
    const { data, error:authError } = await withTimeout(
      window.supabaseClient.auth.signInWithPassword({ email, password })
    );

    if(authError || !data.session){
      error.textContent = 'Usuário ou senha inválidos.';
      return;
    }

    authSession = data.session;
    await finishLogin();
  }catch(e){
    console.error('Erro no login:', e);
    showLogin('Não foi possível concluir o login. Verifique sua conexão e tente novamente.');
  }finally{
    if(button) button.disabled = false;
  }
}

async function finishLogin(){
  try{
    if(!authSession || !authSession.user) throw new Error('Sessão de autenticação não encontrada.');

    const result = await withTimeout(db.collection('users').limit(100).get());
    const emailUsuario = authSession.user.email.split('@')[0].toLowerCase();
    const account = result.docs.map(normalizeDoc).find(user=>
      user.usuario?.toLowerCase() === emailUsuario && user.status !== 'Inativo'
    );

    if(!account){
      await window.supabaseClient.auth.signOut();
      authSession = null;
      showLogin('Perfil de usuário não encontrado.');
      return;
    }

    CUR = { name: account.nome, role: account.perfil, usuario: account.usuario };
    const setTxt = (sel, txt)=>{ const el = $(sel); if(el) el.textContent = txt; };
    setTxt('#user-name-lbl', CUR.name);
    setTxt('#user-role-lbl', CUR.role);
    setTxt('#user-avatar', CUR.name.charAt(0).toUpperCase());
    setTxt('#top-avatar', CUR.name.charAt(0).toUpperCase());
    applyPermissions();

    // O banco pode estar temporariamente indisponível. Isso não deve gerar tela preta.
    try{
      await withTimeout(seedDemoData());
      await withTimeout(seedOperationalData());
    }catch(e){
      console.warn('Dados iniciais não carregados:', e);
      toast('Conectado, mas o banco demorou para carregar.');
    }

    showApp();
    subscribeAll();

  }catch(e){
    console.error('Erro ao carregar o perfil/sistema:', e);
    showLogin('A sessão foi recuperada, mas não foi possível carregar o sistema. Tente novamente.');
  }
}

async function doLogout(signOut=true){
  if(signOut && window.supabaseClient){
    try{ await window.supabaseClient.auth.signOut(); }catch(e){ console.warn('Erro ao sair:', e); }
  }
  authSession = null;
  CUR = { name:'', role:'Administrador', usuario:'' };
  showLogin('');
  const p = $('#login-password'); if(p) p.value='';
}

function applyPermissions(){
  const access={
    Administrador:['dashboard','os','planejamento','clientes','materiais','ferramentas','cnc','indicadores','pendencias','notificacoes','usuarios'],
    Atendimento:['dashboard','os','planejamento','clientes','notificacoes'],
    Produção:['dashboard','os','planejamento','materiais','ferramentas','cnc','pendencias','notificacoes'],
    Estoque:['dashboard','os','materiais','ferramentas','pendencias','notificacoes'],
    Qualidade:['dashboard','os','pendencias','notificacoes','indicadores'],
    Instalação:['dashboard','os','planejamento','ferramentas','pendencias','notificacoes'],
    'Pós-venda':['dashboard','os','pendencias','notificacoes','indicadores']
  };
  const allowed=access[CUR.role]||access.Administrador;
  $$('.navitem').forEach(item=>item.style.display=allowed.includes(item.dataset.view)?'flex':'none');
  if(!allowed.includes(VIEW)){VIEW='dashboard';}
}

on('#logout-btn', 'click', ()=>doLogout());
function setMobileMenu(open){
  const sb = $('#sidebar'), ov = $('#mobile-overlay');
  if(sb) sb.classList.toggle('open', open);
  if(ov){ ov.classList.toggle('show', open); ov.setAttribute('aria-hidden', String(!open)); }
}
on('#menu-toggle', 'click', ()=>{ const sb = $('#sidebar'); setMobileMenu(!(sb && sb.classList.contains('open'))); });
on('#mobile-overlay', 'click', ()=>setMobileMenu(false));

/* ---------------- LIVE SUBSCRIPTIONS ---------------- */
function subscribeAll(){
  if(!db) return;
  db.collection('clients').orderBy('nome').onSnapshot(snap => {
    STATE.clients = snap.docs.map(normalizeDoc);
    renderView();
  }, err=> toast('Erro ao carregar clientes: '+(err.code||err.message)));

  db.collection('materials').orderBy('nome').onSnapshot(snap=>{
    STATE.materials = snap.docs.map(normalizeDoc);
    renderView();
  }, err=> toast('Erro ao carregar materiais: '+(err.code||err.message)));

  db.collection('service_orders').orderBy('numero','desc').onSnapshot(snap=>{
    STATE.orders = snap.docs.map(normalizeDoc);
    if(STATE.orders.length===0 && STATE._seedTried!==true){
      STATE._seedTried = true;
      seedDemoData();
    }
    renderView();
  }, err=> toast('Erro ao carregar OS: '+(err.code||err.message)));

  ['tools','cnc','notifications','users'].forEach(name=>{
    db.collection(name).orderBy('created_at','desc').onSnapshot(snap=>{
      STATE[name] = snap.docs.map(normalizeDoc);
      renderView();
    }, err=> toast('Erro ao carregar '+name+': '+(err.code||err.message)));
  });
}

/* ---------------- SEED (apenas se banco vazio) ---------------- */
async function seedDemoData(){
  if(!db) return;
  const existingClients = await db.collection('clients').limit(1).get();
  if(existingClients.docs.length===0){
    const c1 = await db.collection('clients').add({nome:'Empresa ABC', contato:'Marcos Lima', telefone:'(24) 99900-1122', endereco:'Av. Central, 480 - Barra do Piraí/RJ'});
    const c2 = await db.collection('clients').add({nome:'Empresa XYZ', contato:'Renata Souza', telefone:'(24) 99911-3344', endereco:'Rua das Flores, 12 - Volta Redonda/RJ'});
    const c3 = await db.collection('clients').add({nome:'Loja Central', contato:'Paulo Vieira', telefone:'(24) 99922-5566', endereco:'Praça XV, 90 - Barra do Piraí/RJ'});
    const mats = [
      {codigo:'MAT-001', nome:'ACM 3mm branco', unidade:'chapa', estoque_minimo:10, estoque_fisico:20, reservado:8},
      {codigo:'MAT-002', nome:'Acrílico 4mm transparente', unidade:'placa', estoque_minimo:5, estoque_fisico:9, reservado:2},
      {codigo:'MAT-003', nome:'Parafuso autobrocante', unidade:'unidade', estoque_minimo:100, estoque_fisico:400, reservado:40},
      {codigo:'MAT-004', nome:'Bucha de nylon', unidade:'unidade', estoque_minimo:100, estoque_fisico:120, reservado:40},
      {codigo:'MAT-005', nome:'Silicone branco', unidade:'tubo', estoque_minimo:5, estoque_fisico:4, reservado:2},
    ];
    const matIds = [];
    for(const m of mats){ const r = await db.collection('materials').add(m); matIds.push({id:r.id, ...m}); }

    const mk = (codeIdx, qtd)=>({material_id: matIds[codeIdx].id, nome: matIds[codeIdx].nome, unidade: matIds[codeIdx].unidade, qtd_necessaria: qtd, qtd_reservada:0, qtd_separada:0, qtd_utilizada:0});

    const os1 = {
      numero:'0048', cliente_id:c1.id, cliente_nome:'Empresa ABC', servico:'Fachada comercial',
      descricao:'Fachada em ACM com letreiro luminoso', responsavel:'João Almeida', prioridade:'Alta',
      prazo: addDays(3), data_producao: addDays(1), data_instalacao: addDays(3),
      endereco:'Av. Central, 480 - Barra do Piraí/RJ', observacoes:'',
      status:'materiais', producao_status:'aguardando', qualidade_status:'aguardando', instalacao_status:'aguardando',
      materiais:[mk(0,3), mk(2,40), mk(3,40), mk(4,2)],
      historico:[{data: nowStr(), usuario:'Sistema', acao:'OS cadastrada (dados de demonstração).'}],
      posvenda:{avaliacao:0, comentario:'', problema:false, status:'—'},
      created_at: Date.now()
    };
    const os2 = {
      numero:'0049', cliente_id:c2.id, cliente_nome:'Empresa XYZ', servico:'Comunicação visual',
      descricao:'Adesivagem de frota', responsavel:'Marina Costa', prioridade:'Média',
      prazo: addDays(6), data_producao: addDays(2), data_instalacao: addDays(6),
      endereco:'Rua das Flores, 12 - Volta Redonda/RJ', observacoes:'',
      status:'producao', producao_status:'em_producao', qualidade_status:'aguardando', instalacao_status:'aguardando',
      materiais:[mk(1,2)],
      historico:[{data: nowStr(), usuario:'Sistema', acao:'OS cadastrada (dados de demonstração).'},{data:nowStr(), usuario:'Sistema', acao:'Produção iniciada.'}],
      posvenda:{avaliacao:0, comentario:'', problema:false, status:'—'},
      created_at: Date.now()-1000
    };
    const os3 = {
      numero:'0050', cliente_id:c3.id, cliente_nome:'Loja Central', servico:'Placa externa',
      descricao:'Placa luminosa de fachada', responsavel:'João Almeida', prioridade:'Baixa',
      prazo: addDays(-1), data_producao: addDays(-3), data_instalacao: addDays(-1),
      endereco:'Praça XV, 90 - Barra do Piraí/RJ', observacoes:'',
      status:'qualidade', producao_status:'concluida', qualidade_status:'reprovado', qualidade_motivo:'Medida da placa divergente do projeto.',
      instalacao_status:'aguardando',
      materiais:[mk(0,1)],
      historico:[{data:nowStr(),usuario:'Sistema',acao:'OS cadastrada (dados de demonstração).'},{data:nowStr(),usuario:'Sistema',acao:'Produção concluída.'},{data:nowStr(),usuario:'Sistema',acao:'Qualidade reprovou a OS.'}],
      posvenda:{avaliacao:0, comentario:'', problema:false, status:'—'},
      created_at: Date.now()-2000
    };
    await db.collection('service_orders').add(os1);
    await db.collection('service_orders').add(os2);
    await db.collection('service_orders').add(os3);
  }
}
async function seedOperationalData(){
  if(!db) return;
  const tools = await db.collection('tools').limit(1).get();
  if(!tools.docs.length){
    const demoTools = [
      {codigo:'FER-001', nome:'Furadeira de impacto', quantidade:2, disponivel:2, estado:'Boa', manutencao:'Em dia', responsavel:'Estoque', created_at:Date.now()},
      {codigo:'FER-002', nome:'Parafusadeira', quantidade:3, disponivel:2, estado:'Boa', manutencao:'Em dia', responsavel:'Estoque', created_at:Date.now()-1},
      {codigo:'FER-003', nome:'Escada extensiva', quantidade:1, disponivel:1, estado:'Boa', manutencao:'Em dia', responsavel:'Estoque', created_at:Date.now()-2}
    ];
    for(const tool of demoTools) await db.collection('tools').add(tool);
  }
  const users = await db.collection('users').limit(100).get();
  if(!users.docs.length){
    for(const user of [
      {nome:'Administrador', usuario:'admin', perfil:'Administrador', status:'Ativo', created_at:Date.now()},
      {nome:'Equipe de Produção', usuario:'producao', perfil:'Produção', status:'Ativo', created_at:Date.now()-1},
      {nome:'Equipe de Qualidade', usuario:'qualidade', perfil:'Qualidade', status:'Ativo', created_at:Date.now()-2}
    ]) await db.collection('users').add(user);
  }
}
function addDays(n){ const d = new Date(); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }

/* ---------------- NAV ---------------- */
$$('.navitem').forEach(el=>{
  el.addEventListener('click', ()=>{
    VIEW = el.dataset.view; OS_OPEN=null;
    setMobileMenu(false);
    renderView();
  });
});

function setActiveNav(){
  $$('.navitem').forEach(n=>n.classList.toggle('active', n.dataset.view===VIEW));
}

/* ---------------- DERIVED HELPERS ---------------- */
function materialDisponivel(m){ return (m.estoque_fisico||0) - (m.reservado||0); }
function materialSituacao(m){
  const disp = materialDisponivel(m);
  if(disp <= 0) return 'red';
  if(disp < (m.estoque_minimo||0)) return 'yellow';
  return 'green';
}
function osPrazoStatus(os){
  if(!os.prazo) return 'grey';
  if(['concluido'].includes(os.status)) return 'green';
  const today = new Date(); today.setHours(0,0,0,0);
  const prazo = new Date(os.prazo+'T00:00:00');
  const diff = (prazo-today)/86400000;
  if(diff < 0) return 'red';
  if(diff <= 2) return 'yellow';
  return 'green';
}
function osMateriaisOk(os){ return (os.materiais||[]).every(m => m.qtd_reservada >= m.qtd_necessaria); }
function osMateriaisSeparadosOk(os){ return (os.materiais||[]).every(m => m.qtd_separada >= m.qtd_necessaria); }
function gatesFor(os){
  const linkedTools = (os.ferramentas||[]).map(id=>STATE.tools.find(t=>t.id===id));
  const toolsOk = linkedTools.length>0 && linkedTools.every(t=>t && Number(t.disponivel)>0);
  const installationBasics = [
    !toolsOk ? 'Ferramentas não conferidas ou indisponíveis' : null,
    !os.equipe ? 'Equipe não definida' : null,
    !os.endereco ? 'Endereço não confirmado' : null
  ].filter(Boolean);
  return {
    producao: { ok: !!os.responsavel && osMateriaisOk(os), reasons: [
      !os.responsavel ? 'Responsável não definido' : null,
      !osMateriaisOk(os) ? 'Materiais ainda não reservados/disponíveis' : null,
    ].filter(Boolean)},
    qualidade: { ok: os.producao_status==='concluida', reasons: [ os.producao_status!=='concluida' ? 'Produção ainda não foi concluída' : null].filter(Boolean)},
    instalacao: { ok: os.qualidade_status==='aprovado' && osMateriaisSeparadosOk(os) && installationBasics.length===0, reasons: [
      os.qualidade_status!=='aprovado' ? 'Qualidade ainda não foi aprovada' : null,
      !osMateriaisSeparadosOk(os) ? 'Materiais ainda não separados' : null,
      ...installationBasics
    ].filter(Boolean)},
    encerramento: { ok: os.instalacao_status==='concluida', reasons: [ os.instalacao_status!=='concluida' ? 'Instalação ainda não foi concluída' : null].filter(Boolean)}
  };
}
function pendencias(){
  const list = [];
  STATE.orders.forEach(os=>{
    (os.materiais||[]).forEach(m=>{
      const mat = STATE.materials.find(x=>x.id===m.material_id);
      if(mat && materialDisponivel(mat) < m.qtd_necessaria && os.status!=='concluido'){
        list.push({level:'red', text:`Material insuficiente: ${m.nome} para OS ${os.numero}`, os:os.id});
      }
    });
    if(os.qualidade_status==='reprovado'){
      list.push({level:'red', text:`Qualidade reprovada — OS ${os.numero}`, os:os.id});
    }
    if(osPrazoStatus(os)==='red' && os.status!=='concluido'){
      list.push({level:'red', text:`OS ${os.numero} está atrasada`, os:os.id});
    } else if(osPrazoStatus(os)==='yellow' && os.status!=='concluido'){
      list.push({level:'orange', text:`OS ${os.numero} próxima do prazo`, os:os.id});
    }
    if(os.status==='posvenda' && (os.posvenda?.status==='—' || !os.posvenda?.status)){
      list.push({level:'yellow', text:`Pós-venda sem resposta — OS ${os.numero}`, os:os.id});
    }
  });
  return list;
}
function statusLabel(s){
  return {pedido:'Pedido',planejamento:'Planejamento',materiais:'Materiais',producao:'Produção',qualidade:'Qualidade',instalacao:'Instalação',posvenda:'Pós-venda',concluido:'Concluída'}[s] || s;
}

/* ---------------- RENDER ROUTER ---------------- */
function renderView(){
  setActiveNav();
  const c = $('#content');
  if(!c) return;
  if(OS_OPEN){ renderOSDetail(); return; }
  const head = (t,s)=>{ const a=$('#view-title'), b=$('#view-sub'); if(a) a.textContent=t; if(b) b.textContent=s; };
  if(VIEW==='dashboard'){ head('Dashboard','Visão geral da operação em tempo real'); c.innerHTML = viewDashboard(); bindDashboard(); }
  else if(VIEW==='os'){ head('Ordens de Serviço','Todas as OS cadastradas no sistema'); c.innerHTML = viewOSList(); bindOSList(); }
  else if(VIEW==='clientes'){ head('Clientes','Cadastro de clientes'); c.innerHTML = viewClientes(); bindClientes(); }
  else if(VIEW==='materiais'){ head('Materiais & Estoque','Catálogo, estoque físico e reservas'); c.innerHTML = viewMateriais(); bindMateriais(); }
  else if(VIEW==='planejamento'){ head('Planejamento','Fila operacional e programação das equipes'); c.innerHTML = viewPlanejamento(); bindPlanejamento(); }
  else if(VIEW==='ferramentas'){ head('Ferramentas','Disponibilidade, estado e manutenção'); c.innerHTML = viewFerramentas(); bindFerramentas(); }
  else if(VIEW==='cnc'){ head('Terceirização / CNC','Serviços externos vinculados às OS'); c.innerHTML = viewCnc(); bindCnc(); }
  else if(VIEW==='indicadores'){ head('Indicadores','Dados calculados a partir das OS cadastradas'); c.innerHTML = viewIndicadores(); }
  else if(VIEW==='pendencias'){ head('Pendências','Itens que exigem atenção agora'); c.innerHTML = viewPendencias(); bindPendList(); }
  else if(VIEW==='notificacoes'){ head('Notificações','Alertas gerados pelo andamento da operação'); c.innerHTML = viewNotificacoes(); bindNotificacoes(); }
  else if(VIEW==='usuarios'){ head('Usuários','Perfis e permissões de acesso'); c.innerHTML = viewUsuarios(); bindUsuarios(); }
}

/* ================= DASHBOARD ================= */
function viewDashboard(){
  const total = STATE.orders.length;
  const emProducao = STATE.orders.filter(o=>o.producao_status==='em_producao').length;
  const instalacoes = STATE.orders.filter(o=>o.status==='instalacao' || o.instalacao_status==='em_andamento').length;
  const atrasadas = STATE.orders.filter(o=>osPrazoStatus(o)==='red' && o.status!=='concluido').length;
  const matInsuf = new Set();
  STATE.orders.forEach(os=>(os.materiais||[]).forEach(m=>{
    const mat = STATE.materials.find(x=>x.id===m.material_id);
    if(mat && materialDisponivel(mat) < m.qtd_necessaria) matInsuf.add(os.id);
  }));
  const qualidadeAguardando = STATE.orders.filter(o=>o.producao_status==='concluida' && o.qualidade_status==='aguardando').length;
  const posvendaPend = STATE.orders.filter(o=>o.status==='posvenda' && (!o.posvenda?.status || o.posvenda.status==='—')).length;

  const stageCounts = {pedido:0,planejamento:0,materiais:0,producao:0,qualidade:0,instalacao:0,posvenda:0,concluido:0};
  STATE.orders.forEach(o=> stageCounts[o.status] = (stageCounts[o.status]||0)+1);
  const maxStage = Math.max(1,...Object.values(stageCounts));

  const pend = pendencias().slice(0,6);

  return `
  <div class="kpi-grid">
    <div class="kpi"><div class="n">${total}</div><div class="l">Total de Ordens de Serviço</div></div>
    <div class="kpi ok"><div class="n">${emProducao}</div><div class="l">Em produção</div></div>
    <div class="kpi"><div class="n">${instalacoes}</div><div class="l">Instalações em curso</div></div>
    <div class="kpi ${atrasadas>0?'danger':''}"><div class="n">${atrasadas}</div><div class="l">Serviços atrasados</div></div>
    <div class="kpi ${matInsuf.size>0?'danger':''}"><div class="n">${matInsuf.size}</div><div class="l">OS com material insuficiente</div></div>
    <div class="kpi ${qualidadeAguardando>0?'warn':''}"><div class="n">${qualidadeAguardando}</div><div class="l">Aguardando qualidade</div></div>
    <div class="kpi ${STATE.cnc.some(c=>!['Aprovado','Recebido'].includes(c.status))?'warn':''}"><div class="n">${STATE.cnc.filter(c=>!['Aprovado','Recebido'].includes(c.status)).length}</div><div class="l">CNC em acompanhamento</div></div>
    <div class="kpi ${posvendaPend>0?'warn':''}"><div class="n">${posvendaPend}</div><div class="l">Pós-vendas pendentes</div></div>
  </div>
  <div class="row2">
    <div class="panel">
      <h2>Serviços por etapa <small>— contagem real das OS cadastradas</small></h2>
      ${Object.entries(stageCounts).map(([k,v])=>`
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
          <div style="width:100px;font-size:12.5px;color:var(--ink2);">${statusLabel(k)}</div>
          <div style="flex:1;background:var(--grey-bg);border-radius:6px;height:16px;overflow:hidden;">
            <div style="width:${(v/maxStage*100)}%;background:var(--blue);height:100%;"></div>
          </div>
          <div style="width:24px;text-align:right;font-family:'IBM Plex Mono';font-size:12.5px;">${v}</div>
        </div>`).join('')}
    </div>
    <div class="panel">
      <h2>Pendências <small>— toque para abrir a OS</small></h2>
      ${pend.length? pend.map(p=>`
        <div class="pend-item" data-os="${p.os}">
          <span class="pend-badge ${p.level}"></span>
          <span class="t">${p.text}</span>
        </div>`).join('') : '<div class="empty">Nenhuma pendência no momento.</div>'}
      ${pendencias().length>6?`<div style="text-align:right;margin-top:8px;"><span class="btn ghost sm" data-view="pendencias">Ver todas →</span></div>`:''}
    </div>
  </div>`;
}
function bindDashboard(){
  $$('.pend-item').forEach(el=>el.addEventListener('click', ()=>{ OS_OPEN = el.dataset.os; OS_TAB='resumo'; renderView(); }));
  const more = $('#content [data-view="pendencias"]'); if(more) more.addEventListener('click', ()=>{VIEW='pendencias'; renderView();});
}

/* ================= PENDÊNCIAS (full) ================= */
function viewPendencias(){
  const all = pendencias();
  const groups = {red:'Críticas', orange:'Alta prioridade', yellow:'Acompanhamento'};
  return Object.keys(groups).map(lv=>{
    const items = all.filter(p=>p.level===lv);
    return `<div class="panel"><h2>${groups[lv]} <small>${items.length} item(ns)</small></h2>
      ${items.length? items.map(p=>`<div class="pend-item" data-os="${p.os}"><span class="pend-badge ${p.level}"></span><span class="t">${p.text}</span></div>`).join('') : '<div class="empty">Nada por aqui.</div>'}
    </div>`;
  }).join('');
}
function bindPendList(){ $$('.pend-item').forEach(el=>el.addEventListener('click', ()=>{ OS_OPEN = el.dataset.os; OS_TAB='resumo'; renderView(); })); }

/* ================= CLIENTES ================= */
function viewClientes(){
  return `
  <div class="toolbar"><div class="toolbar-left"><input class="filter-input" id="cli-search" placeholder="Buscar cliente..." style="width:240px;"></div>
    <button class="btn primary" id="cli-new">+ Novo cliente</button></div>
  <div class="panel" style="padding:0;">
    <table><thead><tr><th>Nome</th><th>Contato</th><th>Telefone</th><th>Endereço</th><th>OS vinculadas</th><th></th></tr></thead>
    <tbody id="cli-tbody"></tbody></table>
  </div>`;
}
function renderCliTbody(filter=''){
  const rows = STATE.clients.filter(c => (c?.nome || '').toLowerCase().includes(filter.toLowerCase()));
  $('#cli-tbody').innerHTML = rows.length? rows.map(c=>{
    const n = STATE.orders.filter(o=>o.cliente_id===c.id).length;
    return `<tr>
      <td><b>${toText(c?.nome)}</b></td><td>${toText(c?.contato)}</td><td>${toText(c?.telefone)}</td><td style="color:var(--ink2);">${toText(c?.endereco)}</td>
      <td>${n}</td>
      <td style="text-align:right;"><button class="btn sm ghost" data-edit="${c.id}">Editar</button> <button class="btn sm ghost" data-del="${c.id}">Excluir</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">Nenhum cliente encontrado.</td></tr>`;
  $$('[data-edit]', $('#cli-tbody')).forEach(b=>b.addEventListener('click', ()=>openClienteModal(b.dataset.edit)));
  $$('[data-del]', $('#cli-tbody')).forEach(b=>b.addEventListener('click', ()=>delCliente(b.dataset.del)));
}
function bindClientes(){
  renderCliTbody();
  $('#cli-search').addEventListener('input', e=>renderCliTbody(e.target.value));
  $('#cli-new').addEventListener('click', ()=>openClienteModal());
}
function openClienteModal(id){
  const c = id? STATE.clients.find(x=>x.id===id) : {nome:'',contato:'',telefone:'',endereco:''};
  $('#modal-inner').innerHTML = `
    <h3>${id?'Editar cliente':'Novo cliente'}</h3><div class="msub">Dados salvos no banco em tempo real.</div>
    <div class="form-grid">
      <div class="full"><label>Nome / Razão social</label><input id="f-nome" value="${c.nome||''}"></div>
      <div><label>Contato</label><input id="f-contato" value="${c.contato||''}"></div>
      <div><label>Telefone</label><input id="f-telefone" value="${c.telefone||''}"></div>
      <div class="full"><label>Endereço</label><input id="f-endereco" value="${c.endereco||''}"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Salvar</button></div>`;
  showModal();
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async ()=>{
    const data = { nome:$('#f-nome').value.trim(), contato:$('#f-contato').value.trim(), telefone:$('#f-telefone').value.trim(), endereco:$('#f-endereco').value.trim() };
    if(!data.nome){ toast('Informe o nome do cliente.'); return; }
    if(!db){ toast('Banco indisponível.'); return; }
    if(id){ await db.collection('clients').doc(id).update(data); toast('Cliente atualizado.'); }
    else { await db.collection('clients').add(data); toast('Cliente cadastrado.'); }
    closeModal();
  });
}
async function delCliente(id){
  if(!confirm('Excluir este cliente? OS já vinculadas não serão apagadas.')) return;
  await db.collection('clients').doc(id).delete();
  toast('Cliente excluído.');
}

/* ================= MATERIAIS / ESTOQUE ================= */
function viewMateriais(){
  return `
  <div class="toolbar"><div class="toolbar-left"><input class="filter-input" id="mat-search" placeholder="Buscar material..." style="width:240px;">
    <select class="filter-select" id="mat-filter"><option value="">Todas as situações</option><option value="red">Insuficiente</option><option value="yellow">Abaixo do mínimo</option><option value="green">Disponível</option></select></div>
    <button class="btn primary" id="mat-new">+ Novo material</button></div>
  <div class="panel" style="padding:0;">
    <table><thead><tr><th class="mono">Código</th><th>Material</th><th>Unid.</th><th>Físico</th><th>Reservado</th><th>Disponível</th><th>Mín.</th><th>Situação</th><th></th></tr></thead>
    <tbody id="mat-tbody"></tbody></table>
  </div>`;
}
function renderMatTbody(){
  const q = ($('#mat-search')?.value||'').toLowerCase();
  const f = $('#mat-filter')?.value||'';
  const rows = STATE.materials.filter(m => (m?.nome || '').toLowerCase().includes(q) && (!f || materialSituacao(m)===f) );
  $('#mat-tbody').innerHTML = rows.length? rows.map(m=>{
    const disp = materialDisponivel(m); const sit = materialSituacao(m);
    const sitLabel = sit==='red'?'Insuficiente':sit==='yellow'?'Abaixo do mínimo':'Disponível';
    return `<tr>
      <td class="mono">${toText(m?.codigo)}</td><td><b>${toText(m?.nome)}</b></td><td>${toText(m?.unidade)}</td>
      <td>${toText(m?.estoque_fisico)}</td><td>${toText(m?.reservado)}</td><td><b>${disp}</b></td><td>${toText(m?.estoque_minimo)}</td>
      <td><span class="chip ${sit}">${sitLabel}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn sm ghost" data-mov="${m.id}">Movimentar</button>
        <button class="btn sm ghost" data-edit="${m.id}">Editar</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="empty">Nenhum material encontrado.</td></tr>`;
  $$('[data-edit]', $('#mat-tbody')).forEach(b=>b.addEventListener('click', ()=>openMaterialModal(b.dataset.edit)));
  $$('[data-mov]', $('#mat-tbody')).forEach(b=>b.addEventListener('click', ()=>openMovModal(b.dataset.mov)));
}
function bindMateriais(){
  renderMatTbody();
  $('#mat-search').addEventListener('input', renderMatTbody);
  $('#mat-filter').addEventListener('change', renderMatTbody);
  $('#mat-new').addEventListener('click', ()=>openMaterialModal());
}
function openMaterialModal(id){
  const m = id? STATE.materials.find(x=>x.id===id) : {codigo:'',nome:'',unidade:'',estoque_minimo:0,estoque_fisico:0,reservado:0};
  $('#modal-inner').innerHTML = `
    <h3>${id?'Editar material':'Novo material'}</h3><div class="msub">Catálogo geral — evite duplicar materiais com nomes parecidos.</div>
    <div class="form-grid">
      <div><label>Código</label><input id="f-codigo" value="${m.codigo}"></div>
      <div><label>Unidade</label><input id="f-unidade" value="${m.unidade}" placeholder="chapa, tubo, unidade..."></div>
      <div class="full"><label>Nome</label><input id="f-nome" value="${m.nome}"></div>
      <div><label>Estoque mínimo</label><input id="f-min" type="number" value="${m.estoque_minimo}"></div>
      <div><label>Estoque físico inicial</label><input id="f-fisico" type="number" value="${m.estoque_fisico}" ${id?'disabled':''}></div>
    </div>
    ${id?'<div class="msub" style="margin-top:10px;">Para alterar o estoque físico, use o botão "Movimentar" na lista.</div>':''}
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Salvar</button></div>`;
  showModal();
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async ()=>{
    const data = { codigo:$('#f-codigo').value.trim(), nome:$('#f-nome').value.trim(), unidade:$('#f-unidade').value.trim(), estoque_minimo:Number($('#f-min').value)||0 };
    if(!data.nome || !data.codigo){ toast('Informe código e nome.'); return; }
    if(id){ await db.collection('materials').doc(id).update(data); toast('Material atualizado.'); }
    else { data.estoque_fisico = Number($('#f-fisico').value)||0; data.reservado = 0; await db.collection('materials').add(data); toast('Material cadastrado.'); }
    closeModal();
  });
}
function openMovModal(id){
  const m = STATE.materials.find(x=>x.id===id);
  $('#modal-inner').innerHTML = `
    <h3>Movimentar estoque — ${m.nome}</h3>
    <div class="msub">Disponível = Estoque físico (${m.estoque_fisico}) − Reservado (${m.reservado}) = <b>${materialDisponivel(m)}</b></div>
    <div class="form-grid">
      <div><label>Tipo de movimentação</label>
        <select id="f-tipo"><option value="entrada">Entrada (compra recebida)</option><option value="saida">Saída (ajuste/perda)</option></select>
      </div>
      <div><label>Quantidade</label><input id="f-qtd" type="number" min="1" value="1"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Registrar</button></div>`;
  showModal();
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async ()=>{
    const tipo = $('#f-tipo').value; const qtd = Number($('#f-qtd').value)||0;
    if(qtd<=0){ toast('Informe uma quantidade válida.'); return; }
    let novoFisico = m.estoque_fisico + (tipo==='entrada'? qtd : -qtd);
    if(novoFisico < m.reservado){ toast('Saída inválida: deixaria o estoque físico abaixo do reservado.'); return; }
    await db.collection('materials').doc(id).update({ estoque_fisico: novoFisico });
    toast(tipo==='entrada'? 'Entrada registrada.' : 'Saída registrada.');
    closeModal();
  });
}

/* ================= ORDENS DE SERVIÇO — LISTA ================= */
function viewOSList(){
  return `
  <div class="toolbar">
    <div class="toolbar-left">
      <input class="filter-input" id="os-search" placeholder="Buscar por número, cliente, serviço..." style="width:260px;">
      <select class="filter-select" id="os-status"><option value="">Todas as etapas</option>
        ${['pedido','planejamento','materiais','producao','qualidade','instalacao','posvenda','concluido'].map(s=>`<option value="${s}">${statusLabel(s)}</option>`).join('')}
      </select>
      <select class="filter-select" id="os-prior"><option value="">Toda prioridade</option><option>Alta</option><option>Média</option><option>Baixa</option></select>
    </div>
    <button class="btn primary" id="os-new">+ Nova Ordem de Serviço</button>
  </div>
  <div class="panel" style="padding:0;">
    <table><thead><tr><th>OS</th><th>Cliente</th><th>Serviço</th><th>Responsável</th><th>Prazo</th><th>Etapa</th><th>Prioridade</th></tr></thead>
    <tbody id="os-tbody"></tbody></table>
  </div>`;
}
function renderOSTbody(){
  const q = ($('#os-search')?.value||'').toLowerCase();
  const st = $('#os-status')?.value||''; const pr = $('#os-prior')?.value||'';
  let rows = STATE.orders.filter(o=>{
    const hit = !q || (o?.numero||'').toString().includes(q) || (o?.cliente_nome||'').toLowerCase().includes(q) || (o?.servico||'').toLowerCase().includes(q) || (o?.responsavel||'').toLowerCase().includes(q);
    return hit && (!st || o.status===st) && (!pr || o.prioridade===pr);
  });
  $('#os-tbody').innerHTML = rows.length? rows.map(o=>{
    const pz = osPrazoStatus(o);
    return `<tr class="rowlink" data-os="${o.id}">
      <td class="osnum">OS ${toText(o?.numero)}</td><td>${toText(o?.cliente_nome)}</td><td>${toText(o?.servico)}</td><td>${toText(o?.responsavel)}</td>
      <td><span class="chip ${pz}">${fmtDate(o?.prazo)}</span></td>
      <td><span class="chip blue">${statusLabel(o?.status)}</span></td>
      <td>${toText(o?.prioridade)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="empty">Nenhuma OS encontrada.</td></tr>`;
  $$('.rowlink', $('#os-tbody')).forEach(tr=>tr.addEventListener('click', ()=>{ OS_OPEN = tr.dataset.os; OS_TAB='resumo'; renderView(); }));
}
function bindOSList(){
  renderOSTbody();
  ['#os-search','#os-status','#os-prior'].forEach(sel=> $(sel).addEventListener('input', renderOSTbody));
  $('#os-new').addEventListener('click', openNewOSModal);
}
function openNewOSModal(){
  if(STATE.clients.length===0){ toast('Cadastre ao menos um cliente antes de criar uma OS.'); VIEW='clientes'; renderView(); return; }
  const nextNum = String(1000 + STATE.orders.length + 1).slice(-4);
  $('#modal-inner').innerHTML = `
    <h3>Nova Ordem de Serviço</h3><div class="msub">A OS é o centro do sistema — materiais, produção, qualidade e instalação giram em torno dela.</div>
    <div class="form-grid">
      <div><label>Cliente</label><select id="f-cliente">${STATE.clients.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('')}</select></div>
      <div><label>Serviço</label><input id="f-servico" placeholder="Ex: Fachada comercial"></div>
      <div class="full"><label>Descrição</label><textarea id="f-desc"></textarea></div>
      <div><label>Responsável</label><input id="f-resp"></div>
      <div><label>Equipe</label><input id="f-equipe" placeholder="Ex: Equipe de instalação A"></div>
      <div><label>Prioridade</label><select id="f-prior"><option>Alta</option><option selected>Média</option><option>Baixa</option></select></div>
      <div><label>Prazo</label><input id="f-prazo" type="date"></div>
      <div><label>Data prevista de produção</label><input id="f-dprod" type="date"></div>
      <div><label>Data prevista de instalação</label><input id="f-dinst" type="date"></div>
      <div class="full"><label>Endereço de instalação</label><input id="f-end"></div>
      <div class="full"><label>Observações</label><textarea id="f-obs"></textarea></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Criar OS ${nextNum}</button></div>`;
  showModal();
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async ()=>{
    const cli = STATE.clients.find(c=>c.id===$('#f-cliente').value);
    const servico = $('#f-servico').value.trim();
    if(!servico){ toast('Informe o serviço.'); return; }
    const data = {
      numero: nextNum, cliente_id: cli.id, cliente_nome: cli.nome, servico,
      descricao: $('#f-desc').value.trim(), responsavel: $('#f-resp').value.trim(), equipe: $('#f-equipe').value.trim(),
      prioridade: $('#f-prior').value, prazo: $('#f-prazo').value, data_producao: $('#f-dprod').value, data_instalacao: $('#f-dinst').value,
      endereco: $('#f-end').value.trim() || cli.endereco || '', observacoes: $('#f-obs').value.trim(),
      status:'pedido', producao_status:'aguardando', qualidade_status:'aguardando', instalacao_status:'aguardando',
      materiais:[], historico:[{data:nowStr(), usuario:CUR.name, acao:'OS cadastrada.'}],
      posvenda:{avaliacao:0, comentario:'', problema:false, status:'—'}, created_at: Date.now()
    };
    const ref = await db.collection('service_orders').add(data);
    toast('OS '+nextNum+' criada.');
    closeModal();
    OS_OPEN = ref.id; OS_TAB='materiais'; renderView();
  });
}

/* ================= OS DETALHE ================= */
function getOS(){ return STATE.orders.find(o=>o.id===OS_OPEN); }
async function osUpdate(patch){ if(!db) return; await db.collection('service_orders').doc(OS_OPEN).update(patch); }
async function osLog(acao){
  const os = getOS(); const hist = (os.historico||[]).concat([{data:nowStr(), usuario:CUR.name, acao}]);
  await osUpdate({historico:hist});
}

function renderOSDetail(){
  const os = getOS();
  if(!os){ OS_OPEN=null; renderView(); return; }
  $('#view-title').textContent = 'OS '+os.numero;
  $('#view-sub').textContent = os.cliente_nome+' · '+os.servico;
  const gates = gatesFor(os);
  const pz = osPrazoStatus(os);

  const tabs = ['resumo','materiais','estoque','ferramentas','producao','cnc','qualidade','retrabalho','instalacao','fotos','ocorrencias','posvenda','historico'];
  const tabLabels = {resumo:'Resumo',materiais:'Materiais',estoque:'Estoque',ferramentas:'Ferramentas',producao:'Produção',cnc:'CNC',qualidade:'Qualidade',retrabalho:'Retrabalho',instalacao:'Instalação',fotos:'Fotos',ocorrencias:'Ocorrências',posvenda:'Pós-venda',historico:'Histórico'};

  let body = '';
  if(OS_TAB==='resumo') body = tabResumo(os, gates, pz);
  else if(OS_TAB==='materiais') body = tabMateriais(os, gates);
  else if(OS_TAB==='estoque') body = tabEstoque(os);
  else if(OS_TAB==='ferramentas') body = tabOSFerramentas(os, gates);
  else if(OS_TAB==='producao') body = tabProducao(os, gates);
  else if(OS_TAB==='cnc') body = tabOSCnc(os);
  else if(OS_TAB==='qualidade') body = tabQualidade(os, gates);
  else if(OS_TAB==='retrabalho') body = tabRetrabalho(os);
  else if(OS_TAB==='instalacao') body = tabInstalacao(os, gates);
  else if(OS_TAB==='fotos') body = tabFotos(os);
  else if(OS_TAB==='ocorrencias') body = tabOcorrencias(os);
  else if(OS_TAB==='posvenda') body = tabPosvenda(os);
  else if(OS_TAB==='historico') body = tabHistorico(os);

  $('#content').innerHTML = `
    <div style="margin-bottom:10px;"><span class="btn ghost sm" id="back-list">← Voltar para Ordens de Serviço</span></div>
    <div class="os-head">
      <div>
        <div class="os-title">OS ${os.numero}</div>
        <div class="os-meta">${os.cliente_nome} · ${os.servico} · Responsável: ${os.responsavel||'—'}</div>
      </div>
      <div style="text-align:right;">
        <span class="chip blue">${statusLabel(os.status)}</span>
        <span class="chip ${pz}">Prazo ${fmtDate(os.prazo)}</span>
      </div>
    </div>
    <div class="tabbar">${tabs.map(t=>`<div class="tabbtn ${OS_TAB===t?'active':''}" data-tab="${t}">${tabLabels[t]}</div>`).join('')}</div>
    <div>${body}</div>
  `;
  $('#back-list').addEventListener('click', ()=>{ OS_OPEN=null; VIEW='os'; renderView(); });
  $$('.tabbtn').forEach(t=>t.addEventListener('click', ()=>{ OS_TAB=t.dataset.tab; renderView(); }));
  bindOSTabEvents(os, gates);
}

function tabResumo(os, gates, pz){
  return `
  <div class="row2">
    <div class="panel">
      <h2>Dados da OS</h2>
      <div class="form-grid" style="font-size:13px;">
        <div><label>Descrição</label><div>${os.descricao||'—'}</div></div>
        <div><label>Prioridade</label><div>${os.prioridade}</div></div>
        <div><label>Data prevista de produção</label><div>${fmtDate(os.data_producao)}</div></div>
        <div><label>Data prevista de instalação</label><div>${fmtDate(os.data_instalacao)}</div></div>
        <div class="full"><label>Endereço de instalação</label><div>${os.endereco||'—'}</div></div>
        <div class="full"><label>Observações</label><div>${os.observacoes||'—'}</div></div>
      </div>
    </div>
    <div class="panel">
      <h2>Status geral</h2>
      <div class="reqline">${os.responsavel? '🟢':'⚪'} Responsável definido</div>
      <div class="reqline">${gates.producao.ok? '🟢':'🔴'} Materiais disponíveis / reservados</div>
      <div class="reqline">${os.producao_status==='concluida'?'🟢':(os.producao_status==='em_producao'?'🟡':'⚪')} Produção ${os.producao_status==='concluida'?'concluída':(os.producao_status==='em_producao'?'em andamento':'não iniciada')}</div>
      <div class="reqline">${os.qualidade_status==='aprovado'?'🟢':(os.qualidade_status==='reprovado'?'🔴':'⚪')} Qualidade ${os.qualidade_status==='aprovado'?'aprovada':os.qualidade_status==='reprovado'?'reprovada':'aguardando'}</div>
      <div class="reqline">${gates.instalacao.ok?'🟢':'⚪'} Instalação ${os.instalacao_status==='concluida'?'concluída':gates.instalacao.ok?'liberada':'bloqueada'}</div>
      <div class="reqline">${os.status==='posvenda'||os.status==='concluido'?'🟢':'⚪'} Pós-venda</div>
    </div>
  </div>`;
}

function tabMateriais(os, gates){
  const rows = (os.materiais||[]).map((m,i)=>{
    const mat = STATE.materials.find(x=>x.id===m.material_id);
    const disp = mat? materialDisponivel(mat) : 0;
    const sit = !mat? 'grey' : disp>=m.qtd_necessaria? 'green' : disp>0? 'yellow' : 'red';
    return `<div class="mat-row">
      <span><b>${m.nome}</b><div style="color:var(--grey);font-size:11.5px;">Disponível no estoque: ${disp} ${m.unidade}</div></span>
      <span>${m.qtd_necessaria} ${m.unidade}</span>
      <span>${m.qtd_reservada}</span>
      <span>${m.qtd_separada}</span>
      <span><span class="chip ${sit}">${sit==='green'?'OK':sit==='yellow'?'Parcial':sit==='red'?'Insuf.':'—'}</span></span>
      <span style="text-align:right;"><button class="btn sm ghost" data-rmmat="${i}">Remover</button></span>
    </div>`;
  }).join('');
  const separatedCount = (os.materiais||[]).filter(m=>m.qtd_separada>=m.qtd_necessaria).length;
  const total = (os.materiais||[]).length;
  return `
  <div class="panel">
    <h2>Materiais necessários <small>${total} item(ns) · ${separatedCount}/${total} separados</small></h2>
    <div class="progress-bar"><div style="width:${total? (separatedCount/total*100):0}%"></div></div>
    <div class="mat-row head"><span>Material</span><span>Necessária</span><span>Reservada</span><span>Separada</span><span>Situação</span><span></span></div>
    ${rows || '<div class="empty">Nenhum material adicionado a esta OS.</div>'}
    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn primary sm" id="add-mat">+ Adicionar material</button>
      <button class="btn green sm" id="reserve-mat" ${gates.producao.ok||total===0?'disabled':''}>Reservar materiais no estoque</button>
      <button class="btn sm" id="separate-mat" ${total===0?'disabled':''}>Marcar todos como separados</button>
    </div>
    ${!gates.producao.ok && total>0 ? `<div class="gate blocked" style="margin-top:12px;">🔒 Produção bloqueada: ${gates.producao.reasons.join('; ')}.</div>` : ''}
  </div>`;
}

function tabEstoque(os){
  const rows=(os.materiais||[]).map(m=>{const mat=STATE.materials.find(x=>x.id===m.material_id);const available=mat?materialDisponivel(mat):0;return `<div class="mat-row"><span><b>${toText(m.nome)}</b></span><span>Necessária ${m.qtd_necessaria}</span><span>Físico ${toText(mat?.estoque_fisico,0)}</span><span>Reservada ${m.qtd_reservada||0}</span><span class="chip ${available>=m.qtd_necessaria?'green':'red'}">Disponível ${available}</span><span>${available<m.qtd_necessaria?`Falta ${m.qtd_necessaria-available}`:'Liberado'}</span></div>`;}).join('');
  return `<div class="panel"><h2>Conferência de estoque <small>disponível = físico - reservado</small></h2><div class="mat-row head"><span>Material</span><span>Necessária</span><span>Físico</span><span>Reservada</span><span>Disponibilidade</span><span>Regra</span></div>${rows||'<div class="empty">Adicione materiais à OS para conferir o estoque.</div>'}</div>`;
}
function tabOSFerramentas(os,gates){
  const selected=os.ferramentas||[];
  return `<div class="panel"><h2>Ferramentas da OS <small>${selected.length} selecionada(s)</small></h2>${selected.length?selected.map((id,i)=>{const t=STATE.tools.find(x=>x.id===id);return `<div class="reqline"><span class="chip ${t&&t.disponivel>0?'green':'red'}">${t&&t.disponivel>0?'OK':'Indisponível'}</span>${toText(t?.nome)} <button class="btn sm ghost" data-os-tool-remove="${i}">Remover</button></div>`;}).join(''):'<div class="empty">Nenhuma ferramenta vinculada.</div>'}<button class="btn primary sm" id="os-tool-add">+ Vincular ferramenta</button>${selected.some(id=>{const t=STATE.tools.find(x=>x.id===id);return !t||t.disponivel<=0;})?'<div class="gate blocked" style="margin-top:12px;">🔒 Instalação bloqueada: ferramenta indisponível.</div>':''}</div>`;
}
function tabOSCnc(os){const items=STATE.cnc.filter(x=>x.os_id===os.id);return `<div class="panel"><h2>Terceirização e CNC</h2>${items.length?items.map(c=>`<div class="reqline"><span class="chip yellow">${toText(c.status)}</span>${toText(c.peca)} · ${toText(c.fornecedor)} · prazo ${fmtDate(c.prazo)}</div>`).join(''):'<div class="empty">Nenhum serviço externo vinculado.</div>'}<button class="btn primary sm" id="os-cnc-add">+ Novo serviço CNC</button></div>`;}
function tabRetrabalho(os){const r=os.retrabalho;return `<div class="panel"><h2>Retrabalho</h2>${r?`<div class="gate ${r.status==='Concluído'?'ok':'blocked'}">${r.status==='Concluído'?'✅ Retrabalho concluído.':'🔧 Retrabalho necessário: '+toText(r.motivo)}</div><div class="form-grid"><div><label>Responsável</label><div>${toText(r.responsavel)}</div></div><div><label>Prazo</label><div>${fmtDate(r.prazo)}</div></div></div>`:'<div class="empty">Nenhum retrabalho registrado para esta OS.</div>'}${r&&r.status!=='Concluído'?'<button class="btn green sm" id="rework-finish">Concluir retrabalho</button>':''}</div>`;}
function tabFotos(os){const photos=os.fotos||[];return `<div class="panel"><h2>Registro fotográfico</h2><div class="form-grid"><div><label>Categoria</label><select id="photo-cat"><option>Antes</option><option>Durante</option><option>Depois</option></select></div><div><label>Descrição / arquivo</label><input id="photo-name" placeholder="Nome ou referência da foto"></div></div><button class="btn primary sm" id="photo-add">+ Registrar foto</button><div class="photo-list">${photos.length?photos.map((p,i)=>`<div class="reqline"><span class="chip blue">${p.categoria}</span>${toText(p.nome)} <button class="btn sm ghost" data-photo-del="${i}">Excluir</button></div>`).join(''):'<div class="empty">Nenhuma foto registrada.</div>'}</div></div>`;}
function tabOcorrencias(os){const items=os.ocorrencias||[];return `<div class="panel"><h2>Ocorrências</h2>${items.length?items.map((o,i)=>`<div class="pend-item"><span class="pend-badge ${o.status==='Resolvida'?'green':'red'}"></span><span class="t"><b>${o.tipo}</b> — ${o.descricao}<small style="display:block;color:var(--grey);">${o.status} · ${o.data}</small></span><button class="btn sm ghost" data-occ-resolve="${i}">${o.status==='Resolvida'?'Resolvida':'Resolver'}</button></div>`).join(''):'<div class="empty">Nenhuma ocorrência registrada.</div>'}<button class="btn primary sm" id="occ-new">+ Registrar ocorrência</button></div>`;}

function tabProducao(os, gates){
  return `
  <div class="panel">
    <h2>Produção</h2>
    ${!gates.producao.ok ? `<div class="gate blocked">🔒 Produção bloqueada: ${gates.producao.reasons.join('; ')}.</div>` : `<div class="gate ok">🟢 Requisitos atendidos — produção pode ser iniciada.</div>`}
    <div style="margin:14px 0;"><span class="chip ${os.producao_status==='concluida'?'green':os.producao_status==='em_producao'?'yellow':os.producao_status==='pausada'?'grey':'grey'}">${
      {aguardando:'Aguardando', em_producao:'Em produção', pausada:'Pausada', concluida:'Concluída'}[os.producao_status]
    }</span></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn primary" id="prod-start" ${!gates.producao.ok || os.producao_status==='em_producao' || os.producao_status==='concluida' ? 'disabled':''}>▶️ Iniciar produção</button>
      <button class="btn" id="prod-pause" ${os.producao_status!=='em_producao'?'disabled':''}>⏸ Pausar</button>
      <button class="btn green" id="prod-finish" ${os.producao_status==='concluida'||os.producao_status==='aguardando'?'disabled':''}>⏹ Finalizar produção</button>
    </div>
    <div style="margin-top:14px;font-size:12.5px;color:var(--ink2);">
      ${os.producao_inicio? 'Início: '+os.producao_inicio : ''} ${os.producao_fim? ' · Fim: '+os.producao_fim : ''}
    </div>
  </div>`;
}

function tabQualidade(os, gates){
  const checkItems = ['Medidas','Acabamento','Estrutura','Fixação','Material','Projeto','Quantidade'];
  return `
  <div class="panel">
    <h2>Inspeção de qualidade</h2>
    ${!gates.qualidade.ok ? `<div class="gate blocked">🔒 Inspeção bloqueada: ${gates.qualidade.reasons.join('; ')}.</div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:14px 0;">
      ${checkItems.map(i=>`<div class="reqline">☐ ${i}</div>`).join('')}
    </div>
    <div style="margin-bottom:14px;"><span class="chip ${os.qualidade_status==='aprovado'?'green':os.qualidade_status==='reprovado'?'red':'grey'}">${
      {aguardando:'Aguardando inspeção', aprovado:'Aprovado', reprovado:'Reprovado'}[os.qualidade_status]
    }</span></div>
    ${os.qualidade_status==='reprovado' && os.qualidade_motivo? `<div class="panel" style="background:var(--red-bg);border-color:transparent;"><b>Motivo da reprovação:</b> ${os.qualidade_motivo}</div>`:''}
    <div style="display:flex;gap:10px;">
      <button class="btn green" id="q-approve" ${!gates.qualidade.ok || os.qualidade_status==='aprovado'?'disabled':''}>✅ Aprovar</button>
      <button class="btn red" id="q-reject" ${!gates.qualidade.ok?'disabled':''}>❌ Reprovar</button>
    </div>
  </div>`;
}

function tabInstalacao(os, gates){
  return `
  <div class="panel">
    <h2>Instalação</h2>
    ${!gates.instalacao.ok ? `<div class="gate blocked">🔒 Instalação bloqueada: ${gates.instalacao.reasons.join('; ')}.</div>` : `<div class="gate ok">🟢 Instalação liberada — todos os requisitos foram atendidos.</div>`}
    <div class="form-grid" style="margin:14px 0;font-size:13px;">
      <div><label>Endereço</label><div>${os.endereco||'—'}</div></div>
      <div><label>Data prevista</label><div>${fmtDate(os.data_instalacao)}</div></div>
    </div>
    <div style="margin-bottom:14px;"><span class="chip ${os.instalacao_status==='concluida'?'green':os.instalacao_status==='em_andamento'?'yellow':'grey'}">${
      {aguardando:'Aguardando', em_andamento:'Em andamento', concluida:'Concluída'}[os.instalacao_status]
    }</span></div>
    <div style="display:flex;gap:10px;">
      <button class="btn primary" id="inst-start" ${!gates.instalacao.ok || os.instalacao_status!=='aguardando'?'disabled':''}>▶️ Iniciar instalação</button>
      <button class="btn green" id="inst-finish" ${os.instalacao_status!=='em_andamento'?'disabled':''}>⏹ Finalizar instalação</button>
    </div>
    <div style="margin-top:14px;font-size:12.5px;color:var(--ink2);">
      ${os.instalacao_inicio? 'Início: '+os.instalacao_inicio : ''} ${os.instalacao_fim? ' · Fim: '+os.instalacao_fim : ''}
    </div>
  </div>`;
}

function tabPosvenda(os){
  const pv = os.posvenda||{avaliacao:0,comentario:'',problema:false,status:'—'};
  if(os.status!=='posvenda' && os.status!=='concluido'){
    return `<div class="panel"><div class="gate blocked">🔒 Pós-venda é aberto automaticamente após a instalação ser finalizada.</div></div>`;
  }
  return `
  <div class="panel">
    <h2>Avaliação do serviço</h2>
    <div style="margin-bottom:12px;">
      ${[1,2,3,4,5].map(n=>`<span data-star="${n}" style="cursor:pointer;font-size:20px;color:${n<=pv.avaliacao?'#E0B93A':'#D7DBE3'};">★</span>`).join('')}
    </div>
    <label style="font-size:12px;font-weight:600;color:var(--ink2);">O serviço apresentou algum problema?</label>
    <div style="margin:8px 0;"><label><input type="checkbox" id="pv-problema" ${pv.problema?'checked':''}> Sim, houve problema</label></div>
    <textarea id="pv-comentario" placeholder="Comentário / descrição do problema" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:10px;min-height:70px;">${pv.comentario||''}</textarea>
    <div style="margin-top:12px;"><label style="font-size:12px;font-weight:600;color:var(--ink2);">Status do atendimento</label>
      <select id="pv-status" style="margin-top:6px;border:1px solid var(--line);border-radius:8px;padding:8px;">
        ${['Aguardando resposta','Respondido','Em atendimento','Resolvido'].map(s=>`<option ${pv.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div style="margin-top:16px;"><button class="btn primary" id="pv-save">Salvar avaliação</button>
    ${os.status!=='concluido'? `<button class="btn green" id="pv-close" style="margin-left:8px;">Encerrar OS</button>`:''}
    </div>
  </div>`;
}

function tabHistorico(os){
  const hist = (os.historico||[]).slice().reverse();
  return `<div class="panel"><h2>Linha do tempo</h2><div class="timeline">
    ${hist.map(h=>`<div class="tl-item"><div class="tl-date">${h.data} — ${h.usuario}</div><div class="tl-text">${h.acao}</div></div>`).join('') || '<div class="empty">Sem eventos ainda.</div>'}
  </div></div>`;
}

function bindOSTabEvents(os, gates){
  if(OS_TAB==='materiais'){
    $('#add-mat')?.addEventListener('click', ()=>openAddMaterialToOS(os));
    $$('[data-rmmat]').forEach(b=>b.addEventListener('click', async ()=>{
      const idx = Number(b.dataset.rmmat);
      const mats = os.materiais.slice(); mats.splice(idx,1);
      await osUpdate({materiais:mats}); await osLog('Material removido da OS.');
    }));
    $('#reserve-mat')?.addEventListener('click', async ()=>{
      const mats = os.materiais.slice();
      let ok = true; const updates = [];
      for(const m of mats){
        const mat = STATE.materials.find(x=>x.id===m.material_id);
        if(!mat || materialDisponivel(mat) < m.qtd_necessaria){ ok=false; continue; }
        updates.push({mat, m});
      }
      if(!ok){ toast('Ainda há materiais insuficientes — não é possível reservar tudo.'); return; }
      for(const {mat,m} of updates){
        await db.collection('materials').doc(mat.id).update({ reservado: (mat.reservado||0) + m.qtd_necessaria });
        m.qtd_reservada = m.qtd_necessaria;
      }
      await osUpdate({materiais:mats, status: os.status==='pedido'||os.status==='planejamento'||os.status==='materiais' ? 'materiais' : os.status});
      await osLog('Materiais reservados no estoque.');
      toast('Materiais reservados.');
    });
    $('#separate-mat')?.addEventListener('click', async ()=>{
      const mats = os.materiais.map(m=>({...m, qtd_separada: m.qtd_reservada}));
      await osUpdate({materiais:mats}); await osLog('Materiais marcados como separados.');
    });
  }
  if(OS_TAB==='ferramentas'){
    $('#os-tool-add')?.addEventListener('click',async()=>{const available=STATE.tools.filter(t=>!(os.ferramentas||[]).includes(t.id));if(!available.length){toast('Cadastre uma ferramenta antes de vincular.');return;}const id=prompt('Informe o código da ferramenta:\n'+available.map(t=>`${t.codigo} — ${t.nome}`).join('\n'));const tool=available.find(t=>t.codigo===id);if(!tool){toast('Código não encontrado.');return;}await osUpdate({ferramentas:[...(os.ferramentas||[]),tool.id]});await osLog('Ferramenta vinculada: '+tool.nome+'.');});
    $$('[data-os-tool-remove]').forEach(b=>b.addEventListener('click',async()=>{const list=(os.ferramentas||[]).slice();list.splice(Number(b.dataset.osToolRemove),1);await osUpdate({ferramentas:list});await osLog('Ferramenta removida da OS.');}));
  }
  if(OS_TAB==='cnc') $('#os-cnc-add')?.addEventListener('click',openCncModal);
  if(OS_TAB==='retrabalho') $('#rework-finish')?.addEventListener('click',async()=>{await osUpdate({retrabalho:{...os.retrabalho,status:'Concluído',data_fim:nowStr()},status:'qualidade',qualidade_status:'aguardando'});await osLog('Retrabalho concluído; OS retornou para qualidade.');toast('OS retornou para qualidade.');});
  if(OS_TAB==='fotos'){
    $('#photo-add')?.addEventListener('click',async()=>{const nome=$('#photo-name').value.trim();if(!nome){toast('Informe a referência da foto.');return;}const fotos=(os.fotos||[]).concat([{categoria:$('#photo-cat').value,nome,data:nowStr(),usuario:CUR.name}]);await osUpdate({fotos});await osLog('Foto registrada: '+nome+'.');});
    $$('[data-photo-del]').forEach(b=>b.addEventListener('click',async()=>{const fotos=(os.fotos||[]).slice();fotos.splice(Number(b.dataset.photoDel),1);await osUpdate({fotos});}));
  }
  if(OS_TAB==='ocorrencias'){
    $('#occ-new')?.addEventListener('click',async()=>{const tipo=prompt('Tipo (Material, Medida, Cliente, Local, Ferramenta, Instalação ou Outro):','Outro');if(!tipo)return;const descricao=prompt('Descreva a ocorrência:');if(!descricao)return;const ocorrencias=(os.ocorrencias||[]).concat([{tipo,descricao,status:'Aberta',data:nowStr(),responsavel:CUR.name}]);await osUpdate({ocorrencias});await osLog('Ocorrência registrada: '+descricao);await createNotification('red','Nova ocorrência na OS '+os.numero,os.id);});
    $$('[data-occ-resolve]').forEach(b=>b.addEventListener('click',async()=>{const ocorrencias=(os.ocorrencias||[]).map((x,i)=>i===Number(b.dataset.occResolve)?{...x,status:'Resolvida',resolvida_em:nowStr()}:x);await osUpdate({ocorrencias});await osLog('Ocorrência resolvida.');}));
  }
  if(OS_TAB==='producao'){
    $('#prod-start')?.addEventListener('click', async ()=>{
      await osUpdate({producao_status:'em_producao', producao_inicio: nowStr(), status:'producao'});
      await osLog('Produção iniciada.'); toast('Produção iniciada.');
    });
    $('#prod-pause')?.addEventListener('click', async ()=>{ await osUpdate({producao_status:'pausada'}); await osLog('Produção pausada.'); });
    $('#prod-finish')?.addEventListener('click', async ()=>{
      await osUpdate({producao_status:'concluida', producao_fim: nowStr(), status:'qualidade'});
      await osLog('Produção concluída.'); toast('Produção concluída.');
    });
  }
  if(OS_TAB==='qualidade'){
    $('#q-approve')?.addEventListener('click', async ()=>{
      await osUpdate({qualidade_status:'aprovado', qualidade_motivo:'', status:'instalacao'});
      await osLog('Qualidade aprovou a OS.'); toast('Qualidade aprovada.');
    });
    $('#q-reject')?.addEventListener('click', async ()=>{
      const motivo = prompt('Motivo da reprovação:'); if(motivo===null) return;
      await osUpdate({qualidade_status:'reprovado', qualidade_motivo: motivo||'Não especificado', retrabalho:{motivo:motivo||'Não especificado',responsavel:CUR.name,prazo:addDays(2),status:'Pendente',data_inicio:nowStr()}});
      await osLog('Qualidade reprovou a OS: '+ (motivo||'—')); toast('OS reprovada — retrabalho necessário.');
      await createNotification('red','Qualidade reprovou a OS '+os.numero,os.id);
    });
  }
  if(OS_TAB==='instalacao'){
    $('#inst-start')?.addEventListener('click', async ()=>{
      await osUpdate({instalacao_status:'em_andamento', instalacao_inicio: nowStr()});
      await osLog('Instalação iniciada.'); toast('Instalação iniciada.');
    });
    $('#inst-finish')?.addEventListener('click', async ()=>{
      await osUpdate({instalacao_status:'concluida', instalacao_fim: nowStr(), status:'posvenda'});
      await osLog('Instalação finalizada.'); toast('Instalação finalizada. OS enviada para pós-venda.');
    });
  }
  if(OS_TAB==='posvenda'){
    let rating = os.posvenda?.avaliacao||0;
    $$('[data-star]').forEach(s=>s.addEventListener('click', ()=>{
      rating = Number(s.dataset.star);
      $$('[data-star]').forEach(x=> x.style.color = Number(x.dataset.star)<=rating? '#E0B93A':'#D7DBE3');
    }));
    $('#pv-save')?.addEventListener('click', async ()=>{
      const posvenda = { avaliacao: rating, comentario: $('#pv-comentario').value.trim(), problema: $('#pv-problema').checked, status: $('#pv-status').value };
      await osUpdate({posvenda}); await osLog('Avaliação de pós-venda registrada.'); toast('Pós-venda salvo.');
    });
    $('#pv-close')?.addEventListener('click', async ()=>{
      await osUpdate({status:'concluido'}); await osLog('OS encerrada.'); toast('OS encerrada.');
    });
  }
}

function openAddMaterialToOS(os){
  if(STATE.materials.length===0){ toast('Cadastre materiais no catálogo primeiro.'); return; }
  $('#modal-inner').innerHTML = `
    <h3>Adicionar material à OS ${os.numero}</h3>
    <div class="form-grid">
      <div class="full"><label>Material</label><select id="f-mat">${STATE.materials.map(m=>`<option value="${m.id}">${m.nome} (${m.unidade}) — disponível: ${materialDisponivel(m)}</option>`).join('')}</select></div>
      <div><label>Quantidade necessária</label><input id="f-qtd" type="number" min="1" value="1"></div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Adicionar</button></div>`;
  showModal();
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', async ()=>{
    const mat = STATE.materials.find(x=>x.id===$('#f-mat').value);
    const qtd = Number($('#f-qtd').value)||0;
    if(qtd<=0){ toast('Quantidade inválida.'); return; }
    const mats = (os.materiais||[]).slice();
    const existing = mats.find(m=>m.material_id===mat.id);
    if(existing){ existing.qtd_necessaria += qtd; }
    else { mats.push({material_id:mat.id, nome:mat.nome, unidade:mat.unidade, qtd_necessaria:qtd, qtd_reservada:0, qtd_separada:0, qtd_utilizada:0}); }
    await osUpdate({materiais:mats, status: os.status==='pedido'?'materiais':os.status});
    await osLog(`Material adicionado: ${qtd} ${mat.unidade} de ${mat.nome}.`);
    toast('Material adicionado.'); closeModal();
  });
}

/* ================= PLANEJAMENTO ================= */
function viewPlanejamento(){
  const stages = ['pedido','planejamento','materiais','producao','qualidade','instalacao','posvenda','concluido'];
  return `<div class="toolbar"><div class="toolbar-left"><select class="filter-select" id="plan-filter"><option value="">Todas as etapas</option>${stages.map(s=>`<option value="${s}">${statusLabel(s)}</option>`).join('')}</select></div><span class="chip blue">${STATE.orders.length} OS no fluxo</span></div>
    <div class="panel"><h2>Quadro operacional <small>arranque, prazo e responsável por etapa</small></h2><div class="plan-grid" id="plan-grid">
      ${stages.map(stage=>`<section class="plan-column" data-stage="${stage}"><h3>${statusLabel(stage)} <span>${STATE.orders.filter(o=>o.status===stage).length}</span></h3>${STATE.orders.filter(o=>o.status===stage).map(o=>`<article class="plan-card" data-os="${o.id}"><b>OS ${toText(o.numero)}</b><strong>${toText(o.cliente_nome)}</strong><span>${toText(o.servico)}</span><small>${toText(o.responsavel)} · ${fmtDate(o.prazo)}</small><button class="btn sm ghost plan-open" data-os="${o.id}">Abrir OS</button></article>`).join('')||'<div class="empty">Nenhuma OS</div>'}</section>`).join('')}
    </div></div>`;
}
function bindPlanejamento(){
  $('#plan-filter').addEventListener('change', e=>$$('.plan-column').forEach(col=>col.style.display=!e.target.value||col.dataset.stage===e.target.value?'block':'none'));
  $$('.plan-open').forEach(btn=>btn.addEventListener('click',()=>{OS_OPEN=btn.dataset.os;OS_TAB='resumo';renderView();}));
}

/* ================= FERRAMENTAS ================= */
function viewFerramentas(){
  return `<div class="toolbar"><div class="toolbar-left"><input class="filter-input" id="tool-search" placeholder="Buscar ferramenta..."></div><button class="btn primary" id="tool-new">+ Nova ferramenta</button></div>
    <div class="panel" style="padding:0"><table><thead><tr><th>Código</th><th>Ferramenta</th><th>Qtd.</th><th>Disponível</th><th>Estado</th><th>Manutenção</th><th></th></tr></thead><tbody id="tool-tbody">${renderToolRows()}</tbody></table></div>`;
}
function renderToolRows(){
  const q=($('#tool-search')?.value||'').toLowerCase();
  const rows=STATE.tools.filter(t=>(t.nome||'').toLowerCase().includes(q)||(t.codigo||'').toLowerCase().includes(q));
  return rows.length?rows.map(t=>`<tr><td class="mono">${toText(t.codigo)}</td><td><b>${toText(t.nome)}</b></td><td>${toText(t.quantidade,0)}</td><td><span class="chip ${Number(t.disponivel)>0?'green':'red'}">${toText(t.disponivel,0)}</span></td><td>${toText(t.estado)}</td><td>${toText(t.manutencao)}</td><td><button class="btn sm ghost" data-tool-edit="${t.id}">Editar</button><button class="btn sm ghost" data-tool-del="${t.id}">Excluir</button></td></tr>`).join(''):'<tr><td colspan="7" class="empty">Nenhuma ferramenta cadastrada.</td></tr>';
}
function bindToolButtons(){
  $$('[data-tool-edit]').forEach(b=>b.addEventListener('click',()=>openToolModal(b.dataset.toolEdit)));
  $$('[data-tool-del]').forEach(b=>b.addEventListener('click',async()=>{if(confirm('Excluir esta ferramenta?')){await db.collection('tools').doc(b.dataset.toolDel).delete();toast('Ferramenta excluída.');}}));
}
function bindFerramentas(){
  $('#tool-search').addEventListener('input',()=>{ $('#tool-tbody').innerHTML=renderToolRows(); bindToolButtons(); });
  $('#tool-new').addEventListener('click',()=>openToolModal());
  bindToolButtons();
}
function openToolModal(id){
  const t=id?STATE.tools.find(x=>x.id===id):{codigo:'',nome:'',quantidade:1,disponivel:1,estado:'Boa',manutencao:'Em dia',responsavel:''};
  $('#modal-inner').innerHTML=`<h3>${id?'Editar ferramenta':'Nova ferramenta'}</h3><div class="msub">A disponibilidade bloqueia a instalação quando não houver unidade livre.</div><div class="form-grid"><div><label>Código</label><input id="f-tcodigo" value="${toText(t.codigo,'')}"></div><div><label>Nome</label><input id="f-tnome" value="${toText(t.nome,'')}"></div><div><label>Quantidade</label><input id="f-tqtd" type="number" min="0" value="${Number(t.quantidade)||0}"></div><div><label>Disponível</label><input id="f-tdisp" type="number" min="0" value="${Number(t.disponivel)||0}"></div><div><label>Estado</label><input id="f-testado" value="${toText(t.estado,'Boa')}"></div><div><label>Manutenção</label><input id="f-tman" value="${toText(t.manutencao,'Em dia')}"></div></div><div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Salvar</button></div>`;
  showModal();$('#m-cancel').addEventListener('click',closeModal);$('#m-save').addEventListener('click',async()=>{const data={codigo:$('#f-tcodigo').value.trim(),nome:$('#f-tnome').value.trim(),quantidade:Number($('#f-tqtd').value)||0,disponivel:Number($('#f-tdisp').value)||0,estado:$('#f-testado').value.trim(),manutencao:$('#f-tman').value.trim(),created_at:t.created_at||Date.now()};if(!data.nome||!data.codigo){toast('Informe código e nome.');return;}if(id)await db.collection('tools').doc(id).update(data);else await db.collection('tools').add(data);closeModal();toast('Ferramenta salva.');});
}

/* ================= TERCEIRIZAÇÃO / CNC ================= */
function viewCnc(){
  return `<div class="toolbar"><span class="chip yellow">${STATE.cnc.filter(x=>!['Aprovado','Recebido'].includes(x.status)).length} em acompanhamento</span><button class="btn primary" id="cnc-new">+ Novo serviço externo</button></div><div class="panel" style="padding:0"><table><thead><tr><th>OS</th><th>Fornecedor</th><th>Peça / serviço</th><th>Prazo</th><th>Status</th><th></th></tr></thead><tbody>${STATE.cnc.length?STATE.cnc.map(c=>`<tr><td class="osnum">OS ${toText(c.os_numero)}</td><td>${toText(c.fornecedor)}</td><td>${toText(c.peca)}</td><td>${fmtDate(c.prazo)}</td><td><span class="chip ${c.status==='Aprovado'?'green':c.status==='Reprovado'?'red':'yellow'}">${toText(c.status)}</span></td><td><button class="btn sm ghost" data-cnc-status="${c.id}">Atualizar</button></td></tr>`).join(''):'<tr><td colspan="6" class="empty">Nenhum serviço externo registrado.</td></tr>'}</tbody></table></div>`;
}
function bindCnc(){
  $('#cnc-new').addEventListener('click',openCncModal);
  $$('[data-cnc-status]').forEach(b=>b.addEventListener('click',async()=>{const c=STATE.cnc.find(x=>x.id===b.dataset.cncStatus);const next=prompt('Novo status (Enviado, Em produção, Aguardando retorno, Recebido, Em inspeção, Aprovado, Reprovado):',c.status);if(!next)return;await db.collection('cnc').doc(c.id).update({status:next,updated_at:nowStr()});if(next==='Reprovado')await createNotification('red',`CNC reprovado — OS ${c.os_numero}`,c.os_id);toast('Status do CNC atualizado.');}));
}
function openCncModal(){
  $('#modal-inner').innerHTML=`<h3>Novo serviço de terceirização</h3><div class="form-grid"><div><label>OS</label><select id="f-cos">${STATE.orders.map(o=>`<option value="${o.id}">${o.numero} — ${toText(o.cliente_nome)}</option>`).join('')}</select></div><div><label>Fornecedor</label><input id="f-cfor" placeholder="Nome do fornecedor"></div><div><label>Peça / serviço</label><input id="f-cpeca"></div><div><label>Quantidade</label><input id="f-cqtd" type="number" min="1" value="1"></div><div><label>Prazo de retorno</label><input id="f-cprazo" type="date"></div><div><label>Status</label><select id="f-cstatus"><option>Aguardando envio</option><option>Enviado</option><option>Em produção</option><option>Aguardando retorno</option><option>Recebido</option></select></div><div class="full"><label>Observações</label><textarea id="f-cobs"></textarea></div></div><div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Salvar</button></div>`;
  showModal();$('#m-cancel').addEventListener('click',closeModal);$('#m-save').addEventListener('click',async()=>{const o=STATE.orders.find(x=>x.id===$('#f-cos').value);if(!o){toast('Cadastre uma OS primeiro.');return;}const data={os_id:o.id,os_numero:o.numero,fornecedor:$('#f-cfor').value.trim(),peca:$('#f-cpeca').value.trim(),quantidade:Number($('#f-cqtd').value)||1,prazo:$('#f-cprazo').value,status:$('#f-cstatus').value,observacoes:$('#f-cobs').value.trim(),created_at:Date.now()};if(!data.fornecedor||!data.peca){toast('Informe fornecedor e peça.');return;}await db.collection('cnc').add(data);await osLogFor(o.id,`Serviço externo criado: ${data.peca}.`);closeModal();toast('Serviço CNC cadastrado.');});
}

/* ================= NOTIFICAÇÕES E USUÁRIOS ================= */
function notificationItems(){
  const items=pendencias().map(p=>({id:`auto-${p.os}-${p.text}`,level:p.level,title:p.text,os:p.os,read:false}));
  return STATE.notifications.concat(items).filter((n,i,a)=>a.findIndex(x=>x.id===n.id)===i);
}
function viewNotificacoes(){const items=notificationItems();return `<div class="toolbar"><span class="chip ${items.length?'red':'green'}">${items.length} alerta(s)</span><button class="btn ghost" id="notif-clear">Marcar alertas como vistos</button></div><div class="panel">${items.length?items.map(n=>`<div class="pend-item" data-notif-os="${n.os||''}"><span class="pend-badge ${n.level||'yellow'}"></span><span class="t"><b>${toText(n.title||n.text)}</b></span><span class="a">${n.read?'Visto':'Atenção'}</span></div>`).join(''):'<div class="empty">Nenhuma notificação pendente.</div>'}</div>`;}
function bindNotificacoes(){$$('[data-notif-os]').forEach(x=>x.addEventListener('click',()=>{if(x.dataset.notifOs){OS_OPEN=x.dataset.notifOs;OS_TAB='resumo';renderView();}}));$('#notif-clear').addEventListener('click',async()=>{for(const n of STATE.notifications)await db.collection('notifications').doc(n.id).update({read:true});toast('Notificações marcadas como vistas.');});}
async function createNotification(level,title,os){return db.collection('notifications').add({level,title,os,read:false,created_at:Date.now()});}
async function osLogFor(osId,acao){const os=STATE.orders.find(x=>x.id===osId);if(!os)return;const hist=(os.historico||[]).concat([{data:nowStr(),usuario:CUR.name,acao}]);await db.collection('service_orders').doc(osId).update({historico:hist});}
function viewUsuarios(){return `<div class="toolbar"><div class="toolbar-left"><span class="chip blue">${STATE.users.length} usuários</span><button class="btn" id="users-export">Salvar users.json</button></div><button class="btn primary" id="user-new">+ Novo usuário</button></div><div class="panel" style="padding:0"><table><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Status</th><th></th></tr></thead><tbody>${STATE.users.length?STATE.users.map(u=>`<tr><td><b>${toText(u.nome)}</b></td><td class="mono">${toText(u.usuario)}</td><td><span class="chip blue">${toText(u.perfil)}</span></td><td>${toText(u.status)}</td><td><button class="btn sm ghost" data-user-del="${u.id}">Excluir</button></td></tr>`).join(''):'<tr><td colspan="5" class="empty">Nenhum usuário cadastrado.</td></tr>'}</tbody></table></div>`;}
function bindUsuarios(){$('#user-new').addEventListener('click',openUserModal);$('#users-export').addEventListener('click',exportUsersJson);$$('[data-user-del]').forEach(b=>b.addEventListener('click',async()=>{if(confirm('Excluir este usuário?')){await db.collection('users').doc(b.dataset.userDel).delete();toast('Usuário excluído. Salve o users.json atualizado.');}}));}
async function exportUsersJson(){
  const payload=JSON.stringify({schema:'nexlog.users.v1',description:'Base de usuarios do NEXLOG.',users:STATE.users.map(user=>{const clean={...user};delete clean.email;return clean;})},null,2);
  try{
    if(window.showSaveFilePicker){
      const handle=await window.showSaveFilePicker({suggestedName:'users.json',types:[{description:'Arquivo JSON',accept:{'application/json':['.json']}}]});
      const writable=await handle.createWritable();await writable.write(payload);await writable.close();toast('users.json atualizado.');return;
    }
  }catch(error){if(error.name==='AbortError')return;}
  const blob=new Blob([payload],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download='users.json';
  link.style.display='none';
  document.body.appendChild(link);
  link.click();
  setTimeout(()=>{link.remove();URL.revokeObjectURL(url);},1000);
  toast('users.json baixado.');
}
function openUserModal(){
  $('#modal-inner').innerHTML=`<h3>Novo usuário</h3><div class="form-grid"><div><label>Nome</label><input id="f-unome"></div><div><label>Nome de usuário</label><input id="f-uusuario" autocomplete="username"></div><div><label>Senha</label><input id="f-usenha" type="password" autocomplete="new-password"></div><div><label>Perfil</label><select id="f-uperfil"><option>Administrador</option><option>Atendimento</option><option>Produção</option><option>Estoque</option><option>Qualidade</option><option>Instalação</option><option>Pós-venda</option></select></div></div><div class="modal-actions"><button class="btn ghost" id="m-cancel">Cancelar</button><button class="btn primary" id="m-save">Salvar</button></div>`;
  showModal();
  $('#m-cancel').addEventListener('click',closeModal);
  $('#m-save').addEventListener('click',async()=>{
    const nome=$('#f-unome').value.trim(), usuario=$('#f-uusuario').value.trim().toLowerCase(), senha=$('#f-usenha').value;
    if(!nome||!usuario||!senha){toast('Informe nome, usuário e senha.');return;}
    const previousSession = authSession;
    const { data, error } = await window.supabaseClient.auth.signUp({email:`${usuario}@nexlog.app`,password:senha});
    if(error){toast('Não foi possível criar o usuário: '+error.message);return;}
    if(data.session && previousSession) await window.supabaseClient.auth.setSession({access_token:previousSession.access_token,refresh_token:previousSession.refresh_token});
    await db.collection('users').add({nome,usuario,perfil:$('#f-uperfil').value,status:'Ativo',created_at:Date.now()});
    closeModal();
    toast('Usuário criado no Supabase Auth.');
  });
}

/* ================= INDICADORES ================= */
function viewIndicadores(){
  const total = STATE.orders.length;
  const producaoConcluida = STATE.orders.filter(o=>o.producao_status==='concluida').length;
  const qualAprovadas = STATE.orders.filter(o=>o.qualidade_status==='aprovado').length;
  const qualReprovadas = STATE.orders.filter(o=>o.qualidade_status==='reprovado').length;
  const instConcluidas = STATE.orders.filter(o=>o.instalacao_status==='concluida').length;
  const noPrazo = STATE.orders.filter(o=>osPrazoStatus(o)==='green').length;
  const atrasadas = STATE.orders.filter(o=>osPrazoStatus(o)==='red').length;
  const avaliacoes = STATE.orders.filter(o=>o.posvenda?.avaliacao>0);
  const mediaAval = avaliacoes.length? (avaliacoes.reduce((s,o)=>s+o.posvenda.avaliacao,0)/avaliacoes.length).toFixed(1) : '—';
  const matBaixo = STATE.materials.filter(m=>materialSituacao(m)!=='green').length;

  const bar = (label,val,max,color)=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
    <div style="width:150px;font-size:12.5px;color:var(--ink2);">${label}</div>
    <div style="flex:1;background:var(--grey-bg);border-radius:6px;height:14px;overflow:hidden;"><div style="width:${max? (val/max*100):0}%;background:${color};height:100%;"></div></div>
    <div style="width:26px;text-align:right;font-family:'IBM Plex Mono';font-size:12.5px;">${val}</div></div>`;

  return `
  <div class="row2">
    <div class="panel"><h2>Produção &amp; Qualidade</h2>
      ${bar('OS produzidas', producaoConcluida, Math.max(total,1), 'var(--blue)')}
      ${bar('Qualidade aprovada', qualAprovadas, Math.max(total,1), 'var(--green)')}
      ${bar('Qualidade reprovada', qualReprovadas, Math.max(total,1), 'var(--red)')}
      ${bar('Instalações concluídas', instConcluidas, Math.max(total,1), 'var(--blue)')}
    </div>
    <div class="panel"><h2>Prazos &amp; Pós-venda</h2>
      ${bar('No prazo', noPrazo, Math.max(total,1), 'var(--green)')}
      ${bar('Atrasadas', atrasadas, Math.max(total,1), 'var(--red)')}
      <div class="kpi" style="margin-top:10px;"><div class="n">${mediaAval}</div><div class="l">Avaliação média de pós-venda (${avaliacoes.length} respostas)</div></div>
    </div>
  </div>
  <div class="panel"><h2>Materiais</h2>
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="kpi"><div class="n">${STATE.materials.length}</div><div class="l">Materiais no catálogo</div></div>
      <div class="kpi ${matBaixo>0?'warn':''}"><div class="n">${matBaixo}</div><div class="l">Abaixo do mínimo ou insuficientes</div></div>
      <div class="kpi"><div class="n">${STATE.materials.reduce((s,m)=>s+(m.reservado||0),0)}</div><div class="l">Unidades reservadas no total</div></div>
    </div>
  </div>`;
}

/* ---------------- MODAL HELPERS ---------------- */
function showModal(){ const m = $('#modal-bg'); if(m) m.classList.add('show'); }
function closeModal(){ const m = $('#modal-bg'); if(m) m.classList.remove('show'); }
on('#modal-bg', 'click', e=>{ if(e.target.id==='modal-bg') closeModal(); });

/* ---------------- GLOBAL SEARCH ---------------- */
on('#global-search', 'keydown', e=>{
  if(e.key==='Enter'){
    const q = e.target.value.toLowerCase();
    const hit = STATE.orders.find(o=> String(o.numero||'').includes(q) || (o.cliente_nome||'').toLowerCase().includes(q) || (o.servico||'').toLowerCase().includes(q));
    if(hit){ OS_OPEN = hit.id; OS_TAB='resumo'; renderView(); }
    else { VIEW='os'; renderView(); setTimeout(()=>{ const s=$('#os-search'); if(s){ s.value=q; renderOSTbody(); } },0); }
  }
});

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();