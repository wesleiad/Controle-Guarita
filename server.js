'use strict';
// Controle de Guarita - Node.js + Express + SQLite (node:sqlite embutido)
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'guarita.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY, usuario TEXT UNIQUE NOT NULL, nome TEXT, senha TEXT NOT NULL, perfil TEXT NOT NULL CHECK (perfil IN ('guarita','rh')));
CREATE TABLE IF NOT EXISTS sessoes (token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL, expira INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS veiculos (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, placa TEXT UNIQUE NOT NULL, km INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS funcionarios (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, setor TEXT DEFAULT '', ativo INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS portoes (codigo TEXT PRIMARY KEY, ordem INTEGER, titulo TEXT, texto TEXT, recebe INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS frota (id INTEGER PRIMARY KEY, veiculo_id INTEGER NOT NULL REFERENCES veiculos(id), motorista TEXT, destino TEXT, status TEXT DEFAULT 'Normal', obs TEXT DEFAULT '',
  km_saida INTEGER, km_entrada INTEGER, data_saida TEXT, hora_saida TEXT, data_entrada TEXT, hora_entrada TEXT);
CREATE TABLE IF NOT EXISTS terceiros (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, empresa TEXT DEFAULT '', portao TEXT DEFAULT '', obs TEXT DEFAULT '', data TEXT, hora_entrada TEXT, hora_saida TEXT);
CREATE TABLE IF NOT EXISTS func_mov (id INTEGER PRIMARY KEY, funcionario_id INTEGER, nome TEXT NOT NULL, setor TEXT DEFAULT '', motivo TEXT, obs TEXT DEFAULT '', data TEXT, hora TEXT);
CREATE TABLE IF NOT EXISTS auditoria (id INTEGER PRIMARY KEY, usuario TEXT, acao TEXT, detalhe TEXT, quando TEXT);
CREATE INDEX IF NOT EXISTS ix_frota_data ON frota(data_saida); CREATE INDEX IF NOT EXISTS ix_terc_data ON terceiros(data);
CREATE INDEX IF NOT EXISTS ix_fm_data ON func_mov(data);
`);

// ---------- utilidades ----------
const pad = n => String(n).padStart(2, '0');
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const agoraHora = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const quando = () => `${hoje()} ${agoraHora()}:${pad(new Date().getSeconds())}`;
const horaOk = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h || '');
const hash = (s, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(String(s), salt, 32).toString('hex');
const confere = (s, h) => { const [salt, k] = h.split(':'); const a = Buffer.from(hash(s, salt).split(':')[1], 'hex'), b = Buffer.from(k, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const txt = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const upper = v => txt(v).toUpperCase();
const audit = (u, acao, detalhe) => db.prepare('INSERT INTO auditoria(usuario,acao,detalhe,quando) VALUES(?,?,?,?)').run(u.usuario, acao, detalhe, quando());
class Erro extends Error { constructor(msg, code = 400, extra) { super(msg); this.code = code; this.extra = extra; } }

// ---------- dados iniciais ----------
// Dados da empresa (frota, portões) ficam em dados-iniciais.json, que NÃO vai para o GitHub. Sem ele, o RH cadastra tudo na aba Cadastros.
let INICIAIS = { veiculos: [], portoes: [], destinos: [] };
try { INICIAIS = { ...INICIAIS, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'dados-iniciais.json'), 'utf8')) }; } catch { }
const FROTA = INICIAIS.veiculos, PORTOES = INICIAIS.portoes;
if (!db.prepare('SELECT COUNT(*) c FROM usuarios').get().c) {
  const ins = db.prepare('INSERT INTO usuarios(usuario,nome,senha,perfil) VALUES(?,?,?,?)');
  ins.run('guarita', 'Guarita', hash('1234'), 'guarita');
  ins.run('rh', 'RH / Admin', hash('admin123'), 'rh');
}
if (!db.prepare('SELECT COUNT(*) c FROM veiculos').get().c) {
  const ins = db.prepare('INSERT INTO veiculos(nome,placa,km) VALUES(?,?,?)'); FROTA.forEach(v => ins.run(...v));
}
if (!db.prepare('SELECT COUNT(*) c FROM funcionarios').get().c && fs.existsSync(path.join(__dirname, 'funcionarios.csv'))) {
  const ins = db.prepare('INSERT INTO funcionarios(nome,setor) VALUES(?,?)');
  fs.readFileSync(path.join(__dirname, 'funcionarios.csv'), 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1).forEach(l => { const [n, s] = l.split(';'); if (n && n.trim()) ins.run(n.trim().toUpperCase(), (s || '').trim().toUpperCase()); });
}
if (!db.prepare('SELECT COUNT(*) c FROM portoes').get().c) {
  const ins = db.prepare('INSERT INTO portoes(codigo,ordem,titulo,texto,recebe) VALUES(?,?,?,?,?)'); PORTOES.forEach((p, i) => ins.run(p[0], i + 1, p[1], p[2], p[3]));
}

// ---------- app / sessão ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
function auth(req, _res, next) {
  const t = cookies(req).sid;
  if (t) {
    const u = db.prepare('SELECT u.id,u.usuario,u.nome,u.perfil FROM sessoes s JOIN usuarios u ON u.id=s.usuario_id WHERE s.token=? AND s.expira>?').get(t, Date.now());
    if (u) req.user = u;
  }
  next();
}
app.use(auth);
const precisaLogin = (req, _res, next) => req.user ? next() : next(new Erro('Faça login.', 401));
const soRH = (req, _res, next) => req.user?.perfil === 'rh' ? next() : next(new Erro('Apenas o RH pode fazer isso.', 403));
const wrap = fn => (req, res, next) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { next(e); } };

const tentativas = new Map();
app.post('/api/login', wrap((req, res) => {
  const ip = req.ip, t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.ate > Date.now()) throw new Erro('Muitas tentativas. Aguarde 1 minuto.', 429);
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario=?').get(txt(req.body.usuario).toLowerCase());
  if (!u || !confere(req.body.senha || '', u.senha)) {
    t.n++; if (t.n >= 8) { t.ate = Date.now() + 60000; t.n = 0; } tentativas.set(ip, t);
    throw new Erro('Usuário ou senha incorretos.', 401);
  }
  tentativas.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM sessoes WHERE expira<?').run(Date.now());
  db.prepare('INSERT INTO sessoes VALUES(?,?,?)').run(token, u.id, Date.now() + 12 * 3600e3);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}`);
  audit(u, 'LOGIN', '');
  return { usuario: u.usuario, nome: u.nome, perfil: u.perfil };
}));
app.post('/api/logout', wrap((req, res) => {
  const t = cookies(req).sid; if (t) db.prepare('DELETE FROM sessoes WHERE token=?').run(t);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return { ok: true };
}));
app.get('/api/me', wrap(req => req.user || (() => { throw new Erro('Não autenticado', 401); })()));

app.use('/api', precisaLogin);
app.get('/api/destinos', wrap(() => INICIAIS.destinos || []));
app.get('/api/agora', wrap(() => ({ data: hoje(), hora: agoraHora() })));

// ---------- portões ----------
app.get('/api/portoes', wrap(() => db.prepare('SELECT * FROM portoes ORDER BY ordem').all()));
app.put('/api/portoes/:codigo', soRH, wrap(req => {
  const p = db.prepare('SELECT * FROM portoes WHERE codigo=?').get(req.params.codigo); if (!p) throw new Erro('Portão não encontrado', 404);
  db.prepare('UPDATE portoes SET titulo=?,texto=?,recebe=? WHERE codigo=?').run(upper(req.body.titulo) || p.titulo, txt(req.body.texto, 500), req.body.recebe ? 1 : 0, p.codigo);
  audit(req.user, 'EDITAR PORTÃO', p.codigo); return { ok: true };
}));

// ---------- veículos ----------
app.get('/api/veiculos', wrap(req => db.prepare(`SELECT * FROM veiculos ${req.query.todos ? '' : 'WHERE ativo=1'} ORDER BY nome,placa`).all()));
const placaOk = p => /^[A-Z0-9]{7}$/.test(p);
app.post('/api/veiculos', soRH, wrap(req => {
  const nome = upper(req.body.nome), placa = upper(req.body.placa).replace(/[^A-Z0-9]/g, ''), km = parseInt(req.body.km) || 0;
  if (!nome || !placaOk(placa)) throw new Erro('Informe nome e placa (7 caracteres).');
  try { const r = db.prepare('INSERT INTO veiculos(nome,placa,km) VALUES(?,?,?)').run(nome, placa, km); audit(req.user, 'NOVO VEÍCULO', `${nome} ${placa} KM ${km}`); return { id: Number(r.lastInsertRowid) }; }
  catch { throw new Erro('Já existe veículo com essa placa.'); }
}));
app.put('/api/veiculos/:id/km', wrap(req => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id); if (!v) throw new Erro('Veículo não encontrado', 404);
  const km = parseInt(req.body.km); if (!(km >= 0)) throw new Erro('KM inválido.');
  db.prepare('UPDATE veiculos SET km=? WHERE id=?').run(km, v.id);
  audit(req.user, 'CORRIGIR KM', `${v.nome} ${v.placa}: ${v.km} -> ${km}`); return { ok: true, km };
}));
app.put('/api/veiculos/:id', soRH, wrap(req => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id); if (!v) throw new Erro('Veículo não encontrado', 404);
  const nome = upper(req.body.nome) || v.nome, placa = upper(req.body.placa).replace(/[^A-Z0-9]/g, '') || v.placa;
  if (!placaOk(placa)) throw new Erro('Placa inválida.');
  try { db.prepare('UPDATE veiculos SET nome=?,placa=?,km=?,ativo=? WHERE id=?').run(nome, placa, req.body.km === undefined ? v.km : parseInt(req.body.km) || 0, req.body.ativo === undefined ? v.ativo : (req.body.ativo ? 1 : 0), v.id); }
  catch { throw new Erro('Já existe veículo com essa placa.'); }
  audit(req.user, 'EDITAR VEÍCULO', `${v.placa} -> ${nome} ${placa}`); return { ok: true };
}));
app.delete('/api/veiculos/:id', soRH, wrap(req => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id); if (!v) throw new Erro('Não encontrado', 404);
  if (db.prepare('SELECT COUNT(*) c FROM frota WHERE veiculo_id=?').get(v.id).c) { db.prepare('UPDATE veiculos SET ativo=0 WHERE id=?').run(v.id); audit(req.user, 'DESATIVAR VEÍCULO', v.placa); return { ok: true, desativado: true }; }
  db.prepare('DELETE FROM veiculos WHERE id=?').run(v.id); audit(req.user, 'EXCLUIR VEÍCULO', v.placa); return { ok: true };
}));

// ---------- funcionários (cadastro) ----------
app.get('/api/funcionarios', wrap(req => db.prepare(`SELECT * FROM funcionarios ${req.query.todos ? '' : 'WHERE ativo=1'} ORDER BY nome`).all()));
app.post('/api/funcionarios', soRH, wrap(req => {
  const nome = upper(req.body.nome); if (!nome) throw new Erro('Informe o nome.');
  const r = db.prepare('INSERT INTO funcionarios(nome,setor) VALUES(?,?)').run(nome, upper(req.body.setor)); audit(req.user, 'NOVO FUNCIONÁRIO', nome); return { id: Number(r.lastInsertRowid) };
}));
app.put('/api/funcionarios/:id', soRH, wrap(req => {
  const f = db.prepare('SELECT * FROM funcionarios WHERE id=?').get(req.params.id); if (!f) throw new Erro('Não encontrado', 404);
  db.prepare('UPDATE funcionarios SET nome=?,setor=?,ativo=? WHERE id=?').run(upper(req.body.nome) || f.nome, req.body.setor === undefined ? f.setor : upper(req.body.setor), req.body.ativo === undefined ? f.ativo : (req.body.ativo ? 1 : 0), f.id);
  audit(req.user, 'EDITAR FUNCIONÁRIO', f.nome); return { ok: true };
}));
app.delete('/api/funcionarios/:id', soRH, wrap(req => {
  const f = db.prepare('SELECT * FROM funcionarios WHERE id=?').get(req.params.id); if (!f) throw new Erro('Não encontrado', 404);
  db.prepare('DELETE FROM funcionarios WHERE id=?').run(f.id); audit(req.user, 'EXCLUIR FUNCIONÁRIO', f.nome); return { ok: true };
}));
app.post('/api/funcionarios/importar', soRH, wrap(req => {
  const linhas = String(req.body.csv || '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let novos = 0, atualizados = 0;
  const get = db.prepare('SELECT id FROM funcionarios WHERE nome=?'), ins = db.prepare('INSERT INTO funcionarios(nome,setor) VALUES(?,?)'), upd = db.prepare('UPDATE funcionarios SET setor=?,ativo=1 WHERE id=?');
  db.exec('BEGIN');
  try {
    linhas.forEach((l, i) => {
      const sep = l.includes(';') ? ';' : (l.includes('\t') ? '\t' : ',');
      const [n, s] = l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
      if (!n || (i === 0 && /^nome$/i.test(n))) return;
      const nome = upper(n), ex = get.get(nome);
      if (ex) { upd.run(upper(s), ex.id); atualizados++; } else { ins.run(nome, upper(s)); novos++; }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(req.user, 'IMPORTAR FUNCIONÁRIOS', `${novos} novos, ${atualizados} atualizados`); return { novos, atualizados };
}));

// ---------- frota ----------
const FROTA_SQL = `SELECT f.*, v.nome AS veiculo, v.placa FROM frota f JOIN veiculos v ON v.id=f.veiculo_id`;
const podeEditar = (user, datas, aberto) => user.perfil === 'rh' || aberto || datas.includes(hoje());
app.get('/api/frota', wrap(req => {
  const d = req.user.perfil === 'rh' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : hoje();
  return db.prepare(`${FROTA_SQL} WHERE f.data_saida=? OR f.data_entrada=? OR (? = ? AND f.km_entrada IS NULL) ORDER BY f.id DESC`).all(d, d, d, hoje());
}));
app.get('/api/frota/rua', wrap(() => db.prepare(`${FROTA_SQL} WHERE f.km_entrada IS NULL ORDER BY f.id`).all()));
function dadosFrota(b, parcial) {
  const o = {};
  o.motorista = upper(b.motorista); o.destino = upper(b.destino);
  o.status = ['Normal', 'Lavação', 'Oficina'].includes(b.status) ? b.status : 'Normal';
  o.obs = txt(b.obs, 500);
  if (!parcial) { if (!o.motorista) throw new Erro('Informe o motorista.'); if (!o.destino) throw new Erro('Informe o destino.'); }
  return o;
}
app.post('/api/frota/saida', wrap(req => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=? AND ativo=1').get(req.body.veiculo_id); if (!v) throw new Erro('Escolha o veículo.');
  if (db.prepare('SELECT 1 FROM frota WHERE veiculo_id=? AND km_entrada IS NULL').get(v.id)) throw new Erro('Esse veículo já está na rua. Registre o retorno primeiro.');
  const o = dadosFrota(req.body);
  const km = req.body.km_saida === '' || req.body.km_saida == null ? v.km : parseInt(req.body.km_saida);
  if (!(km >= 0)) throw new Erro('KM de saída inválido.');
  if (km !== v.km) { db.prepare('UPDATE veiculos SET km=? WHERE id=?').run(km, v.id); audit(req.user, 'CORRIGIR KM', `${v.nome} ${v.placa}: ${v.km} -> ${km} (na saída)`); }
  const hora = horaOk(req.body.hora) ? req.body.hora : agoraHora();
  const r = db.prepare('INSERT INTO frota(veiculo_id,motorista,destino,status,obs,km_saida,data_saida,hora_saida) VALUES(?,?,?,?,?,?,?,?)').run(v.id, o.motorista, o.destino, o.status, o.obs, km, hoje(), hora);
  return { id: Number(r.lastInsertRowid) };
}));
app.post('/api/frota/:id/retorno', wrap(req => {
  const f = db.prepare('SELECT * FROM frota WHERE id=?').get(req.params.id); if (!f) throw new Erro('Registro não encontrado', 404);
  if (f.km_entrada != null) throw new Erro('Esse veículo já retornou.');
  const km = parseInt(req.body.km_entrada); if (!(km >= 0)) throw new Erro('Informe o KM de retorno.');
  if (km < f.km_saida) throw new Erro(`KM de retorno (${km}) não pode ser menor que o de saída (${f.km_saida}).`);
  if (km - f.km_saida > 500 && !req.body.confirmado) throw new Erro(`A viagem deu ${km - f.km_saida} km. Confirme se está correto.`, 409, { confirmar: true });
  const hora = horaOk(req.body.hora) ? req.body.hora : agoraHora();
  const o = req.body.status ? dadosFrota({ ...f, ...req.body }, true) : null;
  db.prepare('UPDATE frota SET km_entrada=?,data_entrada=?,hora_entrada=?,status=COALESCE(?,status),obs=COALESCE(?,obs) WHERE id=?').run(km, hoje(), hora, o?.status ?? null, o ? o.obs : null, f.id);
  db.prepare('UPDATE veiculos SET km=? WHERE id=?').run(km, f.veiculo_id);
  return { ok: true };
}));
app.put('/api/frota/:id', wrap(req => {
  const f = db.prepare('SELECT * FROM frota WHERE id=?').get(req.params.id); if (!f) throw new Erro('Registro não encontrado', 404);
  if (!podeEditar(req.user, [f.data_saida, f.data_entrada], f.km_entrada == null)) throw new Erro('A guarita só edita registros do dia. Fale com o RH.', 403);
  const o = dadosFrota(req.body);
  const ks = parseInt(req.body.km_saida), ke = req.body.km_entrada === '' || req.body.km_entrada == null ? null : parseInt(req.body.km_entrada);
  if (!(ks >= 0)) throw new Erro('KM de saída inválido.');
  if (ke != null && (!(ke >= 0) || ke < ks)) throw new Erro('KM de retorno inválido (menor que o de saída).');
  if (ke != null && ke - ks > 500 && !req.body.confirmado) throw new Erro(`A viagem deu ${ke - ks} km. Confirme se está correto.`, 409, { confirmar: true });
  const hs = horaOk(req.body.hora_saida) ? req.body.hora_saida : f.hora_saida, he = ke == null ? null : (horaOk(req.body.hora_entrada) ? req.body.hora_entrada : (f.hora_entrada || agoraHora()));
  const de = ke == null ? null : (f.data_entrada || hoje());
  db.prepare('UPDATE frota SET motorista=?,destino=?,status=?,obs=?,km_saida=?,km_entrada=?,hora_saida=?,hora_entrada=?,data_entrada=? WHERE id=?').run(o.motorista, o.destino, o.status, o.obs, ks, ke, hs, he, de, f.id);
  audit(req.user, 'EDITAR FROTA', `#${f.id} KM ${f.km_saida}/${f.km_entrada ?? '-'} -> ${ks}/${ke ?? '-'} | ${o.motorista} | ${o.destino}`); return { ok: true };
}));
app.delete('/api/frota/:id', soRH, wrap(req => {
  const f = db.prepare(`${FROTA_SQL} WHERE f.id=?`).get(req.params.id); if (!f) throw new Erro('Não encontrado', 404);
  db.prepare('DELETE FROM frota WHERE id=?').run(f.id); audit(req.user, 'EXCLUIR FROTA', `#${f.id} ${f.veiculo} ${f.placa} ${f.data_saida}`); return { ok: true };
}));
app.get('/api/motoristas', wrap(() => db.prepare("SELECT DISTINCT motorista n FROM frota WHERE motorista<>'' UNION SELECT nome FROM funcionarios WHERE ativo=1 ORDER BY 1").all().map(r => r.n)));

// ---------- terceiros ----------
const dataReq = req => req.user.perfil === 'rh' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : hoje();
app.get('/api/terceiros', wrap(req => { const d = dataReq(req); return db.prepare('SELECT * FROM terceiros WHERE data=? OR (hora_saida IS NULL AND ?=?) ORDER BY id DESC').all(d, d, hoje()); }));
app.get('/api/terceiros/dentro', wrap(() => db.prepare('SELECT * FROM terceiros WHERE hora_saida IS NULL ORDER BY id').all()));
app.get('/api/terceiros/sugestoes', wrap(() => ({
  nomes: db.prepare("SELECT DISTINCT nome n FROM terceiros ORDER BY 1").all().map(r => r.n),
  empresas: db.prepare("SELECT DISTINCT empresa n FROM terceiros WHERE empresa<>'' ORDER BY 1").all().map(r => r.n) })));
app.post('/api/terceiros', wrap(req => {
  const nome = upper(req.body.nome); if (!nome) throw new Erro('Informe o nome.');
  const portao = upper(req.body.portao);
  const hora = horaOk(req.body.hora) ? req.body.hora : agoraHora();
  const r = db.prepare('INSERT INTO terceiros(nome,empresa,portao,obs,data,hora_entrada) VALUES(?,?,?,?,?,?)').run(nome, upper(req.body.empresa), portao, txt(req.body.obs, 500), hoje(), hora);
  return { id: Number(r.lastInsertRowid) };
}));
app.post('/api/terceiros/:id/saida', wrap(req => {
  const t = db.prepare('SELECT * FROM terceiros WHERE id=?').get(req.params.id); if (!t) throw new Erro('Não encontrado', 404);
  if (t.hora_saida) throw new Erro('Saída já registrada.');
  db.prepare('UPDATE terceiros SET hora_saida=? WHERE id=?').run(horaOk(req.body.hora) ? req.body.hora : agoraHora(), t.id); return { ok: true };
}));
app.put('/api/terceiros/:id', wrap(req => {
  const t = db.prepare('SELECT * FROM terceiros WHERE id=?').get(req.params.id); if (!t) throw new Erro('Não encontrado', 404);
  if (!podeEditar(req.user, [t.data], !t.hora_saida)) throw new Erro('A guarita só edita registros do dia. Fale com o RH.', 403);
  const nome = upper(req.body.nome); if (!nome) throw new Erro('Informe o nome.');
  const he = horaOk(req.body.hora_entrada) ? req.body.hora_entrada : t.hora_entrada;
  const hs = req.body.hora_saida === '' || req.body.hora_saida == null ? null : (horaOk(req.body.hora_saida) ? req.body.hora_saida : t.hora_saida);
  db.prepare('UPDATE terceiros SET nome=?,empresa=?,portao=?,obs=?,hora_entrada=?,hora_saida=? WHERE id=?').run(nome, upper(req.body.empresa), upper(req.body.portao), txt(req.body.obs, 500), he, hs, t.id);
  audit(req.user, 'EDITAR TERCEIRO', `#${t.id} ${t.nome} -> ${nome}`); return { ok: true };
}));
app.delete('/api/terceiros/:id', soRH, wrap(req => {
  const t = db.prepare('SELECT * FROM terceiros WHERE id=?').get(req.params.id); if (!t) throw new Erro('Não encontrado', 404);
  db.prepare('DELETE FROM terceiros WHERE id=?').run(t.id); audit(req.user, 'EXCLUIR TERCEIRO', `#${t.id} ${t.nome} ${t.data}`); return { ok: true };
}));

// ---------- funcionários: hora extra / saída antecipada ----------
const MOTIVOS = ['Hora Extra', 'Saída Antecipada', 'Serviço Externo'];
app.get('/api/func-mov', wrap(req => db.prepare('SELECT * FROM func_mov WHERE data=? ORDER BY id DESC').all(dataReq(req))));
app.post('/api/func-mov', wrap(req => {
  const nome = upper(req.body.nome); if (!nome) throw new Erro('Informe o funcionário.');
  if (!MOTIVOS.includes(req.body.motivo)) throw new Erro('Escolha o motivo.');
  const f = db.prepare('SELECT id,setor FROM funcionarios WHERE nome=?').get(nome);
  const hora = horaOk(req.body.hora) ? req.body.hora : agoraHora();
  const r = db.prepare('INSERT INTO func_mov(funcionario_id,nome,setor,motivo,obs,data,hora) VALUES(?,?,?,?,?,?,?)').run(f?.id ?? null, nome, upper(req.body.setor) || f?.setor || '', req.body.motivo, txt(req.body.obs, 500), hoje(), hora);
  return { id: Number(r.lastInsertRowid) };
}));
app.put('/api/func-mov/:id', wrap(req => {
  const m = db.prepare('SELECT * FROM func_mov WHERE id=?').get(req.params.id); if (!m) throw new Erro('Não encontrado', 404);
  if (!podeEditar(req.user, [m.data], false)) throw new Erro('A guarita só edita registros do dia. Fale com o RH.', 403);
  if (!MOTIVOS.includes(req.body.motivo)) throw new Erro('Escolha o motivo.');
  db.prepare('UPDATE func_mov SET nome=?,setor=?,motivo=?,obs=?,hora=? WHERE id=?').run(upper(req.body.nome) || m.nome, upper(req.body.setor), req.body.motivo, txt(req.body.obs, 500), horaOk(req.body.hora) ? req.body.hora : m.hora, m.id);
  audit(req.user, 'EDITAR FUNC. MOV', `#${m.id} ${m.nome}`); return { ok: true };
}));
app.delete('/api/func-mov/:id', soRH, wrap(req => {
  const m = db.prepare('SELECT * FROM func_mov WHERE id=?').get(req.params.id); if (!m) throw new Erro('Não encontrado', 404);
  db.prepare('DELETE FROM func_mov WHERE id=?').run(m.id); audit(req.user, 'EXCLUIR FUNC. MOV', `#${m.id} ${m.nome} ${m.data}`); return { ok: true };
}));

// ---------- usuários (RH) ----------
app.get('/api/usuarios', soRH, wrap(() => db.prepare('SELECT id,usuario,nome,perfil FROM usuarios ORDER BY usuario').all()));
app.post('/api/usuarios', soRH, wrap(req => {
  const usuario = txt(req.body.usuario, 40).toLowerCase(); if (!/^[a-z0-9._-]{2,40}$/.test(usuario)) throw new Erro('Usuário: use letras minúsculas/números (mín. 2).');
  if (String(req.body.senha || '').length < 4) throw new Erro('Senha com no mínimo 4 caracteres.');
  if (!['guarita', 'rh'].includes(req.body.perfil)) throw new Erro('Perfil inválido.');
  try { db.prepare('INSERT INTO usuarios(usuario,nome,senha,perfil) VALUES(?,?,?,?)').run(usuario, txt(req.body.nome, 80), hash(req.body.senha), req.body.perfil); }
  catch { throw new Erro('Esse usuário já existe.'); }
  audit(req.user, 'NOVO USUÁRIO', `${usuario} (${req.body.perfil})`); return { ok: true };
}));
app.put('/api/usuarios/:id', soRH, wrap(req => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id); if (!u) throw new Erro('Não encontrado', 404);
  const perfil = ['guarita', 'rh'].includes(req.body.perfil) ? req.body.perfil : u.perfil;
  if (u.perfil === 'rh' && perfil !== 'rh' && db.prepare("SELECT COUNT(*) c FROM usuarios WHERE perfil='rh'").get().c < 2) throw new Erro('Precisa existir pelo menos um usuário RH.');
  let senha = u.senha; if (req.body.senha) { if (String(req.body.senha).length < 4) throw new Erro('Senha com no mínimo 4 caracteres.'); senha = hash(req.body.senha); }
  db.prepare('UPDATE usuarios SET nome=?,perfil=?,senha=? WHERE id=?').run(txt(req.body.nome, 80) || u.nome, perfil, senha, u.id);
  if (req.body.senha) db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(u.id);
  audit(req.user, 'EDITAR USUÁRIO', `${u.usuario}${req.body.senha ? ' (senha alterada)' : ''}`); return { ok: true };
}));
app.delete('/api/usuarios/:id', soRH, wrap(req => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id); if (!u) throw new Erro('Não encontrado', 404);
  if (u.id === req.user.id) throw new Erro('Você não pode excluir o próprio usuário.');
  if (u.perfil === 'rh' && db.prepare("SELECT COUNT(*) c FROM usuarios WHERE perfil='rh'").get().c < 2) throw new Erro('Precisa existir pelo menos um usuário RH.');
  db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(u.id); db.prepare('DELETE FROM usuarios WHERE id=?').run(u.id);
  audit(req.user, 'EXCLUIR USUÁRIO', u.usuario); return { ok: true };
}));
app.get('/api/auditoria', soRH, wrap(req => db.prepare('SELECT * FROM auditoria ORDER BY id DESC LIMIT ?').all(Math.min(parseInt(req.query.limite) || 200, 2000))));

// ---------- relatórios CSV ----------
const csvCell = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const br = d => d ? d.split('-').reverse().join('/') : '';
app.get('/api/relatorio', soRH, wrap((req, res) => {
  const tipo = req.query.tipo, de = req.query.de || '0000-01-01', ate = req.query.ate || '9999-12-31', q = `%${upper(req.query.q)}%`;
  let cab, linhas;
  if (tipo === 'frota') {
    const vq = req.query.veiculo ? Number(req.query.veiculo) : null;
    const rows = db.prepare(`${FROTA_SQL} WHERE f.data_saida BETWEEN ? AND ? AND (?1 IS NULL OR 1) ORDER BY f.id`.replace('(?1 IS NULL OR 1)', '1=1')).all(de, ate)
      .filter(r => (!vq || r.veiculo_id === vq) && (q === '%%' || `${r.motorista} ${r.destino} ${r.veiculo} ${r.placa}`.includes(upper(req.query.q))));
    cab = ['Data saída', 'Hora saída', 'Veículo', 'Placa', 'Motorista', 'Destino', 'Status', 'KM saída', 'Data retorno', 'Hora retorno', 'KM retorno', 'KM rodados', 'Observação'];
    linhas = rows.map(r => [br(r.data_saida), r.hora_saida, r.veiculo, r.placa, r.motorista, r.destino, r.status, r.km_saida, br(r.data_entrada), r.hora_entrada, r.km_entrada, r.km_entrada != null ? r.km_entrada - r.km_saida : '', r.obs]);
  } else if (tipo === 'terceiros') {
    const rows = db.prepare('SELECT * FROM terceiros WHERE data BETWEEN ? AND ? AND (nome LIKE ? OR empresa LIKE ?) ORDER BY id').all(de, ate, q, q);
    cab = ['Data', 'Nome', 'Empresa', 'Portão', 'Entrada', 'Saída', 'Observação'];
    linhas = rows.map(r => [br(r.data), r.nome, r.empresa, r.portao, r.hora_entrada, r.hora_saida, r.obs]);
  } else if (tipo === 'funcionarios') {
    const setor = upper(req.query.setor);
    const rows = db.prepare('SELECT * FROM func_mov WHERE data BETWEEN ? AND ? AND nome LIKE ? AND setor LIKE ? ORDER BY id').all(de, ate, q, `%${setor}%`);
    cab = ['Data', 'Hora', 'Funcionário', 'Setor', 'Motivo', 'Observação'];
    linhas = rows.map(r => [br(r.data), r.hora, r.nome, r.setor, r.motivo, r.obs]);
  } else if (tipo === 'auditoria') {
    const rows = db.prepare('SELECT * FROM auditoria WHERE substr(quando,1,10) BETWEEN ? AND ? ORDER BY id').all(de, ate);
    cab = ['Quando', 'Usuário', 'Ação', 'Detalhe']; linhas = rows.map(r => [r.quando, r.usuario, r.acao, r.detalhe]);
  } else throw new Erro('Tipo de relatório inválido.');
  const csv = '﻿' + [cab, ...linhas].map(l => l.map(csvCell).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="guarita-${tipo}-${hoje()}.csv"`);
  res.send(csv);
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => {
  if (!(err instanceof Erro)) { console.error(err); return res.status(500).json({ erro: 'Erro interno do servidor.' }); }
  res.status(err.code).json({ erro: err.message, ...(err.extra || {}) });
});

function ips() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n==============================================');
  console.log('  CONTROLE DE GUARITA em execucao');
  console.log('==============================================');
  console.log('  Endereco para digitar no navegador (RH/Guarita):\n');
  const l = ips(); (l.length ? l : ['localhost']).forEach(ip => console.log(`      http://${ip}:${PORT}`));
  console.log('\n  Usuarios iniciais:  guarita / 1234   |   rh / admin123');
  console.log('  (troque as senhas na aba Cadastros > Usuarios)');
  console.log('  Para encerrar: feche esta janela ou Ctrl+C');
  console.log('==============================================\n');

  // Atualização automática pelo GitHub (confere ao iniciar e a cada hora; se atualizar, reinicia sozinho pelo .bat)
  const atualizador = require('./atualizar');
  const conferir = async () => { try { if (await atualizador.verificar()) { console.log('[atualizador] reiniciando para aplicar a nova versão...'); setTimeout(() => process.exit(0), 1000); } } catch (e) { console.log('[atualizador]', e.message); } };
  setTimeout(conferir, 15000); setInterval(conferir, 3600e3);
});
