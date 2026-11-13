'use strict';
// Atualização automática: compara a versão local (versao.txt) com o último commit do GitHub
// e, se houver novidade, baixa o ZIP, copia os arquivos (sem tocar em data/, node_modules e funcionarios.csv).
// Uso: node atualizar.js   (ou chamado pelo server.js a cada hora)
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const REPO = 'wesleiad/Controle-Guarita', RAMO = 'main';
const RAIZ = __dirname, VERSAO = path.join(RAIZ, 'versao.txt');
const PULAR = new Set(['data', 'node_modules', 'funcionarios.csv', 'versao.txt', '.git']);

async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': 'controle-guarita-updater', ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${url}`);
  return r;
}
function copia(de, para, nivel = 0) {
  fs.mkdirSync(para, { recursive: true });
  for (const n of fs.readdirSync(de)) {
    if (nivel === 0 && PULAR.has(n)) continue;
    const a = path.join(de, n), b = path.join(para, n);
    if (fs.statSync(a).isDirectory()) copia(a, b, nivel + 1); else fs.copyFileSync(a, b);
  }
}
async function verificar() {
  const local = fs.existsSync(VERSAO) ? fs.readFileSync(VERSAO, 'utf8').trim() : '';
  let remoto;
  try { remoto = (await (await get(`https://api.github.com/repos/${REPO}/commits/${RAMO}`, { headers: { Accept: 'application/vnd.github.sha' } })).text()).trim(); }
  catch (e) { console.log('[atualizador] sem acesso ao GitHub agora:', e.message); return false; }
  if (!/^[0-9a-f]{40}$/.test(remoto) || remoto === local) return false;
  console.log(`[atualizador] nova versão ${remoto.slice(0, 7)} encontrada. Baixando...`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guarita-upd-')), zip = path.join(tmp, 'v.zip');
  try {
    fs.writeFileSync(zip, Buffer.from(await (await get(`https://codeload.github.com/${REPO}/zip/refs/heads/${RAMO}`)).arrayBuffer()));
    const x = spawnSync('tar', ['-xf', zip, '-C', tmp], { windowsHide: true });
    if (x.status !== 0) throw new Error('falha ao extrair: ' + (x.stderr || '').toString());
    const pasta = fs.readdirSync(tmp).map(n => path.join(tmp, n)).find(p => fs.statSync(p).isDirectory());
    if (!pasta || !fs.existsSync(path.join(pasta, 'server.js'))) throw new Error('pacote inválido (sem server.js)');
    const pkgAntes = fs.existsSync(path.join(RAIZ, 'package.json')) ? fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8') : '';
    copia(pasta, RAIZ);
    if (fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8') !== pkgAntes) {
      console.log('[atualizador] instalando dependências...');
      spawnSync('npm', ['install', '--omit=dev', '--silent'], { cwd: RAIZ, shell: true, windowsHide: true, stdio: 'inherit' });
    }
    fs.writeFileSync(VERSAO, remoto);
    console.log('[atualizador] atualizado com sucesso.');
    return true;
  } catch (e) { console.log('[atualizador] falhou, mantendo a versão atual:', e.message); return false; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { verificar };
if (require.main === module) verificar().then(a => console.log(a ? 'Atualizado.' : 'Já está na versão mais recente (ou sem acesso).'));
