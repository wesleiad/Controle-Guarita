'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let U = null, tab = 'frota', sub = 'func', agora = { data: '', hora: '' };
let veiculos = [], portoes = [];
let DESTINOS = [];
const MOTIVOS = ['Hora Extra', 'Saída Antecipada', 'Serviço Externo'];
const br = d => d ? d.split('-').reverse().join('/') : '';

async function api(m, url, body) {
  const r = await fetch(url, { method: m, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const d = ct.includes('json') ? await r.json() : null;
  if (!r.ok) { const e = new Error(d?.erro || 'Erro'); e.data = d; e.status = r.status; if (r.status === 401 && U) { U = null; mostrarLogin(); } throw e; }
  return d;
}
function toast(msg, erro) { const d = document.createElement('div'); d.textContent = msg; if (erro) d.className = 'e'; $('#toast').append(d); setTimeout(() => d.remove(), erro ? 6000 : 2500); }
const tentar = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.status !== 401) toast(e.message, true); } };

// ---- modal ----
function modal(html) { $('#mbox').innerHTML = html; $('#modal').classList.remove('hide'); }
function fechar() { $('#modal').classList.add('hide'); }
function confirmar(msg, label = 'SIM, CONFIRMAR') {
  return new Promise(res => {
    modal(`<h2>Atenção</h2><p style="font-size:19px">${esc(msg)}</p><div class="acts"><button class="btn cinza" id="mn">Cancelar</button><button class="btn vermelho" id="ms">${esc(label)}</button></div>`);
    $('#mn').onclick = () => { fechar(); res(false); }; $('#ms').onclick = () => { fechar(); res(true); };
  });
}

// ---- máscara de hora ----
function maskHora(el) {
  el.addEventListener('input', () => { let v = el.value.replace(/\D/g, '').slice(0, 4); if (v.length > 2) v = v.slice(0, 2) + ':' + v.slice(2); el.value = v; el.dataset.manual = '1'; });
  el.addEventListener('blur', () => { if (el.value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(el.value)) { toast('Hora inválida. Use HH:MM', true); el.value = agora.hora; } });
}
const horaInput = (id, val) => `<label>Hora<input id="${id}" value="${esc(val ?? agora.hora)}" maxlength="5" inputmode="numeric" placeholder="HH:MM" data-hora></label>`;
function ligarHoras(root = document) { root.querySelectorAll('[data-hora]').forEach(maskHora); }
function atualizaHoras() { document.querySelectorAll('[data-hora]').forEach(el => { if (!el.dataset.manual && el.dataset.auto !== '0') el.value = agora.hora; }); }
async function tick() { try { agora = await api('GET', '/api/agora'); $('#relogio').textContent = agora.hora; atualizaHoras(); } catch { } }

// ---- login ----
function mostrarLogin() { $('#app').classList.add('hide'); $('#login').classList.remove('hide'); $('#lp').value = ''; }
$('#fl').onsubmit = async e => {
  e.preventDefault(); $('#lerr').textContent = '';
  try { U = await api('POST', '/api/login', { usuario: $('#lu').value, senha: $('#lp').value }); iniciar(); } catch (er) { $('#lerr').textContent = er.message; }
};
$('#sair').onclick = async () => { await api('POST', '/api/logout').catch(() => { }); U = null; mostrarLogin(); };

async function iniciar() {
  $('#login').classList.add('hide'); $('#app').classList.remove('hide');
  $('#quem').textContent = `${U.nome || U.usuario} (${U.perfil === 'rh' ? 'RH / Admin' : 'Guarita'})`;
  await tick();
  portoes = await api('GET', '/api/portoes'); desenhaGuia();
  const abas = [['frota', '🚚 VEÍCULOS DA EMPRESA'], ['terc', '🧍 TERCEIROS / VISITANTES'], ['func', '👷 FUNCIONÁRIOS']];
  if (U.perfil === 'rh') abas.push(['cad', '⚙ CADASTROS E RELATÓRIOS']);
  if (!abas.find(a => a[0] === tab)) tab = 'frota';
  $('#tabs').innerHTML = abas.map(a => `<button data-t="${a[0]}">${a[1]}</button>`).join('');
  $('#tabs').onclick = e => { const t = e.target.closest('button')?.dataset.t; if (t) { tab = t; render(); } };
  render();
}
function desenhaGuia() {
  $('#guia').innerHTML = `<h2>GUIA RÁPIDO DE PORTÕES</h2>` + portoes.map(p => `<div class="pt"><b>${esc(p.codigo)} - ${esc(p.titulo)}</b>
    <span class="et ${p.recebe ? 's' : 'n'}">${p.recebe ? 'RECEBE ENTREGA' : 'NÃO RECEBE ENTREGA'}</span><div>${esc(p.texto)}</div></div>`).join('') +
    `<div class="aviso">AVISO GERAL: Demais situações e visitas devem ser encaminhadas à Recepção/Escritório.</div>`;
}
async function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  veiculos = await api('GET', '/api/veiculos').catch(() => []);
  await ({ frota: telaFrota, terc: telaTerc, func: telaFunc, cad: telaCad }[tab])().catch(e => toast(e.message, true));
  ligarHoras($('#conteudo'));
}
const dataFiltro = () => `<div class="row" style="max-width:320px;margin-bottom:8px"><label>Data (RH)<input type="date" id="fdata" value="${esc(window._fd || agora.data)}"></label></div>`;
function ligaData() { const f = $('#fdata'); if (f) f.onchange = () => { window._fd = f.value; render(); }; }
const qs = () => (U.perfil === 'rh' && window._fd ? `?data=${window._fd}` : '');
const opts = (arr, sel) => arr.map(a => `<option ${a === sel ? 'selected' : ''}>${esc(a)}</option>`).join('');

// ================= FROTA =================
async function telaFrota() {
  const [rua, lista, mot, dest] = await Promise.all([api('GET', '/api/frota/rua'), api('GET', '/api/frota' + qs()), api('GET', '/api/motoristas'), api('GET', '/api/destinos')]);
  DESTINOS = dest;
  const naRua = new Set(rua.map(r => r.veiculo_id));
  const livres = veiculos.filter(v => !naRua.has(v.id));
  $('#conteudo').innerHTML = `
  <div class="box"><h2>🚨 Veículos na rua agora (${rua.length})</h2><div class="cards">${rua.map(r => `
    <div class="card"><b>${esc(r.veiculo)} ${esc(r.placa)}</b><small>Motorista: ${esc(r.motorista)}</small><small>Destino: ${esc(r.destino)} ${r.status !== 'Normal' ? '• ' + esc(r.status) : ''}</small>
    <small>Saiu ${br(r.data_saida)} às ${esc(r.hora_saida)} • KM ${r.km_saida}</small>
    <button class="btn vermelho grande" data-ret="${r.id}" style="font-size:19px;padding:12px">REGISTRAR RETORNO</button></div>`).join('') || '<i>Nenhum veículo fora.</i>'}</div></div>
  <div class="box"><h2>➡ Registrar SAÍDA de veículo</h2>
    <div class="grid">
      <label>Veículo / Placa<select id="fv"><option value="">-- escolha --</option>${livres.map(v => `<option value="${v.id}">${esc(v.nome)} - ${esc(v.placa)}</option>`).join('')}</select></label>
      <div><label>KM Saída</label><div class="row"><input id="fkm" inputmode="numeric"><button class="btn amarelo" id="fcorrige" type="button">Corrigir Último KM</button></div></div>
      <label>Motorista<input id="fm" list="dlm" autocomplete="off"><datalist id="dlm">${mot.map(m => `<option value="${esc(m)}">`).join('')}</datalist></label>
      ${horaInput('fh')}
    </div>
    <label>Destino</label><div class="quick" id="fdq">${DESTINOS.map(d => `<button type="button">${d}</button>`).join('')}</div>
    <input id="fd" placeholder="ou digite outro destino">
    <div class="grid"><label>Status<select id="fs"><option>Normal</option><option>Lavação</option><option>Oficina</option></select></label>
    <label>Observação<input id="fo"></label></div>
    <button class="btn verde grande" id="fsalvar">REGISTRAR SAÍDA</button></div>
  <div class="box"><h2>📋 Movimento ${U.perfil === 'rh' && window._fd ? br(window._fd) : 'de hoje'}</h2>${U.perfil === 'rh' ? dataFiltro() : ''}<div class="tw"><table>
    <tr><th>Veículo</th><th>Motorista</th><th>Destino</th><th>Saída</th><th>KM sai.</th><th>Retorno</th><th>KM ret.</th><th>Status</th><th>Obs</th><th></th></tr>
    ${lista.map(r => `<tr><td>${esc(r.veiculo)}<br><b>${esc(r.placa)}</b></td><td>${esc(r.motorista)}</td><td>${esc(r.destino)}</td><td>${br(r.data_saida)} ${esc(r.hora_saida)}</td><td>${r.km_saida}</td>
    <td>${r.km_entrada == null ? '<b style="color:#c62828">NA RUA</b>' : br(r.data_entrada) + ' ' + esc(r.hora_entrada)}</td><td>${r.km_entrada ?? ''}</td><td>${esc(r.status)}</td><td>${esc(r.obs)}</td>
    <td style="white-space:nowrap"><button class="btn amarelo peq" data-ed="${r.id}">Editar</button>${U.perfil === 'rh' ? ` <button class="btn vermelho peq" data-del="${r.id}">Excluir</button>` : ''}</td></tr>`).join('')}</table></div></div>
  <div class="box"><h2>🔧 KM atual da frota</h2><div class="tw" style="max-height:40vh"><table><tr><th>Veículo</th><th>Placa</th><th>Último KM</th><th></th></tr>
    ${veiculos.map(v => `<tr><td>${esc(v.nome)}</td><td>${esc(v.placa)}</td><td><b>${v.km}</b></td><td><button class="btn amarelo peq" data-km="${v.id}">Corrigir KM Atual</button></td></tr>`).join('')}</table></div></div>`;
  ligaData();
  const sel = $('#fv'), km = $('#fkm');
  sel.onchange = () => { const v = veiculos.find(x => x.id == sel.value); km.value = v ? v.km : ''; };
  $('#fdq').onclick = e => { const b = e.target.closest('button'); if (!b) return; $('#fd').value = b.textContent; $('#fdq').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
  $('#fcorrige').onclick = tentar(async () => { if (!sel.value) throw new Error('Escolha o veículo primeiro.'); await corrigirKm(sel.value, km.value); });
  $('#fsalvar').onclick = tentar(async () => {
    await api('POST', '/api/frota/saida', { veiculo_id: sel.value, km_saida: km.value, motorista: $('#fm').value, destino: $('#fd').value, status: $('#fs').value, obs: $('#fo').value, hora: $('#fh').value });
    toast('Saída registrada!'); render();
  });
  $('#conteudo').onclick = tentar(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ret) return retorno(rua.find(r => r.id == b.dataset.ret));
    if (b.dataset.ed) return editarFrota(lista.find(r => r.id == b.dataset.ed));
    if (b.dataset.km) { const v = veiculos.find(x => x.id == b.dataset.km); return modalKm(v); }
    if (b.dataset.del && await confirmar('Excluir este registro definitivamente?', 'EXCLUIR')) { await api('DELETE', '/api/frota/' + b.dataset.del); toast('Excluído'); render(); }
  });
}
async function corrigirKm(id, valor) {
  const v = veiculos.find(x => x.id == id); const n = parseInt(valor);
  if (!(n >= 0)) throw new Error('Digite o KM correto.');
  if (!await confirmar(`Alterar o último KM de ${v.nome} ${v.placa} de ${v.km} para ${n}?`, 'SIM, CORRIGIR')) return;
  await api('PUT', `/api/veiculos/${id}/km`, { km: n }); toast('KM corrigido'); render();
}
function modalKm(v) {
  modal(`<h2>Corrigir KM Atual</h2><p><b>${esc(v.nome)} ${esc(v.placa)}</b> — atual: ${v.km}</p><label>Novo KM<input id="nk" inputmode="numeric" value="${v.km}"></label>
  <div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR KM</button></div>`);
  $('#nk').select(); $('#mc').onclick = fechar;
  $('#mo').onclick = tentar(async () => { const n = parseInt($('#nk').value); if (!(n >= 0)) throw new Error('KM inválido'); await api('PUT', `/api/veiculos/${v.id}/km`, { km: n }); fechar(); toast('KM corrigido'); render(); });
}
function retorno(r) {
  modal(`<h2>Retorno: ${esc(r.veiculo)} ${esc(r.placa)}</h2><p>Saiu com KM <b>${r.km_saida}</b> — motorista ${esc(r.motorista)}</p>
  <label>KM de Entrada (retorno)<input id="rk" inputmode="numeric" autofocus></label>${horaInput('rh')}
  <div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn verde" id="mo">CONFIRMAR RETORNO</button></div>`);
  ligarHoras($('#mbox')); $('#mc').onclick = fechar;
  const enviar = async conf => {
    const body = { km_entrada: $('#rk').value, hora: $('#rh').value, confirmado: conf };
    try { await api('POST', `/api/frota/${r.id}/retorno`, body); fechar(); toast('Retorno registrado!'); render(); }
    catch (e) {
      if (e.data?.confirmar) {
        if (await confirmar(e.message + ' Deseja registrar mesmo assim?', 'SIM, ESTÁ CORRETO')) { try { await api('POST', `/api/frota/${r.id}/retorno`, { ...body, confirmado: true }); fechar(); toast('Retorno registrado!'); render(); } catch (e2) { toast(e2.message, true); } }
        else retorno(r);
      } else toast(e.message, true);
    }
  };
  $('#mo').onclick = () => enviar(false);
}
function editarFrota(r) {
  modal(`<h2>Editar: ${esc(r.veiculo)} ${esc(r.placa)}</h2><div class="grid">
  <label>Motorista<input id="em" value="${esc(r.motorista)}"></label><label>Destino<input id="ed" value="${esc(r.destino)}"></label>
  <label>Status<select id="es">${opts(['Normal', 'Lavação', 'Oficina'], r.status)}</select></label>
  <label>KM Saída<input id="eks" inputmode="numeric" value="${r.km_saida}"></label><label>Hora Saída<input id="ehs" data-hora data-auto="0" value="${esc(r.hora_saida)}" maxlength="5"></label>
  <label>KM Retorno<input id="eke" inputmode="numeric" value="${r.km_entrada ?? ''}" placeholder="vazio = na rua"></label><label>Hora Retorno<input id="ehe" data-hora data-auto="0" value="${esc(r.hora_entrada || '')}" maxlength="5"></label></div>
  <label>Observação<input id="eo" value="${esc(r.obs)}"></label>
  <div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR</button></div>`);
  ligarHoras($('#mbox')); $('#mc').onclick = fechar;
  const salvar = async conf => {
    const body = { motorista: $('#em').value, destino: $('#ed').value, status: $('#es').value, km_saida: $('#eks').value, hora_saida: $('#ehs').value, km_entrada: $('#eke').value, hora_entrada: $('#ehe').value, obs: $('#eo').value, confirmado: conf };
    try { await api('PUT', '/api/frota/' + r.id, body); fechar(); toast('Registro atualizado'); render(); }
    catch (e) {
      if (!e.data?.confirmar) return toast(e.message, true);
      if (await confirmar(e.message + ' Registrar mesmo assim?', 'SIM, ESTÁ CORRETO')) { try { await api('PUT', '/api/frota/' + r.id, { ...body, confirmado: true }); toast('Registro atualizado'); render(); } catch (e2) { toast(e2.message, true); } }
      else editarFrota({ ...r, ...Object.fromEntries(Object.entries({ motorista: body.motorista, destino: body.destino, status: body.status, obs: body.obs })) });
    }
  };
  $('#mo').onclick = () => salvar(false);
}

// ================= TERCEIROS =================
function sugestao(inp, lista) {
  const ul = document.createElement('ul'); ul.className = 'sug-ul'; inp.parentElement.classList.add('sug'); inp.parentElement.append(ul); ul.classList.add('hide');
  const mostra = () => {
    const q = inp.value.trim().toUpperCase(); const m = q ? lista.filter(x => x.toUpperCase().includes(q)).slice(0, 8) : [];
    ul.innerHTML = m.map(x => `<li>${esc(x)}</li>`).join(''); ul.classList.toggle('hide', !m.length || (m.length === 1 && m[0].toUpperCase() === q));
  };
  inp.addEventListener('input', mostra); inp.addEventListener('blur', () => setTimeout(() => ul.classList.add('hide'), 150));
  ul.onmousedown = e => { const li = e.target.closest('li'); if (li) { inp.value = li.textContent; ul.classList.add('hide'); inp.dispatchEvent(new Event('change')); } };
  ul.style.cssText = 'position:absolute;z-index:5;left:0;right:0;background:#fff;border:2px solid #1976d2;border-radius:8px;margin:0;padding:0;list-style:none;max-height:260px;overflow:auto';
}
async function telaTerc() {
  const [dentro, lista, sg] = await Promise.all([api('GET', '/api/terceiros/dentro'), api('GET', '/api/terceiros' + qs()), api('GET', '/api/terceiros/sugestoes')]);
  const P = [...portoes.map(p => p.codigo), 'RECEPÇÃO'];
  $('#conteudo').innerHTML = `
  <div class="box"><h2>🏭 Terceiros dentro da fábrica agora (${dentro.length})</h2><div class="cards">${dentro.map(t => `
    <div class="card dentro"><b>${esc(t.nome)}</b><small>${esc(t.empresa)} • ${esc(t.portao)}</small><small>Entrou ${br(t.data)} às ${esc(t.hora_entrada)}</small>
    <button class="btn vermelho grande" data-sai="${t.id}" style="font-size:19px;padding:12px">DAR BAIXA (SAÍDA)</button></div>`).join('') || '<i>Ninguém dentro.</i>'}</div></div>
  <div class="box"><h2>➡ Registrar ENTRADA</h2><div class="grid">
    <label>Nome<input id="tn" autocomplete="off"></label><label>Empresa<input id="te" autocomplete="off"></label>${horaInput('th')}</div>
    <label>Portão de destino</label><div class="quick" id="tpq">${P.map(p => `<button type="button">${p}</button>`).join('')}</div>
    <label>Observação<input id="to"></label><button class="btn verde grande" id="tsalvar">REGISTRAR ENTRADA</button></div>
  <div class="box"><h2>📋 Movimento ${U.perfil === 'rh' && window._fd ? br(window._fd) : 'de hoje'}</h2>${U.perfil === 'rh' ? dataFiltro() : ''}<div class="tw"><table>
    <tr><th>Data</th><th>Nome</th><th>Empresa</th><th>Portão</th><th>Entrada</th><th>Saída</th><th>Obs</th><th></th></tr>
    ${lista.map(t => `<tr><td>${br(t.data)}</td><td>${esc(t.nome)}</td><td>${esc(t.empresa)}</td><td>${esc(t.portao)}</td><td>${esc(t.hora_entrada)}</td><td>${t.hora_saida ? esc(t.hora_saida) : '<b style="color:#1b8a3a">DENTRO</b>'}</td><td>${esc(t.obs)}</td>
    <td style="white-space:nowrap"><button class="btn amarelo peq" data-ed="${t.id}">Editar</button>${U.perfil === 'rh' ? ` <button class="btn vermelho peq" data-del="${t.id}">Excluir</button>` : ''}</td></tr>`).join('')}</table></div></div>`;
  ligaData(); sugestao($('#tn'), sg.nomes); sugestao($('#te'), sg.empresas);
  $('#tpq').onclick = e => { const b = e.target.closest('button'); if (b) { window._p = b.textContent; $('#tpq').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); } };
  window._p = '';
  $('#tsalvar').onclick = tentar(async () => { await api('POST', '/api/terceiros', { nome: $('#tn').value, empresa: $('#te').value, portao: window._p, obs: $('#to').value, hora: $('#th').value }); toast('Entrada registrada!'); render(); });
  $('#conteudo').onclick = tentar(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sai) { await api('POST', `/api/terceiros/${b.dataset.sai}/saida`, {}); toast('Saída registrada'); render(); }
    if (b.dataset.ed) {
      const t = lista.find(x => x.id == b.dataset.ed);
      modal(`<h2>Editar terceiro</h2><div class="grid"><label>Nome<input id="en" value="${esc(t.nome)}"></label><label>Empresa<input id="ee" value="${esc(t.empresa)}"></label>
      <label>Portão<select id="ep"><option></option>${opts(P, t.portao)}</select></label><label>Hora entrada<input id="ehe" data-hora data-auto="0" value="${esc(t.hora_entrada)}" maxlength="5"></label>
      <label>Hora saída<input id="ehs" data-hora data-auto="0" value="${esc(t.hora_saida || '')}" maxlength="5" placeholder="vazio = dentro"></label></div>
      <label>Observação<input id="eo" value="${esc(t.obs)}"></label><div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR</button></div>`);
      ligarHoras($('#mbox')); $('#mc').onclick = fechar;
      $('#mo').onclick = tentar(async () => { await api('PUT', '/api/terceiros/' + t.id, { nome: $('#en').value, empresa: $('#ee').value, portao: $('#ep').value, hora_entrada: $('#ehe').value, hora_saida: $('#ehs').value, obs: $('#eo').value }); fechar(); toast('Atualizado'); render(); });
    }
    if (b.dataset.del && await confirmar('Excluir este registro definitivamente?', 'EXCLUIR')) { await api('DELETE', '/api/terceiros/' + b.dataset.del); render(); }
  });
}

// ================= FUNCIONÁRIOS (movimento) =================
async function telaFunc() {
  const [lista, funcs] = await Promise.all([api('GET', '/api/func-mov' + qs()), api('GET', '/api/funcionarios')]);
  $('#conteudo').innerHTML = `
  <div class="box"><h2>➡ Registrar Hora Extra / Saída Antecipada / Serviço Externo</h2><div class="grid">
    <label>Funcionário (digite parte do nome)<input id="fn" autocomplete="off"></label><label>Setor<input id="fsr"></label>${horaInput('fh')}</div>
    <label>Motivo</label><div class="quick" id="fmq">${MOTIVOS.map(m => `<button type="button">${m}</button>`).join('')}</div>
    <label>Observação<input id="fo"></label><button class="btn verde grande" id="fsalvar">REGISTRAR</button></div>
  <div class="box"><h2>📋 Registros ${U.perfil === 'rh' && window._fd ? br(window._fd) : 'de hoje'}</h2>${U.perfil === 'rh' ? dataFiltro() : ''}<div class="tw"><table>
    <tr><th>Data</th><th>Hora</th><th>Funcionário</th><th>Setor</th><th>Motivo</th><th>Obs</th><th></th></tr>
    ${lista.map(m => `<tr><td>${br(m.data)}</td><td>${esc(m.hora)}</td><td>${esc(m.nome)}</td><td>${esc(m.setor)}</td><td>${esc(m.motivo)}</td><td>${esc(m.obs)}</td>
    <td style="white-space:nowrap"><button class="btn amarelo peq" data-ed="${m.id}">Editar</button>${U.perfil === 'rh' ? ` <button class="btn vermelho peq" data-del="${m.id}">Excluir</button>` : ''}</td></tr>`).join('')}</table></div></div>`;
  ligaData();
  const nomes = funcs.map(f => f.nome); sugestao($('#fn'), nomes);
  const acha = () => { const f = funcs.find(x => x.nome === $('#fn').value.trim().toUpperCase()); if (f) $('#fsr').value = f.setor; };
  $('#fn').addEventListener('change', acha); $('#fn').addEventListener('blur', () => setTimeout(acha, 200));
  window._m = '';
  $('#fmq').onclick = e => { const b = e.target.closest('button'); if (b) { window._m = b.textContent; $('#fmq').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); } };
  $('#fsalvar').onclick = tentar(async () => { await api('POST', '/api/func-mov', { nome: $('#fn').value, setor: $('#fsr').value, motivo: window._m, obs: $('#fo').value, hora: $('#fh').value }); toast('Registrado!'); render(); });
  $('#conteudo').onclick = tentar(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ed) {
      const m = lista.find(x => x.id == b.dataset.ed);
      modal(`<h2>Editar registro</h2><div class="grid"><label>Funcionário<input id="en" value="${esc(m.nome)}"></label><label>Setor<input id="es" value="${esc(m.setor)}"></label>
      <label>Motivo<select id="em">${opts(MOTIVOS, m.motivo)}</select></label><label>Hora<input id="eh" data-hora data-auto="0" value="${esc(m.hora)}" maxlength="5"></label></div>
      <label>Observação<input id="eo" value="${esc(m.obs)}"></label><div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR</button></div>`);
      ligarHoras($('#mbox')); $('#mc').onclick = fechar;
      $('#mo').onclick = tentar(async () => { await api('PUT', '/api/func-mov/' + m.id, { nome: $('#en').value, setor: $('#es').value, motivo: $('#em').value, hora: $('#eh').value, obs: $('#eo').value }); fechar(); toast('Atualizado'); render(); });
    }
    if (b.dataset.del && await confirmar('Excluir este registro definitivamente?', 'EXCLUIR')) { await api('DELETE', '/api/func-mov/' + b.dataset.del); render(); }
  });
}

// ================= CADASTROS (RH) =================
async function telaCad() {
  const S = [['func', 'Funcionários'], ['vei', 'Veículos'], ['usr', 'Usuários / Senhas'], ['por', 'Portões P1–P10'], ['rel', 'Relatórios (Excel/CSV)'], ['aud', 'Auditoria']];
  $('#conteudo').innerHTML = `<div class="sub">${S.map(s => `<button data-s="${s[0]}" class="${s[0] === sub ? 'on' : ''}">${s[1]}</button>`).join('')}</div><div id="sc"></div>`;
  $('.sub').onclick = e => { const s = e.target.closest('button')?.dataset.s; if (s) { sub = s; telaCad(); } };
  await ({ func: cadFunc, vei: cadVei, usr: cadUsr, por: cadPor, rel: cadRel, aud: cadAud }[sub])();
  ligarHoras($('#sc'));
}
let fq = '';
async function cadFunc() {
  const f = await api('GET', '/api/funcionarios?todos=1'); const v = f.filter(x => !fq || (x.nome + x.setor).includes(fq.toUpperCase()));
  $('#sc').innerHTML = `<div class="box"><h2>Funcionários (${f.length})</h2>
    <div class="row"><label>Nome<input id="nn"></label><label>Setor<input id="ns"></label><button class="btn verde" id="nadd">Adicionar</button></div>
    <div class="row" style="margin-top:10px"><label>Importar CSV (Nome;Setor)<input type="file" id="nf" accept=".csv,.txt"></label><button class="btn cinza" id="nimp">Importar</button></div>
    <label>Buscar<input id="nq" value="${esc(fq)}"></label><div class="tw"><table><tr><th>Nome</th><th>Setor</th><th>Ativo</th><th></th></tr>
    ${v.slice(0, 300).map(x => `<tr><td>${esc(x.nome)}</td><td>${esc(x.setor)}</td><td>${x.ativo ? 'Sim' : 'Não'}</td><td style="white-space:nowrap"><button class="btn amarelo peq" data-e="${x.id}">Editar</button> <button class="btn vermelho peq" data-d="${x.id}">Excluir</button></td></tr>`).join('')}</table></div>${v.length > 300 ? '<i>Mostrando 300. Use a busca.</i>' : ''}</div>`;
  $('#nq').oninput = e => { fq = e.target.value; clearTimeout(window._qt); window._qt = setTimeout(async () => { await cadFunc(); const q = $('#nq'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300); };
  $('#nadd').onclick = tentar(async () => { await api('POST', '/api/funcionarios', { nome: $('#nn').value, setor: $('#ns').value }); toast('Adicionado'); cadFunc(); });
  $('#nimp').onclick = tentar(async () => { const file = $('#nf').files[0]; if (!file) throw new Error('Escolha o arquivo CSV.'); const r = await api('POST', '/api/funcionarios/importar', { csv: await file.text() }); toast(`${r.novos} novos, ${r.atualizados} atualizados`); cadFunc(); });
  $('#sc').onclick = tentar(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.e) { const x = f.find(y => y.id == b.dataset.e);
      modal(`<h2>Editar funcionário</h2><label>Nome<input id="en" value="${esc(x.nome)}"></label><label>Setor<input id="es" value="${esc(x.setor)}"></label><label><input type="checkbox" id="ea" ${x.ativo ? 'checked' : ''} style="width:auto"> Ativo</label>
      <div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR</button></div>`);
      $('#mc').onclick = fechar; $('#mo').onclick = tentar(async () => { await api('PUT', '/api/funcionarios/' + x.id, { nome: $('#en').value, setor: $('#es').value, ativo: $('#ea').checked }); fechar(); cadFunc(); }); }
    if (b.dataset.d && await confirmar('Excluir este funcionário?', 'EXCLUIR')) { await api('DELETE', '/api/funcionarios/' + b.dataset.d); cadFunc(); }
  });
}
async function cadVei() {
  const v = await api('GET', '/api/veiculos?todos=1');
  $('#sc').innerHTML = `<div class="box"><h2>Veículos</h2><div class="row"><label>Nome/Modelo<input id="vn"></label><label>Placa<input id="vp" maxlength="8"></label><label>KM atual<input id="vk" inputmode="numeric"></label><button class="btn verde" id="vadd">Adicionar</button></div>
    <div class="tw"><table><tr><th>Veículo</th><th>Placa</th><th>KM</th><th>Ativo</th><th></th></tr>${v.map(x => `<tr><td>${esc(x.nome)}</td><td>${esc(x.placa)}</td><td>${x.km}</td><td>${x.ativo ? 'Sim' : 'Não'}</td>
    <td style="white-space:nowrap"><button class="btn amarelo peq" data-e="${x.id}">Editar</button> <button class="btn vermelho peq" data-d="${x.id}">Excluir</button></td></tr>`).join('')}</table></div></div>`;
  $('#vadd').onclick = tentar(async () => { await api('POST', '/api/veiculos', { nome: $('#vn').value, placa: $('#vp').value, km: $('#vk').value }); toast('Adicionado'); cadVei(); });
  $('#sc').onclick = tentar(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.e) { const x = v.find(y => y.id == b.dataset.e);
      modal(`<h2>Editar veículo</h2><label>Nome<input id="en" value="${esc(x.nome)}"></label><label>Placa<input id="ep" value="${esc(x.placa)}"></label><label>KM<input id="ek" value="${x.km}"></label><label><input type="checkbox" id="ea" ${x.ativo ? 'checked' : ''} style="width:auto"> Ativo</label>
      <div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR</button></div>`);
      $('#mc').onclick = fechar; $('#mo').onclick = tentar(async () => { await api('PUT', '/api/veiculos/' + x.id, { nome: $('#en').value, placa: $('#ep').value, km: $('#ek').value, ativo: $('#ea').checked }); fechar(); cadVei(); }); }
    if (b.dataset.d && await confirmar('Excluir este veículo? (se tiver histórico, será apenas desativado)', 'EXCLUIR')) { const r = await api('DELETE', '/api/veiculos/' + b.dataset.d); if (r.desativado) toast('Tinha histórico: veículo desativado'); cadVei(); }
  });
}
async function cadUsr() {
  const u = await api('GET', '/api/usuarios');
  $('#sc').innerHTML = `<div class="box"><h2>Usuários e senhas</h2><div class="row"><label>Usuário<input id="un"></label><label>Nome<input id="uo"></label><label>Senha<input id="us" type="password"></label>
    <label>Perfil<select id="up"><option value="guarita">Guarita</option><option value="rh">RH / Admin</option></select></label><button class="btn verde" id="uadd">Adicionar</button></div>
    <table><tr><th>Usuário</th><th>Nome</th><th>Perfil</th><th></th></tr>${u.map(x => `<tr><td>${esc(x.usuario)}</td><td>${esc(x.nome)}</td><td>${x.perfil === 'rh' ? 'RH / Admin' : 'Guarita'}</td>
    <td style="white-space:nowrap"><button class="btn amarelo peq" data-e="${x.id}">Editar / Trocar senha</button> <button class="btn vermelho peq" data-d="${x.id}">Excluir</button></td></tr>`).join('')}</table></div>`;
  $('#uadd').onclick = tentar(async () => { await api('POST', '/api/usuarios', { usuario: $('#un').value, nome: $('#uo').value, senha: $('#us').value, perfil: $('#up').value }); toast('Usuário criado'); cadUsr(); });
  $('#sc').onclick = tentar(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.e) { const x = u.find(y => y.id == b.dataset.e);
      modal(`<h2>Editar ${esc(x.usuario)}</h2><label>Nome<input id="en" value="${esc(x.nome)}"></label><label>Perfil<select id="ep"><option value="guarita" ${x.perfil === 'guarita' ? 'selected' : ''}>Guarita</option><option value="rh" ${x.perfil === 'rh' ? 'selected' : ''}>RH / Admin</option></select></label>
      <label>Nova senha (deixe vazio para manter)<input id="es" type="password"></label><div class="acts"><button class="btn cinza" id="mc">Cancelar</button><button class="btn amarelo" id="mo">SALVAR</button></div>`);
      $('#mc').onclick = fechar; $('#mo').onclick = tentar(async () => { await api('PUT', '/api/usuarios/' + x.id, { nome: $('#en').value, perfil: $('#ep').value, senha: $('#es').value }); fechar(); toast('Salvo'); cadUsr(); }); }
    if (b.dataset.d && await confirmar('Excluir este usuário?', 'EXCLUIR')) { await api('DELETE', '/api/usuarios/' + b.dataset.d); cadUsr(); }
  });
}
async function cadPor() {
  const p = await api('GET', '/api/portoes');
  $('#sc').innerHTML = `<div class="box"><h2>Orientações dos portões</h2>${p.map(x => `<div class="pt" style="background:#eef1f5;color:#000"><div class="grid"><label>${esc(x.codigo)} - Título<input data-t="${x.codigo}" value="${esc(x.titulo)}"></label>
    <label>Orientação<input data-x="${x.codigo}" value="${esc(x.texto)}"></label><label>Recebe entrega?<select data-r="${x.codigo}"><option value="1" ${x.recebe ? 'selected' : ''}>SIM</option><option value="0" ${x.recebe ? '' : 'selected'}>NÃO</option></select></label>
    <button class="btn amarelo" data-s="${x.codigo}" style="align-self:end">Salvar ${esc(x.codigo)}</button></div></div>`).join('')}</div>`;
  $('#sc').onclick = tentar(async e => {
    const c = e.target.closest('button')?.dataset.s; if (!c) return;
    await api('PUT', '/api/portoes/' + c, { titulo: $(`[data-t="${c}"]`).value, texto: $(`[data-x="${c}"]`).value, recebe: $(`[data-r="${c}"]`).value === '1' });
    portoes = await api('GET', '/api/portoes'); desenhaGuia(); toast(c + ' salvo');
  });
}
async function cadRel() {
  const v = await api('GET', '/api/veiculos?todos=1');
  $('#sc').innerHTML = `<div class="box"><h2>Exportar relatório (CSV para Excel)</h2><div class="grid">
    <label>Relatório<select id="rt"><option value="frota">Veículos da empresa</option><option value="terceiros">Terceiros / Visitantes</option><option value="funcionarios">Funcionários (hora extra / saída)</option><option value="auditoria">Auditoria</option></select></label>
    <label>De<input type="date" id="rd" value="${agora.data.slice(0, 8)}01"></label><label>Até<input type="date" id="ra" value="${agora.data}"></label>
    <label>Nome / texto<input id="rq"></label><label>Setor (funcionários)<input id="rs"></label>
    <label>Veículo (frota)<select id="rv"><option value="">Todos</option>${v.map(x => `<option value="${x.id}">${esc(x.nome)} ${esc(x.placa)}</option>`).join('')}</select></label></div>
    <button class="btn verde grande" id="rb">BAIXAR RELATÓRIO</button></div>`;
  $('#rb').onclick = () => { const p = new URLSearchParams({ tipo: $('#rt').value, de: $('#rd').value, ate: $('#ra').value, q: $('#rq').value, setor: $('#rs').value, veiculo: $('#rv').value }); location.href = '/api/relatorio?' + p; };
}
async function cadAud() {
  const a = await api('GET', '/api/auditoria?limite=300');
  $('#sc').innerHTML = `<div class="box"><h2>Log de auditoria (últimos 300)</h2><div class="tw"><table><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Detalhe</th></tr>${a.map(x => `<tr><td>${esc(x.quando)}</td><td>${esc(x.usuario)}</td><td>${esc(x.acao)}</td><td>${esc(x.detalhe)}</td></tr>`).join('')}</table></div></div>`;
}

// ---- start ----
setInterval(() => { if (U) tick(); }, 20000);
(async () => { try { U = await api('GET', '/api/me'); iniciar(); } catch { mostrarLogin(); } })();
