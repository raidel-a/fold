// Drives the native host over the same framing Chrome uses, to smoke-test it.
import { spawn } from 'node:child_process';

const HOST = new URL('../native/fold-appleai-host', import.meta.url).pathname;

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

/** Reassembles framed messages from the raw byte stream. */
async function* readMessages(stream) {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      yield JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
    }
  }
}

const requests = process.argv.slice(2).map((p) => JSON.parse(p));
const child = spawn(HOST, [], { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdout.resume();

const messages = readMessages(child.stdout);

for (const req of requests) {
  child.stdin.write(frame(req));
  const t = Date.now();
  const { value, done } = await messages.next();
  if (done) {
    console.error('host closed stdout before replying');
    break;
  }
  console.log(`--- ${req.id ?? '(no id)'} in ${Date.now() - t}ms`);
  console.log(JSON.stringify(value, null, 2));
}

child.stdin.end();
child.kill();