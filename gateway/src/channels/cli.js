import readline from 'node:readline';

// The terminal as a channel: you type as the owner, replies print. For the simulator and tests.
// "f: text" sends text as a forwarded message (someone else wrote it).
export class CliChannel {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    Object.assign(this, { input, output });
    this.n = 0;
  }

  start(onMessage) {
    this.rl = readline.createInterface({ input: this.input });
    this.rl.on('line', (line) => {
      const forwarded = line.startsWith('f:');
      onMessage({ id: `u${++this.n}`, text: forwarded ? line.slice(2).trim() : line, forwarded });
    });
    this.rl.on('close', () => this.onClose?.());
  }

  async send(text) {
    this.output.write(`\n${text}\n\n`);
    return `b${++this.n}`;
  }

  async react(id, emoji) { if (emoji) this.output.write(`[${emoji} on ${id}]\n`); }

  stop() { this.rl?.close(); }
}
