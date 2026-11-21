// A stand-in OTLP/HTTP collector for the Run-agent check's telemetry job, so the export is proved
// without a real backend. Bodies are protobuf, but strings are stored in it verbatim, so searching the
// raw bytes is enough to find attribute values and to prove a canary word is absent.
//
// node otlp-receiver.mjs serve <record file>   records each request; writes <record file>.ready when listening
// node otlp-receiver.mjs check <record file>   checks the record; needs EXPECTED_AUTHORIZATION, CANARY and
//                                              EXPECTED_TEXT (strings every run must send, one per line)

import fs from 'node:fs';
import http from 'node:http';

const [mode, recordFile] = process.argv.slice(2);
const PORT = 4318;

if (mode === 'serve') {
  http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const entry = { path: request.url, authorization: request.headers.authorization ?? '', body: Buffer.concat(chunks).toString('base64') };
      fs.appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
  }).listen(PORT, '127.0.0.1', () => fs.writeFileSync(`${recordFile}.ready`, ''));
} else if (mode === 'check') {
  const fail = message => { console.log(`::error::${message}`); process.exit(1); };
  const requests = fs.existsSync(recordFile)
    ? fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const paths = requests.map(request => request.path);
  // Unexpected paths first: a redirect to a beta endpoint also leaves a signal missing, and this
  // names the cause.
  const unexpected = paths.filter(path => !['/v1/metrics', '/v1/logs'].includes(path));
  if (unexpected.length > 0) fail(`Requests reached ${[...new Set(unexpected)].join(', ')}, so traces or a beta export are on. run-agent must allow only metrics and logs.`);
  for (const signal of ['/v1/metrics', '/v1/logs']) {
    if (!paths.includes(signal)) fail(`No request reached ${signal}. Requests seen: ${paths.join(', ') || 'none'}.`);
  }
  if (requests.some(request => request.authorization !== process.env.EXPECTED_AUTHORIZATION)) {
    fail('A request arrived without the expected Authorization header.');
  }
  const bodies = requests.map(request => Buffer.from(request.body, 'base64').toString('latin1'));
  for (const text of process.env.EXPECTED_TEXT.split('\n').filter(Boolean)) {
    if (!bodies.some(body => body.includes(text))) fail(`No request carried "${text}".`);
  }
  if (bodies.some(body => body.includes(process.env.CANARY))) fail('The prompt\'s canary word was exported, so content logging is on.');
  console.log(`${requests.length} OTLP requests: ${[...new Set(paths)].join(', ')}, with the header and attributes, nothing else and no prompt or response content.`);
} else {
  throw new Error('Usage: otlp-receiver.mjs serve|check <record file>');
}
