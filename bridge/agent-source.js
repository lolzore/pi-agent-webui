/*
 * Where pi lives: on this machine, or inside a container (issue #157).
 *
 * start-webui.sh used to ask that in a terminal prompt and save the answer to
 * bridge/agent-source.txt before starting the bridge. The WebUI's setup screen
 * asks the same question now - the same file, so the scripts and the WebUI
 * agree - which is what lets the desktop app work with no terminal at all.
 *
 * PI_COMMAND / PI_SESSION_DIR still win when they are set: the scripts,
 * containers and the tests use them to point the bridge at something specific,
 * and the file is only consulted when they are absent.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = process.env.PI_WEBUI_SOURCE_FILE || path.join(__dirname, 'agent-source.txt');

function read() {
  let text = '';
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch {
    return { source: null, container: null, file: FILE, configured: false };
  }
  const out = { source: null, container: null };
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'source') out.source = m[2] || null;
    if (m[1] === 'container') out.container = m[2] || null;
  }
  // a docker source without a container is not a choice, it is a broken file
  if (out.source !== 'native' && out.source !== 'docker') out.source = null;
  if (out.source === 'docker' && !out.container) out.source = null;
  return { ...out, file: FILE, configured: !!out.source };
}

function write({ source, container }) {
  if (source !== 'native' && source !== 'docker') throw new Error('source must be "native" or "docker"');
  const name = String(container || '').trim();
  if (source === 'docker' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error('a docker container name is required');
  }
  const body = source === 'docker' ? `source=docker\ncontainer=${name}\n` : 'source=native\n';
  // written beside and renamed, like every other file the bridge owns: a
  // half-written source file is a bridge that will not start
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, FILE);
  return read();
}

/* The command line the agent is started with. */
function command(env = process.env) {
  if (env.PI_COMMAND) return env.PI_COMMAND;
  const s = read();
  if (s.source === 'docker') return `docker exec -i ${s.container} pi --mode rpc`;
  return 'pi --mode rpc';
}

/* The session dir the sidebar lists, or null for the caller's default. */
function sessionDir(env = process.env) {
  if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
  if (env.PI_SESSION_DIR) return env.PI_SESSION_DIR;
  const s = read();
  if (s.source === 'docker') return `docker:${s.container}:/root/.pi/agent/sessions`;
  return null;
}

/* What is actually here, so the setup screen offers real choices. */
async function detect(execFile) {
  const run = (cmd, args) => new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch {
      resolve('');
    }
  });
  const which = process.platform === 'win32' ? ['where'] : ['sh', ['-c', 'command -v pi']];
  const [pi, docker, containers] = await Promise.all([
    which.length === 1 ? run(which[0], ['pi']) : run(which[0], which[1]),
    which.length === 1 ? run('where', ['docker']) : run('sh', ['-c', 'command -v docker']),
    run('docker', ['ps', '-a', '--format', '{{.Names}}']),
  ]);
  return {
    pi: pi.split('\n')[0].trim() || null,
    docker: docker.split('\n')[0].trim() || null,
    containers: containers.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 40),
  };
}

module.exports = { FILE, read, write, command, sessionDir, detect };
