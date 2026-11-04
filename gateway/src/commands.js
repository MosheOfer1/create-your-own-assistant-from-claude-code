// Which shell commands only look at things, so they run without asking the owner.
//
// An allow list, never a deny list (deny lists were bypassed with `python3 -c`, `mv`, quotes):
// a command is read-only only when every part is a known program with arguments that keep it
// read-only. Anything not understood ($(...), backticks, a redirect into a file, an option that
// writes, a path that holds secrets) is not read-only and goes to the owner.

const any = () => true;
const isFlag = (a) => a.startsWith('-');
// The option exactly, as --opt=value, or a short letter inside a cluster like -fn.
const hasOpt = (a, b) => a === b || a.startsWith(`${b}=`)
  || (/^-[a-zA-Z]$/.test(b) && /^-[a-zA-Z]+$/.test(a) && a.includes(b[1]));
const without = (...bad) => (args) => !args.some((a) => bad.some((b) => hasOpt(a, b)));
// The verb must be one of `verbs`, and only `flags` (options without a value) may appear:
// an option value (systemctl -p status restart x) must never be taken for the verb.
const verb = (verbs, flags) => (args) => args.every((a) => !isFlag(a) || flags.includes(a)) && verbs.includes(args.find((a) => !isFlag(a)));
const versionOnly = (...flags) => (args) => args.length === 1 && flags.includes(args[0]);

const GIT = {
  status: any, log: without('--output'), diff: without('--output'), show: without('--output'),
  'rev-parse': any, describe: any, 'ls-files': any, blame: any, shortlog: any,
  branch: (a) => a.every(isFlag) && without('-d', '-D', '-m', '-M', '-c', '-C', '-f', '-u', '--delete', '--move', '--copy', '--force', '--set-upstream-to')(a),
  tag: (a) => a.length === 0 || ['-l', '--list'].includes(a[0]),
  remote: (a) => a.length === 0 || (a.length === 1 && ['-v', '--verbose'].includes(a[0])),
};
function git(args) {
  let i = 0;
  while (i < args.length && isFlag(args[i])) { // -c could run programs: only -C and --no-pager
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager') i += 1;
    else return false;
  }
  return Object.hasOwn(GIT, args[i] ?? '') && GIT[args[i]](args.slice(i + 1));
}

// ps e / ps eww print every process's environment (secrets). "-e" (all processes) is fine.
const psNoEnv = (a) => !a.some((x) => (!x.startsWith('-') && /e/.test(x)) || /^--?(env|environ)/.test(x));
// curl: a GET to the screen. No body, upload, headers or file.
const CURL_FLAGS = new Set(['-s', '-S', '-sS', '-f', '-fs', '-sf', '-fsS', '-sSf', '-I', '-i', '-L', '-sL', '-sSL', '-v', '--silent', '--show-error', '--fail', '--head', '--include', '--location', '--compressed']);
const curl = (a) => {
  for (let i = 0; i < a.length; i++) {
    if (['-m', '--max-time', '--connect-timeout', '-w', '--write-out'].includes(a[i])) i++;
    else if (isFlag(a[i]) ? !CURL_FLAGS.has(a[i]) : !/^https?:\/\//.test(a[i])) return false;
  }
  return true;
};

export const READ_ONLY = {
  ls: any, cat: any, head: any, wc: any, cut: any, tr: any, nl: any, echo: any, printf: any, pwd: any, cd: any,
  whoami: any, id: any, uname: any, uptime: any, df: any, du: any, free: any, ps: psNoEnv, pgrep: any, stat: any,
  which: any, realpath: any, readlink: any, basename: any, dirname: any, cmp: any, md5sum: any, sha256sum: any,
  column: any, nproc: any,
  jq: (a) => !a.some((x) => /env|input_filename|\$__loc__/i.test(x)), // `jq -n env` prints the secrets groups: any, test: any, '[': any, true: any, false: any, seq: any, comm: any,
  paste: any, rev: any, fold: any, strings: any, od: any, nslookup: any, dig: any, host: any, getent: any,
  locale: any, grep: any, egrep: any, fgrep: any, zgrep: any, zcat: any, lscpu: any, lsblk: any,
  hostname: (a) => a.every(isFlag),
  file: without('-C', '--compile'),
  diff: without('--output'),
  tree: without('-o'),
  rg: without('--pre', '--pre-glob'),
  tail: without('-f', '-F', '--follow', '--retry'),
  sort: without('-o', '--output', '--compress-program'),
  uniq: (a) => a.filter((x) => !isFlag(x)).length <= 1, // a second name is an output file
  date: without('-s', '--set'),
  find: without('-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'),
  sed: (a) => a.includes('-n') && a.filter(isFlag).every((f) => ['-n', '-E', '-r'].includes(f))
    && /^(\d+|\$)(,(\d+|\$))?p$/.test(a.find((x) => !isFlag(x)) ?? ''),
  ping: (a) => a.includes('-c'),
  journalctl: without('-f', '--follow', '--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush'),
  systemctl: verb(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-timers', 'show', 'cat'],
    ['--user', '--no-pager', '-l', '--full', '-a', '--all', '--failed', '-q', '--quiet', '--no-legend', '--plain']),
  git,
  curl,
  node: versionOnly('-v', '--version'),
  python3: versionOnly('-V', '--version'),
  claude: versionOnly('-v', '--version'),
  npm: (a) => versionOnly('-v', '--version')(a) || ['ls', 'list', 'view'].includes(a[0]),
};

// These print names and sizes, not contents: a secret path in their arguments is fine.
const NAMES_ONLY = new Set(['ls', 'du', 'stat', 'find', 'tree', 'file', 'realpath', 'readlink', 'basename', 'dirname', 'which', 'test', '[', 'df', 'wc']);

// Paths that hold secrets: reading them would put a key into the chat.
const SECRET = [
  /(^|[/~])\.env(\.|$)/, /(^|\/)\.ssh(\/|$)/, /id_(rsa|ed25519|ecdsa|dsa)/, /credential/i, /\.netrc/, /shadow/,
  /(^|\/)data(\/|$)/, /(^|\/)auth(\/|$)/, /\.pem$/, /\.key$/, /token/i, /secret/i, /passw/i, /gnupg/, /\.aws/,
  /\.kube/, /keyring/i, /\.claude/, /(^|[/~])\.config(\/|$)/, /_key(\.|$)/i, /api[-_]?key/i, /mcp\.json/,
  /(^|\/)proc\/(\d+|self|thread-self)(\/|$)/, /environ/i,
  /\/\.[^/]*[*?[]/, /^\.[^/]*[*?[]/, /^~\/?$/, /^\/(home|root)?\/?$/,
];

const SAFE_REDIRECT = /^(\d?>|&>)\/dev\/null$|^\d?>&\d$/;

// Splits a line into simple commands (on | || && ; newline) made of words, quotes removed;
// a redirect is kept as { redirect }, a word with an unquoted * ? [ as { glob } (the shell
// expands it, so its real name is unknown). null for anything this parser does not understand.
export function parse(line) {
  const cmds = [[]];
  let word = null;
  let glob = false;
  const push = () => { if (word !== null) cmds[cmds.length - 1].push(glob ? { glob: word } : word); word = null; glob = false; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let s = '';
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '$' || line[j] === '`') return null;
        if (line[j] === '\\') j++;
        s += line[j] ?? '';
      }
      if (j >= line.length) return null;
      word = (word ?? '') + s;
      i = j;
    } else if (c === '\\') {
      if (i + 1 >= line.length || line[i + 1] === '\n') return null;
      word = (word ?? '') + line[++i];
    } else if (c === ' ' || c === '\t') {
      push();
    } else if (c === '|' || c === ';' || c === '\n' || (c === '&' && line[i + 1] === '&')) {
      push();
      if (line[i + 1] === c && c !== ';' && c !== '\n') i++;
      cmds.push([]);
    } else if (c === '>' || (c === '&' && line[i + 1] === '>')) {
      let r = '';
      if (word !== null && /^\d$/.test(word) && c === '>') r = word; else push();
      word = null;
      r += c === '&' ? '&>' : '>';
      let j = i + (c === '&' ? 2 : 1);
      if (line[j] === '>') return null; // >> appends to a file
      if (line[j] === '&') { r += '&'; j++; }
      while (line[j] === ' ') j++;
      while (j < line.length && !' \t|;&\n<>'.includes(line[j])) r += line[j++];
      cmds[cmds.length - 1].push({ redirect: r });
      i = j - 1;
    } else if ('$`<(){}&'.includes(c) || (c === '#' && word === null)) {
      return null;
    } else {
      if ('*?['.includes(c)) glob = true;
      word = (word ?? '') + c;
    }
  }
  push();
  return cmds;
}

// True when the whole command line only reads. Empty, unparsable or very long lines are not.
export function isReadOnly(line) {
  if (typeof line !== 'string' || !line.trim() || line.length > 4000) return false;
  const cmds = parse(line);
  if (!cmds) return false;
  const parts = cmds.filter((c) => c.length > 0);
  const trailingEmpty = cmds.at(-1).length === 0 ? 1 : 0;
  if (parts.length === 0 || parts.length !== cmds.length - trailingEmpty) return false; // "ls ;; rm"
  return parts.every((words) => {
    const args = [];
    let globbed = false;
    for (const w of words) {
      if (typeof w === 'string') args.push(w);
      else if (w.glob !== undefined) { args.push(w.glob); globbed = true; } else if (!SAFE_REDIRECT.test(w.redirect)) return false;
    }
    const [prog, ...rest] = args;
    if (!prog || !Object.hasOwn(READ_ONLY, prog) || !READ_ONLY[prog](rest)) return false;
    if (NAMES_ONLY.has(prog)) return true;
    // A program that prints contents: no glob (cat dat?/x hides "data") and no secret path.
    return !globbed && !rest.some((a) => SECRET.some((re) => re.test(a)));
  });
}

// With freeShell (the gateway runs as its own user): commands run without asking unless they
// change the machine for real or reach other machines. These always ask.
const REAL_CHANGE = [
  /\bsudo\b|\bpkexec\b|(^|[;&|]\s*)su\b/, /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bsystemctl\b(?!\s+(--user\s+)?(status|is-active|is-enabled|is-failed|list-[a-z-]+|show|cat)\b)/,
  /\b(apt|apt-get|dnf|yum|pacman|brew|snap)\s+(install|remove|purge|upgrade)/, /\bnpm\s+(i|install)\s+-g\b/,
  /\b(kill|pkill|killall)\b/, /\bgit\b[^|;&]*\bpush\b/, /\b(ssh|scp|sftp|rsync)\b/, /\bcrontab\b/,
  /(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, /\bcurl\b[^|;&]*\s(-d|--data[\w-]*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE))\b/,
  /\bmkfs|\bdd\s|\bwipefs\b|\bshred\b/,
];
export const realChange = (command = '') => REAL_CHANGE.some((r) => r.test(String(command)));
