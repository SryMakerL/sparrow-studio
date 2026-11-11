import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = process.argv[2] ?? fileURLToPath(new URL('../../native/dotnet-engine/target/release/sparrow_dotnet_native.dll', import.meta.url));
const bytes = readFileSync(path);
const pe = bytes.readUInt32LE(60);
if (bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664)
  throw new Error('Expected a Windows x64 PE DLL.');
const optional = pe + 24;
if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Expected PE32+.');
const directories = optional + 112;
const sections = Array.from({ length: bytes.readUInt16LE(pe + 6) }, (_, index) => {
  const at = optional + bytes.readUInt16LE(pe + 20) + index * 40;
  return {
    rva: bytes.readUInt32LE(at + 12),
    size: Math.max(bytes.readUInt32LE(at + 8), bytes.readUInt32LE(at + 16)),
    raw: bytes.readUInt32LE(at + 20),
  };
});
function offset(rva) {
  const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
  if (!section) throw new Error(`Invalid PE RVA: ${rva}`);
  return section.raw + rva - section.rva;
}
const string = at => bytes.toString('ascii', at, bytes.indexOf(0, at));
const table = offset(bytes.readUInt32LE(directories));
const names = offset(bytes.readUInt32LE(table + 32));
const exports = Array.from({ length: bytes.readUInt32LE(table + 24) }, (_, i) =>
  string(offset(bytes.readUInt32LE(names + i * 4))));
const required = [
  'sparrow_cancel_create', 'sparrow_cancel_request', 'sparrow_cancel_free',
  'sparrow_solve_json', 'sparrow_string_free', 'sparrow_validate_json',
  'sparrow_session_create_json', 'sparrow_session_start_json', 'sparrow_session_step_json',
  'sparrow_session_poll_json', 'sparrow_session_cancel', 'sparrow_session_free',
];
for (const name of required)
  if (!exports.includes(name)) throw new Error(`Missing native export: ${name}`);
const imports = [];
const importRva = bytes.readUInt32LE(directories + 8);
if (importRva)
  for (let at = offset(importRva); bytes.readUInt32LE(at + 12); at += 20)
    imports.push(string(offset(bytes.readUInt32LE(at + 12))));
console.log(JSON.stringify({ path, architecture: 'win-x64', exports, imports }, null, 2));
