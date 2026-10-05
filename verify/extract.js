// Extracts a named top-level function out of bridge/server.js and evaluates it,
// so the unit checks run the *shipped* source rather than a copy that can drift.
//
//   node extract.js <file> <declaration-prefix>
//
// Prints the function's source text on stdout. Exits non-zero if the name is not
// present, which is what stopped a broken extraction from silently passing.

const fs = require('fs');

const file = process.argv[2];
const decl = process.argv[3];
if (!file || !decl) {
  console.error('usage: extract.js <file> <declaration-prefix>');
  process.exit(2);
}

const src = fs.readFileSync(file, 'utf8');
const start = src.indexOf(decl);
if (start < 0) {
  console.error(`extract: "${decl}" not found in ${file}`);
  process.exit(3);
}

// Find this function's own closing brace at column 0, not any nested one: the
// docker branch of sessionLines has braces of its own, and stopping at the first
// "\n}\n" inside the body would hand back a syntactically valid fragment.
let depth = 0;
let i = src.indexOf('{', start);
const open = i;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') {
    depth--;
    if (depth === 0) break;
  }
}
if (depth !== 0) {
  console.error(`extract: unbalanced braces for "${decl}"`);
  process.exit(4);
}
process.stdout.write(src.slice(start, i + 1) + '\n');
