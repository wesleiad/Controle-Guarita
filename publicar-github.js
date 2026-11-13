'use strict';
// Publica esta pasta no repositório público wesleiad/Controle-Guarita (de onde o servidor da guarita se atualiza).
// Envia só os arquivos que o Git do Projetos-TI controla/não ignora (sem dados da empresa) e sem histórico antigo.
// Uso: node publicar-github.js "mensagem do commit"
const { execFileSync } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const REMOTO = 'https://github.com/wesleiad/Controle-Guarita.git';
const raiz = path.resolve(__dirname, '..'), pasta = path.basename(__dirname);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const lista = git(raiz, 'ls-files', '-co', '--exclude-standard', '--', pasta).split('\n').filter(Boolean);
const proibido = /(^|\/)(data|node_modules)\/|funcionarios\.csv$|dados-iniciais\.json$|versao\.txt$/;
const arquivos = lista.filter(f => !proibido.test(f) && fs.existsSync(path.join(raiz, f)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guarita-pub-'));
try {
  git(os.tmpdir(), 'clone', '-q', REMOTO, tmp);
  for (const n of fs.readdirSync(tmp)) if (n !== '.git') fs.rmSync(path.join(tmp, n), { recursive: true, force: true });
  for (const f of arquivos) { const d = path.join(tmp, f.slice(pasta.length + 1)); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(raiz, f), d); }
  git(tmp, 'add', '-A');
  if (!git(tmp, 'status', '--porcelain').trim()) { console.log('Nada novo para publicar.'); process.exit(0); }
  git(tmp, 'commit', '-q', '-m', process.argv[2] || 'Atualização');
  git(tmp, 'push', '-q', 'origin', 'HEAD:main');
  console.log(`Publicado (${arquivos.length} arquivos). O servidor da guarita atualiza sozinho em até 1 hora.`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
